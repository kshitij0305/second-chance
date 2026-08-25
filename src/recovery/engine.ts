import { db } from "../db.ts";
import { linkProvider } from "../razorpay/links.ts";
import type { Decision } from "./strategy.ts";
import { config } from "../config.ts";
import { compose, formatAmount } from "./composer.ts";
import type { FailureClass } from "./classifier.ts";
import { recordOutcome } from "./bandit.ts";
import { findVariant } from "./variants.ts";

export interface FailedPayment {
  payment_id: string;
  amount: number;
  currency: string;
  email?: string | null;
  contact?: string | null;
  order_id?: string | null;
}

/**
 * Records a recovery to be sent later, rather than sending it now.
 *
 * Nothing goes out at failure time. The strategy decides when, and a customer
 * who has just failed a payment is frequently still at the checkout retrying —
 * a link arriving mid-retry risks a double charge.
 */
export function scheduleRecovery(payment: FailedPayment, decision: Decision): void {
  const existing = db.prepare(
    "SELECT COUNT(*) n FROM recovery_attempts WHERE payment_id = ?",
  ).get(payment.payment_id) as { n: number };

  if (existing.n >= decision.strategy.maxAttempts) {
    console.log(
      `[schedule] ${payment.payment_id} already at ${existing.n}/${decision.strategy.maxAttempts} attempts — not scheduling`,
    );
    return;
  }

  db.prepare(
    `INSERT INTO recovery_attempts
       (payment_id, strategy, status, amount, attempt_number, scheduled_for, explanation)
     VALUES (?, ?, 'scheduled', ?, ?, ?, ?)`,
  ).run(
    payment.payment_id,
    decision.strategy.name,
    payment.amount,
    existing.n + 1,
    decision.scheduledFor,
    decision.explanation,
  );

  console.log(
    `[schedule] ${payment.payment_id} -> ${decision.strategy.name}, due ${decision.scheduledFor}`,
  );
}

interface DueRow {
  id: number;
  payment_id: string;
  strategy: string;
  amount: number;
  email: string | null;
  contact: string | null;
  order_id: string | null;
  method: string | null;
  failure_class: FailureClass | null;
}

/**
 * Sends any recovery that has come due.
 *
 * Called on a timer. Every send is guarded: between scheduling and dispatch the
 * customer may have completed the payment by some other route, and a recovery
 * link sent after that is at best noise and at worst a second charge.
 */
let dispatchInFlight = false;

export async function dispatchDue(now: Date = new Date()): Promise<number> {
  // The poll interval is shorter than a Razorpay round trip, so without this a
  // second pass starts while the first is still awaiting the API.
  if (dispatchInFlight) return 0;
  dispatchInFlight = true;
  try {
    return await runDispatch(now);
  } finally {
    dispatchInFlight = false;
  }
}

async function runDispatch(now: Date): Promise<number> {
  const due = db.prepare(
    `SELECT a.id, a.payment_id, a.strategy, a.amount,
            f.email, f.contact, f.order_id, f.method, f.failure_class
       FROM recovery_attempts a
       JOIN failed_payments f ON f.payment_id = a.payment_id
      WHERE a.status = 'scheduled' AND a.scheduled_for <= ?
      ORDER BY a.scheduled_for`,
  ).all(now.toISOString()) as unknown as DueRow[];

  let sent = 0;
  for (const row of due) {
    // Claim the row before doing anything slow. The in-flight guard above stops
    // overlapping passes within one process; this is the actual correctness
    // guarantee, and it is a single atomic statement so two readers cannot both
    // win. Without it the dispatcher creates two live payment links for one
    // recovery — observed, and invisible in the data afterwards because the
    // second send simply overwrites the first link's URL.
    const claimed = db.prepare(
      "UPDATE recovery_attempts SET status = 'sending' WHERE id = ? AND status = 'scheduled'",
    ).run(row.id);
    if (claimed.changes === 0) continue;

    if (alreadyPaid(row)) {
      db.prepare(
        "UPDATE recovery_attempts SET status = 'superseded', error = ? WHERE id = ?",
      ).run("customer completed payment before this recovery was due", row.id);
      console.log(`[dispatch] ${row.payment_id} superseded — already paid`);
      continue;
    }
    if (await send(row)) sent++;
  }
  return sent;
}

/**
 * Has this order been settled since the failure?
 *
 * Answered from captured webhooks rather than by polling the provider: the
 * events are already on disk, and a lookup per due recovery would burn the same
 * rate limit the recovery itself needs.
 */
function alreadyPaid(row: DueRow): boolean {
  if (!row.order_id) return false;
  const hit = db.prepare(
    `SELECT COUNT(*) n FROM webhook_events
      WHERE event = 'payment.captured'
        AND json_extract(payload, '$.payload.payment.entity.order_id') = ?`,
  ).get(row.order_id) as { n: number };
  return hit.n > 0;
}

async function send(row: DueRow): Promise<boolean> {
  try {
    // When the failure was a property of the instrument rather than the moment,
    // the plan says to steer away from it — and until now that intent only ever
    // reached an explanation string. Hide the failed method on the checkout so
    // the recovery actually offers a different route.
    const variant = row.failure_class ? findVariant(row.failure_class, row.strategy) : undefined;
    const excludeMethod = variant?.avoidFailedMethod ? (row.method ?? undefined) : undefined;

    const link = await linkProvider.create({
      amount: row.amount,
      currency: "INR",
      description: "Your payment didn't go through — here's a fresh link",
      email: row.email ?? undefined,
      contact: row.contact ?? undefined,
      notes: { recovers_payment_id: row.payment_id, strategy: row.strategy },
      excludeMethod,
    });

    // Composed only once the link exists, so the message can carry the real
    // URL. Never blocks the send: compose() falls back to a template if
    // generation is unavailable or produces something that fails validation.
    const composed = await compose(
      row.failure_class ?? "unknown",
      {
        name: null,
        method: row.method ?? "payment method",
        amount: formatAmount(row.amount),
        link: link.short_url,
      },
      // What the plan actually did, not what the class usually implies. If no
      // method was hidden, the message must not tell the customer to switch.
      { steerToAnotherMethod: Boolean(link.excluded_method) },
    );

    db.prepare(
      `UPDATE recovery_attempts
          SET status = 'sent', payment_link_id = ?, payment_link_url = ?,
              message = ?, message_source = ?, excluded_method = ?, sent_at = datetime('now')
        WHERE id = ?`,
    ).run(link.id, link.short_url, composed.text, composed.source, link.excluded_method ?? null, row.id);

    console.log(
      `[dispatch] ${row.payment_id} -> ${link.short_url} (${row.strategy}, message by ${composed.source}` +
      (link.excluded_method ? `, ${link.excluded_method} hidden` : "") + ")",
    );
    console.log(`           "${composed.text}"`);
    return true;
  } catch (error) {
    // Record the failure rather than only logging it. A recovery that never
    // went out is the most important thing for an operator to see, and a line
    // in a scrolling terminal is not seeing it.
    const message = describeError(error);
    db.prepare("UPDATE recovery_attempts SET status = 'failed', error = ? WHERE id = ?")
      .run(message, row.id);
    console.error(`[dispatch] ${row.payment_id} FAILED: ${message}`);
    return false;
  }
}

/** Razorpay errors nest the useful text; plain Errors don't. */
function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const e = error as { error?: { description?: string }; message?: string };
    if (e.error?.description) return e.error.description;
    if (e.message) return e.message;
  }
  return String(error);
}

export function markRecovered(paymentLinkId: string): boolean {
  const result = db.prepare(
    `UPDATE recovery_attempts
        SET recovered_at = datetime('now'), status = 'recovered'
      WHERE payment_link_id = ? AND recovered_at IS NULL`,
  ).run(paymentLinkId);
  return result.changes > 0;
}

/**
 * Attributes a recovery using the original payment id planted in the link notes.
 * Razorpay copies those notes onto the payment that settles the link, so
 * payment.captured alone is enough; payment_link.paid is a second route to the
 * same conclusion. Idempotent, because both can arrive for one recovery.
 */
export function markRecoveredByOriginalPayment(originalPaymentId: string): boolean {
  // Read the arm before the update, so the outcome is attributed to the plan
  // that was actually used rather than to whatever is current.
  const arm = armFor(originalPaymentId);

  const result = db.prepare(
    `UPDATE recovery_attempts
        SET recovered_at = datetime('now'), status = 'recovered'
      WHERE payment_id = ? AND recovered_at IS NULL AND status != 'scheduled'`,
  ).run(originalPaymentId);

  if (result.changes > 0 && arm) recordOutcome(arm.failure_class, arm.strategy, true);
  return result.changes > 0;
}

interface Arm { failure_class: FailureClass; strategy: string }

function armFor(paymentId: string): Arm | null {
  const row = db.prepare(
    `SELECT a.strategy, f.failure_class
       FROM recovery_attempts a
       JOIN failed_payments f ON f.payment_id = a.payment_id
      WHERE a.payment_id = ? AND a.recovered_at IS NULL AND a.status != 'scheduled'
      ORDER BY a.id DESC LIMIT 1`,
  ).get(paymentId) as unknown as Arm | undefined;
  return row ?? null;
}

/**
 * Resolves recoveries that were sent and never paid.
 *
 * Without this the bandit only ever hears about successes, so every arm looks
 * perfect and it learns nothing. A recovery that goes unanswered is the more
 * common outcome and the more informative one.
 *
 * The horizon scales with TIME_SCALE alongside the delays, so a compressed demo
 * resolves outcomes at the same compressed rate rather than never.
 */
export function expireStale(now: Date = new Date()): number {
  const horizonMs = (config.expiryHours * 3600_000) / config.timeScale;
  const cutoff = new Date(now.getTime() - horizonMs).toISOString();

  const stale = db.prepare(
    `SELECT a.id, a.strategy, f.failure_class
       FROM recovery_attempts a
       JOIN failed_payments f ON f.payment_id = a.payment_id
      WHERE a.status = 'sent' AND a.recovered_at IS NULL AND a.sent_at <= ?`,
  ).all(cutoff.replace("T", " ").slice(0, 19)) as unknown as (Arm & { id: number })[];

  for (const row of stale) {
    db.prepare("UPDATE recovery_attempts SET status = 'expired' WHERE id = ?").run(row.id);
    recordOutcome(row.failure_class, row.strategy, false);
  }
  if (stale.length) console.log(`[expire] ${stale.length} recovery attempt(s) went unanswered`);
  return stale.length;
}

/**
 * Reports recoveries left mid-send by a process that died.
 *
 * Deliberately does not reset them to 'scheduled'. The provider call may have
 * succeeded before the crash, so retrying risks the second live payment link
 * this whole mechanism exists to prevent. Surfacing them for a human to judge
 * is the safe default; automatic recovery here needs an idempotency key on the
 * provider call, which is the proper fix rather than a guess.
 */
export function reportStuckSends(): number {
  const stuck = db.prepare(
    "SELECT COUNT(*) n FROM recovery_attempts WHERE status = 'sending'",
  ).get() as { n: number };
  if (stuck.n > 0) {
    console.warn(
      `[dispatch] ${stuck.n} recovery attempt(s) stuck in 'sending' from a previous run — ` +
      "not retried automatically, since the payment link may already exist",
    );
  }
  return stuck.n;
}

/** Starts the dispatch loop. Returns a stop function. */
export function startDispatcher(): () => void {
  reportStuckSends();
  const timer = setInterval(() => {
    dispatchDue().catch((e) => console.error("[dispatch] loop error:", e));
    try {
      expireStale();
    } catch (e) {
      console.error("[expire] loop error:", e);
    }
  }, config.dispatchIntervalMs);
  timer.unref?.();
  console.log(`dispatcher polling every ${config.dispatchIntervalMs / 1000}s`);
  return () => clearInterval(timer);
}

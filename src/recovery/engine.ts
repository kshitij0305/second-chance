import { db } from "../db.ts";
import { linkProvider } from "../razorpay/links.ts";
import type { Decision } from "./strategy.ts";
import { config } from "../config.ts";
import { compose, formatAmount } from "./composer.ts";
import { channel, subjectFor } from "../delivery/channel.ts";
import { renderEmail } from "../delivery/email.ts";
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

// Nothing goes out at failure time. A customer who just failed is often still
// at the checkout retrying, and a link arriving mid-retry risks a double charge.
export function scheduleRecovery(payment: FailedPayment, decision: Decision): void {
  const existing = db.prepare(
    "SELECT COUNT(*) n FROM recovery_attempts WHERE payment_id = ?",
  ).get(payment.payment_id) as { n: number };

  // Razorpay retries webhook delivery on any non-2xx, so the same payment.failed
  // arrives more than once routinely — one event delivered three times gave one
  // customer two live recovery links. maxAttempts means N asks over time, each
  // after the last went unanswered; not N at once.
  const inFlight = db.prepare(
    `SELECT COUNT(*) n FROM recovery_attempts
      WHERE payment_id = ? AND status IN ('scheduled', 'sending', 'sent')`,
  ).get(payment.payment_id) as { n: number };

  if (inFlight.n > 0) {
    console.log(
      `[schedule] ${payment.payment_id} already has a recovery in flight — not scheduling another`,
    );
    return;
  }

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

// Between scheduling and dispatch the customer may have paid some other way, so
// every send is guarded. A link sent after that is noise at best, a second
// charge at worst.
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
    // Claim before doing anything slow. One atomic statement, so two readers
    // can't both win. Without it the dispatcher made two live payment links for
    // one recovery — and it was invisible afterwards, because the second send
    // just overwrote the first link's URL.
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

// Answered from captured webhooks, not by polling — the events are already on
// disk and a lookup per due recovery burns the rate limit the send needs.
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
    // This intent used to reach nothing but an explanation string. Actually hide
    // the failed method so the recovery offers a different route.
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

    // After the link exists, so the message can carry the real URL. Never blocks
    // the send — compose() falls back to a template.
    const composed = await compose(
      row.failure_class ?? "unknown",
      {
        name: null,
        method: row.method ?? "payment method",
        amount: formatAmount(row.amount),
        link: link.short_url,
      },
      // What the plan did, not what the class usually implies. If nothing was
      // hidden, the message must not tell them to switch.
      { steerToAnotherMethod: Boolean(link.excluded_method) },
    );

    // Actually send it. Until this existed the system stopped one step short of
    // its own premise: a recovery nobody receives cannot be recovered, which is
    // why the recovered figure was structurally zero rather than merely low.
    //
    // A delivery failure does not lose the recovery. The link exists, the
    // message exists, and both are recorded with the error so an operator can
    // see that the ask never left rather than wondering why nobody paid.
    // The composed message is an SMS. Sent as email verbatim it read as
    // phishing, because it has the same shape. The placeholders let the amount
    // become a stated fact and the link a button.
    const amount = formatAmount(row.amount);
    const email = renderEmail({
      template: composed.template,
      amount,
      link: link.short_url,
      reference: row.payment_id,
    });

    const delivery = await channel.send({
      to: row.email,
      subject: subjectFor(amount),
      body: email.text,
      html: email.html,
    });

    db.prepare(
      `UPDATE recovery_attempts
          SET status = 'sent', payment_link_id = ?, payment_link_url = ?,
              message = ?, message_source = ?, excluded_method = ?, sent_at = datetime('now'),
              delivery_channel = ?, delivered_to = ?, delivery_error = ?,
              delivered_at = CASE WHEN ? IS NULL THEN datetime('now') ELSE NULL END
        WHERE id = ?`,
    ).run(
      link.id, link.short_url, composed.text, composed.source, link.excluded_method ?? null,
      delivery.channel, delivery.to || null, delivery.error ?? null, delivery.error ?? null,
      row.id,
    );

    console.log(
      `[dispatch] ${row.payment_id} -> ${link.short_url} (${row.strategy}, message by ${composed.source}` +
      (link.excluded_method ? `, ${link.excluded_method} hidden` : "") +
      (delivery.error ? `, DELIVERY FAILED` : `, delivered via ${delivery.channel}`) + ")",
    );
    console.log(`           "${composed.text}"`);
    return true;
  } catch (error) {
    // Recorded, not just logged. A recovery that never went out is the thing an
    // operator most needs to see, and a line in a scrolling terminal isn't seen.
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

// Razorpay copies the link notes onto the payment that settles it, so
// payment.captured carries the original payment id. payment_link.paid is a
// second route to the same conclusion, so this has to be idempotent.
export function markRecoveredByOriginalPayment(originalPaymentId: string): boolean {
  // Read the arm before the update, so the outcome lands on the plan that was
  // actually used rather than whatever is current.
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

// Without this the bandit only hears about successes, every arm looks perfect,
// and it learns nothing. The horizon scales with TIME_SCALE so a compressed demo
// still resolves outcomes.
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

// Left mid-send by a dead process. Deliberately not reset to 'scheduled': the
// provider call may have succeeded before the crash, and retrying risks exactly
// the duplicate link this guards against. Doing it automatically needs an
// idempotency key on the provider call.
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

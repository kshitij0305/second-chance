import { db } from "../db.ts";
import { razorpay } from "../razorpay/client.ts";

export interface FailedPayment {
  payment_id: string;
  amount: number;
  currency: string;
  email?: string | null;
  contact?: string | null;
}

/**
 * Day 1 engine: one strategy, no branching, no model.
 *
 * This is deliberately dumb. The point right now is to prove a payment can
 * fail, be asked for again, and come back — end to end, on real webhooks.
 * The classifier, the policy engine and the strategy selection replace this.
 */
export async function attemptRecovery(payment: FailedPayment): Promise<void> {
  const strategy = "immediate_link";

  try {
    const link = await razorpay.paymentLink.create({
      amount: payment.amount,
      currency: payment.currency,
      accept_partial: false,
      description: "Your payment didn't go through — here's a fresh link",
      customer: {
        email: payment.email ?? undefined,
        contact: payment.contact ?? undefined,
      },
      // We do the sending ourselves, so Razorpay must not also notify the
      // customer — otherwise every recovery goes out twice.
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { recovers_payment_id: payment.payment_id, strategy },
    });

    db.prepare(
      `INSERT INTO recovery_attempts
         (payment_id, strategy, status, payment_link_id, payment_link_url, amount)
       VALUES (?, ?, 'sent', ?, ?, ?)`,
    ).run(payment.payment_id, strategy, link.id, link.short_url, payment.amount);

    // Day 1: "sending" is a log line. The channel adapter comes later.
    console.log(`[recovery] ${payment.payment_id} -> ${link.short_url} (${strategy})`);
  } catch (error) {
    // Record the failure rather than only logging it. A recovery that never
    // went out is the single most important thing for the operator to see, and
    // a line in a scrolling terminal is not seeing it.
    const message = describeError(error);
    db.prepare(
      `INSERT INTO recovery_attempts (payment_id, strategy, status, error, amount)
       VALUES (?, ?, 'failed', ?, ?)`,
    ).run(payment.payment_id, strategy, message, payment.amount);

    console.error(`[recovery] ${payment.payment_id} FAILED: ${message}`);
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
 * Attributes a recovery using the original payment id we planted in the link's
 * notes. Razorpay copies those notes onto the payment that settles the link, so
 * payment.captured alone is enough — payment_link.paid is a second, optional
 * route to the same conclusion.
 *
 * Safe to call twice: the recovered_at guard makes it idempotent, which matters
 * because both events can arrive for a single recovery.
 */
export function markRecoveredByOriginalPayment(originalPaymentId: string): boolean {
  const result = db.prepare(
    `UPDATE recovery_attempts
        SET recovered_at = datetime('now'), status = 'recovered'
      WHERE payment_id = ? AND recovered_at IS NULL`,
  ).run(originalPaymentId);
  return result.changes > 0;
}

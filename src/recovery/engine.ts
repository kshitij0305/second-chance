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
    `INSERT INTO recovery_attempts (payment_id, strategy, payment_link_id, payment_link_url, amount)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(payment.payment_id, strategy, link.id, link.short_url, payment.amount);

  // Day 1: "sending" is a log line. The channel adapter comes later.
  console.log(`[recovery] ${payment.payment_id} -> ${link.short_url} (${strategy})`);
}

export function markRecovered(paymentLinkId: string): boolean {
  const result = db.prepare(
    `UPDATE recovery_attempts
        SET recovered_at = datetime('now')
      WHERE payment_link_id = ? AND recovered_at IS NULL`,
  ).run(paymentLinkId);
  return result.changes > 0;
}

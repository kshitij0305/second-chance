import type { RazorpayPaymentEntity } from "../razorpay/types.ts";
import type { FailedPayment } from "./engine.ts";

/**
 * Translates Razorpay's payment entity into our domain shape.
 *
 * This function exists because the two vocabularies differ — most importantly
 * Razorpay's `id` is our `payment_id` — and doing the translation implicitly at
 * the call site silently produced an undefined primary key. Keeping it in one
 * typed, tested place means the compiler catches the next field that drifts.
 */
export function toFailedPayment(entity: RazorpayPaymentEntity): FailedPayment {
  if (!entity.id) throw new Error("Razorpay payment entity has no id");

  return {
    payment_id: entity.id,
    amount: entity.amount,
    currency: entity.currency,
    email: entity.email ?? null,
    contact: entity.contact ?? null,
    order_id: entity.order_id ?? null,
  };
}

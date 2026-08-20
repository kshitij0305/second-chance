import { test } from "node:test";
import assert from "node:assert/strict";
import { toFailedPayment } from "./mapper.ts";
import type { RazorpayPaymentEntity } from "../razorpay/types.ts";

const entity: RazorpayPaymentEntity = {
  id: "pay_abc123", amount: 249900, currency: "INR", status: "failed",
  method: "card", email: "a@b.com", contact: "+919999999999",
  error_code: "BAD_REQUEST_ERROR", error_reason: "payment_failed",
};

test("maps Razorpay's `id` onto our `payment_id`", () => {
  assert.equal(toFailedPayment(entity).payment_id, "pay_abc123");
});

test("carries amount and currency through unchanged", () => {
  const mapped = toFailedPayment(entity);
  assert.equal(mapped.amount, 249900);
  assert.equal(mapped.currency, "INR");
});

test("normalises missing contact details to null, never undefined", () => {
  // node:sqlite throws on undefined bind values, so null is load-bearing here.
  const mapped = toFailedPayment({ ...entity, email: undefined, contact: undefined });
  assert.equal(mapped.email, null);
  assert.equal(mapped.contact, null);
});

test("refuses an entity with no id rather than writing an undefined key", () => {
  assert.throws(() => toFailedPayment({ ...entity, id: "" as string }), /no id/);
});

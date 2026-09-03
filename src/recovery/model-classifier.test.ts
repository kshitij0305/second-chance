import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDeep } from "./classifier.ts";
import type { RazorpayPaymentEntity } from "../razorpay/types.ts";

// These don't call the model. They assert the boundary around it: a rules answer
// is never overridden, a generic description is never sent, and a model failure
// leaves the rules standing. Whether it classifies well is a different question
// and not one for a unit test that would need a network.

const entity = (over: Partial<RazorpayPaymentEntity> = {}): RazorpayPaymentEntity => ({
  id: "pay_test", amount: 249900, currency: "INR", status: "failed", method: "card",
  error_code: "BAD_REQUEST_ERROR", error_reason: "payment_failed",
  error_description: "Payment failed", ...over,
});

test("a class the rules found is never sent to the model", async () => {
  // The rules are authoritative over the documented vocabulary. Asking a model
  // to second-guess a known error code would trade determinism for nothing.
  const result = await classifyDeep(entity({ error_reason: "insufficient_fund" }));
  assert.equal(result.failureClass, "insufficient_funds");
  assert.equal(result.classifier, "rules");
});

test("a description the rules recognise is never sent to the model", async () => {
  const result = await classifyDeep(entity({
    error_description: "Your payment didn't go through as it was declined by the bank.",
  }));
  assert.equal(result.failureClass, "instrument_rejected");
  assert.equal(result.classifier, "rules");
});

test("a generic description is never sent to the model", async () => {
  // "Payment failed" says something went wrong, not what. Handing it to a model
  // is asking it to invent a cause, and it would oblige.
  for (const description of ["Payment failed", "Transaction declined", "An error occurred", ""]) {
    const result = await classifyDeep(entity({ error_description: description }));
    assert.equal(result.classifier, "rules", `"${description}" reached the model`);
    assert.equal(result.failureClass, "unknown");
  }
});

test("a model answer is never reported as observed", async () => {
  // Nothing about a model reading a sentence was observed arriving. If the model
  // ran at all, the evidence must say inferred.
  const result = await classifyDeep(entity({
    error_description: "Your card has expired. Please use a different card.",
  }));
  if (result.classifier === "model") {
    assert.equal(result.evidence, "inferred");
    assert.match(result.basis, /model/i);
  }
});

test("the classification is usable whether or not a model was available", async () => {
  // With no GROQ_API_KEY this exercises the fallback; with one it exercises the
  // model path. Either way the caller gets a valid class and a stated basis,
  // which is the property the rest of the system depends on.
  const result = await classifyDeep(entity({
    error_description: "The issuer is not available in your region at this time.",
  }));
  const classes = [
    "transient_provider", "insufficient_funds", "instrument_rejected",
    "authentication_abandoned", "customer_cancelled", "unknown",
  ];
  assert.ok(classes.includes(result.failureClass));
  assert.ok(result.basis.length > 10);
  assert.ok(result.classifier === "rules" || result.classifier === "model");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify } from "./classifier.ts";
import type { RazorpayPaymentEntity } from "../razorpay/types.ts";

const observed: RazorpayPaymentEntity[] = JSON.parse(
  readFileSync(new URL("./fixtures/observed-failures.json", import.meta.url), "utf8"),
);

const entity = (over: Partial<RazorpayPaymentEntity> = {}): RazorpayPaymentEntity => ({
  id: "pay_test", amount: 100000, currency: "INR", status: "failed",
  method: "card", error_code: "BAD_REQUEST_ERROR", error_reason: "payment_failed",
  error_description: "Payment failed", ...over,
});

// --- Real captured payloads -------------------------------------------------
// These are payloads the provider actually sent, scrubbed of personal data.
// They are the only evidence in this repository that is not invented.

test("every real captured failure classifies without throwing", () => {
  assert.equal(observed.length, 7);
  for (const e of observed) {
    const result = classify(e);
    assert.ok(result.failureClass, `no class for ${e.id}`);
    assert.ok(result.basis.length > 0, `no basis for ${e.id}`);
  }
});

test("the real netbanking failure is read as a rejected instrument, not a blanket outage", () => {
  const netbanking = observed.find((e) => e.method === "netbanking")!;
  const result = classify(netbanking);
  // Its description says the bank declined it and to try another method — the
  // opposite strategy from the wallet failure below, despite both carrying the
  // same generic error_reason.
  assert.equal(result.failureClass, "instrument_rejected");
  assert.equal(result.evidence, "observed");
});

test("the real wallet failure is read as transient", () => {
  const wallet = observed.find((e) => e.method === "wallet")!;
  const result = classify(wallet);
  assert.equal(result.failureClass, "transient_provider");
  assert.equal(result.evidence, "observed");
});

test("real card failures stay unknown rather than being guessed at", () => {
  for (const card of observed.filter((e) => e.method === "card")) {
    assert.equal(classify(card).failureClass, "unknown");
  }
});

test("reading error_reason alone would have collapsed the distinct real failures", () => {
  // Guards the finding this classifier exists because of: every real failure
  // carries error_reason "payment_failed", so a classifier keyed on that field
  // could not tell these two apart. Their classes must differ.
  const netbanking = classify(observed.find((e) => e.method === "netbanking")!);
  const wallet = classify(observed.find((e) => e.method === "wallet")!);
  assert.equal(observed.every((e) => e.error_reason === "payment_failed"), true);
  assert.notEqual(netbanking.failureClass, wallet.failureClass);
});

// --- Documented vocabulary --------------------------------------------------
// Never observed arriving. Classified from published documentation, and
// reported as such.

test("documented error reasons map to their class and are marked documented", () => {
  const cases: [string, string][] = [
    ["insufficient_fund", "insufficient_funds"],
    ["payment_timed_out", "transient_provider"],
    ["gateway_technical_error", "transient_provider"],
    ["authentication_failed", "authentication_abandoned"],
    ["payment_cancelled", "customer_cancelled"],
    ["card_declined", "instrument_rejected"],
    ["card_disabled_for_online_payments", "instrument_rejected"],
    ["card_number_invalid", "instrument_rejected"],
  ];
  for (const [reason, expected] of cases) {
    const result = classify(entity({ error_reason: reason }));
    assert.equal(result.failureClass, expected, `${reason} -> ${result.failureClass}`);
    assert.equal(result.evidence, "documented", `${reason} evidence`);
  }
});

test("a specific error_reason outranks the description", () => {
  const result = classify(entity({
    error_reason: "insufficient_fund",
    error_description: "Your payment did not go through due to a temporary issue.",
  }));
  assert.equal(result.failureClass, "insufficient_funds");
});

// --- Fallbacks --------------------------------------------------------------

test("generic netbanking and wallet failures fall back to transient", () => {
  for (const method of ["netbanking", "wallet"]) {
    const result = classify(entity({ method, error_description: "Payment failed" }));
    assert.equal(result.failureClass, "transient_provider");
  }
});

test("an unrecognised error_reason is unknown, not silently bucketed", () => {
  const result = classify(entity({ error_reason: "some_future_reason_we_have_never_seen" }));
  assert.equal(result.failureClass, "unknown");
  assert.equal(result.evidence, "inferred");
});

test("an unrecognised method is unknown and says so", () => {
  const result = classify(entity({ method: "cardless_emi" }));
  assert.equal(result.failureClass, "unknown");
  assert.match(result.basis, /cardless_emi/);
});

test("missing fields do not throw", () => {
  const result = classify({ id: "pay_x", amount: 100, currency: "INR", status: "failed" });
  assert.equal(result.failureClass, "unknown");
});

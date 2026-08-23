import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, formatAmount } from "./composer.ts";
import { renderTemplate, INTENT } from "./templates.ts";
import type { FailureClass } from "./classifier.ts";

const CLASSES: FailureClass[] = [
  "transient_provider", "insufficient_funds", "instrument_rejected",
  "authentication_abandoned", "customer_cancelled", "unknown",
];

const context = {
  name: "Asha", method: "card", amount: "₹2,749",
  link: "https://rzp.io/rzp/example",
};

// --- Validation: what we refuse to send -------------------------------------
// The model writes prose; it never handles facts. These assert the fence.

test("a message inventing a number is rejected", () => {
  // The model is given no amounts, so any digit it emits is fabricated —
  // a made-up figure, a deadline, or an account fragment.
  assert.match(
    validate("Hi, your {{amount}} payment failed. Pay within 24 hours: {{link}}")!,
    /invented/,
  );
});

test("a message inventing a discount is rejected", () => {
  assert.match(
    validate("Hi, your {{amount}} payment failed. Here is a discount: {{link}}")!,
    /discount/,
  );
});

test("a message smuggling in its own URL is rejected", () => {
  assert.match(
    validate("Your {{amount}} payment failed. Go to https://example.com or {{link}}")!,
    /URL/,
  );
});

test("a message missing the link placeholder is rejected", () => {
  assert.match(validate("Your {{amount}} payment did not go through.")!, /link/);
});

test("a message missing the amount placeholder is rejected", () => {
  assert.match(validate("Your payment did not go through: {{link}}")!, /amount/);
});

test("an over-long message is rejected", () => {
  const long = "x".repeat(400) + " {{amount}} {{link}}";
  assert.match(validate(long)!, /too long/);
});

test("an empty response is rejected", () => {
  assert.equal(validate(""), "empty");
});

test("a well-formed message passes", () => {
  assert.equal(
    validate("Hi Asha, your {{amount}} payment did not go through. You can try again here: {{link}}"),
    null,
  );
});

// --- Templates: the floor the model writes above ----------------------------

test("every failure class has a template and a brief", () => {
  for (const failureClass of CLASSES) {
    const text = renderTemplate(failureClass, context);
    assert.ok(text.length > 40, `${failureClass} template too thin`);
    assert.ok(INTENT[failureClass]?.length > 40, `${failureClass} brief too thin`);
  }
});

test("every template carries the link and the amount", () => {
  for (const failureClass of CLASSES) {
    const text = renderTemplate(failureClass, context);
    assert.ok(text.includes(context.link), `${failureClass} drops the link`);
    assert.ok(text.includes(context.amount), `${failureClass} drops the amount`);
  }
});

test("every template fits inside the length the validator enforces", () => {
  for (const failureClass of CLASSES) {
    assert.ok(renderTemplate(failureClass, context).length <= 320, `${failureClass} too long`);
  }
});

test("the insufficient funds message never names the reason", () => {
  // Telling someone their account was empty is a needless embarrassment, and it
  // is the one class where the honest reason should not be stated.
  const text = renderTemplate("insufficient_funds", context).toLowerCase();
  for (const word of ["insufficient", "balance", "funds", "declined"]) {
    assert.ok(!text.includes(word), `insufficient_funds template says "${word}"`);
  }
});

test("the rejected-instrument message actually steers to another method", () => {
  const text = renderTemplate("instrument_rejected", context).toLowerCase();
  assert.match(text, /another method|different method|another way/);
});

test("no template uses pressure tactics", () => {
  for (const failureClass of CLASSES) {
    const text = renderTemplate(failureClass, context);
    assert.ok(!text.includes("!"), `${failureClass} uses an exclamation mark`);
    assert.ok(!/hurry|urgent|last chance|expires/i.test(text), `${failureClass} applies pressure`);
  }
});

test("a missing name degrades to a greeting rather than an empty slot", () => {
  const text = renderTemplate("unknown", { ...context, name: null });
  assert.ok(!text.includes("null") && !text.includes("undefined"));
  assert.ok(text.startsWith("Hi"));
});

// --- Amounts are rendered by code, never by the model -----------------------

test("amounts render in Indian digit grouping", () => {
  assert.equal(formatAmount(274900), "₹2,749");
  assert.equal(formatAmount(1499900), "₹14,999");
  assert.equal(formatAmount(10000000), "₹1,00,000");
});

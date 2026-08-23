import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectStrategy, strategyFor, allStrategies } from "./strategy.ts";
import { classify } from "./classifier.ts";
import type { RazorpayPaymentEntity } from "../razorpay/types.ts";

const NOW = new Date("2026-08-23T10:00:00.000Z");

const observed: RazorpayPaymentEntity[] = JSON.parse(
  readFileSync(new URL("./fixtures/observed-failures.json", import.meta.url), "utf8"),
);

// --- The invariant the whole design rests on --------------------------------

test("no strategy ever sends immediately", () => {
  // A customer who just failed is often still at the checkout retrying. A
  // recovery link arriving mid-retry risks a double charge, which costs more
  // trust than the recovery earns.
  for (const [failureClass, strategy] of allStrategies()) {
    assert.ok(strategy.delayMinutes > 0, `${failureClass} has no delay floor`);
  }
});

test("every failure class has a strategy and a rationale", () => {
  for (const [failureClass, strategy] of allStrategies()) {
    assert.ok(strategy.name, `${failureClass} unnamed`);
    assert.ok(strategy.maxAttempts >= 1, `${failureClass} allows no attempts`);
    assert.ok(strategy.rationale.length > 20, `${failureClass} rationale too thin`);
  }
});

// --- The distinctions that justify the product ------------------------------

test("a dead instrument is retried on a different rail, an outage on the same one", () => {
  const rejected = strategyFor("instrument_rejected");
  const transient = strategyFor("transient_provider");
  assert.equal(rejected.avoidFailedMethod, true);
  assert.equal(transient.avoidFailedMethod, false);
});

test("an empty account waits hours; a bank blip waits minutes", () => {
  // Retrying an empty account within the hour just declines again.
  assert.ok(
    strategyFor("insufficient_funds").delayMinutes >
    strategyFor("transient_provider").delayMinutes * 10,
  );
});

test("a dead instrument is not made to wait, since waiting changes nothing", () => {
  assert.ok(
    strategyFor("instrument_rejected").delayMinutes <
    strategyFor("transient_provider").delayMinutes,
  );
});

test("a customer who cancelled is nudged once, and not soon", () => {
  const cancelled = strategyFor("customer_cancelled");
  assert.equal(cancelled.maxAttempts, 1);
  assert.ok(cancelled.delayMinutes >= 12 * 60);
});

test("abandoned authentication gets the fastest re-offer available", () => {
  const fastest = Math.min(...allStrategies().map(([, s]) => s.delayMinutes));
  assert.equal(strategyFor("authentication_abandoned").delayMinutes, fastest);
});

test("an undiagnosed failure is treated cautiously, not optimistically", () => {
  const unknown = strategyFor("unknown");
  assert.equal(unknown.avoidFailedMethod, false);
  assert.ok(unknown.delayMinutes >= strategyFor("transient_provider").delayMinutes);
  assert.ok(unknown.maxAttempts <= strategyFor("transient_provider").maxAttempts);
});

// --- Scheduling -------------------------------------------------------------

test("scheduledFor is the delay applied to the supplied clock", () => {
  const decision = selectStrategy(
    { failureClass: "transient_provider", evidence: "observed", basis: "test" },
    NOW,
  );
  assert.equal(decision.scheduledFor, "2026-08-23T10:20:00.000Z");
});

test("the explanation records the finding, the evidence and the plan", () => {
  const decision = selectStrategy(
    { failureClass: "insufficient_funds", evidence: "documented", basis: "error_reason says so" },
    NOW,
  );
  assert.match(decision.explanation, /insufficient_funds/);
  assert.match(decision.explanation, /documented/);
  assert.match(decision.explanation, /error_reason says so/);
  assert.match(decision.explanation, /wait_for_funds/);
  assert.match(decision.explanation, /18h/);
});

// --- End to end on real captured payloads -----------------------------------

test("the two diagnosable real failures get genuinely different plans", () => {
  const netbanking = observed.find((e) => e.method === "netbanking")!;
  const wallet = observed.find((e) => e.method === "wallet")!;

  const a = selectStrategy(classify(netbanking), NOW);
  const b = selectStrategy(classify(wallet), NOW);

  assert.notEqual(a.strategy.name, b.strategy.name);
  // The netbanking failure said the bank declined it: switch rails, promptly.
  assert.equal(a.strategy.avoidFailedMethod, true);
  // The wallet failure said temporary issue: same rail, wait it out.
  assert.equal(b.strategy.avoidFailedMethod, false);
  assert.ok(b.strategy.delayMinutes > a.strategy.delayMinutes);
});

test("undiagnosable real card failures all land on the conservative default", () => {
  for (const card of observed.filter((e) => e.method === "card")) {
    const decision = selectStrategy(classify(card), NOW);
    assert.equal(decision.strategy.name, "conservative_default");
  }
});

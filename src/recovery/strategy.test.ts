import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectStrategy, strategyFor, allStrategies, allVariants } from "./strategy.ts";
import { variantsFor } from "./variants.ts";
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
  // trust than the recovery earns. This must hold for every candidate plan the
  // bandit can reach, not just the defaults - an arm that could be learned into
  // would bypass the floor entirely.
  for (const [failureClass, strategy] of allVariants()) {
    assert.ok(strategy.delayMinutes > 0, `${failureClass}/${strategy.name} has no delay floor`);
  }
});

test("every candidate plan has a name, an attempt cap and a rationale", () => {
  for (const [failureClass, strategy] of allVariants()) {
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
    { failureClass: "transient_provider", evidence: "observed", classifier: "rules", basis: "test" },
    NOW,
    { learning: false, timeScale: 1 },
  );
  assert.equal(decision.scheduledFor, "2026-08-23T10:20:00.000Z");
});

test("the explanation records the finding, the evidence and the plan", () => {
  const decision = selectStrategy(
    { failureClass: "insufficient_funds", evidence: "documented", classifier: "rules", basis: "error_reason says so" },
    NOW,
    { learning: false, timeScale: 1 },
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

  // Learning pinned off. This asserts what the classification implies, which is
  // deterministic; with the bandit active the arm is drawn at random and the
  // delay comparison below flips whenever transient_provider draws its 5-minute
  // arm against instrument_rejected's 30-minute one. That made this test flaky
  // from the moment the bandit landed.
  const a = selectStrategy(classify(netbanking), NOW, { learning: false });
  const b = selectStrategy(classify(wallet), NOW, { learning: false });

  assert.notEqual(a.strategy.name, b.strategy.name);
  // The netbanking failure said the bank declined it: switch rails, promptly.
  assert.equal(a.strategy.avoidFailedMethod, true);
  // The wallet failure said temporary issue: same rail, wait it out.
  assert.equal(b.strategy.avoidFailedMethod, false);
  assert.ok(b.strategy.delayMinutes > a.strategy.delayMinutes);
});

test("undiagnosable real card failures all land on the conservative default", () => {
  for (const card of observed.filter((e) => e.method === "card")) {
    const decision = selectStrategy(classify(card), NOW, { learning: false });
    assert.equal(decision.strategy.name, "conservative_default");
  }
});

test("with learning on, an undiagnosed failure still gets a plan built for uncertainty", () => {
  // The bandit may pick any arm for this class, but every arm has to be one we
  // would defend for a failure we could not diagnose.
  const card = observed.find((e) => e.method === "card")!;
  for (let i = 0; i < 40; i++) {
    const decision = selectStrategy(classify(card), NOW, { learning: true });
    const names = variantsFor("unknown").map((v) => v.name);
    assert.ok(names.includes(decision.strategy.name), `picked ${decision.strategy.name}`);
    assert.ok(decision.strategy.delayMinutes > 0);
  }
});

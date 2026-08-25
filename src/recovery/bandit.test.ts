import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, existsSync } from "node:fs";

// A scratch database, set before anything reads config.
const DB = "./bandit-test.db";
process.env.DB_PATH = DB;
process.env.RAZORPAY_KEY_ID ??= "rzp_test_x";
process.env.RAZORPAY_KEY_SECRET ??= "x";
process.env.RAZORPAY_WEBHOOK_SECRET ??= "x";

const { recordOutcome, statsFor, selectVariant } = await import("./bandit.ts");
const { db } = await import("../db.ts");
const { defaultVariant, variantsFor } = await import("./variants.ts");

before(() => db.exec("DELETE FROM strategy_outcomes"));
after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(DB + suffix)) unlinkSync(DB + suffix);
  }
});

test("an arm nobody has tried reads as unknown, not as bad", () => {
  // A Beta(1,1) prior puts an untried arm at 0.5. Starting it at zero would
  // mean the first arm to get lucky is never challenged.
  for (const arm of statsFor("transient_provider")) {
    assert.equal(arm.observations, 0);
    assert.equal(arm.rate, 0.5);
  }
});

test("outcomes accumulate against the arm that produced them", () => {
  recordOutcome("transient_provider", "quick_retry", true);
  recordOutcome("transient_provider", "quick_retry", true);
  recordOutcome("transient_provider", "quick_retry", false);

  const arm = statsFor("transient_provider").find((a) => a.variant === "quick_retry")!;
  assert.equal(arm.successes, 2);
  assert.equal(arm.failures, 1);
  assert.equal(arm.observations, 3);
});

test("outcomes never leak between failure classes", () => {
  const other = statsFor("unknown").find((a) => a.observations > 0);
  assert.equal(other, undefined);
});

test("with learning off, every class returns its default and nothing else", () => {
  for (let i = 0; i < 20; i++) {
    for (const cls of ["transient_provider", "unknown", "instrument_rejected"] as const) {
      assert.equal(selectVariant(cls, false).strategy.name, defaultVariant(cls).name);
    }
  }
});

test("with learning on, selection stays inside the declared arms", () => {
  const names = variantsFor("unknown").map((v) => v.name);
  for (let i = 0; i < 60; i++) {
    assert.ok(names.includes(selectVariant("unknown", true).strategy.name));
  }
});

test("given lopsided evidence, traffic concentrates on the better arm", () => {
  db.exec("DELETE FROM strategy_outcomes");
  // 60/100 against 10/100 is a gap Thompson sampling should resolve decisively.
  for (let i = 0; i < 100; i++) {
    recordOutcome("instrument_rejected", "switch_rails", i < 60);
    recordOutcome("instrument_rejected", "switch_rails_after_a_pause", i < 10);
  }

  // Sampled behaviour, so this asserts a proportion rather than an outcome. The
  // draw count is high enough that the assertion is far outside the noise band —
  // a tighter test on fewer draws would fail occasionally for no reason, and a
  // suite that fails occasionally teaches people to rerun it instead of reading
  // it.
  const draws = 2000;
  let better = 0;
  for (let i = 0; i < draws; i++) {
    if (selectVariant("instrument_rejected", true).strategy.name === "switch_rails") better++;
  }
  assert.ok(better > draws * 0.9, `picked the better arm only ${better}/${draws} times`);
});

test("a thin lead does not produce false confidence", () => {
  db.exec("DELETE FROM strategy_outcomes");
  // Three observations each, one apart. There is no real evidence here, and the
  // bandit should keep exploring rather than commit.
  recordOutcome("instrument_rejected", "switch_rails", true);
  recordOutcome("instrument_rejected", "switch_rails", true);
  recordOutcome("instrument_rejected", "switch_rails", false);
  recordOutcome("instrument_rejected", "switch_rails_after_a_pause", true);
  recordOutcome("instrument_rejected", "switch_rails_after_a_pause", false);
  recordOutcome("instrument_rejected", "switch_rails_after_a_pause", false);

  const draws = 2000;
  let leader = 0;
  for (let i = 0; i < draws; i++) {
    if (selectVariant("instrument_rejected", true).strategy.name === "switch_rails") leader++;
  }
  // Expected share sits near 65%. The bounds are deliberately loose: the claim is
  // "still exploring", not a specific ratio, and asserting the ratio would make
  // this fail on ordinary variance.
  assert.ok(
    leader > draws * 0.25 && leader < draws * 0.85,
    `committed too hard on thin evidence: ${leader}/${draws}`,
  );
});

test("the selection reason is recorded for the audit trail", () => {
  const selection = selectVariant("instrument_rejected", true);
  assert.ok(selection.reason.length > 10);
  assert.match(selection.reason, /sampled|exploring/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { cohensKappa, describeKappa, type Answer } from "./kappa.ts";

/** These are ratios of ratios, so exact equality fails on the last bit. */
const close = (actual: number, expected: number, why?: string) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    why ?? `expected ${expected}, got ${actual}`,
  );

/** Builds two rater arrays with the given confusion counts. */
function raters(bothYes: number, aYesBNo: number, aNoBYes: number, bothNo: number) {
  const a: Answer[] = [], b: Answer[] = [];
  const push = (x: Answer, y: Answer, times: number) => {
    for (let i = 0; i < times; i++) { a.push(x); b.push(y); }
  };
  push("yes", "yes", bothYes);
  push("yes", "no", aYesBNo);
  push("no", "yes", aNoBYes);
  push("no", "no", bothNo);
  return [a, b] as const;
}

test("the textbook worked example", () => {
  // 50 items: 20 both yes, 15 both no, 5 and 10 the two disagreements.
  // po = 35/50 = 0.7. Marginals 25/50 and 30/50 give pe = 0.5.
  // kappa = (0.7 - 0.5) / 0.5 = 0.4.
  const [a, b] = raters(20, 5, 10, 15);
  const r = cohensKappa(a, b);
  close(r.po, 0.7);
  close(r.pe, 0.5);
  close(r.kappa, 0.4);
});

test("perfect agreement is 1", () => {
  const [a, b] = raters(30, 0, 0, 20);
  close(cohensKappa(a, b).kappa, 1);
});

test("agreement exactly at chance is 0", () => {
  // Both raters say yes half the time, and their answers line up no better
  // than a coin would: pe = 0.5 and po = 0.5.
  const [a, b] = raters(25, 25, 25, 25);
  const r = cohensKappa(a, b);
  close(r.po, 0.5);
  close(r.pe, 0.5);
  close(r.kappa, 0);
});

test("systematic inversion goes negative", () => {
  const [a, b] = raters(0, 25, 25, 0);
  assert.ok(cohensKappa(a, b).kappa < 0);
});

test("two raters who always say yes have no measurable agreement", () => {
  // pe is 1: there is no headroom above chance, so kappa is 0/0. The point of
  // the whole statistic is that this case must not come back as 1.0.
  const [a, b] = raters(40, 0, 0, 0);
  const r = cohensKappa(a, b);
  close(r.po, 1);
  close(r.pe, 1);
  assert.ok(Number.isNaN(r.kappa));
  assert.match(describeKappa(r.kappa), /undefined/);
});

test("high agreement can still produce a low kappa", () => {
  // The paradox, concretely. 95 of 100 items agree, which sounds excellent,
  // but 94 of them are one category, so chance alone explains almost all of it.
  const [a, b] = raters(94, 3, 2, 1);
  const r = cohensKappa(a, b);
  close(r.po, 0.95);
  assert.ok(r.kappa < 0.3, `expected a low kappa despite 95% agreement, got ${r.kappa}`);
  assert.ok(r.prevalenceIndex > 0.9);
});

test("the confidence interval narrows as n grows", () => {
  const small = cohensKappa(...raters(20, 5, 10, 15));
  const large = cohensKappa(...raters(200, 50, 100, 150));
  assert.ok(Math.abs(large.kappa - small.kappa) < 1e-9, "same proportions, same kappa");
  assert.ok(large.se < small.se, "ten times the items should tighten the interval");
});

test("mismatched arrays throw rather than silently misalign", () => {
  assert.throws(() => cohensKappa(["yes", "no"], ["yes"]), /differ in length/);
  assert.throws(() => cohensKappa([], []), /no items/);
});

test("the bias index catches one rater saying yes more than the other", () => {
  const even = cohensKappa(...raters(20, 10, 10, 20));
  const lopsided = cohensKappa(...raters(20, 20, 0, 20));
  close(even.biasIndex, 0);
  assert.ok(lopsided.biasIndex > 0.3);
});

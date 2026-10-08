import { test } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT, BATCH_SYSTEM_PROMPT, passes, claimsFor } from "./judge.ts";

// The batched judge is only comparable to the single-claim one if they are
// given the same rules. These assert that, because the failure is silent: edit
// a rule into one prompt and the two runs disagree for a reason that looks like
// a finding about batching.
const RULES = [
  "Do not judge whether the message is good.",
  "Judge the text in front of you, not what you assume the sender meant.",
  "The statement does not have to appear word for word.",
  "But the message has to say it.",
  "If your reason would use the words implying, suggesting, or hinting, the answer is no.",
];

test("both judge prompts carry every shared rule", () => {
  for (const rule of RULES) {
    assert.ok(SYSTEM_PROMPT.includes(rule), `single-claim prompt is missing: ${rule}`);
    assert.ok(BATCH_SYSTEM_PROMPT.includes(rule), `batched prompt is missing: ${rule}`);
  }
});

test("neither prompt reveals whether a claim is required or forbidden", () => {
  // Polarity is decided in code. A judge told a rule is a prohibition answers
  // what you want to hear, and that is the whole reason for passes().
  //
  // Narrowly worded on purpose: a bare /must not/ matches the batched prompt's
  // "your answer must not depend on your answer to any other", which is an
  // instruction about independence and not a hint about the claim.
  for (const [name, prompt] of [["single", SYSTEM_PROMPT], ["batch", BATCH_SYSTEM_PROMPT]] as const) {
    assert.ok(!/mustnot|forbidden|prohibit|is required|should be (true|false)/i.test(prompt), name);
  }
});

test("the batched prompt asks for one verdict per statement, independently", () => {
  assert.match(BATCH_SYSTEM_PROMPT, /must not depend on your answer to any other/);
  assert.match(BATCH_SYSTEM_PROMPT, /Answer every statement you are given, once each/);
  // Statements are echoed back so verdicts can be matched by text rather than
  // position; matching on order misattributes everything after a dropped one.
  assert.match(BATCH_SYSTEM_PROMPT, /copy each statement back exactly/);
  assert.match(BATCH_SYSTEM_PROMPT, /"statement"/);
});

test("polarity is applied in code, not asked for", () => {
  assert.equal(passes("must", "yes"), true);
  assert.equal(passes("must", "no"), false);
  assert.equal(passes("mustNot", "no"), true);
  assert.equal(passes("mustNot", "yes"), false);
  // An unparseable answer must never read as a pass on a required claim.
  assert.equal(passes("must", "unparseable"), false);
  // On a forbidden claim it must not read as a pass either: "we could not tell"
  // is not evidence the message is clean.
  assert.equal(passes("mustNot", "unparseable"), false);
});

test("every class's claim set includes the universal ones", () => {
  const claims = claimsFor("customer_cancelled").map((c) => c.claim);
  assert.ok(claims.includes("contains the {{amount}} placeholder"));
  assert.ok(claims.includes("criticises the customer"));
  assert.ok(claims.includes("says that paying is optional or that no action is required"));
});

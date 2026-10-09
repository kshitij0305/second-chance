/**
 * Judges every claim on a message in one call instead of one call per claim,
 * then scores the result against the single-claim run.
 *
 *   npm run judge:batched
 *
 * The saving is real: 492 calls re-send the system prompt and the message once
 * per claim. 56 calls send each once. About 143,000 tokens against 40,000, on a
 * 200,000 daily tier.
 *
 * The cost is that this is a different judge. One claim per call has no ordering
 * and nothing to compare; nine at once has both, and the judge may answer for
 * consistency across claims rather than reading each cold. A claim with two
 * branches already proved this model will answer the first thing it is asked and
 * drop the second.
 *
 * So the script does not assume the saving is free. It needs judge_results.json
 * from a single-claim run over the same eval_results.json, and reports the
 * agreement between them. High agreement means the cheap judge is the same
 * judge. Low agreement means it is not, and the tokens were not the price.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CASES } from "../src/eval/cases.ts";
import { ask, askAll, claimsFor, describeInput, passes, type ClaimKind } from "../src/eval/judge.ts";
import { cohensKappa, describeKappa, type Answer } from "../src/eval/kappa.ts";

if (!process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY is not set — nothing to judge.");
  process.exit(1);
}

interface EvalResult { id: string; name?: string | null; method: string; template: string }
interface Verdict {
  id: string;
  claim: string;
  kind: ClaimKind;
  answer: string;
  pass: boolean;
  reason: string;
  /** false when the batch left this claim out and it had to be re-asked alone. */
  batched: boolean;
}

const results: EvalResult[] = JSON.parse(readFileSync("eval_results.json", "utf8"));

// Resume. Writing each verdict as it arrives keeps them, but without this a
// retry starts over and pays for the lot again — which is the whole point of
// the exercise. A DNS blip 417 judgements in is what prompted it.
const OUT = "judge_results_batched.json";
const verdicts: Verdict[] = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
const already = new Set(verdicts.map((v) => `${v.id}\u0000${v.claim}`));
if (verdicts.length) console.log(`resuming with ${verdicts.length} judgements already recorded`);
let calls = 0;
let refills = 0;

for (const result of results) {
  const testCase = CASES.find((c) => c.id === result.id);
  if (!testCase) {
    console.warn(`no case for result id ${result.id} — skipped`);
    continue;
  }

  const input = describeInput(result.method, result.name);
  const claims = claimsFor(testCase.failureClass, testCase.must, testCase.mustNot);

  // Skip whole messages already done, so a resume does not re-batch them.
  const outstanding = claims.filter((c) => !already.has(`${result.id}\u0000${c.claim}`));
  if (!outstanding.length) {
    process.stdout.write("-");
    continue;
  }

  const answered = await askAll(result.template, input, outstanding.map((c) => c.claim));
  calls++;

  for (const { claim, kind } of outstanding) {
    let judgement = answered.get(claim);
    let batched = true;
    if (!judgement) {
      // The batch dropped it. Ask singly rather than guess — a hole is
      // recoverable, a wrong verdict looks like a finding.
      judgement = await ask(result.template, input, claim);
      calls++;
      refills++;
      batched = false;
    }
    const pass = passes(kind, judgement.answer);
    verdicts.push({ id: result.id, claim, kind, answer: judgement.answer, pass, reason: judgement.reason, batched });
    writeFileSync(OUT, JSON.stringify(verdicts, null, 2));
    process.stdout.write(batched ? (pass ? "." : "F") : (pass ? "·" : "f"));
  }
}

console.log("\n");
const failed = verdicts.filter((v) => !v.pass);
console.log(`${verdicts.length} judgements, ${failed.length} failed`);
console.log(`${calls} calls — a single-claim run over the same messages is ${verdicts.length}.`);
if (refills) console.log(`${refills} claims were dropped by the batch and re-asked alone.`);
for (const f of failed) console.log(`  F ${f.id}  |  ${f.claim}  |  ${f.reason}`);

// The part that decides whether any of this was worth it.
if (!existsSync("judge_results.json")) {
  console.log(`\nNo judge_results.json to compare against. Run npm run judge on these`);
  console.log(`same messages first, or the saving is unmeasured.`);
  process.exit(0);
}

const single: Verdict[] = JSON.parse(readFileSync("judge_results.json", "utf8"));
const bySingle = new Map(single.map((v) => [`${v.id}\u0000${v.claim}`, v]));
const paired = verdicts.filter((v) => bySingle.has(`${v.id}\u0000${v.claim}`));

console.log(`\n\nBatched against single-claim`);
console.log("─".repeat(72));
if (paired.length < verdicts.length) {
  console.log(`${paired.length} of ${verdicts.length} judgements line up. A gap means the two runs`);
  console.log(`saw different messages or a different claim set, which makes the rest moot.\n`);
}

const a = paired.map((v) => v.answer as Answer);
const b = paired.map((v) => bySingle.get(`${v.id}\u0000${v.claim}`)!.answer as Answer);
const r = cohensKappa(a, b);
const k = Number.isNaN(r.kappa) ? "undefined" : r.kappa.toFixed(3);
console.log(`   n                    ${r.n}`);
console.log(`   agreement            ${(100 * r.po).toFixed(1)}%`);
console.log(`   kappa                ${k}  (${describeKappa(r.kappa)})`);
console.log(`   failures, batched    ${verdicts.filter((v) => !v.pass).length}`);
console.log(`   failures, single     ${single.filter((v) => !v.pass).length}`);

const diffs = paired.filter((v) => v.answer !== bySingle.get(`${v.id}\u0000${v.claim}`)!.answer);
if (!diffs.length) {
  console.log(`\n   No verdict changed. On this run the cheap judge is the same judge.`);
} else {
  console.log(`\n   ${diffs.length} verdicts differ. Read them before trusting the saving:\n`);
  for (const v of diffs) {
    const s = bySingle.get(`${v.id}\u0000${v.claim}`)!;
    console.log(`     ${v.id}  |  ${v.claim}`);
    console.log(`       single  ${s.answer}: ${s.reason}`);
    console.log(`       batched ${v.answer}: ${v.reason}`);
    // Position is the first thing to suspect: a claim answered differently when
    // it was ninth in a list is the textbook batching failure.
    const idx = verdicts.filter((x) => x.id === v.id).findIndex((x) => x.claim === v.claim);
    console.log(`       (claim ${idx + 1} of ${verdicts.filter((x) => x.id === v.id).length} in its batch)\n`);
  }
}

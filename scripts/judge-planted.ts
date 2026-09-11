/**
 * Checks the judge against messages that are known to be wrong.
 *
 * Every planted message breaks one claim on purpose. The judge should fail it
 * on that claim. If it doesn't, a green run of `npm run judge` means nothing —
 * a judge that answers yes to everything would score the same.
 *
 * Exits 1 on any miss, so it can gate CI.
 *
 *   npm run judge:planted
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { PLANTED } from "../src/eval/planted.ts";
import { inputClaims } from "../src/eval/cases.ts";
import { ask, claimsFor, describeInput, passes, type ClaimKind } from "../src/eval/judge.ts";

if (!process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY is not set — nothing to judge.");
  process.exit(1);
}

// Planted cases get the same claim set a real case would: universal, class,
// and whatever follows from the input.
function claimsOf(p: (typeof PLANTED)[number]) {
  const extra = inputClaims(p.context, p.options);
  return claimsFor(p.failureClass, extra.must, extra.mustNot);
}

// A typo in `breaks` would make every case look like a miss, so check before
// spending any calls.
for (const p of PLANTED) {
  if (!claimsOf(p).some((c) => c.claim === p.breaks)) {
    console.error(`${p.id}: breaks "${p.breaks}" is not a claim for ${p.failureClass}`);
    process.exit(1);
  }
}

interface Verdict {
  claim: string;
  kind: ClaimKind;
  answer: string;
  pass: boolean;
  reason: string;
}

interface Outcome {
  id: string;
  breaks: string;
  caught: boolean;
  collateral: string[];
  verdicts: Verdict[];
}

const outcomes: Outcome[] = [];

for (const p of PLANTED) {
  const input = describeInput(p.context.method, p.context.name);
  const verdicts: Verdict[] = [];

  for (const { claim, kind } of claimsOf(p)) {
    const { answer, reason } = await ask(p.template, input, claim);
    verdicts.push({ claim, kind, answer, pass: passes(kind, answer), reason });
  }

  const target = verdicts.find((v) => v.claim === p.breaks)!;
  outcomes.push({
    id: p.id,
    breaks: p.breaks,
    caught: !target.pass,
    collateral: verdicts.filter((v) => !v.pass && v.claim !== p.breaks).map((v) => v.claim),
    verdicts,
  });
  process.stdout.write(target.pass ? "M" : ".");
}

console.log("\n");
writeFileSync("judge_planted_results.json", JSON.stringify(outcomes, null, 2));

for (const o of outcomes) {
  console.log(`${o.caught ? "caught" : "MISSED"}  ${o.id}`);
  if (!o.caught) {
    const target = o.verdicts.find((v) => v.claim === o.breaks)!;
    console.log(`        ${o.breaks}`);
    console.log(`        judge: ${target.reason}`);
  }
  if (o.collateral.length) console.log(`        also failed: ${o.collateral.join("; ")}`);
}

const caught = outcomes.filter((o) => o.caught).length;
console.log(`\n${caught} of ${outcomes.length} caught`);
if (caught < outcomes.length) process.exit(1);

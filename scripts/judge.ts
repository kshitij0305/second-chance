/**
 * Asks a model whether each composed message satisfies each claim.
 *
 * Reads eval_results.json, writes judge_results.json. Run `npm run eval` first.
 *
 *   npm run judge
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { CASES } from "../src/eval/cases.ts";
import { ask, claimsFor, describeInput, passes, type ClaimKind } from "../src/eval/judge.ts";

if (!process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY is not set — nothing to judge.");
  process.exit(1);
}

interface EvalResult {
  id: string;
  source: string;
  name?: string | null;
  method?: string;
  rejectionReason?: string;
  template: string;
  text: string;
}

interface Verdict {
  id: string;
  claim: string;
  kind: ClaimKind;
  answer: string;
  pass: boolean;
  reason: string;
}

const results: EvalResult[] = JSON.parse(readFileSync("eval_results.json", "utf8"));
const verdicts: Verdict[] = [];

for (const result of results) {
  const testCase = CASES.find((c) => c.id === result.id);
  if (!testCase) {
    console.warn(`no case for result id ${result.id} — skipped`);
    continue;
  }

  const input = describeInput(result.method, result.name);

  for (const { claim, kind } of claimsFor(testCase.failureClass, testCase.must, testCase.mustNot)) {
    // Judged before substitution: the claims are about {{amount}} and {{link}}.
    const { answer, reason } = await ask(result.template, input, claim);
    const pass = passes(kind, answer);
    verdicts.push({ id: result.id, claim, kind, answer, pass, reason });
    process.stdout.write(pass ? "." : "F");
  }
}

console.log();
writeFileSync("judge_results.json", JSON.stringify(verdicts, null, 2));

const failed = verdicts.filter((v) => !v.pass);
console.log(`${verdicts.length} judgements, ${failed.length} failed`);
for (const v of failed) {
  console.log(`  ${v.id} — ${v.claim}`);
  console.log(`    ${v.reason}`);
}

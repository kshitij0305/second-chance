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

/**
 * A per-minute limit is worth waiting out; a per-day one is not, and the two
 * have to be told apart because the response for them is opposite.
 */
function rateLimit(error: unknown): "minute" | "day" | null {
  const e = error as { status?: number; error?: { error?: { message?: string } } };
  if (e?.status !== 429) return null;
  return /per day|TPD/i.test(e.error?.error?.message ?? "") ? "day" : "minute";
}

/**
 * Set when the daily token limit stops the run. Running out of tokens is not
 * the control failing, and a red tick meaning "no quota" teaches you to ignore
 * red — the one thing this check cannot afford, since its whole value is being
 * believed when it does go red. Green would be a lie and red would be a
 * different lie, so it exits 0 and says what happened.
 */
let ranOutOfQuotaAfter: number | null = null;

outer: for (const [i, p] of PLANTED.entries()) {
  const input = describeInput(p.context.method, p.context.name);
  const verdicts: Verdict[] = [];

  for (const { claim, kind } of claimsOf(p)) {
    let judged;
    for (let attempt = 1; ; attempt++) {
      try {
        judged = await ask(p.template, input, claim);
        break;
      } catch (error) {
        const limit = rateLimit(error);
        if (limit === "day") {
          // Breaking out rather than exiting here: process.exit() while the
          // SDK still holds a handle trips a libuv assertion that reads like a
          // crash in a CI log.
          ranOutOfQuotaAfter = i;
          break outer;
        }
        if (limit !== "minute" || attempt > 6) throw error;
        const hint = /try again in ([\d.]+)s/.exec(
          (error as { error?: { error?: { message?: string } } }).error?.error?.message ?? "",
        )?.[1];
        const waitMs = hint ? Math.ceil(Number(hint) * 1000) + 500 : Math.min(2000 * 2 ** attempt, 60_000);
        process.stdout.write(`[waiting ${(waitMs / 1000).toFixed(0)}s]`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    const { answer, reason } = judged;
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
  // Written per case, not after the loop. Eleven cases is 91 calls and a rate
  // limit partway through used to lose all of them.
  writeFileSync("judge_planted_results.json", JSON.stringify(outcomes, null, 2));
  process.stdout.write(target.pass ? "M" : ".");
}

console.log("\n");

if (ranOutOfQuotaAfter !== null) {
  writeFileSync("judge_planted_results.json", JSON.stringify(outcomes, null, 2));
  const msg =
    `the daily token limit was reached after ${ranOutOfQuotaAfter} of ${PLANTED.length} ` +
    `planted cases, so the judge was not checked. This is not a pass and not a failure.`;
  console.log(msg);
  // Rendered as a warning annotation when this runs in GitHub Actions.
  console.log(`::warning title=Control did not run::${msg}`);
  process.exitCode = 0;
} else {

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
// exitCode rather than exit(), for the same libuv reason as above.
if (caught < outcomes.length) process.exitCode = 1;

}

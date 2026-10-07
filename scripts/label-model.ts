/**
 * Has a second model answer the same questions the human answered, as an
 * independent rater.
 *
 *   npm run label:model
 *   npm run label:model -- --model qwen/qwen3.8-27b
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * This is model-to-model agreement. It is not a second human opinion and it
 * does not retire the single-rater caveat. Two models can agree because a claim
 * is clear, or because they were trained on overlapping text and share the same
 * reading of an ambiguous phrase, and the statistic cannot tell those apart.
 *
 * What it does answer: where two unrelated families diverge on a claim, that
 * claim is ambiguous. That makes this a test of the rubric's wording rather
 * than of the judge's accuracy — a cheap way to find which claims only look
 * unambiguous to the person who wrote them.
 *
 * So the rater must be from a different family than the judge. Scoring
 * gpt-oss-120b against gpt-oss-20b would mostly measure family resemblance.
 *
 * It asks only the items the human already labelled, so all three raters see
 * exactly the same sample and every pairing is comparable.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CASES, inputClaims } from "../src/eval/cases.ts";
import { ask, claimsFor, describeInput, JUDGE_MODEL, type ClaimKind } from "../src/eval/judge.ts";

const SNAPSHOT = "src/eval/snapshots/2026-10-03";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const model = arg("model") ?? "qwen/qwen3.8-27b";
const slug = model.replace(/[^a-z0-9]+/gi, "-");
const OUT = `${SNAPSHOT}/model_labels_${slug}.json`;

if (!process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY is not set.");
  process.exit(1);
}
if (model === JUDGE_MODEL) {
  console.error(`${model} is the judge. A rater has to be a different model to tell you anything.`);
  process.exit(1);
}

interface Label { id: string; claim: string; kind: ClaimKind; answer: string; reason: string }

const human = JSON.parse(readFileSync(`${SNAPSHOT}/human_labels.json`, "utf8")) as {
  id: string; claim: string; kind: ClaimKind;
}[];

// The messages, and the input each composer call was given.
const messages = new Map<string, { template: string; method: string; name?: string | null }>();
for (const r of JSON.parse(readFileSync(`${SNAPSHOT}/eval_results.json`, "utf8"))) {
  messages.set(r.id, { template: r.template, method: r.method, name: r.name });
}

// Confirms each (id, claim) is a real claim for that case before spending calls,
// the same guard judge-planted.ts uses.
const valid = new Set<string>();
for (const c of CASES) {
  const extra = inputClaims(c.context, c.options);
  for (const { claim } of claimsFor(c.failureClass, extra.must, extra.mustNot)) {
    valid.add(`${c.id}\u0000${claim}`);
  }
}
for (const h of human) {
  if (!valid.has(`${h.id}\u0000${h.claim}`)) {
    console.error(`${h.id}: "${h.claim}" is not a claim for that case. The claim set has moved.`);
    process.exit(1);
  }
}

const labels: Label[] = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
const done = new Set(labels.map((l) => `${l.id}\u0000${l.claim}`));
const todo = human.filter((h) => !done.has(`${h.id}\u0000${h.claim}`));

console.log(`${model} rating ${todo.length} of ${human.length} items (${labels.length} already done).`);

/**
 * Qwen's free tier allows 1000 output tokens a minute, and a reasoning model
 * spends ~300 of them on a one-line answer — roughly three calls a minute. The
 * first run of this died at 82 of 100 on a 429.
 *
 * Groq says how long to wait, so wait that long rather than guessing. Retrying
 * immediately on a quota error just burns the quota faster.
 */
async function askWithRetry(message: string, input: string, claim: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ask(message, input, claim, model);
    } catch (error: any) {
      const retryable = error?.status === 429 || error?.status >= 500;
      if (!retryable || attempt > 8) throw error;
      const hint = /try again in ([\d.]+)s/.exec(error?.error?.error?.message ?? "")?.[1];
      const waitMs = hint ? Math.ceil(Number(hint) * 1000) + 500 : Math.min(2000 * 2 ** attempt, 60_000);
      process.stdout.write(`[${error.status}, waiting ${(waitMs / 1000).toFixed(1)}s]`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

for (const h of todo) {
  const m = messages.get(h.id)!;
  const { answer, reason } = await askWithRetry(m.template, describeInput(m.method, m.name), h.claim);
  labels.push({ id: h.id, claim: h.claim, kind: h.kind, answer, reason });
  // Written as they arrive. A judge run once died on a rate limit at 110
  // judgements and lost every one of them.
  writeFileSync(OUT, JSON.stringify(labels, null, 2));
  process.stdout.write(answer === "yes" ? "y" : answer === "no" ? "n" : "?");
}

const unparseable = labels.filter((l) => l.answer !== "yes" && l.answer !== "no");
console.log(`\n\n${labels.length} labels in ${OUT}`);
if (unparseable.length) {
  console.log(`${unparseable.length} did not parse as yes or no — excluded from any scoring:`);
  for (const u of unparseable.slice(0, 5)) console.log(`  ${u.id}  ${u.claim}  -> ${u.answer}`);
}

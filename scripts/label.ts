/**
 * Collects human labels on a frozen run, so the judge can be scored against a
 * second rater instead of against itself.
 *
 *   npm run label                  -- 100 items, the default sample
 *   npm run label -- --n 40        -- fewer
 *   npm run label -- --all-claims  -- include the regex-decidable claims
 *   npm run label -- --seed 7      -- a different sample, reproducibly
 *
 * Answer y or n. Enter repeats the question, s skips, q saves and quits.
 * Resumable: every answer is written before the next question is asked.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It never opens judge_results.json. Not to show you, not to order the
 * questions, not to pick the sample. A rater who has seen the verdict is a
 * reviewer, and agreement with an answer you were shown measures nothing.
 *
 * It also does not tell you whether a claim is required or forbidden. The judge
 * is not told either — that is the whole point of asking "is this property
 * present" and deciding polarity in code afterwards. Showing you the polarity
 * would make you a differently-biased rater than the one you are scoring.
 *
 * The claim list is derived from cases.ts rather than read back from the judge's
 * output, which is what makes the blindness structural rather than a promise.
 * That derivation reproduces all 492 of the snapshot's (id, claim, kind) triples
 * exactly; if it ever stops doing so, the claims have changed and the snapshot
 * is no longer the thing you are labelling.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as readline from "node:readline/promises";
import { CASES, inputClaims } from "../src/eval/cases.ts";
import { claimsFor, describeInput, SYSTEM_PROMPT, type ClaimKind } from "../src/eval/judge.ts";

const SNAPSHOT = "src/eval/snapshots/2026-10-03";
const OUT = `${SNAPSHOT}/human_labels.json`;

// Decidable by substring or regex, so no judgement happens and agreement on
// them is a free win. Excluded by default; --all-claims puts them back, since
// "the judge is being asked, so the judge should be scored" is also defensible.
const MECHANICAL = new Set([
  "contains the {{amount}} placeholder",
  "contains the {{link}} placeholder",
  "uses the words balance, funds, or insufficient",
]);

interface Label {
  id: string;
  claim: string;
  /** Recorded, never shown. Lets pass/fail be derived without re-labelling. */
  kind: ClaimKind;
  /** The raw answer to "is this property present", exactly as the judge gives. */
  answer: "yes" | "no";
  at: string;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (flag: string) => process.argv.includes(`--${flag}`);

const n = Number(arg("n") ?? 100);
const seed = Number(arg("seed") ?? 1);
const allClaims = has("all-claims");
const onlyClaim = arg("claim");

// Seeded so the sample is reproducible and so a resumed session asks the same
// questions. mulberry32.
function rng(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Task {
  id: string;
  claim: string;
  kind: ClaimKind;
  message: string;
  input: string;
}

// The messages. Read from the frozen snapshot, not from a fresh eval run: the
// composer runs at temperature 0.6, so a live run is different prose and the
// labels would describe text nobody can produce again.
const messages = new Map<string, { template: string; method: string; name?: string | null }>();
for (const r of JSON.parse(readFileSync(`${SNAPSHOT}/eval_results.json`, "utf8"))) {
  messages.set(r.id, { template: r.template, method: r.method, name: r.name });
}

const tasks: Task[] = [];
for (const c of CASES) {
  const m = messages.get(c.id);
  if (!m) continue;
  const extra = inputClaims(c.context, c.options);
  for (const { claim, kind } of claimsFor(c.failureClass, extra.must, extra.mustNot)) {
    if (!allClaims && MECHANICAL.has(claim)) continue;
    if (onlyClaim && !claim.toLowerCase().includes(onlyClaim.toLowerCase())) continue;
    tasks.push({ id: c.id, claim, kind, message: m.template, input: describeInput(m.method, m.name) });
  }
}

// A plain random sample, not stratified. Stratifying would guarantee every
// claim appears, but then the estimate needs weighting back to the population
// before kappa means anything. Use --claim to label one claim exhaustively if
// you want a per-claim number.
const shuffled = [...tasks];
const rand = rng(seed);
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  const swap = shuffled[i]!;
  shuffled[i] = shuffled[j]!;
  shuffled[j] = swap;
}
const sample = shuffled.slice(0, Math.min(n, shuffled.length));

const labels: Label[] = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
const done = new Set(labels.map((l) => `${l.id}\u0000${l.claim}`));
const todo = sample.filter((t) => !done.has(`${t.id}\u0000${t.claim}`));

console.log(`\n${tasks.length} judgements eligible, sampling ${sample.length} (seed ${seed}).`);
if (labels.length) console.log(`${labels.length} already labelled, ${todo.length} left.`);
if (!allClaims) console.log(`Regex-decidable claims excluded. --all-claims includes them.`);
if (!todo.length) {
  console.log(`\nNothing left in this sample. ${labels.length} labels in ${OUT}`);
  process.exit(0);
}

// The judge's own instructions, verbatim, minus the line about replying in JSON.
console.log(`\n${"═".repeat(72)}\nYour instructions are the judge's instructions:\n`);
console.log(
  SYSTEM_PROMPT.split("\n")
    .filter((line) => !line.startsWith("Reply with JSON"))
    .join("\n")
    .trim(),
);
console.log(`\ny = true of the message   n = not true   s = skip   q = save and quit`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

for (const [i, t] of todo.entries()) {
  // Laid out exactly as ask() lays it out for the judge: input, message,
  // statement. Same order, same words, same "true of the message as written".
  console.log("\n" + "─".repeat(72));
  console.log(`${i + 1} of ${todo.length}   ${t.id}`);
  console.log(`\nInput: ${t.input}`);
  console.log(`\nMessage:\n${t.message}`);
  console.log(`\nStatement: the message ${t.claim}`);

  let answer: "yes" | "no" | null = null;
  let quit = false;
  while (answer === null) {
    const key = (await rl.question(`\nTrue of the message as written?  `)).trim().toLowerCase();
    if (key === "y") answer = "yes";
    else if (key === "n") answer = "no";
    else if (key === "s" || key === "q") {
      // Break out rather than process.exit: exiting mid-await leaves the
      // readline promise unsettled and node prints a warning that reads like a
      // crash on a run that saved everything correctly.
      quit = key === "q";
      break;
    }
  }
  if (quit) break;
  if (answer === null) continue;

  labels.push({ id: t.id, claim: t.claim, kind: t.kind, answer, at: new Date().toISOString() });
  // Written now, not at the end. A judge run once died on a rate limit at 110
  // judgements and lost all of them, because results were written after the
  // loop. Your attention is scarcer than an API quota.
  writeFileSync(OUT, JSON.stringify(labels, null, 2));
}

rl.close();
console.log(`\n${labels.length} labels in ${OUT}`);
console.log(`The judge's answers are in ${SNAPSHOT}/judge_results.json — joined on (id, claim).`);

/**
 * Scores the judge against the human labels collected by `npm run label`.
 *
 *   npm run kappa
 *
 * Reports the same agreement twice, on two different scales, because they do
 * not behave the same way and only one of them is worth quoting:
 *
 *   raw answer   both raters said yes or no to "is this property present"
 *   pass/fail    what the code decided that answer meant
 *
 * pass/fail is what you care about operationally and is almost unmeasurable,
 * because nearly every judgement passes. The raw answer is balanced, because
 * mustNot claims are correctly answered "no" — a side effect of hiding polarity
 * from the judge that happens to make this statistic work.
 */
import { readFileSync, readdirSync } from "node:fs";
import { cohensKappa, describeKappa, type Answer, type Agreement } from "../src/eval/kappa.ts";
import { passes, type ClaimKind } from "../src/eval/judge.ts";

const SNAPSHOT =
  process.argv.indexOf("--snapshot") === -1
    ? "src/eval/snapshots/2026-10-03"
    : process.argv[process.argv.indexOf("--snapshot") + 1]!;

interface Label { id: string; claim: string; kind: ClaimKind; answer: Answer }
interface Judged { id: string; claim: string; kind: ClaimKind; answer: string }

const human: Label[] = JSON.parse(readFileSync(`${SNAPSHOT}/human_labels.json`, "utf8"));
// --judge names a different verdict file in the same snapshot, so the judge can
// be re-scored after its prompt changes without overwriting the run that the
// published number was measured against.
const JUDGE_FILE =
  process.argv.indexOf("--judge") === -1
    ? "judge_results.json"
    : process.argv[process.argv.indexOf("--judge") + 1]!;
const judged: Judged[] = JSON.parse(readFileSync(`${SNAPSHOT}/${JUDGE_FILE}`, "utf8"));
if (JUDGE_FILE !== "judge_results.json") console.log(`scoring against ${JUDGE_FILE}`);

const byKey = new Map(judged.map((j) => [`${j.id}\u0000${j.claim}`, j]));

// Only items both raters actually answered. A human label with no matching
// judgement means the claim set moved under the snapshot, which would quietly
// bias the sample — so it is an error, not something to drop silently.
const pairs: { label: Label; judge: Judged }[] = [];
const orphans: Label[] = [];
for (const h of human) {
  const j = byKey.get(`${h.id}\u0000${h.claim}`);
  if (j) pairs.push({ label: h, judge: j });
  else orphans.push(h);
}
// Strict by default: a label with no matching judgement usually means the claim
// set moved under the snapshot, which biases the sample silently. It is expected
// when re-judging only the claims that still exist, so --allow-unmatched says
// so out loud rather than quietly dropping them.
if (orphans.length && process.argv.includes("--allow-unmatched")) {
  const names = [...new Set(orphans.map((o) => o.claim))];
  console.log(`\nleaving out ${orphans.length} labels on ${names.length} claims with no judgement:`);
  for (const n of names) console.log(`   ${n}`);
} else if (orphans.length) {
  console.error(`${orphans.length} human labels have no matching judgement:`);
  for (const o of orphans.slice(0, 5)) console.error(`  ${o.id}  ${o.claim}`);
  console.error(`The claims have changed since the snapshot was frozen. Re-label or re-judge.`);
  console.error(`Pass --allow-unmatched to score only the pairs that exist.`);
  process.exit(1);
}

function report(title: string, note: string, a: Agreement) {
  const pct = (x: number) => (100 * x).toFixed(1) + "%";
  console.log(`\n${title}`);
  console.log("─".repeat(72));
  console.log(note);
  console.log(`
                  judge yes   judge no
   human yes   ${String(a.bothYes).padStart(9)} ${String(a.aYesBNo).padStart(10)}
   human no    ${String(a.aNoBYes).padStart(9)} ${String(a.bothNo).padStart(10)}

   observed agreement   ${pct(a.po)}
   expected by chance   ${pct(a.pe)}
   kappa                ${a.kappa.toFixed(3)}  (${describeKappa(a.kappa)})
   95% interval         ${a.ci95[0].toFixed(3)} to ${a.ci95[1].toFixed(3)}${
     a.ci95[1] > 1 || a.ci95[0] < -1
       ? `
                        the interval runs past the range kappa can take. It is a
                        normal approximation and it breaks down near the ceiling
                        or on a near-degenerate table. Read the bound as 1.`
       : ""
   }
   prevalence index     ${a.prevalenceIndex.toFixed(3)}${a.prevalenceIndex > 0.8 ? "   <- lopsided; treat the kappa with suspicion" : ""}
   bias index           ${a.biasIndex.toFixed(3)}`);
}

console.log(`${pairs.length} judgements labelled by both raters.`);

// Scale 1: the raw answer, exactly as each rater gave it.
report(
  "Rating the raw answer",
  `"Is this property present in this message?" — the question both raters were asked.`,
  cohensKappa(
    pairs.map((p) => p.label.answer),
    pairs.map((p) => p.judge.answer as Answer),
  ),
);

// Scale 2: what the code decided the answer meant. Derived, not re-labelled —
// which is why the CLI records `kind` alongside the answer.
const toPass = (kind: ClaimKind, answer: string): Answer => (passes(kind, answer) ? "yes" : "no");
report(
  "Rating pass/fail",
  `The same answers, after polarity is applied. "yes" here means the claim held.`,
  cohensKappa(
    pairs.map((p) => toPass(p.label.kind, p.label.answer)),
    pairs.map((p) => toPass(p.judge.kind, p.judge.answer)),
  ),
);

// A kappa this high invites the question of whether it rests on items where one
// answer was never in doubt. Rather than assert it does not, recompute without
// them. Invariant claims are found from the data, not listed, so this stays
// correct as more labels arrive.
const perClaim = new Map<string, Set<Answer>>();
for (const p of pairs) {
  const seen = perClaim.get(p.label.claim) ?? new Set<Answer>();
  seen.add(p.label.answer);
  perClaim.set(p.label.claim, seen);
}
const counts = new Map<string, number>();
for (const p of pairs) counts.set(p.label.claim, (counts.get(p.label.claim) ?? 0) + 1);
// Constant *and* sampled enough times for the constancy to be an observation.
// A claim with one label is trivially constant, and dropping those would be
// throwing away the thinnest claims for a property of the sample size.
const MIN_TO_CALL_INVARIANT = 3;
const invariant = [...perClaim]
  .filter(([c, s]) => s.size === 1 && (counts.get(c) ?? 0) >= MIN_TO_CALL_INVARIANT)
  .map(([c]) => c);
const biggest = new Set([...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => c));

function subset(title: string, keep: (claim: string) => boolean) {
  const p = pairs.filter((x) => keep(x.label.claim));
  if (p.length < 2) return console.log(`   ${title.padEnd(38)} n=${p.length}  too few to score`);
  const r = cohensKappa(p.map((x) => x.label.answer), p.map((x) => x.judge.answer as Answer));
  const k = Number.isNaN(r.kappa) ? "undefined" : r.kappa.toFixed(3);
  console.log(
    `   ${title.padEnd(38)} n=${String(r.n).padStart(3)}` +
      `  po=${(100 * r.po).toFixed(1)}%  pe=${(100 * r.pe).toFixed(1)}%  kappa=${k}`,
  );
}

console.log(`\n\nIs it resting on the easy items?`);
console.log("─".repeat(72));
console.log(
  `${invariant.length} claims got the same human answer every time across at least ` +
    `${MIN_TO_CALL_INVARIANT} labels,\ncovering ` +
    `${pairs.filter((p) => invariant.includes(p.label.claim)).length} of ${pairs.length}. ` +
    `They are agreement without discrimination, so the\nnumber should survive losing them.\n`,
);
subset("everything", () => true);
subset("without the invariant claims", (c) => !invariant.includes(c));
subset("only the four biggest claims", (c) => biggest.has(c));
subset("only the long tail", (c) => !biggest.has(c));

const disagreements = pairs.filter((p) => p.label.answer !== p.judge.answer);
console.log(`\n\nThe ${disagreements.length} disagreements`);
console.log("─".repeat(72));
console.log("Read these. The number is a summary; these are the actual finding.\n");
for (const { label, judge } of disagreements) {
  console.log(`  ${label.id}`);
  console.log(`    the message ${label.claim}`);
  console.log(`    human ${label.answer}   judge ${judge.answer}\n`);
}

// A third rater, if one has been run. Any model_labels_*.json in the snapshot
// is picked up; npm run label:model writes them.
const extra = readdirSync(SNAPSHOT).filter((f) => f.startsWith("model_labels_"));
for (const file of extra) {
  const rows: { id: string; claim: string; answer: string }[] =
    JSON.parse(readFileSync(`${SNAPSHOT}/${file}`, "utf8"));
  const name = file.replace(/^model_labels_|\.json$/g, "");

  // Only items all three rated, and only where the third rater's answer parsed.
  const third = new Map(rows.filter((r) => r.answer === "yes" || r.answer === "no").map((r) => [`${r.id}\u0000${r.claim}`, r.answer as Answer]));
  const three = pairs.filter((p) => third.has(`${p.label.id}\u0000${p.label.claim}`));
  if (three.length < 2) continue;

  const t = three.map((p) => third.get(`${p.label.id}\u0000${p.label.claim}`)!);
  const h = three.map((p) => p.label.answer);
  const j = three.map((p) => p.judge.answer as Answer);

  console.log(`\n\nA third rater: ${name}`);
  console.log("─".repeat(72));
  console.log(
    `${three.length} of ${pairs.length} items, scored three ways. This is an experiment in\n` +
      `claim ambiguity, not a second human opinion — where two unrelated model\n` +
      `families read a claim differently, the claim is the thing at fault.\n`,
  );
  const line = (what: string, a: Answer[], b: Answer[]) => {
    const r = cohensKappa(a, b);
    const k = Number.isNaN(r.kappa) ? "undefined" : r.kappa.toFixed(3);
    console.log(`   ${what.padEnd(34)} po=${(100 * r.po).toFixed(1)}%  kappa=${k}`);
  };
  line("human vs judge (gpt-oss-120b)", h, j);
  line(`human vs ${name}`, h, t);
  line(`judge vs ${name}  [model-model]`, j, t);

  const split = three.filter((_, i) => j[i] !== t[i]);
  if (split.length) {
    console.log(`\n   ${split.length} claims the two models read differently:\n`);
    for (const [i, p] of three.entries()) {
      if (j[i] === t[i]) continue;
      console.log(`     ${p.label.id}`);
      console.log(`       the message ${p.label.claim}`);
      console.log(`       human ${h[i]}   judge ${j[i]}   ${name} ${t[i]}\n`);
    }
  }
}

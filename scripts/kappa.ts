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
import { readFileSync } from "node:fs";
import { cohensKappa, describeKappa, type Answer, type Agreement } from "../src/eval/kappa.ts";
import { passes, type ClaimKind } from "../src/eval/judge.ts";

const SNAPSHOT = "src/eval/snapshots/2026-10-03";

interface Label { id: string; claim: string; kind: ClaimKind; answer: Answer }
interface Judged { id: string; claim: string; kind: ClaimKind; answer: string }

const human: Label[] = JSON.parse(readFileSync(`${SNAPSHOT}/human_labels.json`, "utf8"));
const judged: Judged[] = JSON.parse(readFileSync(`${SNAPSHOT}/judge_results.json`, "utf8"));

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
if (orphans.length) {
  console.error(`${orphans.length} human labels have no matching judgement:`);
  for (const o of orphans.slice(0, 5)) console.error(`  ${o.id}  ${o.claim}`);
  console.error(`The claims have changed since the snapshot was frozen. Re-label or re-judge.`);
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

const disagreements = pairs.filter((p) => p.label.answer !== p.judge.answer);
console.log(`\n\nThe ${disagreements.length} disagreements`);
console.log("─".repeat(72));
console.log("Read these. The number is a summary; these are the actual finding.\n");
for (const { label, judge } of disagreements) {
  console.log(`  ${label.id}`);
  console.log(`    the message ${label.claim}`);
  console.log(`    human ${label.answer}   judge ${judge.answer}\n`);
}

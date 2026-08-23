/**
 * Drives the bandit against a simulated merchant so learning can be observed.
 *
 * The honest framing matters here. Real traffic in this project is seven
 * captured failures, which is nowhere near enough for a bandit to converge. This
 * simulator does not claim to show which recovery plan is best in the real
 * world. It shows that the selection mechanism, given outcomes, finds the arm
 * with the highest success rate — a claim about the machinery, not about
 * payments.
 *
 * The success rates below are invented. They are chosen so that for three of the
 * six failure classes the hand-authored default is deliberately NOT the best
 * arm, because a learning layer that only ever confirms its author's guesses
 * demonstrates nothing.
 *
 *   npm run simulate
 *   npm run simulate -- 4000
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";

process.env.DB_PATH ??= "./simulation.db";
process.env.LEARNING ??= "on";

const { selectVariant, statsFor } = await import("../src/recovery/bandit.ts");
const { defaultVariant, allClasses } = await import("../src/recovery/variants.ts");
const { db } = await import("../src/db.ts");
import type { FailureClass } from "../src/recovery/classifier.ts";

/** Invented ground truth: the probability a recovery on this arm is paid. */
const TRUTH: Record<FailureClass, Record<string, number>> = {
  // Default is wait_out_the_outage (20 min). The truth says asking sooner wins.
  transient_provider: { wait_out_the_outage: 0.42, quick_retry: 0.55, patient_wait: 0.30 },
  // Default is correct here.
  insufficient_funds: { wait_for_funds: 0.38, same_day_second_ask: 0.22, wait_for_payday: 0.30 },
  // Default is correct here.
  instrument_rejected: { switch_rails: 0.48, switch_rails_after_a_pause: 0.35 },
  // Default is correct here.
  authentication_abandoned: { reoffer_while_warm: 0.62, reoffer_after_the_dust_settles: 0.40 },
  // Default is one_quiet_reminder. Waiting longer is marginally better.
  customer_cancelled: { one_quiet_reminder: 0.12, leave_it_longer: 0.15 },
  // Default is conservative_default. Asking sooner is better.
  unknown: { conservative_default: 0.28, unknown_quick: 0.33, unknown_offer_alternatives: 0.31 },
};

/** Rough share of traffic per class, weighted towards the undiagnosable case. */
const MIX: [FailureClass, number][] = [
  ["unknown", 0.42],
  ["transient_provider", 0.20],
  ["instrument_rejected", 0.15],
  ["insufficient_funds", 0.12],
  ["authentication_abandoned", 0.08],
  ["customer_cancelled", 0.03],
];

const rounds = Number(process.argv[2] ?? 2000);
const repeatFlag = process.argv.indexOf("--repeat");
const repeats = repeatFlag >= 0 ? Number(process.argv[repeatFlag + 1] ?? 20) : 1;


interface RunResult {
  learned: number;
  baseline: number;
  bestArmFound: Record<string, boolean>;
  checkpoints: { round: number; learned: number; baseline: number }[];
}

function bestArmFor(cls: FailureClass): string {
  return Object.entries(TRUTH[cls]).sort((a, b) => b[1] - a[1])[0]![0];
}

function runOnce(): RunResult {
  db.exec("DELETE FROM strategy_outcomes");

  function drawClass(): FailureClass {
    let r = Math.random();
    for (const [cls, share] of MIX) {
      if ((r -= share) <= 0) return cls;
    }
    return MIX[0]![0];
  }

  let learnedWins = 0;
  let baselineWins = 0;
  const checkpoints: { round: number; learned: number; baseline: number }[] = [];

  for (let i = 1; i <= rounds; i++) {
    const failureClass = drawClass();

    // What the bandit chooses, and what a fixed hand-authored default would have.
    const chosen = selectVariant(failureClass, true).strategy.name;
    const baseline = defaultVariant(failureClass).name;

    const recovered = Math.random() < TRUTH[failureClass][chosen]!;
    if (recovered) learnedWins++;
    if (Math.random() < TRUTH[failureClass][baseline]!) baselineWins++;

    db.prepare(
      `INSERT INTO strategy_outcomes (failure_class, variant, successes, failures)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(failure_class, variant) DO UPDATE SET
         successes = successes + excluded.successes,
         failures  = failures  + excluded.failures`,
    ).run(failureClass, chosen, recovered ? 1 : 0, recovered ? 0 : 1);

    if (i % Math.max(1, Math.floor(rounds / 8)) === 0) {
      checkpoints.push({ round: i, learned: learnedWins / i, baseline: baselineWins / i });
    }
  }


  const bestArmFound: Record<string, boolean> = {};
  for (const cls of allClasses()) {
    const arms = statsFor(cls).filter((a) => a.observations > 0);
    if (!arms.length) continue;
    const picked = [...arms].sort((a, b) => b.observations - a.observations)[0]!;
    bestArmFound[cls] = picked.variant === bestArmFor(cls);
  }
  return {
    learned: learnedWins / rounds,
    baseline: baselineWins / rounds,
    bestArmFound,
    checkpoints,
  };
}

if (repeats > 1) {
  /**
   * One simulation is an anecdote. Convergence on a low-volume class where the
   * arms are close is genuinely a coin flip, and a single run will report
   * whichever side it landed on as though it were the result.
   */
  const runs = Array.from({ length: repeats }, runOnce);
  const converged: Record<string, number> = {};
  for (const run of runs) {
    for (const [cls, ok] of Object.entries(run.bestArmFound)) {
      converged[cls] = (converged[cls] ?? 0) + (ok ? 1 : 0);
    }
  }

  console.log(`${repeats} independent runs of ${rounds} failures each.
`);
  console.log("how often each class settles on the best arm");
  const ordered = Object.entries(converged).sort((a, b) => b[1] - a[1]);
  for (const [cls, wins] of ordered) {
    const pct = Math.round((wins / repeats) * 100);
    const gap = (() => {
      const t = Object.values(TRUTH[cls as FailureClass]).sort((a, b) => b - a);
      return ((t[0]! - t[1]!) * 100).toFixed(0);
    })();
    console.log(`  ${String(pct).padStart(3)}%  ${cls.padEnd(26)} best arm leads by ${gap} points`);
  }

  const learned = runs.reduce((s, r) => s + r.learned, 0) / repeats;
  const baseline = runs.reduce((s, r) => s + r.baseline, 0) / repeats;
  const lifts = runs.map((r) => ((r.learned - r.baseline) / r.baseline) * 100).sort((a, b) => a - b);
  console.log(
    `
mean recovery ${(learned * 100).toFixed(1)}% vs ${(baseline * 100).toFixed(1)}% fixed — ` +
    `lift ${lifts[0]!.toFixed(1)}% to ${lifts.at(-1)!.toFixed(1)}% across runs, median ${lifts[Math.floor(repeats / 2)]!.toFixed(1)}%`,
  );
  process.exit(0);
}

const single = runOnce();
const learnedWins = Math.round(single.learned * rounds);
const baselineWins = Math.round(single.baseline * rounds);
const checkpoints = single.checkpoints;

console.log(`${rounds} simulated failures. Ground truth is invented; see the header of this script.\n`);

console.log("recovery rate as the bandit learns");
console.log("  round     learned   fixed default");
for (const c of checkpoints) {
  console.log(
    `  ${String(c.round).padStart(6)}    ${(c.learned * 100).toFixed(1).padStart(5)}%    ${(c.baseline * 100).toFixed(1).padStart(5)}%`,
  );
}

console.log("\nwhere it ended up, per failure class");
for (const cls of allClasses()) {
  const arms = statsFor(cls).filter((a) => a.observations > 0);
  if (!arms.length) continue;

  const total = arms.reduce((s, a) => s + a.observations, 0);
  const best = Object.entries(TRUTH[cls]).sort((a, b) => b[1] - a[1])[0]![0];
  const picked = [...arms].sort((a, b) => b.observations - a.observations)[0]!;
  const isDefault = best === defaultVariant(cls).name;

  console.log(`\n  ${cls}`);
  for (const arm of [...arms].sort((a, b) => b.observations - a.observations)) {
    const share = ((arm.observations / total) * 100).toFixed(0).padStart(3);
    const truth = (TRUTH[cls][arm.variant]! * 100).toFixed(0);
    const marker = arm.variant === best ? "  <- best" : "";
    console.log(
      `    ${share}% of traffic  ${arm.variant.padEnd(32)} observed ${(arm.rate * 100).toFixed(0).padStart(3)}%  true ${truth}%${marker}`,
    );
  }
  console.log(
    `    settled on ${picked.variant === best ? "the best arm" : "the WRONG arm"}` +
    (isDefault ? "; the hand-authored default was already correct" : "; the hand-authored default was NOT the best"),
  );
}

const final = checkpoints.at(-1);
if (final) {
  const lift = ((final.learned - final.baseline) / final.baseline) * 100;
  console.log(
    `\noverall: ${(final.learned * 100).toFixed(1)}% recovered versus ${(final.baseline * 100).toFixed(1)}% ` +
    `for fixed defaults — ${lift >= 0 ? "+" : ""}${lift.toFixed(1)}% relative`,
  );
}

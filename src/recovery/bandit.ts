import { db } from "../db.ts";
import type { FailureClass } from "./classifier.ts";
import { variantsFor, defaultVariant, type Strategy } from "./variants.ts";

/**
 * Chooses between the candidate plans for a failure class, and learns from what
 * happened.
 *
 * Thompson sampling over a Beta posterior per arm. Each arm holds a count of
 * recoveries that succeeded and recoveries that did not; selection draws a
 * plausible success rate from each arm's posterior and takes the best draw.
 *
 * Thompson sampling rather than epsilon-greedy for a reason that matters here.
 * Recovery volume is low and outcomes are slow — a recovery scheduled for
 * eighteen hours away resolves a day later — so the number of observations per
 * arm stays small for a long time. Epsilon-greedy explores at a fixed rate
 * regardless of how uncertain it is, wasting traffic on arms already known to be
 * poor while under-exploring ones it has barely tried. Thompson sampling
 * explores in proportion to actual uncertainty, which is the right behaviour
 * when data is scarce and every observation is expensive.
 *
 * An honest note on scale. This mechanism needs volume to converge and the real
 * traffic here is seven captured failures. It is exercised against a simulator
 * with known ground truth, which demonstrates that the learning works; it does
 * not demonstrate that any particular arm is best in the real world. Those are
 * different claims and only the first one is being made.
 */

export interface ArmStats {
  failureClass: FailureClass;
  variant: string;
  successes: number;
  failures: number;
  /** Posterior mean, the arm's current best estimate of its success rate. */
  rate: number;
  /** successes + failures. Zero means never tried. */
  observations: number;
}

export function recordOutcome(
  failureClass: FailureClass,
  variant: string,
  recovered: boolean,
): void {
  db.prepare(
    `INSERT INTO strategy_outcomes (failure_class, variant, successes, failures)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(failure_class, variant) DO UPDATE SET
       successes = successes + excluded.successes,
       failures  = failures  + excluded.failures`,
  ).run(failureClass, variant, recovered ? 1 : 0, recovered ? 0 : 1);
}

export function statsFor(failureClass: FailureClass): ArmStats[] {
  const rows = db.prepare(
    "SELECT variant, successes, failures FROM strategy_outcomes WHERE failure_class = ?",
  ).all(failureClass) as unknown as { variant: string; successes: number; failures: number }[];

  const seen = new Map(rows.map((r) => [r.variant, r]));

  return variantsFor(failureClass).map((v) => {
    const row = seen.get(v.name) ?? { successes: 0, failures: 0 };
    const observations = row.successes + row.failures;
    return {
      failureClass,
      variant: v.name,
      successes: row.successes,
      failures: row.failures,
      observations,
      // Beta(1,1) prior, so an untried arm reads as 0.5 rather than 0 — an arm
      // with no evidence is unknown, not bad.
      rate: (row.successes + 1) / (observations + 2),
    };
  });
}

export interface Selection {
  strategy: Strategy;
  /** Why this arm won, for the audit trail. */
  reason: string;
}

/**
 * Picks a plan for this failure class.
 *
 * Falls back to the default variant when learning is disabled, so the system
 * behaves identically to the pre-bandit version with one setting.
 */
export function selectVariant(failureClass: FailureClass, enabled: boolean): Selection {
  if (!enabled) {
    return {
      strategy: defaultVariant(failureClass),
      reason: "learning disabled; using the default plan",
    };
  }

  const stats = statsFor(failureClass);
  const draws = stats.map((arm) => ({
    arm,
    draw: sampleBeta(arm.successes + 1, arm.failures + 1),
  }));

  draws.sort((a, b) => b.draw - a.draw);
  const winner = draws[0]!;
  const variant = variantsFor(failureClass).find((v) => v.name === winner.arm.variant)!;

  const observed = stats.reduce((sum, a) => sum + a.observations, 0);
  const reason = observed === 0
    ? `no outcomes recorded for ${failureClass} yet; exploring`
    : `sampled ${winner.draw.toFixed(2)} from ${winner.arm.successes}/${winner.arm.observations} observed ` +
      `(${stats.map((a) => `${a.variant} ${a.successes}/${a.observations}`).join(", ")})`;

  return { strategy: variant, reason };
}

/**
 * Draws from Beta(alpha, beta) via two Gamma draws.
 *
 * Both shape parameters are at least 1 here, since the priors add 1 to counts
 * that cannot be negative, so Marsaglia-Tsang applies without the boost step
 * that a shape below 1 would need.
 */
function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

/** Marsaglia-Tsang, valid for shape >= 1. */
function sampleGamma(shape: number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = standardNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Box-Muller. */
function standardNormal(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

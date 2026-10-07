/**
 * Cohen's kappa: agreement between two raters, corrected for the agreement
 * they would have reached by guessing.
 *
 * Percent agreement alone is close to meaningless here. If 95% of messages
 * satisfy a claim, two raters who both answer "yes" blindly agree 90% of the
 * time while sharing no judgement at all. Kappa asks how much of the observed
 * agreement is left over once that is subtracted.
 *
 *   kappa = (po - pe) / (1 - pe)
 *
 * po is how often they actually agreed. pe is how often they would be expected
 * to agree if each rater kept their own overall yes/no habit but applied it at
 * random. The denominator is the agreement still available above chance, so
 * kappa is the share of that headroom the raters actually captured.
 *
 * 1 is perfect agreement, 0 is exactly chance, negative is worse than chance
 * — which happens, and means something is systematically inverted.
 */

export type Answer = "yes" | "no";

export interface Agreement {
  n: number;
  /** Both said yes, both said no, and the two ways of disagreeing. */
  bothYes: number;
  bothNo: number;
  aYesBNo: number;
  aNoBYes: number;
  /** Observed agreement. */
  po: number;
  /** Agreement expected from the raters' marginals alone. */
  pe: number;
  kappa: number;
  /** Standard error and a 95% interval. A kappa without one is half an answer. */
  se: number;
  ci95: [number, number];
  /**
   * How lopsided the items are: |p(both yes) - p(both no)|. Near 1 means one
   * category dominates, chance agreement is already high, and kappa divides by
   * a sliver — the "high agreement, low kappa" paradox (Feinstein & Cicchetti,
   * J Clin Epidemiol 43:543, 1990). Report it next to kappa or the kappa misleads.
   */
  prevalenceIndex: number;
  /** How differently the two raters used "yes" overall. */
  biasIndex: number;
}

/**
 * `a` and `b` are the two raters' answers to the same items, in the same order.
 * Throws rather than truncating if they differ in length: a silent off-by-one
 * would misalign every pair and still return a plausible number.
 */
export function cohensKappa(a: readonly Answer[], b: readonly Answer[]): Agreement {
  if (a.length !== b.length) {
    throw new Error(`rater arrays differ in length: ${a.length} vs ${b.length}`);
  }
  if (a.length === 0) throw new Error("no items to compare");

  const n = a.length;
  let bothYes = 0, bothNo = 0, aYesBNo = 0, aNoBYes = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] === "yes", y = b[i] === "yes";
    if (x && y) bothYes++;
    else if (!x && !y) bothNo++;
    else if (x) aYesBNo++;
    else aNoBYes++;
  }

  const po = (bothYes + bothNo) / n;

  // Each rater's own rate of saying yes. pe assumes they keep that rate but
  // apply it independently of the item.
  const aYes = (bothYes + aYesBNo) / n;
  const bYes = (bothYes + aNoBYes) / n;
  const pe = aYes * bYes + (1 - aYes) * (1 - bYes);

  // pe === 1 means both raters gave every item the same single answer. There is
  // no headroom above chance to measure, so kappa is 0/0. Saying so beats
  // returning Infinity or a confident-looking 0.
  const kappa = pe === 1 ? NaN : (po - pe) / (1 - pe);

  // The usual large-sample approximation. Exact enough at n in the hundreds,
  // and it is the one most papers quote.
  const se = pe === 1 ? NaN : Math.sqrt((po * (1 - po)) / (n * (1 - pe) ** 2));

  return {
    n, bothYes, bothNo, aYesBNo, aNoBYes, po, pe, kappa, se,
    ci95: [kappa - 1.96 * se, kappa + 1.96 * se],
    prevalenceIndex: Math.abs(bothYes - bothNo) / n,
    biasIndex: Math.abs(aYesBNo - aNoBYes) / n,
  };
}

/**
 * Landis & Koch's 1977 labels. Worth knowing because interviewers quote them,
 * worth distrusting because they are a convention someone proposed, not a
 * result. A kappa of 0.61 is not meaningfully different from 0.60.
 */
export function describeKappa(k: number): string {
  if (Number.isNaN(k)) return "undefined — no agreement above chance was available to measure";
  if (k < 0) return "worse than chance";
  // Landis & Koch call 0 to 0.20 "slight", which reads as faint praise for a
  // result that is literally indistinguishable from guessing.
  if (k === 0) return "exactly chance";
  if (k <= 0.2) return "slight";
  if (k <= 0.4) return "fair";
  if (k <= 0.6) return "moderate";
  if (k <= 0.8) return "substantial";
  return "almost perfect";
}

import type { FailureClass } from "./classifier.ts";

// Each hand-authored strategy is a hypothesis, not a fact — twenty minutes for
// an outage is a guess, so is eighteen hours for an empty account. So each class
// offers several plans and the outcome data picks.
//
// Every variant has to be one a merchant would accept on its own terms. An arm
// nobody could justify isn't worth the traffic to evaluate.
//
// First in each list is the default: used before there's evidence, and the
// fallback when learning is off.

export interface Strategy {
  name: string;
  /** Minutes to wait before the recovery goes out. Never zero. */
  delayMinutes: number;
  /** Whether to steer the customer away from the instrument that just failed. */
  avoidFailedMethod: boolean;
  /** Total recovery attempts allowed, including this one. */
  maxAttempts: number;
  /** Why this plan, in terms a merchant would accept. */
  rationale: string;
}

export const VARIANTS: Record<FailureClass, Strategy[]> = {
  transient_provider: [
    {
      name: "wait_out_the_outage",
      delayMinutes: 20,
      avoidFailedMethod: false,
      maxAttempts: 3,
      rationale: "provider-side and temporary; the same instrument will most likely work shortly, so keep the rail and wait it out",
    },
    {
      name: "quick_retry",
      delayMinutes: 5,
      avoidFailedMethod: false,
      maxAttempts: 3,
      rationale: "most provider blips clear in under five minutes, and asking sooner catches the customer while the purchase is still in mind",
    },
    {
      name: "patient_wait",
      delayMinutes: 60,
      avoidFailedMethod: false,
      maxAttempts: 2,
      rationale: "a real outage lasts longer than twenty minutes, and asking during it wastes the one attempt the customer will tolerate",
    },
  ],

  insufficient_funds: [
    {
      name: "wait_for_funds",
      delayMinutes: 18 * 60,
      avoidFailedMethod: false,
      maxAttempts: 2,
      rationale: "the account was empty, not broken; retrying within the hour declines again, so ask the following morning",
    },
    {
      name: "same_day_second_ask",
      delayMinutes: 6 * 60,
      avoidFailedMethod: false,
      maxAttempts: 2,
      rationale: "balances move during the day; six hours is long enough for a transfer to land while the purchase is still wanted",
    },
    {
      name: "wait_for_payday",
      delayMinutes: 72 * 60,
      avoidFailedMethod: false,
      maxAttempts: 1,
      rationale: "if the account was empty it may stay empty for days; one well-timed ask beats several that all decline",
    },
  ],

  instrument_rejected: [
    {
      name: "switch_rails",
      delayMinutes: 3,
      avoidFailedMethod: true,
      maxAttempts: 2,
      rationale: "this instrument will keep refusing, so waiting changes nothing; offer a different payment method promptly",
    },
    {
      name: "switch_rails_after_a_pause",
      delayMinutes: 30,
      avoidFailedMethod: true,
      maxAttempts: 2,
      rationale: "a customer who has just been declined may need a moment before being asked to fetch a different card",
    },
  ],

  authentication_abandoned: [
    {
      name: "reoffer_while_warm",
      delayMinutes: 2,
      avoidFailedMethod: false,
      maxAttempts: 2,
      rationale: "the customer was mid-purchase and lost it at verification; intent decays within minutes, so re-offer as soon as is safe",
    },
    {
      name: "reoffer_after_the_dust_settles",
      delayMinutes: 15,
      avoidFailedMethod: false,
      maxAttempts: 2,
      rationale: "an OTP that failed once often fails twice in a row; a short pause avoids repeating the same frustration",
    },
  ],

  customer_cancelled: [
    {
      name: "one_quiet_reminder",
      delayMinutes: 24 * 60,
      avoidFailedMethod: false,
      maxAttempts: 1,
      rationale: "the customer deliberately backed out; a quick nudge reads as pressure, so leave a single low-urgency reminder a day later",
    },
    {
      name: "leave_it_longer",
      delayMinutes: 72 * 60,
      avoidFailedMethod: false,
      maxAttempts: 1,
      rationale: "cancelling is a decision, not an accident; three days is long enough that the reminder reads as helpful rather than pushy",
    },
  ],

  unknown: [
    {
      name: "conservative_default",
      delayMinutes: 30,
      avoidFailedMethod: false,
      maxAttempts: 2,
      rationale: "the cause could not be determined, so behave cautiously rather than guessing: one delayed re-ask on any rail",
    },
    {
      name: "unknown_quick",
      delayMinutes: 10,
      avoidFailedMethod: false,
      maxAttempts: 2,
      rationale: "most undiagnosed failures turn out to be transient, and a faster ask catches the customer before they leave",
    },
    {
      name: "unknown_offer_alternatives",
      delayMinutes: 30,
      avoidFailedMethod: true,
      maxAttempts: 2,
      rationale: "if the cause cannot be identified, offering a different rail hedges against it being the instrument",
    },
  ],
};

/** The plan used before there is any evidence, and when learning is off. */
export function defaultVariant(failureClass: FailureClass): Strategy {
  return VARIANTS[failureClass][0]!;
}

export function variantsFor(failureClass: FailureClass): Strategy[] {
  return VARIANTS[failureClass];
}

export function findVariant(failureClass: FailureClass, name: string): Strategy | undefined {
  return VARIANTS[failureClass].find((v) => v.name === name);
}

export function allClasses(): FailureClass[] {
  return Object.keys(VARIANTS) as FailureClass[];
}

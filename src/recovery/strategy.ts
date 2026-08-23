import type { Classification, FailureClass } from "./classifier.ts";
import { config } from "../config.ts";

/**
 * Chooses how to ask again, given why the payment failed.
 *
 * This is where the product's claim lives: a card declined for insufficient
 * funds and a bank that fell over for ninety seconds are not the same event and
 * should not get the same response. Retrying a declined instrument immediately
 * is noise. Waiting eighteen hours for a transient gateway blip wastes a
 * customer who would have paid on the second tap.
 *
 * Like the classifier, deliberately a table rather than a model. Six classes in,
 * six plans out, every one of which needs to be defensible to a merchant and
 * assertable in a test. There is nothing here a model would do better.
 *
 * The one rule that applies to every class: nothing sends immediately. A
 * customer who has just failed a payment is frequently still at the checkout,
 * retrying. A recovery link arriving mid-retry risks them paying twice, and a
 * double charge costs far more trust than a recovery gains. Even the case where
 * intent is hottest waits a couple of minutes.
 */

export interface Strategy {
  name: string;
  /** Minutes to wait before the recovery goes out. Never zero — see above. */
  delayMinutes: number;
  /**
   * Whether to steer the customer away from the instrument that just failed.
   * Only meaningful when the failure is a property of the instrument rather
   * than of the moment.
   */
  avoidFailedMethod: boolean;
  /** Total recovery attempts allowed, including this one. */
  maxAttempts: number;
  /** Why this plan, in terms a merchant would accept. */
  rationale: string;
}

const STRATEGIES: Record<FailureClass, Strategy> = {
  transient_provider: {
    name: "wait_out_the_outage",
    // Long enough for a provider blip to clear, short enough that the purchase
    // is still live in the customer's mind.
    delayMinutes: 20,
    avoidFailedMethod: false,
    maxAttempts: 3,
    rationale: "provider-side and temporary; the same instrument will most likely work shortly, so keep the rail and wait it out",
  },

  insufficient_funds: {
    // Retrying an empty account produces another decline and another failure
    // notification for the customer. The constraint is money arriving, which is
    // measured in days, not minutes. Next morning is the earliest sensible ask.
    name: "wait_for_funds",
    delayMinutes: 18 * 60,
    avoidFailedMethod: false,
    maxAttempts: 2,
    rationale: "the account was empty, not broken; retrying within the hour just declines again, so ask once the following morning",
  },

  instrument_rejected: {
    // The card or account will keep refusing. Sending the same rail again is
    // guaranteed to fail, so the recovery has to offer a different route. Can go
    // out quickly because nothing is expected to change by waiting.
    name: "switch_rails",
    delayMinutes: 3,
    avoidFailedMethod: true,
    maxAttempts: 2,
    rationale: "this instrument will keep refusing, so waiting changes nothing; offer a different payment method promptly instead",
  },

  authentication_abandoned: {
    // The customer was present and engaged, and lost the payment to an OTP.
    // Intent decays fast here, so this is the shortest delay the double-charge
    // floor allows.
    name: "reoffer_while_warm",
    delayMinutes: 2,
    avoidFailedMethod: false,
    maxAttempts: 2,
    rationale: "the customer was mid-purchase and lost it at verification; intent decays within minutes, so re-offer as soon as is safe",
  },

  customer_cancelled: {
    // They chose to stop. A prompt nudge reads as pressure and costs more
    // goodwill than the order is worth. One quiet reminder, a day later.
    name: "one_quiet_reminder",
    delayMinutes: 24 * 60,
    avoidFailedMethod: false,
    maxAttempts: 1,
    rationale: "the customer deliberately backed out; a quick nudge reads as pressure, so leave a single low-urgency reminder a day later",
  },

  unknown: {
    // Cannot diagnose, so do not act as though we can. Long enough to be safe
    // if it was transient, short enough to still be relevant.
    name: "conservative_default",
    delayMinutes: 30,
    avoidFailedMethod: false,
    maxAttempts: 2,
    rationale: "the cause could not be determined, so behave cautiously rather than guessing: one delayed re-ask on any rail",
  },
};

export interface Decision {
  strategy: Strategy;
  /** When the recovery should go out, as an ISO-8601 UTC timestamp. */
  scheduledFor: string;
  /** Full audit line: what we concluded, on what evidence, and what we will do. */
  explanation: string;
}

export function selectStrategy(
  classification: Classification,
  now: Date,
  timeScale: number = config.timeScale,
): Decision {
  const strategy = STRATEGIES[classification.failureClass];
  // The strategy always states its real intent in minutes; only the wall-clock
  // deadline is compressed, so a demo never changes what a strategy decided.
  const scheduledFor = new Date(now.getTime() + (strategy.delayMinutes * 60_000) / timeScale);

  return {
    strategy,
    scheduledFor: scheduledFor.toISOString(),
    explanation:
      `classified ${classification.failureClass} (${classification.evidence}) because ${classification.basis}; ` +
      `strategy ${strategy.name} — ${strategy.rationale}; ` +
      `sending in ${formatDelay(strategy.delayMinutes)}` +
      (strategy.avoidFailedMethod ? ", steering away from the failed method" : ""),
  };
}

/** Exposed so the strategy table can be inspected and rendered, not just applied. */
export function strategyFor(failureClass: FailureClass): Strategy {
  return STRATEGIES[failureClass];
}

export function allStrategies(): ReadonlyArray<[FailureClass, Strategy]> {
  return Object.entries(STRATEGIES) as [FailureClass, Strategy][];
}

function formatDelay(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

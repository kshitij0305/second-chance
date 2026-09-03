import type { Classification, FailureClass } from "./classifier.ts";
import { config } from "../config.ts";
import { selectVariant } from "./bandit.ts";
import { VARIANTS as VARIANTS_BY_CLASS } from "./variants.ts";
import { defaultVariant, findVariant, variantsFor, type Strategy } from "./variants.ts";

export type { Strategy };

// A card declined for insufficient funds and a gateway that fell over for
// ninety seconds are not the same event. Retrying a declined instrument
// immediately is noise; waiting eighteen hours for a blip loses a customer who
// would have paid on the second tap.
//
// A table, not a model: six classes in, six plans out, each one defensible to a
// merchant and assertable in a test.
//
// One rule holds for every class — nothing sends immediately. A customer who
// just failed is often still at the checkout retrying, and a link arriving
// mid-retry risks a double charge. Even the hottest case waits a couple of
// minutes.

export interface Decision {
  strategy: Strategy;
  /** When the recovery should go out, as an ISO-8601 UTC timestamp. */
  scheduledFor: string;
  /** Full audit line: what we concluded, on what evidence, and what we will do. */
  explanation: string;
}

export interface SelectOptions {
  /** Compresses only the wall-clock deadline, never the strategy's intent. */
  timeScale?: number;
  /** Off means always use the class default, making selection deterministic. */
  learning?: boolean;
}

export function selectStrategy(
  classification: Classification,
  now: Date,
  options: SelectOptions = {},
): Decision {
  const timeScale = options.timeScale ?? config.timeScale;
  const learning = options.learning ?? config.learningEnabled;
  const chosen = selectVariant(classification.failureClass, learning);
  const strategy = chosen.strategy;
  // The strategy always states its real intent in minutes; only the wall-clock
  // deadline is compressed, so a demo never changes what a strategy decided.
  const scheduledFor = new Date(now.getTime() + (strategy.delayMinutes * 60_000) / timeScale);

  return {
    strategy,
    scheduledFor: scheduledFor.toISOString(),
    explanation:
      `classified ${classification.failureClass} (${classification.evidence}) because ${classification.basis}; ` +
      `strategy ${strategy.name} — ${strategy.rationale}; ` +
      `chosen because ${chosen.reason}; ` +
      `sending in ${formatDelay(strategy.delayMinutes)}` +
      (strategy.avoidFailedMethod ? ", steering away from the failed method" : ""),
  };
}

/** The plan used before any evidence exists. Exposed for inspection and tests. */
export function strategyFor(failureClass: FailureClass): Strategy {
  return defaultVariant(failureClass);
}

/** Every default plan, one per class. */
export function allStrategies(): ReadonlyArray<[FailureClass, Strategy]> {
  return (Object.keys(VARIANTS_BY_CLASS) as FailureClass[])
    .map((c) => [c, defaultVariant(c)] as [FailureClass, Strategy]);
}

/** Every candidate plan across every class, for tests and inspection. */
export function allVariants(): ReadonlyArray<[FailureClass, Strategy]> {
  return (Object.keys(VARIANTS_BY_CLASS) as FailureClass[])
    .flatMap((c) => variantsFor(c).map((v) => [c, v] as [FailureClass, Strategy]));
}

export { findVariant };

function formatDelay(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

import type { RazorpayPaymentEntity } from "../razorpay/types.ts";

/**
 * Turns a failed payment into a class that implies a recovery strategy.
 *
 * Two mechanisms, split by what each is good at.
 *
 * The rules below own the documented vocabulary. For a closed set of published
 * error codes a lookup table is faster, deterministic, unit-testable, and cannot
 * be wrong in a way a test would not catch. A model there would be strictly
 * worse at a problem that is already solved.
 *
 * What a table cannot do is read a sentence it has never seen. Production sends
 * descriptions this project never captured — a card that expired, a transaction
 * a risk system refused, an issuer unavailable in a region — and each one lands
 * in `unknown` and gets the conservative plan, when a human reading it would
 * know exactly what to do. That is the open-ended half, and `classifyDeep` hands
 * it to a model constrained to the same six classes. See model-classifier.ts.
 *
 * Where the signal actually lives took a wrong turn to find. `error_reason` is
 * the obvious field and it is useless in test mode — it reads `payment_failed`
 * for every single failure, including five different cards documented to produce
 * five different errors. `error_description` is where the provider puts the real
 * meaning, and it does vary: one observed failure says the bank declined the
 * payment and to try another method, another says a temporary issue occurred and
 * any debited amount will be refunded. Those imply opposite strategies. Reading
 * only `error_reason` would have collapsed both into one bucket.
 *
 * Every classification carries the grounds it was reached on, because most of
 * this vocabulary has never been observed arriving — it is read from published
 * documentation. Classifying on documented-but-unobserved values is legitimate
 * since production sends them. Presenting them as observed is not.
 */

export type FailureClass =
  /** Provider-side and temporary. The same instrument will likely work shortly. */
  | "transient_provider"
  /** Customer has no money right now. Same instrument, materially later. */
  | "insufficient_funds"
  /** This instrument will keep failing. Recovery must offer a different rail. */
  | "instrument_rejected"
  /** Customer was present and dropped at authentication. Intent is still warm. */
  | "authentication_abandoned"
  /** Customer deliberately backed out. Re-asking soon is unwelcome. */
  | "customer_cancelled"
  /** Genuinely undetermined. Strategy must be conservative. */
  | "unknown";

export type Evidence =
  /** This exact shape has been seen arriving from the provider. */
  | "observed"
  /** In the published vocabulary, but never seen in our own traffic. */
  | "documented"
  /** Provider sent nothing specific; class deduced from the payment method. */
  | "inferred";

export interface Classification {
  failureClass: FailureClass;
  evidence: Evidence;
  /** Human-readable grounds. Surfaced in the UI so a decision is never opaque. */
  basis: string;
  /**
   * Which mechanism produced this. The rules cover the documented vocabulary;
   * the model reads descriptions the rules have never seen. Recorded separately
   * from evidence because "how confident are we" and "what worked it out" are
   * different questions, and an operator will want both.
   */
  classifier: "rules" | "model";
}

/** Documented error reasons. Production sends these; test mode never has. */
const BY_REASON: Record<string, FailureClass> = {
  insufficient_fund: "insufficient_funds",
  payment_timed_out: "transient_provider",
  gateway_technical_error: "transient_provider",
  server_error: "transient_provider",
  authentication_failed: "authentication_abandoned",
  payment_cancelled: "customer_cancelled",
  card_declined: "instrument_rejected",
  card_disabled_for_online_payments: "instrument_rejected",
  card_number_invalid: "instrument_rejected",
};

/**
 * Patterns over `error_description`, which carries the real meaning when
 * `error_reason` is generic.
 *
 * Matched on distinctive phrases rather than whole strings: the observed text
 * differs from the published text in small ways ("didn't" against "did not"),
 * and provider copy is not a stable interface. Order matters — the first match
 * wins, so more specific patterns come first.
 */
const BY_DESCRIPTION: ReadonlyArray<[RegExp, FailureClass]> = [
  [/insufficient (account )?balance|insufficient fund/i, "insufficient_funds"],
  [/declined by (the |your )?(issuing )?bank/i, "instrument_rejected"],
  [/disabled for online payments?/i, "instrument_rejected"],
  [/incorrect card number|card number.*invalid/i, "instrument_rejected"],
  [/incorrect otp|verification details/i, "authentication_abandoned"],
  [/has been cancelled|payment was cancelled/i, "customer_cancelled"],
  [/temporary issue|try again later/i, "transient_provider"],
];

/** Descriptions actually seen arriving, so evidence can be reported truthfully. */
const OBSERVED_DESCRIPTIONS: ReadonlyArray<RegExp> = [
  /declined by the bank/i,
  /temporary issue/i,
];

/** Error reasons carrying no information. */
const GENERIC_REASONS = new Set(["payment_failed", "", "-"]);

/**
 * Methods observed in real traffic. `error_source` is deliberately excluded from
 * classification: across every real sample it mapped one-to-one onto `method`,
 * so using both would imply two signals where there is one.
 */
const OBSERVED_METHODS = new Set(["card", "netbanking", "wallet"]);

export function classify(entity: RazorpayPaymentEntity): Classification {
  const reason = (entity.error_reason ?? "").trim();
  const description = (entity.error_description ?? "").trim();
  const method = (entity.method ?? "unknown").trim();

  // 1. A specific error reason is the strongest signal, when the provider sends one.
  const byReason = BY_REASON[reason];
  if (byReason) {
    return {
      failureClass: byReason,
      evidence: "documented",
      classifier: "rules" as const,
      basis: `error_reason "${reason}" is a documented failure mode`,
    };
  }

  // 2. Otherwise the description usually carries the meaning the reason omitted.
  for (const [pattern, failureClass] of BY_DESCRIPTION) {
    if (pattern.test(description)) {
      const seen = OBSERVED_DESCRIPTIONS.some((p) => p.test(description));
      return {
        failureClass,
        evidence: seen ? "observed" : "documented",
        classifier: "rules" as const,
        basis: `error_description indicates ${failureClass.replace(/_/g, " ")}: "${truncate(description)}"`,
      };
    }
  }

  // 3. Nothing specific anywhere. Method is all that is left.
  if (!GENERIC_REASONS.has(reason)) {
    return {
      failureClass: "unknown",
      evidence: "inferred",
      classifier: "rules" as const,
      basis: `error_reason "${reason}" is not in the known vocabulary and the description says nothing specific`,
    };
  }

  const evidence: Evidence = OBSERVED_METHODS.has(method) ? "observed" : "inferred";

  switch (method) {
    case "netbanking":
    case "wallet":
      return {
        failureClass: "transient_provider",
        evidence,
        classifier: "rules" as const,
        basis: `generic ${method} failure; provider-side problems dominate this method and are usually temporary`,
      };

    case "card":
      // A generic card failure could be a decline, an outage or a 3DS problem.
      // Guessing one would build a strategy on nothing.
      return {
        failureClass: "unknown",
        evidence,
        classifier: "rules" as const,
        basis: "generic card failure; decline, outage and authentication failure are indistinguishable here",
      };

    default:
      return {
        failureClass: "unknown",
        evidence: "inferred",
        classifier: "rules" as const,
        basis: `generic error on an unrecognised method "${method}"`,
      };
  }
}

/**
 * Trims at a word boundary. Cutting mid-word — "Any debite..." — reads as a
 * rendering fault rather than an abbreviation, and this string is shown to an
 * operator as the grounds for a decision.
 */
function truncate(text: string, max = 70): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,.;:]$/, "") + "…";
}

/**
 * Classifies a failure, asking a model only about descriptions the rules could
 * not read.
 *
 * The division of labour is the point. Rules own the documented vocabulary,
 * where the answer is known and a table is faster, deterministic and testable.
 * The model owns the tail — a production account sends descriptions this project
 * has never captured, and every one of them currently lands in `unknown` and
 * gets the conservative plan when a human reading the sentence would know
 * exactly what to do.
 *
 * The model is consulted only when three things are true: the rules produced no
 * class, there is a description worth reading, and that description is not one
 * of the generic strings that genuinely carry no information. Asking a model
 * what "Payment failed" means is asking it to invent something.
 *
 * It can only ever improve the answer. If it is unavailable, slow, or replies
 * with anything outside the six classes, the rules' answer stands unchanged.
 */
export async function classifyDeep(entity: RazorpayPaymentEntity): Promise<Classification> {
  const fromRules = classify(entity);
  if (fromRules.failureClass !== "unknown") return fromRules;

  const description = (entity.error_description ?? "").trim();
  if (!description || GENERIC_DESCRIPTIONS.has(description.toLowerCase())) return fromRules;

  const { classifyWithModel } = await import("./model-classifier.ts");
  const fromModel = await classifyWithModel(description);
  if (!fromModel || fromModel.failureClass === "unknown") return fromRules;

  return {
    failureClass: fromModel.failureClass,
    // Never "observed". Nothing about this was seen arriving — a model read a
    // sentence and made a judgement, and the audit trail should say so.
    evidence: "inferred",
    classifier: "model",
    basis: fromModel.basis,
  };
}

/**
 * Descriptions that say something went wrong without saying what. Every real
 * card failure captured in test mode reads "Payment failed", and handing that to
 * a model is asking it to guess.
 */
const GENERIC_DESCRIPTIONS = new Set([
  "payment failed",
  "transaction failed",
  "transaction declined",
  "an error occurred",
  "error",
]);

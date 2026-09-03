import type { RazorpayPaymentEntity } from "../razorpay/types.ts";

// Rules own the documented error codes. A model reads the descriptions the
// rules have never seen — see classifyDeep at the bottom.
//
// error_reason is the obvious field and it's useless in test mode: it reads
// "payment_failed" for every failure, including five cards documented to
// produce five different errors. error_description is where the real meaning
// is, and it does vary — "declined by the bank, try another method" vs
// "temporary issue, any amount debited will be refunded". Opposite strategies.

export type FailureClass =
  /** Provider-side and temporary. Same instrument will likely work shortly. */
  | "transient_provider"
  /** No money right now. Same instrument, materially later. */
  | "insufficient_funds"
  /** This instrument will keep failing. Offer a different rail. */
  | "instrument_rejected"
  /** Dropped at authentication. Intent is still warm. */
  | "authentication_abandoned"
  /** Deliberately backed out. Re-asking soon is unwelcome. */
  | "customer_cancelled"
  /** Undetermined. Strategy must be conservative. */
  | "unknown";

// Most of this vocabulary has never actually arrived here — it's read from the
// docs. Classifying on it is fine; presenting it as observed is not.
export type Evidence =
  /** Seen arriving from the provider. */
  | "observed"
  /** In the published vocabulary, never seen in our traffic. */
  | "documented"
  /** Nothing specific sent; deduced from the payment method. */
  | "inferred";

export interface Classification {
  failureClass: FailureClass;
  evidence: Evidence;
  /** Shown in the UI so a decision is never opaque. */
  basis: string;
  /** Separate from evidence: "how sure" and "what worked it out" differ. */
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

// Distinctive phrases, not whole strings — the observed text differs from the
// published text in small ways ("didn't" vs "did not"). First match wins, so
// specific patterns go first.
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

// error_source is deliberately not used: across every real sample it mapped
// one-to-one onto method, so using both would imply two signals where there's one.
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

// Trims at a word boundary. "Any debite…" looks like a bug, not an ellipsis.
function truncate(text: string, max = 70): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,.;:]$/, "") + "…";
}

// Asks a model only when the rules found nothing, there's a description worth
// reading, and it isn't one of the generic strings. Can only improve the
// answer: if the model is down or replies outside the six classes, rules stand.
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
    // Never "observed" — a model read a sentence and made a judgement.
    evidence: "inferred",
    classifier: "model",
    basis: fromModel.basis,
  };
}

// Say something went wrong without saying what. Every real card failure in test
// mode reads "Payment failed"; handing that to a model is asking it to guess.
const GENERIC_DESCRIPTIONS = new Set([
  "payment failed",
  "transaction failed",
  "transaction declined",
  "an error occurred",
  "error",
]);

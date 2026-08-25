import type { RazorpayPaymentEntity } from "../razorpay/types.ts";

/**
 * Turns a failed payment into a class that implies a recovery strategy.
 *
 * This is deliberately a lookup table and not a language model. The input is a
 * closed vocabulary published by the payment provider and the output is one of
 * six classes; a model would be slower, non-deterministic and untestable, and
 * would add nothing a table cannot do. The model earns its place later, writing
 * the message to the customer, where the output is genuinely open-ended.
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
        basis: `error_description indicates ${failureClass.replace(/_/g, " ")}: "${truncate(description)}"`,
      };
    }
  }

  // 3. Nothing specific anywhere. Method is all that is left.
  if (!GENERIC_REASONS.has(reason)) {
    return {
      failureClass: "unknown",
      evidence: "inferred",
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
        basis: `generic ${method} failure; provider-side problems dominate this method and are usually temporary`,
      };

    case "card":
      // A generic card failure could be a decline, an outage or a 3DS problem.
      // Guessing one would build a strategy on nothing.
      return {
        failureClass: "unknown",
        evidence,
        basis: "generic card failure; decline, outage and authentication failure are indistinguishable here",
      };

    default:
      return {
        failureClass: "unknown",
        evidence: "inferred",
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

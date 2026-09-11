import type { FailureClass } from "../recovery/classifier.ts";
import type { MessageContext } from "../recovery/templates.ts";
import type { ComposeOptions } from "../recovery/composer.ts";
import { VARIANTS, allClasses } from "../recovery/variants.ts";

export interface MatchRule {
  must: string[];
  mustNot: string[];
}

export interface Case {
  id: string;
  must: string[];
  mustNot: string[];
  failureClass: FailureClass;
  context: MessageContext;
  options: ComposeOptions;
}

export const UNIVERSAL: MatchRule = {
  must: [
    "contains the {{amount}} placeholder",
    "contains the {{link}} placeholder",
    "offers a way to complete the payment",
  ],
  mustNot: [
    "blames the customer or comments on their finances",
    // Was a must phrased "uses the name if one is given, and never invents one
    // if not". Two branches in one claim, and the judge only ever answered the
    // first — every no-name case failed on a rule it satisfied.
    "invents a customer name that was not provided",
  ]
};

export const CLASS_RULES: Record<FailureClass, MatchRule> = {
  "transient_provider": {
    // The failure was on the payment provider's side and temporary. Reassure them nothing is wrong with their card or account, and invite them to try the same way again.
    must: [
        "reassures the customer that nothing is wrong with their card or account",
        "invites them to try the same payment method again",
        "attributes the failure to the payment provider",
        "says the problem is temporary"
    ],
    mustNot: [
        "states or implies the payment failed due to problem from user side"
    ]
  },
  "insufficient_funds": {
    must: [],
    mustNot: [
        "states or implies the payment failed for lack of money",
        "uses the words balance, funds, or insufficient",
    ]
  },
  "instrument_rejected": {
    must: [],
    mustNot: []
  },
  "authentication_abandoned": {
    must: [],
    mustNot: []
  },
  "customer_cancelled": {
    must: [],
    mustNot: []
  },
  "unknown": {
    must: [],
    mustNot: []
  }
};

// Only what reaches the model varies. Amount and link are substituted by code
// after generation, so changing them tests nothing.
const METHODS = ["card", "netbanking", "wallet", "upi"];
const NAMES: (string | undefined)[] = [undefined, "kshitij"];
const AMOUNT = "₹850";
const LINK = "https://rzp.io";

const SHORT: Record<FailureClass, string> = {
  transient_provider: "transient",
  insufficient_funds: "insuf",
  instrument_rejected: "rejected",
  authentication_abandoned: "auth",
  customer_cancelled: "cancelled",
  unknown: "unknown",
};

// Read from the strategies, not assumed per class. unknown has an arm that
// steers away from the failed method and arms that don't, so it gets both.
function steerOptions(failureClass: FailureClass): boolean[] {
  return [...new Set(VARIANTS[failureClass].map((v) => v.avoidFailedMethod))];
}

const NAMED = "addresses the customer by the name provided";
const SWITCHING = "suggests switching to a different payment method";

/**
 * Claims that depend on what the composer was given rather than on the class.
 * Switching was filed under insufficient_funds, but it follows the steer flag:
 * a steered message has to suggest another method, an unsteered one must not.
 * Same claim both ways, only the polarity moves.
 */
export function inputClaims(context: MessageContext, options: ComposeOptions): MatchRule {
  const steer = options.steerToAnotherMethod ?? false;
  return {
    must: [...(context.name ? [NAMED] : []), ...(steer ? [SWITCHING] : [])],
    mustNot: steer ? [] : [SWITCHING],
  };
}

function gridCases(): Case[] {
  const cases: Case[] = [];
  for (const failureClass of allClasses()) {
    const steers = steerOptions(failureClass);
    for (const steer of steers) {
      for (const method of METHODS) {
        for (const name of NAMES) {
          const id = [SHORT[failureClass], method, name ? "named" : "noname"];
          if (steers.length > 1) id.push(steer ? "steer" : "nosteer");
          const context: MessageContext = { ...(name ? { name } : {}), method, amount: AMOUNT, link: LINK };
          const options: ComposeOptions = { steerToAnotherMethod: steer };
          cases.push({ id: id.join("-"), failureClass, context, options, ...inputClaims(context, options) });
        }
      }
    }
  }
  return cases;
}

// Specific known failures, pinned to the input that produced them. They don't
// fit the grid, so they're listed by hand and appended.
export const REGRESSION_CASES: Case[] = [];

export const CASES: Case[] = [...gridCases(), ...REGRESSION_CASES];

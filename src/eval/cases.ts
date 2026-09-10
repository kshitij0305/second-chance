import type { FailureClass } from "../recovery/classifier.ts";
import type { MessageContext } from "../recovery/templates.ts";
import type { ComposeOptions } from "../recovery/composer.ts";

export interface MatchRule {
  must: string[];
  mustNot: string[];
}

export interface Case {
  id: string;
  name?: string;
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
    "offer a way to complete the payment",
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
    must: [],
    mustNot: []
  },
  "insufficient_funds": {
    must: [],
    mustNot: [
        "states or implies the payment failed for lack of money",
        "uses the words balance, funds, or insufficient",
        "suggests switching to a different payment method",
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

export const CASES: Case[] = [
  {
    id: "insuf-card-noname",
    must: [],
    mustNot: [],
    failureClass: "insufficient_funds",
    context: {
      method: "card",
      amount: "₹850",
      link: "https://rzp.io",
    },
    options: {
      steerToAnotherMethod: false,
    },
  },
  {
    id: "insuf-netbanking-noname",
    must: [],
    mustNot: [],
    failureClass: "insufficient_funds",
    context: {
      method: "netbanking",
      amount: "₹850",
      link: "https://rzp.io",
    },
    options: {
      steerToAnotherMethod: false,
    },
  },
  {
    id: "insuf-wallet-noname",
    must: [],
    mustNot: [],
    failureClass: "insufficient_funds",
    context: {
      method: "wallet",
      amount: "₹850",
      link: "https://rzp.io",
    },
    options: {
      steerToAnotherMethod: false,
    },
  },
  {
    id: "insuf-upi-noname",
    must: [],
    mustNot: [],
    failureClass: "insufficient_funds",
    context: {
      method: "upi",
      amount: "₹850",
      link: "https://rzp.io",
    },
    options: {
      steerToAnotherMethod: false,
    },
  },
  {
    id: "insuf-card",
    must: ["addresses the customer by the name provided"],
    mustNot: [],
    failureClass: "insufficient_funds",
    context: {
      name: "kshitij",
      method: "card",
      amount: "₹850",
      link: "https://rzp.io",
    },
    options: {
      steerToAnotherMethod: false,
    },
  },
  {
    id: "insuf-netbanking",
    must: ["addresses the customer by the name provided"],
    mustNot: [],
    failureClass: "insufficient_funds",
    context: {
      name: "kshitij",
      method: "netbanking",
      amount: "₹850",
      link: "https://rzp.io",
    },
    options: {
      steerToAnotherMethod: false,
    },
  },
  {
    id: "insuf-wallet",
    must: ["addresses the customer by the name provided"],
    mustNot: [],
    failureClass: "insufficient_funds",
    context: {
      name: "kshitij",
      method: "wallet",
      amount: "₹850",
      link: "https://rzp.io",
    },
    options: {
      steerToAnotherMethod: false,
    },
  },
  {
    id: "insuf-upi",
    must: ["addresses the customer by the name provided"],
    mustNot: [],
    failureClass: "insufficient_funds",
    context: {
      name: "kshitij",
      method: "upi",
      amount: "₹850",
      link: "https://rzp.io",
    },
    options: {
      steerToAnotherMethod: false,
    },
  },
];

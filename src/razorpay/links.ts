import { randomUUID } from "node:crypto";
import { getRazorpay } from "./client.ts";
import { config } from "../config.ts";

// Razorpay test mode allows 30 payment links per account, ever — cancelling
// doesn't give the quota back. Every local run and replay was creating real
// ones and the account ran dry mid-development, with the demo still to record.
// Local runs use the stub now.

export interface PaymentLink {
  id: string;
  short_url: string;
  /** Which method was steered away from, if any. Recorded for the audit trail. */
  excluded_method?: string;
}

export interface CreateLinkInput {
  amount: number;
  currency: string;
  description: string;
  email?: string | undefined;
  contact?: string | undefined;
  notes: Record<string, string>;
  /** Method to hide. Ignored if the checkout can't hide it. */
  excludeMethod?: string | undefined;
}

/** The methods Razorpay's checkout can be told to show or hide. */
const TOGGLEABLE = ["card", "netbanking", "upi", "wallet"] as const;
type Toggleable = (typeof TOGGLEABLE)[number];

// Undefined when nothing is restricted, so the common case sends no options at
// all. Only ever hides one method — a link excluding everything can't be paid,
// which is worse than not steering.
export function checkoutMethods(excludeMethod?: string): Record<string, boolean> | undefined {
  if (!excludeMethod) return undefined;

  const target = excludeMethod.trim().toLowerCase();
  if (!TOGGLEABLE.includes(target as Toggleable)) return undefined;

  const methods: Record<string, boolean> = {};
  for (const method of TOGGLEABLE) methods[method] = method !== target;
  return methods;
}

const razorpayProvider: LinkProvider = {
  name: "razorpay",
  async create(input) {
    const methods = checkoutMethods(input.excludeMethod);

    const link = await getRazorpay().paymentLink.create({
      amount: input.amount,
      currency: input.currency,
      accept_partial: false,
      description: input.description,
      customer: { email: input.email, contact: input.contact },
      // We do the sending ourselves, so Razorpay must not also notify the
      // customer — otherwise every recovery goes out twice.
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: input.notes,
      ...(methods ? { options: { checkout: { method: methods } } } : {}),
    });

    return {
      id: link.id,
      short_url: link.short_url,
      ...(methods ? { excluded_method: input.excludeMethod } : {}),
    };
  },
};

export interface LinkProvider {
  readonly name: string;
  create(input: CreateLinkInput): Promise<PaymentLink>;
}

// The URL deliberately doesn't resolve. A stub real enough to open would
// eventually be mistaken for one; the dashboard also labels the provider.
const stubProvider: LinkProvider = {
  name: "stub",
  async create(input) {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 14);
    const methods = checkoutMethods(input.excludeMethod);
    return {
      id: `plink_stub${suffix}`,
      short_url: `https://stub.invalid/rzp/${suffix}`,
      ...(methods ? { excluded_method: input.excludeMethod } : {}),
    };
  },
};

export const linkProvider: LinkProvider =
  config.linkProvider === "stub" ? stubProvider : razorpayProvider;

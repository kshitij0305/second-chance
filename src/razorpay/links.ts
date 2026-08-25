import { randomUUID } from "node:crypto";
import { getRazorpay } from "./client.ts";
import { config } from "../config.ts";

/**
 * Creates the payment link a recovery is sent as.
 *
 * Exists because development was quietly spending a finite production-shaped
 * resource. Razorpay test mode allows thirty payment links per account, ever —
 * cancelling them does not give the quota back — and every local test run, every
 * replayed scenario and every end-to-end check was creating real ones. The
 * account ran dry mid-development, and the links were needed for the demo.
 *
 * So local runs use a stub: same shape, no network, no quota, instant. Real
 * links are created only when actually demonstrating against Razorpay. The rule
 * this encodes is that a development loop should never consume a resource the
 * demo depends on.
 */

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
  /**
   * The payment method to steer away from, when the failure was a property of
   * the instrument rather than of the moment. Ignored if it is not a method the
   * checkout can hide.
   */
  excludeMethod?: string | undefined;
}

/** The methods Razorpay's checkout can be told to show or hide. */
const TOGGLEABLE = ["card", "netbanking", "upi", "wallet"] as const;
type Toggleable = (typeof TOGGLEABLE)[number];

/**
 * Builds the checkout method configuration for a link.
 *
 * Returns undefined when nothing should be restricted, so the common case sends
 * no `options` at all and the customer sees everything the account supports.
 *
 * A recovery link that excludes every method cannot be paid, which would turn a
 * recovery attempt into a dead end — worse than not steering at all. Only one
 * method is ever hidden, and only if it is one the checkout recognises.
 */
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

/**
 * Produces links shaped like the real thing but never leaves the process.
 *
 * The URL is deliberately not resolvable. A stub that looked real enough to open
 * would eventually be mistaken for one, and the dashboard labels the provider
 * so a stubbed run cannot be presented as a live one.
 */
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

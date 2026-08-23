import { randomUUID } from "node:crypto";
import { razorpay } from "./client.ts";
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
}

export interface CreateLinkInput {
  amount: number;
  currency: string;
  description: string;
  email?: string | undefined;
  contact?: string | undefined;
  notes: Record<string, string>;
}

export interface LinkProvider {
  readonly name: string;
  create(input: CreateLinkInput): Promise<PaymentLink>;
}

const razorpayProvider: LinkProvider = {
  name: "razorpay",
  async create(input) {
    const link = await razorpay.paymentLink.create({
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
    });
    return { id: link.id, short_url: link.short_url };
  },
};

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
    return {
      id: `plink_stub${suffix}`,
      short_url: `https://stub.invalid/rzp/${suffix}`,
    };
  },
};

export const linkProvider: LinkProvider =
  config.linkProvider === "stub" ? stubProvider : razorpayProvider;

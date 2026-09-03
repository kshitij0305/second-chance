import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.ts";

// Until this existed the system diagnosed the failure, chose a plan, made a real
// payment link, wrote a message — and put it all on a dashboard. Nothing reached
// the customer, so nothing could ever be recovered. The zero was structural.
//
// Console channel by default, same as stub links: a dev loop shouldn't be able
// to email anybody.

export interface Delivery {
  channel: string;
  /** Where it actually went, which is not always where it was addressed. */
  to: string;
  error?: string;
}

export interface DeliveryRequest {
  /** The address on the failed payment. May be absent, may be a real customer. */
  to: string | null;
  subject: string;
  /** Plain text. The only thing a console channel or an SMS would ever show. */
  body: string;
  /** Optional. A channel that can't show it ignores it. */
  html?: string;
}

export interface Channel {
  readonly name: string;
  send(request: DeliveryRequest): Promise<Delivery>;
}

// Captured failures carry the real email of whoever was at that checkout, and
// this repo replays them constantly. A configured redirect wins over whatever
// the payment says; the original goes in the subject so it isn't silent.
// Returns null when there is nowhere safe to send.
export function resolveRecipient(addressed: string | null): { to: string; redirected: boolean } | null {
  if (config.deliveryRedirectTo) {
    return { to: config.deliveryRedirectTo, redirected: Boolean(addressed) && addressed !== config.deliveryRedirectTo };
  }
  if (!addressed) return null;
  return { to: addressed, redirected: false };
}

/** Logs what would have gone out. The default, so nothing is sent by accident. */
const consoleChannel: Channel = {
  name: "console",
  async send(request) {
    const resolved = resolveRecipient(request.to);
    const to = resolved?.to ?? "(no address)";
    console.log(`[deliver] console — would send to ${to}`);
    console.log(`           ${request.body}`);
    return { channel: "console", to };
  },
};

let transporter: Transporter | null = null;

const emailChannel: Channel = {
  name: "email",
  async send(request) {
    const resolved = resolveRecipient(request.to);
    if (!resolved) {
      return { channel: "email", to: "", error: "no recipient on the payment and no redirect configured" };
    }

    transporter ??= nodemailer.createTransport({
      service: "gmail",
      auth: { user: config.smtpUser, pass: config.smtpPass },
    });

    try {
      await transporter.sendMail({
        // Without a display name this is a bare Gmail address telling someone
        // their payment failed, which is indistinguishable from phishing.
        from: { name: config.merchantName, address: config.smtpFrom || config.smtpUser },
        to: resolved.to,
        // Say so in the subject. A test email that looks exactly like a real one
        // is how someone eventually believes it.
        subject: resolved.redirected ? `[redirected from ${request.to}] ${request.subject}` : request.subject,
        // Both parts always — HTML-only is itself a spam signal.
        text: request.body,
        html: request.html,
      });
      console.log(`[deliver] email sent to ${resolved.to}${resolved.redirected ? " (redirected)" : ""}`);
      return { channel: "email", to: resolved.to };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[deliver] email FAILED: ${message}`);
      return { channel: "email", to: resolved.to, error: message };
    }
  },
};

export const channel: Channel = config.deliveryChannel === "email" ? emailChannel : consoleChannel;

// Takes an amount and no failure class, so it can't start naming the reason. A
// subject shows on a lock screen; the insufficient_funds message avoids telling
// its own recipient why it failed, and the subject would tell everyone near them.
// Amount leads because it's the identifying fact, and it fits a phone.
export function subjectFor(amount: string): string {
  return `Your ${amount} payment didn't complete`;
}

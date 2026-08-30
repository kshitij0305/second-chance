import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.ts";

/**
 * Delivers the recovery message to the customer.
 *
 * Until this existed the system stopped one step short of its own premise. It
 * diagnosed the failure, chose a plan, created a real payment link and wrote a
 * message — and then put all of it on a dashboard. Nothing ever reached the
 * person who had failed to pay, which means nothing could ever be recovered. The
 * zero on the dashboard was not a demo artefact, it was the honest consequence.
 *
 * Same shape as the link provider: a console channel for development that sends
 * nothing, a real channel for demonstrations. A development loop should not be
 * able to email anybody.
 */

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
  /**
   * The email rendering of the same message. Optional: a channel that cannot
   * display it ignores it, and email falls back to sending text alone.
   */
  html?: string;
}

export interface Channel {
  readonly name: string;
  send(request: DeliveryRequest): Promise<Delivery>;
}

/**
 * Decides the address an email is actually sent to.
 *
 * Real captured failures carry the real email of whoever was at the checkout.
 * A development machine replaying captured traffic must never mail those people,
 * so when a redirect address is configured every message goes there instead,
 * regardless of what the payment said. The original recipient is preserved in
 * the subject so the redirect is visible rather than silent.
 *
 * Returns null when there is nowhere safe to send.
 */
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
        // A display name, because the alternative is a bare Gmail address
        // telling someone their payment failed — indistinguishable from a
        // phishing attempt, to a person and to a spam filter alike.
        from: { name: config.merchantName, address: config.smtpFrom || config.smtpUser },
        to: resolved.to,
        // A redirected message says so in the subject. A test email that looks
        // exactly like a production one is how someone eventually believes it.
        subject: resolved.redirected ? `[redirected from ${request.to}] ${request.subject}` : request.subject,
        // Both parts, always. An HTML-only message is itself a spam signal, and
        // some clients will only ever render the text one.
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

/**
 * The subject line.
 *
 * Deliberately says nothing about why the payment failed, and takes no failure
 * class so that it cannot start to. A subject is displayed on a lock screen, in
 * a notification, and over the shoulder of whoever is holding the phone. The
 * insufficient_funds message goes out of its way not to state its reason to the
 * person it is addressed to; putting that reason in the subject would announce
 * it to everyone else instead.
 *
 * The amount leads because it is the identifying fact — it is what tells someone
 * scanning an inbox which payment this is about. It is short enough that a phone
 * will not truncate it.
 *
 * No urgency and no marketing, the same register as the body.
 */
export function subjectFor(amount: string): string {
  return `Your ${amount} payment didn't complete`;
}

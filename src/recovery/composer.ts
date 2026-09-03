import Groq from "groq-sdk";
import type { FailureClass } from "./classifier.ts";
import { INTENT, steeringInstruction, renderTemplate, type MessageContext } from "./templates.ts";
import { config } from "../config.ts";

// Two rules keep the model safe here.
//
// It never handles facts — no amount, no link, no name. It writes placeholders
// and code substitutes. It can't misstate a number it was never given.
//
// It's never load-bearing. Every class has a template, and if generation is
// down, slow, or fails validation, the template ships.

export type MessageSource = "model" | "template" | "template_after_rejection";

export interface ComposedMessage {
  /** Real values substituted. What SMS sends and the dashboard shows. */
  text: string;
  /**
   * Same message, placeholders intact. Substitution is a rendering decision and
   * each medium makes it differently — SMS has only a URL to offer, email has a
   * button. Without this the email renderer would have to hunt for a URL inside
   * finished prose and hope it found the right one.
   */
  template: string;
  source: MessageSource;
  rejectionReason?: string;
}

const MAX_CHARS = 320;

/** Placeholders the model must use instead of real values. */
export const AMOUNT_TOKEN = "{{amount}}";
export const LINK_TOKEN = "{{link}}";

export const SYSTEM_PROMPT = `You write short payment recovery messages for Indian merchants, sent over SMS and WhatsApp.

Your message MUST contain both of these exact placeholders, or it is discarded unread:
  ${AMOUNT_TOKEN}   - where the amount goes
  ${LINK_TOKEN}     - where the payment link goes
Write them literally, braces included. Never write the actual amount or a real URL; you have not been told either.

Rules, all of them absolute:
- Output the message body only. No subject line, no preamble, no sign-off, no quotation marks around it.
- Never write a number, a currency figure, a date, a deadline, a discount or any offer. You do not know them.
- Under 300 characters.
- Plain and human. No marketing voice, no exclamation marks, no emoji, no guilt, no urgency tactics.
- Never blame the customer and never speculate about their finances.
- Indian English.

Two examples of correctly formatted output:

The bank declined the card and will keep declining it:
Hi Asha, your bank turned down the ${AMOUNT_TOKEN} payment on that card, and it is likely to be declined again. You can pay by another method here: ${LINK_TOKEN}

A temporary problem at the payment provider:
Hi, the ${AMOUNT_TOKEN} payment did not go through because of a temporary issue on the provider side. Nothing is wrong with your card. You can try again here: ${LINK_TOKEN}

Note that both contain ${AMOUNT_TOKEN} and ${LINK_TOKEN} exactly as written.`;

let client: Groq | null = null;

function getClient(): Groq | null {
  if (!config.groqEnabled) return null;
  client ??= new Groq({ apiKey: config.groqApiKey });
  return client;
}

export interface ComposeOptions {
  /**
   * Whether the plan actually hid the failed method on the checkout. The message
   * has to match the decision, not the failure class in general.
   */
  steerToAnotherMethod?: boolean;
}

export async function compose(
  failureClass: FailureClass,
  context: MessageContext,
  options: ComposeOptions = {},
): Promise<ComposedMessage> {
  const fallback = renderTemplate(failureClass, context);
  // Placeholder form too, so the fallback path hands the email renderer the same
  // thing the model path does.
  const fallbackTemplate = renderTemplate(failureClass, {
    ...context, amount: AMOUNT_TOKEN, link: LINK_TOKEN,
  });

  let raw: string;
  try {
    const generated = await generate(failureClass, context, options.steerToAnotherMethod ?? false);
    if (generated === null) return { text: fallback, template: fallbackTemplate, source: "template" };
    raw = generated;
  } catch (error) {
    console.warn(`[compose] generation unavailable, using template: ${describe(error)}`);
    return { text: fallback, template: fallbackTemplate, source: "template" };
  }

  const problem = validate(raw);
  if (problem) {
    // Record why. A rising rejection rate is the signal the model is too small.
    console.warn(`[compose] rejected generated message (${problem})`);
    return { text: fallback, template: fallbackTemplate, source: "template_after_rejection", rejectionReason: problem };
  }

  return { text: substitute(raw, context), template: raw, source: "model" };
}

/** Returns null when no provider is configured. Throws on provider failure. */
async function generate(
  failureClass: FailureClass,
  context: MessageContext,
  steerToAnotherMethod: boolean,
): Promise<string | null> {
  const groq = getClient();
  if (!groq) return null;

  const completion = await groq.chat.completions.create({
    model: config.composerModel,
    // gpt-oss reasons against the same token budget as the answer. At the
    // default effort this spent 298 of 300 tokens thinking, hit the limit, and
    // returned "" — every message silently fell back to a template. Low takes
    // reasoning to 7 tokens.
    reasoning_effort: "low",
    // Covers reasoning as well as output; the validator enforces message length.
    max_completion_tokens: 512,
    temperature: 0.6,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Payment method that failed: ${context.method}\n` +
          `What happened, and how to handle it: ${INTENT[failureClass]}\n` +
          `${steeringInstruction(steerToAnotherMethod)}\n` +
          (context.name
            ? `Customer's first name: ${context.name}\n`
            : "The customer's name is unknown; do not invent one.\n") +
          `\nWrite the message.`,
      },
    ],
  });

  return (completion.choices[0]?.message?.content ?? "").trim();
}

// Blunt on purpose. A missing link is unusable and an invented figure is a
// false promise about money — both worth losing a nicer sentence over.
export function validate(text: string): string | null {
  if (!text) return "empty";
  if (text.length > MAX_CHARS) return `too long (${text.length} chars)`;
  if (!text.includes(LINK_TOKEN)) return "no link placeholder";
  if (!text.includes(AMOUNT_TOKEN)) return "no amount placeholder";

  // Any digit outside the placeholders was invented: amount, deadline, discount.
  const stripped = text.split(AMOUNT_TOKEN).join("").split(LINK_TOKEN).join("");
  if (/\d/.test(stripped)) return "contains a number the model invented";

  if (/https?:\/\//i.test(stripped)) return "contains a URL other than the placeholder";
  if (/(\d+\s*%|percent|discount|coupon|off\b)/i.test(stripped)) return "offers a discount we did not authorise";
  return null;
}

function substitute(text: string, context: MessageContext): string {
  return text.split(AMOUNT_TOKEN).join(context.amount).split(LINK_TOKEN).join(context.link);
}

function describe(error: unknown): string {
  if (error instanceof Groq.APIError) return `${error.status} ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function formatAmount(paise: number): string {
  return "₹" + (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

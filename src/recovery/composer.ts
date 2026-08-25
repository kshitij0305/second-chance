import Groq from "groq-sdk";
import type { FailureClass } from "./classifier.ts";
import { INTENT, renderTemplate, type MessageContext } from "./templates.ts";
import { config } from "../config.ts";

/**
 * Writes the message the customer actually receives.
 *
 * This is the one place in the system where a model belongs. Classification and
 * strategy selection are closed problems with enumerable answers, so they are
 * lookup tables. This is not: the output is prose, the register has to shift
 * with the reason for the failure, and "your bank declined this card" and "there
 * wasn't enough balance" need very different handling for the same customer.
 *
 * Two rules make it safe to use one here.
 *
 * The model never handles facts. It is given no amount, no link and no name — it
 * writes a body with placeholders and code substitutes the real values. A model
 * cannot misstate a number it was never given.
 *
 * The model is never load-bearing. Every failure class has a deterministic
 * template, and if generation is unavailable, slow, or produces something that
 * fails validation, the template ships. A recovery must never be lost because an
 * inference provider was down.
 *
 * The provider is deliberately shallow here — one chat completion behind one
 * function. The parts worth keeping are the validation and the fallback, and
 * neither knows or cares which model wrote the words. Swapping providers touched
 * only `generate()` and left every test passing unchanged.
 */

export type MessageSource = "model" | "template" | "template_after_rejection";

export interface ComposedMessage {
  text: string;
  source: MessageSource;
  /** Set when a generated message was rejected, naming what was wrong with it. */
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

export async function compose(
  failureClass: FailureClass,
  context: MessageContext,
): Promise<ComposedMessage> {
  const fallback = renderTemplate(failureClass, context);

  let raw: string;
  try {
    const generated = await generate(failureClass, context);
    if (generated === null) return { text: fallback, source: "template" };
    raw = generated;
  } catch (error) {
    console.warn(`[compose] generation unavailable, using template: ${describe(error)}`);
    return { text: fallback, source: "template" };
  }

  const problem = validate(raw);
  if (problem) {
    // Something we will not send. Ship the template and record why, so a pattern
    // of rejections becomes visible rather than silent — a rising rejection rate
    // is the signal that the model is too small for the brief.
    console.warn(`[compose] rejected generated message (${problem})`);
    return { text: fallback, source: "template_after_rejection", rejectionReason: problem };
  }

  return { text: substitute(raw, context), source: "model" };
}

/** Returns null when no provider is configured. Throws on provider failure. */
async function generate(
  failureClass: FailureClass,
  context: MessageContext,
): Promise<string | null> {
  const groq = getClient();
  if (!groq) return null;

  const completion = await groq.chat.completions.create({
    model: config.composerModel,
    // gpt-oss models reason before answering, and reasoning is billed against
    // the same completion budget as the answer. At the default effort this task
    // spent 298 of 300 tokens thinking, hit the length limit, and returned an
    // empty string — every message silently fell back to a template.
    //
    // Writing two sentences from a supplied brief needs no deliberation, so
    // effort is pinned low. That took reasoning from 298 tokens to 7.
    reasoning_effort: "low",
    // Generous relative to a 300-character message, because this budget covers
    // reasoning as well as output. The message length limit is enforced by the
    // validator, which is the check that actually matters.
    max_completion_tokens: 512,
    temperature: 0.6,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Payment method that failed: ${context.method}\n` +
          `What happened, and how to handle it: ${INTENT[failureClass]}\n` +
          (context.name
            ? `Customer's first name: ${context.name}\n`
            : "The customer's name is unknown; do not invent one.\n") +
          `\nWrite the message.`,
      },
    ],
  });

  return (completion.choices[0]?.message?.content ?? "").trim();
}

/**
 * Rejects any generated message we would not stand behind.
 *
 * The checks are blunt on purpose. A missing link is unusable; a fabricated
 * figure is a false promise about money. Both are worth losing a nicer sentence
 * over.
 */
export function validate(text: string): string | null {
  if (!text) return "empty";
  if (text.length > MAX_CHARS) return `too long (${text.length} chars)`;
  if (!text.includes(LINK_TOKEN)) return "no link placeholder";
  if (!text.includes(AMOUNT_TOKEN)) return "no amount placeholder";

  // Any digit outside the placeholders is a number the model invented — an
  // amount, a deadline, a discount, an account fragment. None are acceptable.
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

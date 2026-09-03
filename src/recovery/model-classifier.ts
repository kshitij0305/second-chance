import Groq from "groq-sdk";
import { config } from "../config.ts";
import type { FailureClass } from "./classifier.ts";

// The rules are a lookup table over vocabulary we've seen. What they can't do is
// read something new — an expired card, a risk-system refusal, an issuer
// unavailable in a region. All of those land in `unknown` and get the cautious
// plan, when a human reading the sentence would know exactly what to do.
//
// Same two rules as the composer keep it safe: it picks from a closed list and
// anything else is discarded, and it's never load-bearing. It can improve a
// classification, never break one.
//
// It's also allowed to answer `unknown`. A classifier that must always produce
// an answer will produce one for "Payment failed".

const CLASSES: FailureClass[] = [
  "transient_provider",
  "insufficient_funds",
  "instrument_rejected",
  "authentication_abandoned",
  "customer_cancelled",
  "unknown",
];

const SYSTEM_PROMPT = `You classify failed payment messages from an Indian payment gateway.

Reply with exactly one of these words and nothing else:

transient_provider        the provider, gateway or bank had a temporary problem; the same instrument would likely work shortly
insufficient_funds        the account did not have enough money, or a spending or transaction limit was hit
instrument_rejected       this specific card or account was refused and will keep being refused; the customer needs a different one
authentication_abandoned  the payment failed at OTP, 3D Secure or another verification step
customer_cancelled        the customer deliberately cancelled or backed out
unknown                   the message does not say what went wrong

Choose unknown whenever the message is generic. "Payment failed", "Transaction declined" and "An error occurred" are all unknown — they describe that something went wrong, not what.

Do not explain. Do not add punctuation. One word.`;

let client: Groq | null = null;

export interface ModelClassification {
  failureClass: FailureClass;
  /** The description it read, for the audit trail. */
  basis: string;
}

// Null means the model was unavailable or unusable — caller keeps the rules.
export async function classifyWithModel(description: string): Promise<ModelClassification | null> {
  if (!config.groqEnabled) return null;

  const text = description.trim();
  if (!text) return null;

  client ??= new Groq({ apiKey: config.groqApiKey });

  try {
    const completion = await client.chat.completions.create({
      model: config.composerModel,
      // Same lesson as the composer — these reason against the completion
      // allowance, and this task needs none.
      reasoning_effort: "low",
      max_completion_tokens: 256,
      // Two identical failures must classify identically or the audit trail
      // stops meaning anything.
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    });

    const raw = (completion.choices[0]?.message?.content ?? "").trim().toLowerCase();
    const answer = raw.replace(/[^a-z_]/g, "");

    // The model picks from our vocabulary; it doesn't get to extend it.
    if (!CLASSES.includes(answer as FailureClass)) {
      console.warn(`[classify] model returned "${raw}", which is not a class — ignoring`);
      return null;
    }

    return {
      failureClass: answer as FailureClass,
      basis: `a model read the provider's description and classified it as ${answer}: "${truncate(text)}"`,
    };
  } catch (error) {
    const message = error instanceof Groq.APIError ? `${error.status} ${error.message}` : String(error);
    console.warn(`[classify] model unavailable, keeping the rules' answer: ${message}`);
    return null;
  }
}

function truncate(text: string, max = 70): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,.;:]$/, "") + "…";
}

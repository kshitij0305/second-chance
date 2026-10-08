import Groq from "groq-sdk";
import type { FailureClass } from "../recovery/classifier.ts";
import { UNIVERSAL, CLASS_RULES } from "./cases.ts";

// Deliberately not the model that wrote the messages. A model scores its own
// output higher than a stranger's, and swapping it costs nothing here.
export const JUDGE_MODEL = "openai/gpt-oss-120b";

/**
 * Exported so the human labelling CLI can show a rater the same instructions.
 * Two raters answering differently-worded questions do not disagree about the
 * message, they disagree about the question, and an agreement statistic over
 * that measures nothing.
 */
export const SYSTEM_PROMPT = `You check whether a payment recovery message has a stated property.

You get one message and one statement about it. Answer only whether the statement is true of the message as written.

Do not judge whether the message is good. Do not consider any property except the one stated. Judge the text in front of you, not what you assume the sender meant.

The statement does not have to appear word for word. A message that says the same thing in different words satisfies it.

But the message has to say it. A statement is not true because the message implies it, is consistent with it, or would lead a reader to assume it. If your reason would use the words implying, suggesting, or hinting, the answer is no.

Reply with JSON only: {"answer": "yes" | "no", "reason": "<one short sentence>"}`;

export type ClaimKind = "must" | "mustNot";

export interface Claim {
  claim: string;
  kind: ClaimKind;
}

export interface Judgement {
  answer: string;
  reason: string;
}

let client: Groq | null = null;

function groq(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");
  client ??= new Groq({ apiKey });
  return client;
}

/**
 * What the composer was given, in words. Without it the judge can't tell a
 * name the model invented from one it was handed.
 */
export function describeInput(method: string | undefined, name: string | null | undefined): string {
  const who = name ? `the customer name was ${name}` : "no customer name was provided";
  return `the payment method was ${method ?? "unknown"} and ${who}.`;
}

export function claimsFor(
  failureClass: FailureClass,
  caseMust: string[] = [],
  caseMustNot: string[] = [],
): Claim[] {
  const rules = CLASS_RULES[failureClass];
  return [
    ...[...UNIVERSAL.must, ...rules.must, ...caseMust].map((claim) => ({ claim, kind: "must" as const })),
    ...[...UNIVERSAL.mustNot, ...rules.mustNot, ...caseMustNot].map((claim) => ({ claim, kind: "mustNot" as const })),
  ];
}

/**
 * `model` exists so a second model can be asked the identical question as an
 * independent rater. It defaults to the judge, so every existing caller is
 * unchanged. Anything scored with a non-default model is model-to-model
 * agreement and has to be reported as that — it is not a human opinion and
 * does not substitute for one.
 */
export async function ask(
  message: string,
  input: string,
  claim: string,
  model: string = JUDGE_MODEL,
): Promise<Judgement> {
  const completion = await groq().chat.completions.create({
    model,
    temperature: 0,
    reasoning_effort: "low",
    max_completion_tokens: 512,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Input: ${input}\n\nMessage:\n${message}\n\nStatement: the message ${claim}` },
    ],
  });

  const raw = (completion.choices[0]?.message?.content ?? "").trim();
  try {
    const parsed = JSON.parse(raw);
    return { answer: String(parsed.answer ?? "").toLowerCase(), reason: String(parsed.reason ?? "") };
  } catch {
    return { answer: "unparseable", reason: raw.slice(0, 120) };
  }
}

/**
 * The judge is never told whether a claim is required or forbidden — it only
 * says whether the property is present. Told a rule is a prohibition, a model
 * answers what you want to hear.
 */
export function passes(kind: ClaimKind, answer: string): boolean {
  return kind === "must" ? answer === "yes" : answer === "no";
}

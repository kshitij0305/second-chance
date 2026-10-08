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
const HEADER = `You check whether a payment recovery message has a stated property.`;

/**
 * Shared by the one-claim and many-claim prompts, so a rule cannot be edited
 * into one and not the other. Two judges differing because someone changed one
 * copy is the kind of divergence that looks like a real finding for a day.
 */
const RULES = `Do not judge whether the message is good. Do not consider any property except the one stated. Judge the text in front of you, not what you assume the sender meant.

The statement does not have to appear word for word. A message that says the same thing in different words satisfies it.

But the message has to say it. A statement is not true because the message implies it, is consistent with it, or would lead a reader to assume it. If your reason would use the words implying, suggesting, or hinting, the answer is no.`;

export const SYSTEM_PROMPT = `${HEADER}

You get one message and one statement about it. Answer only whether the statement is true of the message as written.

${RULES}

Reply with JSON only: {"answer": "yes" | "no", "reason": "<one short sentence>"}`;

/**
 * The same judge asked about every claim on a message at once.
 *
 * Why: one claim per call re-sends the system prompt and the message for each
 * of a case's ~9 claims. 492 calls a run is 143,000 tokens against a 200,000
 * daily tier; batching is about 40,000.
 *
 * What it costs: the single-claim form has no ordering and nothing to compare,
 * which is why it was chosen. Asking nine questions at once reintroduces
 * position effects and gives the model room to answer for consistency across
 * claims rather than reading each one cold — the same failure that made a claim
 * with two branches unanswerable, where the judge answered the first and
 * ignored the second.
 *
 * So this is a different judge, not a cheaper one, and whether it agrees with
 * the original is a measurement rather than an assumption. judge-batched.ts
 * runs both and scores them against each other.
 */
export const BATCH_SYSTEM_PROMPT = `${HEADER}

You get one message and several numbered statements about it. For each statement, answer only whether it is true of the message as written.

${RULES}

Answer each statement on its own. Your answer to one statement must not depend on your answer to any other, and you must not try to make your answers agree with each other. Some statements will be true and others false of the same message; that is expected.

Answer every statement you are given, once each, and copy each statement back exactly as it was written.

Reply with JSON only: {"verdicts": [{"statement": "<copied exactly>", "answer": "yes" | "no", "reason": "<one short sentence>"}]}`;

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

/** Loose enough to survive reformatting, strict enough to still be the claim. */
function normalise(statement: string): string {
  return statement.toLowerCase().replace(/^the message /, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Asks about every claim on one message in a single call.
 *
 * Returns only the claims the model actually answered, matched by the statement
 * it echoed back rather than by position. Matching on order would silently
 * misattribute every verdict after a dropped or reordered one, and a run full of
 * confident wrong answers is worse than a run with holes. The caller decides
 * what to do about anything missing — judge-batched.ts re-asks it singly.
 */
export async function askAll(
  message: string,
  input: string,
  claims: readonly string[],
  model: string = JUDGE_MODEL,
): Promise<Map<string, Judgement>> {
  const numbered = claims.map((c, i) => `${i + 1}. the message ${c}`).join("\n");
  const completion = await groq().chat.completions.create({
    model,
    temperature: 0,
    reasoning_effort: "low",
    // Nine verdicts with a sentence each, plus reasoning against the same
    // budget. Running out mid-JSON loses the whole message rather than one
    // claim, which is the one way batching can cost more than it saves.
    max_completion_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: BATCH_SYSTEM_PROMPT },
      { role: "user", content: `Input: ${input}\n\nMessage:\n${message}\n\nStatements:\n${numbered}` },
    ],
  });

  const raw = (completion.choices[0]?.message?.content ?? "").trim();
  const out = new Map<string, Judgement>();
  let verdicts: unknown;
  try {
    verdicts = JSON.parse(raw)?.verdicts;
  } catch {
    return out;
  }
  if (!Array.isArray(verdicts)) return out;

  const byNormalised = new Map(claims.map((c) => [normalise(c), c]));
  for (const v of verdicts) {
    const echoed = String((v as { statement?: unknown })?.statement ?? "");
    const claim = byNormalised.get(normalise(echoed));
    // An unrecognised statement means the model invented or mangled one. Drop
    // it: the claim it was meant to answer is then simply missing, and gets
    // re-asked singly, which is the safe direction to fail in.
    if (!claim || out.has(claim)) continue;
    out.set(claim, {
      answer: String((v as { answer?: unknown }).answer ?? "").toLowerCase(),
      reason: String((v as { reason?: unknown }).reason ?? ""),
    });
  }
  return out;
}

/**
 * The judge is never told whether a claim is required or forbidden — it only
 * says whether the property is present. Told a rule is a prohibition, a model
 * answers what you want to hear.
 */
export function passes(kind: ClaimKind, answer: string): boolean {
  return kind === "must" ? answer === "yes" : answer === "no";
}

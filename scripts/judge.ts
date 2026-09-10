/**
 * Asks a model whether each composed message satisfies each claim.
 *
 * Reads eval_results.json, writes judge_results.json. Run `npm run eval` first.
 *
 *   npm run judge
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import Groq from "groq-sdk";
import { CASES, UNIVERSAL, CLASS_RULES } from "../src/eval/cases.ts";

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error("GROQ_API_KEY is not set — nothing to judge.");
  process.exit(1);
}

const groq = new Groq({ apiKey });

// Deliberately not the model that wrote the messages. A model scores its own
// output higher than a stranger's, and swapping it costs nothing here.
const JUDGE_MODEL = "openai/gpt-oss-120b";

const SYSTEM_PROMPT = `You check whether a payment recovery message has a stated property.

You get one message and one statement about it. Answer only whether the statement is true of the message as written.

Do not judge whether the message is good. Do not consider any property except the one stated. Judge the text in front of you, not what you assume the sender meant.

Reply with JSON only: {"answer": "yes" | "no", "reason": "<one short sentence>"}`;

interface EvalResult {
  id: string;
  source: string;
  name?: string;
  method?: string;
  rejectionReason?: string;
  template: string;
  text: string;
}

interface Verdict {
  id: string;
  claim: string;
  kind: "must" | "mustNot";
  answer: string;
  pass: boolean;
  reason: string;
}

async function ask(message: string, context: string, claim: string) {
  const completion = await groq.chat.completions.create({
    model: JUDGE_MODEL,
    temperature: 0,
    reasoning_effort: "low",
    max_completion_tokens: 512,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: `Input: ${context}

Message:
${message}

Statement: the message ${claim}`,
      },
    ],
  });

  const raw = (completion.choices[0]?.message?.content ?? "").trim();

  try {
    const parsed = JSON.parse(raw);

    return {
      answer: String(parsed.answer ?? "").toLowerCase(),
      reason: String(parsed.reason ?? ""),
    };
  } catch {
    return {
      answer: "unparseable",
      reason: raw.slice(0, 120),
    };
  }
}

const results: EvalResult[] = JSON.parse(
  readFileSync("eval_results.json", "utf8")
);

const verdicts: Verdict[] = [];

for (const result of results) {
  const testCase = CASES.find((c) => c.id === result.id);

  if (!testCase) {
    console.warn(`no case for result id ${result.id} — skipped`);
    continue;
  }

  const classRules = CLASS_RULES[testCase.failureClass];

  const claims: { claim: string; kind: "must" | "mustNot" }[] = [
    ...[...UNIVERSAL.must, ...classRules.must, ...testCase.must].map(
      (claim) => ({
        claim,
        kind: "must" as const,
      })
    ),

    ...[...UNIVERSAL.mustNot, ...classRules.mustNot, ...testCase.mustNot].map(
      (claim) => ({
        claim,
        kind: "mustNot" as const,
      })
    ),
  ];

  const context = `the payment method was ${
    result.method ?? "unknown"
  } and ${
    result.name
      ? `the customer name was ${result.name}`
      : "no customer name was provided"
  }.`;

  for (const { claim, kind } of claims) {
    const { answer, reason } = await ask(
      result.template,
      context,
      claim
    );

    // The judge only determines whether the property is present.
    // Polarity is decided here.
    const pass =
      kind === "must"
        ? answer === "yes"
        : answer === "no";

    verdicts.push({
      id: result.id,
      claim,
      kind,
      answer,
      pass,
      reason,
    });

    process.stdout.write(pass ? "." : "F");
  }
}

console.log();

writeFileSync(
  "judge_results.json",
  JSON.stringify(verdicts, null, 2)
);

const failed = verdicts.filter((v) => !v.pass);

console.log(
  `${verdicts.length} judgements, ${failed.length} failed`
);

for (const v of failed) {
  console.log(`  ${v.id} — ${v.claim}`);
  console.log(`    ${v.reason}`);
}
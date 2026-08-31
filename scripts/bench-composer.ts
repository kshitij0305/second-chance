/**
 * Measures whether a bigger model, or few-shot examples, is worth it for message
 * composition.
 *
 * The README claims a small model is the right size for this job. That was a
 * judgement, not a measurement. This turns it into a number: same prompt, same
 * validator, same failure classes, varying only the model and whether examples
 * are supplied.
 *
 * It measures the prompt production actually sends, which it did not always do.
 * The steering instruction was missing here while every real send included it,
 * so the reported rate was for a prompt one line shorter than the live one — and
 * that line turned out to be the one carrying most of the rejections. A benchmark
 * measuring something adjacent to the system is worse than no benchmark, because
 * the number it prints gets believed.
 *
 * The metric is the validator rejection rate. A rejected message is not a
 * stylistic complaint — it is one the system refused to send because it
 * fabricated a figure, dropped a placeholder or ran long, and the template went
 * out instead. A model that produces fewer of those is doing the job better, and
 * that is measurable without anyone reading prose and forming an impression.
 *
 *   npm run bench:composer
 *   npm run bench:composer -- 12      generations per class per variant
 */
import "dotenv/config";
import Groq from "groq-sdk";
import { SYSTEM_PROMPT, validate, AMOUNT_TOKEN, LINK_TOKEN } from "../src/recovery/composer.ts";
import { INTENT, steeringInstruction } from "../src/recovery/templates.ts";
import type { FailureClass } from "../src/recovery/classifier.ts";

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error("GROQ_API_KEY is not set — nothing to benchmark.");
  process.exit(1);
}

const groq = new Groq({ apiKey });
const perClass = Number(process.argv[2] ?? 8);

const CLASSES: FailureClass[] = [
  "transient_provider", "insufficient_funds", "instrument_rejected",
  "authentication_abandoned", "customer_cancelled", "unknown",
];

/** Published Groq pricing, dollars per million tokens. */
const PRICING: Record<string, { in: number; out: number }> = {
  "openai/gpt-oss-20b": { in: 0.075, out: 0.30 },
  "openai/gpt-oss-120b": { in: 0.15, out: 0.60 },
};

/**
 * Examples aimed squarely at the observed failure: the model omits the amount
 * placeholder. Showing rather than telling is the cheapest thing to try before
 * paying for a larger model.
 */
const FEW_SHOT = `
Two examples of correctly formatted output:

The bank declined the card and will keep declining it:
Hi Asha, your bank turned down the ${AMOUNT_TOKEN} payment on that card, and it is likely to be declined again. You can pay by another method here: ${LINK_TOKEN}

A temporary problem at the payment provider:
Hi, the ${AMOUNT_TOKEN} payment did not go through because of a temporary issue on the provider side. Nothing is wrong with your card. You can try again here: ${LINK_TOKEN}

Note that both contain ${AMOUNT_TOKEN} and ${LINK_TOKEN} exactly as written.`;

interface Variant {
  label: string;
  model: string;
  fewShot: boolean;
}

const VARIANTS: Variant[] = [
  { label: "20b, current prompt", model: "openai/gpt-oss-20b", fewShot: false },
  { label: "20b, few-shot", model: "openai/gpt-oss-20b", fewShot: true },
  { label: "120b, current prompt", model: "openai/gpt-oss-120b", fewShot: false },
];

interface Result {
  rejected: number;
  total: number;
  reasons: Record<string, number>;
  latencies: number[];
  inTokens: number;
  outTokens: number;
  errors: number;
}

async function runVariant(variant: Variant): Promise<Result> {
  const result: Result = { rejected: 0, total: 0, reasons: {}, latencies: [], inTokens: 0, outTokens: 0, errors: 0 };

  for (const failureClass of CLASSES) {
    for (let i = 0; i < perClass; i++) {
      const started = Date.now();
      try {
        const completion = await groq.chat.completions.create({
          model: variant.model,
          reasoning_effort: "low",
          max_completion_tokens: 512,
          temperature: 0.6,
          messages: [
            { role: "system", content: SYSTEM_PROMPT + (variant.fewShot ? FEW_SHOT : "") },
            {
              role: "user",
              content:
                `Payment method that failed: card\n` +
                `What happened, and how to handle it: ${INTENT[failureClass]}\n` +
                // Both branches, alternating. Production sends one of them on every
                // single call, and they do not perform the same.
                `${steeringInstruction(i % 2 === 0)}\n` +
                (i % 2 === 0 ? "Customer's first name: Asha\n" : "The customer's name is unknown; do not invent one.\n") +
                `\nWrite the message.`,
            },
          ],
        });

        result.latencies.push(Date.now() - started);
        result.inTokens += completion.usage?.prompt_tokens ?? 0;
        result.outTokens += completion.usage?.completion_tokens ?? 0;

        const text = (completion.choices[0]?.message?.content ?? "").trim();
        const problem = validate(text);
        result.total++;
        if (problem) {
          result.rejected++;
          const key = problem.startsWith("too long") ? "too long" : problem;
          result.reasons[key] = (result.reasons[key] ?? 0) + 1;
        }
      } catch (error) {
        result.errors++;
        result.total++;
      }
    }
  }
  return result;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

console.log(`${perClass} generations per class, ${CLASSES.length} classes, ${VARIANTS.length} variants.`);
console.log(`${perClass * CLASSES.length} calls per variant.\n`);

const results: [Variant, Result][] = [];
for (const variant of VARIANTS) {
  process.stdout.write(`running ${variant.label}... `);
  const result = await runVariant(variant);
  results.push([variant, result]);
  console.log(`done (${result.total} calls)`);
}

console.log("\n  variant                 rejected   median latency   cost / 1000 messages");
for (const [variant, r] of results) {
  const price = PRICING[variant.model]!;
  const perMessage = (r.inTokens / r.total) * (price.in / 1e6) + (r.outTokens / r.total) * (price.out / 1e6);
  const rejectRate = ((r.rejected / r.total) * 100).toFixed(1);
  console.log(
    `  ${variant.label.padEnd(22)}  ${(rejectRate + "%").padStart(7)}   ` +
    `${(median(r.latencies) + "ms").padStart(13)}   ` +
    `${("$" + (perMessage * 1000).toFixed(3)).padStart(8)}` +
    (r.errors ? `   (${r.errors} API errors)` : ""),
  );
}

console.log("\nwhy messages were rejected");
for (const [variant, r] of results) {
  const reasons = Object.entries(r.reasons).sort((a, b) => b[1] - a[1]);
  console.log(`  ${variant.label}: ${reasons.length ? reasons.map(([k, n]) => `${k} x${n}`).join(", ") : "nothing rejected"}`);
}

const [baseline] = results;
if (baseline) {
  const [, base] = baseline;
  console.log("\nagainst the current setup:");
  for (const [variant, r] of results.slice(1)) {
    const delta = (r.rejected / r.total) - (base.rejected / base.total);
    const price = PRICING[variant.model]!;
    const basePrice = PRICING[VARIANTS[0]!.model]!;
    const costRatio = (price.out / basePrice.out).toFixed(1);
    console.log(
      `  ${variant.label}: ${delta <= 0 ? "" : "+"}${(delta * 100).toFixed(1)} points of rejection` +
      (variant.model === VARIANTS[0]!.model ? ", same price" : `, ${costRatio}x the price`),
    );
  }
}

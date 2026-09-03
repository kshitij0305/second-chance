/**
 * Is a bigger model, or more examples, worth it for message composition?
 *
 * Metric is the validator rejection rate — a rejected message is one the system
 * refused to send, so the template went out instead.
 *
 * This did not always measure the prompt production sends. The steering
 * instruction was missing here while every real send included it, so every
 * number it ever printed was for a prompt one line shorter than the live one —
 * and that line is where most of the rejections are.
 *
 *   npm run bench:composer
 *   npm run bench:composer -- 12      generations per class per variant
 */
import "dotenv/config";
import Groq from "groq-sdk";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "groq-sdk/resources/chat/completions";
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

// Aimed at the observed failure: the model omits the amount placeholder.
// Showing beats telling, and it's cheaper than a bigger model.
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

// Rate limiting is not a benchmark result. The free tier allows 8000 tokens a
// minute and this loop asks for several times that; every 429 was landing in the
// catch below and counting as a failed generation, which reads on the summary as
// the model failing. Those calls never reached a model.
const RATE_LIMITED = 429;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds Groq asks us to wait, when it says. Falls back to a widening backoff. */
function retryAfter(error: unknown, attempt: number): number {
  const message = error instanceof Groq.APIError ? String(error.message) : "";
  const asked = message.match(/try again in ([0-9.]+)s/);
  return asked ? Math.ceil(Number(asked[1]) * 1000) + 500 : 5000 * (attempt + 1);
}

async function completeWithRetry(
  // The non-streaming overload specifically. The general parameter type admits
  // a stream, and a stream has no usage or choices to read.
  body: ChatCompletionCreateParamsNonStreaming,
): Promise<ChatCompletion> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await groq.chat.completions.create(body);
    } catch (error) {
      const limited = error instanceof Groq.APIError && error.status === RATE_LIMITED;
      if (!limited || attempt >= 8) throw error;
      await sleep(retryAfter(error, attempt));
    }
  }
}

async function runVariant(variant: Variant): Promise<Result> {
  const result: Result = { rejected: 0, total: 0, reasons: {}, latencies: [], inTokens: 0, outTokens: 0, errors: 0 };

  for (const failureClass of CLASSES) {
    for (let i = 0; i < perClass; i++) {
      const started = Date.now();
      try {
        const completion = await completeWithRetry({
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
                // Steering alternates; the name doesn't, because production has
                // none — engine.ts passes name: null and nothing sets it.
                // Alternating it spent half the run on a dead branch, and while
                // it shared a period with steering it hid the one combination
                // already known to fail. Restore it if a real name appears.
                `${steeringInstruction(i % 2 === 0)}\n` +
                "The customer's name is unknown; do not invent one.\n" +
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
      // ~16 calls a minute, which is what the limit buys at this prompt size.
      await sleep(3800);
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

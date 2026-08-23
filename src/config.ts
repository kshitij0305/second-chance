import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

/**
 * Compresses every strategy delay by this factor.
 *
 * Real delays run from 2 minutes to 24 hours, which is correct behaviour and
 * impossible to show in a five-minute demo. At a scale of 60 a 20-minute wait
 * becomes 20 seconds and the whole lifecycle is watchable, without any strategy
 * changing its mind about what it wants to do.
 *
 * 1 in production. Anything above 1 is visibly labelled in the UI, so a
 * compressed demo can never be mistaken for real timing.
 */
const timeScale = Number(process.env.TIME_SCALE ?? 1);

/**
 * Message generation is optional by design. Without a key the composer falls
 * back to deterministic templates, so the system is fully functional with no
 * model at all — the model improves messages, it does not enable them.
 */
const groqApiKey = process.env.GROQ_API_KEY ?? "";

export const config = {
  razorpayKeyId: required("RAZORPAY_KEY_ID"),
  razorpayKeySecret: required("RAZORPAY_KEY_SECRET"),
  webhookSecret: required("RAZORPAY_WEBHOOK_SECRET"),
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? "./second-chance.db",
  timeScale: Number.isFinite(timeScale) && timeScale >= 1 ? timeScale : 1,
  dispatchIntervalMs: Number(process.env.DISPATCH_INTERVAL_MS ?? 5000),
  /**
   * "stub" creates fake payment links locally instead of calling Razorpay.
   * Test mode allows thirty links per account for its entire lifetime and
   * cancelling does not return them, so a development loop that creates real
   * ones will exhaust the quota the demo needs. Default is real; local work
   * should set stub.
   */
  linkProvider: process.env.LINK_PROVIDER === "stub" ? "stub" : "razorpay",
  groqApiKey,
  groqEnabled: Boolean(groqApiKey),
  /**
   * A small model is the right size for this job. The output is two sentences
   * with a fixed shape, the brief is supplied in the prompt, and correctness is
   * enforced by validation rather than by model capability — a fabricated number
   * is caught by code, not hoped away by a better model.
   *
   * The rejection rate is the signal for whether this is too small: messages
   * rejected by the validator are recorded as `template_after_rejection`, so if
   * that climbs, move to openai/gpt-oss-120b.
   */
  composerModel: process.env.COMPOSER_MODEL ?? "openai/gpt-oss-20b",
};

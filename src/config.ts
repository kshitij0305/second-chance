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
  /**
   * When off, every class uses its default plan and behaviour is identical to
   * the version before the bandit existed. Kept as a switch because a learning
   * system you cannot turn off is one you cannot debug.
   */
  learningEnabled: process.env.LEARNING !== "off",
  /**
   * "email" actually delivers; anything else logs what would have gone out.
   * Defaults to not sending, on the same principle as stub payment links: a
   * development loop should not be able to contact a customer.
   */
  deliveryChannel: process.env.DELIVERY === "email" ? "email" : "console",
  smtpUser: process.env.SMTP_USER ?? "",
  /**
   * Whitespace stripped because Google displays app passwords in four groups of
   * four and everyone copies them that way. The literal value with spaces fails
   * authentication with a generic "username and password not accepted", which
   * points at the wrong problem entirely.
   */
  smtpPass: (process.env.SMTP_PASS ?? "").replace(/s+/g, ""),
  smtpFrom: process.env.SMTP_FROM ?? "",
  /**
   * When set, every message goes here instead of the address on the payment.
   * Captured real failures carry the email of whoever was at that checkout, and
   * replaying them on a laptop must not mail those people.
   */
  deliveryRedirectTo: process.env.DELIVERY_REDIRECT_TO ?? "",
  /**
   * How long a sent recovery waits before being counted as unanswered. Without
   * a horizon the bandit only ever hears about successes and learns nothing.
   */
  expiryHours: Number(process.env.EXPIRY_HOURS ?? 48),
  groqApiKey,
  groqEnabled: Boolean(groqApiKey),
  /**
   * A small model, measured rather than assumed. Across 150 generations each
   * (`npm run bench:composer`):
   *
   *   20b, plain prompt    4.7% rejected   $0.041 per 1000 messages
   *   20b, few-shot        0.7% rejected   $0.050
   *   120b, plain prompt   0.0% rejected   $0.093
   *
   * Two examples in the system prompt close almost the whole gap to a model
   * eight times the size, for 22% more cost rather than 130% more. At this
   * sample 0.7% and 0.0% are one rejection apart and not distinguishable.
   *
   * Every rejection in every variant had the same cause — the model omitting the
   * amount placeholder — which is an instruction-following miss, not a
   * capability limit. Instruction-following misses are fixed by showing rather
   * than by paying.
   */
  composerModel: process.env.COMPOSER_MODEL ?? "openai/gpt-oss-20b",
};

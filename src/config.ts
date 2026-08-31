import "dotenv/config";

/**
 * Credentials the server needs, checked when the server starts rather than when
 * this module loads.
 *
 * These used to throw on import. That made the whole config module unloadable
 * without a .env file, and since almost everything imports config, a clone of
 * this repository could not run its own test suite — four test files failed to
 * load at all, and the reported test count silently dropped from 72 to 35.
 * The README said `npm install && npm test`, and that had never been tried on a
 * machine that did not already have credentials.
 *
 * Configuration is data. Whether the data is sufficient is a question for the
 * thing that needs it, and a pure function under test needs none of it.
 */
const REQUIRED_TO_SERVE = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
] as const;

/**
 * Warns about settings that are individually valid but together mean the system
 * cannot do what it is about to announce.
 *
 * DELIVERY=email without SMTP credentials printed "messages are really sent" and
 * then failed on every message. The failure was recorded correctly and visible on
 * the dashboard, but the startup line said the opposite of the truth.
 */
export function warnAboutConfig(): void {
  if (config.deliveryChannel === "email" && (!config.smtpUser || !config.smtpPass)) {
    console.warn([
      "[config] DELIVERY=email but SMTP_USER or SMTP_PASS is empty — every send will fail.",
      "         Messages are still composed and recorded, with the delivery error against each one.",
    ].join("\n"));
  }
  if (config.deliveryChannel === "email" && !config.deliveryRedirectTo) {
    console.warn([
      "[config] DELIVERY=email with no DELIVERY_REDIRECT_TO — mail goes to the address on each payment.",
      "         Captured real failures carry real customer addresses. Set it unless this is production.",
    ].join("\n"));
  }
}

export function assertServerConfig(): void {
  const missing = REQUIRED_TO_SERVE.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(
      `Missing required env var${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.\n` +
      "Copy .env.example to .env and fill it in, then run npm run setup:secret.",
    );
  }
}

/**
 * Reads a numeric setting, falling back to the default when the value is absent
 * or nonsense.
 *
 * Every one of these was `Number(process.env.X ?? default)`, which returns NaN
 * for a typo and accepts zero and negatives without comment. The failures are
 * quiet and none of them look like a config problem when you hit them:
 * `EXPIRY_HOURS=abc` makes the expiry cutoff an Invalid Date, so the comparison
 * matches nothing and recoveries simply never resolve. `DISPATCH_INTERVAL_MS=0`
 * is a busy loop against the database and the payment provider.
 *
 * Refusing the value and saying so beats propagating a NaN into date arithmetic.
 */
function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`[config] ${name}="${raw}" is not a positive number — using ${fallback}`);
    return fallback;
  }
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
const timeScale = positiveNumber("TIME_SCALE", 1);

/**
 * Message generation is optional by design. Without a key the composer falls
 * back to deterministic templates, so the system is fully functional with no
 * model at all — the model improves messages, it does not enable them.
 */
const groqApiKey = process.env.GROQ_API_KEY ?? "";

export const config = {
  razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? "",
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET ?? "",
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",
  port: positiveNumber("PORT", 3000),
  dbPath: process.env.DB_PATH ?? "./second-chance.db",
  timeScale: timeScale >= 1 ? timeScale : 1,
  dispatchIntervalMs: positiveNumber("DISPATCH_INTERVAL_MS", 5000),
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
  smtpPass: (process.env.SMTP_PASS ?? "").replace(/\s+/g, ""),
  smtpFrom: process.env.SMTP_FROM ?? "",
  /**
   * The merchant the recovery is sent on behalf of.
   *
   * Used as the From display name and shown in the email itself. Without it the
   * recipient sees a bare Gmail address asking about a failed payment, which is
   * the exact shape of a phishing attempt — and mail providers score it that way
   * too. Nothing in this system knows the real merchant's name, so it is
   * configuration rather than something to infer.
   */
  merchantName: process.env.MERCHANT_NAME || "Second Chance",
  /**
   * When set, every message goes here instead of the address on the payment.
   * Captured real failures carry the email of whoever was at that checkout, and
   * replaying them on a laptop must not mail those people.
   */
  deliveryRedirectTo: process.env.DELIVERY_REDIRECT_TO ?? "",
  /** Mounts the checkout investigation harness. Off unless explicitly asked for. */
  labEnabled: process.env.LAB === "on",
  /**
   * How long a sent recovery waits before being counted as unanswered. Without
   * a horizon the bandit only ever hears about successes and learns nothing.
   */
  expiryHours: positiveNumber("EXPIRY_HOURS", 48),
  groqApiKey,
  groqEnabled: Boolean(groqApiKey),
  /**
   * A small model, measured rather than assumed. Across 72 generations per
   * variant (`npm run bench:composer -- 12`):
   *
   *   20b, current prompt    1.4% rejected   $0.052 per 1000 messages
   *   20b, examples twice    0.0%            $0.061
   *   120b, current prompt   0.0%            $0.121
   *
   * One rejection against none is not a difference to act on, and the larger
   * model asks double the price and 200ms more latency to deliver it.
   *
   * An earlier run reported 4.7% / 0.7% / 0.0% and is the reason the system
   * prompt carries two examples at all. Those numbers were taken on a prompt
   * missing the steering instruction that every real send includes, so they are
   * the history of a decision rather than a current measurement.
   *
   * Rejections all have the same cause — the model omitting the amount
   * placeholder — and they concentrate rather than spread. Sampled alone,
   * instrument_rejected with the steering branch rejects around 10-20%; across
   * six classes that dilutes to the 1.4% above. An instruction-following miss
   * rather than a capability limit, and the template ships whenever it happens.
   */
  composerModel: process.env.COMPOSER_MODEL ?? "openai/gpt-oss-20b",
};

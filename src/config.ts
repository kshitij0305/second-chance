import "dotenv/config";

// Checked at startup, not at import. These used to throw on import, which made
// config unloadable without a .env — four test files wouldn't even load and the
// suite silently ran 35 tests instead of 72.
const REQUIRED_TO_SERVE = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
] as const;

// DELIVERY=email with no SMTP creds printed "messages are really sent" and then
// failed on every one.
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

// These were all `Number(process.env.X ?? default)`, which yields NaN on a typo
// and accepts 0. EXPIRY_HOURS=abc made the cutoff an Invalid Date, so nothing
// ever matched and recoveries never resolved. DISPATCH_INTERVAL_MS=0 busy-loops.
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

// Divides the wall-clock delay only, never the strategy's stated intent. 1 in
// production; anything above is labelled in the UI.
const timeScale = positiveNumber("TIME_SCALE", 1);

// Optional. Without a key the composer falls back to templates — the model
// improves messages, it doesn't enable them.
const groqApiKey = process.env.GROQ_API_KEY ?? "";

export const config = {
  razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? "",
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET ?? "",
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",
  port: positiveNumber("PORT", 3000),
  dbPath: process.env.DB_PATH ?? "./second-chance.db",
  timeScale: timeScale >= 1 ? timeScale : 1,
  dispatchIntervalMs: positiveNumber("DISPATCH_INTERVAL_MS", 5000),
  // Test mode allows 30 payment links per account, ever, and cancelling doesn't
  // give them back. Use stub for local work.
  linkProvider: process.env.LINK_PROVIDER === "stub" ? "stub" : "razorpay",
  learningEnabled: process.env.LEARNING !== "off",
  // Defaults to not sending. A dev loop shouldn't be able to contact a customer.
  deliveryChannel: process.env.DELIVERY === "email" ? "email" : "console",
  smtpUser: process.env.SMTP_USER ?? "",
  // Google shows app passwords in four groups of four and everyone pastes them
  // that way. With the spaces it fails as "username and password not accepted".
  smtpPass: (process.env.SMTP_PASS ?? "").replace(/\s+/g, ""),
  smtpFrom: process.env.SMTP_FROM ?? "",
  // From display name. Without it the recipient sees a bare Gmail address asking
  // about a failed payment, which is what phishing looks like to a spam filter.
  merchantName: process.env.MERCHANT_NAME || "Second Chance",
  // Overrides the address on the payment. Captured real failures carry real
  // customers' addresses and this repo replays them constantly.
  deliveryRedirectTo: process.env.DELIVERY_REDIRECT_TO ?? "",
  labEnabled: process.env.LAB === "on",
  // Without a horizon the bandit only hears about successes.
  expiryHours: positiveNumber("EXPIRY_HOURS", 48),
  groqApiKey,
  groqEnabled: Boolean(groqApiKey),
  // Measured, not assumed — `npm run bench:composer -- 12`, 72 generations each:
  //   20b current 1.4% rejected $0.052/1k | 20b 2x examples 0.0% $0.061
  //   | 120b 0.0% $0.121. One rejection against none isn't a difference; 120b
  // wants 2x the price and 200ms for it. Rejections are always the same cause
  // (model drops the amount placeholder) and concentrate in instrument_rejected
  // with steering, ~10-20% there against 1.4% overall.
  composerModel: process.env.COMPOSER_MODEL ?? "openai/gpt-oss-20b",
};

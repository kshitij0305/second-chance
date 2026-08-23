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

export const config = {
  razorpayKeyId: required("RAZORPAY_KEY_ID"),
  razorpayKeySecret: required("RAZORPAY_KEY_SECRET"),
  webhookSecret: required("RAZORPAY_WEBHOOK_SECRET"),
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? "./second-chance.db",
  timeScale: Number.isFinite(timeScale) && timeScale >= 1 ? timeScale : 1,
  dispatchIntervalMs: Number(process.env.DISPATCH_INTERVAL_MS ?? 5000),
};

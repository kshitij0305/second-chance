import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

export const config = {
  razorpayKeyId: required("RAZORPAY_KEY_ID"),
  razorpayKeySecret: required("RAZORPAY_KEY_SECRET"),
  webhookSecret: required("RAZORPAY_WEBHOOK_SECRET"),
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? "./second-chance.db",
};

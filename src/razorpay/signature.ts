import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Razorpay signs the raw request body with the webhook secret (HMAC-SHA256).
 * The body must be the exact bytes received — parsing and re-serializing the
 * JSON changes key order and whitespace, and the signature stops matching.
 */
export function isValidWebhookSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Sends one real recovery email to DELIVERY_REDIRECT_TO so the rendering can be
 * looked at in an actual mail client. Throwaway — the preview in a browser is
 * not what Gmail does with a message.
 */
import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";

const secret = process.env.RAZORPAY_WEBHOOK_SECRET!;
const port = process.env.PORT ?? "3000";
const to = process.env.DELIVERY_REDIRECT_TO;

if (!to) {
  console.error("DELIVERY_REDIRECT_TO is empty — refusing to guess an address.");
  process.exit(1);
}

const id = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 14)}`;

const entity = {
  id: id("pay"),
  order_id: id("order"),
  entity: "payment",
  amount: 249900,
  currency: "INR",
  status: "failed",
  method: "card",
  error_code: "BAD_REQUEST_ERROR",
  error_reason: "card_declined",
  error_description: "Your payment didn't go through as it was declined by the bank.",
  error_source: "issuer",
  error_step: "payment_authorization",
  // Matching the redirect address means resolveRecipient reports no redirect,
  // so the subject is the real one rather than the diverted-from variant.
  email: to,
  contact: "+919876543210",
  created_at: Math.floor(Date.now() / 1000),
};

const body = JSON.stringify({
  entity: "event",
  event: "payment.failed",
  contains: ["payment"],
  payload: { payment: { entity } },
  created_at: Math.floor(Date.now() / 1000),
});

const response = await fetch(`http://localhost:${port}/webhooks/razorpay`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-razorpay-signature": createHmac("sha256", secret).update(body).digest("hex"),
    "x-second-chance-source": "replay",
  },
  body,
});

console.log(`${response.status} ${await response.text()}`);
console.log(`fired ${entity.id} — mail will go to the configured redirect address`);

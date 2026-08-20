/**
 * Replays a signed webhook against the local app, exactly as Razorpay would.
 *
 * This exists so the recovery loop can be developed and tested without a public
 * tunnel in the path. It signs with the same secret Razorpay uses, hits the same
 * route, and goes through the same signature check — the only thing it skips is
 * the network hop from Razorpay's servers.
 *
 * IMPORTANT: the payloads below are synthetic and the error fields are guesses.
 * Once real webhooks are flowing, replace these with payloads captured from the
 * webhook_events table. The failure taxonomy has to come from what Razorpay
 * actually sends, not from what we imagined it sends.
 *
 *   npm run replay -- card_declined
 *   npm run replay -- list
 */
import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";

const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
const port = process.env.PORT ?? "3000";

if (!secret) {
  console.error("RAZORPAY_WEBHOOK_SECRET is empty in .env — nothing to sign with.");
  process.exit(1);
}

const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 14)}`;

interface Scenario {
  method: string;
  amount: number;
  error_code: string;
  error_source: string;
  error_step: string;
  error_reason: string;
  description: string;
}

const SCENARIOS: Record<string, Scenario> = {
  card_declined: {
    method: "card", amount: 249900,
    error_code: "BAD_REQUEST_ERROR", error_source: "bank",
    error_step: "payment_authorization", error_reason: "payment_failed",
    description: "Card declined by issuing bank",
  },
  insufficient_funds: {
    method: "card", amount: 899900,
    error_code: "BAD_REQUEST_ERROR", error_source: "bank",
    error_step: "payment_authorization", error_reason: "insufficient_funds",
    description: "Insufficient balance",
  },
  otp_incorrect: {
    method: "card", amount: 129900,
    error_code: "BAD_REQUEST_ERROR", error_source: "customer",
    error_step: "payment_authentication", error_reason: "incorrect_otp",
    description: "Customer entered an incorrect OTP",
  },
  upi_timeout: {
    method: "upi", amount: 59900,
    error_code: "GATEWAY_ERROR", error_source: "gateway",
    error_step: "payment_authentication", error_reason: "payment_timeout",
    description: "UPI collect request expired",
  },
  gateway_down: {
    method: "netbanking", amount: 1499900,
    error_code: "GATEWAY_ERROR", error_source: "gateway",
    error_step: "payment_initiation", error_reason: "server_error",
    description: "Issuer unavailable",
  },
};

const name = process.argv[2];

if (!name || name === "list") {
  console.log("Scenarios:");
  for (const [key, s] of Object.entries(SCENARIOS)) {
    console.log(`  ${key.padEnd(20)} ${s.method.padEnd(11)} ₹${(s.amount / 100).toLocaleString("en-IN")}  ${s.description}`);
  }
  process.exit(name ? 0 : 1);
}

const scenario = SCENARIOS[name];
if (!scenario) {
  console.error(`Unknown scenario "${name}". Run: npm run replay -- list`);
  process.exit(1);
}

const body = JSON.stringify({
  entity: "event",
  event: "payment.failed",
  contains: ["payment"],
  payload: {
    payment: {
      entity: {
        id: id("pay"),
        entity: "payment",
        amount: scenario.amount,
        currency: "INR",
        status: "failed",
        order_id: id("order"),
        method: scenario.method,
        email: "customer@example.com",
        contact: "+919999999999",
        error_code: scenario.error_code,
        error_description: scenario.description,
        error_source: scenario.error_source,
        error_step: scenario.error_step,
        error_reason: scenario.error_reason,
        description: scenario.description,
        created_at: Math.floor(Date.now() / 1000),
      },
    },
  },
  created_at: Math.floor(Date.now() / 1000),
});

const signature = createHmac("sha256", secret).update(body).digest("hex");

const response = await fetch(`http://localhost:${port}/webhooks/razorpay`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-razorpay-signature": signature },
  body,
});

console.log(`${name} -> ${response.status} ${await response.text()}`);
if (response.status === 401) {
  console.error("Signature rejected. The secret this script read from .env does not match the one the app booted with — restart the app.");
}

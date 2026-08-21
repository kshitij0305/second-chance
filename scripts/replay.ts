/**
 * Replays a signed webhook against the local app, exactly as Razorpay would.
 *
 * This exists so the recovery loop can be developed and tested without a public
 * tunnel in the path. It signs with the same secret Razorpay uses, hits the same
 * route, and goes through the same signature check — the only thing it skips is
 * the network hop from Razorpay's servers.
 *
 * The error_code and error_reason values below come from the published
 * error-scenario table, not from invention. An earlier version of this file
 * guessed them — insufficient_funds, payment_failed, incorrect_otp — and every
 * guess was wrong. Since the classifier keys off these strings, a wrong fixture
 * would have trained it on a vocabulary that does not exist.
 *
 * Each scenario names the test card that reproduces the same failure at a real
 * checkout, so a synthetic replay and a real payment stay comparable.
 *
 * Still inferred, and worth correcting against captured payloads once real
 * webhooks land in webhook_events: error_source and error_step.
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
  /**
   * Razorpay validates contact numbers even in test mode and rejects recurring
   * digits — +919999999999 comes back as a 400. Each scenario uses a distinct,
   * plausible Indian mobile number.
   */
  contact: string;
  email: string;
  error_code: string;
  error_source: string;
  error_step: string;
  error_reason: string;
  description: string;
  /** Test card that produces this exact failure at a real checkout. */
  test_card: string;
}

const SCENARIOS: Record<string, Scenario> = {
  card_declined: {
    method: "card", amount: 249900, test_card: "4100 2800 0006 0003",
    contact: "+919876543210", email: "asha.menon@example.com",
    error_code: "BAD_REQUEST_ERROR", error_source: "bank",
    error_step: "payment_authorization", error_reason: "card_declined",
    description: "Declined by the issuing bank",
  },
  insufficient_fund: {
    method: "card", amount: 899900, test_card: "4100 2800 0008 0001",
    contact: "+919812345678", email: "rohan.das@example.com",
    error_code: "BAD_REQUEST_ERROR", error_source: "bank",
    error_step: "payment_authorization", error_reason: "insufficient_fund",
    description: "Not enough balance on the account",
  },
  payment_timed_out: {
    method: "card", amount: 129900, test_card: "4100 2800 0009 0000",
    contact: "+919673401285", email: "priya.nair@example.com",
    error_code: "BAD_REQUEST_ERROR", error_source: "bank",
    error_step: "payment_authorization", error_reason: "payment_timed_out",
    description: "Temporary issue at the bank end",
  },
  authentication_failed: {
    method: "card", amount: 59900, test_card: "4100 2800 0000 0009",
    contact: "+918745092361", email: "vikram.rao@example.com",
    error_code: "GATEWAY_ERROR", error_source: "gateway",
    error_step: "payment_authentication", error_reason: "authentication_failed",
    description: "OTP or verification details were wrong",
  },
  gateway_technical_error: {
    method: "card", amount: 1499900, test_card: "4100 2800 0002 0007",
    contact: "+917298436501", email: "sneha.iyer@example.com",
    error_code: "GATEWAY_ERROR", error_source: "gateway",
    error_step: "payment_initiation", error_reason: "gateway_technical_error",
    description: "Temporary gateway outage",
  },
};

const name = process.argv[2];

if (!name || name === "list") {
  console.log("Scenarios (card number reproduces the same failure at a real checkout):\n");
  for (const [key, s] of Object.entries(SCENARIOS)) {
    const rupees = (s.amount / 100).toLocaleString("en-IN");
    console.log(`  ${key.padEnd(24)} Rs ${rupees.padEnd(9)} ${s.test_card}   ${s.description}`);
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
        email: scenario.email,
        contact: scenario.contact,
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
  headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": signature,
      "x-second-chance-source": "replay",
    },
  body,
});

console.log(`${name} -> ${response.status} ${await response.text()}`);
if (response.status === 401) {
  console.error("Signature rejected. The secret this script read from .env does not match the one the app booted with — restart the app.");
}

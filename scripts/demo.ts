/**
 * Drives a scripted demonstration at a controlled pace.
 *
 * Recording a live system by hand means typing commands between sentences, and
 * every take comes out slightly different. This fires a fixed sequence with
 * fixed gaps, so the narration can be written against it and take one and take
 * nine are identical.
 *
 * It deliberately does not start the app. Run the server yourself so the
 * dashboard is already up and visible before anything happens:
 *
 *   LEARNING=off LINK_PROVIDER=stub TIME_SCALE=400 EXPIRY_HOURS=6 npm run dev
 *   npm run demo
 *
 * LEARNING=off matters. With the bandit active and no outcomes recorded yet,
 * Thompson sampling explores at random, so each class picks a different arm on
 * every run and the narration below stops matching what appears on screen — it
 * will claim the fastest re-offer while the slower arm is on the dashboard.
 * Turning learning off makes the decision path deterministic, which is what a
 * scripted walkthrough needs. Demonstrate the learning layer separately with
 * `npm run simulate`, where it has enough volume to actually be doing something.
 *
 * Drop LINK_PROVIDER to create real Razorpay links, which look considerably
 * better on camera — but note test mode allows only thirty per account for its
 * lifetime, so use a fresh account and keep takes to a minimum.
 *
 *   npm run demo -- --reset     clear the database and stop
 *   npm run demo -- --pace 12   seconds between beats (default 9)
 */
import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
const port = process.env.PORT ?? "3000";
const dbPath = process.env.DB_PATH ?? "./second-chance.db";

if (!secret) {
  console.error("RAZORPAY_WEBHOOK_SECRET is empty in .env — nothing to sign with.");
  process.exit(1);
}

const args = process.argv.slice(2);
const paceFlag = args.indexOf("--pace");
const pace = (paceFlag >= 0 ? Number(args[paceFlag + 1]) : 9) * 1000;

function reset(): void {
  const db = new DatabaseSync(dbPath);
  for (const table of ["recovery_attempts", "failed_payments", "webhook_events", "strategy_outcomes"]) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.close();
  console.log(`cleared ${dbPath} — dashboard is empty, ready for a take`);
}

if (args.includes("--reset")) {
  reset();
  process.exit(0);
}

interface Beat {
  /** What the operator says while this lands. */
  say: string;
  entity: Record<string, unknown>;
  /** Real captured payload, or constructed from the documented vocabulary. */
  real: boolean;
}

const observed: Record<string, unknown>[] = JSON.parse(
  readFileSync(new URL("../src/recovery/fixtures/observed-failures.json", import.meta.url), "utf8"),
);

const realOf = (method: string) => {
  const found = observed.find((e) => e.method === method);
  if (!found) throw new Error(`no captured ${method} failure in the fixtures`);
  return found;
};

const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 14)}`;

const contact = ["+919876543210", "+919812345678", "+919673401285", "+918745092361", "+917298436501"];

function synthetic(over: Record<string, unknown>, i: number): Record<string, unknown> {
  return {
    amount: 249900, currency: "INR", status: "failed", method: "card",
    error_code: "BAD_REQUEST_ERROR", error_description: "Payment failed",
    error_source: "gateway", error_step: "payment_authorization",
    ...over,
  };
}

/**
 * The order is the argument.
 *
 * Beats one and two are the product in two frames: two real captured failures
 * carrying an identical `error_reason`, which get opposite strategies because
 * the description says different things. Beat three is the honest limitation.
 * Beats four and five show the range of the strategy table.
 */
const BEATS: Beat[] = [
  {
    say: "A real netbanking failure. The description says the bank declined it and to try another method — so: switch rails, and quickly, because waiting changes nothing.",
    entity: realOf("netbanking"),
    real: true,
  },
  {
    say: "A real wallet failure. Identical error_reason to the last one — 'payment_failed'. But the description says temporary issue, refund pending. Opposite plan: same rail, wait it out. A classifier reading error_reason alone gets this backwards.",
    entity: realOf("wallet"),
    real: true,
  },
  {
    say: "A real card failure. Test mode collapses every card decline to one generic error, so this cannot be diagnosed — and it says so rather than guessing. Five of my seven real captures land here.",
    entity: realOf("card"),
    real: true,
  },
  {
    say: "Authentication abandoned. The customer was seconds from done, so this gets the fastest re-offer the safety floor allows. Watch the message that gets composed.",
    entity: synthetic({ error_reason: "authentication_failed", amount: 59900,
      error_description: "Your payment could not be completed due to incorrect OTP or verification details." }, 3),
    real: false,
  },
  {
    say: "Insufficient funds. Retrying an empty account within the hour just declines again, so this waits until the next morning — and the message never says why, because telling someone their account was empty is a needless embarrassment.",
    entity: synthetic({ error_reason: "insufficient_fund", amount: 899900,
      error_description: "Your payment could not be completed due to insufficient account balance." }, 4),
    real: false,
  },
  {
    say: "And this one my rules cannot read. An expired card is not in the documented vocabulary and no pattern matches it, so it would land in unknown and get the cautious plan. Instead a model reads the sentence, picks from the same six classes, and gets it right — the card will keep failing, so switch rails. If it answered with anything outside those six, the rules' answer would stand.",
    entity: synthetic({ error_reason: "payment_failed", amount: 459900,
      error_description: "Your card has expired. Please use a different card." }, 5),
    real: false,
  },
];

async function fire(beat: Beat, index: number): Promise<void> {
  const entity = {
    ...beat.entity,
    id: id("pay"),
    order_id: id("order"),
    entity: "payment",
    contact: contact[index % contact.length],
    email: "customer@example.com",
    created_at: Math.floor(Date.now() / 1000),
  };

  const body = JSON.stringify({
    entity: "event",
    event: "payment.failed",
    contains: ["payment"],
    payload: { payment: { entity } },
    created_at: Math.floor(Date.now() / 1000),
  });

  const signature = createHmac("sha256", secret!).update(body).digest("hex");

  const response = await fetch(`http://localhost:${port}/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": signature,
      // Replays of genuinely captured payloads are marked as such; nothing here
      // claims to be live provider traffic.
      "x-second-chance-source": "replay",
    },
    body,
  });

  if (!response.ok) {
    console.error(`  beat ${index + 1} failed: ${response.status} ${await response.text()}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The narration names specific plans, which only hold when selection is
// deterministic. Better to refuse than to have the operator discover mid-take
// that the dashboard disagrees with what they are saying.
const stats = await fetch(`http://localhost:${port}/api/stats`)
  .then((r) => r.json() as Promise<{ learning?: boolean }>)
  .catch(() => null);

if (stats === null) {
  console.error(`Nothing answering on http://localhost:${port}. Start the app first.`);
  process.exit(1);
}

if (stats.learning !== false) {
  console.error([
    "Refusing to run: the app has learning enabled.",
    "",
    "With no outcomes recorded the bandit explores at random, so each class picks a",
    "different plan every run and the narration in this script will not match the",
    "dashboard. Restart the app with learning off:",
    "",
    "  LEARNING=off LINK_PROVIDER=stub TIME_SCALE=400 EXPIRY_HOURS=6 npm run dev",
    "",
    "Show the learning layer separately with: npm run simulate",
  ].join("\n"));
  process.exit(1);
}

reset();
console.log(`\n${BEATS.length} beats, ${pace / 1000}s apart. Dashboard: http://localhost:${port}\n`);
await wait(2000);

for (const [i, beat] of BEATS.entries()) {
  const tag = beat.real ? "REAL CAPTURE" : "documented vocabulary";
  console.log(`\n─── beat ${i + 1}/${BEATS.length}  (${tag}) ─────────────────────────`);
  console.log(`  ${beat.say}\n`);
  await fire(beat, i);
  if (i < BEATS.length - 1) await wait(pace);
}

console.log("\n─── all beats fired ────────────────────────────────────");
console.log("  Now let it run. Recoveries dispatch on their own schedule, messages");
console.log("  get composed as each one sends, and unanswered ones expire into the");
console.log("  learning table at the bottom of the dashboard.\n");

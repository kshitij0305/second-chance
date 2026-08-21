/**
 * Re-delivers a webhook payload that Razorpay already sent us, straight from the
 * webhook_events table.
 *
 * Two uses. Recovering from a handler bug: the raw payload is stored before any
 * processing, so a fix can be applied to traffic that already arrived instead of
 * having to reproduce the payment. And building the classifier: real captured
 * failures are the only honest input for a failure taxonomy, and this replays
 * them on demand without a checkout in the loop.
 *
 *   npm run redeliver -- list
 *   npm run redeliver -- 7
 *   npm run redeliver -- all payment.failed
 */
import "dotenv/config";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
const port = process.env.PORT ?? "3000";
const dbPath = process.env.DB_PATH ?? "./second-chance.db";

if (!secret) {
  console.error("RAZORPAY_WEBHOOK_SECRET is empty in .env — nothing to sign with.");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const [command, filter] = process.argv.slice(2);

interface EventRow { id: number; event: string; payload: string; received_at: string }

if (!command || command === "list") {
  const rows = db.prepare(
    "SELECT id, event, received_at FROM webhook_events ORDER BY id DESC LIMIT 30",
  ).all() as unknown as Omit<EventRow, "payload">[];

  if (!rows.length) {
    console.log("No webhooks captured yet.");
    process.exit(0);
  }
  console.log("id   received             event");
  for (const r of rows) {
    console.log(`${String(r.id).padEnd(4)} ${r.received_at}  ${r.event}`);
  }
  process.exit(0);
}

const rows: EventRow[] = command === "all"
  ? db.prepare(
      filter
        ? "SELECT id, event, payload, received_at FROM webhook_events WHERE event = ? ORDER BY id"
        : "SELECT id, event, payload, received_at FROM webhook_events ORDER BY id",
    ).all(...(filter ? [filter] : [])) as unknown as EventRow[]
  : db.prepare(
      "SELECT id, event, payload, received_at FROM webhook_events WHERE id = ?",
    ).all(Number(command)) as unknown as EventRow[];

if (!rows.length) {
  console.error(`Nothing matched "${command}${filter ? " " + filter : ""}". Try: npm run redeliver -- list`);
  process.exit(1);
}

for (const row of rows) {
  // Re-serialise from the stored object. Key order is stable through
  // parse/stringify here because we sign the same bytes we send — this is our
  // own signature, not Razorpay's, so it only has to be internally consistent.
  const body = JSON.stringify(JSON.parse(row.payload));
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  const response = await fetch(`http://localhost:${port}/webhooks/razorpay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": signature },
    body,
  });

  console.log(`#${row.id} ${row.event.padEnd(22)} -> ${response.status} ${await response.text()}`);
}

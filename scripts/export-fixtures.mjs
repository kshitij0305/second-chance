/**
 * Exports real captured failures as a test fixture, with personal data removed.
 *
 * The classifier should be tested against payloads the provider actually sent,
 * not ones we invented — that is the whole lesson of this build. But those
 * payloads came from real checkouts and carry an email, a phone number and card
 * identifiers, none of which belong in a repository. Only the fields the
 * classifier reads are kept; everything identifying is replaced.
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import "dotenv/config";

const db = new DatabaseSync(process.env.DB_PATH ?? "./second-chance.db");
const rows = db.prepare(
  "SELECT payload FROM webhook_events WHERE event = 'payment.failed' AND source = 'razorpay' ORDER BY id",
).all();

const KEEP = ["amount", "currency", "status", "method", "error_code",
              "error_description", "error_source", "error_step", "error_reason"];

const fixtures = rows.map((row, i) => {
  const entity = JSON.parse(row.payload).payload.payment.entity;
  const scrubbed = { id: `pay_fixture${String(i + 1).padStart(2, "0")}` };
  for (const k of KEEP) if (entity[k] !== undefined) scrubbed[k] = entity[k];
  return scrubbed;
});

writeFileSync(
  "src/recovery/fixtures/observed-failures.json",
  JSON.stringify(fixtures, null, 2) + "\n",
);
console.log(`wrote ${fixtures.length} scrubbed fixtures`);

const text = JSON.stringify(fixtures);
for (const [label, re] of [["email", /@/], ["digits-run", /\d{7,}/]]) {
  if (re.test(text)) console.log(`  WARNING: possible ${label} survived scrubbing`);
}

/**
 * Summarises the real failures captured in webhook_events.
 *
 * The classifier has to be built from the failure vocabulary Razorpay actually
 * sends, not the one the docs describe — a card documented to produce
 * `card_declined` was observed producing `payment_failed` from `gateway`.
 *
 * Synthetic replays are excluded by default. They live in the same table as real
 * traffic, and counting them as evidence is how a taxonomy ends up describing
 * its own fixtures: an earlier run of this script reported `insufficient_funds`
 * and `incorrect_otp` as observed failure reasons when both were invented by the
 * replay script and have never appeared in real Razorpay traffic.
 *
 *   npm run taxonomy
 *   npm run taxonomy -- --all-sources
 *   npm run taxonomy -- --raw
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.DB_PATH ?? "./second-chance.db");

interface Entity {
  method?: string;
  error_code?: string;
  error_source?: string;
  error_step?: string;
  error_reason?: string;
  error_description?: string;
  amount?: number;
  id?: string;
}

const includeAll = process.argv.includes("--all-sources");

const bySource = db.prepare(
  "SELECT source, COUNT(*) n FROM webhook_events WHERE event = 'payment.failed' GROUP BY source",
).all() as unknown as { source: string; n: number }[];

console.log("payment.failed rows by provenance:");
for (const r of bySource) console.log(`  ${String(r.source).padEnd(12)} ${r.n}`);
console.log(includeAll ? "\ncounting ALL sources\n" : "\ncounting real Razorpay traffic only\n");

const rows = db.prepare(
  includeAll
    ? "SELECT payload FROM webhook_events WHERE event = 'payment.failed' ORDER BY id"
    : "SELECT payload FROM webhook_events WHERE event = 'payment.failed' AND source = 'razorpay' ORDER BY id",
).all() as unknown as { payload: string }[];

if (!rows.length) {
  console.log("No real failures captured yet.");
  process.exit(0);
}

const entities: Entity[] = rows.map((r) => JSON.parse(r.payload).payload.payment.entity);

if (process.argv.includes("--raw")) {
  for (const e of entities) console.log(JSON.stringify(e, null, 2));
  process.exit(0);
}

console.log(`${entities.length} real failures\n`);

// A field with one distinct value across every sample carries no signal and
// cannot be part of a classification key, however meaningful its name sounds.
console.log("field variance");
const FIELDS = ["method", "error_code", "error_source", "error_step", "error_reason", "error_description"] as const;
for (const field of FIELDS) {
  const values = new Map<string, number>();
  for (const e of entities) {
    const v = String(e[field] ?? "(absent)");
    values.set(v, (values.get(v) ?? 0) + 1);
  }
  const flag = values.size === 1 ? "   <- constant, no signal" : "";
  console.log(`  ${field.padEnd(18)} ${values.size} distinct${flag}`);
  for (const [v, n] of [...values.entries()].sort((a, b) => b[1] - a[1])) {
    const shown = v.length > 88 ? v.slice(0, 85) + "..." : v;
    console.log(`      x${String(n).padEnd(3)} ${shown}`);
  }
}

console.log("\ndistinct combinations");
const combos = new Map<string, number>();
for (const e of entities) {
  const key = [e.method, e.error_code, e.error_source, e.error_step, e.error_reason]
    .map((v) => v ?? "-")
    .join(" | ");
  combos.set(key, (combos.get(key) ?? 0) + 1);
}
for (const [key, n] of [...combos.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${key}   x${n}`);
}

console.log(`\n${combos.size} distinct combination(s) across ${entities.length} real failures.`);
if (combos.size < 3) {
  console.log("Too few to classify on. Vary the method (UPI, netbanking) and the card network.");
}

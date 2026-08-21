/**
 * Re-runs the classifier over every captured failure and updates the stored
 * classification.
 *
 * Distinct from `redeliver`, which re-posts a payload through the full webhook
 * handler and therefore repeats its side effects — creating fresh payment links,
 * spending rate limit, and adding duplicate recovery attempts. Classification is
 * a pure function of a payload already on disk, so re-running it should touch
 * nothing but the classification columns.
 *
 * The classifier will keep changing as more failure shapes are understood. This
 * makes every previously captured failure benefit from that, instead of the
 * stored classification reflecting whatever the rules happened to be on the day
 * it first arrived.
 *
 *   npm run reclassify
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import { classify } from "../src/recovery/classifier.ts";
import type { RazorpayPaymentEntity } from "../src/razorpay/types.ts";

const db = new DatabaseSync(process.env.DB_PATH ?? "./second-chance.db");

const realOnly = !process.argv.includes("--all-sources");

const rows = db.prepare(
  `SELECT payment_id, payload, webhook_events.source AS source
     FROM webhook_events
     JOIN failed_payments ON failed_payments.payment_id =
          json_extract(webhook_events.payload, '$.payload.payment.entity.id')
    WHERE webhook_events.event = 'payment.failed'
    GROUP BY payment_id`,
).all() as unknown as { payment_id: string; payload: string; source: string }[];

if (!rows.length) {
  console.log("Nothing to reclassify.");
  process.exit(0);
}

const update = db.prepare(
  "UPDATE failed_payments SET failure_class = ?, evidence = ?, basis = ? WHERE payment_id = ?",
);

const counts = new Map<string, number>();
const skipped: string[] = [];
for (const row of rows) {
  if (realOnly && row.source !== "razorpay") { skipped.push(row.payment_id); continue; }
  const entity: RazorpayPaymentEntity = JSON.parse(row.payload).payload.payment.entity;
  const result = classify(entity);
  update.run(result.failureClass, result.evidence, result.basis, row.payment_id);
  db.prepare("UPDATE failed_payments SET source = ? WHERE payment_id = ?").run(row.source, row.payment_id);
  const key = `${result.failureClass} (${result.evidence})`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

const done = rows.length - skipped.length;
const suffix = skipped.length
  ? ` (skipped ${skipped.length} synthetic; pass --all-sources to include them)`
  : "";
console.log(`reclassified ${done} real failures${suffix}
`);
for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padEnd(3)} ${key}`);
}

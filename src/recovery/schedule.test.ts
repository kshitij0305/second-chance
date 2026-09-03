import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, existsSync } from "node:fs";

// Regression test for duplicate recoveries from retried webhooks. Razorpay
// retries delivery on any non-2xx, so the same payment.failed arrives more than
// once routinely — one event delivered three times gave one failure two live
// payment links, by a different route than the dispatcher race.
//
// The cause was misreading maxAttempts: it means N asks over time, each after
// the last went unanswered, not N outstanding at once.

const DB = "./schedule-test.db";
process.env.DB_PATH = DB;
process.env.RAZORPAY_KEY_ID ??= "rzp_test_x";
process.env.RAZORPAY_KEY_SECRET ??= "x";
process.env.RAZORPAY_WEBHOOK_SECRET ??= "x";

const { db } = await import("../db.ts");
const { scheduleRecovery } = await import("./engine.ts");
const { selectStrategy } = await import("./strategy.ts");
const { classify } = await import("./classifier.ts");

const NOW = new Date("2026-08-25T10:00:00.000Z");

const failure = {
  payment_id: "pay_retry_probe",
  amount: 249900,
  currency: "INR",
  email: "c@example.com",
  contact: "+919876543210",
  order_id: "order_retry_probe",
};

const decision = () =>
  selectStrategy(
    classify({
      id: failure.payment_id, amount: failure.amount, currency: "INR", status: "failed",
      method: "card", error_code: "BAD_REQUEST_ERROR", error_reason: "card_declined",
    }),
    NOW,
    { learning: false, timeScale: 1 },
  );

const attempts = () =>
  (db.prepare("SELECT COUNT(*) n FROM recovery_attempts WHERE payment_id = ?")
    .get(failure.payment_id) as { n: number }).n;

before(() => {
  db.exec("DELETE FROM recovery_attempts");
  db.exec("DELETE FROM failed_payments");
  db.prepare(
    "INSERT OR IGNORE INTO failed_payments (payment_id, amount, currency, method) VALUES (?, ?, 'INR', 'card')",
  ).run(failure.payment_id, failure.amount);
});

after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(DB + suffix)) unlinkSync(DB + suffix);
  }
});

test("a retried webhook does not create a second live recovery", () => {
  scheduleRecovery(failure, decision());
  assert.equal(attempts(), 1);

  // Razorpay redelivering the same event, three more times.
  for (let i = 0; i < 3; i++) scheduleRecovery(failure, decision());
  assert.equal(attempts(), 1, "duplicate deliveries created extra recoveries");
});

test("a second attempt is allowed once the first has resolved unanswered", () => {
  // This is what maxAttempts is actually for: asking again, later, because the
  // first ask went unanswered.
  db.prepare("UPDATE recovery_attempts SET status = 'expired' WHERE payment_id = ?").run(failure.payment_id);

  scheduleRecovery(failure, decision());
  assert.equal(attempts(), 2);
});

test("the attempt cap still holds once nothing is in flight", () => {
  // instrument_rejected allows two. Both are now used, so no more.
  db.prepare("UPDATE recovery_attempts SET status = 'expired' WHERE payment_id = ?").run(failure.payment_id);

  scheduleRecovery(failure, decision());
  assert.equal(attempts(), 2, "scheduled past the strategy's attempt cap");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

/**
 * Regression test for a double-send observed in a live run.
 *
 * The dispatcher polls faster than a provider round trip completes. It selected
 * rows with status 'scheduled', then awaited the API before writing the result
 * back, so a second poll landing inside that await selected the same row again
 * and created a second live payment link for one recovery. Two links means the
 * customer can pay twice, which is the precise outcome this product exists to
 * avoid — and it left no trace, because the second send overwrote the first
 * link's URL and the row count stayed correct.
 *
 * The fix is an atomic claim. This asserts the property that makes it work:
 * a conditional UPDATE can only succeed for one of two concurrent readers.
 */

function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE recovery_attempts (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL
    );
    INSERT INTO recovery_attempts (status) VALUES ('scheduled');
  `);
  return db;
}

const claim = (db: DatabaseSync, id: number) =>
  db.prepare(
    "UPDATE recovery_attempts SET status = 'sending' WHERE id = ? AND status = 'scheduled'",
  ).run(id).changes;

test("only one of two passes can claim the same due recovery", () => {
  const db = seed();
  assert.equal(claim(db, 1), 1, "first pass should win the row");
  assert.equal(claim(db, 1), 0, "second pass must find nothing to claim");
});

test("an unclaimed row is left alone for the next pass", () => {
  const db = seed();
  db.exec("INSERT INTO recovery_attempts (status) VALUES ('scheduled')");
  claim(db, 1);
  const remaining = db.prepare(
    "SELECT COUNT(*) n FROM recovery_attempts WHERE status = 'scheduled'",
  ).get() as { n: number };
  assert.equal(remaining.n, 1);
});

test("a row already sent is never reclaimed", () => {
  const db = seed();
  db.exec("UPDATE recovery_attempts SET status = 'sent' WHERE id = 1");
  assert.equal(claim(db, 1), 0);
});

test("a row left mid-send is not silently picked up again", () => {
  // Retrying it could produce the second live payment link the claim prevents,
  // so it stays 'sending' until a human or an idempotency key resolves it.
  const db = seed();
  db.exec("UPDATE recovery_attempts SET status = 'sending' WHERE id = 1");
  assert.equal(claim(db, 1), 0);
});

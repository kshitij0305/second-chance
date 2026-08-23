import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  -- Every webhook Razorpay sends us, stored raw. We build the failure taxonomy
  -- from what actually arrives, not from what we assumed the docs said.
  CREATE TABLE IF NOT EXISTS webhook_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event       TEXT    NOT NULL,
    payload     TEXT    NOT NULL,
    source      TEXT    NOT NULL DEFAULT 'razorpay',  -- razorpay | replay | redelivery
    received_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per payment that failed and is a candidate for recovery.
  CREATE TABLE IF NOT EXISTS failed_payments (
    payment_id   TEXT PRIMARY KEY,
    order_id     TEXT,
    amount       INTEGER NOT NULL,
    currency     TEXT    NOT NULL,
    method       TEXT,
    email        TEXT,
    contact      TEXT,
    error_code   TEXT,
    error_source TEXT,
    error_step   TEXT,
    error_reason TEXT,
    description  TEXT,
    failure_class TEXT,
    evidence      TEXT,
    basis         TEXT,
    source        TEXT NOT NULL DEFAULT 'razorpay',
    failed_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per recovery attempt, including the ones that never got off the
  -- ground. An attempt that fails is a fact about the system, not log noise —
  -- if it only ever reached console.error nobody would notice it happening.
  CREATE TABLE IF NOT EXISTS recovery_attempts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id       TEXT NOT NULL REFERENCES failed_payments(payment_id),
    strategy         TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'sent',   -- scheduled | sending | sent | recovered | failed | superseded | expired
    attempt_number   INTEGER NOT NULL DEFAULT 1,
    scheduled_for    TEXT,
    explanation      TEXT,
    message          TEXT,
    message_source   TEXT,
    error            TEXT,
    payment_link_id  TEXT,
    payment_link_url TEXT,
    amount           INTEGER NOT NULL,
    sent_at          TEXT NOT NULL DEFAULT (datetime('now')),
    recovered_at     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_attempts_link ON recovery_attempts(payment_link_id);

  -- One row per (failure class, plan). The bandit's entire memory.
  CREATE TABLE IF NOT EXISTS strategy_outcomes (
    failure_class TEXT NOT NULL,
    variant       TEXT NOT NULL,
    successes     INTEGER NOT NULL DEFAULT 0,
    failures      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (failure_class, variant)
  );
`);

// Dev databases created before status/error existed keep working instead of
// forcing a delete-and-recreate.
const columns = (db.prepare("PRAGMA table_info(recovery_attempts)").all() as { name: string }[])
  .map((c) => c.name);
if (!columns.includes("status")) {
  db.exec("ALTER TABLE recovery_attempts ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'");
}
if (!columns.includes("error")) {
  db.exec("ALTER TABLE recovery_attempts ADD COLUMN error TEXT");
}

// Synthetic replays and real Razorpay traffic were landing in one table with
// nothing to separate them, so the failure taxonomy was reading invented
// payloads back as evidence. Rows captured before this column existed cannot be
// attributed after the fact and are marked unknown rather than guessed at.
for (const [column, ddl] of [
  ["attempt_number", "ALTER TABLE recovery_attempts ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1"],
  ["scheduled_for", "ALTER TABLE recovery_attempts ADD COLUMN scheduled_for TEXT"],
  ["explanation", "ALTER TABLE recovery_attempts ADD COLUMN explanation TEXT"],
  ["message", "ALTER TABLE recovery_attempts ADD COLUMN message TEXT"],
  ["message_source", "ALTER TABLE recovery_attempts ADD COLUMN message_source TEXT"],
] as const) {
  const existing = (db.prepare("PRAGMA table_info(recovery_attempts)").all() as { name: string }[])
    .map((c) => c.name);
  if (!existing.includes(column)) db.exec(ddl);
}

for (const [column, ddl] of [
  ["failure_class", "ALTER TABLE failed_payments ADD COLUMN failure_class TEXT"],
  ["evidence", "ALTER TABLE failed_payments ADD COLUMN evidence TEXT"],
  ["basis", "ALTER TABLE failed_payments ADD COLUMN basis TEXT"],
  ["source", "ALTER TABLE failed_payments ADD COLUMN source TEXT NOT NULL DEFAULT 'razorpay'"],
] as const) {
  const existing = (db.prepare("PRAGMA table_info(failed_payments)").all() as { name: string }[])
    .map((c) => c.name);
  if (!existing.includes(column)) db.exec(ddl);
}

const eventColumns = (db.prepare("PRAGMA table_info(webhook_events)").all() as { name: string }[])
  .map((c) => c.name);
if (!eventColumns.includes("source")) {
  db.exec("ALTER TABLE webhook_events ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'");
  db.exec("UPDATE webhook_events SET source = 'unknown'");
}

export type WebhookSource = "razorpay" | "replay" | "redelivery";

export function recordWebhook(event: string, payload: unknown, source: WebhookSource): void {
  db.prepare("INSERT INTO webhook_events (event, payload, source) VALUES (?, ?, ?)")
    .run(event, JSON.stringify(payload), source);
}

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
    received_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per payment that failed and is a candidate for recovery.
  CREATE TABLE IF NOT EXISTS failed_payments (
    payment_id   TEXT PRIMARY KEY,
    order_id     TEXT,
    amount       INTEGER NOT NULL,      -- paise
    currency     TEXT    NOT NULL,
    method       TEXT,
    email        TEXT,
    contact      TEXT,
    error_code   TEXT,
    error_source TEXT,
    error_step   TEXT,
    error_reason TEXT,
    description  TEXT,
    failed_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per recovery attempt. This is the table the dashboard reads.
  CREATE TABLE IF NOT EXISTS recovery_attempts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id       TEXT NOT NULL REFERENCES failed_payments(payment_id),
    strategy         TEXT NOT NULL,
    payment_link_id  TEXT,
    payment_link_url TEXT,
    amount           INTEGER NOT NULL,
    sent_at          TEXT NOT NULL DEFAULT (datetime('now')),
    recovered_at     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_attempts_link ON recovery_attempts(payment_link_id);
`);

export function recordWebhook(event: string, payload: unknown): void {
  db.prepare("INSERT INTO webhook_events (event, payload) VALUES (?, ?)")
    .run(event, JSON.stringify(payload));
}

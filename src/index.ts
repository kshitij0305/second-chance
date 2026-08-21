import express from "express";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { webhookRouter } from "./razorpay/webhook.ts";

const app = express();

app.use("/webhooks", webhookRouter);
app.use(express.json());
app.use(express.static("public"));

app.get("/api/stats", (_req, res) => {
  const row = db.prepare(`
    SELECT COUNT(*)                                                AS attempts,
           COALESCE(SUM(status = 'recovered'), 0)                  AS recovered,
           COALESCE(SUM(status = 'failed'), 0)                     AS failed,
           COALESCE(SUM(CASE WHEN status = 'recovered'
                             THEN amount END), 0)                  AS recovered_paise
      FROM recovery_attempts
  `).get() as Record<string, number>;

  const recent = db.prepare(`
    SELECT a.payment_id, a.strategy, a.status, a.error, a.payment_link_url,
           a.sent_at, a.recovered_at, a.amount,
           f.error_code, f.error_reason, f.method,
           f.failure_class, f.evidence, f.basis, f.source
      FROM recovery_attempts a
      JOIN failed_payments f ON f.payment_id = a.payment_id
     ORDER BY a.id DESC
     LIMIT 50
  `).all();

  res.json({ ...row, recent });
});

app.listen(config.port, () => {
  console.log(`second-chance listening on http://localhost:${config.port}`);
  console.log(`webhook endpoint: POST /webhooks/razorpay`);
});

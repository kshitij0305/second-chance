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
    SELECT COUNT(*)                                              AS attempts,
           COUNT(recovered_at)                                   AS recovered,
           COALESCE(SUM(CASE WHEN recovered_at IS NOT NULL
                             THEN amount END), 0)                AS recovered_paise
      FROM recovery_attempts
  `).get() as { attempts: number; recovered: number; recovered_paise: number };

  const recent = db.prepare(`
    SELECT a.payment_id, a.strategy, a.payment_link_url, a.sent_at, a.recovered_at,
           a.amount, f.error_code, f.error_reason, f.method
      FROM recovery_attempts a
      JOIN failed_payments f ON f.payment_id = a.payment_id
     ORDER BY a.sent_at DESC
     LIMIT 50
  `).all();

  res.json({ ...row, recent });
});

app.listen(config.port, () => {
  console.log(`second-chance listening on http://localhost:${config.port}`);
  console.log(`webhook endpoint: POST /webhooks/razorpay`);
});

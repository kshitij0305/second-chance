import express from "express";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { webhookRouter } from "./razorpay/webhook.ts";
import { startDispatcher } from "./recovery/engine.ts";
import { labRouter } from "./lab/checkout.ts";
import { statsFor } from "./recovery/bandit.ts";
import { allClasses } from "./recovery/variants.ts";

const app = express();

app.use("/webhooks", webhookRouter);
app.use(express.json());
app.use(express.static("public"));

// Investigation harness, not product surface. Gated so it cannot be mounted by
// accident: it creates real orders and exists only to find out what the provider
// sends through the direct Checkout flow.
if (config.labEnabled) {
  app.use("/lab", labRouter);
}

app.get("/api/stats", (_req, res) => {
  const row = db.prepare(`
    SELECT COUNT(*)                                                AS attempts,
           COALESCE(SUM(status = 'recovered'), 0)                  AS recovered,
           COALESCE(SUM(status = 'failed'), 0)                     AS failed,
           COALESCE(SUM(status = 'scheduled'), 0)                  AS scheduled,
           COALESCE(SUM(status = 'expired'), 0)                    AS expired,
           COALESCE(SUM(status = 'sent'), 0)                       AS sent_pending,
           COALESCE(SUM(CASE WHEN status IN ('scheduled','sending','sent')
                             THEN amount END), 0)                  AS at_risk_paise,
           COALESCE(SUM(CASE WHEN status = 'recovered'
                             THEN amount END), 0)                  AS recovered_paise
      FROM recovery_attempts
  `).get() as Record<string, number>;

  const recent = db.prepare(`
    SELECT a.payment_id, a.strategy, a.status, a.error, a.payment_link_url,
           a.sent_at, a.recovered_at, a.amount, a.scheduled_for, a.attempt_number, a.explanation, a.message, a.message_source, a.excluded_method,
           a.delivered_to, a.delivered_at, a.delivery_channel, a.delivery_error,
           f.error_code, f.error_reason, f.method,
           f.failure_class, f.evidence, f.basis, f.source
      FROM recovery_attempts a
      JOIN failed_payments f ON f.payment_id = a.payment_id
     ORDER BY a.id DESC
     LIMIT 50
  `).all();

  // Flattened for the dashboard: one row per arm, ordered by class, with the
  // leading arm marked so the table reads without the reader doing arithmetic.
  const arms = allClasses().flatMap((cls) => {
    const stats = statsFor(cls);
    const total = stats.reduce((sum, a) => sum + a.observations, 0);
    if (total === 0) return [];
    const best = Math.max(...stats.map((a) => a.observations));
    return stats
      .sort((a, b) => b.observations - a.observations)
      .map((a, i) => ({
        failure_class: cls,
        variant: a.variant,
        observations: a.observations,
        rate: a.rate,
        share: total ? a.observations / total : 0,
        leading: a.observations === best && total > 0,
        first: i === 0,
      }));
  });

  res.json({
    ...row,
    time_scale: config.timeScale,
    link_provider: config.linkProvider,
    learning: config.learningEnabled,
    delivery_channel: config.deliveryChannel,
    arms,
    recent,
  });
});

app.listen(config.port, () => {
  console.log(`second-chance listening on http://localhost:${config.port}`);
  console.log(`webhook endpoint: POST /webhooks/razorpay`);
  if (config.timeScale > 1) {
    console.log(`TIME SCALE ${config.timeScale}x — strategy delays are compressed for demo`);
  }
  if (config.linkProvider === "stub") {
    console.log("LINK PROVIDER stub — payment links are fake and no Razorpay quota is used");
  }
  console.log(
    config.deliveryChannel === "email"
      ? `DELIVERY email — messages are really sent${config.deliveryRedirectTo ? `, redirected to ${config.deliveryRedirectTo}` : ""}`
      : "DELIVERY console — messages are logged, not sent",
  );
  if (config.labEnabled) {
    console.log(`LAB enabled — checkout error lab at http://localhost:${config.port}/lab`);
  }
  startDispatcher();
});

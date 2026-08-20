import { Router, raw } from "express";
import { config } from "../config.ts";
import { db, recordWebhook } from "../db.ts";
import { isValidWebhookSignature } from "./signature.ts";
import { attemptRecovery, markRecovered } from "../recovery/engine.ts";

export const webhookRouter: Router = Router();

webhookRouter.post("/razorpay", raw({ type: "application/json" }), async (req, res) => {
  const signature = req.header("x-razorpay-signature");
  if (!signature || !isValidWebhookSignature(req.body as Buffer, signature, config.webhookSecret)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const body = JSON.parse((req.body as Buffer).toString("utf8"));
  recordWebhook(body.event, body);

  // Acknowledge before doing any work. Razorpay retries on non-2xx, and a slow
  // handler turns one failed payment into several duplicate recovery links.
  res.status(200).json({ ok: true });

  try {
    await handleEvent(body);
  } catch (error) {
    console.error(`[webhook] handler failed for ${body.event}:`, error);
  }
});

async function handleEvent(body: any): Promise<void> {
  switch (body.event) {
    case "payment.failed": {
      const p = body.payload.payment.entity;
      db.prepare(
        `INSERT OR IGNORE INTO failed_payments
           (payment_id, order_id, amount, currency, method, email, contact,
            error_code, error_source, error_step, error_reason, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        p.id, p.order_id ?? null, p.amount, p.currency, p.method ?? null,
        p.email ?? null, p.contact ?? null,
        p.error_code ?? null, p.error_source ?? null, p.error_step ?? null,
        p.error_reason ?? null, p.description ?? null,
      );
      await attemptRecovery(p);
      break;
    }

    case "payment_link.paid": {
      const linkId = body.payload.payment_link.entity.id;
      const attributed = markRecovered(linkId);
      console.log(`[webhook] ${linkId} paid${attributed ? " — recovered" : " (not one of ours)"}`);
      break;
    }

    default:
      console.log(`[webhook] ignoring ${body.event}`);
  }
}

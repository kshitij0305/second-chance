import { Router, raw } from "express";
import { config } from "../config.ts";
import { db, recordWebhook, type WebhookSource } from "../db.ts";
import { isValidWebhookSignature } from "./signature.ts";
import type { RazorpayWebhookBody } from "./types.ts";
import { attemptRecovery, markRecovered, markRecoveredByOriginalPayment } from "../recovery/engine.ts";
import { toFailedPayment } from "../recovery/mapper.ts";

export const webhookRouter: Router = Router();

webhookRouter.post("/razorpay", raw({ type: "application/json" }), async (req, res) => {
  const signature = req.header("x-razorpay-signature");
  if (!signature || !isValidWebhookSignature(req.body as Buffer, signature, config.webhookSecret)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  // The only `as` cast in the pipeline. Everything downstream is typed, so a
  // field-name mismatch is a compile error rather than an undefined at runtime.
  const body = JSON.parse((req.body as Buffer).toString("utf8")) as RazorpayWebhookBody;
  // Local tooling identifies itself so synthetic payloads never get mistaken for
  // real traffic. Razorpay never sends this header, so anything without it is
  // genuine. Not a security control — the signature check is — just provenance.
  const header = req.header("x-second-chance-source");
  const source: WebhookSource =
    header === "replay" || header === "redelivery" ? header : "razorpay";
  recordWebhook(body.event, body, source);

  // Acknowledge before doing any work. Razorpay retries on non-2xx, and a slow
  // handler turns one failed payment into several duplicate recovery links.
  res.status(200).json({ ok: true });

  try {
    await handleEvent(body);
  } catch (error) {
    console.error(`[webhook] handler failed for ${body.event}:`, error);
  }
});

async function handleEvent(body: RazorpayWebhookBody): Promise<void> {
  switch (body.event) {
    case "payment.failed": {
      const entity = body.payload.payment?.entity;
      if (!entity) throw new Error("payment.failed arrived with no payment entity");

      db.prepare(
        `INSERT OR IGNORE INTO failed_payments
           (payment_id, order_id, amount, currency, method, email, contact,
            error_code, error_source, error_step, error_reason, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entity.id, entity.order_id ?? null, entity.amount, entity.currency,
        entity.method ?? null, entity.email ?? null, entity.contact ?? null,
        entity.error_code ?? null, entity.error_source ?? null,
        entity.error_step ?? null, entity.error_reason ?? null,
        entity.description ?? null,
      );

      await attemptRecovery(toFailedPayment(entity));
      break;
    }

    case "payment_link.paid": {
      const entity = body.payload.payment_link?.entity;
      if (!entity) throw new Error("payment_link.paid arrived with no payment_link entity");

      const attributed = markRecovered(entity.id);
      console.log(`[webhook] ${entity.id} paid${attributed ? " — recovered" : " (not one of ours)"}`);
      break;
    }

    case "payment.captured": {
      const entity = body.payload.payment?.entity;
      if (!entity) throw new Error("payment.captured arrived with no payment entity");

      const original = entity.notes?.recovers_payment_id;
      if (!original) {
        console.log(`[webhook] payment.captured ${entity.id} — not one of our recoveries`);
        break;
      }

      const attributed = markRecoveredByOriginalPayment(original);
      console.log(
        `[webhook] payment.captured ${entity.id} recovers ${original}` +
        (attributed ? " — RECOVERED" : " (already attributed)"),
      );
      break;
    }

    default:
      console.log(`[webhook] ignoring ${body.event}`);
  }
}

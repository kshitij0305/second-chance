import { Router } from "express";
import { getRazorpay } from "../razorpay/client.ts";
import { config } from "../config.ts";

/**
 * A test harness for finding out what the provider actually sends.
 *
 * Every failure captured so far arrived through payment links, and every card
 * failure came back with the same generic `payment_failed` regardless of which
 * documented error card was used. The published error-scenario table describes
 * the direct Checkout integration — an order created via the API and Checkout.js
 * opened against it, with no payment-link wrapper and no mock bank page in
 * front. Whether those cards produce their documented errors there is untested,
 * and it is the difference between five of seven real failures being
 * undiagnosable and most of them being diagnosable.
 *
 * This is not product surface. It exists to answer a question about the
 * provider, and it is gated so it cannot be mounted by accident.
 */

export const labRouter: Router = Router();

labRouter.post("/order", async (req, res) => {
  const amount = Number((req.body as { amount?: number })?.amount ?? 149900);
  try {
    const order = await getRazorpay().orders.create({
      amount,
      currency: "INR",
      receipt: `lab_${Date.now()}`,
      notes: { purpose: "checkout_error_investigation" },
    });
    res.json({ order_id: order.id, amount: order.amount, key_id: config.razorpayKeyId });
  } catch (error) {
    const message =
      typeof error === "object" && error !== null && "error" in error
        ? (error as { error?: { description?: string } }).error?.description
        : String(error);
    res.status(500).json({ error: message ?? "order creation failed" });
  }
});

labRouter.get("/", (_req, res) => {
  res.type("html").send(PAGE);
});

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Checkout error lab</title>
<style>
  body { font: 17px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif;
         max-width: 52rem; margin: 0 auto; padding: 2rem 1.5rem 5rem; color: #16181d; background: #f7f8fa; }
  h1 { font-size: 1.2rem; }
  p { color: #4b515b; }
  .card { background: #fff; border: 1px solid #e4e7ec; border-radius: 8px; padding: 1rem 1.15rem; margin-bottom: .6rem; }
  .num { font-family: ui-monospace, Menlo, monospace; font-size: 1.05rem; font-weight: 600; letter-spacing: .04em; }
  .why { color: #5f6570; font-size: .9rem; margin-top: .15rem; }
  button { font: inherit; font-size: .95rem; padding: .4rem .9rem; border-radius: 6px;
           border: 1px solid #0a58c2; background: #0a58c2; color: #fff; cursor: pointer; margin-top: .55rem; }
  button:disabled { opacity: .5; cursor: default; }
  .note { background: #fff6dc; border: 1px solid #e3c04a; color: #7a5c00;
          padding: .7rem .9rem; border-radius: 6px; margin-bottom: 1.5rem; font-size: .92rem; }
  #out { font-family: ui-monospace, Menlo, monospace; font-size: .85rem; white-space: pre-wrap;
         background: #fff; border: 1px solid #e4e7ec; border-radius: 8px; padding: 1rem; margin-top: 1.5rem; }
</style>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>

<h1>Checkout error lab</h1>
<p>Does the direct Checkout integration produce the documented error reasons, where
payment links only ever produce a generic <code>payment_failed</code>?</p>

<div class="note">
  Pick a card, click its button, paste the number into Checkout, use any CVV and
  any future expiry. On the bank page that follows, click <strong>Failure</strong>.
  The real payload lands in <code>webhook_events</code>; compare with
  <code>npm run taxonomy</code>.
</div>

<div id="cards"></div>
<div id="out">no attempt yet</div>

<script>
const CARDS = [
  ["4100 2800 0008 0001", "insufficient_fund", "documented: not enough balance"],
  ["4100 2800 0006 0003", "card_declined", "documented: declined by the issuing bank"],
  ["4100 2800 0009 0000", "payment_timed_out", "documented: temporary issue at the bank"],
  ["4100 2800 0000 0009", "authentication_failed", "documented: OTP or verification wrong"],
  ["4100 2800 0002 0007", "gateway_technical_error", "documented: temporary gateway outage"],
  ["4100 2800 0001 0008", "card_number_invalid", "documented: incorrect card number"],
];

const out = document.getElementById("out");
document.getElementById("cards").innerHTML = CARDS.map(([num, reason, why], i) => \`
  <div class="card">
    <div class="num">\${num}</div>
    <div class="why">expects <strong>\${reason}</strong> — \${why}</div>
    <button data-i="\${i}">Start a payment to fail with this card</button>
  </div>\`).join("");

document.getElementById("cards").addEventListener("click", async (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  const [num, reason] = CARDS[Number(button.dataset.i)];

  button.disabled = true;
  out.textContent = "creating order...";
  try {
    // Absolute. This page is served at /lab with no trailing slash, so a
    // relative "order" resolves to /order and 404s.
    const res = await fetch("/lab/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!res.ok) { out.textContent = "order request failed: HTTP " + res.status; button.disabled = false; return; }
    const data = await res.json();
    if (data.error) { out.textContent = "order failed: " + data.error; button.disabled = false; return; }

    out.textContent = "order " + data.order_id + "\\ncard to type: " + num + "\\nexpecting: " + reason +
                      "\\n\\nRemember to click Failure on the bank page.";

    const rzp = new Razorpay({
      key: data.key_id,
      amount: data.amount,
      currency: "INR",
      order_id: data.order_id,
      name: "Second Chance — error lab",
      description: "expecting " + reason,
      handler: () => { out.textContent += "\\n\\nThis one SUCCEEDED. Click Failure next time."; },
      modal: { ondismiss: () => { button.disabled = false; } },
    });

    rzp.on("payment.failed", (response) => {
      const err = response.error ?? {};
      out.textContent =
        "FAILED as intended\\n\\n" +
        "  expected error_reason : " + reason + "\\n" +
        "  actual reason         : " + (err.reason ?? "(none)") + "\\n" +
        "  actual code           : " + (err.code ?? "(none)") + "\\n" +
        "  actual source         : " + (err.source ?? "(none)") + "\\n" +
        "  actual step           : " + (err.step ?? "(none)") + "\\n" +
        "  description           : " + (err.description ?? "(none)") + "\\n\\n" +
        (err.reason === reason
          ? "MATCH — direct Checkout does produce documented errors."
          : "MISMATCH — this flow collapses the error too.");
      button.disabled = false;
    });

    rzp.open();
  } catch (error) {
    out.textContent = "error: " + error;
    button.disabled = false;
  }
});
</script>`;

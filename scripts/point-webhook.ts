import "dotenv/config";

// Quick cloudflared tunnels get a new random hostname on every start, so the
// registered webhook URL goes stale the moment the tunnel is closed. Razorpay
// then delivers payment.captured to a dead host and nothing is ever attributed —
// the payment succeeds and the row stays 'sent' forever.
//
//   npx tsx scripts/point-webhook.ts https://something.trycloudflare.com

const base = process.argv[2];
if (!base || !base.startsWith("https://")) {
  console.error("Usage: npx tsx scripts/point-webhook.ts https://<host>");
  process.exit(1);
}

const url = `${base.replace(/\/+$/, "")}/webhooks/razorpay`;
const auth = Buffer.from(
  `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`,
).toString("base64");

interface Hook { id: string; url: string; active: boolean; events: Record<string, boolean> }

const list = await fetch("https://api.razorpay.com/v1/webhooks", {
  headers: { Authorization: `Basic ${auth}` },
});
const { items = [] } = (await list.json()) as { items?: Hook[] };

if (!items.length) {
  console.error("No webhook registered. Create one in the dashboard first.");
  process.exit(1);
}

const hook = items[0]!;

// payment.captured is the primary attribution route: Razorpay copies the link's
// notes onto the payment that settles it. payment_link.paid is a second route to
// the same conclusion, and the handler is idempotent so both arriving is fine.
const events = {
  "payment.failed": true,
  "payment.captured": true,
  "payment_link.paid": true,
};

const res = await fetch(`https://api.razorpay.com/v1/webhooks/${hook.id}`, {
  method: "PUT",
  headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
  body: JSON.stringify({ url, events }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}

const updated = JSON.parse(text) as Hook;
console.log(`updated ${updated.id}`);
console.log(`url:    ${updated.url}`);
console.log(`active: ${updated.active}`);
console.log(`events: ${Object.keys(updated.events).filter((k) => updated.events[k]).join(", ")}`);

import "dotenv/config";

const auth = Buffer.from(
  `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`,
).toString("base64");

const r = await fetch("https://api.razorpay.com/v1/webhooks", {
  headers: { Authorization: `Basic ${auth}` },
});

console.log(`HTTP ${r.status}`);
const text = await r.text();

interface Hook { id: string; url: string; active: boolean; events: Record<string, boolean> }
let body: { items?: Hook[] };
try {
  body = JSON.parse(text);
} catch {
  console.log(text.slice(0, 500));
  process.exit(1);
}

const items = body.items ?? [];
if (!items.length) {
  console.log("NO WEBHOOKS REGISTERED on this account.");
  process.exit(0);
}

const NEEDED = ["payment.failed", "payment.captured", "payment_link.paid"];

for (const w of items) {
  const on = Object.keys(w.events ?? {}).filter((k) => w.events[k]);
  console.log(`\nid:     ${w.id}`);
  console.log(`url:    ${w.url}`);
  console.log(`active: ${w.active}`);
  console.log(`events: ${on.join(", ") || "(none)"}`);
  const missing = NEEDED.filter((e) => !on.includes(e));
  if (missing.length) console.log(`MISSING: ${missing.join(", ")}`);
}

import "dotenv/config";

// Test mode allows 30 payment links per account for its lifetime, and cancelling
// does not give them back. The quota is spent on creation, not on payment.
//
//   npx tsx scripts/check-links.ts

const auth = Buffer.from(
  `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`,
).toString("base64");

const r = await fetch("https://api.razorpay.com/v1/payment_links?count=100", {
  headers: { Authorization: `Basic ${auth}` },
});

if (!r.ok) {
  console.error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  process.exit(1);
}

const body = (await r.json()) as { payment_links?: Array<{ status: string }> };
const links = body.payment_links ?? [];

const byStatus: Record<string, number> = {};
for (const l of links) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;

const left = 30 - links.length;
console.log(`created ever : ${links.length} of 30`);
console.log(`remaining    : ${left}   (${Math.floor(left / 6)} more full takes)`);
console.log(`by status    : ${JSON.stringify(byStatus)}`);

# Second Chance

Recovers failed payments on Razorpay by diagnosing *why* a payment failed and
choosing how to ask for it again.

Razorpay AI Buildathon — Track 03, AI Revenue Recovery.

## The problem

Indian checkouts fail constantly: issuer downtime, UPI collect timeouts,
insufficient funds, customers dropping at OTP. Most merchants respond with a
single blind retry, or nothing at all. A card that was declined for insufficient
funds will be declined again thirty seconds later — retrying it is noise. The
same customer would very likely pay by UPI tomorrow morning.

The failure reason should determine the response. That is what this does.

## How it works

```
payment.failed webhook
        |
        v
  classify failure          why did this actually fail?
        |
        v
  select strategy           which rail, how long to wait, how many attempts
        |
        v
  policy gate               does the merchant allow this send, right now?
        |
        v
  compose + send            fresh Payment Link over the chosen channel
        |
        v
payment_link.paid webhook   attribute the recovery, feed the outcome back
```

## Status

Working: webhook ingestion with signature verification, failed-payment capture,
Payment Link generation, recovery attribution, live dashboard.

Not built yet: failure classifier, strategy selection, policy engine, channel
adapters, outcome-driven strategy weighting.

The recovery engine currently runs one hardcoded strategy. That is deliberate —
the end-to-end loop was built first so every later piece could be tested against
real webhook traffic rather than assumptions.

## Running it

Requires Node 24+ (uses the built-in `node:sqlite`, so there is nothing to compile).

```bash
npm install
cp .env.example .env    # fill in your Razorpay test-mode credentials
npm run dev
```

Razorpay needs a public URL to deliver webhooks to. Point a tunnel at port 3000
and register `https://<your-tunnel>/webhooks/razorpay` in the Razorpay dashboard
under Account & Settings > Webhooks, subscribed to `payment.failed` and
`payment_link.paid`. The webhook secret you choose there goes in `.env`.

Dashboard: http://localhost:3000

```bash
npm test        # unit tests
npm run typecheck
```

## Layout

| Path | What lives there |
|---|---|
| `src/razorpay/webhook.ts` | Webhook route, signature check, event dispatch |
| `src/razorpay/signature.ts` | HMAC verification of the raw request body |
| `src/recovery/engine.ts` | Recovery strategy and Payment Link creation |
| `src/db.ts` | SQLite schema |
| `public/index.html` | Dashboard |

## Notes on the build

`DAY-LOG.md` records what broke and how it got fixed, day by day.

Test mode only. No production credentials are used anywhere in this repo.

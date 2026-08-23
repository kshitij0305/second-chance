# Second Chance

Recovers failed payments on Razorpay by working out *why* a payment failed and
choosing how to ask again.

Razorpay AI Buildathon — Track 03, AI Revenue Recovery.

## The problem

Indian checkouts fail constantly: banks decline, gateways wobble, accounts run
dry, customers drop at OTP. Most merchants respond with one blind retry, or with
nothing at all.

A blind retry is wrong in both directions. An account with no money in it will
decline again thirty seconds later, and the customer gets a second failure
notification for their trouble. A gateway that fell over for ninety seconds would
have taken the payment on the next tap, and instead the sale is gone.

The failure reason should decide the response. That is what this does.

## How it works

```
payment.failed
      |
      v
  classify            what went wrong, and how confident can we be
      |
      v
  select strategy     how long to wait, which rail, how many attempts
      |
      v
  schedule            nothing sends immediately - see below
      |
      v
  dispatch            guarded: has the customer already paid another way?
      |
      v
payment.captured      attribute the recovery to the failure that caused it
```

**Nothing sends immediately, ever.** A customer who has just failed a payment is
often still at the checkout, retrying. A recovery link landing mid-retry risks
them paying twice, and a double charge costs far more trust than a recovery
earns. Every strategy has a delay floor, and a test asserts none can be zero.

### The strategies

| Failure class | Plan | Why |
|---|---|---|
| `transient_provider` | wait 20 min, same rail, 3 attempts | provider-side and temporary; the instrument is fine |
| `insufficient_funds` | wait 18 h, same rail, 2 attempts | the account was empty, not broken; retrying now declines again |
| `instrument_rejected` | wait 3 min, **different rail**, 2 attempts | this card will keep refusing, so waiting changes nothing |
| `authentication_abandoned` | wait 2 min, same rail, 2 attempts | customer was mid-purchase; intent decays within minutes |
| `customer_cancelled` | wait 24 h, 1 attempt | they chose to stop; a quick nudge reads as pressure |
| `unknown` | wait 30 min, same rail, 2 attempts | cannot diagnose, so do not act as though we can |

### Where a model is and is not used

Classification and strategy selection are lookup tables, deliberately. The input
is a closed vocabulary of provider error codes and the output is one of six
classes. A model would be slower, non-deterministic, impossible to unit test, and
no more accurate than a table encoding the same mapping.

The model earns its place at message composition, where the output is genuinely
open-ended — the register has to shift with the reason for the failure, and
"your bank declined this card" and "there wasn't enough balance" need very
different handling for the same customer.

Two rules make that safe. **The model never handles facts**: it is given no
amount, no link and no name, it writes a body with placeholders, and code
substitutes the real values. A model cannot misstate a number it was never
given. **The model is never load-bearing**: every failure class has a
deterministic template, and if generation is unavailable or produces something
that fails validation, the template ships. A recovery is never lost because an
inference provider was down.

Generated messages are rejected if they contain any digit outside the
placeholders, a URL of their own, an unauthorised discount, or if they exceed the
length limit. Rejections are recorded as `template_after_rejection`, so a rising
rejection rate is the signal that the model is too small for the brief rather
than something a reader has to notice by eye.

Inference runs on Groq (`openai/gpt-oss-20b` by default). The provider sits
behind a single function; swapping it touched one call site and left all 51 tests
passing unchanged, because the tests cover the validation fence rather than the
model.

## What this can and cannot demonstrate

Worth stating plainly, because it shapes what the code does.

Razorpay test mode collapses almost every card failure into one generic error.
Five different documented error-scenario cards — declined, insufficient funds,
timed out, authentication failed, and a Mastercard decline — were each failed at
a real checkout, and every captured failure came back identical on
`error_reason`. The real signal turned out to be `error_description`, which does
separate a bank decline from a temporary issue.

So of seven real captured failures, two are diagnosable and five classify as
`unknown`. That is the honest result rather than a bug: a generic card failure
genuinely cannot be told apart from an outage or a 3DS drop, and inventing a
class would mean building strategy on nothing.

The classifier therefore handles the full documented vocabulary, because
production sends it, while only part of that vocabulary can be exercised against
real data here. Every classification records whether it rests on something
`observed`, something `documented`, or something `inferred`. Every webhook
records whether it arrived from Razorpay or from local tooling. Real evidence and
synthetic fixtures can never be mistaken for one another.

`src/recovery/fixtures/observed-failures.json` holds the real captured payloads,
scrubbed of personal data. They are the only evidence in this repository that was
not invented.

## Running it

Needs Node 24+ — uses the built-in `node:sqlite`, so there is nothing to compile.

```bash
npm install
cp .env.example .env
npm run setup:secret
npm run dev
```

Fill `.env` with Razorpay test-mode credentials. `npm run setup:secret` generates
the webhook signing secret.

Razorpay needs a public URL for webhooks. Point a tunnel at port 3000 and
register `https://<tunnel>/webhooks/razorpay` under Account & Settings >
Webhooks, subscribed to `payment.failed` and `payment.captured`. The secret from
`npm run setup:secret` goes in the same form.

Dashboard: http://localhost:3000

### Developing without burning payment-link quota

Razorpay test mode allows **thirty payment links per account, ever** — cancelling
them does not give the quota back. A development loop that creates real links
will exhaust the allowance the demo needs, which is exactly what happened here.

So local work uses a stub provider: same shape, no network, no quota.

```bash
LINK_PROVIDER=stub npm run dev
```

The dashboard shows a banner whenever links are stubbed, so a stubbed run cannot
be presented as a live one. Leave it unset to create real links.

### Seeing it work without waiting a day

Real delays run from 2 minutes to 24 hours. `TIME_SCALE` divides only the
wall-clock deadline, never the strategy's stated intent, so behaviour is
identical and watchable:

```bash
TIME_SCALE=60 npm run dev
```

A 20-minute wait becomes 20 seconds. Any value above 1 puts a visible banner on
the dashboard, so a compressed run cannot be mistaken for real timing.

## Tooling

| Command | What it does |
|---|---|
| `npm run replay -- <scenario>` | fires a signed synthetic failure at the local app; `-- list` shows the scenarios |
| `npm run redeliver -- <id>` | re-posts a payload already captured in `webhook_events`, so a handler fix can be applied to traffic that already arrived |
| `npm run taxonomy` | field-by-field variance across real captured failures; `--all-sources` includes synthetic ones |
| `npm run reclassify` | re-runs classification over stored failures without repeating the webhook handler side effects |
| `npm run export-fixtures` | regenerates the scrubbed test fixtures from captured traffic |
| `npm test` / `npm run typecheck` | 51 tests, strict TypeScript |

## Layout

| Path | What lives there |
|---|---|
| `src/razorpay/webhook.ts` | webhook route, signature check, event dispatch |
| `src/razorpay/signature.ts` | HMAC verification over the raw request body |
| `src/razorpay/types.ts` | hand-written webhook payload types |
| `src/recovery/classifier.ts` | failure entity to failure class, with evidence |
| `src/recovery/strategy.ts` | failure class to a plan, with a rationale |
| `src/recovery/composer.ts` | message generation, validation and fallback |
| `src/recovery/templates.ts` | deterministic message per failure class |
| `src/razorpay/links.ts` | payment link creation, real or stubbed |
| `src/recovery/engine.ts` | scheduling, guarded dispatch, attribution |
| `src/recovery/mapper.ts` | Razorpay vocabulary to ours |
| `src/db.ts` | SQLite schema and migrations |
| `public/index.html` | dashboard |

## Known gaps

- A recovery interrupted mid-send stays in `sending` and is not retried
  automatically. The provider call may have succeeded before the crash, so
  retrying risks a second live payment link. The proper fix is an idempotency key
  on the provider call.
- Link creation is rate-limited by Razorpay and has no backoff, so a burst of
  failures — precisely the case this exists for — would fail to recover some of
  them. Those are recorded as `failed` and surfaced, not silently dropped.
- Recovery messages are composed and stored but not yet delivered to a customer.
  Dispatch creates the link, writes the message, and logs it. SMS and WhatsApp
  adapters are the next piece.
- `instrument_rejected` records the intent to steer away from the failed method
  but does not yet restrict methods on the generated link.

## Notes

`DAY-LOG.md` records what broke, day by day, and why. It is the unvarnished
version of this README.

Test mode only. No production credentials appear anywhere in this repository.

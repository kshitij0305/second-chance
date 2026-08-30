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
| `instrument_rejected` | wait 3 min, **failed method hidden on the checkout**, 2 attempts | this card will keep refusing, so waiting changes nothing |
| `authentication_abandoned` | wait 2 min, same rail, 2 attempts | customer was mid-purchase; intent decays within minutes |
| `customer_cancelled` | wait 24 h, 1 attempt | they chose to stop; a quick nudge reads as pressure |
| `unknown` | wait 30 min, same rail, 2 attempts | cannot diagnose, so do not act as though we can |

### Learning which plan works

Each hand-authored strategy is a hypothesis, not a fact. Twenty minutes for a
provider outage is a guess. So each failure class offers several defensible
plans and a Thompson-sampling bandit lets the outcomes decide between them.

Thompson sampling rather than epsilon-greedy because recovery volume is low and
outcomes are slow — a recovery scheduled eighteen hours out resolves a day later.
Epsilon-greedy explores at a fixed rate regardless of uncertainty, wasting
traffic on arms already known to be poor. Thompson sampling explores in
proportion to actual uncertainty, which is what you want when every observation
is expensive.

Successes and failures both feed back: a recovery that goes unanswered past the
expiry horizon is recorded as a failure, since a bandit that only hears about
successes learns nothing.

```bash
npm run simulate
```

Real traffic here is seven captured failures, nowhere near enough to converge.
The simulator therefore drives the mechanism against invented ground truth, and
the claim is about the machinery rather than about payments: given outcomes, does
selection find the best arm? On 3000 simulated failures it reaches 40.5% recovery
against 37.0% for fixed defaults, and finds the best arm in five of six classes —
including two where the hand-authored default was wrong.

Which class it misses varies between runs, and that variance is the point — a
single simulation is an anecdote. Repeating it says something firmer:

```bash
npm run simulate -- 3000 --repeat 12
```

Classes where the best arm leads by 10 points or more converge in every run.
Classes where two arms sit 2-3 points apart on thin traffic converge about half
the time, which is correct: there is not enough evidence to separate them, and a
system that always picked one would be overfitting.

**The learning layer is not free, and below a certain volume it loses money.**
Measured across 12 runs at each size:

| Failures | Median lift | Range across runs |
|---|---|---|
| 500 | +5.2% | −4.0% to +15.9% |
| 1,000 | +6.3% | −3.8% to +13.5% |
| 3,000 | +6.7% | −1.5% to +14.3% |
| 10,000 | +11.5% | +7.6% to +16.8% |

Exploration has a real cost, and under about ten thousand failures it can exceed
the gain — a merchant with low volume may end up worse off than with fixed
defaults. So learning is a deliberate switch rather than an always-on default:

```bash
LEARNING=off npm run dev
```

With it off, every class uses its hand-authored default and behaviour is
identical to the version before the bandit existed.

### Where a model is and is not used

Classification is split by what each mechanism is good at.

**Rules own the documented vocabulary.** A closed set of published error codes
mapped to six classes is a lookup table: faster, deterministic, unit-testable,
and correct for every input it was written for. A model there would be strictly
worse at a problem already solved. Strategy selection is a table for the same
reason.

**A model owns the tail.** What a table cannot do is read a sentence it has never
seen, and production sends plenty — a card that expired, a transaction a risk
system refused, an issuer unavailable in a region. Every one currently lands in
`unknown` and gets the conservative plan, when a human reading it would know
exactly what to do. The model is consulted only when the rules found nothing and
the description is not one of the generic strings that genuinely carry no
information; asking it what "Payment failed" means is asking it to invent a cause.

It picks from the same six classes and anything else is discarded, so it cannot
extend the vocabulary. It is never load-bearing: if it is unavailable or answers
with something unrecognised, the rules' answer stands. Adding the model can
improve a classification; it cannot break one. Every row records which mechanism
decided.

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
behind a single function; swapping it touched one call site and left every test
passing unchanged, because the tests cover the validation fence rather than the
model.

**The model size was measured, not assumed.** `npm run bench:composer` varies
only the model and whether the prompt carries examples, across 150 generations
each:

| Variant | Rejected by the validator | Cost per 1000 messages |
|---|---|---|
| 20b, plain prompt | 4.7% | $0.041 |
| 20b, few-shot | 0.7% | $0.050 |
| 120b, plain prompt | 0.0% | $0.093 |

Every rejection in every variant had the same cause: the model omitting the
amount placeholder. That is an instruction-following miss, not a capability
limit, and instruction-following misses are fixed by showing rather than by
paying. Two examples in the system prompt close almost the whole gap to a model
eight times the size, for 22% more cost instead of 130% more — and at this sample
0.7% and 0.0% are one rejection apart, which is not a distinguishable difference.

So the small model stays, with examples. The rejection rate remains the signal if
that ever stops being true.

## What this can and cannot demonstrate

Worth stating plainly, because it shapes what the code does.

Razorpay test mode collapses every card failure into one generic error, and this
was tested rather than assumed.

Through **payment links**: five different documented error-scenario cards —
declined, insufficient funds, timed out, authentication failed, and a Mastercard
decline — each failed at a real checkout. All five returned identical payloads.

Through the **direct Checkout integration**, which is the flow the published
error-scenario table actually describes: same result. Different cards, identical
`error_reason: payment_failed`, `error_source: gateway`, same description. The
harness used for that is at `src/lab/checkout.ts` and prints expected against
actual error reason for each documented card.

So there is no integration path in test mode that yields distinguishable card
errors. The real signal turned out to be `error_description`, which does separate
a bank decline from a temporary issue — but only for netbanking and wallet
failures, never for cards.

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

### Delivery

A recovery nobody receives cannot be recovered, so dispatch sends the composed
message rather than only recording it.

Nothing is sent unless `DELIVERY=email` is set — the same principle as stub
payment links, a development loop should not be able to contact a customer. With
it unset, messages are logged and the dashboard says so.

```bash
DELIVERY=email npm run dev
```

`DELIVERY_REDIRECT_TO` sends every message to one address regardless of what the
payment says, and the subject records who it was diverted from. Captured real
failures carry the email of whoever stood at that checkout, and this repository
replays those payloads routinely — during development, in the demo runner, and
whenever a handler fix is applied to traffic that already arrived. Every one of
those reaches the delivery code with a real person's address on it.

`MERCHANT_NAME` is the name the recovery is sent on behalf of. It is the From
display name and it appears in the email, and it is worth setting for a reason
that is not cosmetic — see below.

### Why an email is not the message

The composer writes for SMS: under 300 characters, link inline, no structure.
Those exact bytes were sent as an email for a while, and the result read as a
phishing attempt — because it has one's exact shape. An unfamiliar address, the
words "your payment failed", a shortened URL, and nothing else. A person reads
that as a scam and a spam filter scores it the same way, so the best-composed
message in the system was landing somewhere nobody would act on it.

Rewriting the words would not have fixed it. The mistake was treating two media
as one.

The seam that fixes it already existed for a different reason. The composer never
handles facts: it writes `{{amount}}` and `{{link}}` and code substitutes the
real values, so a model cannot misstate a number it was never given. Keeping the
unsubstituted form lets each medium decide what a fact should look like. SMS
substitutes a URL because a URL is all SMS has. Email substitutes an anchor and
puts the ask on a button, adds the amount as a stated figure rather than a phrase
inside prose, carries the payment id so an unexpected email can be tied to a real
attempt, and says in the footer that no money has been taken.

Both parts are always sent. An HTML-only message is itself a spam signal, and
some clients render only the text one.

Model-written prose ends up inside that markup, which is the one place in this
system where untrusted text meets a document that gets interpreted. It is escaped
before any markup goes near it, and there is a test that says so.

### Seeing it work without waiting a day

Real delays run from 2 minutes to 24 hours. `TIME_SCALE` divides only the
wall-clock deadline, never the strategy's stated intent, so behaviour is
identical and watchable:

```bash
TIME_SCALE=60 npm run dev
```

A 20-minute wait becomes 20 seconds. Any value above 1 puts a visible banner on
the dashboard, so a compressed run cannot be mistaken for real timing.

## Recording a walkthrough

```bash
LEARNING=off LINK_PROVIDER=stub TIME_SCALE=400 EXPIRY_HOURS=6 npm run dev
npm run demo
```

Fires a fixed five-beat sequence at a fixed pace, printing the narration for each
beat as it lands, so a walkthrough can be scripted against it and repeated
identically. `npm run demo -- --reset` clears the database between takes.

The first three beats are real captured payloads. Two of them carry an identical
`error_reason` and receive opposite strategies, which is the product in two
frames; the third cannot be diagnosed at all and says so.

`LEARNING=off` is required and the script refuses to run without it. With the
bandit active and no outcomes recorded, Thompson sampling explores at random, so
each class picks a different plan every run and the narration stops matching the
screen. The learning layer is demonstrated separately by `npm run simulate`,
where there is enough volume for it to be doing something.

## Tooling

| Command | What it does |
|---|---|
| `npm run replay -- <scenario>` | fires a signed synthetic failure at the local app; `-- list` shows the scenarios |
| `npm run redeliver -- <id>` | re-posts a payload already captured in `webhook_events`, so a handler fix can be applied to traffic that already arrived |
| `npm run taxonomy` | field-by-field variance across real captured failures; `--all-sources` includes synthetic ones |
| `npm run reclassify` | re-runs classification over stored failures without repeating the webhook handler side effects |
| `npm run export-fixtures` | regenerates the scrubbed test fixtures from captured traffic |
| `npm run simulate -- <n>` | drives the bandit against invented ground truth so learning is observable |
| `npm run demo` | scripted walkthrough at a fixed pace; `-- --reset` clears state between takes |
| `npm run bench:composer` | model size and few-shot against validator rejection rate and cost |
| `npm test` / `npm run typecheck` | 66 tests, strict TypeScript |

## Layout

| Path | What lives there |
|---|---|
| `src/razorpay/webhook.ts` | webhook route, signature check, event dispatch |
| `src/razorpay/signature.ts` | HMAC verification over the raw request body |
| `src/razorpay/types.ts` | hand-written webhook payload types |
| `src/recovery/classifier.ts` | failure entity to failure class, with evidence |
| `src/recovery/strategy.ts` | failure class to a plan, with a rationale |
| `src/recovery/variants.ts` | the candidate plans the bandit chooses between |
| `src/recovery/bandit.ts` | Thompson sampling and outcome accounting |
| `src/recovery/composer.ts` | message generation, validation and fallback |
| `src/recovery/templates.ts` | deterministic message per failure class |
| `src/razorpay/links.ts` | payment link creation, real or stubbed |
| `src/delivery/channel.ts` | sending the message, real or logged |
| `src/delivery/email.ts` | rendering the message for email rather than SMS |
| `src/recovery/engine.ts` | scheduling, guarded dispatch, attribution |
| `src/recovery/mapper.ts` | Razorpay vocabulary to ours |
| `src/db.ts` | SQLite schema and migrations |
| `public/index.html` | dashboard |

## Known gaps

- The dashboard has no authentication. It shows payment identifiers, amounts,
  customer-facing messages and live payment links to anyone who can reach the
  port — including anyone holding the tunnel URL while one is running. Fine for a
  local tool, not fine anywhere else.
- Webhook signatures prove authenticity but not freshness: a captured payload
  stays valid indefinitely and can be replayed. Duplicate deliveries no longer
  produce duplicate recoveries, but a genuine replay attack is not defended
  against. A timestamp window or event-id ledger would fix it.

- A recovery interrupted mid-send stays in `sending` and is not retried
  automatically. The provider call may have succeeded before the crash, so
  retrying risks a second live payment link. The proper fix is an idempotency key
  on the provider call.
- Link creation is rate-limited by Razorpay and has no backoff, so a burst of
  failures — precisely the case this exists for — would fail to recover some of
  them. Those are recorded as `failed` and surfaced, not silently dropped.
- Delivery is email only. SMS and WhatsApp are where Indian payment recovery
  actually happens, and neither is built.

## Notes

`DAY-LOG.md` records what broke, day by day, and why. It is the unvarnished
version of this README.

Test mode only. No production credentials appear anywhere in this repository.

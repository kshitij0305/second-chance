# Build log

What broke, what I got wrong, and how I got out. Written as it happened.

---

## Day 0 — 20 Aug

Scaffolded the spine. Decision, not a disaster: used Node 24's built-in
`node:sqlite` instead of `better-sqlite3`. `better-sqlite3` is a native module
and building it on Windows drags in MSVC build tools — a bad thing to discover
on day 1 of 14. `node:sqlite` still prints an ExperimentalWarning, which is
noisy but harmless.

Wrote the webhook signature check by hand with `node:crypto` rather than using
the SDK helper, because the raw-body requirement is the part most likely to bite
later and I wanted the failure mode in code I own. Express parses JSON by
default; if the webhook route sees a parsed-and-reserialised body the HMAC will
not match, because key order and whitespace change. So the webhook route is
mounted with `express.raw()` *before* `express.json()` is applied. Tests cover
tampered bodies and wrong secrets.

Acknowledge the webhook before doing any work — Razorpay retries on non-2xx, and
a slow handler would turn one failed payment into several duplicate links.

Open question for tomorrow: does `payment.failed` actually carry `email` and
`contact` for UPI collect failures, or only for card ones? If not, recovery for
UPI drops has no way to reach the customer and needs a different route.

Razorpay rejected my credentials with a bare `401 Authentication failed` — no
hint about which half was wrong. Turned out `key_id` was 24 characters when a
`rzp_test_` key is 23: a stray `V` had ended up at the front of the value when I
pasted it, so the file read `Vrzp_test_...`. Invisible when you skim the line.

What actually found it was counting the characters rather than reading the
string. Lesson for anything credential-shaped: compare the length first, and
`cat -A` the line so whitespace and stray bytes show up.

Worth noting the 401 was indistinguishable from a wrong secret, an expired key,
or a key from a different account. I had assumed a bad-credential error would
narrow it down. It doesn't — so verify the credential end to end with one
throwaway API call *before* wiring it into anything bigger, which is why the
probe script existed at all.

Two bugs in the first end-to-end run, and the second one is the one worth
remembering.

**The link existed but the record of it didn't.** Razorpay created a payment
link, so from the outside it looked like it worked, but `recovery_attempts` was
empty. Cause: Razorpay's payment entity calls the field `id`; my recovery
function expected `payment_id`. It got `undefined`, still fired the link request,
then `node:sqlite` refused the undefined primary key and threw — after the link
was already created at Razorpay's end.

TypeScript should have caught that at compile time and didn't, because I'd typed
the webhook handler `body: any`. `any` is contagious: every field access
downstream of it is unchecked, so the mismatch sailed through. Renaming the field
would have fixed this instance and left the hole open. Instead I wrote real types
for the webhook payloads and put the Razorpay-to-domain translation in one tested
function, so the next field that drifts is a compile error.

**I couldn't see any of it.** Both failures went to `console.error` in a terminal
I wasn't watching, which is why I reported "it worked" when it hadn't. A recovery
attempt that never goes out is the single most important thing an operator needs
to see, and a line scrolling past in a terminal is not seeing it. So attempts now
carry `status` and `error` columns and failures render on the dashboard in red.

The general lesson: don't let the only record of a failure be a log line. If the
system can fail in a way that looks like success from the outside, that failure
needs to be a row in a table.

(Third, smaller: Razorpay validates phone numbers even in test mode and rejects
recurring digits — my placeholder `+919999999999` came back as a 400. The
synthetic scenarios now use varied plausible numbers.)

First real webhook. Failed a live test-mode payment at a real checkout, and the
app picked it up, classified nothing yet, created a recovery link and recorded
the attempt. Tunnel, signature check, capture, link creation, attribution table —
all working against real Razorpay traffic rather than my replays.

Two things I got wrong on the way, and the second one is the interesting one.

The webhook subscription was too broad in one direction and missing in another.
Ticking the "Payment Events" group subscribed me to `payment.authorized` and
`payment.captured`, which I don't use, while `payment_link.paid` — which the
whole recovery attribution depends on — sits in a different group and wasn't
subscribed at all. Paying a link produced no event. Worth checking what you're
actually subscribed to rather than what you think you ticked.

Then the taxonomy. I had rewritten my synthetic fixtures to use the error reasons
from the published error-scenario table — `card_declined`, `insufficient_fund`,
`payment_timed_out` and so on — on the grounds that my earlier guesses were
wrong. Then I failed a real payment with the `card_declined` test card and the
webhook came back:

    error_code   BAD_REQUEST_ERROR
    error_reason payment_failed
    error_source gateway
    error_step   payment_authorization

Not `card_declined`, and `gateway` rather than `bank`. The documented table
describes the errors those cards are capable of producing; the mock bank page's
Failure button seems to produce a generic failure regardless of which card went
in. So the documentation was accurate and my inference from it was not.

Consequence for the design: a classifier keyed on `error_reason` alone collapses
everything into one bucket. It has to read `error_code`, `error_source`,
`error_step` and `method` together. And I can't finish the taxonomy from one
sample — I need to fail payments across several cards and methods and see which
fields actually move.

The general point, twice over now: the failure vocabulary has to be built from
captured payloads. Docs tell you what is possible, not what arrives.

Closed the loop, and the fix came from reading a payload I was ignoring.

The recovery was stuck showing as pending even after I paid the link, because
attribution was written to depend on `payment_link.paid` and that event was never
subscribed. The obvious fix was to go tick the checkbox. Before doing that I
dumped the `payment.captured` payload — an event I *was* receiving and explicitly
ignoring — and found this on it:

    notes: {"strategy":"immediate_link","recovers_payment_id":"pay_TSQXBFs5wVYVO1"}

Razorpay copies the notes from a payment link onto the payment that settles it.
I had been setting those notes since the first version of the engine purely as a
breadcrumb, without realising they came back. So the event I was throwing away
already carried the attribution.

Attribution now runs off `payment.captured` via those notes, with
`payment_link.paid` kept as a second route to the same conclusion. Both paths hit
an idempotent update guarded on `recovered_at IS NULL`, so a recovery that fires
both events is credited once. This is strictly better than what I had: it does
not depend on getting a subscription checkbox right, and it still attributes if
the customer pays the link by some route that does not raise a link event.

Also built `npm run redeliver`, which re-posts payloads straight out of
`webhook_events`. Because raw payloads are stored before any processing, a
handler fix can be applied to traffic that already arrived rather than needing
the payment reproduced — which is how the stuck recovery above got credited
without paying anything a second time. It is also how the classifier gets built:
replay real captured failures instead of inventing them.

Lesson: before adding a dependency to fix a gap, look at what you are already
receiving and discarding. The data was in hand the whole time.

Nearly published my own phone number, and the cause was a `.gitignore` pattern
that looked complete.

`.gitignore` had `*.db`, which I assumed covered the database. It does not cover
`second-chance.db-wal` or `second-chance.db-shm` — SQLite's write-ahead log and
shared-memory sidecar. In WAL mode the `.db` file can be almost empty while the
real pages sit in the `-wal` file, so what got committed was the part with the
data in it. Two commits carried captured webhook payloads containing the email
and phone number I had typed into a real test checkout, buried in a binary blob
nobody would think to open.

Found it by listing what was actually tracked before the first push, rather than
trusting the ignore file. Worth doing every time:

    git ls-files

Fixed with `*.db-*` and `*.sqlite-*` alongside `*.db`, then a `filter-branch`
pass to purge the files from all ten commits, deleting `refs/original` and
expiring the reflog afterwards — without that last part the old objects are still
sitting there and the rewrite is theatre.

The timing is the whole lesson. The repo had never been pushed, so the rewrite
cost about a minute. After a public push it would not have been recoverable in
any meaningful sense: GitHub retains unreachable objects, forks keep their own
copies, and scrapers do not wait. A leak is cheap to fix only in the window
before anyone else has a copy, and that window closes on the first push.

Same session, same principle applied twice: check what you are actually shipping,
not what you believe you configured.

Hit `429 Too many requests` creating seven payment links in a loop — Razorpay
rate-limits link creation, and five in quick succession was enough to trip it.

That matters more than it first looks. The recovery engine creates one payment
link per failed payment, and the situation it exists for is precisely a burst:
an issuer goes down and two hundred checkouts fail inside a minute. The engine
would then hit the rate limit and fail to recover exactly the failures it was
built for. Recovery capacity collapses at the moment it is most needed.

Current behaviour is at least not silent — the attempt is recorded with
`status = 'failed'` and the error text, so the dashboard shows it. But there is
no retry and no pacing.

Fix, when I get to the strategy work: link creation goes through a queue with
rate limiting and exponential backoff on 429, and a failed attempt becomes
retryable rather than terminal. Recovery is not latency-critical — a link sent
ninety seconds later is worth the same as one sent immediately — so throttling
costs nothing here.

Two findings, and the second one changes the plan.

First, my own instrumentation was lying to me. Synthetic replays were being
written into `webhook_events` alongside real Razorpay traffic with nothing to
distinguish them, so the first run of the taxonomy script reported
`insufficient_funds` and `incorrect_otp` as observed failure reasons. Both were
invented by my own replay script. Neither has ever appeared in real traffic. I
was reading my fixtures back as evidence and would have built a classifier around
vocabulary that does not exist.

Fixed by tagging provenance: local tooling now sends an `x-second-chance-source`
header, so the table records whether a row came from Razorpay, the replay script,
or a redelivery, and the taxonomy counts only real traffic by default. Rows
captured before the column existed cannot be attributed after the fact — I
backfilled the ones I could account for from session history and would otherwise
have had to discard them.

Second, and worse: test mode cannot produce varied card failures. I failed five
payments with five different documented error-scenario cards — declined,
insufficient funds, timed out, authentication failed, and a Mastercard decline —
confirmed genuinely distinct by the `last4` on each payment. All five came back
identical:

    BAD_REQUEST_ERROR | gateway | payment_authorization | payment_failed

Every field constant. The mock bank page's Failure button produces a generic
failure and overrides whatever card went in, at least through the payment-link
flow. Whether the direct Checkout integration behaves differently is untested.

So the premise of the whole product — that the failure reason should determine
the response — cannot be demonstrated with data collected this way. Options are
to test the direct Checkout flow, to vary the method instead (UPI and netbanking
at least move `method`), or to build the classifier against the documented
vocabulary and drive it with clearly-labelled synthetic fixtures while noting
that real test-mode traffic collapses to a single shape.

Probably the last, honestly stated, plus whatever variance UPI and netbanking
give. A classifier that handles a vocabulary it can only partly observe is a
normal engineering situation; pretending the observation was richer than it was
would not be.

Collection finished: seven real failures across card, netbanking and wallet.
UPI turned out to be disabled on the account, which is why the checkout showed no
UPI option — found by querying the enabled payment methods rather than guessing
at the UI.

    card        | BAD_REQUEST_ERROR | gateway | payment_authorization | payment_failed  x5
    netbanking  | BAD_REQUEST_ERROR | bank    | payment_authorization | payment_failed  x1
    wallet      | BAD_REQUEST_ERROR | issuer  | payment_authorization | payment_failed  x1

Three distinct combinations, which looks like useful variety until you notice
that `error_source` maps one-to-one onto `method`. Card is always `gateway`,
netbanking always `bank`, wallet always `issuer`. It is not an independent
dimension, it is `method` restated. Treating those as two features would mean
building a classifier that looks like it discriminates on two signals while
actually keying on one.

`error_code`, `error_step` and `error_reason` never moved across any of the seven.

So the observable signal in test mode is `method`, and nothing else. Five
different documented error cards produced identical payloads; only changing the
payment method moved anything.

What that means for the build. The classifier has to consume the full documented
failure vocabulary, because production will send it, while only one dimension of
that vocabulary can be exercised against real data here. That gap gets stated
rather than hidden: real captured failures prove the method dimension, and
clearly-labelled synthetic fixtures exercise the rest, with the provenance column
keeping the two apart so neither is ever mistaken for the other.

Strategy differentiation in the demo will therefore be driven by method, which is
defensible on its own merits — a netbanking failure genuinely does suggest bank
downtime and a later retry, while a card decline suggests switching rails. It is
a smaller claim than "we diagnose why every payment failed", and it is one the
data actually supports.

## Day 1

Built the classifier, and nearly built it on the wrong field.

Yesterday I concluded that `method` was the only observable signal, because
`error_reason` reads `payment_failed` for every real failure. That conclusion was
wrong, and the reason it was wrong is that my analysis script never looked at
`error_description`. When I exported the captured failures as test fixtures the
descriptions were sitting right there:

    card        "Payment failed"
    netbanking  "...declined by the bank. Try another payment method..."
    wallet      "...due to a temporary issue. Any debited amount will be refunded..."

Razorpay keeps `error_reason` generic and puts the actual meaning in
`error_description`. Those two descriptions imply opposite strategies — one says
this instrument will not work, try another; the other says wait, it was
temporary. A classifier keyed on `error_reason` collapses them into one bucket
and gets the strategy backwards half the time.

The lesson is not "read the description". It is that my analysis tool decided
what the data contained. It printed five fields, I read five fields, and I
concluded the sixth did not exist. An instrument that quietly omits a dimension
is worse than no instrument, because it produces a confident wrong answer instead
of an obvious gap.

The classifier is a lookup table, deliberately, and this is the place I most
expected to reach for a model and did not. The input is a closed vocabulary of
provider error codes and the output is one of six classes. A model would be
slower, non-deterministic, impossible to unit test, and no more accurate than a
table that encodes exactly the same mapping. The model earns its place at message
generation, where the output is genuinely open-ended and the input is a customer,
an amount and a language.

Every classification carries the grounds it was reached on — observed, documented
or inferred — because most of this vocabulary has never been seen arriving. On
real traffic that produces five `unknown (observed)` for cards, one
`instrument_rejected (observed)` for netbanking, one `transient_provider
(observed)` for wallet. Five unknowns out of seven looks like a bad result and is
the correct one: a generic card failure genuinely cannot be told apart from an
outage or a 3DS drop, and inventing a class would mean building strategy on
nothing.

Two things this shook out. The provenance problem reappeared one table over —
synthetic replays were sitting in `failed_payments` unmarked, exactly as they had
been in `webhook_events`, so the same fix had to be applied again. And
`reclassify` initially reported "10 failures" on a run that processed 7, which is
precisely the class of quietly-wrong instrumentation that caused the
`error_description` miss in the first place.

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

## Day 3

Built strategy selection, and it immediately produced the exact bug the product
exists to prevent.

The strategy table maps each failure class to a plan: how long to wait, whether
to steer away from the failed instrument, how many attempts are allowed. A dead
card gets a different rail in three minutes because waiting changes nothing. An
empty account waits until the next morning because retrying an empty account
just declines again. A provider blip keeps the same rail and waits twenty
minutes. Abandoned authentication gets the fastest re-offer available, because
intent decays in minutes.

One rule applies to every class: nothing sends instantly. A customer who has just
failed a payment is often still at the checkout retrying, and a recovery link
arriving mid-retry risks them paying twice. A double charge costs far more trust
than a recovery gains, so even the hottest-intent case waits. There is a test
asserting no strategy can ever have a zero delay.

Then the dispatcher double-sent.

Running the lifecycle end to end, one payment produced two live payment links.
The dispatcher polls every couple of seconds; it selected rows with status
`scheduled`, then awaited the provider call before writing the result back. A
second poll landing inside that await saw the same row still marked `scheduled`
and sent it again. Read-then-write with an await in the middle, no claim.

Two things make this worse than an ordinary race. The failure mode is precisely
what the delay floor above was designed to prevent — two live links means the
customer can pay twice — so the design was defeated one layer below where it was
reasoned about. And it left no trace: the second send overwrote the first link's
URL, so the row count stayed correct and the data looked perfectly healthy. I
only caught it because the dispatch log printed the same payment id twice.

Fixed with an atomic claim: a conditional `UPDATE ... WHERE id = ? AND status =
'scheduled'` before anything slow, proceeding only if it changed a row. Two
concurrent readers cannot both win a single atomic statement. There is also an
in-flight guard against overlapping passes, but that is an optimisation — the
claim is the correctness guarantee, and the tests assert the claim, not the
guard. Re-verified under deliberately harsher settings than the ones that
triggered it: 120x compression, one-second polling, four concurrent recoveries,
one link each.

Left deliberately unfixed: a recovery interrupted mid-send stays in `sending` and
is never retried automatically. The provider call may have succeeded before the
crash, so retrying risks the second live link again. Doing this properly needs an
idempotency key on the provider call. Guessing is worse than surfacing it, so it
warns on boot and waits for a human.

Also added time compression for the demo. Real delays run from two minutes to
twenty-four hours, which is correct and unwatchable in a five-minute video.
`TIME_SCALE` divides only the wall-clock deadline, never the strategy's stated
intent, and any value above 1 puts a visible banner on the dashboard so a
compressed run can never be mistaken for real timing.

## Day 3, later

Message composition, which is the one place in this system a model belongs, and
two constraints found the hard way.

The design rule is that the model writes prose and code owns facts. It is handed
no amount, no link and no customer name — it writes a body containing
placeholders, and code substitutes the real values afterwards. A model cannot
misstate a number it was never given. On top of that, a validator rejects
anything containing a digit outside the placeholders, a URL of its own, an
unauthorised discount, or over the length limit. Rejections fall back to a
deterministic template and are recorded as such, so a rising rejection rate
becomes a measurable signal that the model is too small for the brief rather than
something someone has to notice by eye.

The model is also never load-bearing. Every failure class has a template, and if
generation is unavailable the template ships. A recovery must not be lost because
an inference provider was down.

That structure paid for itself immediately. The credits turned out to be on a
Claude Code plan rather than an API account, so the provider had to change.
Swapping the entire inference provider touched one function and left all 51 tests
passing unchanged — because the tests cover the validation fence and the
templates, neither of which know which model wrote the words.

The second constraint was self-inflicted and more instructive. Dispatch started
failing with "test mode limit of 30 reached for payment_link". Razorpay allows
thirty payment links per test account for its entire lifetime, and cancelling
them does not return the quota — verified by cancelling one and immediately
failing to create another.

Every local test run, every replayed scenario, every end-to-end check had been
creating real payment links. Development quietly consumed a finite resource that
the demo depends on, and the account ran dry mid-build with the video still
unrecorded.

The fix is a stub link provider: same shape, no network, no quota, and a banner
on the dashboard whenever links are stubbed so a stubbed run cannot be passed off
as a live one. The rule worth keeping is that a development loop should never
consume a resource the demonstration needs. This should have been the first thing
built, not the thing built after running out.

First real generation attempt returned nothing at all. Every message fell back to
a template with the rejection reason `empty`.

`gpt-oss-20b` reasons before answering, and that reasoning is billed against the
same completion budget as the answer. I had set `max_completion_tokens: 300`,
sized for a 300-character message. The model spent 298 tokens thinking, hit the
length limit, and returned an empty string. Two budgets that look like one: the
token budget covers reasoning plus output, while the character limit only
constrains output.

Setting `reasoning_effort: "low"` took reasoning from 298 tokens to 7. Writing two
sentences from a brief that is already supplied requires no deliberation.

The failure is worth noting for how quiet it was. Nothing errored, nothing
retried, no alert fired — messages simply came out as templates, which is a
perfectly good outcome and would have looked like the model working fine if I had
not checked the source field. The fallback that makes the system robust is also
what would have hidden the model being completely broken. Recording *which*
source produced each message is what made it visible.

Then the measurable part earned its keep. First run: 33% of generations rejected,
every one for omitting the amount placeholder. Rewrote the prompt to state the
placeholder requirement up front and say plainly that a message without both is
discarded. Second run: 11%, same single cause. That is a real quality dial with a
number on it, rather than reading a few samples and forming an impression.

## Day 3, learning layer

Thompson sampling over candidate plans per failure class, with outcomes feeding
back.

The choice of algorithm was the one real decision. Epsilon-greedy is the obvious
default and is wrong here: it explores at a fixed rate regardless of how
uncertain it actually is, which wastes traffic on arms already known to be poor
while under-exploring ones barely tried. Recovery volume is low and outcomes are
slow — a recovery scheduled eighteen hours out resolves a day later — so every
observation is expensive and exploration should be proportional to uncertainty.
That is exactly what Thompson sampling does.

Two things that turned out to matter more than the sampler.

An untried arm has to read as unknown rather than as bad. A Beta(1,1) prior puts
it at 0.5; starting arms at zero would mean the first one to get lucky is never
challenged again.

And the bandit has to hear about failures, not just successes. Recoveries are
only marked when someone pays, so without an expiry horizon every arm looks
perfect and nothing is ever learned. A sent recovery that goes unanswered past
the horizon is now resolved as a failure, and the horizon scales with TIME_SCALE
alongside the delays so a compressed demo resolves outcomes at the compressed
rate rather than never.

Three tests were failing after the rewiring, all correctly: they asserted a fixed
plan per class, which stopped being true the moment selection became stochastic.
The fix was to make selection options explicit parameters rather than reading
config, so a test can pin learning off and assert exact scheduling, while a
separate test asserts that with learning on the choice stays inside the declared
arms and still respects the no-instant-send floor. That floor check now runs over
every candidate arm rather than the defaults — an arm the bandit could learn into
would otherwise bypass the safety rule entirely.

On 3000 simulated failures: 40.5% recovered against 37.0% for fixed defaults, and
the best arm found in five of six classes, including two where my hand-authored
default was wrong. The default for transient failures was twenty minutes; the
data preferred five.

It fails on the sixth class and that failure is worth keeping in the demo.
`customer_cancelled` carries 3% of traffic and its two arms differ by three
percentage points. There is not enough evidence there to distinguish them, the
bandit does not distinguish them, and a version that confidently picked one would
be overfitting. Reporting that honestly is better than tuning the simulation
until every class looks solved.

The ground truth in the simulator is invented, and the script says so at the top
and in its output. It demonstrates that the selection mechanism finds the best
arm given outcomes. It does not demonstrate which recovery plan is best in the
real world. Those are different claims and only the first is being made.

Then I measured whether the learning layer is actually worth having, and the
answer is: not always.

One simulation is an anecdote. The first 3000-failure run found the best arm in
five of six classes; the next found six of six. Same code, same settings. So I
added a repeat mode that runs the whole simulation many times and reports how
often each class converges, rather than reporting whichever result came up.

That pattern is stable: classes where the best arm leads by ten points or more
converge every run, and classes where two arms sit two or three points apart on
thin traffic converge about half the time. Half is the correct answer there —
there is not enough evidence to separate them, and a version that always picked
one would be overfitting.

The more useful number came from varying the traffic volume, twelve runs each:

      500 failures   median +5.2%   range  -4.0% to +15.9%
     1000 failures   median +6.3%   range  -3.8% to +13.5%
     3000 failures   median +6.7%   range  -1.5% to +14.3%
    10000 failures   median +11.5%  range  +7.6% to +16.8%

Exploration costs something, and below roughly ten thousand failures that cost
can exceed the gain. A merchant with low volume may end up worse off than with
fixed defaults. A single 1000-round run I did by hand came out at -1.1%, which is
not noise but the expected behaviour at that size.

I would not have found this by looking at one run and seeing +10%. The temptation
with a learning layer is to run it once, get a good number, and put that number
in the pitch. The honest version needed a distribution rather than a sample, and
the distribution says something more useful than the sample did: this feature
should be a deliberate switch, not an always-on default, and it should not be
turned on for a merchant who does not have the volume to pay for the exploration.

That is now what the code does and what the README says.

Added a guard to the simulator, and it immediately caught a real bug in the thing
it was guarding.

`strategy_outcomes` records no provenance — a simulated outcome and a real one
are identical once written. So the simulator now refuses to run against a
database containing real recovery attempts, and tells you to point it at a
scratch file instead.

The first time I ran it, the guard fired on a run I expected to succeed. Not a
false positive. The script began with:

    import "dotenv/config";
    process.env.DB_PATH ??= "./simulation.db";

dotenv loads `.env` first and does not override variables already set, so
`DB_PATH` was already `./second-chance.db` by the time the default ran and `??=`
did nothing. Every simulation I had run had been writing invented outcomes
directly into the working database. Checking it: fifteen arm rows holding several
thousand fabricated observations, and not one real recovery among them. The
bandit's entire memory in the live database was fiction.

Assignment is now unconditional, with `SIM_DB` as the only way to redirect it,
and the contaminated table has been cleared.

Three things about this are worth keeping.

The bug was invisible from the outside. The simulator printed correct-looking
results either way, because it clears the outcomes table before each run — so it
always reported a clean experiment while leaving the debris in whichever database
it happened to be pointed at.

`??=` reads as "use this default" but means "only if nothing else set it", and
what set it was an import three lines above. The two lines were written minutes
apart and the interaction between them was invisible in either one alone.

And this is the third time in this build that mixing real and synthetic data has
caused a problem: synthetic webhooks counted as real evidence in the taxonomy,
synthetic failures unmarked in `failed_payments`, and now fabricated outcomes in
the live bandit. Each time the fix was provenance — recording where data came
from — and each time I applied it only to the table that had just burned me
rather than to the pattern. The guard is the first fix that generalises, and it
only exists because I finally treated it as a recurring problem rather than three
separate accidents.

## Day 5

Built a scripted demo runner so a walkthrough can be recorded without typing
commands between sentences, and it exposed a conflict between two things that
were each correct on their own.

The script fires a fixed sequence with fixed gaps and prints the narration for
each beat. The first dry run contradicted itself: the narration said "the fastest
re-offer the safety floor allows" while the dashboard showed
`reoffer_after_the_dust_settles`, the slower arm.

Not a bug. That is the bandit doing its job. With no outcomes recorded, Thompson
sampling explores at random, so every class picks a different plan on every run.
Correct behaviour for a learning system, and fatal for a scripted walkthrough,
where the same command has to produce the same screen every time.

Trying to have both would have meant either seeding fake outcomes so the bandit
"chooses" the intended arm — inventing evidence to make a demo look good, which
is the thing I have spent this whole build avoiding — or writing narration vague
enough to be true whatever it picked, which would have thrown away the specificity
that makes the walkthrough worth watching.

So the demo runs with learning off, the script refuses to start otherwise, and
the dashboard shows a LEARNING OFF banner throughout. The learning layer gets
demonstrated separately by the simulator, where it has the volume to actually be
learning rather than guessing. Two demonstrations of two different claims, rather
than one demonstration quietly making both look like the same thing.

Verified: five beats, five classes, five plans, matching the narration exactly,
repeatably.

Closed a gap that was worse than an unfinished feature: a claim the system made
about itself that was not true.

The `instrument_rejected` strategy carries `avoidFailedMethod: true`, the README
described it as "different rail", and I had written it into the demo narration as
"switch rails". What the code actually did was set the flag, append the words
"steering away from the failed method" to an explanation string, and then create
a payment link identical to every other payment link. The customer could switch
method because the link offered all of them, but nothing steered them anywhere.
The intent existed only as text.

That is a specific kind of bad. An unfinished feature is visible in the Known
Gaps list. A feature that describes itself in the audit trail, in the docs and in
the demo, while doing nothing, is the system lying about its own behaviour — and
the explanation string made it read as though it had happened.

Razorpay payment links do support this: `options.checkout.method` takes booleans
per method. Checked the API rather than guessing at the shape, since this was
going into the video.

One rule matters in the implementation. Only ever hide one method, and only if
the checkout recognises it. A recovery link with everything disabled cannot be
paid at all, which turns a recovery attempt into a dead end — strictly worse than
not steering. Methods the checkout cannot toggle, like paylater or nach, are
ignored rather than passed through, because an unrecognised key could restrict
nothing or everything depending on how the provider reads it, and sending no
options is predictable. There are tests for both.

Verified end to end: the real captured netbanking failure now produces a link
with netbanking hidden, and nothing else in the sequence is restricted.

The general lesson is about where intent gets recorded. This system explains
every decision it makes, which is a good property, and it meant a decision that
was never carried out still appeared in the audit trail as though it had been.
Explanations should be generated from what happened, not from what was planned.

Turned a judgement in the README into a measurement.

The README asserted that a small model was the right size for message
composition. That was reasoning, not evidence, and it is exactly the kind of
claim a panel should push on. So I benchmarked it: same prompt, same validator,
same failure classes, varying only the model and whether examples are supplied.
150 generations per variant.

    20b, plain prompt    4.7% rejected   $0.041 per 1000 messages
    20b, few-shot        0.7% rejected   $0.050
    120b, plain prompt   0.0% rejected   $0.093

The useful part is not which won. It is that every rejection in every variant had
the same cause — the model omitting the amount placeholder — and that tells you
what kind of problem it is. An instruction-following miss is not a capability
limit, and paying eight times more per token to fix one is the wrong lever. Two
examples in the prompt closed almost the entire gap for 22% more cost rather than
130% more.

The metric mattered as much as the result. Validator rejection rate is not a
stylistic opinion about prose; a rejected message is one the system refused to
send because it fabricated a figure or dropped a placeholder, and the template
went out instead. That made "is the bigger model better" answerable without
anyone reading messages and forming an impression.

Two smaller things. A first run at 48 generations per variant showed 4.2% against
0.0% — two rejections against none, which is not a result. Rerunning at 150
turned it into something defensible, and the numbers barely moved, which is
itself reassuring. And that first run showed the few-shot variant at 3.5 seconds
median against 617ms, which I flagged as possibly noise rather than asserting;
at the larger sample all three variants land within 100ms of each other. It was
noise. Worth having said so at the time rather than building an argument on it.

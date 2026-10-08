# Second Chance

[![CI](https://github.com/kshitij0305/second-chance/actions/workflows/ci.yml/badge.svg)](https://github.com/kshitij0305/second-chance/actions/workflows/ci.yml)

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
only the model and whether the prompt carries examples twice, across 72
generations per variant:

| Variant | Rejected by the validator | Cost per 1000 messages |
|---|---|---|
| 20b, current prompt | 1.4% | $0.052 |
| 20b, examples twice | 0.0% | $0.061 |
| 120b, current prompt | 0.0% | $0.121 |

One rejection against none is not a difference to act on, and the larger model
asks double the price and 200ms more latency to deliver it. The small model
stays.

Every rejection has the same cause: the model omitting the amount placeholder.
That is an instruction-following miss, not a capability limit, which is why two
examples in the system prompt were worth more than eight times the parameters —
an earlier run of this benchmark measured 4.7% without them and is the reason
they are there.

Those earlier figures are not comparable to the ones above, and the reason is
worth stating. The benchmark did not send the steering instruction, which every
real dispatch does, so every number it had ever printed described a prompt one
line shorter than the live one. It also alternated a customer name that
production never supplies, and for a while gated that alternation on the same
expression as the steering branch — so two variables moved together and neither
was isolated. A benchmark measuring something adjacent to the system is worse
than no benchmark, because the number it prints gets believed.

Rejections also concentrate rather than spread. Sampled on its own,
`instrument_rejected` with the steering branch rejects around 10-20%; across six
classes that dilutes to the 1.4% above. The rejection rate remains the signal if
the small model ever stops being enough.

## What the validator cannot see

The fence is mechanical, and that is the whole of its reach. It counts
characters, looks for two placeholders, and rejects any digit, URL or discount
the model invented. Every one of those is a string operation.

So this ships:

> Sorry, your account didn't have enough balance to cover {{amount}}. You can
> try again here: {{link}}

Both placeholders, no stray digits, no URL, well under the limit. Four checks,
four passes.

It is also the one thing the brief for `insufficient_funds` forbids. That class
says to be tactful and not state the reason outright, and this states it in the
first six words. The reason is a guess, too — Razorpay reports an error code,
never a balance, and the shortfall could as easily have been a card limit or a
daily cap. The message puts an inference about a stranger's money in writing and
gets it past every check the system has.

That failure is invisible to a regex and obvious to anyone who reads it. So is a
message that tells a UPI customer nothing is wrong with their card, or one that
suggests switching payment method when the plan hid nothing. They are all the
same shape: the words are well-formed and the meaning is wrong.

Everything below is about catching that.

### The golden set is the whole input space

A hand-written set of examples is a sample, and a sample has gaps nobody can
name. This one has no gaps, because there is very little to sample.

Four things reach the model: the payment method, the class's `INTENT` string, the
steering line, and the customer's first name or a note that there isn't one. That
is the entire prompt. The amount and the link never appear in it — the model
writes `{{amount}}` and `{{link}}` and code substitutes afterwards — so varying
them tests nothing. Ten cases differing only in amount are ten copies of one case.

That leaves six classes, four payment methods, and name or no name. The cases are
generated by a loop over exactly that, so no cell can be forgotten and adding a
fifth method is one word rather than twenty-four more hand-copied blocks.

Forty-eight cells, then. Forty-eight was wrong, and how it was wrong is the
useful part. Steering — whether the message points the customer at a different
method — was assumed to follow from the failure class. It does for five of them.
`unknown` has three strategy arms, one of which steers away from the failed
instrument while the other two do not, so the bandit can send either kind of
message. Reading that flag off the strategies instead of assuming it per class
gives `unknown` sixteen cells and the set fifty-six.

The steering bug already recorded in `templates.ts` — an `unknown` failure
telling someone to try a different method when nothing had been hidden — lives in
exactly the eight cells the assumption would have skipped.

### Claims are written once

A case does not carry an example of the right output. For open-ended text there
is no single right output — a hundred messages could all be acceptable — so a
case carries the bar instead, as claims the message has to clear.

Claims sit at the level they belong to, and each is written in exactly one place.

**Universal** claims hold for every message the composer will ever write: both
placeholders present, a way to pay offered, the customer never criticised, no
name invented that was not supplied.

**Class** claims die the moment the failure class changes. `insufficient_funds`
must never name the reason; `transient_provider` must say the problem is
temporary and attribute it to the provider. The test for placement is exactly
that question — would this still be true for a different class?

**Input-dependent** claims follow what the composer was handed rather than which
class it was. There are two. A message is required to address the customer by
name when a name was given, and forbidden from suggesting a different payment
method unless the plan actually hid the failed one — the same claim, with its
polarity taken from the steering flag.

**Case** claims are nearly always empty, which is correct. They exist to pin a
specific known failure to the input that produced it, so a bug that has been
fixed can never come back quietly.

Two of those arrangements were wrong first. The name rule began as a single claim
reading "uses the name if one is given, and never invents one if not" — two
branches joined by a conjunction, and the judge only ever answered the first, so
all four no-name cases failed a rule they satisfied. It is now a universal
prohibition on inventing a name, plus a case-level requirement on the four cases
that have one. And the rule against suggesting another method was filed under
`insufficient_funds`, where it looked at home, because that class never steers.
It is not a property of the class at all. It follows the flag.

### The judge, and how it is checked

Each claim is one call. Fifty-six messages at roughly nine claims each is 516
judgements per run, at temperature zero with the response format pinned to JSON,
so the same input gives the same verdict and parsing cannot drift.

The judge is never told whether a claim is required or forbidden. It answers one
question — is this property present in this message — and the code decides what
that means:

```ts
const pass = kind === "must" ? answer === "yes" : answer === "no";
```

Tell a model that a rule is a prohibition and it will tell you what you want to
hear. Asking neutrally and deciding polarity afterwards removes the chance.

It reads the message before substitution, since the claims are about `{{amount}}`
and `{{link}}`, and it is given the input the composer was given — the method,
and whether there was a name — because a judge that cannot see the input cannot
tell an invented name from a supplied one.

Judging runs on `openai/gpt-oss-120b` where the composer runs on `openai/gpt-oss-20b`.
A model scores its own output higher than a stranger's.

None of which proves the judge works. A judge that answered "pass" to everything
would have produced the same clean run. So six messages were written to be wrong,
each in one specific way, and fed through as a control: one names the reason
outright, one uses a banned word, one steers when it should not, one drops the
link, one invents a name, one implies the customer was short of money without
using any word on the banned list.

Writing them is harder than it sounds, because each has to break exactly one
claim. Take the link out and the message also stops offering a way to pay — those
two are coupled by construction, and that shows up as a double failure every
time. The method that works is to start from a message that passes and change one
phrase.

All six were caught. The one that matters is the last: *once you've topped up,
you can try again here* contains no banned word, and a regex would wave it
through. `npm run judge:planted` exits non-zero on any miss.

### What runs automatically, and what deliberately does not

Two workflows, split by whether a failure means anything.

`ci.yml` gates every push and pull request: `npm run typecheck` and 98 unit
tests, on a pinned runner, installed with `npm ci` from the lockfile. No API key,
no network, same answer every time. That is the entry fee for blocking a merge —
a check that can fail on a coin flip teaches you to re-run it instead of reading
it, which is worse than having no check.

Wiring it up immediately found a bug it was built to find. The test script's glob
was unquoted, so on Linux `sh` expanded `src/**/*.test.ts` itself, collapsed it to
one directory level, and dropped `src/auth.test.ts` — the eight tests covering
the gate in front of the dashboard, which serves customer addresses and every
composed message. The suite would have reported 90 of 98 green and nobody would
have looked. Quoting it hands the glob to node, which matches both depths on
every platform.

`eval.yml` runs `judge:planted` daily at 02:00 UTC and on demand, and never
blocks anything. It wants a secret, so it cannot run on a fork's pull request,
and temperature zero narrows the variance without removing it. It is a drift
detector, not a gate — the model behind the judge can change under you, and a
daily control run is how you find out. The results file is gitignored, so the
run uploads it as an artifact, on failure especially.

It started on a weekly cron for a bad reason worth recording: the token
arithmetic came from the wrong script. `npm run judge` is 492 judgements, most
of a day's free tier. `judge:planted` is six messages at nine claims — about 54
calls, a tenth of the tier. Those are different budgets and only one of them
argues for spacing runs out. Daily also survives GitHub dropping a scheduled run,
which it does silently on free repos under load; a weekly job that gets skipped
goes blind for two weeks. Scheduled runs are best-effort either way — the first
one here fired almost six hours late.

The full `npm run judge` stays manual, because that budget is real and because
it is a measurement rather than a pass/fail.

### What it found, and what it cannot tell you

The first full run found four bugs, all of them in the claims and none in the
composer. The name rule with two branches was one. `customer_cancelled` was
another and worse: it demanded the message say the customer cancelled while a
universal rule forbade blaming them, so every one of its eight cases failed one
or the other and no message could have satisfied both. That universal rule now
reads "criticises the customer", which is what was meant.

The second run found a bug in the product. Four `transient_provider` messages
reassured the customer that nothing was wrong with their card — on netbanking,
wallet and UPI payments. The phrase "card or account" was sitting in two `INTENT`
strings and in both few-shot examples, and the model copied it regardless of what
had actually failed. `bench:composer` had never seen it because it only ever
tested `method: card`. Rewriting the prompt and making one example a netbanking
failure took those claims to zero failures and the run total from 32 to 21.

Two claims were then deleted rather than satisfied. Both asked for something no
`INTENT` requested — that an `unknown` message announce the cause could not be
determined, that a `cancelled` message name who cancelled — so the model never
complied and the claim was measuring an intention nobody had stated.

That left five failures in 492, down from 32. Three were one claim — three of
eight `customer_cancelled` messages never said in so many words that there is no
obligation to pay. The other two were the judge being wrong: it read "this method
will likely keep failing", which `instrument_rejected` explicitly requires, as
criticism of the customer, and it split hairs over whether a message saying a
payment stopped at verification states that verification did not complete.

Those two claims were then reworded, and the agreement work below is what
diagnosed them. `states that the verification step did not complete` turned on a
synonym — raters divided over whether "the verification step failed" satisfies
"did not complete" — and on which of two things had failed to complete, since
"did not complete due to a verification step" is about the payment. It now reads
`says the payment stopped at a verification or authentication step`.

`makes clear there is no obligation to pay` was worse. "Makes clear" describes
what a reader concludes, and the judge is told to answer only what is true of the
message as written, so the claim asked for the one inference the prompt forbids.
In practice it was answerable only when the composer happened to use the words:
on "there is no obligation to pay" three independent raters agreed, on "if you
wish to proceed" they split three ways. It measured the generator's explicitness
rather than the message, and now reads `says that paying is optional or that no
action is required`.

**Two failures in 492 immediately after the rewording, and the accounting is not "rewording fixed
three".** The verification claim went to zero over eight cases and that one is
genuinely fixed. `criticises the customer` also went to zero — but every
`instrument_rejected` message in the run still says "will keep declining", the
exact phrasing that tripped it before, so that is the intermittent tension
failing to fire rather than a fix. The two remaining failures are the obligation
claim, and they are real: six of eight `cancelled` messages say paying is
optional and two say only "No issue on your side" or nothing at all. The same
2-to-3-of-8 gap appeared under the old wording, which is what makes it the
product rather than the rubric.

### Then the judge was caught inferring

Planting a failure in every class — the six originals were all
`insufficient_funds`, so a green control said nothing about the other five —
found a miss within minutes. A `transient_provider` message said "an issue on the
provider side" with nothing about duration, against the claim `says the problem
is temporary`. The judge answered yes and gave its reason as "implying it is
temporary", while its own prompt told it to judge the text in front of it and not
what it assumed the sender meant. The same miss reproduced identically in CI
seventeen hours later, so it was a property of the judge, not a flake.

Two sentences were added to the judge's prompt, and the first matters as much as
the second: a message may satisfy a statement in different words, but it has to
say it — implication, consistency and what a reader would assume do not count,
and if the reason would use the word "implying" the answer is no. Without the
first half the judge overcorrects into literalism and "No obligation to proceed"
stops satisfying `says that paying is optional`. The control then caught 11 of 11.

Re-judging the same 56 messages with only the prompt changed moved three
verdicts, all from pass to fail. The first read of those was that the claims were
overreaching, and checking the `INTENT` they come from killed that idea:

> Their bank refused this payment method **and will keep refusing it**. Tell them
> **plainly** that the payment method they used will not go through, and steer
> them to a different payment method.

Two of the three are `says this payment method will keep being refused` against
messages reading "will **likely** keep declining" and "will **likely** be declined
again". The claim encodes the `INTENT` exactly; the `INTENT` asks for plainness
and names the permanence; the model hedges anyway. Whether a flat assertion about
a bank's future behaviour is the right thing to promise is a fair question about
the `INTENT` — but it is a product question, and until it is answered the claim is
right and the composer is not following it.

The third is `leaves the option open to pay later` against "No issue on your side.
You can retry the same method here". `customer_cancelled`'s `INTENT` says to leave
the option open, and a message can say so outright — "no rush", "whenever suits
you". This one says nothing about later at all.

So all three are the product, not the rubric, and the stricter judge is what made
them visible. That puts the run at five failures in 492, up from two, which is
the right direction: the judge had been passing messages it should not have.

The direction is the point. The card wording was the product's fault and the
prompt changed; the claims above were the eval's fault and the eval changed. An
eval that always blames the thing under test is as useless as one that never
does.

What it cannot tell you yet:

- **One human rater, and he is the one who wrote the claims.** The agreement
  number below rests on 100 labels from a single person who could not un-know
  what each rule was for. A second independent rater is the missing control, and
  the two disagreements suggest exactly why.
- **The control covers one failure class of six.** All six planted failures are
  `insufficient_funds`, so a green `judge:planted` says the judge catches
  violations of that class's claims and nothing about the other five. Neither
  reworded claim can be validated by it at all.
- **The judge is not independent.** Same model family as the composer, one size
  up. Better than self-grading, short of a real second opinion.
- **One run a day.** About 180,000 tokens against a 200,000 daily free tier. One
  run hit the ceiling at 110 judgements and lost all of them, because results are
  written after the loop rather than as they arrive.
- **One claim is in tension with another.** `instrument_rejected` requires the
  message to say the method will keep being refused, and a universal rule forbids
  criticising the customer. The judge treated the first as a breach of the second
  once in eight cases. It is the `customer_cancelled` contradiction again, firing
  intermittently rather than always, and it has not been resolved.

### How well the judge agrees with a human

A run of the eval was frozen — 56 messages and the 492 judgements over them — and
100 of those judgements were labelled by hand, blind. `npm run label` derives its
claim list from `cases.ts` and never opens the judge's output, so there is no
path by which a verdict reaches the screen. It also withholds whether a claim is
required or forbidden, because the judge is not told either, and it shows the
rater the judge's own system prompt. Two raters answering differently worded
questions disagree about the question, not the message.

`npm run kappa` scores the result on both of the scales available, and they do
not agree with each other:

```
Rating the raw answer                Rating pass/fail
  observed agreement   98.0%           observed agreement   98.0%
  expected by chance   50.7%           expected by chance   98.0%
  kappa                0.959           kappa                0.000
  prevalence index     0.120           prevalence index     0.980
```

Same 100 items, same two raters, same 98% agreement. One scale says almost
perfect and the other says indistinguishable from guessing.

Both are arithmetically correct. On the pass/fail scale 98 of 100 items land in
one category, so two raters who rubber-stamped everything would agree 98% of the
time by construction; there is no headroom above chance and kappa divides by
nothing. That is the paradox Feinstein and Cicchetti described in 1990, and it is
the reason percent agreement is not worth quoting on its own.

The raw answer avoids it for a reason that was not designed in. Because the judge
is asked "is this property present" and never told the polarity, `mustNot` claims
are correctly answered *no* — so the answers split 45/55 even though the outcomes
split 98/2. Hiding polarity was meant to stop the model telling us what we wanted
to hear. It also happens to be what makes this measurable.

**The two disagreements are the more useful result, and the judge won both.** One
message contained no name at all and was marked as inventing one; another said
"nothing is wrong with your wallet" and was marked as blaming the user. Both are
`mustNot` claims, both errors run the same direction, and both are the human
answering "is this rule satisfied" instead of "is this property present". The
polarity hiding that protects the model does not protect the person who wrote the
rules and cannot un-know what they are for.

So 0.959 is a floor rather than a ceiling, and it is one rater's floor. The honest
reading is that the judge is at least as careful as the person who specified it,
on a sample where that person made two mistakes and it made none.

A kappa that high invites the question of whether it is resting on items where
one answer was never in doubt, and it partly is. Seven claims got the same human
answer every time, covering 58 of the 100 labels — every message offers a way to
pay, none criticises the customer, because the prompt forbids it and the model
complies. Those are agreement without discrimination. `npm run kappa` finds them
from the data rather than from a list, and recomputes without them:

```
everything                     n=100  po=98.0%  pe=50.7%  kappa=0.959
without the invariant claims   n= 42  po=95.2%  pe=57.1%  kappa=0.889
only the four biggest claims   n= 67  po=98.5%  pe=57.5%  kappa=0.965
only the long tail             n= 33  po=97.0%  pe=59.0%  kappa=0.926
```

Strip out every claim where the answer was a foregone conclusion and 42 items
remain at 0.889. Lower, as it should be, and still high.

A third rater was then run as an experiment — `npm run label:model`, which asks a
model from a different family the same 100 questions. Qwen3.8-27b against the
judge's gpt-oss-120b:

```
human vs judge (gpt-oss-120b)        po= 98.0%  kappa=0.959
human vs qwen3.8-27b                 po= 98.0%  kappa=0.959
judge vs qwen3.8-27b  [model-model]  po=100.0%  kappa=1.000
```

The two models agreed on all 100 items, and both disagreed with the human on
exactly the same two — the two described above. So those two are corroborated by
independent raters rather than by one person's second look, and no claim in the
sample was read two ways by two unrelated families, which is a real check on the
rubric's wording.

It changes the single-rater caveat less than it appears to. A kappa of 1.000
between two models is equally the signature of correlated error: models trained
on overlapping text can share a reading no human would reach, and perfect
agreement is the absence of detectable disagreement rather than evidence of
correctness. The only rater who disagreed with anything is still the one human,
and he wrote the claims.

The more actionable result is that a 27b model matched a 120b exactly. A run is
492 judgements and most of a day's free tier, so if that holds over the full set
the judge is over-specced — which is a cost question worth testing properly
rather than inferring from a hundred items.

It is also worth saying what number would have been suspicious. The published
LLM-as-judge agreement figures in the 0.6 to 0.8 range come from open-ended
preference ranking over free-form answers. This asks a binary presence question
about a 300-character message produced under a prompt that forbids most of the
ways it could go wrong. Narrow task, formulaic text, little room to read two
ways. A middling kappa here would be evidence the claims were ambiguous, not
evidence of rigour.

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

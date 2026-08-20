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

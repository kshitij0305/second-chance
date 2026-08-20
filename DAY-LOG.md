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

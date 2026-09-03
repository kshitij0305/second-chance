import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRecipient, subjectFor } from "./channel.ts";
import { config } from "../config.ts";

// Recipient resolution is the part of delivery that can do real harm. Captured
// failures carry the address of whoever was at that checkout, and this repo
// replays those payloads constantly — every replay reaches this code with a real
// person's address on it.

const withRedirect = (to: string, fn: () => void) => {
  const original = config.deliveryRedirectTo;
  (config as { deliveryRedirectTo: string }).deliveryRedirectTo = to;
  try { fn(); } finally { (config as { deliveryRedirectTo: string }).deliveryRedirectTo = original; }
};

test("a configured redirect wins over the address on the payment", () => {
  withRedirect("me@example.com", () => {
    const resolved = resolveRecipient("a.real.customer@gmail.com")!;
    assert.equal(resolved.to, "me@example.com");
    assert.equal(resolved.redirected, true);
  });
});

test("a redirect applies even when the payment carries no address", () => {
  withRedirect("me@example.com", () => {
    const resolved = resolveRecipient(null)!;
    assert.equal(resolved.to, "me@example.com");
    // Nothing was diverted from anyone, so this is not a redirect to announce.
    assert.equal(resolved.redirected, false);
  });
});

test("redirecting to the same address is not reported as a redirect", () => {
  withRedirect("me@example.com", () => {
    assert.equal(resolveRecipient("me@example.com")!.redirected, false);
  });
});

test("without a redirect, mail goes to the address on the payment", () => {
  withRedirect("", () => {
    const resolved = resolveRecipient("customer@example.com")!;
    assert.equal(resolved.to, "customer@example.com");
    assert.equal(resolved.redirected, false);
  });
});

test("no address and no redirect means nowhere to send, not a guess", () => {
  withRedirect("", () => {
    assert.equal(resolveRecipient(null), null);
  });
});

test("the subject carries the amount and applies no pressure", () => {
  const subject = subjectFor("₹2,749");
  assert.match(subject, /₹2,749/);
  assert.ok(!subject.includes("!"));
  assert.ok(!/urgent|hurry|last chance|expires|act now/i.test(subject));
});

test("the subject never discloses why the payment failed", () => {
  // A subject shows up on a lock screen. The insufficient_funds message is
  // written specifically not to tell its recipient why it failed; leaking that
  // into a notification would tell everyone standing near them instead.
  //
  // Structurally it cannot happen — subjectFor takes an amount and no failure
  // class — and this test exists so that adding one is a deliberate act.
  const subject = subjectFor("₹2,749");
  for (const word of ["declined", "insufficient", "balance", "expired", "bank", "rejected", "cancelled"]) {
    assert.ok(!subject.toLowerCase().includes(word), `subject discloses "${word}"`);
  }
});

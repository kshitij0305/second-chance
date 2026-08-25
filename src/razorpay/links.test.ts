import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutMethods } from "./links.ts";

/**
 * The `instrument_rejected` strategy says to steer the customer away from the
 * method that just failed. For most of this build that intent reached nothing
 * but an explanation string — the flag was set, the sentence was appended, and
 * the link created was identical to every other link. These tests exist so that
 * cannot silently become true again.
 */

test("no exclusion means no restriction at all", () => {
  // The common case sends no options, so the customer sees every method the
  // account supports.
  assert.equal(checkoutMethods(undefined), undefined);
  assert.equal(checkoutMethods(""), undefined);
});

test("the failed method is hidden and the others stay available", () => {
  const methods = checkoutMethods("card")!;
  assert.equal(methods.card, false);
  assert.equal(methods.netbanking, true);
  assert.equal(methods.upi, true);
  assert.equal(methods.wallet, true);
});

test("every toggleable method can be the one excluded", () => {
  for (const method of ["card", "netbanking", "upi", "wallet"]) {
    const methods = checkoutMethods(method)!;
    assert.equal(methods[method], false, `${method} was not hidden`);
  }
});

test("exactly one method is ever hidden", () => {
  // A link with everything disabled cannot be paid, which turns a recovery
  // attempt into a dead end — worse than not steering at all.
  for (const method of ["card", "netbanking", "upi", "wallet"]) {
    const methods = checkoutMethods(method)!;
    const available = Object.values(methods).filter(Boolean).length;
    assert.equal(available, 3, `excluding ${method} left ${available} methods`);
    assert.ok(available > 0);
  }
});

test("a method the checkout cannot hide is ignored rather than guessed at", () => {
  // paylater, nach, emi and friends are real methods but not toggleable here.
  // Sending an unrecognised key could restrict nothing or everything depending
  // on how the provider reads it; sending no options at all is predictable.
  for (const method of ["paylater", "nach", "emi", "cardless_emi", "nonsense"]) {
    assert.equal(checkoutMethods(method), undefined, `${method} should be ignored`);
  }
});

test("method names are matched case and whitespace insensitively", () => {
  // The value comes from a provider payload, not from our own vocabulary.
  assert.equal(checkoutMethods(" Card ")!.card, false);
  assert.equal(checkoutMethods("NETBANKING")!.netbanking, false);
});

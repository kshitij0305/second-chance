import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { isValidWebhookSignature } from "./signature.ts";

const SECRET = "whsec_test";
const body = Buffer.from(JSON.stringify({ event: "payment.failed" }));
const sign = (b: Buffer, s = SECRET) => createHmac("sha256", s).update(b).digest("hex");

test("accepts a signature produced with the shared secret", () => {
  assert.equal(isValidWebhookSignature(body, sign(body), SECRET), true);
});

test("rejects a signature made with a different secret", () => {
  assert.equal(isValidWebhookSignature(body, sign(body, "wrong"), SECRET), false);
});

test("rejects when the body was altered after signing", () => {
  const signature = sign(body);
  const tampered = Buffer.from(JSON.stringify({ event: "payment.captured" }));
  assert.equal(isValidWebhookSignature(tampered, signature, SECRET), false);
});

test("rejects a malformed signature without throwing on length mismatch", () => {
  assert.equal(isValidWebhookSignature(body, "abc", SECRET), false);
});

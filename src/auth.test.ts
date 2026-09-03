import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { dashboardAuth } from "./auth.ts";
import { config } from "./config.ts";

// The dashboard and /api return customer addresses and every composed message.
// These assert the gate in front of them, including that it is genuinely closed
// when a password is set.

const withPassword = (value: string, fn: () => void) => {
  const original = config.dashboardPassword;
  (config as { dashboardPassword: string }).dashboardPassword = value;
  try { fn(); } finally { (config as { dashboardPassword: string }).dashboardPassword = original; }
};

function run(authorization?: string) {
  const req = { headers: authorization ? { authorization } : {} } as Request;
  let status = 0;
  let passed = false;
  const res = {
    set() { return res; },
    status(code: number) { status = code; return res; },
    type() { return res; },
    send() { return res; },
  } as unknown as Response;

  dashboardAuth(req, res, () => { passed = true; });
  return { passed, status };
}

const basic = (user: string, pass: string) =>
  "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

test("with no password configured the gate is open", () => {
  // Deliberate: a laptop demo should not need credentials. The startup warning
  // is what makes this a choice rather than an oversight.
  withPassword("", () => assert.equal(run().passed, true));
});

test("a correct password gets through", () => {
  withPassword("hunter2", () => assert.equal(run(basic("admin", "hunter2")).passed, true));
});

test("the username is not checked, only the password", () => {
  withPassword("hunter2", () => assert.equal(run(basic("anyone", "hunter2")).passed, true));
});

test("a password containing a colon survives the split", () => {
  // Basic auth joins user and password with ":", so splitting on the first one
  // is the only correct read. Splitting on the last would truncate this.
  withPassword("a:b:c", () => assert.equal(run(basic("admin", "a:b:c")).passed, true));
});

test("a wrong password is refused", () => {
  withPassword("hunter2", () => {
    const { passed, status } = run(basic("admin", "wrong"));
    assert.equal(passed, false);
    assert.equal(status, 401);
  });
});

test("a password that is a prefix of the real one is refused", () => {
  withPassword("hunter2", () => assert.equal(run(basic("admin", "hunter")).passed, false));
});

test("no header at all is refused when a password is set", () => {
  withPassword("hunter2", () => {
    const { passed, status } = run();
    assert.equal(passed, false);
    assert.equal(status, 401);
  });
});

test("a non-Basic scheme is refused", () => {
  withPassword("hunter2", () => assert.equal(run("Bearer hunter2").passed, false));
});

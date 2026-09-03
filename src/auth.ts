import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { config } from "./config.ts";

// The dashboard and /api/stats return customer email addresses, payment ids,
// amounts and every composed message. That was served to anyone who could reach
// the port, and this gets run behind a public tunnel during development.
//
// Not applied to /webhooks — the provider calls that and it authenticates with
// an HMAC signature over the raw body instead.

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Compare against a fixed-length digest-ish pair so length alone doesn't leak
  // through an early return.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const dashboardAuth: RequestHandler = (req, res, next) => {
  const expected = config.dashboardPassword;
  if (!expected) return next();

  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (safeEqual(password, expected)) return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="Second Chance", charset="UTF-8"');
  res.status(401).type("text/plain").send("Authentication required.\n");
};

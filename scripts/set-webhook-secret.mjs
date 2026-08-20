/**
 * Generates a webhook signing secret and writes it into .env.
 *
 * Exists as a script rather than a shell one-liner because the quoting differs
 * between PowerShell, cmd and bash, and getting it wrong writes a mangled secret
 * that fails signature checks in a way that looks like a code bug.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const KEY = "RAZORPAY_WEBHOOK_SECRET";

if (!existsSync(".env")) {
  console.error("No .env here. Run this from the project root, after copying .env.example to .env.");
  process.exit(1);
}

const existing = readFileSync(".env", "utf8");
const current = existing.match(new RegExp(`^${KEY}=(.*)$`, "m"))?.[1];

if (current && !process.argv.includes("--force")) {
  console.log(`${KEY} is already set (${current.length} chars). Pass --force to replace it.`);
  console.log("Replacing it means re-entering the new value in the Razorpay dashboard.");
  process.exit(0);
}

const secret = "whsec_" + randomBytes(16).toString("hex");
const updated = new RegExp(`^${KEY}=.*$`, "m").test(existing)
  ? existing.replace(new RegExp(`^${KEY}=.*$`, "m"), `${KEY}=${secret}`)
  : `${existing.trimEnd()}\n${KEY}=${secret}\n`;

writeFileSync(".env", updated);
console.log(`${KEY} written to .env (${secret.length} chars).`);
console.log("Paste the same value into the Razorpay webhook form when you set up the tunnel.");

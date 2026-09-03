import Razorpay from "razorpay";
import { config } from "../config.ts";

// Constructed on first use, not at import. This was a module-level constant, and
// the SDK throws on an empty key_id — so importing anything that reached this
// file needed real credentials. A fresh clone couldn't load its own tests, and
// the "missing env var" check never ran, because ES imports evaluate first. The
// startup error was an SDK stack trace instead of the sentence written to
// explain what was missing.
let client: Razorpay | null = null;

export function getRazorpay(): Razorpay {
  client ??= new Razorpay({
    key_id: config.razorpayKeyId,
    key_secret: config.razorpayKeySecret,
  });
  return client;
}

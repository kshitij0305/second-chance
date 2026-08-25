import Razorpay from "razorpay";
import { config } from "../config.ts";

/**
 * The Razorpay client, constructed on first use rather than at import.
 *
 * It used to be a module-level constant. The SDK throws if `key_id` is empty, so
 * merely importing anything that transitively reached this file required real
 * credentials — which meant a clone of this repository could not load its own
 * link tests, and the server's own "missing env var" check never ran, because ES
 * imports are evaluated before any statement in the importing module.
 *
 * The result was a repository whose startup error was a stack trace from inside
 * a vendored SDK rather than the sentence written specifically to explain what
 * was missing.
 */
let client: Razorpay | null = null;

export function getRazorpay(): Razorpay {
  client ??= new Razorpay({
    key_id: config.razorpayKeyId,
    key_secret: config.razorpayKeySecret,
  });
  return client;
}

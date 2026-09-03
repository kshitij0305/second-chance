import type { FailureClass } from "./classifier.ts";

// Not a placeholder for the model — the floor it writes above. Every send has a
// correct message available with no network call, and this is what ships when a
// generated one fails validation.

export interface MessageContext {
  /** Customer's first name, if we have one worth using. */
  name?: string | null;
  /** The payment method that failed, in customer-facing words. */
  method: string;
  /** Formatted amount, e.g. "₹2,749". Rendered by code, never by the model. */
  amount: string;
  /** The recovery payment link. */
  link: string;
}

// Also the model's brief, so generated and fallback versions say the same thing.
export const INTENT: Record<FailureClass, string> = {
  transient_provider:
    "The failure was on the payment provider's side and temporary. Reassure them nothing is wrong with their card or account, and invite them to try the same way again.",
  insufficient_funds:
    "The account did not have enough balance. Be tactful — do not state the reason outright, do not imply anything about their finances. Simply invite them to complete the payment when convenient.",
  instrument_rejected:
    "Their bank refused this payment method and will keep refusing it. Tell them plainly that this card or account will not go through, and steer them to a different payment method.",
  authentication_abandoned:
    "They were partway through paying and the verification step did not complete. Be brief and low-friction — they were seconds from done.",
  customer_cancelled:
    "They chose to cancel. Be light and unpushy, make clear there is no obligation, and leave the option open.",
  unknown:
    "The cause could not be determined. Do not speculate about why it failed. Keep it short and simply offer a way to complete the payment.",
};

// Without this the message drifts from the decision — an unknown failure once
// said "try a different payment method" while the plan had hidden nothing.
export function steeringInstruction(steerToAnotherMethod: boolean): string {
  // Both branches say what to tell the customer, never what the system did.
  // This used to open with "The failed payment method has been hidden on the
  // checkout", which the model treated as copy and put in a customer's inbox:
  // "The card is hidden from checkout." Removing it fixed that, 0 of 20.
  //
  // It did not change the rejection rate, which was the other hypothesis:
  // 2 of 20 before, 4 of 20 after — one number at that sample, not two. Why
  // this branch drops the amount placeholder more than the others is still open.
  return steerToAnotherMethod
    ? "Tell them to pay by a different method."
    : "Tell them the same payment method should work, and do not suggest switching.";
}

const BODIES: Record<FailureClass, (c: MessageContext) => string> = {
  transient_provider: (c) =>
    `${greet(c)}your ${c.amount} payment didn't go through — that was a temporary issue on the payment provider's side, not anything to do with your ${c.method}. You can try again here: ${c.link}`,

  insufficient_funds: (c) =>
    `${greet(c)}your ${c.amount} payment didn't complete. Whenever suits you, you can finish it here: ${c.link}`,

  instrument_rejected: (c) =>
    `${greet(c)}your bank declined the ${c.amount} payment on that ${c.method}, and it's likely to decline again. Here's a link where you can pay by another method instead: ${c.link}`,

  authentication_abandoned: (c) =>
    `${greet(c)}looks like the ${c.amount} payment didn't finish at the verification step. Here's a fresh link, it only takes a moment: ${c.link}`,

  customer_cancelled: (c) =>
    `${greet(c)}you left a ${c.amount} payment unfinished. No rush and no obligation — the link is here if you want it: ${c.link}`,

  unknown: (c) =>
    `${greet(c)}your ${c.amount} payment didn't go through. You can complete it here: ${c.link}`,
};

export function renderTemplate(failureClass: FailureClass, context: MessageContext): string {
  return BODIES[failureClass](context);
}

function greet(c: MessageContext): string {
  return c.name ? `Hi ${c.name}, ` : "Hi — ";
}

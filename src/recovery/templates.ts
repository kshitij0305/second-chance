import type { FailureClass } from "./classifier.ts";


export interface MessageContext {
  name?: string | null;
  method: string;
  amount: string;
  link: string;
}

export const INTENT: Record<FailureClass, string> = {
  transient_provider:
    "The failure was on the payment provider's side and temporary. Reassure them nothing is wrong with the payment method they used, and invite them to try the same way again.",
  insufficient_funds:
    "The account did not have enough balance. Be tactful — do not state the reason outright, do not imply anything about their finances. Simply invite them to complete the payment when convenient.",
  instrument_rejected:
    "Their bank refused this payment method and will keep refusing it. Tell them plainly that the payment method they used will not go through, and steer them to a different payment method.",
  authentication_abandoned:
    "They were partway through paying and the verification step did not complete. Be brief and low-friction — they were seconds from done.",
  customer_cancelled:
    // Was "make clear there is no obligation, and leave the option open", which
    // the model honoured about three times in four — it would say the payment
    // was cancelled and offer a retry without ever saying either thing. Both
    // halves are now instructions to say something rather than to convey it.
    "They chose to cancel. Be light and unpushy. Say that paying is optional, and say they can come back to it later.",
  unknown:
    "The cause could not be determined. Do not speculate about why it failed. Keep it short and simply offer a way to complete the payment.",
};

// Without this the message drifts from the decision — an unknown failure once
// said "try a different payment method" while the plan had hidden nothing.
export function steeringInstruction(steerToAnotherMethod: boolean): string {
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

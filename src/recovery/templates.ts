import type { FailureClass } from "./classifier.ts";

/**
 * Deterministic message bodies, one per failure class.
 *
 * These are not a placeholder for the model — they are the floor the model
 * writes above. A recovery must never fail to go out because an LLM was slow,
 * rate-limited, misconfigured or unavailable, so every send has a correct
 * message available without any network call at all.
 *
 * They are also the reference the model is judged against: if a generated
 * message fails validation, this is what ships instead.
 *
 * Deliberately free of amounts, dates and offers. Those are facts, and facts are
 * assembled by code — see `composer.ts`.
 */

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

/**
 * What each message must convey, given what went wrong. Also handed to the model
 * as the brief, so the generated and fallback versions say the same thing.
 */
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

/**
 * Tells the model what the strategy actually decided about the payment method.
 *
 * Without this the message drifts from the decision. An `unknown` failure was
 * observed producing "please try a different payment method" while the chosen
 * plan had explicitly not steered anywhere and hidden nothing on the checkout —
 * not false, since every method was still available, but the message described
 * an action the system never took.
 *
 * The same shape of mistake as `avoidFailedMethod` describing itself in an
 * explanation string without doing anything. Both times the fix is the same:
 * words about a decision have to be generated from the decision.
 */
export function steeringInstruction(steerToAnotherMethod: boolean): string {
  // Both branches say what the message should tell the customer. Neither states
  // what the system did, and that distinction is not stylistic.
  //
  // The steering branch used to open with "The failed payment method has been
  // hidden on the checkout." The model treated it as copy rather than context
  // and put it in a customer's inbox — "The card is hidden from checkout" — which
  // is an internal detail nobody paying a bill needs. Removing the sentence
  // removed the leak: 0 of 20 generations mentioned it afterwards, against a
  // reproducible occurrence before.
  //
  // It did not change how often the validator rejects a message. That was the
  // hypothesis — an irrelevant fact competing for a small model's attention,
  // costing it the amount placeholder — and the measurement did not support it:
  // 2 of 20 before, 4 of 20 after, which at this sample size is one number, not
  // two. Why this branch drops the placeholder more than the others is still
  // open, and `npm run bench:composer` is where to settle it.
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

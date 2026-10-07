import type { FailureClass } from "../recovery/classifier.ts";
import type { MessageContext } from "../recovery/templates.ts";
import type { ComposeOptions } from "../recovery/composer.ts";

export interface PlantedCase {
  id: string;
  failureClass: FailureClass;
  context: MessageContext;
  options: ComposeOptions;
  template: string;
  breaks: string;
}

export const PLANTED: PlantedCase[] = [
    {
    id: "inappropiate-msg-case",
    failureClass: "insufficient_funds",
    context: {
        link: "https://rzp.io",
        method: "upi",
        amount: "₹850"
    },
    options: { steerToAnotherMethod: false },
    template: "your payment of {{amount}} failed because there wasn't enough money in your account. Please try again here {{link}}.",
    breaks: "states or implies the payment failed for lack of money"
    },
    {
    id: "banned-word-case",
    failureClass: "insufficient_funds",
    context: {
        link: "https://rzp.io",
        method: "upi",
        amount: "₹850"
    },
    options: { steerToAnotherMethod: false },
    template: "you have insufficient balance to complete this transaction of {{amount}}. Please try again here {{link}}.",
    breaks: "uses the words balance, funds, or insufficient"
    },
    {
    id: "steer-to-another-method-case",
    failureClass: "insufficient_funds",
    context: {
        link: "https://rzp.io",
        method: "upi",
        amount: "₹850"
    },
    options: { steerToAnotherMethod: false },
    template: "your payment of {{amount}} could not be processed. Please try again or use a different payment method {{link}}.",
    breaks: "suggests switching to a different payment method"
    },
    {
    id: "name-error",
    failureClass: "insufficient_funds",
    context: {
        link: "https://rzp.io",
        method: "upi",
        amount: "₹850"
    },
    options: { steerToAnotherMethod: false },
    template: "Hi Rahul, the transaction of {{amount}} failed. Please try again later here {{link}}.",
    breaks: "invents a customer name that was not provided"
    },
    {
    id: "no-link-case",
    failureClass: "insufficient_funds",
    context: {
        link: "https://rzp.io",
        method: "upi",
        amount: "₹850"
    },
    options: { steerToAnotherMethod: false },
    template: "the payment of {{amount}} couldn't be completed, please try again later",
    breaks: "contains the {{link}} placeholder"
    },
    {
    id: "roundabout-case",
    failureClass: "insufficient_funds",
    context: {
        link: "https://rzp.io",
        method: "upi",
        amount: "₹850"
    },
    options: { steerToAnotherMethod: false },
    template: "you transaction of {{amount}} couldnt be completed, once you've topped up, you can try again here {{link}} ",
    breaks: "states or implies the payment failed for lack of money"
    },
    // One per failure class from here down. The six above are all
    // insufficient_funds, so a green run said the judge catches violations of
    // that class's claims and nothing at all about the other five.
    //
    // Each starts from a message that passed in a real eval run and changes one
    // phrase, which is the only method that reliably breaks exactly one claim.
    {
    id: "not-temporary-case",
    failureClass: "transient_provider",
    context: {
        link: "https://rzp.io",
        method: "card",
        amount: "₹1,200"
    },
    options: { steerToAnotherMethod: false },
    // "a temporary issue on the provider side" with the word temporary removed.
    // Attribution to the provider rides on "on the provider side" and survives;
    // only the temporariness goes.
    template: "Hi, the {{amount}} payment did not go through due to an issue on the provider side. Nothing is wrong with your card. You can try the same card again here: {{link}}",
    breaks: "says the problem is temporary"
    },
    {
    id: "no-bank-named-case",
    failureClass: "instrument_rejected",
    context: {
        link: "https://rzp.io",
        method: "card",
        amount: "₹2,400"
    },
    options: { steerToAnotherMethod: true },
    // Drops the bank as the actor and keeps the permanence. Doing it the other
    // way round — removing "will keep being refused" — breaks two claims, since
    // "will not go through" and "will keep being refused" are both carried by
    // that one phrase. That coupling is why this class gets this break and not
    // the more obvious one.
    template: "Hi, the {{amount}} payment on your card was refused and will keep being refused. Please use a different payment method here: {{link}}",
    breaks: "states that the bank refused this payment method"
    },
    {
    id: "no-verification-mentioned-case",
    failureClass: "authentication_abandoned",
    context: {
        link: "https://rzp.io",
        method: "card",
        amount: "₹640"
    },
    options: { steerToAnotherMethod: false },
    // "stopped during verification" becomes "did not finish". The class has a
    // single claim, so there is nothing else to collide with.
    template: "Hi, the {{amount}} payment on your card did not finish. The same card should work now. You can retry here: {{link}}",
    breaks: "says the payment stopped at a verification or authentication step"
    },
    {
    id: "pressure-case",
    failureClass: "customer_cancelled",
    context: {
        link: "https://rzp.io",
        method: "card",
        amount: "₹999"
    },
    options: { steerToAnotherMethod: false },
    // Keeps "no obligation" so the optionality claim still holds, and adds
    // urgency rather than a deadline, so the option to pay later survives too.
    // The prose contradicts itself; that is what planting a single break costs
    // here, and a judge reading the contradiction as cancelling the optionality
    // would show up as collateral rather than as a miss.
    template: "Hi, the {{amount}} payment was cancelled on your card. There is no obligation to complete it, but please complete it at the earliest. You can do so here: {{link}}",
    breaks: "pressures the customer to complete the payment"
    },
    {
    id: "speculation-case",
    failureClass: "unknown",
    context: {
        link: "https://rzp.io",
        method: "card",
        amount: "₹1,750"
    },
    options: { steerToAnotherMethod: false },
    // "The issue could not be determined" replaced with a guess. It blames the
    // bank rather than the customer, so it should not also trip the universal
    // rule against criticising them.
    template: "Hi, the {{amount}} payment did not go through with your card, most likely because your bank flagged it as unusual. You can try the same card again here: {{link}}",
    breaks: "speculates about why the payment failed"
    }
];

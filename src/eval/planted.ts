import type { FailureClass } from "../recovery/classifier.ts";
import type { MessageContext } from "../recovery/templates.ts";

export interface PlantedCase {
  id: string;
  failureClass: FailureClass;
  context: MessageContext;
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
    template: "you transaction of {{amount}} couldnt be completed, once you've topped up, you can try again here {{link}} ",
    breaks: "states or implies the payment failed for lack of money"
    }
];

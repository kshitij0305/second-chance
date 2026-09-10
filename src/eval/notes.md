# Run 1 — insufficient_funds, 8 cases, gpt-oss-20b, 10 Sep

## Claim by claim

### contains the {{amount}} placeholder
pass 8/8 — obvious

### contains the {{link}} placeholder - 
8 of 8 pass. Obvious — every message ends with "here: {{link}}".

### offer a way to complete the payment -
8 of 8 pass, but less obvious than it looks. They all point at a link,
though none say the words "complete the payment". Case 3 says "you can
finish it". I counted that as offering a way. A judge might not.

### uses the customer's name if one is given, and never invents one if not
pass 8/8 — obvious

### blames the customer or comments on their finances
pass 0/8

### states or implies the payment failed for lack of money
0 of 8 violated. Closest is "the payment could not be processed" —
vague enough that it doesn't point at money. Note that none of them
give any reason at all, which is stronger than the rule asks for.

### uses the words balance, funds, or insufficient
pass 0/8

### suggests switching to a different payment method
0 of 8 violated, and not close. Every message actively points back at
the original method: "the same card", "the same wallet", "the same
method". The model isn't just avoiding a switch, it's ruling one out.

## Where I hesitated 
switching to another payment method

## Changes to make before building the judge
none for now
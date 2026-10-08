# Run snapshot — 8 Oct 2026

The run after the composer was fixed: the `instrument_rejected` few-shot example
stopped hedging ("likely to be declined again" became "will keep being
refused"), and `customer_cancelled`'s INTENT became two instructions to say
something rather than to convey it.

The authoritative judge run against these messages is incomplete. It reached 143
of 492 judgements and stopped on the daily token cap for `openai/gpt-oss-120b`
— 200,000 TPD, 199,715 spent. Those 143 cover `transient_provider` and most of
`insufficient_funds`, with zero failures, and reach none of the three claims the
fix was aimed at.

`model_labels_qwen-qwen3-8-27b.json` holds a provisional check on just those
three claims, run on a different model with its own quota. It is not the judge's
verdict and does not replace it; the point is to know today whether the fix
worked. Qwen agreed with the judge on 100 of 100 judgements on the 3 Oct
snapshot, which is what makes it worth asking — and model-model agreement of
1.000 is also what a shared blind spot looks like, which is what stops it being
an answer.

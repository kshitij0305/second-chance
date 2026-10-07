# Run snapshot — 7 Oct 2026

A second frozen run, made for one purpose: to re-test the claim
`makes clear there is no obligation to pay` on text the human rater has not
seen.

The first pass at that claim (`../2026-10-03/human_labels.json`, 8 items) is
unusable. The rater reported realising partway through that he had misread the
question, and by then the judge's and the third rater's verdicts on all eight
had already been shown to him. Re-answering those same eight would measure how
well he could reproduce answers he had read, not what the messages say. Both
halves of that are disqualifying on their own.

The composer runs at `temperature: 0.6`, so a fresh eval gives new prose for the
same cases — 55 of the 56 messages here differ from the 3 Oct run, including all
eight `cancelled-*` cases. Same claim, same inputs, text the rater has never
read.

- `eval_results.json` — 56 messages, every one `source: "model"`, no validator
  rejections.
- `judge_results.json` — the judge's verdicts, scoped to the claim under test
  rather than all 492. Partial by design; anything joining on (id, claim) simply
  finds fewer pairs.

The 3 Oct snapshot stays the record for the headline agreement number. This one
answers a narrower question and should not be pooled with it.

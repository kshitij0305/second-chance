# Run snapshot — 3 Oct 2026

The composer runs at `temperature: 0.6`, so every `npm run eval` produces
different prose. The top-level `eval_results.json` and `judge_results.json` are
gitignored and overwritten by the next run.

This pair is frozen because it is the dataset an agreement statistic has to be
computed against. The first attempt at hand-labelling (`../../notes.md`,
10 Sep) is unusable for exactly this reason: the messages it describes no longer
exist, and two of the claims have since been reworded. Labelling an unfrozen run
repeats that mistake.

- `eval_results.json` — 56 messages, every one `source: "model"`, no validator
  rejections.
- `judge_results.json` — 492 judgements over those same 56, 5 failing. Every
  judge id has its message in the file above; the two are one run.

Anything that labels these must read the messages from `eval_results.json` and
must not show `judge_results.json` to the person labelling. A rater who has seen
the judge's answer is a reviewer, and agreement with a verdict you were shown is
not agreement.

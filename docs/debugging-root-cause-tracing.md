# Root-cause tracing

A discipline for the Debugger's "hypothesize and test" phase: drive from
symptom to cause without settling for the first plausible story.

## Principle

Make one causal claim at a time and back each with evidence. Reject
hypotheses that the evidence contradicts — never rationalize a favorite
hypothesis past the data.

## Method

1. **State the symptom precisely** — the exact observable behavior, the
   minimal input that triggers it, and what you expected instead.
2. **Bisect when the range is unclear** — `git bisect` (or commit-by-commit
   checkout) finds the change that introduced the regression. Do not guess
   when you can narrow.
3. **Form one hypothesis** — "X happens because Y does Z." Predict what else
   that hypothesis implies.
4. **Probe with the cheapest evidence** — a focused test, a print, a log line,
   or a minimal reproduction. Cheaper probes first; reach for heavy tooling
   only when cheap probes cannot discriminate.
5. **Confirm or reject** — if the probe contradicts the hypothesis, discard it
   and form a new one. Do not patch the hypothesis to fit.
6. **Stop at the root cause** — the cause is the change whose presence produces
   the symptom and whose absence removes it. A layer above that (a missing
   guard, a race) is the real root cause; the triggering input is just the
   trigger.

## Anti-patterns

- Fixing the symptom and declaring victory (the bug returns under a different
  input).
- Stacking hypotheses without probing ("maybe A, or maybe B, or maybe C") —
  test, do not list.
- Treating "it works on my machine" as evidence; reproduce the failure
  environment.

## See also

- [Defense in depth](debugging-defense-in-depth.md)
- [Condition-based waiting](debugging-condition-based-waiting.md)
- [Debugger agent](../claudecfg/agents/dbg.md)
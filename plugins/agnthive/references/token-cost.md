# Token-cost optimization

The plugin's cost posture: orchestration lives in the root session, work is
delegated by need, and completion is evidence rather than ceremony.

- The root session plans, implements small tasks directly, and delegates only
  when delegation earns its keep: an independent review of a substantial diff,
  context isolation for bulky or unfamiliar exploration and debugging, or
  genuinely independent parallel work ([ADR
  0008](../../../docs/adr/0008-root-orchestration-and-three-specialists.md)).
- Primary specialists (Code Reviewer, Explorer, Debugger) have narrow,
  role-specific prompts in `agents/`; workflow stages (`design`, `test`,
  `docs`, `refactor`, `bug`) run as root procedures with no mandatory agent
  fork, and since ADR 0015 `/review` is a root two-stage procedure too
  (`/simplify`, then a read-only `@cr` dispatch). The alias map carries only
  the three shipped roles.
- Skills provide short, explicit task shapes instead of an always-loaded
  monolithic workflow.
- Handoffs use four fixed fields: `Outcome`, changed files, verification
  status, and remaining risks or next step — a compact shape the runtime can
  recognize and the reader can audit.
- The stop gate ends repeated incomplete summaries after its bounded retry
  limit, preventing a policy-stall loop.
- Lifecycle logging is asynchronous and size-bounded; it does not add output
  to normal tool turns.

## Measured standing context

[ADR 0014](../../../docs/adr/0014-standing-context-budgets-and-single-source-contract.md)
makes the cost posture measurable and enforced. At the 2026-11-26 revision:

| Surface | Cost |
|---|---|
| output style | ~1,400 chars, sent with every request |
| skill descriptions | ~1,870 chars always resident; bodies 1.4-2.5 KB on invocation |
| agent descriptions | ~330 chars always resident; prompts 2.1-2.9 KB per dispatch |
| per-prompt context | ~160 chars, only on a new task, a transition, or a category change |
| Stop block | failed-check checklist and template; the reply is not echoed |
| state | one batched write per hook process, snapshot after 50 replayed events, newest 500 kept |

`scripts/validate.mjs` (`checkContextBudget`) fails when a surface exceeds its
budget, so a later change cannot quietly grow the standing prefix. Raising a
budget is an ADR amendment, not a code tweak.

Removing the mandatory role chain is **not yet measured**: the outcome
benchmarks compare the lean profile against recorded baselines before any claim
is made ([ADR
0008](../../../docs/adr/0008-root-orchestration-and-three-specialists.md)
Consequences). Dispatch reduction is an expected effect of the design, not a
proven saving.

Model and effort settings remain controlled by the user; the plugin does not
pin a model and does not modify global Claude Code settings. Prompts advise
choosing model/effort by task complexity and respecting an explicitly selected
model, without mandatory model switches or unmeasured cost claims. Use the
repository benchmark commands only when measuring agent behavior; mock
benchmarks require no model calls.
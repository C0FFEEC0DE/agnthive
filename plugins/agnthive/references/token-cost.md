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
  fork. Deprecated Manager/Architect/Tester/Docwriter/Bugbuster definitions
  remain only for explicit legacy use.
- Skills provide short, explicit task shapes instead of an always-loaded
  monolithic workflow.
- Handoffs use four fixed fields: `Outcome`, changed files, verification
  status, and remaining risks or next step — a compact shape the runtime can
  recognize and the reader can audit.
- The stop gate ends repeated incomplete summaries after its bounded retry
  limit, preventing a policy-stall loop.
- Lifecycle logging is asynchronous and size-bounded; it does not add output
  to normal tool turns.

Savings from removing the mandatory role chain are **not yet measured**; the
outcome benchmarks compare lean and legacy before any claim is made ([ADR
0008](../../../docs/adr/0008-root-orchestration-and-three-specialists.md) Consequences). Dispatch reduction is an expected effect of the design,
not a proven saving.

Model and effort settings remain controlled by the user; the plugin does not
pin a model and does not modify global Claude Code settings. Prompts advise
choosing model/effort by task complexity and respecting an explicitly selected
model, without mandatory model switches or unmeasured cost claims. Use the
repository benchmark commands only when measuring agent behavior; mock
benchmarks require no model calls.
# Implementation plans

Dated implementation plans produced from an approved design, executed via Subagent-Driven Development.

## Current implementation plans

- [2026-10-19: harness modernization and orchestration simplification](2026-10-19-harness-modernization-and-simplification.md) — detailed implementation handoff based on a repository/runtime review and accepted [ADR 0008–0013](../adr/README.md). Includes root orchestration without a mandatory Manager, evidence-based gates, and a compatibility transition. **Implemented through task 15** (shipped in `efabe5a`, plugin 0.4.0); **task 16 is deferred** until the compatibility window passes. The lean-profile default flip **happened** on 2026-10-22: the ADR 0012 outcome-benchmark rollout gate was exercised on a live 75-cell arm x repetition matrix and passed; `legacy` stays selectable for one transition release. Execution status and the per-task table live in the plan's own "Статус исполнения" section; the run-by-run ledger is `.agnthive/progress.md` (a local, gitignored scratch file).

## Superseded / history

Kept as the record of what was planned at the time; not re-planned and not
rewritten.

- [2026-06-21: Claude Code plugin and Node.js production](2026-06-21-claude-code-plugin-node-production.md) — the plan that moved the project from a copied `~/.claude` profile to a distributable Node.js ESM plugin. Superseded by the shipped plugin; kept for the migration rationale.
- [2026-06-24: subagent dispatch benchmark plan](2026-06-24-subagent-dispatch-benchmark-plan.md) — the dispatch-observability plan. It carries its own "Note (2026-06-25)": the fixtures were since ported from Python to Node, so the `pytest` / `calculator.py` references below that note describe the state at the time of writing and are preserved as history. The current benchmark contract lives in [`docs/benchmarking.md`](../benchmarking.md).

## Convention

- One file per plan: `YYYY-MM-DD-<slug>.md`
- A plan breaks the design into bite-sized tasks (2–5 minutes each). Every task carries exact file paths, the concrete change, and its verification step.
- Each task references the design in `docs/specs/` it derives from.
- Commit the plan; the progress ledger names commits per task so work survives compaction.

## Where this fits

Design (docs/specs/) → Plan → Subagent-Driven Development → Review.

The shipped workflow and contracts live in
`plugins/agnthive/references/`.

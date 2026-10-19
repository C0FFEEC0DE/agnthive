# Implementation plans

Dated implementation plans produced from an approved design, executed via Subagent-Driven Development.

## Current implementation plans

- [2026-10-19: harness modernization and orchestration simplification](2026-10-19-harness-modernization-and-simplification.md) — detailed implementation handoff based on a repository/runtime review and accepted [ADR 0008–0013](../adr/README.md), not yet implemented. Includes root orchestration without a mandatory Manager, evidence-based gates, and a compatibility transition.

## Convention

- One file per plan: `YYYY-MM-DD-<slug>.md`
- A plan breaks the design into bite-sized tasks (2–5 minutes each). Every task carries exact file paths, the concrete change, and its verification step.
- Each task references the design in `docs/specs/` it derives from.
- Commit the plan; the progress ledger names commits per task so work survives compaction.

## Where this fits

Design (docs/specs/) → Plan → Subagent-Driven Development → Review.

The shipped workflow and contracts live in
`plugins/agnthive/references/`.

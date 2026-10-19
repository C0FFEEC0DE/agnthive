---
name: docs
description: Use when README/docs are out of sync, a feature needs user-facing documentation, or code lacks explanation — root documentation procedure; delegate substantial documentation work.
argument-hint: "<doc target or out-of-sync area>"
---

# /docs — root documentation procedure

Run this in the root session. The author of a change usually makes small doc
edits directly. Delegate to a focused subagent when the documentation work is
substantial (a new guide, API reference, or a sweep over several docs) — in
explicit legacy workflows that is the `@doc` (Docwriter) agent, which is
deprecated for new use ([ADR
0008](../../../../docs/adr/0008-root-orchestration-and-three-specialists.md)).

## When to use
- Behavior changed and docs need an update
- README or quickstart is unclear
- Need API or workflow documentation
- Want examples aligned with the real code

## Usage
```text
/docs [what to document]
```

## Procedure
1. Find the relevant code or workflow context
2. Identify the minimum docs that must change
3. Write concise user-facing documentation
4. Keep examples aligned with the repository reality; if an example or command was not verified, say so
5. Call out any remaining documentation gaps

## Important
- Do not invent files, commands, or setup steps
- Prefer updating existing docs before adding new ones
- Record the docs decision for the change as `updated`, `not_required`, or `pending` — with a reason when it is not `updated`; internal changes with no new user-facing semantics can be `not_required`
- Delegated handoffs should end with the stop-safe footer fields: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`
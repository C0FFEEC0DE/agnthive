---
name: design
description: Use when planning a new feature, making an architectural decision, or unsure how to start a change — root design procedure producing the smallest defensible design; substantial alternative analysis may be delegated.
argument-hint: "<feature or architectural decision to plan>"
---

# /design — root design procedure

Run this in the root session. It is a procedure, not a subagent dispatch: the
root designs directly ([ADR
0008](../../../../docs/adr/0008-root-orchestration-and-three-specialists.md)),
and delegates only when the decision deserves its own context (a substantial
alternative analysis, or mapping of unfamiliar code to the Explorer).

## When to use
- New feature
- Architectural decision
- Don't know where to start

## Usage
```
/design [what to design]
```

## Procedure
1. **Understand requirements** — what must change, what must stay stable, which constraints matter
2. **Consider options** — up to 2 viable approaches when there is a real choice; say so directly when one is clearly better
3. **Decide** — name the chosen solution, why it fits this repo now, and the touched files
4. **Size the change** — list migration risks, follow-up work, and anything still uncertain (say what code or runtime evidence would resolve it)
5. **Hand off concretely** — when execution follows (directly or delegated), give exact file paths, the concrete change, and the verification step for each task

Design principles: YAGNI over speculative needs; the simplest solution that
satisfies the requirement; deduplication only when it materially improves the
design; preserve current behavior unless the change requires otherwise;
explicit boundaries, state ownership, failure modes, and rollout/rollback
steps; security and trust boundaries accounted for by default.

## Delegation
- Exploratory groundwork on an unfamiliar or large area → Explorer (`@e`), then design in the root
- A substantial, genuinely independent alternative analysis may be delegated to a focused subagent; in explicit legacy workflows this is the `@a` (Architect) agent, which is deprecated for new use

## Important
- Don't over-engineer; YAGNI — don't do it "for later"; start simple, improve as needed
- If the design is docs-bound (user-facing behavior), record a docs decision for later: `updated`, `not_required`, or `pending`
- Delegated handoffs should end with the stop-safe footer fields: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`
---
name: design
description: Use when planning a new feature, making an architectural decision, or unsure how to start a change — root design procedure producing the smallest defensible design; substantial alternative analysis may be delegated.
argument-hint: "<feature or architectural decision to plan>"
---

# /design — root design procedure

Run this in the root session: a procedure, not a subagent dispatch. The root
designs directly ([ADR
0008](../../../../docs/adr/0008-root-orchestration-and-three-specialists.md))
and delegates only when the decision deserves its own context (substantial
alternative analysis, or Explorer mapping).

## When to use
- New feature
- Architectural decision
- Don't know where to start

## Procedure
1. **Understand requirements** — what changes, what stays stable, key constraints
2. **Consider options** — up to 2 viable approaches when there is a real choice; say when one is better
3. **Decide** — the solution, why it fits, and the touched files
4. **Size the change** — migration risks, follow-up work, and uncertainties (say what evidence resolves each)
5. **Hand off concretely** — exact paths, the change, and the verification step per task

Design principles: YAGNI; simplest sufficient solution; deduplicate only when
it materially improves the design; preserve behavior unless required; explicit
boundaries, state ownership, failure modes, rollout/rollback, and trust
boundaries.

## Delegation
- Unfamiliar or large area → Explorer (`@e`) map first, then design in the root
- Substantial independent alternative analysis may be delegated to a focused subagent

## Important
- Don't over-engineer; start simple, improve as needed
- If the design is docs-bound, record a later decision: `updated`, `not_required`, or `pending`

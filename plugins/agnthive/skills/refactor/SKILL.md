---
name: refactor
description: Use when code has duplication, long functions, fragile tests, or accumulated technical debt needing bounded structural cleanup — root refactoring procedure that preserves behavior; delegate substantial multi-file work.
argument-hint: "<code area with duplication or debt>"
---

# /refactor — root refactoring procedure

Run this in the root session. Behavior-preserving cleanup is ordinary
implementation work — do it directly. Delegate to a focused subagent when a
substantial multi-file refactor genuinely benefits from isolation (in explicit
legacy workflows that is the `@a` (Architect) agent, deprecated for new use),
and get independent review when the diff is substantial ([ADR
0008](../../../../docs/adr/0008-root-orchestration-and-three-specialists.md)).

## When to use
- Code duplication
- Functions too long (>50 lines)
- Bad variable names
- Tests became fragile
- Technical debt cleanup

## Usage
```
/refactor [what to refactor]
```

## Procedure
1. Find the structural problem
2. Describe the smallest safe refactoring approach
3. Prepare an implementation and verification checklist
4. Call out behavior-preservation constraints
5. Implement in bounded steps — leave the code cleaner, not redesigned
6. Run verification after the change; a refactor without a completed covering test is unverified

## Important
- Separate commits for refactor
- Don't add features with refactor
- Preserve behavior: the change is structural, not semantic
- For behavior changes inside the refactor, record a docs decision (`updated`, `not_required`, or `pending`) with a reason
- Substantial refactors get completed independent review of the current diff (`/review`); trivial cleanups may note that rationale instead
- The completion report carries the stop-safe footer fields: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`
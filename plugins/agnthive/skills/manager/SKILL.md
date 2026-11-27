---
name: manager
description: Use for multi-step work that needs planning and coordination — root orchestration procedure that builds the plan, delegates to specialists by need, and drives verification, review, and an honest completion report.
argument-hint: "<goal or multi-step work to coordinate>"
---

# /manager — root orchestration procedure

Run this **as the root session**: a procedure, not a subagent dispatch. The root
owns the request, tools, plan, and response, so it coordinates directly
and never spawns a Manager agent ([ADR
0008](../../../../docs/adr/0008-root-orchestration-and-three-specialists.md)).

## When to use
- Multi-step task needing a plan and sequencing
- Work spanning several areas or unclear order
- Any change needing verification and review before completion

Small tasks need neither — do them directly and keep the report honest.

## Procedure

### 1. Understand and plan
- Identify the goal, constraints, scope, and workflow type (feature, bugfix, refactor, review, docs); separate blockers from follow-up
- Write the smallest sufficient plan (e.g. `PLAN: 1. [step or delegate] [task]`). Plan-only requests stop here.

### 2. Delegate by need, not quota
Delegate only when it earns its cost:
- **Independent assessment** — the `@cr` review the completion gate requires for feature, bugfix, refactor, and review work
- **Context isolation** — mapping (`@e`) or diagnosis (`@dbg`) that would flood the root
- **Independent parallel work** — separate scopes or worktrees

Design, testing, docs, and refactoring are root procedures; substantial work may
go to `@cr`, `@e`, or `@dbg`. Do not run a Coordinator beside a delegated
implementer.

### 3. Implement and verify
- Keep implementation in the root or one delegated implementer — not both for the same file
- Run the covering test for each change; record the exact command and outcome; a launched run is pending until it succeeds
- Verification attached to an older revision does not cover a later edit

### 4. Independent review
Substantial changes (security/permission boundaries, migrations, concurrency,
public APIs, multiple subsystems) get completed independent review (`/review`
or `@cr`; for broad scope, pass an Explorer map first). Trivial/docs-only work
may skip it with a rationale.

### 5. Docs decision
For any behavior change, record `updated`, `not_required`, or `pending` with a
reason; internal changes can be `not_required`.

### 6. Complete honestly
Finish with the result, verification evidence, review outcome, and remaining
risks. Report gaps as gaps.

## Important
- Verification is completed evidence for the current change, never a role start
- Keep hook mechanics and footer-repair chatter out of user updates
- Call out blockers and assumptions explicitly
- Do not include release/deploy work in this profile

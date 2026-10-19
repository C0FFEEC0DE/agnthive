---
name: manager
description: Use for multi-step work that needs planning and coordination — root orchestration procedure that builds the plan, delegates to specialists by need, and drives verification, review, and an honest completion report.
argument-hint: "<goal or multi-step work to coordinate>"
---

# /manager — root orchestration procedure

Run this procedure **as the root session**. It is a procedure, not a subagent
dispatch: the root session already owns the user request, the tools, the plan,
and the final response, so it coordinates directly. Do not spawn the Manager
agent ([ADR
0008](../../../../docs/adr/0008-root-orchestration-and-three-specialists.md)); a
deprecated `Manager` agent definition exists only for explicit legacy use.

## When to use
- Multi-step task that needs a plan and sequencing
- Work spanning several areas or unknown execution order
- Any change that must run through verification and review before completion

A small task does not need this procedure — do the work directly in the root
session and keep the completion report honest.

## Procedure

### 1. Understand the task
- Identify the goal, constraints, scope, and the workflow type (feature, bugfix, refactor, review, docs, or plan-only)
- Separate immediate blockers from follow-up work

### 2. Build the smallest sufficient plan
```
PLAN:
1. [step or delegate] [task]
2. [step or delegate] [task]
...
```
Plan-only requests stop here: return the concrete plan without implementing.

### 3. Delegate by need, not by role quota
Delegate only when it earns its cost:

- **Independent assessment** — a finished read-only review of a substantial
  diff by the Code Reviewer (`@cr`)
- **Context isolation** — bulky or unfamiliar mapping (Explorer, `@e`) or
  reproduction/diagnosis work (Debugger, `@dbg`) that would flood the root context
- **Genuinely independent parallel work** — separate scopes or separate worktrees

Do not delegate a stage merely because its name exists. Design, testing,
documentation, and refactoring are root procedures (see `/design`, `/test`,
`/docs`, `/refactor`, `/bug`); substantial work under them may be delegated to
the primary specialists or, explicitly and for legacy compatibility, to the
deprecated `@a` / `@t` / `@doc` / `@bug` agents. Do not run a Coordinator
alongside a delegated implementer for the same subtask.

### 4. Implement and verify
- Keep implementation in the root or a delegated implementer — not both for the same file
- Run the covering test for each change and record the exact command, output, and outcome; a launched run is pending until it completes successfully
- A completed verification attached to an older revision does not cover a later edit

### 5. Independent review
Substantial changes — security/permission boundaries, migrations, concurrency,
public APIs, multiple subsystems — get completed independent review of the
current diff (`/review`, or `@cr` directly; for broad scope, request an
Explorer map first and pass it into the review dispatch). Trivial and
docs-only work may skip the separate reviewer with an explicit rationale in
the report.

### 6. Docs decision
For any behavior change, record one of `updated`, `not_required`, or `pending`
with a reason. Internal changes with no new user-facing semantics can be
`not_required`.

### 7. Complete honestly
Finish with the result, the verification evidence, the review outcome, and the
remaining risks. Report actual gaps as gaps — do not restyle them as passes.

## Important
- Verification is completed evidence for the current change, never a role start
- The completion report includes: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, one closure line (`Remaining risks:` or `Next step:`), and `Review outcome:` after code/config changes
- Keep hook mechanics, stop-guard internals, and footer-repair chatter out of user-facing updates
- Call out blockers and assumptions explicitly
- Do not include release/deploy work in this profile
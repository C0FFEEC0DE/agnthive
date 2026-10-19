---
name: review
description: Use before committing or merging, or for PR/security/architecture review of changes — dispatches the Code Reviewer in an isolated read-only forked subagent.
argument-hint: "<path, PR, or change scope to review>"
agent: Code Reviewer
context: fork
disable-model-invocation: true
allowed-tools:
  - Read
  - Glob
  - Grep
paths:
  - "**/*.mjs"
  - "**/*.js"
  - "**/*.ts"
  - "**/*.sh"
  - "**/*.md"
---

# /review

**This command is now a skill that invokes @code-reviewer agent.**

Run code review with the Code Reviewer agent. This is the one skill that still
forks a specialist, because independent judgment requires a separate context.

## When to use
- Substantial changes before committing or merging — security/permission boundaries, migrations, concurrency, public APIs, multiple subsystems
- PR review
- Security check
- Architecture review

Trivial and docs-only work may skip the separate reviewer with an explicit
rationale in the report ([ADR
0008](../../../../docs/adr/0008-root-orchestration-and-three-specialists.md)).

## Usage
```
/review [what to review]
```

## Agent Actions
The @code-reviewer agent will — from its read-only toolset (`Read`, `Glob`,
`Grep`) and the review scope the root hands it:
1. Check for bugs and security issues
2. Review architecture and readability
3. Check whether tests exist and cover the change, and report verification gaps
4. Suggest specific solutions, not just problems

## Review Scope Policy
- Small localized reviews can stay `@cr`-only
- Broad workflow, subsystem, or multi-file reviews: the **root** dispatches
  `@e` first and passes the Explorer map into the review dispatch. The
  reviewer is read-only and cannot dispatch agents; it does not run discovery
  for itself, and should say what context was supplied when finalizing findings

## Checklist
- [ ] No obvious bugs
- [ ] Names are clear
- [ ] Functions short (<50 lines)
- [ ] Error handling exists
- [ ] Tests exist and cover the change; gaps reported, not run by the reviewer
- [ ] No sensitive data in logs
- This is the documented entry point for the required `@cr` review used by substantial `feature`, `bugfix`, `refactor`, and `review` work
- Review handoffs should also include `Review outcome:` plus the stop-safe footer fields: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`
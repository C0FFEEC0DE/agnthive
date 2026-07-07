---
name: refactor
description: Use when code has duplication, long functions, fragile tests, or accumulated technical debt needing bounded structural cleanup — dispatches the Architect in an isolated forked subagent.
agent: Architect
context: fork
disable-model-invocation: true
allowed-tools:
  - Read
  - Glob
  - Grep
  - Edit
  - Write
  - Bash(git status:*)
  - Bash(git diff:*)
paths:
  - "**/*.mjs"
  - "**/*.js"
  - "**/*.ts"
  - "**/*.sh"
---

# /refactor

**This command is now a skill that invokes @architect.**

Run refactoring session with the Architect agent.

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

## Agent Actions
The @architect agent will:
1. Find the structural problem
2. Describe the smallest safe refactoring approach
3. Prepare an implementation and verification checklist for the main thread
4. Call out behavior-preservation constraints
5. Leave a concrete refactor handoff instead of a broad redesign

## Important
- Separate commits for refactor
- Don't add features with refactor
- Leave code cleaner than it was
- This handoff satisfies the refactor structural-analysis branch of the gate together with required `@cr` and either successful verification or `@t`
- The resulting handoff should end with exact footer prefixes recognized by the hooks: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`
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
  - "**/*.py"
  - "**/*.js"
  - "**/*.ts"
  - "**/*.sh"
---

# /refactor

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

## Examples
```
/refactor the auth module
/refactor extract common logic from services
/refactor rename variables in user controller
```

## Agent
Invokes @architect who will:
1. Identify the smallest defensible refactor target
2. Propose the structural cleanup plan and safety checkpoints
3. Call out behavior-preservation constraints and verification needs
4. Hand back a concrete refactor direction that the main thread can implement safely
5. Report the intended file-level impact

## Constraints
- **Never ask the user for confirmation.** Proceed directly with bounded refactoring changes.
- Keep changes focused and limited in scope.
- Do not perform release or deploy work.

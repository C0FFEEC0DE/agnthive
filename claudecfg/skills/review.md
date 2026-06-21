---
name: review
description: Use before committing or merging, or for PR/security/architecture review of changes — dispatches the Code Reviewer in an isolated read-only forked subagent.
agent: Code Reviewer
context: fork
disable-model-invocation: true
allowed-tools:
  - Read
  - Glob
  - Grep
paths:
  - "**/*.py"
  - "**/*.js"
  - "**/*.ts"
  - "**/*.sh"
  - "**/*.md"
---

# /review

Run code review with the Code Reviewer agent.

## When to use
- Before committing
- PR review
- Security check
- Architecture review

## Usage
```
/review [what to review]
```

## Examples
```
/review the auth changes
/review PR #123
/review security of payment module
```

## Agent
Invokes @code-reviewer (Toxic Senior) who will:
1. Check for bugs and security issues
2. Review architecture and readability
3. Verify tests exist and pass
4. Suggest specific improvements
5. Report findings with severity

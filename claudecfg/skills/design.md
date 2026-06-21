---
name: design
description: Use when planning a new feature, making an architectural decision, or unsure how to start a change — dispatches the Architect in an isolated forked subagent.
agent: Architect
context: fork
disable-model-invocation: true
allowed-tools:
  - Read
  - Glob
  - Grep
  - Edit
  - Write
paths:
  - "**/*.py"
  - "**/*.js"
  - "**/*.ts"
  - "**/*.sh"
  - "**/*.md"
  - "docs/**"
  - "README*"
  - "CHANGELOG*"
---

# /design

Run design session with the Architect agent.

## When to use
- New feature
- Architectural decision
- Don't know where to start
- Need SOLID review

## Usage
```
/design [what to design]
```

## Examples
```
/design the auth system
/design API for payment service
/design database schema for users
```

## Agent
Invokes @architect (The Architect) who will:
1. Understand requirements
2. Identify constraints
3. Propose solution options
4. Compare pros/cons
5. Recommend approach with justification
6. Ensure SOLID principles

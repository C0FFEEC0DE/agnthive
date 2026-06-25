---
name: bug
description: Use when a failure exists but the root cause is not obvious — dispatches the Bugbuster in an isolated forked subagent for root-cause investigation and the smallest credible fix path.
agent: Bugbuster
context: fork
disable-model-invocation: true
allowed-tools:
  - Read
  - Glob
  - Grep
  - Edit
  - Write
  - Bash(node --test:*)
  - Bash(node:*)
  - Bash(npm test:*)
  - Bash(make test:*)
paths:
  - "src/**"
  - "lib/**"
  - "scripts/**"
  - "plugins/**"
  - "**/*.mjs"
  - "**/*.js"
  - "**/*.ts"
  - "**/*.tsx"
  - "tests/**"
  - "test/**"
  - "**/*.test.mjs"
  - "**/*.test.js"
  - "package.json"
---

# /bug

**This command is now a skill that invokes @bugbuster agent.**

Run a focused bug-hunting session with the Bugbuster agent.

## When to use
- A failure exists but the root cause is not obvious
- Need to narrow down a regression
- Several code paths could explain the bug
- Want a targeted fix plan before editing

## Usage
```text
/bug [description of the bug]
```

## Agent Actions
The @bugbuster agent will:
1. Inspect the failing behavior
2. Narrow the likely root-cause area
3. Compare hypotheses against the code
4. Suggest or implement the smallest credible fix path when task scope allows it
5. Run or request verification after the fix

## Important
- Prefer root cause over symptom-level patching
- Keep the investigation scoped to the described failure
- This is the documented entry point for the bug-investigation handoff used by `bugfix` workflows
- The resulting handoff should end with exact footer prefixes recognized by the hooks: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`
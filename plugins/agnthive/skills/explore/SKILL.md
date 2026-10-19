---
name: explore
description: Use when you need repository context before changing code — root exploration procedure that maps files, control flow, and likely change locations; delegates to the Explorer specialist for large or unfamiliar areas.
argument-hint: "<area, symbol, or question to map>"
---

# /explore — root exploration procedure

Run this in the root session. For a small, well-known area, read the files
directly. Delegate mapping to the Explorer specialist (`@e`) when the area is
large, unfamiliar, or its bulk would cost the root session useful context —
independent context isolation is the reason to delegate, not the stage name
([ADR 0008](../../../../docs/adr/0008-root-orchestration-and-three-specialists.md)).

## When to use
- Need repository context before changing code
- Looking for where behavior is implemented
- Tracing config, hooks, or workflow wiring
- Comparing multiple candidate edit points

## Usage
```text
/explore [what to inspect]
```

## Procedure
1. Locate the relevant files and entry points
2. Trace how data and control flow through the codebase
3. Summarize key implementation constraints
4. Point out likely change locations
5. Highlight risks before implementation starts

When delegating: give the Explorer the exact question, the expected output
shape (locations, control flow, config/env), and what decision the map feeds;
have it cite files and symbols so the result is checkable. Keep the map
returned to the root reusable for the review dispatch.

## Important
- Prefer evidence from files over guesses
- Keep the result focused on decision-making
- Do not surface hook, footer, or prefix-matching repair chatter in the user-facing explanation
- Delegated handoffs should end with the stop-safe footer fields: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`
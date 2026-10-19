---
name: debug
description: Run the root debugging procedure — reproduce, isolate, and root-cause a failure before fixing; delegates long-running or cross-file diagnosis to the Debugger specialist.
argument-hint: "<failing behavior or repro steps>"
---

# /debug — root debugging procedure

Run this in the root session. Do not fork a subagent merely because debugging
started; delegate to the Debugger specialist (`@dbg`) when reproduction is
long-running, the failure spans several files or processes, or the log and
stack work would flood the root context
([ADR 0008](../../../../docs/adr/0008-root-orchestration-and-three-specialists.md)).

## When to use
- Bug not reproducible on first attempt
- Need to investigate code behavior
- Crashes/errors without clear cause

## Usage
```
/debug [description of the bug/issue]
```

## Procedure
1. **Reproduce** — make the issue happen reliably; if it cannot be reproduced, say what is missing before touching anything
2. **Isolate** — narrow to the minimal failing case; bisect when the regression range is unclear
3. **Hypothesize** — one causal hypothesis at a time, probed with the cheapest evidence
4. **Confirm** — state the root cause, apply the smallest defensible fix, and re-run the covering test to prove the behavior changed; add a regression test that fails without the fix

For static analysis of the suspect code, use the
[bug-pattern review checklist](../../references/agent-contracts.md#static-bug-pattern-review-checklist).

## Important
- Don't change code until you understand the cause
- Document what you've tried; record reproduction steps so the session can resume from that state
- The completion report carries the stop-safe footer fields: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`
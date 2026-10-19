---
name: bug
description: Use when a failure exists but the root cause is not obvious — root bug-investigation procedure for root-cause analysis and the smallest credible fix path; delegates long-running or cross-file diagnosis to the Debugger.
argument-hint: "<failure or symptom to investigate>"
---

# /bug — root bug-investigation procedure

Run this in the root session following the debug loop. Do not fork a subagent
merely because the work is bug-shaped: delegate to the Debugger specialist
(`@dbg`) when reproduction is long-running, the failure spans several files or
processes, or the investigation would flood the root context, and rely on the
Code Reviewer for static pattern checks in the resulting diff ([ADR
0008](../../../../docs/adr/0008-root-orchestration-and-three-specialists.md)).
In explicit legacy workflows the `@bug` (Bugbuster) agent exists as a
deprecated compatibility definition.

## When to use
- A failure exists but the root cause is not obvious
- Need to narrow down a regression
- Several code paths could explain the bug
- Want a targeted fix plan before editing

## Usage
```text
/bug [description of the bug]
```

## Procedure
1. **Inspect** the failing behavior and capture the exact trigger (command, request, action) with evidence
2. **Narrow** the likely root-cause area; isolate the minimal failing case
3. **Compare** hypotheses against the code — one causal claim at a time, each backed by evidence; reject hypotheses the evidence contradicts
4. **Fix** — when task scope allows, implement the smallest credible fix after confirming the failure mode, plus a regression test that fails without the fix
5. **Verify** — run the covering test; report the exact command and outcome

For static analysis of the suspect code, use the
[bug-pattern review checklist](../../references/agent-contracts.md#static-bug-pattern-review-checklist)
(null/value handling, trust boundaries, unsafe shell usage, resource leaks,
error paths, boundary errors).

## Important
- Prefer root cause over symptom-level patching
- Keep the investigation scoped to the described failure
- Do not claim runtime behavior you did not verify dynamically
- A launched test run is pending, not passed; only completed evidence for the current diff closes verification
- The completion report carries the stop-safe footer fields: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`
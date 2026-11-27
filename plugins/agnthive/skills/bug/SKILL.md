---
name: bug
description: Use when a failure exists but the root cause is not obvious — root bug-investigation procedure for root-cause analysis and the smallest credible fix path; delegates long-running or cross-file diagnosis to the Debugger.
argument-hint: "<failure or symptom to investigate>"
---

# /bug — root bug-investigation procedure

Run this in the root session. Do not fork merely because work is bug-shaped:
delegate to the Debugger (`@dbg`) when reproduction is long-running, spans files
or processes, or would flood the root context; use the Code Reviewer (`@cr`) for
static pattern checks ([ADR
0008](../../../../docs/adr/0008-root-orchestration-and-three-specialists.md)).

## When to use
- A failure exists but the root cause is not obvious
- Need to narrow down a regression
- Several code paths could explain the bug
- Want a targeted fix plan before editing

## Procedure
1. **Inspect** the failing behavior; capture the exact trigger with evidence
2. **Narrow** the likely root-cause area; isolate the minimal failing case
3. **Compare** hypotheses against the code — one causal claim at a time, each backed by evidence; reject contradicted ones
4. **Fix** — when scope allows, implement the smallest credible fix after confirming the failure mode, plus a regression test that fails without it
5. **Verify** — run the covering test; report the exact command and outcome

For static analysis, use the
[bug-pattern review checklist](../../references/agent-contracts.md#static-bug-pattern-review-checklist).

## Important
- Prefer root cause over symptom-level patching
- Keep the investigation scoped to the described failure
- Do not claim unverified behavior
- A launched test run is pending; only completed evidence for the current diff closes verification

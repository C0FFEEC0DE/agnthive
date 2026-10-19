---
name: test
description: Use when writing or running tests, checking coverage, or closing a verification gap before stopping — root verification procedure; counts only completed results, never launches; delegate large test-suite work.
argument-hint: "<behavior or coverage gap to test>"
---

# /test — root verification procedure

Run this in the root session. Verification is completed evidence for the
current change revision: launch the covering test here (or as a tracked
background job and wait for its real result), and count only what finished
([ADR 0009](../../../../docs/adr/0009-completion-evidence-over-role-quotas.md)).
Delegate to a focused subagent when the work is a large new test suite or a
big verification sweep (in explicit legacy workflows that is the `@t`
(Tester) agent, deprecated for new use).

## When to use
- Need to write tests
- Check existing ones
- Coverage dropped
- Regression

## Usage
```
/test [what to test]
```

## Procedure
1. Find what to test: the changed behavior and its likely regression paths
2. Prefer the **covering test** over broad suites when time is limited; choose unit / integration / end-to-end by the confidence it adds
3. Write or run the tests; prefer concrete assertions over vague coverage claims; keep tests isolated and mock external dependencies
4. Report the exact command, the outcome, and what the assertions actually covered
5. Gaps go in the report as gaps — never restyled as passes

## Important
- A launched test run is **pending**, not passed; only a completed successful run of the current diff closes verification
- Verification attached to an older revision does not cover a later edit — re-run after changes
- If a fix changes behavior, add or extend a test that **fails without the fix** and passes with it
- If tests were designed but not run, say `not-run`
- 100% coverage is not the goal; important uncovered gaps must stay visible
- The completion report carries the stop-safe footer fields: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`
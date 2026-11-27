# Workflow shapes

Short step lists for the three common change shapes. All run in the root
session; delegate only when isolation earns its cost (Explorer `@e`, Debugger
`@dbg`, Code Reviewer `@cr`). Record a docs decision (`updated`,
`not_required`, or `pending`) whenever behavior changes.

## Bug fix

When a bug is found and needs fixing:

1. **Explore** — `@e understand the bug area`
2. **Find** — `@dbg find the root cause`
3. **Design** — design the fix in the root; delegate a substantial alternative analysis only when it earns isolation
4. **Implement** — apply the fix
5. **Verify** — run the covering regression test in the root and report the exact command and outcome; only a completed successful run of the current diff counts
6. **Document** — update docs when behavior, interface, or operator workflow changed, and record the decision
7. **Review** — `@cr review the fix`

## New feature

When a new feature must be implemented:

1. **Explore** — `@e understand the codebase`
2. **Design** — design in the root; delegate a substantial alternative analysis only when it earns isolation
3. **Design tests** — plan the test strategy in the root
4. **Implement** — build the feature
5. **Verify** — run the planned tests in the root and report pass/fail plus coverage gaps; only a completed successful run of the current diff counts
6. **Document** — update docs for the feature and any user-facing behavior change, and record the decision
7. **Review** — `@cr review the implementation`

## Refactor

When code needs behavior-preserving structural cleanup:

1. **Explore** — `@e explore the code to refactor`
2. **Review** — `@cr what needs refactoring`
3. **Design** — design the improved structure in the root; delegate a substantial alternative analysis only when it earns isolation
4. **Refactor** — change structure while preserving behavior
5. **Verify** — run the tests in the root and report whether behavior stayed stable; only a completed successful run of the current diff counts
6. **Document** — update docs only if public behavior or operator guidance changed, and record the decision
7. **Review** — `@cr review the refactored code`

Each shape may be driven through `/manager`, the root orchestration procedure.
Hooks enforce completed verification for the current diff before task
completion; no separate tester role is required.

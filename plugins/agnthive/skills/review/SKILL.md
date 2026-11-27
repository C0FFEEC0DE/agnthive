---
name: review
description: Two-stage review of a change — simplify first, then an independent Code Reviewer pass; use before committing, merging, or shipping a substantial diff.
argument-hint: "<path, PR, or change scope to review>"
---

# /review

Two stages, in order. Stage 1 edits; stage 2 does not.

## Stage 1 — simplify (root)

Run the `/simplify` procedure on the change scope:

- Remove duplication, dead code, and one-use abstractions; inline what only one
  call site uses; drop parameters, options, and config nothing reads.
- Keep behavior identical. Public APIs, security/permission boundaries, and
  migrations are not simplified without an explicit request.
- Re-run the detected tests/lint/build after the edits. A simplification that
  breaks a test is reverted, not "adjusted" by weakening the test.

Record the reductions made (and the verification that still passes). Skip
stage 1 only for a diff with nothing mechanical to remove.

## Stage 2 — independent review

Dispatch the Code Reviewer via the Agent tool in read-only mode, passing the
simplified diff or its scope. It must not edit; it reports:

1. Correctness bugs and security issues
2. Architecture and readability problems the simplification left behind
3. Test coverage gaps — reported, never filled by the reviewer
4. Specific fixes, not just findings

For broad, multi-file work, map the change with the Explorer first and pass that
map into the review dispatch. Report the reviewer's findings first, then your
`Review outcome:` line.

## Checklist

- [ ] Stage 1 applied or explicitly skipped with a reason
- [ ] Verification re-run after stage 1
- [ ] `@cr` started (SubagentStart) and its findings reported
- [ ] No findings suppressed; remaining risks stated

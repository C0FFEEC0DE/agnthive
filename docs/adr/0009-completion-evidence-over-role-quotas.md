# ADR 0009: Completion evidence instead of role quotas and footer gates

- **Status:** Accepted; implementation pending.
- **Date:** 2026-10-19.
- **Decides:** Completion depends on current verification and completed review where required, not agent starts, alias mentions, or footer formatting.
- **Relationship:** Replaces mandatory footer gates from [ADR 0001](0001-scope-subagent-stop-footer-to-agnthive-specialists.md) in lean only; legacy behavior remains during migration. Retains the bounded-loop policy of [ADR 0003](0003-honor-stop-hook-active.md).
- **Basis:** [Review](../specs/2026-10-19-harness-review-and-simplification-design.md), F01/F03/F04.
- **Implementation:** [Plan](../plans/2026-10-19-harness-modernization-and-simplification.md), tasks 04, 09, 11, 13–16.

## Context

The current dispatcher treats a PostToolUse test launch as success, does not invalidate verification after another edit, and accepts started roles as completed handoffs. Transcript aliases and debug-log phrases can supply role evidence without completed work. More mandatory agents do not repair this gap.

## Decision

Maintain a small evidence model with task/run/session identity, operation or agent identity, scope/cwd/worktree, checked revision or diff fingerprint, outcome, and provenance. Exact storage schema is an implementation concern, but these semantics are required:

| Evidence | May satisfy completion? |
|---|---|
| Command launched, background work pending | No |
| Completed check with confirmed success for current scope/revision | Yes, for that check |
| Failed, interrupted, missing, or unknown result | No |
| Reviewer started | No |
| Reviewer completed with an assessment of the current diff | Yes, if required findings are resolved or explicitly accounted for |
| Alias, handoff phrase, or well-formed footer | No; diagnostic claim only |
| Runtime ends a turn after loop prevention | No; turn termination is not task success |

Code/config changes invalidate earlier verification and review for the affected scope. A command started before a parallel edit cannot certify the later state. Account for shell/external edits through a checkpoint/fingerprint or conservative fallback, not only Edit/Write counters. Results from another worktree do not certify the integrated diff.

A task without an applicable automated check reports an explicit verification gap and rationale; it does not manufacture `passed` or loop forever waiting for a nonexistent command. Risk-based review requirements follow ADR 0008. Record whether docs were updated, not required, or remain pending; do not require a documentation edit for every internal refactor.

In lean, footers are concise reporting guidance, not blocking syntax contracts. Missing punctuation cannot be the sole reason to continue a turn. Structured evidence and unresolved findings survive bounded stop handling. Legacy footer gates remain scoped to recognized local specialists until removed; unknown or foreign agents must not acquire obligations because the alias file is unavailable.

## Consequences and alternatives

This replaces cheap but weak role-count checks with a small amount of lifecycle/revision bookkeeping. Keep that model minimal; it is not a scheduler or a proof of bug-free code. A model review is an assessment, and local evidence files are not tamper-proof against code running as the same OS user.

Keeping roles as a proxy for success or treating no error as successful completion is rejected. Removing all gates is also rejected: known failed checks and unresolved substantial review findings must remain visible.

## Acceptance evidence

Regression cases cover background launch/completion, test→edit→stop, edits during tests, separate worktrees, reviewer start without completion, stale review, false handoff text, unknown outcomes, and loop escape preserving failure. Benchmarks must read the same structured evidence rather than reconstruct success from prose.

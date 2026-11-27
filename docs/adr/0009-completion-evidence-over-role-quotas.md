# ADR 0009: Completion evidence instead of role quotas and footer gates

- **Status:** Accepted; implemented in 0.4.0 (working tree); host canaries pending (plan task 14); legacy removal LANDED in 0.5.0 (plan task 16) — the mandatory role quotas are gone and completion is decided by current evidence. Amended 2026-11-27: file fingerprints enforce the evidence-freshness half of the decision (see the amendment below).
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

## Amendment 2026-11-27: fingerprint freshness

The decision above requires shell and external edits to be accounted for "through a checkpoint/fingerprint or conservative fallback". The revision counter plus `fs_revision_hint` implement the conservative fallback for changes Claude itself makes (Edit/Write, and mutating Bash commands). Neither can see a write from outside the session: an editor, `git checkout`, a formatter, or a build step that rewrites a tracked file between a passing check and Stop leaves the record revision-current while the tree it certified no longer exists.

Completed verification records therefore carry a file fingerprint — `files: [{path, size, mtimeMs}]`, or `{path, missing: true}` for a path that could not be stat'ed — captured from `state.files` when the record completes. A record certifies the current tree only if every fingerprinted path still matches its recorded size and mtime; a missing-then-present or present-then-missing path is a mismatch. Records without a fingerprint (older sessions, record-less fixtures) keep the pre-amendment behavior.

This is a freshness check, not tamper-proofing: it detects a later write, not a deliberate restoration of mtime, and it does not replace revision scoping. The host's `FileChanged` hook event was evaluated and rejected for this purpose: its watch list is built from literal filenames in the working directory (or absolute `watchPaths` seeded at SessionStart/CwdChanged), so a file first edited mid-session is never watched in time. A gate-time fingerprint works on every host version.

Two boundaries follow from the existing revision model. Docs paths are excluded from the snapshot, because a docs edit never bumps the revision and the contract allows a docs phase after a passing run. And the snapshot covers only files the session edited through `Edit`/`Write`: a file rewritten by a mutating Bash command is represented by the conservative revision bump, not by a fingerprint, so an out-of-session rewrite of such a file between the check and Stop is not detected by this check alone. Closing that gap needs command-to-file attribution, which the command policy does not attempt.

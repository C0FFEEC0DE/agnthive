# ADR 0013: Deterministic ledger restoration and minimal telemetry

- **Status:** Accepted; implementation pending host-contract verification.
- **Date:** 2026-10-19.
- **Decides:** Restore task context through a verified lifecycle channel and log bounded metadata by default.
- **Basis:** [Review](../specs/2026-10-19-harness-review-and-simplification-design.md), F07/F10.
- **Implementation:** [Plan](../plans/2026-10-19-harness-modernization-and-simplification.md), tasks 02, 07, 14–15.

## Context

Current tests assert JSON emitted by an async PostCompact hook, not delivery of the ledger to the model. The current log stores complete compact summaries while comments promise not to store prompt/transcript contents. Context restoration and audit logging need separate contracts.

## Decision

Use SessionStart compact/resume as the preferred restoration channel after verifying the target CLI's event order and actual context delivery. Keep PostCompact for bounded bookkeeping. If capture disproves the intended delivery path, amend this ADR with evidence before choosing another channel; do not silently claim restoration from emitted JSON alone.

Inject a compact active-task/revision summary and ledger location once per restoration cycle. Preserve ordinary session context and avoid duplicating ledger text across paired lifecycle events. A byte cap is a storage limit, not a reason to inject the maximum on every turn. Missing or oversized ledger produces a bounded diagnostic and an explicit reconstruction step rather than false progress.

Default telemetry records only necessary event/version/session/task/agent/prompt identifiers and status metadata. Record the current notification type with legacy read compatibility where useful. Do not store full compact summaries or copy entire transcripts by default. A verbose diagnostic mode, if implemented, must be explicit, bounded, and document sensitive-content exposure and retention; field selection is not a guarantee of secret redaction.

Observe API failures separately from normal completion. Error text is not an agent work report. Telemetry failures remain nonblocking under ADR 0011. Store local plugin data separately from installed plugin source and do not add external reporting services.

## Alternatives and consequences

Keeping async PostCompact JSON as sufficient proof is rejected because delivery is not tested. Reinjecting the entire ledger on every prompt wastes context and may duplicate instructions. Logging complete summaries by default creates unnecessary content retention.

The smaller default trace is less convenient for retrospective debugging. Scoped verbose diagnostics and reproducible fixtures compensate without claiming that logs are content-free when they are not.

## Acceptance evidence

Capture manual/automatic compaction and resume on the supported CLI. Verify one restoration, correct active task, continued completed-work tracking, missing/oversized ledger handling, bounded logs, and API failure recorded as failed/incomplete. If idle compaction is claimed as supported, include that scenario too.

# ADR 0010: Task boundaries and agent identity survive background events

- **Status:** Accepted; implementation pending.
- **Date:** 2026-10-19.
- **Decides:** Incoming messages do not automatically create a new task; background/resume processing preserves active task and agent state.
- **Relationship:** Amends the unconditional UserPromptSubmit map-reset policy in [ADR 0002](0002-per-agent-loop-block-counter.md); retains per-key mutation and identity helpers from ADR 0002/0005/0006. Retains plugin-only namespace handling from ADR 0007.
- **Basis:** [Review](../specs/2026-10-19-harness-review-and-simplification-design.md), F02/F06/F08.
- **Implementation:** [Plan](../plans/2026-10-19-harness-modernization-and-simplification.md), tasks 02, 05–06, 09.

## Context

UserPromptSubmit currently reclassifies every input and clears all subagent retry counters. Background results can erase the open workflow, while session-wide started roles and verification flags can certify a later unrelated task. Resume events also inflate agent instance counts.

## Decision

Represent task lifecycle separately from prompt identity: start, continue, complete, and explicit transition to another task. Correlation IDs are not proof that a human sent a message. Do not invent a `prompt_source` field; use only captured/documented runtime signals and known active operations. Preserve an unfinished contract when origin is ambiguous, while providing an explicit path for a user to replace or cancel it.

Key agent lifecycle by stable agent ID and owning task, with role, scope, and status. Record parent identity only when actually supplied by a supported source. Resume updates an existing instance; event count and unique-agent count are different metrics. Clear only the relevant retry state; a new message must not erase live siblings. The `_session` fallback cannot certify independent identities when IDs are missing.

Use current runtime background-task information when available. An explicit empty registry is authoritative over old transcript text. Track only relevant pending work; arbitrary crons/monitors cannot keep a task waiting forever. Do not interpret a parent-scoped task list as a child's own descendants.

Normalize namespaced commands into namespace, command, and arguments. Accept the `agnthive` identity; do not erase foreign namespaces. Processing submission and expansion for the same invocation must not reset state twice. `fork`, foreign, and unknown/internal agents do not inherit local specialist footer obligations.

## Subagent result ownership

The previous ADR index incorrectly called `agent_transcript_path` undocumented. It is documented separately from the parent `transcript_path`. SubagentStop `last_assistant_message` is the direct closing text; when SubagentHandback is used, the delivered report is the handback message, not necessarily that closing text. See the [official SubagentStop contract](https://code.claude.com/docs/en/hooks#subagentstop).

Resolve a completed report by its actual event/agent identity. Prefer directly delivered report data; use the subagent transcript only as a scoped fallback. Do not use the parent's last message as a child's review result. Capture fixtures for supported handback behavior before enabling a new adapter. Missing evidence remains unknown.

## Consequences and alternatives

An explicit task boundary adds state but prevents accidental resets and stale success. Resetting on every prompt or using transcript mentions as lifecycle truth is rejected. Existing per-key map events remain useful; do not replace them with whole-map read/modify/write patches.

## Acceptance evidence

Test background return during an open feature, a new task in the same session, duplicate start/resume, siblings continuing through another prompt, foreign namespaces, generic fork, parent/child transcripts, SubagentHandback, missing IDs, and empty versus absent background registries.

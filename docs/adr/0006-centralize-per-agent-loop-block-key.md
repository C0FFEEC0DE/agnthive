# ADR 0006: Centralize the per-agent loop-block key

- **Status:** Accepted; implemented in baseline `2cd40df`.
- **Decides:** The `agentId || '_session'` fallback key is computed by one
  exported helper, `agentLoopKey`, instead of being inlined at every call site.

## Review update (2026-10-19)

Retained: `agentLoopKey` is the shared key derivation helper. `_session` is a
compatibility fallback when identity is absent, not evidence of an independent
agent. [ADR 0010](0010-task-and-agent-lifecycle-identity.md) adds task ownership
and idempotent lifecycle handling without reintroducing duplicated key logic.
The context below describes the pre-implementation code.

## Context

ADR-0002 introduced a per-agent loop-block counter keyed by `agent_id`, falling
back to a shared `_session` key when `agent_id` is absent. The fallback literal
`agentId || '_session'` is now inlined across the loop-block machinery:
`workflow.mjs` (`loopBlockCount`, `recordLoopBlock`),
`summary-contract.mjs` (`emitLoopAwareBlock`), and
`hook-dispatcher.mjs` (`handleSubagentStop` success clear).

**Failure mode:** not a bug — a maintainability gap. The `_session` sentinel is
hardcoded in ~4 places; renaming it or adding a guard (e.g. rejecting a
malformed agent_id) means a multi-site edit, and the ADR-0005 change adds one
more site (`emitLoopAwareBlock` computing `perKey.key`). A single helper keeps
the fallback rule in one place.

## Decision

Add `agentLoopKey(agentId)` to `workflow.mjs` (where `loopBlockFields` lives)
returning `agentId || '_session'`, export it, and call it at every site that
derives the per-agent key: `loopBlockCount`, `recordLoopBlock`,
`emitLoopAwareBlock` (for `perKey.key`, per ADR 0005), and the dispatcher's
`handleSubagentStop` success clear.

## Pinned interface contract

- **`workflow.mjs`:** add and export
  `function agentLoopKey(agentId) { return agentId || '_session'; }`.
  - `loopBlockCount(state, prefix, agentId)`: per-agent read uses
    `state?.[f.mapKey]?.[agentLoopKey(agentId)]?.count`.
  - `recordLoopBlock(state, prefix, reason, message, agentId)`: per-agent key
    `const key = agentLoopKey(agentId);` (replaces the inline `agentId || '_session'`).
- **`summary-contract.mjs` `emitLoopAwareBlock`:** `perKey.key =
  agentLoopKey(agentId)` (imports `agentLoopKey` from `./workflow.mjs` alongside
  the existing `recordLoopBlock` / `loopBlockFields` import).
- **`hook-dispatcher.mjs` `handleSubagentStop` success clear:**
  `appendMapDelete(parsed, 'subagent_stop_blocks', agentLoopKey(parsed.agentId))`
  (imports `agentLoopKey` from `./workflow.mjs`).

## Consequences

The `_session` fallback lives in one function. A future rename or guard is a
single-site change. No behavior change — `agentLoopKey` is the identical
expression factored out.

## Test plan

- `test/unit/workflow.test.mjs`: add a small `agentLoopKey` test
  (`agentLoopKey('a') === 'a'`, `agentLoopKey(undefined) === '_session'`,
  `agentLoopKey('') === '_session'`).
- Existing `loopBlockCount` / `recordLoopBlock` / `emitLoopAwareBlock` tests
  unchanged (identical behavior).

## Files in scope

- `plugins/agnthive/modules/workflow.mjs`
- `plugins/agnthive/modules/summary-contract.mjs`
- `plugins/agnthive/modules/hook-dispatcher.mjs` (`handleSubagentStop` only)
- `test/unit/workflow.test.mjs`

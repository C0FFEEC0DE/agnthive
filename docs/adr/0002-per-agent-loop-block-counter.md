# ADR 0002: Per-agent loop-block counter for SubagentStop

- **Status:** Accepted; amended implementation present in baseline `2cd40df`. Reset semantics further amended by ADR 0010, implementation pending.
- **Decides:** The `subagent_stop` loop-block counter is keyed by `agent_id`;
  the `stop` prefix remains session-global.

## Review update (2026-10-19)

Per-agent counters and per-key `map_set`/`map_delete` events remain the accepted
concurrency contract. The historical context below predates their implementation.

[ADR 0010](0010-task-and-agent-lifecycle-identity.md) supersedes the assumption
that every UserPromptSubmit is a fresh human task and may clear the whole map.
The new reset policy is pending implementation: preserve active siblings on
continuations and clear only state belonging to a confirmed lifecycle boundary.
`map_clear` remains a valid reducer operation, not permission to discard live
agents' entries. ADR 0005/0006 still govern per-key writes and fallback keys.

## Context

The `subagent_stop` loop-block counter is a single session-global scalar
`subagent_stop_block_count` (`state.mjs` DEFAULT_STATE:70;
`workflow.mjs loopBlockFields`:247). `recordLoopBlock` (`workflow.mjs:263`)
increments when `reason`+`message` match the previous values, with **no
`agent_id` dimension**. `emitLoopAwareBlock` (`summary-contract.mjs:285-303`)
fires `continue: false` (hard stop) at `count >= 3`.

Because the counter is shared across all subagents in the session, three
**different** subagents returning identical invalid output (the same block
reason + the same message text) accumulate to 3 and terminate processing
entirely via `continue: false` — even though no single agent retried 3 times.

**Failure mode:** In a parallel workflow, multiple agents returning identical
structured/empty output each get blocked once; the shared counter hits 3 →
`continue: false` → the whole subagent processing stops. Verified: the test
fixture `state_subagent_stop_repeated_files_block.json` seeds the global
`subagent_stop_block_count: 3` and `cases.json:290`
(`subagent_stop_escalates_repeated_same_block_reason`) asserts the hard stop,
enshrining the session-global behavior.

## Decision

Key the `subagent_stop` loop-block counter by `agent_id`. Replace the three
scalar fields with a per-agent map
`subagent_stop_blocks: { [agentId]: { count, reason, message } }`. The `stop`
prefix stays a session-global scalar (the main agent has no `agent_id`). When
`agent_id` is absent, fall back to a shared `_session` key so the safety
backstop still works for runtimes that omit `agent_id`.

## Pinned interface contract

The state event log applies `set_many` patches via a shallow `Object.assign`
(`state.mjs applyEvent`), so per-agent map patches are constructed by
read-merge-write at the patch-construction layer (the event log stays
append-only; each `set_many` replaces the field with the fully merged map).

> **Superseded for `subagent_stop`** by the [Amendment (race fix)](#amendment-race-fix):
> the `subagent_stop` prefix now persists per-key `map_set` / `map_delete`
> events instead of full-map `set_many`, so concurrent writers for different
> agents cannot clobber each other's entry. The `stop` prefix keeps `set_many`.

- **`state.mjs` `DEFAULT_STATE`:** add `subagent_stop_blocks: {}`. Keep the
  legacy `subagent_stop_block_count` / `subagent_stop_block_reason` /
  `subagent_stop_block_message` fields in DEFAULT_STATE for backward
  compatibility with old event logs (no longer read or written by the
  `subagent_stop` path; harmless).

  > **Superseded by [Amendment 2](#amendment-2-map_clear-reset--explicit-per-key-entry--scalar-cleanup):**
  > the legacy scalar fields were removed from DEFAULT_STATE and all fixtures.
  > Old `set_many` event logs that still carry them replay harmlessly (the
  > reducer `Object.assign`'s the keys back into existence with no consumer).

- **`workflow.mjs`:**
  - `loopBlockFields(prefix)`: `'stop'` →
    `{ countKey: 'stop_block_count', reasonKey: 'stop_block_reason', messageKey: 'stop_block_message', perAgent: false }`;
    `'subagent_stop'` → `{ mapKey: 'subagent_stop_blocks', perAgent: true }`;
    default `null`.
  - `loopBlockCount(state, prefix, agentId = null)`: `stop` → existing scalar
    read; `subagent_stop` →
    `Number(state?.subagent_stop_blocks?.[agentId || '_session']?.count) || 0`.
  - `recordLoopBlock(state, prefix, reason, message, agentId = null)`:
    `stop` → existing scalar patch; `subagent_stop` → read
    `state?.subagent_stop_blocks || {}`, key `= agentId || '_session'`,
    `prev = map[key]`,
    `nextCount = (prev?.reason === reason && prev?.message === message) ? (prev.count + 1) : 1`,
    return `{ subagent_stop_blocks: { ...map, [key]: { count: nextCount, reason, message } } }`.

    > **Superseded by [Amendment 2](#amendment-2-map_clear-reset--explicit-per-key-entry--scalar-cleanup):**
    > the per-agent return is now `{ mapKey, key, entry }` (the single changed
    > key plus its new entry, no full-map snapshot). The key uses `agentLoopKey`
    > (ADR 0006). The `stop` prefix return is unchanged.
  - `clearLoopBlockPatch(prefix, agentId = null, state = null)`: `stop` →
    existing scalar reset (ignores `agentId`/`state`); `subagent_stop` → read
    `state?.subagent_stop_blocks || {}`, delete key `agentId || '_session'`,
    return `{ subagent_stop_blocks: { ...mapWithoutKey } }`.
  - `userPromptResetPatch()`: add `subagent_stop_blocks: {}` alongside the
    existing stop-prefix resets (a new user prompt starts a fresh turn).

    > **Superseded by [Amendment 2](#amendment-2-map_clear-reset--explicit-per-key-entry--scalar-cleanup):**
    > `userPromptResetPatch()` now returns `{ scalar, mapClears }`; the
    > per-agent map is cleared via a `map_clear` event (not a scalar
    > `set_many`), for model consistency — all `subagent_stop_blocks`
    > mutations now flow through `map_*` events. (The clear is a deliberate
    > whole-map reset, not a per-key race fix — see Amendment 2 §A.)

- **`summary-contract.mjs`:**
  - `emitLoopAwareBlock(state, prefix, reason, message, agentId = null)`:
    calls `recordLoopBlock(state, prefix, reason, message, agentId)`; reads
    `count` from the returned patch (`patch.stop_block_count` for `stop`,
    `patch.subagent_stop_blocks[agentId || '_session'].count` for
    `subagent_stop`); `hardStop = count >= 3`; `stalled_by_policy`/`policy_stall_reason`
    only for the `stop` prefix (unchanged). Output shape unchanged.

    > **Superseded by [Amendment 2](#amendment-2-map_clear-reset--explicit-per-key-entry--scalar-cleanup)
    > / ADR 0005:** for the per-agent prefix, `recordLoopBlock` returns
    > `{ mapKey, key, entry }` and `emitLoopAwareBlock` threads it into a
    > returned `perKey = { mapKey, key, entry }` (count read from
    > `perKey.entry.count`); `patch` is `null` on that path. The `stop` prefix
    > is unchanged (scalar `patch`, `perKey` null).

- **`hook-dispatcher.mjs`:**
  - `emitBlock(parsed, state, prefix, reason, message, agentId = null)`:
    pass `agentId` to `emitLoopAwareBlock` and `persistPatch`.
  - `handleSubagentStop`: pass `parsed.agentId` as `agentId` to every
    `emitBlock` call and to the success clear:
    `persistPatch(parsed, clearLoopBlockPatch('subagent_stop', parsed.agentId, state));`
    (the `state` loaded at the top of the handler is passed through).

> **Superseded** by the [Amendment (race fix)](#amendment-race-fix): the
> `subagent_stop` persistence calls above are replaced by per-key `map_set`
> (in `emitBlock`) and `map_delete` (in the success clear). `clearLoopBlockPatch`
> is no longer called for the `subagent_stop` prefix. The `stop` prefix is
> unchanged.
  - `handleStop`: `emitBlock`/`clearLoopBlockPatch` calls for the `stop`
    prefix keep `agentId = null` (session-global, unchanged).

## Consequences

Each subagent gets its own 3-strike budget; cross-agent accumulation can no
longer terminate processing. The `stop` prefix (main agent) keeps its
session-global budget. Old event logs with legacy scalar fields are tolerated
(the fields persist harmlessly; the new map is authoritative).

## Amendment (race fix)

The original pinned contract wrote the per-agent map via `set_many` (a full-map
snapshot applied by a shallow `Object.assign`). Under **concurrent**
SubagentStop writers for different agents, each writer computes its full-map
snapshot from a state that does not yet include the other writer's new key; the
reducer applies the two `set_many` events in sequence order and the later one
clobbers the earlier writer's key (last-writer-wins over the whole map). A
sibling agent's freshly-written counter entry is lost.

The persistence path is therefore changed to **per-key map events**; the
read-merge-write at the patch-construction layer (`recordLoopBlock` /
`clearLoopBlockPatch`) is unchanged and stays pure, but the dispatcher no longer
persists the full-map snapshot for the `subagent_stop` prefix:

- **`state.mjs` `applyEvent`:** add `map_set` and `map_delete` event types
  (modeled on `role_increment`). `map_set { mapField, key, value }` sets one key
  on the map (coercing a non-object field to a fresh map); `map_delete
  { mapField, key }` deletes one key (a missing key is a no-op). Both touch a
  single key, so concurrent writers for different keys survive each other.
- **`hook-dispatcher.mjs`:**
  - `emitBlock`: for the `subagent_stop` prefix, extract the single changed
    entry `patch.subagent_stop_blocks[agentId || '_session']` from
    `recordLoopBlock`'s full-map patch and append a `map_set`; fall back to
    `persistPatch` only if the patch shape is unexpected. The `stop` prefix is
    unchanged (still `persistPatch` with the scalar patch).
  - `handleSubagentStop` success clear: append `map_delete` for
    `agentId || '_session'` instead of
    `persistPatch(parsed, clearLoopBlockPatch('subagent_stop', ...))`.
    `clearLoopBlockPatch` is no longer called for the `subagent_stop` prefix and
    has been reduced to scalar-only (its perAgent branch removed) so a future
    rewiring cannot reintroduce the full-map clobber; it remains in use for the
    `stop` prefix.

The race property is verified by `test/unit/state.test.mjs`
("race fix: interleaved map_set for different keys survives; set_many would
not", which also demonstrates the old `set_many` path losing a key) and by the
integration case `subagent_stop_clear_isolates_other_agents`
(`cases.json`), which seeds two agents and asserts clearing one leaves exactly
the other.

## Test plan

- Unit (`test/unit/workflow.test.mjs`): `recordLoopBlock` per-agent
  increment/reset; `loopBlockCount` per-agent; `clearLoopBlockPatch` removes
  only the targeted agent key; `stop` prefix unchanged.
- Unit (`test/unit/summary-contract.test.mjs`): `emitLoopAwareBlock`
  `subagent_stop` hardStop at 3 **for the same agent**; two different agents
  each blocked twice → neither hardStops; `stop` hardStop unchanged.
- Unit (`test/unit/state.test.mjs`): DEFAULT_STATE includes
  `subagent_stop_blocks: {}`.
- Hook integration: update `state_subagent_stop_repeated_files_block.json` →
  `subagent_stop_blocks: { "agent-xyz": { count: 3, reason: "...", message: "..." } }`;
  add `agent_id: "agent-xyz"` to `subagent_stop_missing_files.json` and
  `subagent_stop_complete_loop_reset.json` (same agent_id so the clear targets
  it); update `cases.json` `state_jq`:
  `subagent_stop_clears_loop_state_after_valid_summary` → `.subagent_stop_blocks == {}`;
  `subagent_stop_allows_loose_concrete_outcome_keywords` → `.subagent_stop_blocks == {}`;
  `subagent_stop_escalates_repeated_same_block_reason` → still asserts
  `hardStop == true`/`continue == false` (now per-agent). Add a new case
  `subagent_stop_per_agent_no_cross_agent_hardstop`: seed agent-A at count 2,
  block agent-B with the same reason+message → agent-B count 1 (not hardStop),
  assert `.decision == "block"` and `.hardStop == false`.

## Files in scope

- `plugins/agnthive/modules/workflow.mjs`, `summary-contract.mjs`, `state.mjs`
- `test/unit/workflow.test.mjs`, `test/unit/summary-contract.test.mjs`,
  `test/unit/state.test.mjs`
- `test/hooks/fixtures/state_subagent_stop_repeated_files_block.json`,
  `test/hooks/fixtures/subagent_stop_missing_files.json`,
  `test/hooks/fixtures/subagent_stop_complete_loop_reset.json`,
  `test/hooks/cases.json`

## Amendment 2 (map_clear reset + explicit per-key entry + scalar cleanup)

The Amendment (race fix) left two gaps a `/simplify` altitude review surfaced,
plus residue from the original migration. This amendment closes them so the
"all `subagent_stop_blocks` mutations flow through `map_*` events" invariant
holds with no exceptions, and the ADR-0005 "carry the entry explicitly" intent
is literally true.

### A. `map_clear` event for the turn reset (model consistency, not a race fix)

`userPromptResetPatch()` originally folded `subagent_stop_blocks: {}` into a
scalar `set_many` (Object.assign). That made the invariant "all
`subagent_stop_blocks` mutations flow through `map_*` events" have exactly one
exception — a scalar `set_many` overloading a map field. A future reader
auditing who mutates the map would have to know about this one scalar path.

Routing the reset through a typed `map_clear` event closes that exception: the
map is now mutated only by `map_*` events, so the model is self-consistent.

**Important — this is NOT a per-key race fix.** A clear is intentionally
whole-map (a new user prompt starts a fresh turn, so stale per-agent blocks
should not carry over). A concurrent `map_set` for a sibling agent appended
*before* the `map_clear` is wiped, exactly as the old `set_many` would have
wiped it; a `map_set` appended *after* the clear survives. `map_clear` has the
same ordering semantics as the old `set_many`-with-empty-map — it does not, and
cannot, preserve a key written before a whole-map clear. The ADR-0002 race fix
proper is the **per-key `map_set`/`map_delete` write path** (two agents
incrementing concurrently no longer clobber each other's key); the reset is a
deliberate clear, not a concurrent per-key write. The benefit of `map_clear`
over `set_many` here is model consistency (typed event, no scalar overload), not
race-safety.

- **`state.mjs` `applyEvent`:** add a `map_clear { mapField }` event
  (the last member of the `map_*` family) that sets `state[mapField] = {}`
  after a non-string/empty `mapField` guard. Atomic, single-event, no key
  dimension.
- **`workflow.mjs` `userPromptResetPatch()`:** now returns
  `{ scalar: { stop_block_count, stop_block_reason, stop_block_message,
  stalled_by_policy, policy_stall_reason }, mapClears: ['subagent_stop_blocks'] }`.
- **`hook-dispatcher.mjs` `handleUserPromptSubmit`:** persists `scalar` via one
  `set_many`, then appends one `map_clear` per entry in `mapClears`.

### B. `recordLoopBlock` carries the per-key entry explicitly (ADR 0005 literal)

`recordLoopBlock`'s per-agent branch returned a full-map snapshot
`{ [mapKey]: { ...map, [key]: entry } }`, which `emitLoopAwareBlock` then dug
back out (`patch[mapKey][key]`) to build `perKey`. The full-map spread was dead
work — the dispatcher persists only the single `entry` via `map_set`.

- **`workflow.mjs` `recordLoopBlock`:** the per-agent return is now
  `{ mapKey, key, entry }` (the single changed key + its new entry, no map
  spread). The `key` uses `agentLoopKey(agentId)` (ADR 0006). The `stop` prefix
  scalar return is unchanged.
- **`summary-contract.mjs` `emitLoopAwareBlock`:** builds `perKey` directly from
  the `recordLoopBlock` result; `count` is read from `perKey.entry.count`; the
  returned `patch` is `null` on the per-agent path (the dispatcher uses `perKey`
  alone) and the scalar patch (with `stalled_by_policy`/`policy_stall_reason`
  folded in) on the `stop` path. `perKey` is `null` on the `stop` path.
- **`hook-dispatcher.mjs` `emitBlock`:** unchanged — `if (perKey) appendMapSet(...)
  else persistPatch(patch)`; on the per-agent path `patch` is now `null` and
  unused.

### C. Legacy scalar fields removed

`subagent_stop_block_count` / `_reason` / `_message` in `DEFAULT_STATE` and
~30 fixtures were dead (no `subagent_stop` path reads or writes them). Removed
from `DEFAULT_STATE` and stripped from every fixture that carried them. Old
`set_many` event logs that still write these keys replay harmlessly: the reducer
`Object.assign`'s them back into the state object, where they sit with no
consumer.

### D. Supporting cleanup (cross-referenced from ADR 0005/0006 and /simplify)

- `loopBlockFields` returns frozen module-level constants (no per-call
  allocation on the block hot path).
- `state.mjs` shares one `mapMutationContext` validator between `map_set` and
  `map_delete` (dedup guards).
- `agents.mjs` exports `isGenericType(x)` (replacing 3 `GENERIC_TYPES.includes`
  sites) and `shouldEnforceSubagentFooter` takes an optional precomputed
  `aliasesLoaded` boolean; the dispatcher caches `ALIASES_LOADED` once at module
  init and passes it, avoiding a per-SubagentStop `Object.keys` allocation.

### Test plan (Amendment 2)

- `test/unit/state.test.mjs`: `map_clear` empties the targeted map; non-string
  `mapField` is a no-op; DEFAULT_STATE no longer carries the legacy scalars
  (asserts `undefined`).
- `test/unit/workflow.test.mjs`: `recordLoopBlock` per-agent returns
  `{ mapKey, key, entry }`; `userPromptResetPatch` returns
  `{ scalar, mapClears: ['subagent_stop_blocks'] }`.
- `test/unit/summary-contract.test.mjs`: per-agent `patch` is `null` and
  `perKey` carries the entry; the two-agent fold uses `perKey` to accumulate.

## Files in scope (Amendment 2)

- `plugins/agnthive/modules/state.mjs`, `workflow.mjs`, `summary-contract.mjs`,
  `agents.mjs`, `hook-dispatcher.mjs`
- `test/unit/state.test.mjs`, `workflow.test.mjs`, `summary-contract.test.mjs`,
  `agents.test.mjs`
- `test/hooks/fixtures/*.json` (legacy scalar fields stripped from ~30 fixtures)

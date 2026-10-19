# ADR 0005: Carry the per-key loop-block entry explicitly to the dispatcher

- **Status:** Accepted; amended implementation present in baseline `2cd40df`.
- **Decides:** `emitLoopAwareBlock` returns the per-key entry (`{ mapKey, key,
  entry }`) it already computed, so the dispatcher emits `map_set` directly
  instead of re-reading the full-map patch.

## Review update (2026-10-19)

Retained by the new design. The final amendment below is the implemented
contract: `recordLoopBlock` returns `{ mapKey, key, entry }` directly for an
agent, and the dispatcher persists that entry without constructing a whole-map
patch. Earlier full-map clauses are historical. Changes to task reset boundaries
in [ADR 0010](0010-task-and-agent-lifecycle-identity.md) must preserve this write
contract.

## Context

ADR-0002 routes the `subagent_stop` block write through a per-key `map_set`.
But `recordLoopBlock` still returns a **full-map** patch
(`{ subagent_stop_blocks: { ...map, [key]: entry } }`), and `emitBlock` re-reads
the single changed entry back out of that snapshot:

```js
const entry = patch?.[f.mapKey]?.[key];   // hook-dispatcher.mjs emitBlock
```

`emitLoopAwareBlock` also reads `count` back out of the same patch
(`patch?.[fields.mapKey]?.[agentId || '_session']?.count`). So the full-map
snapshot is built (an O(n_agents) spread), then read back twice, for a write
that touches one key. Because the re-read can fail to find the entry only if
`recordLoopBlock`'s shape changes, `emitBlock` carries a defensive "missing
entry → stderr + skip" branch against a re-clobbering fallback.

**Failure mode:** not a correctness bug — a design-cleanliness gap. The
defensive branch is dead-by-construction today but is a latent footgun (it
exists precisely to avoid falling back to the clobbering `set_many` path), and
the double read-back is wasted work on every `subagent_stop` block. (Maps hold
a handful of agents and SubagentStop fires once per subagent end, so the cost is
small — this is cleanliness, not a hot-path bottleneck.)

## Decision

Have `emitLoopAwareBlock` return the per-key entry it already computed, and have
`emitBlock` consume it directly. The dispatcher then never reads the full-map
patch for a per-agent write, and the defensive missing-entry branch is removed
(entry is present by construction). `recordLoopBlock`'s full-map patch is kept
unchanged so its pure-patch contract and unit tests are unaffected; the patch is
still returned for the scalar `stop` prefix (persisted via `set_many`).

## Pinned interface contract

- **`summary-contract.mjs` `emitLoopAwareBlock(state, prefix, reason, message, agentId = null)`:**
  return object adds `perKey`:
  - for a per-agent prefix: `perKey = { mapKey, key, entry }` where
    `key = agentLoopKey(agentId)` (ADR 0006), `mapKey = fields.mapKey`, and
    `entry = patch?.[mapKey]?.[key]` (the `{ count, reason, message }` record
    `recordLoopBlock` placed there);
  - for a session-global prefix: `perKey = null`.
  The existing `patch` / `output` / `hardStop` / `finalReason` fields are
  unchanged. `count` is still read from the patch (no behavior change).

- **`hook-dispatcher.mjs` `emitBlock`:** for a per-agent prefix
  (`loopBlockFields(prefix)?.perAgent`), emit
  `appendMapSet(parsed, perKey.mapKey, perKey.key, perKey.entry)` directly from
  the returned `perKey`. The `patch?.[f.mapKey]?.[key]` re-read and the
  "missing entry → stderr + skip" defensive branch are removed: `perKey.entry`
  is guaranteed by `recordLoopBlock` for a per-agent prefix. The scalar `else`
  branch (`persistPatch(parsed, patch)`) is unchanged.

## Consequences

The per-agent write path no longer re-reads the full-map snapshot; the entry
flows once from `recordLoopBlock` → `emitLoopAwareBlock` → `emitBlock`. The
latent re-clobber fallback branch is gone. The full-map spread inside
`recordLoopBlock` remains by design (negligible; retained to preserve
`recordLoopBlock`'s contract and tests). Behavior is unchanged for both
prefixes.

## Test plan

- Existing `test/unit/summary-contract.test.mjs` `emitLoopAwareBlock` tests
  (destructure `output`/`hardStop`/`patch`) still pass; add assertions that
  `perKey` is `{ mapKey, key, entry }` for `subagent_stop` and `null` for `stop`.
- Existing `test/unit/dispatcher.test.mjs` and hook integration cases
  (`subagent_stop_*`) still pass unchanged (the persisted `map_set` payload is
  identical).

## Files in scope

- `plugins/agnthive/modules/summary-contract.mjs` (`emitLoopAwareBlock`)
- `plugins/agnthive/modules/hook-dispatcher.mjs` (`emitBlock`)
- `test/unit/summary-contract.test.mjs`

## Amendment: `recordLoopBlock` returns the entry directly

The original decision kept `recordLoopBlock`'s full-map patch unchanged and had
`emitLoopAwareBlock` dig the entry back out of it. A later `/simplify` pass
(ADR-0002 Amendment 2) made the "carry the entry explicitly" intent literal:
`recordLoopBlock`'s per-agent branch now returns `{ mapKey, key, entry }` — the
single changed key plus its new `{ count, reason, message }` entry, with no
full-map spread — and `emitLoopAwareBlock` builds `perKey` straight from it.

Superseded contract clauses (original decision):

- "`recordLoopBlock`'s full-map patch is kept unchanged so its pure-patch
  contract and unit tests are unaffected" — **superseded**: the per-agent return
  is now `{ mapKey, key, entry }` (the `stop` scalar return is unchanged).
  `test/unit/workflow.test.mjs` `recordLoopBlock` assertions were updated to the
  new shape.
- `emitLoopAwareBlock` `entry = patch?.[mapKey]?.[key]` — **superseded**: `perKey`
  is now the `recordLoopBlock` result directly; `count` is read from
  `perKey.entry.count`. The returned `patch` is `null` on the per-agent path
  (the dispatcher uses `perKey` alone); the scalar `stop` patch is unchanged.
- `emitBlock` "the `patch?.[f.mapKey]?.[key]` re-read ... is removed" — holds
  (the re-read is gone; `emitBlock` is unchanged: `if (perKey) appendMapSet(...)
  else persistPatch(patch)`).

The `perKey` shape (`{ mapKey, key, entry }` for per-agent, `null` for scalar)
and the `emitBlock` consumption contract are unchanged from the original
decision; only the source of `perKey` moved from "dug out of a full-map patch"
to "returned directly by `recordLoopBlock`".

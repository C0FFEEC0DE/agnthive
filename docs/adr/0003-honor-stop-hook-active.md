# ADR 0003: Honor `stop_hook_active` in the Stop hook

- **Status:** Accepted; amended yield policy implemented in baseline `2cd40df`. Completion semantics clarified by ADR 0009/0011, implementation pending.
- **Decides:** When `stop_hook_active` is true **and** there is evidence of a
  prior block this session, `handleStop` yields (clears loop state and passes
  through) instead of re-blocking.

## Review update (2026-10-19)

The original context describes code before this decision was implemented.
The current runtime reads the flag and uses `hasPriorStopBlock`.

The one-feedback-cycle yield is an **agnthive policy**, not a Claude Code
requirement to allow the second stop unconditionally. The current
[Stop reference](https://code.claude.com/docs/en/hooks#stop) describes the flag
as continuation after a stop hook and documents a separate continuation cap.
The plugin's existing conservative yield is retained; assertions below that
call a one-block limit mandatory runtime behavior are historical rationale,
superseded by this clarification.

Yielding prevents a loop; it does not prove that verification or review passed.
[ADR 0009](0009-completion-evidence-over-role-quotas.md) requires unresolved
evidence to survive turn termination, and
[ADR 0011](0011-explicit-hook-failure-and-permission-policy.md) distinguishes
that outcome from successful completion. No new runtime behavior is implemented
by this documentation update.

## Context

Claude Code provides `stop_hook_active` to Stop hooks to prevent infinite
re-blocking loops: when true, the hook is being re-invoked after its own
previous block and should not block again. The plugin never reads
`stop_hook_active` (`grep` for `stop_hook_active` across `plugins/agnthive/`
returns zero matches). It reinvents loop prevention with a session-global 3x
counter (`stop_block_count`). This diverges from the standard Claude Code
contract and the project's own spec references.

**Failure mode:** Without honoring `stop_hook_active`, the plugin relies solely
on its 3x counter. Runtimes that set `stop_hook_active` expect the hook to yield
on the second invocation, but the plugin may block again (up to 3x),
contradicting the standard loop-prevention contract. Verified (bug report `1`,
claim 4).

## Decision

Capture `stop_hook_active` from the hook input. In `handleStop`, when
`parsed.stopHookActive === true`, short-circuit: clear the `stop` loop-block
state and return `passthrough()` (allow the stop), honoring the standard
contract. The 3x counter remains as a backstop for runtimes that do not emit
`stop_hook_active`.

## Pinned interface contract

- **`hook-input.mjs` `parseHookInput`:** the returned object adds
  `stopHookActive: data.stop_hook_active === true` (boolean).
- **`hook-dispatcher.mjs` `handleStop`:** at the very top, immediately after the
  `loadStateFor` null check and **before** the `stalled_by_policy` check, add:
  ```js
  if (parsed.stopHookActive === true) {
    persistPatch(parsed, clearLoopBlockPatch('stop'));
    return passthrough();
  }
  ```
  Rationale: `stop_hook_active` means the runtime is asking the hook not to
  block again; yielding first avoids any loop, even for a policy-stalled
  session (whose terminal cancel was already emitted once).

  > **Superseded by [Amendment (gate the yield on a prior block)](#amendment-gate-the-yield-on-a-prior-block):**
  > the unconditional yield above is gated on evidence of a prior block this
  > session (`state.stop_block_count > 0 || state.stalled_by_policy === true`).
  > A first-invocation `stop_hook_active` (no prior block) falls through to
  > normal enforcement instead of silently disabling it.

## Consequences

When the runtime sets `stop_hook_active`, the footer contract gets at most ONE
block per stop cycle (standard Claude Code behavior); the agent must heed the
first block or be allowed to stop. The 3x counter still guards runtimes without
the flag. Trade-off: a slightly stricter retry budget when `stop_hook_active` is
present — this is the documented contract.

## Test plan

- Unit (`test/unit/hook-input.test.mjs`): `parseHookInput` returns
  `stopHookActive: true` when `stop_hook_active: true`; `false` when absent /
  non-boolean.
- Unit (`test/unit/dispatcher.test.mjs`): Stop with `stop_hook_active: true` +
  `code_changed: true` + missing footer → `passthrough()` (no block); Stop
  without `stop_hook_active` + `code_changed: true` + missing footer → block
  (existing behavior preserved).

  > **Amended:** the first assertion above is split into two —
  > `stop_hook_active: true` with **no prior block** → block (enforcement
  > proceeds, the hardening); `stop_hook_active: true` **with a prior
  > `stop_block_count`** → `passthrough()`. The `stalled_by_policy` yield is
  > covered by the pre-existing order-of-operations test. See the Amendment.
- Hook integration: add a stop fixture + case
  `stop_hook_active_yields_even_when_footer_missing` (seed `code_changed: true`,
  missing footer, `stop_hook_active: true`) expecting passthrough. Existing
  stop_guard fixtures must NOT set `stop_hook_active` (preserve block behavior).

## Files in scope

- `plugins/agnthive/modules/hook-input.mjs`
- `plugins/agnthive/modules/hook-dispatcher.mjs` (`handleStop` only)
- `test/unit/hook-input.test.mjs`, `test/unit/dispatcher.test.mjs`,
  `test/hooks/fixtures/stop_*.json`, `test/hooks/cases.json`

## Amendment (gate the yield on a prior block)

The original decision yielded **unconditionally** on `stop_hook_active === true`.
A `/simplify` risk review flagged a latent failure mode: a runtime that
erroneously sets `stop_hook_active` on a **first** Stop invocation (no prior
block this session) would, under the unconditional yield, silently disable all
Stop enforcement for the session — the verification gate, agent-handoff checks,
and footer contract would all be skipped, with no record that anything was
enforced. The standard contract says `stop_hook_active` means "I am re-invoking
you after your own block," so a prior block is always present when the flag is
set correctly; gating on it makes that assumption explicit and turns a
misbehaving runtime into a degraded-but-enforced path instead of a silently
un-enforced one.

### Decision

The top-of-`handleStop` yield is gated on evidence of a prior block this
session:

```js
if (parsed.stopHookActive === true && (Number(state.stop_block_count) > 0 || state.stalled_by_policy === true)) {
  persistPatch(parsed, clearLoopBlockPatch('stop'));
  return passthrough();
}
```

`stop_block_count > 0` covers the common re-invocation case (our 3x counter
recorded at least one prior block); `stalled_by_policy === true` covers the
terminal policy-stall re-invocation (the order-of-operations guarantee from the
original decision is preserved — the stall check sits *after* this guard, so a
stalled session still yields when the runtime asks). When neither holds, the
flag is treated as spurious and normal enforcement proceeds.

> **Refinement:** the two-field condition is encapsulated in
> `hasPriorStopBlock(state)` (`workflow.mjs`), which reads the count through
> `loopBlockCount(state, 'stop')` (the declared single read path) rather than
> restating the scalar field name inline. The shipped guard is
> `if (parsed.stopHookActive === true && hasPriorStopBlock(state)) { ... }`; the
> inline form above is retained as the readable expansion of the predicate.

### Consequences

A first-invocation `stop_hook_active` with no prior block no longer yields;
enforcement runs as if the flag were absent. This is a behavior change only for
runtimes that set `stop_hook_active` before any block occurred — i.e. non-
conformant runtimes — for which the old behavior was "silently disable
enforcement" and the new behavior is "enforce normally." Conformant runtimes
(that set the flag only on re-invocation) are unaffected: a prior block is
present, so the guard is satisfied and the yield behaves exactly as before.

### Test plan (Amendment)

- `test/unit/dispatcher.test.mjs`: `stop_hook_active: true` + `code_changed:
  true` + **no prior block** → `decision: 'block'` (enforcement proceeds, not a
  blind yield); `stop_hook_active: true` + a prior `stop_block_count` (one
  preceding block) → `passthrough()` (yield honored). The pre-existing
  `stalled_by_policy` order-of-operations test still asserts the yield path for
  a terminal stall.

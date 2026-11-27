# ADR 0014: Standing-context budgets and a single-source handoff contract

- Status: Accepted
- Date: 2026-11-26
- Amends: [0008](0008-root-orchestration-and-three-specialists.md) (lean profile
  wording), [0009](0009-completion-evidence-over-role-quotas.md) (completion is
  evidence, so repeated prose is not a gate), [0013](0013-ledger-restoration-and-minimal-telemetry.md)
  (state retention).
- Baseline: `02393fa`, plugin `0.5.0`.

## Context

The plugin's instruction surfaces are paid for on every session, every prompt,
or every dispatch, whether or not they carry new information. Measured at the
baseline revision:

- output style: 3,063 chars, sent with every request (`force-for-plugin`);
- skill descriptions: 1,868 chars always resident; skill bodies 18,254 chars on
  invocation;
- agent descriptions: 326 chars always resident; agent prompts 13,341 chars per
  dispatch;
- `UserPromptSubmit` injection: 617–814 chars on nearly every prompt, carrying
  ADR and plan-task references, and a sentence stating that footer lines are
  "reporting guidance, not blocking gates" while the Stop handler does block;
- Stop blocks: 1.3–2.4 KB per block, up to three per turn, of which 0.8–1.5 KB
  is a fixed checklist and the rest is **the assistant's own final message
  echoed back**;
- `PostToolUse` edit reminder: 105 chars on every code edit; `SubagentStart`
  handoff paragraph: 268 chars on every dispatch;
- references: 63.8 KB, with the three workflow shapes 45–49% identical;
- session state: every event replayed on every load, snapshots never refreshed,
  `trimEvents` defined but never called, so cost grew linearly per session.

The same handoff footer contract appeared in 11 files and the "removed in 0.5.0
/ plan task 16" provenance in 10, so removing a role cost more tokens than the
role ever did.

Anthropic's current Claude Code guidance supports the same conclusions: skill
bodies should stay small with detail in sibling files, descriptions are
always-on cost, output-style instructions are sent with every request, hook
output costs nothing until a hook returns output, and the same instruction
should not be duplicated across two standing surfaces.

## Decision

1. **Standing context is budgeted and enforced.** `scripts/validate.mjs`
   (`checkContextBudget`) fails validation when a surface exceeds its budget:

   | Surface | Budget (chars) |
   |---|---|
   | output style body | 1,600 |
   | all skill descriptions | 2,400 |
   | all agent descriptions | 600 |
   | one skill body | 2,800 |
   | one agent prompt | 3,000 |

   Budgets are character counts, not model-specific tokens: they are a stable,
   model-independent proxy for cost. Raising a budget is a contract change and
   requires an ADR amendment before the code change.

2. **The handoff contract has one canonical definition per audience.** The root
   session reads it from the output style; a subagent reads one line in its own
   prompt. Skills do not restate the footer fields, and the runtime does not
   inject a duplicate reminder on `SubagentStart` or `PostToolUse`.

3. **Per-prompt context is emitted only when it carries new information.** The
   `UserPromptSubmit` message is emitted on a new task, a task transition, or a
   change of workflow category, and is deduplicated by a signature stored in
   session state. A repeated category for the same open task emits nothing.

4. **Stop blocks report the failed check, not the answer.** A block carries the
   checklist of failed prefixes and the minimal valid template. It never echoes
   the assistant's message back into context.

5. **Operational text carries no historical narration.** Version, plan-task, and
   compatibility-window provenance lives in ADRs and CHANGELOG, not in prompts,
   skills, or injected messages.

6. **State I/O is batched and bounded.** A hook process queues its events and
   flushes them in one write; a snapshot is refreshed when replayed events
   exceed a threshold (`AGNTHIVE_STATE_SNAPSHOT_THRESHOLD`, default 50); the
   log is trimmed after a snapshot (`AGNTHIVE_STATE_MAX_EVENTS`, default 500).
   Batches are atomic: all events in one batch share a sequence number, and no
   code may assume one sequence number per event. Sequence allocation floors at
   the snapshot's `_last_seq`, because once events are trimmed the snapshot is
   the only copy of older state and a replay accepts only `seq > _last_seq`.

7. **ADR first.** A change to a hook contract, an injected message, a budget, or
   the state shape is recorded as an ADR (new or amendment) before the code
   change, and the ADR index is updated in the same change.

## Consequences

- The budgets are enforced by CI, so "fewer tokens" stays true instead of
  drifting back on the next feature.
- Enforcement semantics are unchanged: verification evidence, the `@cr` review
  for substantial changes, permission policy, and failure classification all
  behave as before. Only wording and emission frequency change.
- Character budgets do not distinguish cache-read from cache-write cost; they
  bound the standing prefix, which is the part paid repeatedly.
- Snapshot monotonicity is read-check-then-rename, not lock-free. A stale
  process can still finish its rename last; trimming is bounded by the on-disk
  snapshot sequence, so events are never deleted beyond what a snapshot covers.
- The dispatcher must adopt the queued flush to realize the batching benefit;
  until then `appendEvent` remains a flush-of-one with unchanged behavior.

## Verification

`node scripts/validate.mjs` (budget check plus the existing link, manifest, and
frontmatter checks), `node --test test/unit/*.test.mjs`, and the hook contract
harness. Behavior parity is asserted by the existing role, verification, and
gate tests, which are not relaxed by this change.

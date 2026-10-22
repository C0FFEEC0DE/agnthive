# Architecture Decision Records

Architectural decisions for `agnthive`. Updated 2026-10-19 from the
[harness/workflow review](../specs/2026-10-19-harness-review-and-simplification-design.md)
and its [implementation plan](../plans/2026-10-19-harness-modernization-and-simplification.md);
implementation status refreshed 2026-10-21.

## Status and precedence

**Accepted** records an architectural decision, not proof of implementation.
Implementation status is stated separately. Baseline observations refer to
`2cd40df` / plugin `0.3.0`. The 0.4.0 tree (commit `efabe5a`) implements
ADR 0008–0013 and the 2026-10-19 plan tasks 01–15 (evidence model, lifecycle
identity, failure policy, ledger restoration, outcome suite, lean profile
shipped experimental with `legacy` still the default); host canaries on the
pinned CLI remain pending (plan task 14), and removing legacy components
requires the rollout gates in ADR 0012 (plan task 16, deferred to the
compatibility window — the eight agent definitions still ship in
`plugins/agnthive/agents/`).

**Update (2026-10-22): the lean default flip has HAPPENED.** The ADR 0012
rollout gate was exercised to completion on a live arm x repetition matrix
(`native` / `legacy` / `lean`, three paired repetitions per task, nine tasks,
75 cells) and reported `gate_inputs.available: true` with no new false
completions, no permission regressions and no lost material findings against
either baseline. `lean` is now the default workflow profile; `legacy` stays
selectable for one transition release and its removal stays deferred to the
compatibility window (plan task 16). The gate evidence and the two findings
the matrix surfaced are recorded in `plugins/agnthive/CHANGELOG.md` and
`docs/benchmarking.md`.

The lean **default** flip has **not** happened. ADR 0012 gates it on a live
outcome-benchmark run, and the gate has not been exercised to completion:
`gate_inputs` can only be reported as `available: true` for a live run that
executed every involved arm (`native` / `legacy` / `lean`) with at least
`MIN_LIVE_REPS` repetitions per task. The arm × repetition execution loop
that produces those per-(arm, task, rep) records now exists
(`scripts/run-benchmark.mjs --arms/--reps`, one summary per arm under
`<output-dir>/arms/<arm>/`), and a live two-arm run on the pinned CLI
confirms the path end to end — the `native` arm registers no plugin hooks and
finds no plugin state, the `legacy` arm reads `evidence_source:
plugin_state`, and the suite emitter reports `reps=1` with a real
`outcome_pass_rate`. A full three-arm, three-repetition live matrix has not
been run, so the gate still reports `available: false` with its reasons
(`no lean-arm run present`, findings evidence missing). Lean therefore stays
experimental and `legacy` stays the default. See
[`docs/benchmarking.md`](../benchmarking.md) ("Outcome Suite") and the
[plan's execution status](../plans/2026-10-19-harness-modernization-and-simplification.md);
the current cycle's work is tracked in the local progress ledger
`.agnthive/progress.md` (a gitignored scratch file, not part of the checkout).

Dated amendments take precedence over historical snippets in the same ADR.
A later decision replaces only the scope it names; per-agent isolation and
plugin identity remain in force even when lean removes mandatory role gates.

## Index

| ADR | Decision | Implementation / relationship |
|-----|-------|--------|
| [0001](0001-scope-subagent-stop-footer-to-agnthive-specialists.md) | Scope specialist footer enforcement | Baseline scoping present; missing-alias gap noted. Lean replacement: 0009 |
| [0002](0002-per-agent-loop-block-counter.md) | Per-agent loop counters and map events | Amended baseline implementation; reset policy amendment pending in 0010 |
| [0003](0003-honor-stop-hook-active.md) | Bounded Stop yield | Baseline implementation; local policy clarified, unresolved outcomes governed by 0009/0011 |
| [0004](0004-strip-plugin-namespace-in-agent-label-canonicalization.md) | Namespaced agent normalization | Implemented only as narrowed by 0007; arbitrary-prefix stripping superseded |
| [0005](0005-carry-per-key-loop-block-entry-explicitly.md) | Explicit per-key entries | Amended baseline implementation; retained |
| [0006](0006-centralize-per-agent-loop-block-key.md) | Central agent key helper | Baseline implementation; retained |
| [0007](0007-namespace-prefix-is-plugin-identity.md) | Fixed plugin namespace identity | Baseline behavior; retained; rename obligation recorded here |
| [0008](0008-root-orchestration-and-three-specialists.md) | Root orchestration, three specialists, no mandatory Manager | Implemented in 0.4.0 (plan 10–13); host canaries (plan 14) pending; plan 16 deferred |
| [0009](0009-completion-evidence-over-role-quotas.md) | Current completion evidence instead of role/footer quotas | Implemented in 0.4.0 (plan 04, 09, 11, 13); host canaries (plan 14) pending; plan 16 deferred |
| [0010](0010-task-and-agent-lifecycle-identity.md) | Task/agent lifecycle and result ownership | Implemented in 0.4.0 (plan 02, 05–06, 09); host canaries (plan 14) pending |
| [0011](0011-explicit-hook-failure-and-permission-policy.md) | Explicit enforcement/advisory/telemetry failures | Implemented in 0.4.0 (plan 01–03, 08); host canaries (plan 14) pending |
| [0012](0012-versioned-harness-contracts-and-outcome-benchmarks.md) | Versioned contracts, outcome benchmarks, rollout gates | Implemented in 0.4.0 (plan 01–02, 09–10, 13); the lean default flip HAPPENED on 2026-10-22 — the outcome gate was exercised on a live 75-cell arm x repetition matrix and passed; plan 16 deferred |
| [0013](0013-ledger-restoration-and-minimal-telemetry.md) | Verified ledger restoration and bounded metadata | Implemented in 0.4.0 (plan 02, 07); host canaries (plan 14) pending |

## Historical correction

ADR 0001–0007 originated from an earlier untracked bug report. The previous index
called its `agent_transcript_path` claim refuted because the field was supposedly
undocumented. That assertion is withdrawn: the current
[SubagentStop reference](https://code.claude.com/docs/en/hooks#subagentstop)
documents the subagent transcript separately from the parent transcript.
Report ownership and fallback validation now belong to ADR 0010. This correction
does not claim the original bug report was fully reproduced or that runtime
fallback has already been fixed.

## Recording a change

Use a numbered ADR for a new independent decision. Include status, date, context,
decision, alternatives/tradeoffs, relationships, and acceptance evidence. Preserve
historical rationale with explicit amendments rather than silently presenting an
old design as current. Link implementation tasks and update implementation status
only after code and relevant checks exist.

# Architecture Decision Records

Architectural decisions for `agnthive`. Updated 2026-10-19 from the
[harness/workflow review](../specs/2026-10-19-harness-review-and-simplification-design.md)
and its [implementation plan](../plans/2026-10-19-harness-modernization-and-simplification.md).

## Status and precedence

**Accepted** records an architectural decision, not proof of implementation.
Implementation status is stated separately. Baseline observations refer to
`2cd40df` / plugin `0.3.0`. The 0.4.0 working tree implements ADR 0008–0013
(evidence model, lifecycle identity, failure policy, ledger restoration,
outcome suite, lean profile shipped experimental with `legacy` still the
default); host canaries on the pinned CLI remain pending (plan task 14), and
removing legacy components requires the rollout gates in ADR 0012 (plan
task 16, deferred to the compatibility window).

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
| [0008](0008-root-orchestration-and-three-specialists.md) | Root orchestration, three specialists, no mandatory Manager | Implemented in 0.4.0 (plan 10–13); plan 14 canaries + 16 deferred |
| [0009](0009-completion-evidence-over-role-quotas.md) | Current completion evidence instead of role/footer quotas | Implemented in 0.4.0 (plan 04, 09, 11, 13); 14/16 remain |
| [0010](0010-task-and-agent-lifecycle-identity.md) | Task/agent lifecycle and result ownership | Implemented in 0.4.0 (plan 02, 05–06, 09); 14 remains |
| [0011](0011-explicit-hook-failure-and-permission-policy.md) | Explicit enforcement/advisory/telemetry failures | Implemented in 0.4.0 (plan 01–03, 08); 14/15 remain |
| [0012](0012-versioned-harness-contracts-and-outcome-benchmarks.md) | Versioned contracts, outcome benchmarks, rollout gates | Implemented in 0.4.0 (plan 01–02, 09–10, 13); default switch gated by the outcome benchmark (plan 14), 16 deferred |
| [0013](0013-ledger-restoration-and-minimal-telemetry.md) | Verified ledger restoration and bounded metadata | Implemented in 0.4.0 (plan 02, 07); host delivery verification (plan 14) remains |

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

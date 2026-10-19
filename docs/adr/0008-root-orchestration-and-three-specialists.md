# ADR 0008: Root orchestration and three specialist agents

- **Status:** Accepted; implemented in 0.4.0 (working tree); host canaries pending (plan task 14); legacy removal deferred to the compatibility window (plan task 16).
- **Date:** 2026-10-19.
- **Decides:** The main session owns orchestration. The standard specialist set is Code Reviewer, Explorer, and Debugger; there is no mandatory Manager agent.
- **Basis:** [Harness review and design](../specs/2026-10-19-harness-review-and-simplification-design.md), agent-role assessment and findings F04/F06/F08.
- **Implementation:** [Plan](../plans/2026-10-19-harness-modernization-and-simplification.md), tasks 10–16.

## Context

The main session already owns the user request, tools, plan, delegation, and final response. A separate Manager repeats coordination and requires manager-specific background/idle exceptions. Current role gates prove that specialists started, not that their work improved the result. A benchmark that requires Manager dispatch cannot establish its value.

## Decision

The root session chooses the smallest sufficient workflow and delegates for an independent assessment, separate context, or a genuinely independent work item. A small task can run entirely in the root session.

| Existing role | Target treatment |
|---|---|
| Manager | Root orchestration skill; no automatic Manager spawn |
| Code Reviewer | Separate read-only reviewer for substantial changes |
| Explorer | Optional specialist for broad or unfamiliar code exploration |
| Debugger | Optional specialist for reproduction and root-cause investigation |
| Bugbuster | Static checks move to review; investigation moves to debug |
| Architect | Design/refactor procedures; delegate substantial alternative analysis when useful |
| Tester | Test procedure; delegate large verification work when useful |
| Docwriter | Docs procedure; delegate substantial documentation work when useful |

`/agnthive:manager` remains a compatible entry point, executing in the root context. Design, Test, Docs, and Refactor do not fork merely because they represent workflow stages. Reviewer receives exploration artifacts from the root; it must not promise delegation unavailable in its tool list.

Independent review is required for substantial changes, including security/permission boundaries, migrations, concurrency, public APIs, or multiple subsystems. Trivial and docs-only work may omit a separate reviewer with an explicit rationale. Prompt keywords or line count alone cannot waive review of a risky diff. Verification and review validity follow [ADR 0009](0009-completion-evidence-over-role-quotas.md).

## Alternatives considered

- Keep all eight roles mandatory: preserves ceremony and duplicates root coordination without proving completion.
- Remove all specialists: loses independent review and useful context isolation.
- Immediately delete all old definitions: breaks explicit legacy workflows before a migration path exists.

## Consequences and transition

Less role-specific prompting and manager state is expected, but cost and quality improvements must be measured, not asserted. An autonomous coordinator for a large subtask remains possible if justified; it is not part of the standard chain.

Introduce `lean` alongside `legacy`, compare outcome quality under [ADR 0012](0012-versioned-harness-contracts-and-outcome-benchmarks.md), then switch the default only after the quality gate passes. Keep deprecated definitions for explicit legacy use for one transition release. Remove them separately after that window; do not maintain two workflow engines indefinitely. Until then, three recommended specialists does not mean only three agent files are shipped.

## Acceptance evidence

- A normal lean task completes without Manager dispatch or an agent-count quota.
- Substantial implementation gets completed independent review of the resulting diff.
- Docs-only and plan-only requests do not trigger unnecessary implementation agents.
- Legacy entry points have explicit routing and migration notes.
- Outcome comparison reports quality and overhead separately from dispatch compliance.

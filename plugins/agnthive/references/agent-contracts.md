# Plugin agent contract matrix

This document turns agent expectations into an explicit repository contract.

Contract model ([ADR 0008](../../../docs/adr/0008-root-orchestration-and-three-specialists.md),
[ADR 0009](../../../docs/adr/0009-completion-evidence-over-role-quotas.md)):
the main session owns orchestration. Three **primary specialists** — Code
Reviewer, Explorer, Debugger — are agent definitions. Design, Test, Docs, and
Refactor are **root procedures** (the `/design` `/test` `/docs` `/refactor`
`/bug` skills plus the `/manager` orchestration procedure), not mandatory
agent forks. The legacy compatibility agents (Manager, Architect, Tester,
Docwriter, Bugbuster) are gone; their procedures stay as root skills. [ADR
0015](../../../docs/adr/0015-two-stage-review-and-alias-label-removal.md)
deleted their alias labels and made `/review` a root two-stage procedure
(`/simplify`, then `@cr`), so no skill is forked.

The contract has five layers:

1. `Hook-level contract` — Node hooks enforce workflow gates, summary fields, and completion safety
2. `Benchmark task contract` — the per-role smoke suite gives each shipped role focused benchmark coverage
3. `Bench runner assertions` — transcript patterns, used-agent signals, and changed-file checks validate actual behavior, not just exit codes
4. `Role benchmark suite` — `bench/tasks/subagents/smoke/*.json` (one task per shipped role; see below)
5. `Agent contract matrix` — the tables below map every agent to its expected handoff signal and benchmark coverage

## Hook-Level Contract

Hook enforcement is shared across agents and workflows:

- `UserPromptSubmit` classifies work and records the contract (`@cr` for the review-bearing categories; no mandatory role quotas — ADR 0009)
- `SubagentStart` normalizes aliases and records actual role use; generic Task tool types (`general-purpose`, `workflow-subagent`) are filtered from enforcement
- `Stop`, `TaskCompleted`, and `TeammateIdle` fall back to transcript launch lines and `@alias` mentions of a shipped specialist (`@explorer` -> `e`, `@code-reviewer` -> `cr`) when runtimes omit explicit `SubagentStart`; a skill-load line is not evidence (ADR 0015)
- `SubagentStop` requires a concrete handoff summary (a missing summary blocks); the footer lines themselves are reporting guidance, not a blocking contract
- `Stop`, `TaskCompleted`, and `TeammateIdle` block incomplete workflow completion
- `PostToolUse` and `PostToolUseFailure` track edit and verification state: completion is a `verification[]` record scoped to the current change revision — launched/pending is not passed, an unknown outcome is not passed, and a later code/config edit invalidates the earlier result ([ADR 0009](../../../docs/adr/0009-completion-evidence-over-role-quotas.md)); completed reviews land in `review_results[]`, and the agent registry (`agents{}`) keys lifecycle by stable agent id with per-key map events
- Failure policy ([ADR 0011](../../../docs/adr/0011-explicit-hook-failure-and-permission-policy.md)): events are classed `enforce` (PreToolUse, PermissionRequest, PermissionDenied, PostToolUseFailure), `guidance` (workflow gates), and `telemetry` (observability); an enforce-class handler that cannot run or classify blocks with a diagnostic, advisory stays neutral (no blanket allow), telemetry failures are nonblocking; every registration carries a `timeout` (`10s` sync / `30s` async) and the shared Bash/PowerShell PreToolUse safety registration carries `onFailure: "block"`; `PermissionDenied` emits the event-specific `hookSpecificOutput: { hookEventName: "PermissionDenied", retry }` envelope
- `StopFailure` is telemetry ([ADR 0013](../../../docs/adr/0013-ledger-restoration-and-minimal-telemetry.md)): one bounded record per observed turn failure in `stop-failure.jsonl` (`ts`, `session_id`, `error_name`, `exit_code`, `signal`, `agent_id`) — API error text is never logged and a failure never counts as completion
- `SessionStart` `compact`/`resume` restores a bounded task/revision summary and the ledger location ([ADR 0013](../../../docs/adr/0013-ledger-restoration-and-minimal-telemetry.md)); `PostCompact` is metadata-only bookkeeping
- `workflow_profile` (`lean`) selects the gate shape ([ADR 0008](../../../docs/adr/0008-root-orchestration-and-three-specialists.md)/0012): no role quotas, no Manager-idle gate, no footer blocking, and the review and current-verification gates stay. Since 0.5.0 the `legacy` profile is REMOVED — the key survives so an old userConfig does not break, and a session that still names `legacy` runs `lean` with an explicit migration note

Footers are a concise reporting shape, not proof of completion: they are
reporting guidance ([ADR 0009](../../../docs/adr/0009-completion-evidence-over-role-quotas.md)),
completion depends on current verification and completed review, and the stop
gate is bounded — turn termination after loop prevention does not convert a
failed check into a pass. The blocking footer gates are gone with the legacy
profile (0.5.0).

Relevant files (plugin Node runtime — the single `hook-dispatcher.mjs` handles every event that the legacy per-hook shell scripts used to):

- [`modules/hook-dispatcher.mjs`](../modules/hook-dispatcher.mjs) — event dispatch entrypoint (UserPromptSubmit, SubagentStart/Stop, Stop, TaskCompleted, PostToolUse, …)
- [`modules/summary-contract.mjs`](../modules/summary-contract.mjs) — handoff/stop-footer recognition
- [`modules/workflow.mjs`](../modules/workflow.mjs) — workflow-gate enforcement (required-role groups, stop/TaskCompleted blocks, task transitions, lean gate projection)
- [`modules/verification.mjs`](../modules/verification.mjs) — verification result normalization and revision scoping
- [`modules/plugin-config.mjs`](../modules/plugin-config.mjs) — `workflow_profile` resolution (`AGNTHIVE_WORKFLOW_PROFILE` > userConfig bridge > `lean`; the removed `legacy` value and any invalid value run `lean` with an explicit stderr note)
- [`hooks/hooks.json`](../hooks/hooks.json) — event → command manifest (exec form, timeouts, `onFailure`, PowerShell parity)

## Bench Runner Assertions

The behavioral runner checks more than pass/fail:

- `required_transcript_patterns` must appear in assistant-like transcript entries when the task is asserting a stable handoff shape
- `required_used_agents` and `required_used_agent_groups` must match actual `SubagentStart` / recorded handoff activity parsed from the debug log when the task is asserting role usage; explicit `Handoff evidence: @alias ...` transcript lines are treated as canonical handoff evidence for tasks that need a visible role-usage marker
- `forbidden_transcript_patterns` must not appear in assistant-like transcript entries
- changed-file scope, docs scope, and verification requirements are enforced per task
- verification-required benchmark tasks can use the fixture-appropriate local test command detected by the runner
- user prompts do not satisfy transcript assertions

Relevant files: repository benchmark runner, test suite, and forbidden-pattern corpus.

## Dispatch Contract Modes

A benchmark task may declare a `dispatch_contract` (`mode`, `required_agents`, `root_only`) to pin an exact specialist set and select how dispatch is enforced:

- **`standard`** (default, absent) — dispatch is union-credited: a real `SubagentStart` *or* a prose `Handoff evidence:` claim satisfies `required_used_agents`. A dispatch failure here is a real functional gap (the model did not even claim the role) and stays on the merge-blocking functional line.
- **`observed`** — strict: only a real `SubagentStart` (hook source) satisfies the contract; prose claims do not. A dispatch failure is an honest, non-blocking capability signal reported on the separate `dispatch-observed` line and excluded from the functional line.
- **`enforced`** — strict like `observed` for pass/fail, **and** backed by a harness `PreToolUse` hard guard. The plugin's `UserPromptSubmit` classifier parses the `BENCHMARK_DISPATCH_CONTRACT` marker and stashes `dispatch_contract_mode` to session state; the `PreToolUse` handler for `Edit|MultiEdit|Write|NotebookEdit` then denies any root edit until at least one required role has a `SubagentStart` recorded — forcing dispatch as a harness constraint rather than prompt discipline. Once the specialist starts (and is recorded in `subagents_started`), edits flow, including the specialist's own edits. Non-bench sessions never carry the marker, so the guard is inert for normal usage.

The `dispatch-enforced` CI line reports whether the model actually dispatched after the guard — a visible, non-blocking capability signal, never masked.

Relevant files: `plugins/agnthive/modules/workflow.mjs` (`parseDispatchContractMarker`, `classifyPrompt`), `modules/hook-dispatcher.mjs` (`handleUserPromptSubmit`, `enforceDispatchContract`), `modules/state.mjs` (`dispatch_contract_mode`), `hooks/hooks.json` (PreToolUse `EditWrite` registration). See `docs/benchmarking.md` for the full evidence-split and gate-line semantics.

## Role Benchmark Suite (compatibility)

The per-agent suite lives in `bench/tasks/subagents/smoke/`. Since 0.5.0 it
covers the three shipped roles (the smoke tasks of the removed compatibility
agents went with them). It measures dispatch compliance of a named role, not
orchestration-quality or cost; root orchestration is compared by the outcome
benchmarks instead ([plan task
10](../../../docs/plans/2026-10-19-harness-modernization-and-simplification.md)).
Repository validation currently requires every canonical agent alias to have
at least one smoke task, every subagent benchmark task to declare
`agent_alias`, non-empty `forbidden_transcript_patterns`, and at least one
required-behavior assertion — enforced by the repository validator
(`scripts/validate.mjs`).

## Primary Specialist Matrix

The **Tools** and **Effort** columns mirror each agent's frontmatter allowlist
and reasoning effort (`plugins/agnthive/agents/*.md`). Model pinning is
intentionally omitted to keep the plugin model-agnostic.

| Agent | Alias | Tools | Effort | Smoke task (compat suite) | Required signal | Forbidden transcript focus | Contract |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Code Reviewer | `cr` | `Read`, `Glob`, `Grep` | high | review-note smoke task | `Task:\s*Code Review`, `Findings:`, `Review outcome:`, plus stop-safe footer markers | no invented findings, no hook/footer repair chatter | completed independent read-only review of a substantial diff; may not dispatch agents and must not report verification it did not see |
| Explorer | `e` | `Read`, `Glob`, `Grep` | low | explorer code-map smoke task | `Task:\s*Explore`, `Locations:`, plus stop-safe footer markers | no meta chatter about prefix matching or shell guards | code map for large/unfamiliar areas on root request, prepared for the next step or the review dispatch |
| Debugger | `dbg` | `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash` | high | zero-division smoke task | `Task:\s*Debug`, `Reproduction:`, `Root cause:`, plus stop-safe footer markers | no footer-repair chatter | reproduce, isolate, root-cause, smallest defensible fix, covering regression test |

Delegation is by need — independent assessment, context isolation, or
genuinely independent parallel work ([ADR
0008](../../../docs/adr/0008-root-orchestration-and-three-specialists.md)).
The completion gate requires a started `@cr` review for feature, bugfix,
refactor, and review work, with an independent reviewer for a substantial
diff; docs-only work may record a rationale instead. The root passes
exploration artifacts into the review dispatch; the reviewer never promises a
delegation its tool list cannot perform.

## Root Procedure Matrix

These stages are root procedures; substantial work under them may be
delegated by need. Agent-facing contracts apply only when work is actually
delegated.

| Skill | Runs as | Delegates when | Required signal |
| --- | --- | --- | --- |
| `/manager` | root orchestration procedure | specialists by need (see primary matrix) | plan + honest completion report; no automatic Manager spawn |
| `/design` | root design procedure | unfamiliar/large mapping → `@e`; substantial alternative analysis → focused subagent | chosen solution, touched files, migration risks |
| `/test` | root verification procedure | large suite/sweep → focused subagent | completed covering test with exact command and outcome; launched run is pending, not passed |
| `/docs` | root docs procedure | substantial doc work → focused subagent | docs decision `updated`/`not_required`/`pending` with reason |
| `/refactor` | root refactoring procedure | substantial multi-file isolation → focused subagent | behavior preserved + completed covering verification; review when diff is substantial |
| `/bug` | root bug-investigation procedure | long/cross-file diagnosis → `@dbg` | root cause with evidence, smallest credible fix, covering regression test |
| `/debug` | root debugging procedure | long/cross-file diagnosis → `@dbg` | reproduction, isolation, root cause |
| `/explore` | root exploration procedure | large/unfamiliar area → `@e` | locations, control flow, next step |
| `/review` | root two-stage procedure (ADR 0015) | stage 1 `/simplify` in the root; stage 2 → `@cr`, read-only | reductions recorded + verification re-run, then completed independent review of the simplified diff |
| `/simplify` | root reduction procedure (stage 1 of `/review`) | — | behavior-preserving reductions with verification re-run |

A root procedure may produce its work without launching a subagent; when it
delegates, the delegated handoff uses the same stop-safe footer shape. Docs
decisions follow ADR 0009/0008: internal changes without new user-facing
semantics are `not_required`, with the reason recorded.

## Removed Compatibility Agents (0.5.0)

The compatibility window closed and plan task 16 removed the five
compatibility agent definitions; ADR 0015 then removed their alias labels, so
the alias map and the transcript fallback resolve only the three shipped roles.
A gate never demands a role the plugin can no longer produce (a state recorded
under the legacy profile is migrated to the shipped roles).

| Removed agent | Former alias | Role now covered by |
| --- | --- | --- |
| Manager | `m` | root orchestration (`/manager` procedure) |
| Architect | `a` | `/design` + `/refactor` procedures |
| Tester | `t` | `/test` procedure + the verification-evidence gate |
| Docwriter | `doc` | `/docs` procedure |
| Bugbuster | `bug` | `/bug` procedure + Debugger/Reviewer specialists |

## Static bug-pattern review checklist

Migrated from the legacy Bugbuster agent so the checklist survives the
compatibility window. Use it in a Code Reviewer diff review or alongside the
Debugger's dynamic loop.

Typical pattern areas:

- Null or missing-value handling
- Input parsing and trust-boundary mistakes
- Unchecked assumptions about inputs or environment
- Resource leaks or missing cleanup
- File, process, or network error-path gaps
- Unsafe shell or subprocess usage
- Hardcoded secrets or credential handling mistakes
- Error handling gaps
- Race-prone or order-dependent logic
- State/order assumptions and partial-cleanup failures
- Off-by-one and boundary errors
- Deprecated or sharp-edge API usage when it creates real risk

Method: choose the patterns relevant to the language, framework, and
subsystem → scan for risky patterns, missing checks, and unsafe flows →
validate each finding in the actual code path (reject false positives; state
why the issue is reachable) → classify `critical`/`major`/`minor` with the
break condition. Prefer a short list of defensible findings; if nothing
material is present, say so.

## Aliases

`assets/aliases.json` maps only the three shipped roles and their persona
spellings (`e`/`explorer`, `dbg`/`debugger`, `cr`/`code-reviewer`). ADR 0015
deleted the removed labels (`a`, `bug`, `t`, `doc`, `m`): an alias the plugin
cannot resolve to a shipped agent is a lie in the contract, and historical
transcripts keep their text either way. Transcript evidence is
`SubagentStart`, a specialist launch line (`Code Reviewer(`, `Explorer(`,
`Debugger(`), or an `@`-mention of a shipped alias — a root-procedure skill
load is no longer role evidence.

## How To Extend

When adding or changing agents and procedures:

1. Add or update the agent prompt in `plugins/agnthive/agents/`
2. Keep the three-layer model: the three specialists are agents; workflow stages are root procedures; no further compatibility agents are added
3. Compatibility-suite coverage for a new primary specialist: add a focused smoke task in `bench/tasks/subagents/smoke/` with `agent_alias`, non-empty `forbidden_transcript_patterns`, and at least one required-behavior assertion
4. Update this matrix
5. Run:
   - `node --test test/bench/bench_runner_claude_code.test.mjs`
   - `node scripts/validate.mjs`
   - `node scripts/test-hooks.mjs`
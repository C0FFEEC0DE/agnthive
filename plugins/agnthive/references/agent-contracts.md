# Plugin agent contract matrix

This document turns agent expectations into an explicit repository contract.

Contract model ([ADR 0008](../../../docs/adr/0008-root-orchestration-and-three-specialists.md),
[ADR 0009](../../../docs/adr/0009-completion-evidence-over-role-quotas.md)):
the main session owns orchestration. Three **primary specialists** — Code
Reviewer, Explorer, Debugger — are agent definitions. Design, Test, Docs, and
Refactor are **root procedures** (the `/design` `/test` `/docs` `/refactor`
`/bug` skills plus the `/manager` orchestration procedure), not mandatory
agent forks. Five **legacy compatibility agents** (Manager, Architect,
Tester, Docwriter, Bugbuster) remain for one transition release so explicit
legacy workflows keep a defined behavior; they are not recommended delegates
and are removed after the compatibility window ([plan task
16](../../../docs/plans/2026-10-19-harness-modernization-and-simplification.md)).

The contract has five layers:

1. `Hook-level contract` — Node hooks enforce workflow gates, summary fields, and completion safety
2. `Benchmark task contract` — the legacy per-role smoke suite gives each role focused benchmark coverage
3. `Bench runner assertions` — transcript patterns, used-agent signals, and changed-file checks validate actual behavior, not just exit codes
4. `Role benchmark suite` — `bench/tasks/subagents/smoke/*.json` (compatibility suite; see below)
5. `Agent contract matrix` — the tables below map every agent to its expected handoff signal and benchmark coverage

## Hook-Level Contract

Hook enforcement is shared across agents and workflows:

- `UserPromptSubmit` classifies work and seeds required roles (legacy profile; lean replaces role quotas with completed-evidence requirements per ADR 0009)
- `SubagentStart` normalizes aliases and records actual role use; generic Task tool types (`general-purpose`, `workflow-subagent`) are filtered from enforcement
- `Stop`, `TaskCompleted`, and `TeammateIdle` fall back to transcript `@alias` patterns (e.g. `@explorer` -> `e`, `@code-reviewer` -> `cr`, plus legacy persona aliases) when runtimes omit explicit `SubagentStart`
- `SubagentStop` requires a concrete handoff footer with `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and one closure line: `Remaining risks:` or `Next step:`
- `Stop`, `TaskCompleted`, and `TeammateIdle` block incomplete workflow completion
- `PostToolUse` and `PostToolUseFailure` track edit and verification state

Footers are a concise reporting shape, not proof of completion: in the lean
profile they are reporting guidance ([ADR 0009](../../../docs/adr/0009-completion-evidence-over-role-quotas.md)),
completion depends on current verification and completed review, and the stop
gate is bounded — turn termination after loop prevention does not convert a
failed check into a pass. Legacy footer gates remain scoped to recognized
local specialists until removed.

Relevant files (plugin Node runtime — the single `hook-dispatcher.mjs` handles every event that the legacy per-hook shell scripts used to):

- [`modules/hook-dispatcher.mjs`](../modules/hook-dispatcher.mjs) — event dispatch entrypoint (UserPromptSubmit, SubagentStart/Stop, Stop, TaskCompleted, PostToolUse, …)
- [`modules/summary-contract.mjs`](../modules/summary-contract.mjs) — handoff/stop-footer recognition
- [`modules/workflow.mjs`](../modules/workflow.mjs) — workflow-gate enforcement (required-role groups, stop/TaskCompleted blocks)
- [`hooks/hooks.json`](../hooks/hooks.json) — event → command manifest

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

The per-agent suite lives in `bench/tasks/subagents/smoke/`. It is the
**legacy compatibility suite**: it covers the full eight-slot alias map
because legacy dispatch contracts still reference those aliases and their
historical evidence must not change meaning. It measures dispatch
compliance of a named role, not orchestration-quality or cost; lean
orchestration is compared by the outcome benchmarks instead ([plan task
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
Review is required for substantial changes; trivial and docs-only work may
omit a separate reviewer with an explicit rationale. The root passes
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
| `/review` | forked specialist skill (the only fork) | — | completed independent review of the current diff |

A root procedure may produce its work without launching a subagent; when it
delegates, the delegated handoff uses the same stop-safe footer shape. Docs
decisions follow ADR 0009/0008: internal changes without new user-facing
semantics are `not_required`, with the reason recorded.

## Legacy Compatibility Agents

Deprecated for new work; kept as working definitions for one transition
release (removal is a separate compatibility step — plan task 16). They are
**not recommended delegates**: prompt them only for explicit legacy usage.
Aliases still resolve so historical evidence keeps its meaning; `@m/@a/@t/
@doc/@bug` are plugin aliases, not guaranteed native CLI aliases.

| Agent | Alias | Legacy role now covered by | Smoke task (compat suite) |
| --- | --- | --- | --- |
| Manager | `m` | root orchestration (`/manager` procedure) | manager doc-map smoke task |
| Architect | `a` | `/design` + `/refactor` procedures | rollout and refactor smoke tasks |
| Tester | `t` | `/test` procedure | regression smoke task |
| Docwriter | `doc` | `/docs` procedure | quickstart smoke task |
| Bugbuster | `bug` | `/bug` procedure + Debugger/Reviewer specialists | zero-division smoke task |

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

`assets/aliases.json` intentionally retains the full eight-slot mapping
(`a`, `e`, `bug`, `dbg`, `t`, `cr`, `doc`, `m` plus persona aliases): alias
resolution is a compatibility interface, and the meaning of recorded evidence
from older runs must not change ([plan task
12](../../../docs/plans/2026-10-19-harness-modernization-and-simplification.md)).
Legacy shorthands are plugin aliases, not native CLI guarantees.

## How To Extend

When adding or changing agents and procedures:

1. Add or update the agent prompt in `plugins/agnthive/agents/`
2. Keep the three-layer model: primary specialists are agents; workflow stages are root procedures; new legacy agents are not added
3. Compatibility-suite coverage for a new primary specialist: add a focused smoke task in `bench/tasks/subagents/smoke/` with `agent_alias`, non-empty `forbidden_transcript_patterns`, and at least one required-behavior assertion
4. Update this matrix
5. Run:
   - `node --test test/bench/bench_runner_claude_code.test.mjs`
   - `node scripts/validate.mjs`
   - `node scripts/test-hooks.mjs`
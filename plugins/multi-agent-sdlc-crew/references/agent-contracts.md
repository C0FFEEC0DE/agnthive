# Plugin agent contract matrix

This document turns subagent expectations into an explicit repository contract.

It has five layers:

1. `Hook-level contract` — Node hooks enforce workflow gates, summary fields, and completion safety
2. `Benchmark task contract` — each agent has at least one focused benchmark task with file/doc/test scope rules
3. `Bench runner assertions` — transcript patterns, used-agent signals, and changed-file checks validate actual behavior, not just exit codes
4. `Role benchmark suite` — `bench/tasks/subagents/smoke/*.json` provides per-agent coverage for PRs
5. `Agent contract matrix` — the table below maps every agent to its expected handoff signal and benchmark coverage

## Hook-Level Contract

Hook enforcement is shared across agents and workflows:

- `UserPromptSubmit` classifies work and seeds required roles
- `SubagentStart` normalizes aliases and records actual role use; generic Task tool types (`general-purpose`, `workflow-subagent`) are filtered from enforcement
- `Stop`, `TaskCompleted`, and `TeammateIdle` fall back to transcript `@alias` patterns (e.g. `@explorer` -> `e`, `@code-reviewer` -> `cr`, plus legacy persona aliases) when runtimes omit explicit `SubagentStart`
- `SubagentStop` requires a concrete handoff footer with `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and one closure line: `Remaining risks:` or `Next step:`
- `Stop`, `TaskCompleted`, and `TeammateIdle` block incomplete workflow completion
- `PostToolUse` and `PostToolUseFailure` track edit and verification state

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
- verification-required benchmark tasks can use the fixture-appropriate local test command detected by the runner, so the contract covers both Python and non-Python fixtures
- user prompts do not satisfy transcript assertions

Relevant files:

- repository benchmark runner, test suite, and forbidden-pattern corpus

## Role Benchmark Suite

The per-agent suite lives in:

- the repository's `bench/tasks/subagents/smoke/` suite

Repository validation now requires:

- every canonical agent alias has at least one smoke task
- every subagent benchmark task declares `agent_alias`
- every subagent benchmark task has non-empty `forbidden_transcript_patterns`
- every subagent benchmark task has at least one required-behavior assertion via `required_transcript_patterns`, `required_used_agents`, or `required_used_agent_groups`

This is enforced by:

- the repository validator (`scripts/validate.mjs`)

## Matrix

| Agent | Alias | Smoke task | Required signal | Forbidden transcript focus | Benchmark task contract |
| --- | --- | --- | --- | --- | --- |
| Manager | `m` | manager doc-map smoke task | `Plan:`, role handoff markers, plus stop-safe footer markers `Outcome:`, `Changed files:`/`No files changed:`, `Verification status:`, and `Remaining risks:`/`Next step:` | no agent-choice prompts, no hook/footer repair chatter | coordination without asking the user which required agent to use |
| Explorer | `e` | explorer code-map smoke task | `Task:\s*Explore`, `Locations:`, plus stop-safe footer markers | no meta chatter about prefix matching or shell guards | map the target area before change work |
| Architect | `a` | rollout and refactor smoke tasks | actual use of `@a` via `required_used_agents`, plus docs-only or refactor-safe scope checks | no footer-repair chatter | design-note coverage plus bounded refactor planning that preserves behavior and verification |
| Bugbuster | `bug` | zero-division smoke task | `Task:\s*Bug Scan`, `Findings:`, plus stop-safe footer markers | no footer-repair chatter | bugfix with findings, tests, docs update, and review |
| Debugger | `dbg` | zero-division smoke task | `Task:\s*Debug`, `Reproduction:`, `Root cause:`, plus stop-safe footer markers | no footer-repair chatter | reproduce, isolate, fix, test, and document |
| Tester | `t` | regression smoke task | `Task:\s*Testing`, `Gaps:`, plus stop-safe footer markers | no footer-repair chatter | verification-first task with real `pytest -q` evidence |
| Code Reviewer | `cr` | review-note smoke task | `Task:\s*Code Review`, `Findings:`, `Review outcome:`, plus stop-safe footer markers | no invented findings, no hook/footer repair chatter | review-only task that must not modify source code |
| Docwriter | `doc` | quickstart smoke task | `Task:\s*Docs`, `Coverage:`, plus stop-safe footer markers | no invented install/clone steps, no footer-repair chatter | docs-only task with forbidden doc hallucination patterns |
## How To Extend

When adding a new agent or tightening an existing one:

1. Add or update the agent prompt in `plugins/multi-agent-sdlc-crew/agents/`
2. Add a focused smoke task in `bench/tasks/subagents/smoke/`
3. Set `agent_alias`
4. Add at least one required-behavior assertion:
   `required_transcript_patterns`, `required_used_agents`, or `required_used_agent_groups`
5. Add non-empty `forbidden_transcript_patterns`
6. Update this matrix
7. Run:
   - `node --test test/bench/bench_runner_claude_code.test.mjs`
   - `node scripts/validate.mjs`
   - `node scripts/test-hooks.mjs`

# Agent Contract Matrix

This document turns subagent expectations into an explicit repository contract.

It has five layers:

1. `Hook-level contract` — shell hooks enforce workflow gates, summary fields, and completion safety
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

Relevant files:

- [`claudecfg/hooks/user-prompt-submit.sh`](../claudecfg/hooks/user-prompt-submit.sh)
- [`claudecfg/hooks/subagent-start.sh`](../claudecfg/hooks/subagent-start.sh)
- [`claudecfg/hooks/subagent-stop-guard.sh`](../claudecfg/hooks/subagent-stop-guard.sh)
- [`claudecfg/hooks/stop-guard.sh`](../claudecfg/hooks/stop-guard.sh)
- [`claudecfg/hooks/task-completed.sh`](../claudecfg/hooks/task-completed.sh)
- [`claudecfg/hooks/lib.sh`](../claudecfg/hooks/lib.sh)

## Bench Runner Assertions

The behavioral runner checks more than pass/fail:

- `required_transcript_patterns` must appear in assistant-like transcript entries when the task is asserting a stable handoff shape
- `required_used_agents` and `required_used_agent_groups` must match actual `SubagentStart` / recorded handoff activity parsed from the debug log when the task is asserting role usage
- `forbidden_transcript_patterns` must not appear in assistant-like transcript entries
- changed-file scope, docs scope, and verification requirements are enforced per task
- verification-required benchmark tasks can use the fixture-appropriate local test command detected by the runner, so the contract covers both Python and non-Python fixtures
- user prompts do not satisfy transcript assertions

Relevant files:

- [`scripts/bench_runner_claude_code.py`](../scripts/bench_runner_claude_code.py)
- [`tests/bench/test_bench_runner.py`](../tests/bench/test_bench_runner.py)
- [`bench/patterns/forbidden-meta-chatter.json`](../bench/patterns/forbidden-meta-chatter.json)

## Role Benchmark Suite

The per-agent suite lives in:

- [`bench/tasks/subagents/smoke/`](../bench/tasks/subagents/smoke)

Repository validation now requires:

- every canonical agent alias has at least one smoke task
- every subagent benchmark task declares `agent_alias`
- every subagent benchmark task has non-empty `forbidden_transcript_patterns`
- every subagent benchmark task has at least one required-behavior assertion via `required_transcript_patterns`, `required_used_agents`, or `required_used_agent_groups`

This is enforced by:

- [`scripts/validate.sh`](../scripts/validate.sh)

## Matrix

| Agent | Alias | Smoke task | Required signal | Forbidden transcript focus | Benchmark task contract |
| --- | --- | --- | --- | --- | --- |
| Manager | `m` | [`subagent-manager-doc-map-lite.json`](../bench/tasks/subagents/smoke/subagent-manager-doc-map-lite.json) | `Plan:`, role handoff markers, plus stop-safe footer markers `Outcome:`, `Changed files:`/`No files changed:`, `Verification status:`, and `Remaining risks:`/`Next step:` | no agent-choice prompts, no hook/footer repair chatter | coordination without asking the user which required agent to use |
| Explorer | `e` | [`subagent-explorer-code-map-lite.json`](../bench/tasks/subagents/smoke/subagent-explorer-code-map-lite.json) | `Task:\s*Explore`, `Locations:`, plus stop-safe footer markers | no meta chatter about prefix matching or shell guards | map the target area before change work |
| Architect | `a` | [`subagent-architect-rollout-lite.json`](../bench/tasks/subagents/smoke/subagent-architect-rollout-lite.json), [`subagent-architect-refactor-lite.json`](../bench/tasks/subagents/smoke/subagent-architect-refactor-lite.json) | actual use of `@a` via `required_used_agents`, plus docs-only or refactor-safe scope checks | no footer-repair chatter | design-note coverage plus bounded refactor planning that preserves behavior and verification |
| Bugbuster | `bug` | [`subagent-bugbuster-zero-division-lite.json`](../bench/tasks/subagents/smoke/subagent-bugbuster-zero-division-lite.json) | `Task:\s*Bug Scan`, `Findings:`, plus stop-safe footer markers | no footer-repair chatter | bugfix with findings, tests, docs update, and review |
| Debugger | `dbg` | [`subagent-debugger-zero-division-lite.json`](../bench/tasks/subagents/smoke/subagent-debugger-zero-division-lite.json) | `Task:\s*Debug`, `Reproduction:`, `Root cause:`, plus stop-safe footer markers | no footer-repair chatter | reproduce, isolate, fix, test, and document |
| Tester | `t` | [`subagent-tester-regression-lite.json`](../bench/tasks/subagents/smoke/subagent-tester-regression-lite.json) | `Task:\s*Testing`, `Gaps:`, plus stop-safe footer markers | no footer-repair chatter | verification-first task with real `pytest -q` evidence |
| Code Reviewer | `cr` | [`subagent-code-reviewer-note-lite.json`](../bench/tasks/subagents/smoke/subagent-code-reviewer-note-lite.json) | `Task:\s*Code Review`, `Findings:`, `Review outcome:`, plus stop-safe footer markers | no invented findings, no hook/footer repair chatter | review-only task that must not modify source code |
| Docwriter | `doc` | [`subagent-docwriter-quickstart-lite.json`](../bench/tasks/subagents/smoke/subagent-docwriter-quickstart-lite.json) | `Task:\s*Docs`, `Coverage:`, plus stop-safe footer markers | no invented install/clone steps, no footer-repair chatter | docs-only task with forbidden doc hallucination patterns |
## How To Extend

When adding a new agent or tightening an existing one:

1. Add or update the agent prompt in `claudecfg/agents/`
2. Add a focused smoke task in `bench/tasks/subagents/smoke/`
3. Set `agent_alias`
4. Add at least one required-behavior assertion:
   `required_transcript_patterns`, `required_used_agents`, or `required_used_agent_groups`
5. Add non-empty `forbidden_transcript_patterns`
6. Update this matrix
7. Run:
   - `pytest -q tests/bench/test_bench_runner.py`
   - `bash scripts/validate.sh`
   - `node scripts/test-hooks.mjs`

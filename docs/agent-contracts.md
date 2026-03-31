# Agent Contract Matrix

This document turns subagent expectations into an explicit repository contract.

It has five layers:

1. `Hook-level contract` — shell hooks enforce workflow gates, summary fields, and completion safety
2. `Benchmark task contract` — each agent has at least one focused benchmark task with file/doc/test scope rules
3. `Bench runner assertions` — transcript patterns and changed-file checks validate actual behavior, not just exit codes
4. `Golden regression suite` — `bench/tasks/subagents/*.json` is the fast per-agent acceptance suite
5. `Agent contract matrix` — the table below maps every agent to its expected transcript shape and benchmark coverage

## Hook-Level Contract

Hook enforcement is shared across agents and workflows:

- `UserPromptSubmit` classifies work and seeds required roles
- `SubagentStart` normalizes aliases and records actual role use
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

- `required_transcript_patterns` must appear in assistant-like transcript entries
- `forbidden_transcript_patterns` must not appear in assistant-like transcript entries
- changed-file scope, docs scope, and verification requirements are enforced per task
- user prompts do not satisfy transcript assertions

Relevant files:

- [`scripts/bench_runner_claude_code.py`](../scripts/bench_runner_claude_code.py)
- [`tests/bench/test_bench_runner.py`](../tests/bench/test_bench_runner.py)
- [`bench/patterns/forbidden-meta-chatter.json`](../bench/patterns/forbidden-meta-chatter.json)

## Golden Regression Suite

The fast per-agent regression suite lives in:

- [`bench/tasks/subagents/`](../bench/tasks/subagents)

Repository validation now requires:

- every canonical agent alias has at least one subagent benchmark task
- every subagent benchmark task declares `agent_alias`
- every subagent benchmark task has non-empty `required_transcript_patterns`
- every subagent benchmark task has non-empty `forbidden_transcript_patterns`

This is enforced by:

- [`scripts/validate.sh`](../scripts/validate.sh)

## Matrix

| Agent | Alias | Golden task(s) | Required transcript markers | Forbidden transcript focus | Benchmark task contract |
| --- | --- | --- | --- | --- | --- |
| Manager | `m` | [`subagent-manager-doc-map-lite.json`](../bench/tasks/subagents/subagent-manager-doc-map-lite.json) | `Plan:`, `Task:\s*Docs`, plus stop-safe footer markers `Outcome:`, `Changed files:`/`No files changed:`, `Verification status:`, and `Remaining risks:`/`Next step:` | no agent-choice prompts, no hook/footer repair chatter | docs-only coordination without asking the user which required agent to use |
| Explorer | `e` | [`subagent-explorer-code-map-lite.json`](../bench/tasks/subagents/subagent-explorer-code-map-lite.json), [`subagent-explorer-feature-handoff-lite.json`](../bench/tasks/subagents/subagent-explorer-feature-handoff-lite.json) | `Task:\s*Explore`, `Locations:`, plus stop-safe footer markers `Outcome:`, `Changed files:`/`No files changed:`, `Verification status:`, and `Remaining risks:`/`Next step:` | no meta chatter about prefix matching or shell guards | map the target area before change work; docs-only map and feature-handoff variants |
| Architect | `a` | [`subagent-architect-rollout-lite.json`](../bench/tasks/subagents/subagent-architect-rollout-lite.json) | `Task:\s*Design`, `Solution:`, plus stop-safe footer markers `Outcome:`, `Changed files:`/`No files changed:`, `Verification status:`, and `Remaining risks:`/`Next step:` | no footer-repair chatter | docs-only design note, no implementation drift |
| Bugbuster | `bug` | [`subagent-bugbuster-zero-division-lite.json`](../bench/tasks/subagents/subagent-bugbuster-zero-division-lite.json) | `Task:\s*Bug Scan`, `Findings:`, plus stop-safe footer markers `Outcome:`, `Changed files:`/`No files changed:`, `Verification status:`, and `Remaining risks:`/`Next step:` | no footer-repair chatter | bugfix with findings, tests, docs update, and review |
| Debugger | `dbg` | [`subagent-debugger-zero-division-lite.json`](../bench/tasks/subagents/subagent-debugger-zero-division-lite.json) | `Task:\s*Debug`, `Reproduction:`, `Root cause:`, plus stop-safe footer markers `Outcome:`, `Changed files:`/`No files changed:`, `Verification status:`, and `Remaining risks:`/`Next step:` | no footer-repair chatter | reproduce, isolate, fix, test, and document |
| Tester | `t` | [`subagent-tester-regression-lite.json`](../bench/tasks/subagents/subagent-tester-regression-lite.json) | `Task:\s*Testing`, `Gaps:`, plus stop-safe footer markers `Outcome:`, `Changed files:`/`No files changed:`, `Verification status:`, and `Remaining risks:`/`Next step:` | no footer-repair chatter | verification-first task with real `pytest -q` evidence |
| Code Reviewer | `cr` | [`subagent-code-reviewer-note-lite.json`](../bench/tasks/subagents/subagent-code-reviewer-note-lite.json) | `Task:\s*Code Review`, `Findings:`, `Review outcome:`, plus stop-safe footer markers `Outcome:`, `Changed files:`/`No files changed:`, `Verification status:`, and `Remaining risks:`/`Next step:` | no invented findings, no hook/footer repair chatter | review-only task that must not modify source code |
| Docwriter | `doc` | [`subagent-docwriter-quickstart-lite.json`](../bench/tasks/subagents/subagent-docwriter-quickstart-lite.json) | `Task:\s*Docs`, `Coverage:`, plus stop-safe footer markers `Outcome:`, `Changed files:`/`No files changed:`, `Verification status:`, and `Remaining risks:`/`Next step:` | no invented install/clone steps, no footer-repair chatter | docs-only task with forbidden doc hallucination patterns |
| Housekeeper | `hk` | [`subagent-housekeeper-refactor-lite.json`](../bench/tasks/subagents/subagent-housekeeper-refactor-lite.json) | `Task:\s*Veles`, `Warnings:`, plus stop-safe footer markers `Outcome:`, `Changed files:`/`No files changed:`, `Verification status:`, and `Remaining risks:`/`Next step:` | no footer-repair chatter | bounded refactor with verification and no behavior drift |

## How To Extend

When adding a new agent or tightening an existing one:

1. Add or update the agent prompt in `claudecfg/agents/`
2. Add a focused task in `bench/tasks/subagents/`
3. Set `agent_alias`
4. Add non-empty `required_transcript_patterns`
5. Add non-empty `forbidden_transcript_patterns`
6. Update this matrix
7. Run:
   - `pytest -q tests/bench/test_bench_runner.py`
   - `bash scripts/validate.sh`
   - `bash scripts/test-hooks.sh`

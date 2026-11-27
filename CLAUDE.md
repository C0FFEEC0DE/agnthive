# Project Context

This repository ships the `agnthive` Claude Code plugin (`plugins/agnthive/`) — a hook-gated SDLC profile with a platform-independent Node ESM hook runtime and benchmark-driven agent regression coverage.

## Profile

This profile is hook-gated:
- **ADR first**: a change to a hook contract, an injected message, a standing-context budget, or the state shape updates or adds an ADR (and the ADR index) before the code change (ADR 0014)
- standing instruction surfaces are budgeted — output style, skill/agent descriptions, skill bodies, and agent prompts are enforced by `scripts/validate.mjs` → `checkContextBudget`; raising a budget is an ADR amendment
- discover -> design -> implement -> verify -> review -> docs when behavior changes -> cleanup
- release/deploy automation is intentionally disabled
- session metadata is logged to `${CLAUDE_PLUGIN_DATA}/logs` for audit/dataset indexing
- runtime notification events are logged to `notification.jsonl` with automatic log rotation (1MB threshold) to prevent unbounded growth
- final completion and subagent handoff are enforced by the plugin's Node hooks using shared session state for test/lint/build results and summary requirements
- stop-safe no-op replies are only valid when the session made no code or config changes; after code/config edits, keep reporting the actual verification, review outcome, changed files, and remaining risks
- final implementation summaries after code/config changes must include exact stop-safe lines for `Verification status:`, `Review outcome:`, `Changed files:` or `No files changed:`, and `Remaining risks:`
- subagent handoffs must include exact handoff-footer lines for `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and one closure line: `Remaining risks:` or `Next step:`
- benchmark tasks that need a visible role-usage marker may also require `Handoff evidence: @alias ...` in the transcript; the runner treats that as canonical role evidence alongside `SubagentStart`
- there are no role quotas beyond the review gate: feature, bugfix, refactor, and review work require a started `@cr` review plus current verification evidence; docs work requires current verification evidence when behavior changed
- completion evidence is the append-only `verification[]` records (pending/passed/failed/unknown, scoped to the current change revision — a launched run is not a pass, and a later edit invalidates earlier verification) plus `review_results[]` and the `agents{}` registry (ADR 0009/0010); transcript text and footer prose are claims, not completion evidence
- UserPromptSubmit dedupes a re-delivered `prompt_id` and runs explicit task transitions (start/continue/complete), so background returns and sibling handoffs do not erase an open task's required roles or counters (ADR 0010)
- hook events are classed enforce / guidance / telemetry (ADR 0011): a failed enforce handler blocks with a diagnostic, advisory stays neutral (no blanket allow), telemetry failures are nonblocking; `PermissionDenied` emits the `hookSpecificOutput {hookEventName: 'PermissionDenied', retry}` envelope; every registration carries a timeout and the shared Bash/PowerShell PreToolUse safety registration carries `onFailure: "block"`
- `StopFailure` is telemetry only: one bounded `stop-failure.jsonl` record (`ts`, `session_id`, `error_name`, `exit_code`, `signal`, `agent_id`) per observed turn failure; API error text is never logged and a failed turn never counts as completion
- the root-orchestration workflow profile is the only profile since 0.5.0, selected by `userConfig.workflow_profile` (default `lean`; `AGNTHIVE_WORKFLOW_PROFILE` overrides): no mandatory role quotas, no Manager-idle gate, footer lines are reporting guidance, and the current-verification and review gates stay; the `legacy` profile was removed after the compatibility window closed, and a session that still names it runs `lean` with an explicit migration note
- broad multi-file or workflow review should usually use `@e` before `@cr`, even though only `@cr` is hook-enforced
- footer and stop-guard formatting are internal protocol details; agents should not expose prefix-matching or footer-repair chatter to the user

## Quick Start

Install/enable, configuration, and the `--plugin-dir` dev path live in
`plugins/agnthive/README.md`. Update with `claude plugin update agnthive@agnthive`.

## Commands

- `/manager`, `/explore`, `/bug`, `/debug`, `/test`, `/design`, `/refactor`, `/review`, `/simplify`, `/docs`

Commands `/explore`, `/bug`, `/debug`, `/test`, `/design`, `/refactor` and the `/docs` skill are root-session procedures (ADR 0008): they run in the root and delegate to a specialist only when the work earns isolation. `/manager` is the root orchestration procedure and does not spawn a Manager agent. `/review` is a root two-stage procedure (ADR 0015): stage 1 runs the `/simplify` pass and re-verifies, stage 2 dispatches the Code Reviewer in a read-only subagent. `/simplify` also ships standalone.

## Agents

- `@e` — Explorer (codebase)
- `@dbg` — Debugger (debug issues)
- `@cr` — Code Reviewer (review)

Those three are the agents the plugin ships (ADR 0008/0015). The alias map
carries only their labels; the removed 0.5.0 labels were deleted, so historical
transcripts keep their text but no longer canonicalize to a role.

Alias/type normalization (snake_case and camelCase), the generic-type filter, and
the transcript fallback rule are specified in `plugins/agnthive/references/agent-contracts.md`.

## Docs

- `plugins/agnthive/README.md` — plugin quick reference: requirements, installation, configuration, status line, privacy
- `plugins/agnthive/references/subagent-driven-development.md` — the SDD workflow and reference docs
- `docs/benchmarking.md` — benchmark architecture, slot-gate mechanism, local usage, and required GitHub setup
- `plugins/agnthive/references/agent-contracts.md` — contract matrix for benchmark/hook layers per agent role

Plugin skills under `plugins/agnthive/skills/` use YAML frontmatter for routing/tool constraints. Since ADR 0015 no skill is agent-backed (forked): all ten (`manager`, `explore`, `bug`, `debug`, `design`, `test`, `refactor`, `review`, `simplify`, `docs`) are root procedures, and `/review` dispatches `@cr` from its body; the five deprecated legacy agents (Manager, Architect, Tester, Docwriter, Bugbuster) were removed in 0.5.0 (plan task 16) and their alias labels were removed in ADR 0015.

## Repository Automation

CI runs `Validate`, `Hook Tests`, and `Security Scan` on every push and PR, plus
`Behavior Benchmark Subagents Smoke` on benchmark-related PRs; concurrent
benchmark runs go through a two-slot gate (`scripts/wait-for-benchmark-slot.mjs`).
Agent regressions live in `bench/tasks/subagents/smoke/`; the no-spend precheck is
`make bench-precheck`. Details: `docs/benchmarking.md`.

OpenRouter-backed Claude Code is configured via repository secrets/variables. See `docs/benchmarking.md`.

## Test Commands

```bash
# One-command local pre-push gate: full self-check (validate) + lint + tests +
# hook contract harness. No model, no network, no API keys — the same no-spend
# gates CI runs. Add `make bench-precheck` (also no-spend) for benchmark smoke
# task selection, or `make bench-mock` to exercise the benchmark runner plumbing.
make precommit

# Lint: Node ESM syntax check (node scripts/lint.mjs) — Node-only, no Python
make lint

# All tests (Node --test over test/**/*.test.mjs — includes the validator
# suite under test/validators/*.test.mjs, which is itself Node --test .mjs).
make test

# Alias of `make test` for muscle memory. The ratcheting branch-coverage
# gate on scripts/*.py was retired when the bench runners were ported to
# Node ESM (scripts/ is now Node-only); the repo is fully Node now — no
# .py files exist and no Python runs in CI or lint.
make cov

# Hook contract harness + integration scenarios (Node dispatcher driven)
make hooks

# Full repository self-check (validation + hooks + lint + tests)
node scripts/validate.mjs

# Remove regenerable test/benchmark artifacts (coverage data, benchmark
# per-task logs under BENCH_OUTPUT_DIR). Run after repeated test/bench
# cycles so accumulated output does not exhaust disk quota.
make clean

# Validator (task/fixture alignment) tests only
node --test test/validators/**/*.test.mjs
```

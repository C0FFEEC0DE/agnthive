# Project Context

This repository ships the `agnthive` Claude Code plugin (`plugins/agnthive/`) — a hook-gated SDLC profile with a platform-independent Node ESM hook runtime and benchmark-driven agent regression coverage.

## Profile

This profile is hook-gated:
- discover -> design -> implement -> verify -> review -> docs when behavior changes -> cleanup
- release/deploy automation is intentionally disabled
- session metadata is logged to `${CLAUDE_PLUGIN_DATA}/logs` for audit/dataset indexing
- runtime notification events are logged to `notification.jsonl` with automatic log rotation (1MB threshold) to prevent unbounded growth
- final completion and subagent handoff are enforced by the plugin's Node hooks using shared session state for test/lint/build results and summary requirements
- stop-safe no-op replies are only valid when the session made no code or config changes; after code/config edits, keep reporting the actual verification, review outcome, changed files, and remaining risks
- final implementation summaries after code/config changes must include exact stop-safe lines for `Verification status:`, `Review outcome:`, `Changed files:` or `No files changed:`, and `Remaining risks:`
- subagent handoffs must include exact handoff-footer lines for `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and one closure line: `Remaining risks:` or `Next step:`
- benchmark tasks that need a visible role-usage marker may also require `Handoff evidence: @alias ...` in the transcript; the runner treats that as canonical role evidence alongside `SubagentStart`
- feature work requires successful verification or `@t`, plus `@cr` and one of `@e|@a`
- bugfix work requires successful verification or `@t`, plus `@cr` and one of `@bug|@e|@dbg`
- refactor work requires successful verification or `@t`, plus `@cr` and one of `@a|@e`
- review work requires `@cr`; docs work requires `@doc`
- those are the legacy-profile role gates: completion evidence is the append-only `verification[]` records (pending/passed/failed/unknown, scoped to the current change revision — a launched run is not a pass, and a later edit invalidates earlier verification) plus `review_results[]` and the `agents{}` registry (ADR 0009/0010); transcript text and footer prose are claims, not completion evidence
- UserPromptSubmit dedupes a re-delivered `prompt_id` and runs explicit task transitions (start/continue/complete), so background returns and sibling handoffs do not erase an open task's required roles or counters (ADR 0010)
- hook events are classed enforce / guidance / telemetry (ADR 0011): a failed enforce handler blocks with a diagnostic, advisory stays neutral (no blanket allow), telemetry failures are nonblocking; `PermissionDenied` emits the `hookSpecificOutput {hookEventName: 'PermissionDenied', retry}` envelope; every registration carries a timeout and the shared Bash/PowerShell PreToolUse safety registration carries `onFailure: "block"`
- `StopFailure` is telemetry only: one bounded `stop-failure.jsonl` record (`ts`, `session_id`, `error_name`, `exit_code`, `signal`, `agent_id`) per observed turn failure; API error text is never logged and a failed turn never counts as completion
- the lean workflow profile is experimental and selected by `userConfig.workflow_profile` (default `legacy`; `AGNTHIVE_WORKFLOW_PROFILE` overrides): it relaxes role quotas, the Manager-idle gate, and footer blocks while keeping current-verification and review gates; the default flips only after the ADR 0012 outcome benchmark gate
- broad multi-file or workflow review should usually use `@e` before `@cr`, even though only `@cr` is hook-enforced
- footer and stop-guard formatting are internal protocol details; agents should not expose prefix-matching or footer-repair chatter to the user

## Quick Start

Install — this repo is a self-hosted marketplace, so connect Claude Code and install directly (no clone needed). The plugin ships disabled by default, so enable it after install:

```bash
claude plugin marketplace add C0FFEEC0DE/agnthive
claude plugin install agnthive@agnthive
claude plugin enable agnthive@agnthive
```

Update straight from the repo with `claude plugin update agnthive@agnthive`. For local development from a checkout, see `plugins/agnthive/README.md` for the `--plugin-dir` path.

See `plugins/agnthive/README.md` for requirements, configuration, and the optional status line.

## Commands

- `/manager`, `/explore`, `/bug`, `/debug`, `/test`, `/design`, `/refactor`, `/review`, `/docs`

Commands `/explore`, `/bug`, `/debug`, `/test`, `/design`, `/refactor` and the `/docs` skill are root-session procedures (ADR 0008): they run in the root and delegate to a specialist only when the work earns isolation. `/manager` is the root orchestration procedure and does not spawn a Manager agent. `/review` is the only forked specialist skill — it dispatches the Code Reviewer in a read-only subagent.

## Agents

- `@m` — Manager (coordinates)
- `@e` — Explorer (codebase)
- `@a` — Architect (design)
- `@bug` — Bugbuster (find bugs)
- `@dbg` — Debugger (debug issues)
- `@t` — Tester (design, run, and verify tests)
- `@cr` — Code Reviewer (review)
- `@doc` — Docwriter (documentation)

Primary specialists per ADR 0008 (implemented 0.4.0): `@e`, `@dbg`, `@cr`. Manager/Architect/Tester/Docwriter/Bugbuster are deprecated compatibility agents kept for explicit legacy workflows, removed after the compatibility window (plan task 16).

Subagent handoffs normalize aliases, names, and subagent-type fields from both snake_case and camelCase payloads before generic runtime types are considered. Generic Task tool types (`general-purpose`, `workflow-subagent`) are filtered from role enforcement since they are tool dispatch types, not agent roles.
Transcript fallback also recognizes slash-skill loads, agent launch lines like `Code Reviewer(...)`, and `@alias` patterns like `@cr`, `@e`, `@nerd`, `@toxic-senior`, or `@paranoid` when runtimes omit explicit `SubagentStart`.

## Docs

- `plugins/agnthive/README.md` — plugin quick reference: requirements, installation, configuration, status line, privacy
- `plugins/agnthive/references/subagent-driven-development.md` — the SDD workflow and reference docs
- `docs/benchmarking.md` — benchmark architecture, slot-gate mechanism, local usage, and required GitHub setup
- `plugins/agnthive/references/agent-contracts.md` — contract matrix for benchmark/hook layers per agent role

Plugin skills under `plugins/agnthive/skills/` use YAML frontmatter for routing/tool constraints. `/review` is the only agent-backed (forked specialist) skill; the other eight (`manager`, `explore`, `bug`, `debug`, `design`, `test`, `refactor`, `docs`) are root procedures per ADR 0008 — after the compatibility window the five deprecated legacy agents (Manager, Architect, Tester, Docwriter, Bugbuster) are removed.

## Repository Automation

Repository CI includes:
- status badges in `README.md`
- `Validate`, `Hook Tests`, and `Security Scan` on every push and PR
- `Behavior Benchmark Subagents Smoke` on benchmark-related PRs (per-role task selection, matrix shards, two-slot gate)

Concurrent benchmark runs are limited by a **two-slot gate** (`scripts/wait-for-benchmark-slot.mjs`) that prevents CI overload when multiple workflow dispatches fire simultaneously. The gate polls a GitHub API endpoint, waits with fixed-interval retry, and handles HTTP 403 rate-limit errors by reading the `Retry-After` header before retrying.

All benchmark workflows opt into **Node.js 24** via `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` to prepare for the September 2026 Node.js 20 runner deprecation.

Agent-level regressions are covered by the smoke suite under `bench/tasks/subagents/smoke/` with focused canary tasks for each canonical specialist role plus extra workflow-shape coverage. The repository validator enforces shared subagent footer markers inside benchmark tasks so prompt, benchmark, and hook contracts cannot silently drift apart.

The smoke precheck (the CI `precheck` job's task selection + matrix build, with no model spend) is runnable locally via `make bench-precheck` (`scripts/bench-precheck.mjs`), which drives the same Node CLIs CI uses so selection stays byte-identical. See `docs/benchmarking.md` → *Local precheck*.

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

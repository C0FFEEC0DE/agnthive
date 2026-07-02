# Project Context

This repository ships the `agent-hive` Claude Code plugin (`plugins/agent-hive/`) — a hook-gated SDLC profile with a platform-independent Node ESM hook runtime and benchmark-driven agent regression coverage.

## Profile

This profile is hook-gated:
- discover -> design -> implement -> verify -> review -> docs when behavior changes -> cleanup
- release/deploy automation is intentionally disabled
- session metadata is logged to `~/.claude/logs/` for audit/dataset indexing
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
- broad multi-file or workflow review should usually use `@e` before `@cr`, even though only `@cr` is hook-enforced
- footer and stop-guard formatting are internal protocol details; agents should not expose prefix-matching or footer-repair chatter to the user

## Quick Start

Install the plugin from a local checkout:

```bash
claude plugin install ./plugins/agent-hive
```

See `plugins/agent-hive/README.md` for requirements, configuration, and the optional status line.

## Commands

- `/debug`, `/test`, `/design`, `/refactor`, `/review`, `/docs`

Commands `/debug`, `/test`, `/design`, `/refactor`, `/review` and the `/docs` skill invoke specialized agents.

## Agents

- `@m` — Manager (coordinates)
- `@e` — Explorer (codebase)
- `@a` — Architect (design)
- `@bug` — Bugbuster (find bugs)
- `@dbg` — Debugger (debug issues)
- `@t` — Tester (design, run, and verify tests)
- `@cr` — Code Reviewer (review)
- `@doc` — Docwriter (documentation)

Subagent handoffs normalize aliases, names, and subagent-type fields from both snake_case and camelCase payloads before generic runtime types are considered. Generic Task tool types (`general-purpose`, `workflow-subagent`) are filtered from role enforcement since they are tool dispatch types, not agent roles.
Transcript fallback also recognizes slash-skill loads, agent launch lines like `Code Reviewer(...)`, and `@alias` patterns like `@cr`, `@e`, `@nerd`, `@toxic-senior`, or `@paranoid` when runtimes omit explicit `SubagentStart`.

## Docs

- `plugins/agent-hive/README.md` — plugin quick reference: requirements, installation, configuration, status line, privacy
- `plugins/agent-hive/references/subagent-driven-development.md` — the SDD workflow and reference docs
- `docs/benchmarking.md` — benchmark architecture, slot-gate mechanism, local usage, and required GitHub setup
- `plugins/agent-hive/references/agent-contracts.md` — contract matrix for benchmark/hook layers per agent role

Plugin skills under `plugins/agent-hive/skills/` use YAML frontmatter for routing/tool constraints. Agent-backed skills (`bug`, `design`, `docs`, `refactor`, `review`, `test`) carry the full dispatch contract; command skills (`debug`, `explore`, `manager`) are minimal name+description entry points.

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

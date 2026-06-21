# Project Context

This directory contains Claude Code configuration for the multi-agent-sdlc-crew repository — a hook-gated SDLC profile with benchmark-driven agent regression coverage.

## Profile

This profile is hook-gated:
- discover -> design -> implement -> verify -> review -> docs when behavior changes -> cleanup
- release/deploy automation is intentionally disabled
- session metadata is logged to `~/.claude/logs/` for audit/dataset indexing
- runtime notification events are logged to `notification.jsonl` with automatic log rotation (1MB threshold) to prevent unbounded growth
- final completion and subagent handoff are enforced by shell hooks using shared session state for test/lint/build results and summary requirements
- stop-safe no-op replies are only valid when the session made no code or config changes; after code/config edits, keep reporting the actual verification, review outcome, changed files, and remaining risks
- final implementation summaries after code/config changes must include exact stop-safe lines for `Verification status:`, `Review outcome:`, `Changed files:` or `No files changed:`, and `Remaining risks:`
- subagent handoffs must include exact handoff-footer lines for `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and one closure line: `Remaining risks:` or `Next step:`
- feature work requires successful verification or `@t`, plus `@cr` and one of `@e|@a`
- bugfix work requires successful verification or `@t`, plus `@cr` and one of `@bug|@e|@dbg`
- refactor work requires successful verification or `@t`, plus `@cr` and one of `@a|@e`
- review work requires `@cr`; docs work requires `@doc`
- broad multi-file or workflow review should usually use `@e` before `@cr`, even though only `@cr` is hook-enforced
- footer and stop-guard formatting are internal protocol details; agents should not expose prefix-matching or footer-repair chatter to the user

## Quick Start

```bash
./install.sh
```

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

- `claudecfg/GUIDE.md` — quick reference for agents, commands, and navigation
- `claudecfg/README.md` — agent definitions and philosophy
- `docs/benchmarking.md` — benchmark architecture, slot-gate mechanism, local usage, and required GitHub setup
- `docs/agent-contracts.md` — contract matrix for benchmark/hook layers per agent role

Slash skills under `claudecfg/skills/` use YAML frontmatter for routing/tool constraints.

## Repository Automation

Repository CI includes:
- status badges in `README.md`
- `Validate`, `Hook Tests`, and `Security Scan` on every push and PR
- `Behavior Benchmark Subagents Smoke` on benchmark-related PRs (per-role task selection, matrix shards, two-slot gate)

Concurrent benchmark runs are limited by a **two-slot gate** (`scripts/wait-for-benchmark-slot.py`) that prevents CI overload when multiple workflow dispatches fire simultaneously. The gate polls a GitHub API endpoint, waits with fixed-interval retry, and handles HTTP 403 rate-limit errors by reading the `Retry-After` header before retrying.

All benchmark workflows opt into **Node.js 24** via `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` to prepare for the September 2026 Node.js 20 runner deprecation.

Agent-level regressions are covered by the smoke suite under `bench/tasks/subagents/smoke/` with focused canary tasks for each canonical specialist role plus extra workflow-shape coverage. The repository validator enforces shared subagent footer markers inside benchmark tasks so prompt, benchmark, and hook contracts cannot silently drift apart.

OpenRouter-backed Claude Code is configured via repository secrets/variables. See `docs/benchmarking.md`.

## Test Commands

```bash
# Lint: shell syntax + shellcheck + python compile + ruff
make lint

# All tests
make test

# Coverage with a ratcheting branch-coverage gate on scripts/*.py
# (COV_MIN=100). The gate applies ONLY to `make cov`, not `make test`.
make cov

# Hook contract harness + integration scenarios + direct lib.sh unit tests
make hooks

# Full repository self-check (validation + hooks + lint + tests)
bash scripts/validate.sh

# Benchmark tests only
python3 -m pytest tests/bench/ -v
```

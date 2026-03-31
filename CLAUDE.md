# Project Context

This directory contains Claude Code configuration.

## Profile

This profile is hook-gated:
- discover -> design -> implement -> verify -> review -> docs when behavior changes -> cleanup
- release/deploy automation is intentionally disabled
- session metadata is logged for later audit or dataset indexing
- final completion and subagent handoff are enforced by shell hooks using shared session state for test/lint/build results and summary requirements
- stop-safe no-op replies are only valid when the session made no code or config changes; after code/config edits, keep reporting the actual verification, review outcome, changed files, and remaining risks instead of using a no-change shortcut
- final implementation summaries after code/config changes must include exact stop-safe lines for `Verification status:`, `Review outcome:`, `Changed files:` or `No files changed:`, and `Remaining risks:`
- subagent handoffs must include exact handoff-footer lines for `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and one closure line: `Remaining risks:` or `Next step:`
- feature work requires successful verification or `@t`, plus `@cr` and one of `@e|@a`
- bugfix work requires successful verification or `@t`, plus `@cr` and one of `@bug|@e|@dbg`
- refactor work requires successful verification or `@t`, plus `@cr` and one of `@a|@e|@hk`
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
- `@hk` — Veles (cleanup)

Subagent handoffs normalize aliases, names, and subagent-type fields from both snake_case and camelCase payloads before generic runtime types are considered.
Transcript fallback also recognizes slash-skill loads and agent launch lines like `Code Reviewer(...)` when runtimes omit explicit `SubagentStart`.

## Docs

See `claudecfg/GUIDE.md` for full documentation.

## Repository Automation

Repository CI now includes:
- status badges in `README.md`
- `Validate`, `Hook Tests`, and `Security Scan` on every push and PR
- `Behavior Benchmark` on every push, plus manual runs with model and task-glob overrides, using real `claude -p` inside isolated benchmark fixtures

Agent-level regressions are covered by the golden suite in `bench/tasks/subagents/`. Use `docs/agent-contracts.md` for the contract matrix and the expected benchmark/hook layers for each agent.
The repository validator also enforces the shared subagent footer markers inside those golden benchmark tasks, so prompt, benchmark, and hook contracts cannot silently drift apart.

OpenRouter-backed Claude Code is configured via repository secrets/variables. See `docs/benchmarking.md`.

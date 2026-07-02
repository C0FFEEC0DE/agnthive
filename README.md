# agent-hive

[![Repository Checks](https://github.com/C0FFEEC0DE/agent-hive/actions/workflows/validate.yml/badge.svg?branch=main)](https://github.com/C0FFEEC0DE/agent-hive/actions/workflows/validate.yml)
[![Hook Contracts](https://github.com/C0FFEEC0DE/agent-hive/actions/workflows/hooks-test.yml/badge.svg?branch=main)](https://github.com/C0FFEEC0DE/agent-hive/actions/workflows/hooks-test.yml)
[![Security Checks](https://github.com/C0FFEEC0DE/agent-hive/actions/workflows/security-scan.yml/badge.svg?branch=main)](https://github.com/C0FFEEC0DE/agent-hive/actions/workflows/security-scan.yml)

A **hook-gated SDLC profile for Claude Code**: a platform-independent Node hook
runtime enforces a discover → design → implement → verify → review → docs flow,
eight specialist agents do the work, and a benchmark suite catches agent
regressions on every PR.

It gives you: deterministic handoff/stop contracts, token-spend discipline,
explicit `Handoff evidence: @alias ...` markers for benchmark-visible role use,
and defense-in-depth command blocking — all as a distributable Claude Code
plugin.

## Install

Install the plugin from a local checkout:

```bash
claude plugin install ./plugins/agent-hive
```

Restart Claude Code. See `plugins/agent-hive/README.md` for
requirements, configuration, the optional status line, and legacy-migration
notes (if you previously installed the old `~/.claude` profile via `./install.sh`).

## How it works

```mermaid
flowchart LR
    A[Prompt] --> B[Classify]
    B --> C[Specialists run]
    C --> D[Tool gates block danger]
    C --> E[Track edits + verify]
    E --> F[Enforce handoff footer]
    F --> G{Stop gate}
    G -->|missing gate| B
    G -->|all pass| H[Done]
```

Full diagram and the pieces: [`plugins/agent-hive/references/architecture.md`](plugins/agent-hive/references/architecture.md).

## Agents

| Alias | Role | Purpose |
|-------|------|---------|
| `@m` | Manager | Orchestrates other agents |
| `@cr` | Code Reviewer | Code review + security |
| `@t` | Tester | Verification + regression |
| `@e` | Explorer | Codebase exploration |
| `@a` | Architect | System design |
| `@bug` | Bugbuster | Bug hunting |
| `@dbg` | Debugger | Debugging issues |
| `@doc` | Docwriter | Documentation |

Full names work too: `@code-reviewer`, `@tester`, etc.

## Usage

```
@e explore the auth module
@cr review api.mjs
@t write tests for utils
@manager implement new feature: user authentication
```

### Slash commands

- `/manager` — manager-led orchestration
- `/explore` — codebase exploration
- `/bug` — bug hunting
- `/debug` — debugging
- `/test` — testing
- `/design` — design
- `/refactor` — refactoring
- `/review` — code review
- `/docs` — documentation

These are the documented entry points; the hooks enforce the actual handoff and stop gates. When a benchmark needs a visible role-usage marker, it may also require an explicit `Handoff evidence: @alias ...` line in the transcript.

### Required handoffs

| Type | Required |
|------|----------|
| feature | verification or `@t` + `@cr` + (`@e` or `@a`) |
| bugfix | verification or `@t` + `@cr` + (`@bug` / `@e` / `@dbg`) |
| refactor | verification or `@t` + `@cr` + (`@a` or `@e`) |
| review | `@cr` |
| docs | `@doc` |

## Configuration

- **Model:** none pinned — your runtime default applies. Set `"model": "…"` in your Claude Code settings to fix one.
- **`effortLevel`:** defaults to `medium` (lower spend); raise to `high` for hard design/verify/judge stages.
- **Safety:** `permissions.deny` blocks `sudo`, `mkfs`, `dd`, `rm -rf /`, `rm -rf ~`, force-push, and secret reads. Auto-execution only inside project folders.
- **Observability:** `Notification` and other runtime events log to `~/.claude/logs/*.jsonl` (rotated at 1 MB).
- See [`plugins/agent-hive/references/token-cost.md`](plugins/agent-hive/references/token-cost.md) for the full spend story.

## Docs

- [`plugins/agent-hive/README.md`](plugins/agent-hive/README.md) — plugin cheatsheet
- [`plugins/agent-hive/references/architecture.md`](plugins/agent-hive/references/architecture.md) — how the hooks fit together
- [`plugins/agent-hive/references/token-cost.md`](plugins/agent-hive/references/token-cost.md) — minimal token spend
- [`docs/benchmarking.md`](docs/benchmarking.md) — benchmark setup, including `make bench-precheck` to reproduce the smoke precheck locally without a model
- [`plugins/agent-hive/references/agent-contracts.md`](plugins/agent-hive/references/agent-contracts.md) — agent contracts

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Run `make lint`, `make test`, `node scripts/validate.mjs` before a PR. Report security issues via [`SECURITY.md`](SECURITY.md).

## License

MIT — see [`LICENSE`](LICENSE).

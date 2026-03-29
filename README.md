# Claude Code Configuration

[![Validate](https://github.com/C0FFEEC0DE/claude-crew/actions/workflows/validate.yml/badge.svg?branch=main)](https://github.com/C0FFEEC0DE/claude-crew/actions/workflows/validate.yml)
[![Hook Tests](https://github.com/C0FFEEC0DE/claude-crew/actions/workflows/hooks-test.yml/badge.svg?branch=main)](https://github.com/C0FFEEC0DE/claude-crew/actions/workflows/hooks-test.yml)
[![Behavior Benchmark](https://github.com/C0FFEEC0DE/claude-crew/actions/workflows/behavior-benchmark.yml/badge.svg?branch=main)](https://github.com/C0FFEEC0DE/claude-crew/actions/workflows/behavior-benchmark.yml)
[![Security Scan](https://github.com/C0FFEEC0DE/claude-crew/actions/workflows/security-scan.yml/badge.svg?branch=main)](https://github.com/C0FFEEC0DE/claude-crew/actions/workflows/security-scan.yml)

Badges reflect the latest workflow result for the `main` branch.

## Quick Start

```bash
cd claudecfg
./install.sh
```

This will backup your current config and install the new one.

## Auto-Execution

In project folders (`~/projects/**`, `~/code/**`, `~/repos/**`, `~/work/**`), agents can execute safe commands automatically without confirmation.

### Safety
- Protected paths: `~/.ssh`, `~/.aws`, `/etc`, `/usr`, etc.
- Denied commands: `sudo`, `mkfs`, `dd`, `rm -rf /`
- Confirmation required outside project folders
- Release/deploy actions are intentionally out of scope for this profile

## What's Included

### Agents (9)

| Alias | Agent | Character | Purpose |
|-------|-------|-----------|---------|
| `@m` | Manager | Big Boss | Coordinates other agents |
| `@cr` | Code Reviewer | Toxic Senior | Code review + security |
| `@t` | Tester | Paranoid | Test design, execution, and verification |
| `@e` | Explorer | Nerd | Exploring code |
| `@a` | Architect | The Architect | System design + SOLID |
| `@bug` | Bugbuster | Cyber Detective | Bug hunting |
| `@dbg` | Debugger | Bug Hunter | Debugging issues |
| `@doc` | Docwriter | Wiki-Wiki | Documentation |
| `@hk` | Housekeeper | The Cleaner | Cleanup + DevOps |

Full names also work: `@manager`, `@code-reviewer`, etc.

### Slash Commands

Slash commands that invoke specialized agents. The hooks still enforce the actual handoff and stop gates; these docs describe the intended entry points.

- `/manager` — planning and coordination session (invokes @manager)
- `/explore` — codebase exploration session (invokes @explorer)
- `/bug` — bug-hunting session (invokes @bugbuster)
- `/debug` — debugging session
- `/test` — testing session (invokes @tester)
- `/design` — design session (invokes @architect)
- `/refactor` — refactoring session (invokes @housekeeper)
- `/review` — code review (invokes @code-reviewer)
- `/docs` — documentation session (invokes @docwriter)

### Workflows

- `workflows/bugfix.md` — fix a bug
- `workflows/new-feature.md` — implement feature
- `workflows/refactor.md` — refactor code
- `workflows/security-scan.md` — scan for private data (API keys, passwords, tokens)
- `workflows/release.md` — optional manual checklist, not part of the mandatory SDLC profile

For `feature`, `bugfix`, `refactor`, `review`, and `docs` work, the profile is now role-enforced before completion. Hooks track canonical subagent aliases in session state, so full names like `@code-reviewer` normalize to `cr`. `SubagentStart` normalization also accepts alias/name/subagent-type fields from both snake_case and camelCase payloads before falling back to generic agent types.

Required handoffs by workflow:
- `feature` -> `@t`, `@cr`, and one of `@e|@a`
- `bugfix` -> `@t`, `@cr`, and one of `@bug|@e|@dbg`
- `refactor` -> `@t`, `@cr`, and one of `@a|@e|@hk`
- `review` -> `@cr`
- `docs` -> `@doc`

### Hooks

The profile uses hooks as enforcement points, not markdown alone:

- `SessionStart` — bootstrap SDLC context and detect test/lint/build commands
- `UserPromptSubmit` — classify task into `bugfix|feature|refactor|review|docs` and seed required subagent roles
- `PreToolUse` / `PermissionRequest` — block destructive or out-of-scope actions, including force-push, `mkfs*`, and remote bootstrap pipes such as `curl|bash` or `wget|bash`
- `PostToolUse` / `PostToolUseFailure` — track edits plus successful or failed test/lint/build commands
- `SubagentStart` / `SubagentStop` — enforce the subagent handoff contract through shell hooks instead of prompt hooks
- `TaskCompleted` / `Stop` / `TeammateIdle` — use the shared session state to block completion after missing verification, failed test/lint/build runs, or missing required subagent roles for the current workflow
- `SessionEnd` — index transcript paths and session metadata for later dataset work

`Stop` and `SubagentStop` are enforced by shell guards only. This avoids prompt-hook failures on tool-only turns while still requiring structured final summaries after code/config changes or subagent handoffs. If a repo has no detected `test`, `lint`, or `build` command, `Stop` no longer deadlocks the session, but the final summary must explicitly say that verification was not run and why.
For code or config changes, the stop-safe summary is line-oriented: include verification status, review outcome, changed files, and remaining risks on explicit summary lines rather than relying on loose keywords alone.

If a later reply in the same session makes no additional changes after earlier code/config edits, keep reporting the actual verification, review status, changed files, and remaining risks instead of switching to a no-change footer.

## Usage

### Call an agent directly (shortcuts)
```
@e explore the auth module
@cr review api.py
@t write tests for utils
@a design user auth
@bug find login bug
```

### Use full names
```
@explorer explore the auth module
@code-reviewer review api.py
@tester write tests for utils
```

### Use workflow (get plan)
```
@m fix bug in login
@manager implement new feature: user authentication
```

Manager can coordinate work, but completion is enforced by hooks. The expected flow is:
`discover -> design -> implement -> verify -> review -> docs when behavior changes -> cleanup`

### Use slash command
```
/manager
/explore
/bug
/debug
/test
/design
/refactor
/review
/docs
```

## Configuration

See `claudecfg/settings.json` for permissions and settings.

## CI and Claude Code

GitHub Actions now covers four layers:

- `Validate` — fast structural checks on every push and PR
- `Hook Tests` — behavior tests for the SDLC hook scripts
- `Behavior Benchmark` — real Claude Code acceptance tasks executed inside isolated fixture repositories
- `Security Scan` — repository secret and sensitive-file scan

All four workflows run automatically on every push.

### Fast CI

`Validate` runs:

- `bash scripts/validate.sh`
- shell syntax checks for `claudecfg/hooks/*.sh` and `scripts/*.sh`
- JSON checks for settings, hook cases, and benchmark metadata
- slash-command inventory checks across `claudecfg/commands/`, `README.md`, `claudecfg/GUIDE.md`, and `claudecfg/README.md`
- `git diff --check`

`Hook Tests` runs:

- `bash scripts/test-hooks.sh`

This harness verifies that key hooks block dangerous commands, classify prompts correctly, record verification state, reject incomplete stop summaries, and refuse completion after missing or failed verification when code changed.

### Behavior Benchmark

`.github/workflows/behavior-benchmark.yml` is the behavioral acceptance gate for the profile.

That workflow:

- installs the Claude Code CLI
- runs `claudecfg/install.sh` to install the repo config into `~/.claude`
- copies each benchmark fixture into an isolated task workdir
- runs the real `claude -p` inside that workdir
- uses the default cheap CI suite under `bench/tasks/lite/` so the gate stays fast enough for small models
- checks that required tasks actually changed files, kept docs/code scope rules, and still pass verification
- requires the final Claude response to include `Verification status:`, `Review outcome:`, and `Remaining risks:`
- reports both configured and executed task counts so fail-fast runs are not mistaken for full-suite coverage
- uploads per-task Claude logs, results, and workspace patches as artifacts
- fails unless every benchmark task passes

This is now the only real Claude Code workflow in the repository.

The default CI suite covers three small agent workflows:
- a bugfix with tests and a short docs update
- a docs-only README task that must not touch code
- a bounded refactor that must preserve behavior

The fuller suite in `bench/tasks/*.json` remains available for manual or slower evaluation runs when you want broader workflow coverage.

Required benchmark model variable:

- `OLLAMA_MODEL=qwen3.5:cloud`
- optional: `BEHAVIOR_BENCHMARK_MAX_OUTPUT_TOKENS=1024`

## Logs

Hook logs are written under `~/.claude/logs/`. Session metadata and transcript paths are indexed in `~/.claude/logs/session-index.jsonl`.

## Docs

- `claudecfg/GUIDE.md` — full cheatsheet
- `claudecfg/agents/` — agent definitions
- `claudecfg/commands/` — slash command definitions
- `claudecfg/skills/` — reusable slash-skill prompts
- `docs/benchmarking.md` — behavioral benchmark runner and workflow

## Uninstall

To restore backup:
```bash
cp -r ~/.claude.backup.XXX/* ~/.claude/
```

Where `XXX` is the backup timestamp.

## License

MIT

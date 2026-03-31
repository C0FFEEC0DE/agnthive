# Claude Code — Cheatsheet

## Model
- Current default: `minimax-m2.5:cloud`

## Navigation
- `Read path/to/file` — read file
- `Grep "pattern"` — search in code
- `Glob "**/*.py"` — find files

## Search Discipline
- Start with targeted search or file listing before opening files directly
- For large files, read targeted ranges instead of full-file rereads
- Reuse earlier reads from the session when possible

## Planning
- `EnterPlanMode` — for tasks >2-3 files
- `TaskCreate` — create task
- `TaskList` — list tasks

## Git
- **Never** `git reset --hard`, `git push --force` without asking
- Always show `git status` + `git diff` before commit

## Important
- Don't delete files without asking
- Don't change configs automatically
- Don't commit myself
- Don't touch .env, secrets, credentials
- No release/deploy automation in this profile

## Slash Commands

These commands invoke specialized agents:
The hooks enforce the actual handoff and stop gates; the commands below are the documented entry points.

### General
- `/manager` — manager-led orchestration session (invokes @manager)
- `/explore` — codebase exploration session (invokes @explorer)
- `/bug` — bug-hunting session (invokes @bugbuster)
- `/debug` — debugging session
- `/test` — testing session (invokes @tester)
- `/design` — design session (invokes @architect)
- `/refactor` — refactoring session (invokes @housekeeper, Veles)
- `/review` — code review (invokes @code-reviewer)
- `/docs` — documentation session (invokes @docwriter)

## Subagents (shortcuts)

| Alias | Agent | Purpose |
|-------|-------|---------|
| `@m` | Manager | Coordinates other agents |
| `@cr` | Code Reviewer | Code review + security |
| `@t` | Tester | Verification and regression testing |
| `@e` | Explorer | Exploring code |
| `@a` | Architect | System design + SOLID |
| `@bug` | Bugbuster | Bug hunting |
| `@dbg` | Debugger | Debugging issues |
| `@doc` | Docwriter | Documentation |
| `@hk` | Veles | Cleanup + bounded refactor hygiene |

Also works: `@manager`, `@code-reviewer`, etc.

### Slash command examples

```text
/manager fix flaky login tests end to end
/explore trace how auth state is loaded
/bug investigate why payments retry forever
/debug reproduce the cache invalidation issue
/test add regression coverage for password reset
/design design an API for report exports
/refactor clean up duplicated formatting helpers
/review review the authentication changes
/docs update the quickstart after CLI changes
```

## Auto-Execution

When working in a project folder (`~/projects/**`, `~/code/**`, `~/repos/**`, `~/work/**`):
- Commands execute automatically
- No confirmation needed for safe operations
- Security restrictions still apply (no sudo, rm -rf /, etc.)
- Hooks still enforce SDLC gates and block release/deploy actions

Outside project folders, confirmation is required.


## Hook-Gated SDLC

Mandatory flow:

`discover -> design -> implement -> verify -> review -> docs when behavior changes -> cleanup`

Main checkpoints:

- `SessionStart` — bootstrap SDLC context and detect test/lint/build commands
- `UserPromptSubmit` — classify work as feature, bugfix, refactor, review, or docs and seed required subagent roles
- `PreToolUse` / `PermissionRequest` / `PermissionDenied` — block dangerous or out-of-scope commands, including force-push, `mkfs*`, and remote bootstrap pipes; `PermissionDenied` only requests a retry for commands that are not hard-blocked by profile policy and the session is not running in benchmark headless mode
- `PostToolUse` / `PostToolUseFailure` — record edits and successful or failed test/lint/build status
- `SubagentStart` / `SubagentStop` — enforce the subagent output contract with shell guards
- `TaskCompleted` / `TeammateIdle` / `Stop` — share the same gate logic and block completion after missing verification, failed test/lint/build runs, or missing required subagent roles
- `SessionEnd` — log transcript path and session metadata for later indexing

`Stop` is shell-enforced by `hooks/stop-guard.sh`, and `SubagentStop` is shell-enforced by `hooks/subagent-stop-guard.sh`. After code or config changes, the final assistant summary must include explicit summary lines for verification status, review outcome or pending review, changed files or `no files changed`, and remaining risks or `none`. If the repo exposes no detectable `test`, `lint`, or `build` command, the stop guard allows completion without deadlock, but the summary must explicitly say verification was not run and why. Feature, bugfix, refactor, review, and docs workflows also require role-specific specialist handoffs before completion, tracked in shared session state with alias normalization such as `@code-reviewer -> cr`. Manager-led orchestration itself is tracked separately through `manager_mode=orchestrate`, so top-level `@m` use is not treated as a required specialist handoff. For feature, bugfix, and refactor work, a recorded successful test command satisfies the tester side of that gate; otherwise `@t` is still required. `SubagentStart` normalization also accepts alias/name/subagent-type fields in both snake_case and camelCase before falling back to generic runtime types. When a runtime loads slash skills like `/review` without emitting `SubagentStart`, or records specialist launches only as transcript lines like `Code Reviewer(...)`, the hooks fall back to transcript evidence so those handoffs still satisfy review/docs/test specialist gates. When a runtime backgrounds a live manager-led workflow before any code/config changes, `Stop` defers the specialist-role gate for that turn instead of treating the background handoff as a failed final response. `TeammateIdle` additionally blocks manager-led workflows that have not yet handed off to any specialist.
General informational questions are not implementation workflows by themselves. Mentions of models, Ollama, or OpenRouter should stay `other` unless the prompt also asks for a repository change such as implementing, integrating, adding support, or changing configuration.

If a later reply in the same session makes no additional changes after earlier code or config edits, keep reporting the actual verification, review status, changed files, and remaining risks instead of switching to a no-change footer.

Required handoffs:
- `feature` -> successful verification or `@t`, plus `@cr` and one of `@e|@a`
- `bugfix` -> successful verification or `@t`, plus `@cr` and one of `@bug|@e|@dbg`
- `refactor` -> successful verification or `@t`, plus `@cr` and one of `@a|@e|@hk`
- `review` -> `@cr`
- `docs` -> `@doc`

Review policy:
- `@cr` remains the only enforced gate for review tasks
- for broad multi-file, workflow, or subsystem reviews, prefer `@e` first to map files, control flow, and risky boundaries
- for small localized reviews, `@cr` can review directly without forcing `@e`

Subagent summaries must include exact line prefixes for `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and `Remaining risks:` or `Next step:`.
Those footer requirements are an internal handoff contract. Agents should not narrate prefix-matching problems, markdown-formatting repairs, or shell-guard mechanics to the user; they should silently fix the footer and keep the substantive answer separate from the handoff block.

## Standard Output

All subagents may include role-specific sections, but their handoff footer must use exact line prefixes that the shell guards recognize. Use one closure line, not both, unless the extra line adds real value:

```text
Task: <name>
Status: <pending|in_progress|completed|blocked>
Outcome: <what was done or confirmed>
Changed files: <path1>, <path2> | No files changed: <reason>
Verification status: <passed|failed|not run|not required> - <command, evidence, or reason>
Remaining risks: <risks or none>
```
Use `Next step:` instead of `Remaining risks:` when the main handoff is a concrete follow-up action.

## CLAUDE.md
Create `./CLAUDE.md` in project — put project context there (max 50 lines).

## Workflows

Predefined workflows:

- `workflows/bugfix.md` — fix a bug
- `workflows/new-feature.md` — implement feature
- `workflows/refactor.md` — refactor code
- `workflows/security-scan.md` — scan for private data (API keys, passwords, tokens)
- `workflows/release.md` — optional manual checklist, not part of the required SDLC path

### Usage

**Manager-led execution:**
```
@m fix bug in login
```
Manager coordinates the workflow to completion or a concrete blocker.

**Plan only:**
```
@m plan only: fix bug in login
```
Manager returns the plan without continuing execution.

**Execution policy:**
- manager coordination is optional, but when invoked it should continue orchestration by default
- hooks, not markdown, enforce verification, required subagent roles, and stop conditions
- code review remains a required final gate for implementation work
- manager may parallelize multiple same-role specialists when their scopes are distinct; gates still care about roles, not instance count

## Git Worktrees
- Prefer git worktrees for parallel write-heavy tracks in the same repository
- Do not require worktrees for small, read-only, or single-track tasks
- Use worktrees when they reduce edit collisions or simplify multi-agent coordination

**Direct agent invocation:**
```
@manager coordinate rollout for auth changes
@explorer analyze auth module
@bugbuster find the bug
@architect design the fix
@docwriter update the user-facing docs
```

## Docs
- https://docs.anthropic.com/en/docs/claude-code/settings
- https://code.claude.com/docs/en/hooks

## Repository Automation

Repository-level checks are separate from the local Claude profile:

- `.github/workflows/validate.yml` — structural validation on every push and PR
- `.github/workflows/hooks-test.yml` — deterministic hook behavior tests on every push and PR
- `.github/workflows/behavior-benchmark.yml` — behavioral acceptance tasks using the real Claude Code CLI inside benchmark fixtures
- `.github/workflows/security-scan.yml` — repository secret scan on every push and PR, plus weekly schedule

Behavior benchmark recovery metrics are always reported in `summary.json` and the GitHub step summary. By default they are informational only; strict recovery caps are enabled only when `BEHAVIOR_BENCHMARK_MAX_RECOVERED_TASKS` or `BEHAVIOR_BENCHMARK_MAX_SUMMARY_REPAIRED_TASKS` are set explicitly, or when matching `workflow_dispatch` inputs are provided.

Benchmark support files:

- `tests/hooks/` — hook fixtures and assertions
- `bench/tasks/` — benchmark task definitions
- `bench/tasks/subagents/` — golden regression suite for each specialist agent
- `bench/fixtures/` — benchmark fixture repositories
- `docs/agent-contracts.md` — agent contract matrix and how the hook/benchmark layers fit together
- `docs/benchmarking.md` — runner contract and GitHub setup

Each canonical agent alias must have at least one focused task in `bench/tasks/subagents/` with non-empty `required_transcript_patterns` and `forbidden_transcript_patterns`. This keeps agent prompt regressions catchable in CI instead of depending on manual subagent spot checks.

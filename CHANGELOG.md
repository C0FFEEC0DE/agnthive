# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Subagent-Driven Development workflow (`claudecfg/workflows/subagent-driven-development.md`) with file-based handoff scripts (`scripts/task-brief.sh`, `scripts/review-package.sh`), durable progress ledger (`claudecfg/hooks/lib.sh::progress_ledger_path`, `claudecfg/hooks/post-compact.sh`), and plan/spec conventions (`docs/plans/README.md`, `docs/specs/README.md`)
- Three debugging discipline reference docs: `docs/debugging-root-cause-tracing.md`, `docs/debugging-defense-in-depth.md`, `docs/debugging-condition-based-waiting.md`
- 4-status implementer return contract (`DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED`) in `claudecfg/agents/m.md` and additive `Status:` outcome recognition in `claudecfg/hooks/lib.sh`
- Per-task model selection policy in `claudecfg/agents/m.md` and `claudecfg/agents/a.md`; verification-before-completion discipline in `claudecfg/agents/t.md`; systematic root-cause protocol in `claudecfg/agents/dbg.md`
- Trigger-only skill descriptions (< 200 words) for the five slash skills
- `pyproject.toml` coverage configuration (branch coverage on `scripts/*.py`, defensive-line exclusions) and a `make cov` target with a ratcheting `--cov-fail-under` gate at 100 (gate applies to `make cov` only, not `make test`)
- `make hooks` now runs `tests/hooks/test-lib.sh` (~273 direct assertions over the ~49 `lib.sh` enforcement functions)
- Direct pytest tests for every previously-untested `scripts/*.sh` and for `bench_runner_openrouter.py`, `find-failed-benchmark-run.py`, `bench_runner_claude_code.py` (`classify_task_failures`), `select-benchmark-tasks` logic, and the `wait-for-benchmark-slot` / `download-benchmark-summary` / `merge-benchmark-summaries` / `build-benchmark-matrix` scripts
- `tests/hooks/test-lib.sh` unit-test harness wired into `make hooks`, `make lint`, `scripts/validate.sh`, and the Hook Contracts CI workflow
- `tests/test_statusline.py` (10 tests) and `tests/test_install_git_hooks.py` (3 tests)
- End-to-end compare-benchmarks → render-benchmark-report contract test guarding the delta-key contract
- `make bench-precheck` / `scripts/bench-precheck.mjs` to run the smoke precheck locally (mirrors the CI `precheck` job; deterministic, no model/token — drives the same Node CLIs CI uses)

### Changed
- `claudecfg/hooks/lib.sh`: extracted the `message_has_any_line_prefix` helper and deduplicated the seven `message_mentions_*` functions (behavior-identical, ~90 lines removed)
- `scripts/bench_runner_claude_code.py`: extracted the pure `classify_task_failures(...)` from `main()`; pre-initialized the `completed` flag before the 429-retry loop in `run_claude`
- `scripts/find-failed-benchmark-run.py`: moved the `timedelta` import to the top level
- `COV_MIN` gate ratcheted 45 → 100; `scripts/*.py` at 100% line + branch coverage (648 tests)

### Fixed
- `scripts/compare-benchmarks.sh`: now emits `clean_pass_rate`, `recovered_task_rate`, and `summary_repair_rate` deltas that `render-benchmark-report.sh` reads (previously missing → the report crashed with jq exit 5 on real compare output)
- `scripts/bench_runner_claude_code.py`: `forbidden_doc_pattern_hits` was fed a snapshot dict instead of its `.text` string (`TypeError`)

## [0.28] - 2026-06-20

### Fixed
- `claudecfg/settings.json`: track `PostToolUse` state for all file-writing tools (`Edit`, `MultiEdit`, `Write`, and `NotebookEdit`) so Stop gate enforcement no longer misses edits made through multi-edit or notebook-edit payloads
- `claudecfg/hooks/post-edit-write.sh`: normalize changed file paths from `file_path`, `path`, and `notebook_path` payload fields before updating session state

### Added
- Hook regression coverage for `MultiEdit`, `tool_input.path`, and `tool_input.notebook_path` payloads, plus a settings assertion that all file-writing tools remain wired into Stop gate state tracking

## [0.27] - 2026-06-20

Portfolio-readiness release: drift fixes, a minimal-cognitive-load README, a
reorganized `docs/` tree, OSS governance files, professional agent personas,
model-agnostic configuration, harness/hooks best-practice additions, and an
explicit token-cost optimization story. Also the first CHANGELOG-documented
release since 0.22; the previously-unreleased hook fixes are recorded here.

### Added
- OSS governance files: `SECURITY.md` (vulnerability reporting policy), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `.github/ISSUE_TEMPLATE/bug_report.md` and `feature_request.md`, and `.github/PULL_REQUEST_TEMPLATE.md`
- `docs/` index (`docs/README.md`), `docs/architecture.md` (hooks → state → gates → footers flow with diagram), and `docs/token-cost.md` (the explicit six-lever token-optimization narrative)
- `claudecfg/statusline.sh` token-aware status line wired through `settings.json`
- Optional local `scripts/git-hooks/pre-push` secret scanner (grep-based, added-line-only) installable via `scripts/install-git-hooks.sh` as defense-in-depth beyond the Bash deny list
- `make bench-rerun-failed` and `scripts/rerun-failed-benchmark.sh` to re-run only the unresolved subagent smoke tasks via the workflow's `auto_resume` / `resume` selection modes, saving Ollama credits
- Log rotation extended to all JSONL telemetry streams (`session-index`, `pre-compact`, `post-compact`, `config-change`, `instructions-loaded`) via the shared `CLAUDE_CREW_LOG_MAX_BYTES` threshold in `claudecfg/hooks/lib.sh`
- Local benchmark make targets (`bench-mock`, `bench-smoke`, `bench-command`, `bench-assert`, `bench-report`)
- Hook regression cases for policy edge cases and shared-state scenarios

### Changed
- Rewrote `README.md` for minimal cognitive load: one-line value proposition, architecture diagram, agent table, and configuration pointer
- Reorganized documentation to remove the four-way agent/command list duplication across README, GUIDE, and `claudecfg/README.md`; `claudecfg/README.md` is now a directory map and `GUIDE.md` breaks the hook-gated flow into a per-event table
- Softened agent personas to professional, role-focused descriptions (`code-reviewer.md`, `explorer.md`, `manager.md`, `tester.md`, `docwriter.md`); legacy persona aliases (`nerd`, `toxic-senior`, `paranoid`, `big-boss`) retained as hidden aliases so old transcripts and benchmarks still resolve
- Made configuration model-agnostic: removed the pinned third-party provider model from `claudecfg/settings.json`, `GUIDE.md`, and the `Makefile`; the runtime model wins and `OLLAMA_MODEL` is documented as the user-tunable knob
- Lowered the default `effortLevel` from `high` to `medium` and documented it as a spend knob in GUIDE
- Expanded `Bash` deny list in `settings.json` with `rm -rf /` and `rm -rf ~` for belt-and-suspenders coverage alongside the hook scripts

### Fixed
- Removed the dangling `behavior-benchmark.yml` workflow reference (the file did not exist) from the smoke path filter and `scripts/select-benchmark-tasks.py`
- Removed the dangling `housekeeper` symlink rule and malformed loop fragments from `.claude/settings.local.json`
- `claudecfg/hooks/lib.sh`: eliminated the stale state-lock spin and PID-reuse hang by breaking stale locks on the first check
- `claudecfg/hooks/lib.sh`: filtered generic Task tool types (`general-purpose`, `workflow-subagent`) from `effective_started_roles()` so they no longer block agent enforcement when the Task tool records a generic type instead of the actual agent alias
- `claudecfg/hooks/lib.sh`: added `@alias` transcript pattern inference in `infer_started_roles_from_transcript()` so agent mentions like `@nerd`, `@toxic-senior`, `@paranoid`, `@cr`, `@e` in transcript completion lines are canonicalized via `aliases.json` and satisfy specialist handoff gates
- `claudecfg/hooks/lib.sh`: replaced GNU `\b` word boundary in the `@alias` grep pattern with POSIX-compatible `($|[^a-z0-9-])` for macOS BSD grep portability
- `scripts/git-hooks/pre-push`: content scan now filters to added lines (`^\+([^+]|$)`) so context/deletion lines no longer trip false-positive secret matches, and removing a secret is no longer blocked
- `.github/workflows/python-tests.yml`: install `pyyaml` and run the full `tests/` suite (previously a 4-file subset that skipped the YAML-parsing workflow config test)

## [0.22] - 2026-06-02

### Added
- Added docs gate enforcement in `stop-guard.sh` requiring a `Docs status:` footer line for feature/bugfix/refactor/docs workflows when code changes are made, aligning the hook gate with the profile's "docs when behavior changes" step
- Added `docs_required` session state flag in `user-prompt-submit.sh` for task types that imply documentation may need updating
- Added `tests/test_macos_portability.py` TDD regression suite to prevent GNU-specific constructs from silently re-entering the shell surface
- Added hook regression cases for `rm -fr`, `rm -rf -- /`, quoted `$HOME`, and remote bootstrap pipes through `env bash` or `sh`

### Fixed
- `scripts/validate.sh`: replaced GNU-only `find -printf` with portable `sed` so file inventory checks work on BSD/macOS
- `scripts/validate.sh`: replaced bash 4+ `declare -A` associative array with indexed arrays and a lookup helper for command-inventory validation
- `scripts/validate.sh`: replaced GNU `grep -oP` PCRE patterns with portable `sed -E` capture groups in two validation sites
- `tests/install/install-smoke.sh`: added runtime probe selecting `sha256sum` vs `shasum -a 256` so the installer smoke test works on stock macOS
- `claudecfg/hooks/lib.sh`: replaced bash 4+ `${var,,}` lowercase expansion with POSIX `tr` to prevent `bad substitution` errors on macOS /bin/bash 3.2
- `claudecfg/hooks/notification.sh`: replaced GNU `stat -c%s` with runtime-probed BSD-compatible `stat` so `notification.jsonl` log rotation works on macOS
- `claudecfg/hooks/lib.sh`: hardened the portable state lock with PID and timestamp metadata so stale-lock cleanup does not remove a live writer
- `claudecfg/hooks/lib.sh`: classified `make all` as build and `make clean` as other so cleanup commands cannot satisfy verification gates
- `claudecfg/hooks/pre-tool-use.sh` and `permission-request.sh`: reused shared destructive-command detection for safer Linux/macOS hook behavior
- `scripts/bench_runner_claude_code.py` and `scripts/bench_runner_openrouter.py`: made workspace snapshots binary-safe by hashing binary files instead of decoding everything as UTF-8
- `scripts/bench_runner_claude_code.py`: only runs npm verification when `package.json` declares a non-empty `scripts.test`

## [0.21] - 2026-06-02

### Added
- `Behavior Benchmark Full` workflow as a separate manually runnable full-suite entry instead of hiding the full run inside the nightly matrix
- `Behavior Benchmark Subagents Smoke` workflow for fast PR/manual subagent-only checks
- Smart benchmark task selection scripts that map agent, skill, fixture, workflow, and runner changes to the smallest relevant behavioral suites
- Workflow-combination benchmark tasks covering common manager-led chains such as manager+explorer+reviewer and manager+bugbuster/debugger/tester+reviewer
- Golden per-agent benchmark tasks under `bench/tasks/subagents/golden/` so every specialist role has both smoke and stricter regression coverage
- Shared-state hook scenarios via `tests/hooks/scenarios.json` plus scenario-aware `scripts/test-hooks.sh` coverage for multi-hook flows
- `Python Tests` GitHub Actions workflow for non-hook pytest coverage
- `Benchmark Nightly` workflow that runs broader live benchmark suites on schedule when `main` changed in the last 24 hours
- `Notification` hook wiring plus `hooks/notification.sh` log sink for runtime notification telemetry
- `PermissionDenied` hook support so auto-mode classifier denials can retry through the normal approval path when the command is not hard-denied by profile policy
- Auto-execution configuration for project folders (`~/projects/**`, `~/code/**`, `~/repos/**`, `~/work/**`)
- Extended Bash permissions for common dev tools (rm, mkdir, cp, mv, cargo, go, etc.)
- `@debugger` agent for debugging sessions
- `/docs` skill command for documentation
- `skills/` folder for skill definitions
- GitHub Actions security-scan workflow
- CONTRIBUTING.md guidelines
- LICENSE file (MIT)
- Hook-based SDLC gate layer for session start, prompt classification, verification tracking, stop control, and transcript indexing
- Repository-level `Repository Checks` and `Hook Contracts` GitHub Actions workflows
- `Benchmark Smoke` workflow that runs the real Claude Code CLI inside isolated benchmark fixtures and uploads per-task artifacts
- OpenRouter-backed Claude Code benchmark setup documentation
- Behavioral benchmark documentation and summary gate script
- README status badges for repository workflows

### Changed
- Renamed benchmark workflows to clearer GitHub Actions labels: `Behavior Benchmark Smoke`, `Behavior Benchmark Full`, `Behavior Benchmark Subagents Smoke`, and `Behavior Benchmark Subagents Golden`
- Reorganized benchmark tasks into `bench/tasks/smoke/`, `bench/tasks/full/`, `bench/tasks/subagents/smoke/`, and `bench/tasks/subagents/golden/`
- Taught behavioral CI to select only the impacted smoke/full/subagent tasks from changed agents, skills, fixtures, task files, and shared benchmark logic instead of rerunning whole suites by default
- Split the nightly live benchmark matrix so the full workflow suite and the golden subagent suite appear as separate Actions entries and the full suite can be launched manually on `main`
- Expanded the benchmark matrix with a new Node fixture plus fixture-aware verification detection (`pytest`, `npm`, `cargo`, `go`) so manual/full benchmark runs can cover non-Python repos without widening the default PR suite
- Added workflow linting with `actionlint`, shell linting with `shellcheck`, and an installer smoke/idempotency test to the Validate path
- Renamed GitHub workflows to more neutral CI labels and split general `pytest` coverage into a dedicated `Python Tests` workflow while keeping hook-contract checks grouped with the hook harness
- Updated `Repository Checks` to `actions/setup-go@v6` to remove the GitHub Actions Node 20 deprecation warning
- Limited `Benchmark Smoke` to PRs with benchmark-relevant changes and moved the broader live suites into the nightly benchmark workflow so daytime CI stays faster
- Updated `Hook Tests` and `Validate` workflows to `actions/setup-python@v6` so CI is aligned with GitHub's Node 24 migration path
- Restored the live `Behavior Benchmark` default timeout to `300` seconds and added optional `BEHAVIOR_BENCHMARK_MODEL` support so benchmark CI can use a dedicated model without changing the wider repository default
- Switched profile `outputStyle` from `Explanatory` to `Default` to preserve built-in coding instructions
- Added YAML frontmatter to all bundled skills (`/design`, `/docs`, `/refactor`, `/review`, `/test`) with explicit `agent`, `context`, `disable-model-invocation`, `allowed-tools`, and scoped `paths` where useful
- Updated docs (`README`, `GUIDE`, `claudecfg/README`, `CONTRIBUTING`, `CLAUDE.md`) to reflect Notification hook coverage, default output style, and skill-frontmatter requirements
- Behavior Benchmark recovery metrics now remain visible in `summary.json` and the GitHub summary without failing CI by default; strict recovery caps only apply when explicitly set through GitHub variables or `workflow_dispatch`
- `behavior-benchmark.yml`: removed duplicate `max_turns` default assignment
- `benchmark-nightly.yml`: added `--base-ref` to `collect-benchmark-changes` call
- `claudecfg/hooks/`: removed dead `permission_denied_should_retry()` function, added `notification.jsonl` log rotation
- `scripts/wait-for-benchmark-slot.py`: added HTTP 403 rate-limit handling with `Retry-After` header support
- `scripts/validate.sh`: replaced fragile `grep`-based policy checks with robust `jq` validation

### Added

- New pytest coverage: `test_build_benchmark_matrix.py` (shard distribution and chunking), `test_wait_for_benchmark_slot.py` (slot allocation and rate-limit handling), `test_merge_benchmark_summaries.py` (merge logic and totals computation), `test_render_benchmark_summary.py` (jq markdown rendering)
- Benchmark transcript regression coverage now includes a reusable forbidden meta-chatter pattern set and limits forbidden transcript scans to assistant-like entries so user prompts do not trigger false positives
- Golden subagent regression coverage is now explicit: every canonical agent alias must have at least one focused benchmark task with `agent_alias` plus non-empty required/forbidden transcript assertions, and the contract is documented in `docs/agent-contracts.md`
- `PermissionDenied` retry behavior now disables retries in benchmark headless runs so denied shell commands do not consume turn budget during automated benchmark tasks
- Tightened prompt classification so benchmark `Workflow override` and `workflow_category` markers take priority over keyword heuristics, preventing `fixture`/similar text from misclassifying refactor tasks as bugfix work
- Moved the canonical installer entrypoint to repository root `./install.sh` and kept `claudecfg/install.sh` as a compatibility wrapper
- Fixed agent types to use specialized types instead of `general-purpose`
- Reworked workflows around hook-gated execution instead of manager auto-execution promises
- Moved release/deploy out of the default profile into an optional manual checklist
- Updated docs to reflect implemented commands only
- Updated GUIDE.md with new agents and skills
- Updated GitHub Actions workflows to run on every push
- Replaced the custom benchmark coding-agent workflow with automatic real Claude Code CLI runs via OpenRouter
- Removed the standalone `Real Claude Code` smoke workflow in favor of the `Behavior Benchmark` workflow family
- Tightened hook safety and completion gates: expanded dangerous-command blocking, unified failed test/lint/build gating, and moved `Stop` enforcement fully into shell hooks to avoid tool-only prompt-hook failures
- Moved `SubagentStop` enforcement into a shell hook so subagent stop validation no longer depends on prompt-hook message availability
- Updated shell stop gating so repos without detectable `test`/`lint`/`build` commands do not deadlock completion after config changes
- Added role-based subagent enforcement for `feature`, `bugfix`, `refactor`, `review`, and `docs` workflows before completion, with alias normalization and workflow-specific required roles
- Extended `SubagentStart` normalization to prefer alias, name, and subagent-type fields from snake_case and camelCase payloads before generic runtime types
- Updated workflow context and stop feedback with a stop-safe no-op footer for later replies in already dirty sessions
- Switched manager-led workflow enforcement to track manager activation via `manager_mode` instead of incorrectly requiring `@m` as a specialist subagent handoff
- Added an early-specialist-handoff guard so manager-led workflows cannot go idle before delegating to at least one specialist role
- Reworked benchmark automation so the main acceptance path now uses the real Claude Code CLI instead of a one-shot OpenRouter worker
- Improved GitHub Actions observability with readable Claude diagnostics in workflow logs, step summaries, and benchmark task artifacts
- Expanded `Behavior Benchmark` live logs with per-task metadata, prompt excerpts, raw Claude JSON excerpts, patch excerpts, and structured result dumps
- Added per-task `claude-debug.log` capture for the live benchmark path so empty-result failures can be debugged from Claude CLI traces
- Updated the live benchmark runner to use `--permission-mode acceptEdits` and surface `subtype`, `stop_reason`, and permission-denial diagnostics in task results
- Increased the default `Behavior Benchmark` turn budget from `8` to `12` per task
- Added an explicit workflow override to benchmark prompts so implementation tasks are not misclassified as `review` by hook-driven prompt classification
- Switched the default OpenRouter model for the live Claude Code benchmark path to `nvidia/nemotron-3-super-120b-a12b:free`
- Taught `Stop` and `SubagentStop` shell guards to recover the last assistant summary from `transcript_path` when live runtime payloads omit `last_assistant_message`
- Taught the live benchmark runner to recover final summaries from the session transcript when Claude returns an empty `.result` payload after otherwise-valid work
- Enabled fail-fast and a wall-clock timeout in `Behavior Benchmark` so CI stops quickly after the first failed task instead of burning the full task set
- Increased the default `Behavior Benchmark` turn budget from `12` to `16` per task
- Increased the live benchmark task timeout from `180` to `300` seconds so slower OpenRouter-backed models can finish after successful edits and verification
- Updated the benchmark harness to copy the repository `.claude/` directory into each fixture workdir so project-local Claude settings are exercised during live behavioral runs
- Allowed root-level `Read`, `Glob`, and `Grep` in Claude settings so live benchmark agents can inspect `.` without avoidable permission denials
- Made the `bugfix-zero-division` benchmark contract explicitly require a `README.md` update so docs compliance is unambiguous for the first bugfix gate
- Added task-level `forbidden_doc_patterns` support to the benchmark runner so docs tasks can fail on hallucinated files, commands, or clone steps in generated README changes
- Tightened `docs-quickstart-clarity` to forbid invented files or install steps such as `requirements.txt`, `generate_report.py`, `git clone`, and `pip install -r`
- Updated review guidance so broad workflow, subsystem, and multi-file reviews should normally map the area with `@explorer` before `@code-reviewer`, while keeping `@cr` as the only enforced review gate

### Fixed
- Extended validation/test coverage for the new Notification hook and skill frontmatter contract
- New Feature workflow missing implementation and test steps
- Missing post-implementation code review in workflows
- `make lint` is now tracked as lint instead of build in hook session state
- `Stop`/`TaskCompleted`/`TeammateIdle` now consistently block after failed verification commands
- Added regression coverage for force-push, `mkfs*`, remote bootstrap pipes, tool-only stop turns, and incomplete final summaries
- Added shell-based regression coverage for incomplete subagent summaries and missing subagent assistant messages
- Fixed false `@general-purpose` role recording when specialized subagents were invoked through generic runtime payload fields
- Reduced stop-loop UX friction by surfacing a ready-to-use no-change footer in stop-guard feedback
- Fixed live `SubagentStop` and `Stop` false blocks caused by missing `last_assistant_message` in runtime hook payloads despite valid assistant summaries in the session transcript
- Fixed false review gating when runtimes recorded specialist launches only in transcript lines such as `Skill(/review)` or `Code Reviewer(...)`
- Fixed stop-loop false blocks when manager-led workflows were backgrounded before the first specialist handoff completed
- `claudecfg/hooks/lib.sh`: replaced Linux-only `flock` with a portable `mkdir`-based lockfile (`_acquire_state_lock` / `_release_state_lock`) so `_atomic_state_update` works on macOS; the `200>>$file` fd-redirect was dropped
- `claudecfg/hooks/lib.sh` and the shell scripts in `scripts/` plus `tests/install/install-smoke.sh`: replaced bash 4+ `mapfile` calls with `while IFS= read -r` loops so the user-facing shell surface runs on macOS /bin/bash 3.2
- `.shellcheckrc`: refreshed the `SC2094` rationale comment to describe the new mkdir-lockfile strategy

## [1.0.0] - 2026-03-19

### Added
- Initial release with 8 agents
- 10 slash commands
- 5 workflows
- Manager agent with execution planning
- Security-scan workflow documentation

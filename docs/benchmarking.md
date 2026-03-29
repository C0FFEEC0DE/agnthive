# Behavioral Benchmarking

This repository has two benchmark paths:

- `scripts/bench_runner_openrouter.py` — legacy one-shot worker for cheap baseline experiments
- `scripts/bench_runner_claude_code.py` — the primary real Claude Code benchmark runner that executes `claude -p` inside isolated fixture repositories

If you want to know whether the installed profile actually works as a coding agent, use the real Claude Code path. This is also the only live Claude runtime workflow in GitHub Actions.

## What It Checks

The behavioral benchmark copies each fixture from `bench/fixtures/` into a temporary task workdir, runs the benchmark task selected by `task_glob`, and then evaluates the outcome.

Current task assertions include:

- workspace changes were actually made
- verification-required tasks still pass `pytest -q`
- the final Claude response includes:
  - `Verification status:`
  - `Review outcome:`
  - `Remaining risks:`
- docs-required tasks changed documentation
- docs-only tasks did not change non-doc files

This makes the benchmark a behavioral acceptance gate, not just a process smoke test.

The live GitHub workflow now defaults to the fuller suite in `bench/tasks/*.json`. It is meant to validate the agent workflow on actual code changes rather than only the cheapest smoke cases:

- edit the right files
- implement a small bugfix end to end
- add a new API with tests and docs
- keep docs-only tasks out of runtime code
- run `pytest -q` when code changed
- update docs when behavior changed
- preserve existing behavior during a bounded refactor
- finish with the required verification/review/risk footer

The lighter tasks in `bench/tasks/lite/*.json` remain available for manual cheaper smoke runs when you only want a quick provider or prompt sanity check.

The runner invokes Claude Code with `--permission-mode acceptEdits` so isolated fixture repositories can be modified non-interactively during CI. The bundled profile also allows `pytest` directly because benchmark tasks explicitly ask for `pytest -q`, so harmless verification runs do not inflate `permission_denials_count`. If a task still fails, inspect `claude_subtype`, `claude_stop_reason`, `permission_denials_count`, and `first_permission_denial` in the task summary and `result.json`.
The GitHub workflow default is `16` turns per task so CI stays bounded; raise it manually in `workflow_dispatch` when you want a slower debug run.
The runner also injects an explicit workflow override into the prompt so bugfix, feature, refactor, and docs tasks are not misclassified as review-only work just because the final summary must mention review outcome.
The benchmark prompt now requires the final response to end with an exact 3-line footer for verification, review, and remaining-risk status. If the model omits any of those lines, the runner performs up to `5` footer-only repair retries and then synthesizes a conservative footer from the known verification facts as a last resort.
The shell stop guards now fall back to the benchmark session transcript when a runtime omits `last_assistant_message` from `Stop` or `SubagentStop` payloads, so valid summaries are still recognized in live CI runs.
The benchmark runner now mirrors that fallback for Claude CLI results: if `.result` is empty but the session transcript contains a valid multiline summary, the task can still pass. If Claude hits the wall-clock timeout after already leaving correct workspace changes behind and the post-run checks confirm tests, docs, and required summaries, the runner records `timeout_recovered=true` and keeps the task green instead of failing on `exit_code=124` alone. GitHub CI also enables fail-fast, so the live benchmark stops after the first failed task instead of burning time on the rest of the matrix. The summary reports both `configured_tasks` and `executed_tasks`, so truncated runs are not mistaken for full-suite coverage. The live workflow currently gives each task up to `420` seconds of wall-clock runtime before the runner times it out, and `workflow_dispatch` can override that with `timeout_seconds`.
The live workflow also caps Claude Code with `CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096` by default, which keeps Ollama Cloud requests inside the configured budget for benchmark runs; override it with `BEHAVIOR_BENCHMARK_MAX_OUTPUT_TOKENS` or the `workflow_dispatch` input when you need a larger response budget. If Ollama Cloud still rejects a request with a `402` affordability error, the Claude benchmark runner automatically retries with a lower output-token budget derived from the provider error before failing the task. The runner also retries short-lived upstream provider errors such as broken tool-call envelopes before giving up on the task.
The benchmark harness also now exercises the same project-local Claude settings as the repository by copying `.claude/` into each fixture workdir. Root-level read-only tool calls such as `Read(.)`, `Glob(.)`, and `Grep(.)` are allowed so models do not waste turns on harmless repository scans.
Benchmark tasks may also declare `forbidden_doc_patterns`; the runner scans changed documentation files and fails the task if the edited docs mention forbidden hallucinated paths or commands. Those patterns should target invented commands themselves, not negative statements that say an install or clone step is unnecessary.

## GitHub Workflow

The behavioral benchmark workflow is:

- `.github/workflows/behavior-benchmark.yml`

It:

1. installs the Claude Code CLI
2. runs `claudecfg/install.sh` so CI uses the same repo installer as local setup
3. copies the repository `.claude/` directory into each isolated fixture workdir so project-local config is exercised during the benchmark
4. runs `scripts/run-benchmark.sh` in `command` mode with the default `bench/tasks/*.json` task glob
5. uses `scripts/bench_runner_claude_code.py` as the per-task runner
6. uploads per-task Claude artifacts plus `summary.json`
7. fails the workflow unless every benchmark task passes

## Required GitHub Setup

Repository settings:

1. `Settings -> Secrets and variables -> Actions -> New repository secret`
2. Add `OLLAMA_API_KEY`
3. `Settings -> Secrets and variables -> Actions -> Variables`
4. Add `OLLAMA_MODEL`
5. Optionally add `BEHAVIOR_BENCHMARK_TIMEOUT_SECONDS` to override the benchmark per-task timeout
6. Optionally add `BEHAVIOR_BENCHMARK_MAX_OUTPUT_TOKENS` to override the Claude Code output-token cap

Required benchmark model:

```text
qwen3.5:cloud
```

Recommended benchmark timeout:

```text
420
```

Recommended benchmark max output tokens:

```text
4096
```

## Local Usage

With Claude Code CLI and Ollama Cloud env vars available:

```bash
export OLLAMA_API_KEY=...
export ANTHROPIC_BASE_URL=https://ollama.com
export ANTHROPIC_AUTH_TOKEN="$OLLAMA_API_KEY"
export ANTHROPIC_API_KEY=
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3.5:cloud}"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-4096}"
export BENCH_RUNNER_CMD="python3 scripts/bench_runner_claude_code.py"
bash scripts/run-benchmark.sh --output-dir /tmp/claude-bench --mode command
bash scripts/assert-benchmark-summary.sh /tmp/claude-bench/summary.json
```

To run the lighter manual suite instead of the default full suite:

```bash
bash scripts/run-benchmark.sh --output-dir /tmp/claude-bench-lite --mode command --task-glob 'bench/tasks/lite/*.json'
```

For cheap synthetic checks without the real agent:

```bash
bash scripts/run-benchmark.sh --output-dir /tmp/claude-bench-mock --mode mock
```

## Output Artifacts

Each task directory contains:

- `result.json`
- `task-prompt.txt`
- `task-summary.txt`
- `claude-result.json`
- `claude-result.txt`
- `claude-debug.log`
- `claude-stderr.log`
- `workspace.patch`
- `changed-files.json`

The benchmark root contains:

- `summary.json`

Use `summary.json` as the machine-readable gate and the per-task artifacts for debugging failures.
The workflow log now prints task metadata, model, workdir, prompt excerpt, raw Claude JSON excerpt, parsed failure reasons, debug log excerpt, verification output, patch excerpt, and full `result.json` for each task.

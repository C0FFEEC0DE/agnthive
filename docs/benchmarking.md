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
- implementation tasks verify the final Claude response includes exact stop-safe summary lines for `Verification status:`, `Review outcome:`, `Changed files:` or `No files changed:`, and `Remaining risks:`
- subagent golden tasks verify the transcript includes exact handoff-footer markers for `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and `Remaining risks:` or `Next step:`
- docs-required tasks changed documentation
- docs-only tasks did not change non-doc files

This makes the benchmark a behavioral acceptance gate, not just a process smoke test.

The live GitHub workflow now defaults to the cheaper suite in `bench/tasks/lite/*.json` so it can run on smaller models without turning every push into a long provider soak:

- implement a small bugfix end to end
- keep a docs-only task out of runtime code
- preserve behavior during a bounded refactor
- run `pytest -q` when code changed
- finish with the required stop-safe summary or subagent handoff footer

The fuller suite in `bench/tasks/*.json` remains available for manual or slower runs when you want broader workflow coverage.

The runner invokes Claude Code with `--permission-mode acceptEdits` so isolated fixture repositories can be modified non-interactively during CI. The bundled profile also allows `pytest` directly because benchmark tasks explicitly ask for `pytest -q`, so harmless verification runs do not inflate `permission_denials_count`. If a task still fails, inspect `claude_subtype`, `claude_stop_reason`, `permission_denials_count`, and `first_permission_denial` in the task summary and `result.json`.
The GitHub workflow default is `8` turns per task so CI stays bounded for small models; raise it manually in `workflow_dispatch` when you want a slower debug run.
The runner also injects an explicit workflow override into the prompt so bugfix, feature, refactor, and docs tasks are not misclassified as review-only work just because the final summary must mention review outcome.
Manager-led tasks are expected to continue orchestration after manager activation unless the prompt explicitly asks for plan-only behavior. The benchmark contract now expects an early specialist handoff rather than prolonged manager-only analysis.
Parallel same-role handoffs are allowed when the manager gives them distinct scopes; benchmarks should treat that as an orchestration optimization, not as extra required role coverage.
The benchmark prompt now requires the final response to end with the exact hook-recognized summary lines for the relevant workflow. For main implementation tasks that means `Verification status:`, `Review outcome:`, `Changed files:` or `No files changed:`, and `Remaining risks:`. For subagent-oriented tasks it means `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and one closure line: `Remaining risks:` or `Next step:`. If the model omits required main-task summary lines, the runner performs up to `5` footer-only repair retries and then synthesizes a conservative footer from the known verification facts as a last resort.
The shell stop guards now fall back to the benchmark session transcript when a runtime omits `last_assistant_message` from `Stop` or `SubagentStop` payloads, so valid summaries are still recognized in live CI runs.
The benchmark runner now mirrors that fallback for Claude CLI results: if `.result` is empty but the session transcript contains a valid multiline summary, the task can still pass. If Claude hits the wall-clock timeout after already leaving correct workspace changes behind and the post-run checks confirm tests, docs, and required summaries, the runner records `timeout_recovered=true` and keeps the task green instead of failing on `exit_code=124` alone. GitHub CI also enables fail-fast, so the live benchmark stops after the first failed task instead of burning time on the rest of the matrix. The summary reports both `configured_tasks` and `executed_tasks`, so truncated runs are not mistaken for full-suite coverage. The live workflow currently gives each task up to `240` seconds of wall-clock runtime before the runner times it out, and `workflow_dispatch` can override that with `timeout_seconds`.
The live workflow also caps Claude Code with `CLAUDE_CODE_MAX_OUTPUT_TOKENS=1024` by default, which keeps Ollama Cloud requests smaller and faster for benchmark runs; override it with `BEHAVIOR_BENCHMARK_MAX_OUTPUT_TOKENS` or the `workflow_dispatch` input when you need a larger response budget. If Ollama Cloud still rejects a request with a `402` affordability error, the Claude benchmark runner automatically retries with a lower output-token budget derived from the provider error before failing the task. The runner also retries short-lived upstream provider errors such as broken tool-call envelopes before giving up on the task.
Recovery metrics such as `recovered_tasks`, `timeout_recovered`, `max_turns_recovered`, and `summary_repaired` are always written into `summary.json` and surfaced in the GitHub step summary. By default they are report-only signals so the pipeline stays focused on profile behavior rather than model variance. They become hard gates only when strict caps are provided explicitly through repository variables or `workflow_dispatch` inputs.
The benchmark harness also now exercises the same project-local Claude settings as the repository by copying `.claude/` into each fixture workdir. Root-level read-only tool calls such as `Read(.)`, `Glob(.)`, and `Grep(.)` are allowed so models do not waste turns on harmless repository scans.
Benchmark tasks may also declare `forbidden_doc_patterns`; the runner scans changed documentation files and fails the task if the edited docs mention forbidden hallucinated paths or commands. Those patterns should target invented commands themselves, not negative statements that say an install or clone step is unnecessary.
Benchmark tasks may also declare `forbidden_transcript_patterns`; the runner scans the Claude session transcript and fails the task if those patterns appear anywhere in the interaction. This is useful for catching orchestration regressions such as asking the user to choose mandatory subagents instead of selecting them automatically.
Benchmark tasks may also declare `required_transcript_patterns`; the runner scans assistant/result transcript entries and fails the task if those regexes never appear. This is useful for subagent-focused cases where you want evidence of the expected handoff format or review/debug/testing structure without matching the user prompt itself. The repository validator now enforces a shared footer-marker subset across all golden subagent tasks so those transcript requirements do not drift away from the hook contract.
For prompt-behavior regressions, keep a reusable forbidden pattern set in [`../bench/patterns/forbidden-meta-chatter.json`](../bench/patterns/forbidden-meta-chatter.json). Use it to block internal-enforcement leakage such as `I see the issue`, `prefix match`, `shell guard`, or other footer-repair chatter from appearing in assistant output. The runner evaluates forbidden transcript patterns against assistant-like transcript entries only, so user prompts quoting those phrases do not create false failures.

Recommended transcript regression coverage:

- `@e` exploration task: require structural mapping output and forbid footer-repair chatter
- `@m` coordination task: require planning/coordinating output and forbid hook-mechanics chatter
- `@cr` review task: require findings output and forbid guard/prefix/meta formatting chatter

Additional focused suites can live under nested globs such as:

- `bench/tasks/subagents/*.json` for single-agent behavior checks
- `bench/tasks/chains/*.json` for longer orchestration suites when you want them

The subagent suite under `bench/tasks/subagents/*.json` is the repository's golden regression suite for agent behavior. Every canonical agent alias is expected to have coverage there, and each task should include both `required_transcript_patterns` and `forbidden_transcript_patterns` so the runner can catch “agent did not do the expected thing” failures automatically. In addition to role-specific markers such as `Findings:` or `Root cause:`, every subagent golden task is expected to carry the shared footer markers `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and `Remaining risks:` or `Next step:`.

## GitHub Workflow

The behavioral benchmark workflow is:

- `.github/workflows/behavior-benchmark.yml`

It:

1. installs the Claude Code CLI
2. runs `./install.sh` so CI uses the same repo installer as local setup
3. copies the repository `.claude/` directory into each isolated fixture workdir so project-local config is exercised during the benchmark
4. runs `scripts/run-benchmark.sh` in `command` mode with the default `bench/tasks/lite/*.json` task glob
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
7. Optionally add `BEHAVIOR_BENCHMARK_MAX_RECOVERED_TASKS` to enable strict gating on recovered tasks
8. Optionally add `BEHAVIOR_BENCHMARK_MAX_SUMMARY_REPAIRED_TASKS` to enable strict gating on summary-repaired tasks

Required benchmark model:

```text
qwen3.5:cloud
```

Recommended benchmark timeout:

```text
240
```

Recommended benchmark max output tokens:

```text
1024
```

Strict mode is opt-in. Leave the recovery-cap variables unset if you want recovered tasks to remain informational only.

## Local Usage

With Claude Code CLI and Ollama Cloud env vars available:

```bash
export OLLAMA_API_KEY=...
export ANTHROPIC_BASE_URL=https://ollama.com
export ANTHROPIC_AUTH_TOKEN="$OLLAMA_API_KEY"
export ANTHROPIC_API_KEY=
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3.5:cloud}"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-1024}"
export BENCH_RUNNER_CMD="python3 scripts/bench_runner_claude_code.py"
bash scripts/run-benchmark.sh --output-dir /tmp/claude-bench --mode command
bash scripts/assert-benchmark-summary.sh /tmp/claude-bench/summary.json
```

To run the fuller manual suite instead of the default cheap CI suite:

```bash
bash scripts/run-benchmark.sh --output-dir /tmp/claude-bench-full --mode command --task-glob 'bench/tasks/*.json'
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

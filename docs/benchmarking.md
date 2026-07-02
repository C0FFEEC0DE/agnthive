# Behavioral Benchmarking

This repository has two benchmark paths:

- `scripts/bench_runner_openrouter.mjs` — one-shot worker for cheap baseline experiments
- `scripts/bench_runner_claude_code.mjs` — the primary real Claude Code benchmark runner that executes `claude -p` inside isolated fixture repositories

If you want to know whether the installed profile actually works as a coding agent, use the real Claude Code path. GitHub Actions exposes that live path through separate smoke and subagent benchmark workflows.

## What It Checks

The behavioral benchmark copies each fixture from `bench/fixtures/` into a temporary task workdir, runs the benchmark task selected by `task_glob`, and then evaluates the outcome.

Current task assertions include:

- workspace changes were actually made
- verification-required tasks still pass the fixture-appropriate test command such as `node --test`, `npm test`, `cargo test`, or `go test ./...` (the bundled JS fixtures under `bench/fixtures/python-math` and `bench/fixtures/text-report` run via `node --test`)
- implementation tasks verify the final Claude response includes exact stop-safe summary lines for `Verification status:`, `Review outcome:`, `Changed files:` or `No files changed:`, and `Remaining risks:`
- transcript-sensitive tasks verify handoff markers only when the benchmark is explicitly about stable output shape
- workflow-combination tasks prefer `required_used_agents` and `required_used_agent_groups` so CI checks which specialist roles actually ran instead of brittle `Task:` headings
- role-sensitive tasks resolve actual subagent usage from `SubagentStart` and recorded handoff lines in the debug log; `@alias` patterns in transcript entries (e.g. `@code-reviewer`, `@explorer`, `@cr`) are canonicalized to canonical role aliases
- when a task needs a stable visible marker for role usage, the runner also accepts explicit `Handoff evidence: @alias ...` transcript lines as canonical handoff evidence
- docs-required tasks changed documentation
- docs-only tasks did not change non-doc files

**`docs_required` assertion logic:** The runner checks `task["docs_required"]` and `task["docs_updated"]` from the benchmark summary. If `docs_required=true` and `docs_updated=false`, the task fails with `docs_not_updated`. The `docs_updated` flag is set to `true` when any changed file matches the docs-path heuristic: extensions `.md`, `.mdx`, `.txt`, `.rst`, `.adoc`, `.markdown`; paths containing `/docs/`; filenames starting with `readme` or `changelog`; or the file `claude.md`.

To mark a task as docs-not-needed, set `docs_required: false` in the task JSON. Fixture-only bugfix tasks (tasks that modify fixture code but have no real documentation to update) should use `"docs_required": false` to avoid false failures. Tasks that are purely verification or code-change focused and do not affect user-facing docs should also use `"docs_required": false`.

This makes the benchmark a behavioral acceptance gate, not just a process smoke test.

The live GitHub smoke workflow uses the suite in `bench/tasks/smoke/*.json` (if present) so it can run on smaller models without turning every PR into a long provider soak.

The runner invokes Claude Code with `--permission-mode acceptEdits` so isolated fixture repositories can be modified non-interactively during CI. The bundled profile allows the relevant fixture-local test commands directly, including `node`, `npm`, `cargo`, and `go`, so harmless verification runs do not inflate `permission_denials_count`. If a task still fails, inspect `claude_subtype`, `claude_stop_reason`, `permission_denials_count`, and `first_permission_denial` in the task summary and `result.json`.
The GitHub smoke workflow default is `6` turns per task so CI stays bounded for small models; raise it manually in `workflow_dispatch` when you want a slower debug run.
The runner also injects an explicit workflow override into the prompt so bugfix, feature, refactor, and docs tasks are not misclassified as review-only work just because the final summary must mention review outcome.
Manager-led tasks are expected to continue orchestration after manager activation unless the prompt explicitly asks for plan-only behavior. The benchmark contract now expects an early specialist handoff rather than prolonged manager-only analysis.
Parallel same-role handoffs are allowed when the manager gives them distinct scopes; benchmarks should treat that as an orchestration optimization, not as extra required role coverage.
The benchmark prompt now requires the final response to end with the exact hook-recognized summary lines for the relevant workflow. For main implementation tasks that means `Verification status:`, `Review outcome:`, `Changed files:` or `No files changed:`, and `Remaining risks:`. For subagent-oriented tasks it means `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and one closure line: `Remaining risks:` or `Next step:`. If the model omits required main-task summary lines, the runner performs up to `5` footer-only repair retries and then synthesizes a conservative footer from the known verification facts as a last resort.
The shell stop guards now fall back to the benchmark session transcript when a runtime omits `last_assistant_message` from `Stop` or `SubagentStop` payloads, so valid summaries are still recognized in live CI runs.
The benchmark runner now mirrors that fallback for Claude CLI results: if `.result` is empty but the session transcript contains a valid multiline summary, the task can still pass. If Claude hits the wall-clock timeout after already leaving correct workspace changes behind and the post-run checks confirm tests, docs, and required summaries, the runner records `timeout_recovered=true` and keeps the task green instead of failing on `exit_code=124` alone. GitHub CI also enables fail-fast, so the live benchmark stops after the first failed task instead of burning time on the rest of the matrix. The summary reports both `configured_tasks` and `executed_tasks`, so truncated runs are not mistaken for full-suite coverage. The live workflow currently gives each task up to `400` seconds of wall-clock runtime before the runner times it out, and `workflow_dispatch` can override that with `timeout_seconds`.
The live workflow also caps Claude Code with `CLAUDE_CODE_MAX_OUTPUT_TOKENS=768` by default, which keeps Ollama Cloud requests smaller and faster for benchmark runs; override it with `BEHAVIOR_BENCHMARK_MAX_OUTPUT_TOKENS` or the `workflow_dispatch` input when you need a larger response budget. If Ollama Cloud still rejects a request with a `402` affordability error, the Claude benchmark runner automatically retries with a lower output-token budget derived from the provider error before failing the task. The runner also retries short-lived upstream provider errors such as broken tool-call envelopes before giving up on the task.

**Ollama rate-limit (429) retry:** The benchmark runner detects HTTP 429 rate-limit errors from Ollama by scanning stderr for `429` or `rate limit` strings. On detection, it retries with exponential backoff (base delay 8s, up to 4 attempts: 8s, 16s, 32s, 64s). The 429 check is also included in the provider-error retry detection so `try_provider_retry()` can recognize rate-limit errors even when the exit code is non-zero. This handles Ollama Cloud's secondary rate-limit responses that may appear mid-request rather than as HTTP 429 headers.

Recovery metrics such as `recovered_tasks`, `timeout_recovered`, `max_turns_recovered`, and `summary_repaired` are always written into `summary.json` and surfaced in the GitHub step summary. By default they are report-only signals so the pipeline stays focused on profile behavior rather than model variance. They become hard gates only when strict caps are provided explicitly through repository variables or `workflow_dispatch` inputs.
The benchmark harness now bootstraps `~/.claude/`, `~/.claude/state/`, and `~/.claude/logs/` before live runs so Claude Code does not spend benchmark turns recreating missing home-state directories or emit avoidable ENOENT noise in CI logs. It also mirrors the installed Claude profile into each fixture workdir when available, so task-local config resolution matches the live repository setup more closely. Root-level read-only tool calls such as `Read(.)`, `Glob(.)`, and `Grep(.)` are allowed so models do not waste turns on harmless repository scans.
Benchmark tasks may also declare `forbidden_doc_patterns`; the runner scans changed documentation files and fails the task if the edited docs mention forbidden hallucinated paths or commands. Those patterns should target invented commands themselves, not negative statements that say an install or clone step is unnecessary.
Benchmark tasks may also declare `forbidden_transcript_patterns`; the runner scans the Claude session transcript and fails the task if those patterns appear anywhere in the interaction. This is useful for catching orchestration regressions such as asking the user to choose mandatory subagents instead of selecting them automatically.
Benchmark tasks may also declare `required_transcript_patterns`; the runner scans assistant/result transcript entries and fails the task if those regexes never appear. This is useful when the benchmark is specifically about a stable handoff shape or review/debug/testing structure without matching the user prompt itself.

**Note on forbidden patterns:** Keep `forbidden_transcript_patterns` minimal (e.g., `["footer repair", "shell guard"]`) to avoid false positives.
Benchmark tasks may also declare `required_used_agents` and `required_used_agent_groups`; the runner parses actual `SubagentStart`, recorded handoff lines, and explicit `Handoff evidence: @alias ...` transcript entries from the effective debug log of the attempt that produced the final result and fails the task if the expected role usage never happened. Use this for workflow-combination, docs, or manager-led orchestration workflows where the right behavioral signal is "which role actually ran", not "did the final visible reply preserve one exact heading block".
The repository validator now requires every subagent task to declare at least one required-behavior assertion through transcript patterns or used-agent expectations. If a subagent task still relies on transcript requirements, validation also enforces the shared footer-marker subset so those regexes do not drift away from the hook contract.
For prompt-behavior regressions, keep a reusable forbidden pattern set in [`../bench/patterns/forbidden-meta-chatter.json`](../bench/patterns/forbidden-meta-chatter.json). Use it to block internal-enforcement leakage such as `I see the issue`, `prefix match`, `shell guard`, or other footer-repair chatter from appearing in assistant output. The runner evaluates forbidden transcript patterns against assistant-like transcript entries only, so user prompts quoting those phrases do not create false failures.

Recommended transcript regression coverage:

- `@e` exploration task: require structural mapping output and forbid footer-repair chatter
- `@m` coordination task: require planning/coordinating output and forbid hook-mechanics chatter
- `@cr` review task: require findings output and forbid guard/prefix/meta formatting chatter

The subagent smoke suite under `bench/tasks/subagents/smoke/*.json` keeps one canary task per canonical alias for PR-time coverage. Tasks that still validate transcript shape are expected to carry the shared footer markers `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and `Remaining risks:` or `Next step:` so role prompts, hook contracts, and runner assertions stay aligned.

## Agent-Dispatch Evidence Split

The runner resolves agent-usage evidence from three disjoint sources so a strict observed-dispatch contract can be layered in without changing the legacy pass/fail behavior:

- **hook** — real `SubagentStart` events and `Recorded subagent handoff: @alias` echoes captured in the effective debug log. Only these count as genuine dispatch (`hookSourceAliases`).
- **transcript** — launch-like lines inferred from the structured session transcript (`inferUsedAgentAliasesFromTranscript`).
- **claimed** — `Handoff evidence: @alias ...` markers and prose `@alias` patterns in the final result text (`inferUsedAgentAliasesFromResultText`).

`extractUsedAgentEvidence` returns these as disjoint sets plus a `byAlias` map; `extractUsedAgentAliases` returns their union (unchanged legacy behavior used by pass/fail).

Per-task `result.json` gains four additive fields (existing fields are unchanged):

- `observed_agent_aliases` — hook source only (real dispatch).
- `claimed_agent_aliases` — textual claims (transcript + claimed) **minus** any alias that has a real hook, so an alias proved by a `SubagentStart` is counted as observed, not claimed. `observed` and `claimed` form a clean partition: `observed ∪ claimed == used_agent_aliases`.
- `agent_evidence_by_alias` — per-alias `{hook, transcript, claimed}` booleans.
- `dispatch_mode` — `'standard' | 'observed' | 'enforced'`.

`task-summary.txt` gains corresponding lines: `Observed agent aliases (hook):`, `Claimed agent aliases (text):`, and `Dispatch mode:`.

`dispatch_mode` is resolved by `resolveDispatchMode(task)` from `task.dispatch_contract.mode`:

- **`standard`** (default, absent) — credits the union of hook + transcript + claimed. Pass/fail behavior is unchanged from the legacy contract.
- **`observed`** — strict: only a real `SubagentStart` (the hook source) satisfies `required_used_agents`; prose `Handoff evidence:` claims and transcript launch-text do **not**. `effectiveUsedAliasesForEnforcement` returns `observed_agent_aliases` (hook-only) instead of the union, so a role mentioned only in prose still triggers `required_used_agents_missing`.
- **`enforced`** — parsed and surfaced identically to `observed` for pass/fail, **and** backed by a hard `PreToolUse` harness guard (Stage 5, wired). When a task is in `enforced` mode, the plugin's `PreToolUse` handler for `Edit|MultiEdit|Write|NotebookEdit` denies any root edit until at least one of the required roles has a real `SubagentStart` recorded in session state — forcing dispatch as a harness constraint rather than relying on prompt discipline. Non-bench sessions never carry the marker, so `dispatch_contract_mode` stays `''` and the guard is inert; `observed`/`standard` modes pass through unchanged.

Under `observed`/`enforced`, the runner's `requiredUsedAgentMisses` is fed `enforceUsed` (hook-only aliases), so `classifyTaskFailures` fails the task when a required role has no real `SubagentStart`. Under `standard` the union is still credited unchanged. The `observed_*` / `claimed_*` / `agent_evidence_by_alias` fields remain diagnostic in all modes; the strict wiring only narrows which aliases count toward `required_used_agents_missing`.

## Dispatch Contract Marker

The `dispatch_contract` task field lets a benchmark task declare an exact specialist contract so the runner and the plugin hook agree on a single required-role set instead of the category defaults. It is optional; tasks without it keep the legacy behavior.

Shape (validated by `scripts/validate.mjs`):

```json
"dispatch_contract": {
  "mode": "observed",
  "required_agents": ["bug"],
  "root_only": true
}
```

- **`mode`** — one of `standard` | `observed` | `enforced` (see the evidence-split semantics above).
- **`required_agents`** — canonical alias list; the validator requires it to be a non-empty array of known aliases and to match `required_used_agents` exactly (same set), so the runner field and the contract field cannot drift apart.
- **`root_only`** — boolean; the runner always emits the marker as `root_only` because `buildPrompt` runs once for the root prompt and never for a subagent, so a specialist cannot recursively re-dispatch itself.

The runner's `dispatchContractMarker(task)` builds a single line from those fields:

```text
BENCHMARK_DISPATCH_CONTRACT: root_only; mode=observed; roles=bug
```

`buildPrompt` injects it into the root benchmark prompt only. The plugin's `UserPromptSubmit` classifier (`parseDispatchContractMarker` / `RE_DISPATCH_CONTRACT` in `modules/workflow.mjs`) parses that marker and, when present, **overrides the category-default required roles**: it sets `requiredSubagents` to exactly the listed role(s), clears `required_subagent_any_of` (the any-of groups), and emits a contract-specific context message. This resolves the conflict where a tiny bugfix task was forced to also dispatch `@t`/`@cr`/one-of-`@e|@a` by category classification even though the runner only asks for one specialist.

The marker does **not** override `docs_required`; that flag still follows category classification. A bugfix task that changes behavior still needs `docs_required: false` set explicitly if it should not be gated on a docs update.

When a task declares a `dispatch_contract`, `buildPrompt` also appends a **"Dispatch contract discipline"** note to the root prompt: the first substantive action must be launching the required specialist via the Agent tool (a real `SubagentStart`); the root agent must not `Edit`/`Write`/`MultiEdit` any file before that specialist starts; and the specialist owns the substantive work while the root coordinates, verifies, and reports. For **`observed`** and **`standard`** modes this is **advisory prompt discipline only** — the hard gate is the `observed`-mode evidence check, which fails the task when a required role has no real `SubagentStart`. For **`enforced`** mode the discipline is **backed by a harness `PreToolUse` guard** (Stage 5, wired): the plugin stashes `dispatch_contract_mode` to session state at `UserPromptSubmit`, and the `PreToolUse` `EditWrite` handler denies root edits until the required role has started, so the model is forced to dispatch before it can touch code.

Three smoke tasks now declare dispatch contracts (all `root_only: true`):

- `bench/tasks/subagents/smoke/subagent-bugbuster-zero-division-lite.json` — `mode: observed`, `required_agents: ["bug"]`.
- `bench/tasks/subagents/smoke/subagent-tester-regression-lite.json` — `mode: observed`, `required_agents: ["t"]`.
- `bench/tasks/subagents/smoke/subagent-architect-refactor-lite.json` — `mode: enforced`, `required_agents: ["a"]`. This is the Stage 5 canary: the `PreToolUse` guard forces a real `@a` dispatch before any code edit.

## CI Gate-Line Split (functional / dispatch-observed / dispatch-enforced)

The smoke benchmark gate used to be one monolithic pass/fail: `passed === tasks && tool_failures === 0 && unresolved_tasks === 0`. Under that rule a model that did the fix inline with passing `node --test` but never dispatched (the `glm-5.2:cloud` under-delegation case) failed the whole CI on `required_used_agents_missing`, hiding real functional progress behind the dispatch signal. Stage 6 of the dispatch-stabilization plan splits the gate into three explicitly named lines so functional progress stays visible (and mergeable) while the dispatch capability signal stays honestly visible.

The three lines:

- **`functional`** — fix + verification + review/docs + structural execution coverage (`configured_tasks > 0`, `executed_tasks === configured_tasks`, `tasks === executed_tasks`, `policy_violations === 0`, and every task has no functional failures). This is the **MERGE-BLOCKING** check: `assert-benchmark-summary.mjs` exits non-zero only on this line.
- **`dispatch-observed`** — whether the model itself called the Agent tool (a real `SubagentStart`, the hook source from the [Agent-Dispatch Evidence Split](#agent-dispatch-evidence-split)) on `observed`-mode tasks. This is a **VISIBLE, NON-BLOCKING** capability signal. It is never masked or "repaired" through final text; a red `dispatch-observed` line is an honest model-capability signal, not a CI failure.
- **`dispatch-enforced`** — whether the model dispatched after the hard `PreToolUse` guard on `enforced`-mode tasks (the architect-refactor canary). This is a **VISIBLE, NON-BLOCKING** capability signal: a red `dispatch-enforced` line means the guard fired but the model still did not dispatch, reported honestly rather than masked.

### How it is computed

A task's `failures` list mixes functional failures with dispatch failures. The dispatch failure codes are `required_used_agents_missing` and `required_used_agent_groups_missing` (the set `DISPATCH_LINE_FAILURES` in `scripts/bench/lib.mjs`). The split:

- For `observed`/`enforced`-mode tasks, the dispatch failure codes are **excluded** from the functional line and **counted on their own dispatch line**. A dispatch-failed task still has `status: 'failed'` and depresses the legacy `passed`/`tool_failures`/`unresolved_tasks` totals, which is exactly why the functional line no longer reads those totals — it re-derives pass/fail per task from `taskFunctionalFailures(task)`.
- For `standard`-mode tasks, dispatch is union-credited (a prose claim satisfies it — see [Dispatch Contract Marker](#dispatch-contract-marker)), so a dispatch failure there means the model did not even claim the role. That is a real functional gap, so the dispatch failure **stays in the functional line** for `standard` tasks.

Shared logic in `scripts/bench/lib.mjs`:

- `taskFunctionalFailures(task)` — failures for the functional line (dispatch codes excluded for `observed`/`enforced`, kept for `standard`).
- `taskDispatchLineFailures(task, mode)` — failures for the named dispatch line; empty for tasks not in that mode.
- `dispatchLineReport(summary, mode)` — `{ status: 'passed' | 'failed' | 'no-${mode}-tasks', total, passed, failed, failedTaskIds }`.

Merge-blocking authority in `scripts/assert-benchmark-summary.mjs`:

- `summaryFunctionalPassesGate(summary, opts)` — the functional gate the CLI actually enforces.
- `renderGateLines(functionalOk, observed, enforced)` — the three plain-text lines printed to CI step output.

Rendering in `scripts/render-benchmark-summary.mjs`: a `### Gate lines` markdown block is rendered into `benchmark-report.md` and the GitHub step summary, mirroring the assert step's three named lines with a note that dispatch lines are non-blocking capability signals.

### Where it shows up in CI

In `.github/workflows/behavior-benchmark-subagents-smoke.yml`:

- **`Enforce subagent smoke functional gate`** (blocking) — runs `node scripts/assert-benchmark-summary.mjs bench-output/summary.json`, which prints all three gate lines and exits non-zero only when the functional line fails.
- **`Report dispatch-observed capability signal`** (`if: always()`) — renders the `### Gate lines` block into the job summary so the honest dispatch signal stays visible whether or not functional passed. The `if: always()` ensures the capability signal is published even on a red functional gate.

### Backward-compat caveat

The old strict `summaryPassesGate(summary, opts)` (`passed === tasks`, `tool_failures === 0`, `unresolved_tasks === 0`, plus optional recovery/repair caps) is still exported from `scripts/assert-benchmark-summary.mjs` for callers that want the strict all-checks option, but the CLI no longer uses it — `main()` calls `summaryFunctionalPassesGate` instead. If you import `summaryPassesGate` directly, note that it is still polluted by dispatch-line failures on `observed`/`enforced` tasks and will fail a run that the functional gate passes.

## Agent-Backed Skill Taxonomy

The `/bug` skill is now **agent-backed**: like `/test`, `/design`, `/docs`, `/refactor`, and `/review`, it declares `agent: Bugbuster`, `context: fork`, `disable-model-invocation: true`, and a scoped `allowed-tools`/`paths` set, so invoking it dispatches the Bugbuster in an isolated forked subagent rather than running inline. The agent-backed skill set is therefore `bug, design, docs, refactor, review, test`; the command skills (minimal name+description entry points, no agent dispatch) are `debug, explore, manager`. This matters for benchmark dispatch contracts because the `bug` alias now resolves to a real `SubagentStart` against the Bugbuster, the same way `test` resolves to the Tester.

## Hook Test Layers

Hook behavior is covered by a single Node runner, `node scripts/test-hooks.mjs`
(exposed as `make hooks`), which loads `test/hooks/cases.json` and
`test/hooks/scenarios.json` verbatim and feeds each fixture through the Node
hook dispatcher:

- **Cases** check isolated hook contracts one event at a time — edge payloads,
  null/empty field handling, and single-hook `stdout_jq` / `state_jq` assertions.
- **Scenarios** chain multiple hooks through a single shared session `HOME` and
  temp dir for end-to-end flows such as prompt classification -> edit tracking ->
  verification -> completion, plus session lifecycle logging and `file_assertions`.

A small set of intentional bash→Node deltas (the legacy `CLAUDE_ENV_FILE` export
step, which the Node runtime drops because state is the source of truth) are
documented in `test/hooks/DELTA.md` and skipped via `test/hooks/deltas.json`.

## GitHub Workflow

The behavioral benchmark workflow is:

- `.github/workflows/behavior-benchmark-subagents-smoke.yml`

This workflow:

1. installs the Claude Code CLI
2. verifies the `plugins/agent-hive` plugin directory is present (the behavioral suite runs against the shipped plugin, not the legacy `install.sh` profile)
3. loads the plugin via `--plugin-dir plugins/agent-hive` on every `claude` invocation (see `scripts/bench_runner_claude_code.mjs`), so CI exercises the actual Node hook runtime + agents/skills that ship with the plugin; `BENCH_CLAUDE_PROFILE_DIR` points at a nonexistent path so no `~/.claude` profile is copied into the fixture workdir (plugin-only behavior, no legacy shell hooks leaking in)
4. collects the PR diff and maps it to affected agents, fixtures, task files, and shared workflow logic
5. selects the impacted tasks from `bench/tasks/subagents/smoke/*.json`, which contains focused canary tasks for each canonical specialist role plus a few workflow-shape tasks
6. runs `node scripts/run-benchmark.mjs` in `command` mode with the selected task list
7. uses `scripts/bench_runner_claude_code.mjs` as the per-task runner
8. uploads per-task Claude artifacts plus `summary.json`
9. fails the workflow unless every selected benchmark task passes

It only runs on PRs when benchmark-relevant files changed, which keeps the benchmark from re-running on unrelated pushes.
Agent and slash-skill changes are mapped through the frontmatter declared in `plugins/agent-hive/agents/*.md` and `plugins/agent-hive/skills/*/SKILL.md`, so full-name files like `manager.md` and skill directories like `review/` stay aligned with the canonical role aliases used by the task metadata.

## Slot-Gate Mechanism

Concurrent benchmark runs are limited by a two-slot gate enforced through `scripts/wait-for-benchmark-slot.mjs`. This prevents multiple workflow dispatches from overloading shared CI runners.

**How it works:**

- `wait-for-benchmark-slot.mjs` polls a dedicated GitHub API endpoint (or a comparable availability check) until a slot opens, or exits immediately if one is already free.
- The gate allows a maximum of **2 concurrent benchmark runs** at any time.
- When the gate is occupied, the script waits and retries at a fixed interval until a slot becomes available.

**Rate-limit handling:**

- If the slot check returns HTTP 403, the script reads the `Retry-After` header and sleeps for the requested interval before retrying.
- This handles GitHub API secondary-rate-limit errors gracefully without burning CI minutes on tight polling loops.

**Log rotation for hook telemetry:**

Hooks write session events to `~/.claude/logs/*.jsonl` (notifications, compact
markers, config changes, session index). To prevent unbounded log growth on
long-running CI runners, `appendJsonl` in `plugins/agent-hive/modules/notifications.mjs` rotates
every stream past `CLAUDE_CREW_LOG_MAX_BYTES` (default 1 MB): the file is moved
to a `.old` sidecar and a fresh log is started.

**Node.js 24 requirement:**

All benchmark workflows set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` to opt into Node.js 24 ahead of the September 2026 runner deprecation of Node.js 20. If you run benchmarks locally or on a self-hosted runner, ensure it uses Node.js 24 or later.

## Required GitHub Setup

Repository settings:

1. `Settings -> Secrets and variables -> Actions -> New repository secret`
2. Add `OLLAMA_API_KEY`
3. `Settings -> Secrets and variables -> Actions -> Variables`
4. Add `OLLAMA_MODEL` as the general fallback provider model
5. Optionally add `BEHAVIOR_BENCHMARK_MODEL` to pin a separate model for benchmark CI without changing the wider repository default
6. Optionally add `BEHAVIOR_BENCHMARK_TIMEOUT_SECONDS` to override the benchmark per-task timeout
7. Optionally add `BEHAVIOR_BENCHMARK_MAX_OUTPUT_TOKENS` to override the Claude Code output-token cap
8. Optionally add `BEHAVIOR_BENCHMARK_MAX_RECOVERED_TASKS` to enable strict gating on recovered tasks
9. Optionally add `BEHAVIOR_BENCHMARK_MAX_SUMMARY_REPAIRED_TASKS` to enable strict gating on summary-repaired tasks

Required benchmark model: set `OLLAMA_MODEL` (or `BEHAVIOR_BENCHMARK_MODEL` in CI) to whichever model id the runner should use — the profile pins none.

```text
# example only — use any model id your runner targets
export OLLAMA_MODEL="your-model-id"
```

Recommended benchmark timeout:

```text
400
```

Recommended benchmark max output tokens:

```text
768
```

Strict mode is opt-in. Leave the recovery-cap variables unset if you want recovered tasks to remain informational only.

## Local Usage

With Claude Code CLI and Ollama Cloud env vars available:

```bash
export OLLAMA_API_KEY=...
export ANTHROPIC_BASE_URL=https://ollama.com
export ANTHROPIC_AUTH_TOKEN="$OLLAMA_API_KEY"
export ANTHROPIC_API_KEY=
export OLLAMA_MODEL="${OLLAMA_MODEL:-your-model-id}"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-768}"
export BENCH_RUNNER_CMD="node scripts/bench_runner_claude_code.mjs"
node scripts/run-benchmark.mjs --output-dir /tmp/claude-bench --mode command
node scripts/assert-benchmark-summary.mjs /tmp/claude-bench/summary.json
```

To run the subagent smoke suite manually:

```bash
node scripts/run-benchmark.mjs --output-dir /tmp/claude-bench-subagents-smoke --mode command --task-glob 'bench/tasks/subagents/smoke/*.json'
```

For cheap synthetic checks without the real agent:

```bash
node scripts/run-benchmark.mjs --output-dir /tmp/claude-bench-mock --mode mock
```

## Local precheck

The **Behavior Benchmark Subagents Smoke Precheck** CI job (the `precheck` job
in `.github/workflows/behavior-benchmark-subagents-smoke.yml`) selects which
subagent smoke tasks to run before spending model credits. `scripts/bench-precheck.mjs`
reproduces that job locally — it is a thin orchestrator that drives the exact
same Node CLIs the CI uses (`collect-benchmark-changes`, `select-benchmark-tasks`,
`build-benchmark-matrix`, and, for resume modes, `find-failed-benchmark-run` /
`download-benchmark-summary`), so local and CI selection stay byte-identical. No
selection logic is duplicated. It is deterministic and needs **no model or
token** — it only reads the git diff and the task files.

```bash
# Default: mirrors a pull_request against main — collects changed files,
# selects the subagent smoke tasks those changes touch, validates task/fixture
# alignment, builds the 3-shard matrix, and prints a ready-to-run command:
make bench-precheck

# Run the whole suite regardless of what changed (skip the validator step):
make bench-precheck BENCH_PRECHECK_FLAGS='--selection-mode all --no-validators'

# Or invoke directly:
node scripts/bench-precheck.mjs
```

The precheck writes scratch files under `BENCH_OUTPUT_DIR` (default
`/tmp/claude-bench`, cleaned by `make clean`): `.bench-changed-files.txt`,
`.bench-selected-tasks.txt`, and per-shard `.bench-selected-tasks.shardN.txt`.
It then prints the local equivalent of the CI matrix job — one `make bench-smoke`
command per shard (or a single combined run):

```
make bench-smoke BENCH_TASK_LIST='/tmp/claude-bench/.bench-selected-tasks.shard1.txt'
```

Copy that command and run it with your Ollama / Claude Code env vars exported
(see *Local Usage* above) to execute the selected canaries against a real model.
`--selection-mode=resume`/`auto-resume` additionally resolve a prior failed run
via `gh` and need a `GITHUB_TOKEN` plus network, exactly as in CI; `auto-resume`
falls back to `changed` when no failed run is found in the last 72 hours. Run
`node scripts/bench-precheck.mjs --help` for the full flag set.

## Re-running only failed tasks

A full smoke rerun re-executes every canary task and spends Ollama credits on
the ones that already passed. To re-run only the tasks that did not resolve in
a prior failed run, use the smoke workflow's `resume` / `auto_resume` selection
modes — the selector (`scripts/select-benchmark-tasks.mjs`) loads the previous
run's summary and selects only its `unresolved_task_ids`.

From your workstation (requires `gh` with workflow permissions):

```bash
# Re-run the unresolved tasks from the last failed smoke run (<=72h):
make bench-rerun-failed

# ...or resume a specific prior run by id:
make bench-rerun-failed RUN_ID=27872932481

# Equivalent direct invocation:
node scripts/rerun-failed-benchmark.mjs                 # auto_resume
node scripts/rerun-failed-benchmark.mjs --run-id 27872932481
node scripts/rerun-failed-benchmark.mjs --ref main       # target a branch
```

The wrapper dispatches the workflow with `selection_mode=auto_resume` (or
`resume` with `--run-id`), then prints the new run's URL and a `gh run watch`
command. `auto_resume` uses `scripts/find-failed-benchmark-run.mjs` to locate the
last failed run automatically; if none exists in the last 72 hours it falls back
to `changed` mode.

For a local (non-CI) re-run of only the failed tasks, select the unresolved
tasks from a previous summary, then feed that list to the runner:

```bash
# 1. Select only the unresolved tasks from a previous local summary:
node scripts/select-benchmark-tasks.mjs --suite subagents_smoke \
    --selection-mode resume \
    --previous-summary-file /tmp/claude-bench/summary.json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).task_files.join("\n")+"\n"))' \
  > /tmp/claude-bench-failed.txt

# 2. Re-run only those tasks:
node scripts/run-benchmark.mjs --output-dir /tmp/claude-bench-resume \
    --mode command --task-list-file /tmp/claude-bench-failed.txt
```

(`run-benchmark.mjs` itself does not take `--selection-mode`; the selection is
done by `select-benchmark-tasks.mjs`, which emits a task list consumed via
`--task-list-file`.)

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
- `benchmark-report.md`

Use `summary.json` as the machine-readable gate and `benchmark-report.md` as the human-readable markdown report with overview and per-task status tables. The per-task artifacts remain the debugging source for failures.
The workflow log now prints task metadata, model, workdir, prompt excerpt, raw Claude JSON excerpt, parsed failure reasons, debug log excerpt, verification output, patch excerpt, full `result.json` for each task, and the rendered markdown report table.

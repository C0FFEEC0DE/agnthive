# Changelog

All notable changes to this plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This plugin-level changelog records the migration from the copied-`~/.claude`
profile (the `claudecfg/` layout installed via `./install.sh`) to a distributable
Node.js ESM plugin runtime. The repository-root `CHANGELOG.md` covers the older
profile history; entries here begin with the plugin.

## [Unreleased]

Work in progress after 0.4.0 (2026-10-19). **Nothing in this section has
shipped**: the items below are in the working tree or still in progress, and
no release has been cut from them. The `lean` profile is still
**experimental** and `legacy` is still the default — the ADR 0012 outcome
gate has not been exercised to completion (no full live matrix run exists),
so the default flip did not happen.

### Added

- **Benchmark arm × repetition execution loops (ADR 0012) — landed in the
  working tree.** The outcome suite declares the arms `native` (no plugin),
  `legacy` and `lean` and a floor of `MIN_LIVE_REPS` (3) paired repetitions
  per task, and the ADR 0012 rollout gate consumes exactly those
  per-(arm, task, rep) records. `scripts/run-benchmark.mjs` now executes that
  matrix: `--arms native|legacy|lean`, `--reps N` and
  `--arm-profile legacy|lean`; every (task, arm, rep) cell runs in a fresh
  work area; the runner child receives `BENCH_ARM` and `BENCH_REP`, plus
  `BENCH_DISABLE_PLUGIN=1` for the no-plugin `native` baseline and
  `AGNTHIVE_WORKFLOW_PROFILE` for the plugin arms; a matrix run writes one
  summary per arm (`<output-dir>/arms/<arm>/summary.json`) for the suite
  emitter, which takes one arm per run directory. The matrix is opt-in: a run
  without `--arms` still executes each task once, so the existing CI
  invocation and its model spend are unchanged. Verified live on CLI 2.1.303:
  the `native` arm registers 0 plugin hooks and finds no plugin state (a
  genuine no-plugin baseline), the `legacy` arm reads `evidence_source:
  plugin_state` from the host's inline data root, and the suite emitter
  reports `reps=1` with `outcome_pass_rate=1.000`. The gate still reports
  `available: false` — a full matrix run (all three arms, three repetitions
  each, live) has not been executed, so the lean default flip stays blocked.
  Covered by `test/bench/run-benchmark-arms.test.mjs`.

### Fixed

- **Plugin enablement and plugin data root in the benchmark runner — in the
  working tree, not yet released.** Measured on CLI 2.1.303: with the plugin
  loaded via `--plugin-dir` and `defaultEnabled: false`, the host registered
  **0 hooks** (`Registered 0 hooks from 3 plugins`), so the plugin's own hooks
  never ran in benchmark sessions and every evidence layer silently degraded;
  the same session registers 23 hooks once the plugin is enabled. The runner
  now writes a temporary `--settings` file whose `enabledPlugins` map enables
  the inline plugin id (derived from the plugin name with the host's
  `@inline` sentinel — `agnthive@inline` — overridable with
  `BENCH_PLUGIN_ID`) and removes the file afterwards, and it probes the host's
  actual inline data root (`~/.claude/plugins/data/agnthive-inline`, plus a
  cache-dir variant) next to the roots it already searched, so the plugin's
  session state is found and read through the shared state reader.
  `BENCH_DISABLE_PLUGIN=1` runs the child without the plugin (no
  `--plugin-dir`, no `--settings`) for the `native` baseline arm. Covered by
  `test/bench/bench_runner_plugin_enablement.test.mjs` and
  `test/bench/bench_runner_plugin_evidence.test.mjs`.

- **Benchmark task id used as a directory name — in the working tree, not yet
  released.** A task id comes from a task file and becomes a directory name
  under the run output, and two hazards followed, both silent. An id carrying
  path separators (for example `../../elsewhere`) made the artifacts land
  OUTSIDE the run directory, so a task could write into an arbitrary
  location. An id longer than the 255-byte filename limit made `mkdir`/`unlink`
  throw `ENAMETOOLONG` and abort the WHOLE run — including the tasks that were
  fine — although the orchestrator promises that a task which cannot run is
  reported as failed, never as a crash. `scripts/run-benchmark.mjs` now derives
  the directory name from the id instead of using it verbatim: a safe id keeps
  its historical path (the CI artifact layout does not move), and an unsafe id
  becomes a readable slug plus a digest of the original id, which keeps the
  mapping deterministic and collision-free. The REPORTED id is never rewritten
  — `summary.json` and `result.json` still name the task that actually ran.
  Covered by `test/bench/run-benchmark-arms.test.mjs`.

- **Benchmark runner ignored the task's declared budget class — in the working
  tree, not yet released.** The outcome suite writes every task with a
  `budget_class` and the suite schema maps that class to the turn and
  wall-clock budget the task was designed for (`small` 12 turns / 240s,
  `medium` 24 turns / 400s, `large` 40 turns / 800s), but the runner applied
  one flat limit (16 turns / 300s) to every task. A flat limit measures the
  HARNESS, not the task: in the first full live matrix run a `medium` task was
  killed at 300s and recorded as a task failure the model never committed, and
  another cell was cut at the flat 16 turns although its declared budget was
  24. `scripts/bench_runner_claude_code.mjs` now reads the budget class from
  the task file and applies that task's own limits; an explicit `MAX_TURNS` /
  `CLAUDE_TIMEOUT_SECONDS` in the environment still wins, so a manual or CI run
  can pin its own. The cell's effective budget (`budget_class`, `max_turns`,
  `timeout_seconds`, `budget_source`) is recorded in `result.json`, so a
  measurement can be read back with the budget it ran under. Covered by
  `test/bench/bench_runner_claude_code.test.mjs`.

- **The ADR-0012 rollout gate measured the wrong thing — in the working tree, not
  yet released.** The gate is the only thing that authorizes the lean default
  flip, and the first full live matrix run showed it reporting deltas the
  suite's own contract does not define. Two defects, both invisible to the
  existing (symmetric) fixtures: (1) `new_false_completions` and
  `permission_denials_delta` were ARM TOTALS, so a task only one arm runs — the
  `native` control skips the plugin-only lifecycle tasks — was counted as a
  quality difference: the first matrix read `+5 new false completions` for lean
  against native when, on the 21 cells both arms actually ran, lean had ONE
  FEWER; every gate delta is now measured on the PAIRED cells, the (task, rep)
  both arms executed, which is what ADR-0012 asks for. (2)
  `lost_material_findings` subtracted in the wrong direction, so findings the
  BASELINE missed were reported as findings LEAN lost (the first matrix read
  `3 lost` against native, whose own run had found fewer findings); it now
  follows the documented rule — the worst paired-rep drop of
  baseline-matched minus lean-matched material findings, floored at 0, summed
  per task. The per-arm `false_completions` metric is unchanged: it is an
  arm-level number, not a comparison. A baseline that shares no cell with lean
  now makes the gate report `available: false` instead of a vacuous "no
  regression". The metrics document version is bumped to `1.1` — the gate
  semantics changed. Covered by `test/validators/outcome-suite.test.mjs`.

- **A read-only outcome task was graded as a failure — in the working tree, not
  yet released.** The runner's task-level heuristic is "a task that changed
  nothing did not complete", which is wrong for a task that must NOT change
  anything: `outcome-review-flawed-ingest` allows no path (its scope
  predicate has an empty allow list) and its success criteria say "no file is
  modified (read-only review)", so the read-only run — which named all three
  material findings and touched nothing — was recorded as a failed cell in
  every arm of the first live matrix (9 of 9 cells). The runner already
  honours a task's `expect_changes` flag; the SUITE now declares it: a
  read-only task must set `expect_changes: false`, and the suite schema
  rejects a read-only task that does not. Covered by
  `test/validators/outcome-suite.test.mjs`.

### Pending verification

- **The plugin's verification evidence layer never sees `node --test` — found
  by the ADR-0012 outcome matrix, not yet fixed.** `commandClass` in
  `modules/verification.mjs` recognizes `npm test`, `pytest`, `cargo test`,
  `go test`, `make test` — but not `node --test`, so a Node test run is
  classified `other` and `resultFromBashPayload` returns null: no
  `verification[]` record is appended and no verification flag is synced. The
  outcome suite declares `node --test` as the verification command of its
  tasks, and the live matrix confirmed the consequence: the plugin's session
  state carried `verification: []` after a run whose tests passed, and the
  `verification.latest.status == passed` predicate failed in EVERY plugin arm
  (the same cells, so the arm comparison is unaffected). A second, independent
  cause sits behind the same predicate: a BACKGROUND launch is recorded as
  `pending` by design (ADR-0013: a launch is not a completion), never as
  `passed`. Not fixed here on purpose — teaching the plugin to recognize a
  command changes the verification gate's runtime behavior for every user, so
  it needs its own change with its own risk assessment, and the ADR-0012 gate
  does not require it.

- **Two outcome-suite tasks are red in every arm for suite reasons, not model
  reasons.** `outcome-compact-resume` expects a mid-task compaction
  (`scenario: compact_resume`, predicate `restored_task_seq >= 1`) and
  `outcome-background-verification` expects a background verification to be
  recorded as passed; the live runner drives a single-shot `claude -p` session
  and never produces a compaction event, so these predicates cannot be
  satisfied by any arm. The grading was left intact on purpose (the ADR
  forbids weakening it to move a number) — the consequence is that the ABSOLUTE
  outcome pass rate of the matrix understates both arms, while the arm
  comparison the gate actually uses (paired cells) is unaffected.

- **Live host canary captures — in progress.** Real hook stdin payloads are
  being captured on the pinned CLI (2.1.303) to replace the
  `pending_capture` entries in `test/compatibility/manifest.json`. No entry
  has been flipped to `captured` yet, so the compatibility rows stay
  `implemented` / `unverified` and no host behavior may be asserted from
  them (see `docs/compatibility.md`).

## [0.4.0] - 2026-10-19

Feature set from the 2026-10-19 harness modernization plan (ADR 0008–0013).
Lean is shipped **experimental** with `legacy` still the default profile; the
default flips only after the ADR 0012 outcome benchmark passes its rollout
gate (no live outcome-benchmark run was executed in this release cycle, so
the gate has not been exercised — see plan task 14; a bounded exploration
with a local model is possible but was not run). Compatibility-agent
removal (plan task 16) is deferred to the dedicated compatibility window.

### Added

- **Verification evidence model (ADR 0009, plan task 04).** Verification is
  append-only state: `verification[]` records (`{id, kind, command, toolUseId,
  status pending|passed|failed|unknown, startedRevision, completedRevision,
  cwd, exitStatus, signal, source}`) plus `revision` / `fs_revision_hint`.
  A launched run is pending, an unknown outcome is never passed, and a later
  code/config edit invalidates earlier verification. Completed reviews land in
  `review_results[]`; the docs decision field is reserved (writer lands with
  the docs-flow task).
- **Task + agent lifecycle identity (ADR 0010, plan tasks 05–06).** Task
  identity is separate from prompt identity (`task_id`, `active_task`,
  explicit start/continue/complete transitions); a re-delivered `prompt_id`
  is deduped instead of resetting state; siblings keep their counters outside
  task boundaries. Agents are tracked in an `agents{}` registry keyed by
  stable agent id (`starts` counts events, not instances); forks and
  foreign-namespace types never inherit the footer contract.
- **Failure policy classes (ADR 0011, plan task 08).** Events are classed
  `enforce` / `guidance` / `telemetry`; a failed enforce handler blocks with a
  diagnostic, advisory stays neutral (no blanket allow), telemetry failures
  are nonblocking. Every hook registration declares a `timeout` (`10s` sync /
  `30s` async) and the shared PreToolUse shell-policy registration carries
  `onFailure: "block"`.
- **PowerShell parity (plan task 03).** `hooks.json` registers a native
  `PowerShell` matcher for the PreToolUse safety policy and PostToolUse
  verification routing; `PermissionDenied` now emits the event-specific
  `hookSpecificOutput: { hookEventName: "PermissionDenied", retry }` envelope
  instead of the legacy bare `{ retry }` shorthand.
- **StopFailure telemetry + bounded compact logging (ADR 0013, plan task 07).**
  Ledger restoration moved to `SessionStart` `compact`/`resume` (bounded
  task/revision summary + ledger path, once per restoration cycle); PostCompact
  records are metadata-only by default with the
  `AGNTHIVE_VERBOSE_COMPACT_LOG=1` opt-in for bounded summary text; the
  `Notification` stream records `notification_type` (bridging the legacy
  `subtype` alias) plus `agent_id`/`prompt_id` correlation ids; `StopFailure`
  writes bounded `stop-failure.jsonl` records — API error text is never logged.
- **`workflow_profile` selector (plan task 11, experimental).**
  `userConfig.workflow_profile` (`legacy` default) / `AGNTHIVE_WORKFLOW_PROFILE`
  selects the gate shape: lean drops role quotas, the Manager-idle gate, and
  footer blocking while keeping the current-verification and review gates; a
  non-empty invalid value falls back to `legacy` with a stderr note. Legacy
  behavior is byte-stable.
- **Benchmark evidence from plugin state (ADR 0009/0010/0012, plan task 09).**
  `scripts/bench_runner_claude_code.mjs` reads the plugin's per-session event
  store through the shared runtime reader (provenance recorded, strict session
  match); plugin-state registry roles are the authoritative observed tier,
  debug-log phrases are demoted to claimed, and revision-scoped
  `verification[]`/`review_results[]` records back the verification/review
  gates (`verification_evidence_missing` / `review_evidence_missing`).
- **Outcome benchmark suite (ADR 0012, plan task 10).** `bench/tasks/outcomes/`
  (schema + emitter + 9 end-state tasks + pinned seeds): outcome scoring
  without mandatory roles, mock-first evaluation, per-arm metrics, and
  `gate_inputs` for the lean-default rollout decision. See
  `docs/benchmarking.md` → *Outcome Suite (ADR-0012)*.
- **Runtime contract fixtures (plan task 02).** `test/compatibility/` pins
  event-specific output classes (4 active entries, 12 `pending_capture`
  awaiting live canaries; synthetic payloads never claim `captured`).

### Changed

- **Role simplification (ADR 0008, plan task 12).** Three primary specialists
  (`@e`, `@dbg`, `@cr`); `/manager`, `/explore`, `/bug`, `/debug`, `/test`,
  `/design`, `/refactor`, `/docs` are root procedures; `/review` stays the only
  forked specialist skill. Manager/Architect/Tester/Docwriter/Bugbuster remain
  as deprecated compatibility agents for explicit legacy workflows.
- **Validators (plan task 13).** `scripts/validate.mjs` enforces the hooks
  event vocabulary with `StopFailure`, `timeout`/`onFailure` policy, PowerShell
  matcher parity, the `userConfig` contract including `workflow_profile`
  (`legacy|lean`), and the agent-backed skill inventory (`['review']`);
  negative fixtures assert the drift cases.
- **Bench runner plumbing.** Per-(task, rep) records carry `rep`, token usage,
  cost (only when the provider reports it), and outcome predicate results;
  `evidence.json` and `evidence_provenance` artifacts land per run.

### Deferred

- **Compatibility debt removal (plan task 16)** — after the compatibility
  window.
- **Lean default flip** — requires the ADR 0012 outcome-benchmark gate; no
  live outcome run exists yet (task 14), so no cost or quality claim is made.

## [0.3.0] - 2026-08-17

### Added

- **Per-agent loop-block isolation (ADR-0002).** The `subagent_stop` loop-block
  counter is keyed by `agent_id` in a `subagent_stop_blocks` map instead of a
  session-global scalar, so three *different* subagents returning identical
  invalid output can no longer accumulate to a 3-strike hard stop. Persistence
  flows through per-key `map_set`/`map_delete` events (concurrent writers for
  different agents survive each other) plus a `map_clear` event for the turn
  reset — every `subagent_stop_blocks` mutation is now a typed `map_*` event.

- **Honor `stop_hook_active` (ADR-0003).** The Stop hook now yields on a
  `stop_hook_active` re-invocation instead of re-blocking up to 3×, matching the
  standard Claude Code loop-prevention contract. The yield is gated on evidence
  of a prior block (`hasPriorStopBlock`), so a runtime that erroneously sets the
  flag on a first Stop cannot silently disable enforcement. The 3× counter
  remains as a backstop for runtimes that omit the flag.

- **Namespace stripping in agent-label canonicalization (ADR-0004).** A
  namespaced specialist type such as `agnthive:Code Reviewer` is now recognized,
  so footer enforcement applies instead of passing through as a foreign type.

- **Explicit per-key entry + centralized loop key (ADR-0005/0006).**
  `recordLoopBlock` carries the changed per-key entry explicitly
  (`{ mapKey, key, entry }`); `agentLoopKey` centralizes the
  `agentId || '_session'` fallback as the single source of truth for every
  per-agent loop-block site.

- **Architecture decision records (ADR-0001..0007)** documenting the
  subagent-footer scope, per-agent loop-block counter, `stop_hook_active`
  honoring, namespace stripping, explicit per-key entry, centralized loop key,
  and namespace-prefix identity.

### Changed

- **`/simplify` cleanups.** `hasPriorStopBlock` predicate encapsulates the
  prior-block policy check; `isAliasesLoaded` is the single source of truth for
  the alias-map loaded-ness predicate shared by the dispatcher and
  `shouldEnforceSubagentFooter`; `validateMapField` shares the map-field guard
  across the whole `map_*` event family; a redundant defensive spread in
  `emitLoopAwareBlock` was dropped; `handleUserPromptSubmit` resolves session
  paths once per turn; and `handleSubagentStop` short-circuits generic dispatch
  types before the label-extraction walk.

- **`make precommit`** — one-command local pre-push gate that chains the full
  repository self-check (`make validate`, which includes the tier-1
  `plugin-install-smoke` strict gate) plus `make lint`, `make test`, and
  `make hooks`. No model, network, or API keys required — the same no-spend
  gates CI runs. `make bench-precheck` (also no-spend) and `make bench-mock`
  remain separate optional add-ons.

## [0.2.0] - 2026-07-22

### Added

- **Forced SDLC output style.** `output-styles/agnthive.md` carries
  `force-for-plugin: agnthive`, so enabling the plugin automatically applies the
  hook-gated SDLC style (phase order, specialist roles, stop-safe footers) to the
  main conversation without the user selecting an output style. The style
  teaches the contract upstream; the hooks still verify it. It modifies the main
  session prompt only — subagents keep their own agent prompts.
- **Subagent status line, on by default.** `scripts/subagent-statusline.mjs`
  (Node stdlib only) is wired via `settings.json` `subagentStatusLine` and
  renders one alias/role · status · effort · tokens · context-% row per running
  subagent. Degrades gracefully on empty or partial input; no configuration
  needed.
- **Two new `userConfig` knobs + a three-tier env bridge.** `log_max_bytes` and
  `ledger_max_bytes` join `enforcement_mode` as `userConfig` keys. Each runtime
  resolver now reads `AGNTHIVE_*` (explicit) > `CLAUDE_CREW_*` (legacy alias) >
  `CLAUDE_PLUGIN_OPTION_*` (the `userConfig` bridge, lowest priority), so a
  `userConfig` value always applies unless an explicit env var overrides it.
- **Per-agent tool allowlists and reasoning effort.** Every agent frontmatter
  now pins a `tools` allowlist (Explorer and Code Reviewer read-only; Manager
  keeps all tools except `Edit`/`Write`/`NotebookEdit`) and a `model` reasoning
  `effort` (low/medium/high). Model pinning is intentionally omitted to keep the
  plugin model-agnostic.
- **Slash-skill argument hints.** All nine slash skills carry an
  `argument-hint` so the command palette previews the expected argument.
- **Tier-1 strict packaged-plugin validation, always-on.**
  `scripts/plugin-install-smoke.mjs` now strictly checks the `userConfig` schema
  (allowed `type` values; `default` matches type), parse-checks
  `scripts/subagent-statusline.mjs`, and validates the plugin `settings.json`
  shape (only `agent`/`subagentStatusLine` allowed). Wired into
  `node scripts/validate.mjs` as a new `checkPluginInstallSmoke` step so it runs
  in CI on every push/PR.
- **Tier-2 official `claude plugin validate --strict` in CI.** The validate
  workflow adds a Linux-only, best-effort step that runs the official CLI's
  strict manifest validator against `plugins/agnthive`. The CLI install is
  `continue-on-error`; a genuine `--strict` failure fails the shard, but an
  install flake skips cleanly so required checks stay green.

### Changed

- **TaskCompleted / TeammateIdle can optionally emit a structured block
  decision.** These exit-2 blocks may additionally write a
  `{"decision":"block","reason":...}` JSON object to stdout (same reason as the
  stderr message) when `AGNTHIVE_BLOCK_STDOUT_JSON=1` is set, so hosts that
  prefer stdout JSON over the exit code can receive the block intent + reason.
  The flag is **off by default**: with it unset, stdout stays empty and behavior
  is byte-identical to the legacy exit-2 + stderr block, because
  `decision:"block"` is the "continue with feedback" contract and it is
  unverified whether a host honors stdout JSON over the exit code for these
  events (emitting it unconditionally could weaken a hard stop). The write now
  uses `process.exitCode` + return instead of `process.exit` so the stdout
  payload flushes naturally. Full exit-2 removal remains gated on verifying that
  host-runtime contract.
- **Install flow is now marketplace-first across every surface.** The repository
  is a self-hosted plugin marketplace, so the canonical install is
  `claude plugin marketplace add C0FFEEC0DE/agnthive` then
  `claude plugin install agnthive@agnthive`, with
  `claude plugin update agnthive@agnthive` pulling updates straight from the
  repo. The root `README.md`, `index.html` landing page, `CLAUDE.md` Quick Start,
  and this README now lead with the marketplace-add flow instead of the
  clone-and-`claude plugin install ./plugins/agnthive` source-install path
  (which remains as a local/dev alternative).
- **The plugin ships disabled by default.** `defaultEnabled: false` in
  `plugin.json` means `claude plugin install` no longer auto-activates the
  hook-gated profile; the install flow adds `claude plugin enable agnthive@agnthive`
  as the explicit opt-in step.

- **Install flow is now marketplace-first across every surface.** The repository
  is a self-hosted plugin marketplace, so the canonical install is
  `claude plugin marketplace add C0FFEEC0DE/agnthive` then
  `claude plugin install agnthive@agnthive`, with
  `claude plugin update agnthive@agnthive` pulling updates straight from the
  repo. The root `README.md`, `index.html` landing page, `CLAUDE.md` Quick Start,
  and this README now lead with the marketplace-add flow instead of the
  clone-and-`claude plugin install ./plugins/agnthive` source-install path
  (which remains as a local/dev alternative).

### Fixed

- **Corrected the marketplace identifier in every install/update command.** The
  plugin README previously used `agnthive@C0FFEEC0DE`, but `C0FFEEC0DE` is the
  GitHub owner handle, not the marketplace name, and Claude Code requires
  marketplace names to be kebab-case (uppercase is invalid). The marketplace
  `name` in `.claude-plugin/marketplace.json` is `agnthive`, so the correct
  address is `agnthive@agnthive` (`<plugin>@<marketplace>`). Updated install,
  update, disable, enable, uninstall, and `marketplace remove` commands
  accordingly, and corrected the explanatory text that misidentified the
  marketplace name as a "publisher identifier declared in plugin.json".

## [0.1.0-beta.1] - 2026-06-22

First beta of the distributable Claude Code plugin. The hook-gated
`discover → design → implement → verify → review → docs` workflow, the
specialist-role contracts, and the stop/handoff footer contract now run in a
Node 22+ runtime packaged as a plugin — no Bash, Python, `jq`, or GNU/coreutils
dependencies. The work follows the phased plan in
`docs/plans/2026-06-21-claude-code-plugin-node-production.md` and the frozen
contract in `docs/specs/claude-code-plugin-node-migration.md`.

### Added

- **Plugin manifest and distribution.** `.claude-plugin/plugin.json` declares the
  plugin name, displayName, version, author, MIT license, keywords, the
  `hooks/hooks.json` entry, and a single `userConfig` key (`enforcement_mode`).
  Distribution is source-repository-based (marketplace copy of the plugin dir,
  no install-time build, no npm install).
- **Node 22+ hook runtime** under `modules/`: a single `hook-dispatcher.mjs` entry
  point serves all 19 hook registrations via `--event`, backed by event modules
  (`state.mjs`, `workflow.mjs`, `command-policy.mjs`, `verification.mjs`,
  `summary-contract.mjs`, `agents.mjs`, `transcripts.mjs`, `notifications.mjs`,
  `ledger.mjs`, `hook-input.mjs`, `hook-output.mjs`, `util.mjs`). Node standard
  library only — no `child_process`, no shell, no `eval`.
- **Append-only session state.** `state.mjs` replaces lock-protected
  read-modify-write JSON with append-only event records (exclusive-creation
  `wx` writes) plus a pure reducer and disposable snapshots (temp-file + atomic
  rename), removing the non-atomic initial write, shared-state race, and
  stale-lock TOCTOU from the legacy profile. A migration version is stamped on
  every event and snapshot.
- **Platform-neutral command policy.** `command-policy.mjs` inspects
  `tool_input.command` before it runs and gates `PreToolUse`,
  `PermissionRequest`, and `PermissionDenied`. It covers POSIX, PowerShell, and
  CMD spellings of destructive recursive deletion, disk formatting, privilege
  escalation, force pushes / destructive reset, remote-script bootstrap pipes,
  and release/deploy automation. Two modes: `advisory` (default, fail-open on
  the unknown) and `enforce` (fail-closed on unparseable indirection). Contract
  frozen in `docs/specs/command-policy.md`; behavior pinned by the corpus at
  `test/security/command-policy.corpus.mjs`.
- **Stop and subagent footer contracts.** `summary-contract.mjs` ports the
  footer parsing, completion gates, and block checklists, preserving the
  terminal-cancellation semantics (only `continue: false` + `stopReason`, never
  combined with `decision: "block"`) and the policy-stall reset on a genuine
  `UserPromptSubmit`.
- **Telemetry with rotation.** `notifications.mjs` appends structured JSONL
  records under `${CLAUDE_PLUGIN_DATA}/logs` (`notification.jsonl`,
  `session-index.jsonl`, `pre-compact.jsonl`, `post-compact.jsonl`,
  `config-change.jsonl`, `instructions-loaded.jsonl`) built from a fixed field
  whitelist and serialized with `JSON.stringify`. Each stream rotates to
  `<name>.old` at `AGNTHIVE_LOG_MAX_BYTES` (1 MiB default). No credentials,
  full environment variables, or prompt/transcript contents are logged.
- **Progress ledger.** `ledger.mjs` re-injects compact context after
  compaction, capped at `AGNTHIVE_LEDGER_MAX_BYTES` (64 KiB default) with
  UTF-8-safe truncation.
- **Canonical agents and namespaced skills.** Eight agents under `agents/`
  with kebab-case canonical names; legacy persona aliases retained only in
  `assets/aliases.json` for transcript compatibility (no packaged symlinks).
  Skills under `skills/<name>/SKILL.md` with namespaced invocation
  (`/agnthive:review`). Workflow documents moved into `references/`
  as on-demand skill references.
- **Optional Node status line.** `scripts/statusline.mjs` reads one JSON object
  from stdin and prints `<cwd basename> | <model display name> | <output style>`.
  Node standard library only — no subprocess spawning, no shell, no reads of
  arbitrary user files. Opt in via the plugin's `statusLine` setting (not the
  global status line).
- **Plugin README.** Requirements, installation (marketplace and local/dev),
  configuration, optional status line, privacy & telemetry, uninstallation,
  legacy migration, troubleshooting, support & security reporting, and license.
- **Plugin-level LICENSE and SECURITY.md** shipped inside the plugin directory
  so marketplace installs receive them.
- **Supply-chain controls.** CodeQL (`.github/workflows/codeql.yml`),
  dependency review (`dependency-review.yml`), Dependabot
  (`.github/dependabot.yml`), and an SBOM generated with Syft and attached to
  the GitHub Release. Minimal GitHub token permissions in the release workflow
  (`contents: write` for release creation; `id-token: write` reserved for future
  signing).
- **Tag-cut release flow.** `.github/workflows/release.yml` fires only on a
  `v*` SemVer tag, builds one artifact via `git archive` from a clean checkout,
  tests the exact unpacked artifact (structural + `node --check` + optional
  install smoke), attaches `sbom.spdx.json`, and creates the GitHub Release
  with `--verify-tag`. Documented in `docs/release.md`.
- **Threat model.** `docs/threat-model.md` records the trust boundary, the
  seven threats and their mitigations, and the residual risks.
- **Stage 5 `dispatch_enforced` hard guard.** A benchmark task with
  `dispatch_contract.mode: "enforced"` now forces dispatch at the harness level:
  `UserPromptSubmit` stashes `dispatch_contract_mode` to session state from the
  `BENCHMARK_DISPATCH_CONTRACT` marker, and a new `PreToolUse` registration for
  `Edit|MultiEdit|Write|NotebookEdit` denies root edits until at least one
  required specialist role has a real `SubagentStart` recorded. Once the
  specialist starts, edits flow (including the specialist's own). The guard is
  inert for non-bench sessions and for `observed`/`standard` modes. The
  `subagent-architect-refactor-lite` smoke canary is converted to `enforced`,
  unblocking the merge-blocking functional gate (dispatch failures are excluded
  from the functional line under `enforced`/`observed`) while the separate
  `dispatch-enforced` line honestly reports whether the guard produced a real
  dispatch. Hook cases and unit assertions cover deny-before-dispatch,
  allow-after-dispatch, and inert-under-standard.
- **Environment-variable namespace `AGNTHIVE_*`.** The public env knobs
  (`AGNTHIVE_POLICY`, `AGNTHIVE_LOG_MAX_BYTES`, `AGNTHIVE_LEDGER_MAX_BYTES`,
  `AGNTHIVE_PROGRESS_FILE`, `AGNTHIVE_BRIEF_DIR`, `AGNTHIVE_REVIEW_DIR`) use the
  `agnthive` brand; the legacy `CLAUDE_CREW_*` names are read as aliases for one
  release cycle. The default progress-ledger path moved from
  `<projectDir>/.claude-crew/progress.md` to `<projectDir>/.agnthive/progress.md`.

### Changed

- **Runtime moved from Bash to Node ESM.** The legacy 18 events / 19
  registrations / 20 shell files (19 registration scripts + shared `lib.sh`,
  1564 lines) are replaced by the Node dispatcher and event modules. Every
  hook registration now uses exec form (`command: "node"` + `args` array, no
  `shell: true`).
- **Dangerous-intent default changed to `advisory`.** The legacy Bash runtime
  hard-denied unconditionally via `command_is_hard_denied_by_profile`. The Node
  runtime defaults to `advisory` (fail-open on the unknown) and exposes
  `enforce` (fail-closed) as an opt-in. This is a deliberate new default, not a
  mechanical port — recorded as an intentional behavior delta in the migration
  spec.
- **Cross-platform CI.** CI runs on `ubuntu-latest`, `macos-latest`, and
  `windows-latest` across Node 22 and the current LTS, replacing Python/Shell
  workflows. Paths with spaces, CRLF inputs, UTF-8 input chunks, and plugin
  cache paths are exercised on each OS.

### Removed

- **No Bash, Python, or `jq` in the plugin runtime.** `scripts/plugin-install-smoke.mjs`
  (Check 3) and `scripts/check-no-legacy-runtime.mjs` fail if any `.py`/`.sh`
  file appears in the packaged plugin runtime, so a legacy regression cannot
  silently return.
- **No global config mutation.** The legacy profile copied hooks, agents, and
  skills directly into `~/.claude` and mutated `settings.json` in place. The
  plugin never reads or writes `~/.claude/settings.json`; all configuration is
  environment variables and the plugin-scoped `userConfig`. The plugin's
  `settings.json` (if present) supports only `agent` and `subagentStatusLine`.

### Security

- The command policy is defense-in-depth, not a sandbox. Its supported syntax
  and fail-closed `enforce` behavior are explicit; residual limitations (no
  shell-grammar parsing, no homoglyph normalization, no environment awareness,
  bare-path shell matching) are documented in `SECURITY.md` and
  `docs/specs/command-policy.md`.
- The runtime makes no network calls and sends nothing off the local machine
  (verified: no `fetch`/`http`/`https`/`child_process` imports in `modules/`).
- `claude plugin validate --strict` was run by the integrator (exit 0) prior to
  this beta; the release workflow re-validates the exact unpacked artifact
  before creating a release.
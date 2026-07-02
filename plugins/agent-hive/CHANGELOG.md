# Changelog

All notable changes to this plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This plugin-level changelog records the migration from the copied-`~/.claude`
profile (the `claudecfg/` layout installed via `./install.sh`) to a distributable
Node.js ESM plugin runtime. The repository-root `CHANGELOG.md` covers the older
profile history; entries here begin with the plugin.

## [Unreleased]

### Added

- Stage 5 `dispatch_enforced` hard guard. A benchmark task with
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
  `<name>.old` at `CLAUDE_CREW_LOG_MAX_BYTES` (1 MiB default). No credentials,
  full environment variables, or prompt/transcript contents are logged.
- **Progress ledger.** `ledger.mjs` re-injects compact context after
  compaction, capped at `CLAUDE_CREW_LEDGER_MAX_BYTES` (64 KiB default) with
  UTF-8-safe truncation.
- **Canonical agents and namespaced skills.** Eight agents under `agents/`
  with kebab-case canonical names; legacy persona aliases retained only in
  `assets/aliases.json` for transcript compatibility (no packaged symlinks).
  Skills under `skills/<name>/SKILL.md` with namespaced invocation
  (`/agent-hive:review`). Workflow documents moved into `references/`
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
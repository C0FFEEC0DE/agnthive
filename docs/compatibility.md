# Harness compatibility matrix

- **Status:** Active; first capture 2026-10-19 (plan task 01 of
  [harness modernization](plans/2026-10-19-harness-modernization-and-simplification.md)).
- **Decided by:** [ADR 0012 — versioned harness contracts](adr/0012-versioned-harness-contracts-and-outcome-benchmarks.md);
  failure- and permission-related rows contract with
  [ADR 0011](adr/0011-explicit-hook-failure-and-permission-policy.md).
- Replace this file — not history — when the pin moves; re-capture every row you rely on.

This document is the single normative record of which Claude Code runtime(s)
the plugin is verified against, for which hook events and payload fields, and
what happens where support is unproven. It replaces the abandoned promise of a
minimum-version key inside `plugin.json` (see
[the amendment in the node-migration spec](specs/claude-code-plugin-node-migration.md)).

## Evidence classes

| Label | Meaning |
|---|---|
| **captured** | Command was run in the capture environment against the pinned CLI; output quoted below. No model spend was involved. |
| **docs** | Known floor comes from official docs/changelog only; it was not exercised locally on that version boundary. |
| **implemented** | Landed in the plugin runtime (0.4.0 working tree) with regression tests, but **not yet exercised as a host canary on the pinned CLI** — never assert host behavior from it. |
| **unverified** | Not provable in this environment; requires a runtime fixture (`test/compatibility/`) or a host canary (plan task 14). Never assert it as supported. |

## Tested harness contract (pinned)

| Item | Value at capture | Evidence class |
|---|---|---|
| Claude Code CLI | `2.1.303 (Claude Code)` — `claude --version` | captured |
| Node | `v22.22.2` (`node --version`) | captured |
| Plugin | `agnthive` `0.3.0` at `plugins/agnthive`, git `8f21a6b` | captured |
| Platform | Linux x86_64 (single host capture; CI matrix covers Node 22/24 on Linux/macOS/Windows without the CLI) | captured |
| npm pin availability | `npm view @anthropic-ai/claude-code version` → `2.1.303`; `npm view @anthropic-ai/claude-code@2.1.303 version` → `2.1.303` | captured |
| Pinned install command (CI) | `npm install -g @anthropic-ai/claude-code@2.1.303` | captured (registry), install executed in CI only |
| Review-time baseline | `2.1.292` (the CLI installed during the harness review) remains the compatibility **baseline**; it is not a declared minimum for new hook fields | docs (review design, §scope) |

The review's candidate target 2.1.303 is now both the locally installed version
and the version the npm registry serves — so the pin is reproducible from a
known-good registry entry. `claude install <version>` also exists
(`claude install --help` captured) but was not exercised so the local CLI was
not replaced; CI installs the pin via npm instead. Install-path verification on
a second machine/package manager is **unverified** in this environment.

## Event and field matrix

`Known floor` values marked "(changelog)" come from the official Claude Code
changelog table used by the harness review and are **docs**-class evidence,
never captured version-boundary tests. "Plugin use" names the module that
currently consumes the capability. Fixtures under `test/hooks/fixtures/` are
synthetic unless marked otherwise. Plan task 02 added the runtime contract
layer `test/compatibility/` (16 manifest entries: 4 `active` — the dispatcher
is spawned and the output class asserted today — and 12 `pending_capture`,
which pin only the documented input shape until a live canary replaces them).
Nothing here is *host-captured* on the pinned CLI beyond the rows labelled
captured; "implemented" rows carry regression tests but no host canary
(plan task 14 closes those).

| # | Event / field | Known floor | Status | Plugin use | Fixture | Fallback when unsupported |
|---|---|---|---|---|---|---|
| H01 | Plugin manifest validation: `claude plugin validate --strict` on manifest, `agents/`, `skills/` | 2.1.303 (the pinned CLI) | **captured** — all three targets exit 0 on 2.1.303 | CI required gate; plan task 14 repeats it | the CLI is the oracle | structural smoke (`scripts/plugin-install-smoke.mjs`) is tier-1 and runs CLI-free on every OS |
| H02 | Exec-form hook registration: `hooks[].{type:"command",command:"node",args[]}`, no shell string, no `shell:true` | plugin-format baseline (tested at 2.1.292) | **captured** — strict validation passes on 2.1.303 (20 registrations) | `plugins/agnthive/hooks/hooks.json` | `test/hooks/fixtures/*.json` | none — structural smoke fails any regression (check 4) |
| H03 | Manifest `defaultEnabled: false` (plugin ships disabled) | plugin-format baseline | **captured** — strict pass on 2.1.303; asserted by smoke check 8 | manifest contract | `test/unit/plugin-install-smoke.test.mjs` | none |
| H04 | Manifest `userConfig` (`enforcement_mode`, `log_max_bytes`, `ledger_max_bytes`, `workflow_profile`) | plugin-format baseline | **captured** — strict pass on 2.1.303; contract keys asserted by smoke check 10 (smoke requires the first three; `workflow_profile` is type/default-validated by the repo validator and allowed as an extra key there) | runtime reads config values with env-var overrides | `test/unit/plugin-install-smoke.test.mjs`, `test/validators/hook-manifest-contract.test.mjs` | absent/mis-typed userConfig fails the smoke |
| H05 | No `requirements` manifest key (invented minimum-version field is forbidden) | n/a | **captured** — strict pass without it; smoke check 9 forbids reintroduction | docs-level policy only | `test/unit/plugin-install-smoke.test.mjs` | minimum-version policy lives in this document (below) |
| H06 | `PermissionDenied` event-specific envelope `hookSpecificOutput: {hookEventName:"PermissionDenied", retry:<bool>}` | docs (hooks reference) | **implemented (0.4.0)** — the dispatcher emits the corrected envelope (`modules/hook-output.mjs` `permissionDeniedResult`); host capture on the pinned CLI is still pending | `handlePermissionDenied` (`hook-dispatcher.mjs`), plan task 03 / ADR 0011 closed the bare-`{retry}` shorthand | `test/hooks/fixtures/permission_denied_*.json`, `test/compatibility/` (1 active + 1 pending_capture PermissionDenied entry) | the legacy bare `{ retry }` shorthand is historically accepted by hosts but is not the documented contract — it is no longer emitted; a host canary still needs to confirm the envelope lands |
| H07 | Hook config field `onFailure` (host failure behavior) | ≥ 2.1.295 (changelog — docs) | **implemented (0.4.0)** — the shared Bash and PowerShell PreToolUse shell-policy registrations carry `onFailure: "block"` (`hooks.json`); the docs-class floor (a hook that cannot start, times out, or exits non-zero/2 blocks the tool call) is still **unverified on host** | `enforce`-class safety registration (ADR 0011) — a handler that never runs cannot decide advisory vs enforce | `test/validators/hook-manifest-contract.test.mjs` (onFailure:"block" only on PreToolUse shell rows) | without it, host-level launcher failures are invisible to the plugin; advisory rows deliberately omit it (working advisory handlers keep the native permission flow) and async telemetry gets none |
| H08 | Hook config field `timeout` (bounded host wait) | unknown locally | **implemented (0.4.0)** — every registration declares `timeout` (`10s` sync, `30s` async), validator-enforced; host-side enforcement of the value is **unverified** | all hook registrations (`hooks.json`) | `test/validators/hook-manifest-contract.test.mjs` | undefined host hang; dispatcher cannot detect a hung host. Note (docs): `timeout` on `async: true` hooks is declarative only |
| H09 | `UserPromptSubmit` fires when background work returns (not only on user input) | docs (hooks reference) | **unverified** (payload provenance) — the *handling* is implemented (0.4.0): ADR 0010 task transitions + `prompt_id` dedupe mean a re-delivery cannot erase an open task's contract or sibling counters | `handleUserPromptSubmit` (task identity, `taskTransition`, duplicate-submission dedupe) | `test/compatibility/` `compat_user_prompt_submit_background_return` (pending_capture — the prompt body of a background return is the unknown) | treat any delivery as a possible background return; a duplicate `prompt_id` skips the reset and the transition; unproven provenance never resets sibling counters |
| H10 | User slash command arrives before prompt/skill expansion (2.1.299, changelog) | 2.1.299 (docs) | **implemented (0.4.0)** — `parseSlashedCommand` normalizes `/agnthive:<command>` and the plain legacy forms into one procedure; foreign plugin namespaces are ignored (negative fixtures) | `workflow.mjs` typed-command classification (F06 closed) | `user_prompt_manager_feature.json`, `user_prompt_manager_plan_only.json` (synthetic; real pre-expansion capture pending) | naive text matching; foreign plugin namespaces must not trigger local roles |
| H11 | `Stop` payload carries background-task information | docs (hooks reference) | **implemented (0.4.0)** — Stop/TaskCompleted/TeammateIdle read the `agents{}` / `background_tasks{}` registries; an explicit empty registry is authoritative over stale transcript text, and the transcript heuristic is a bounded fallback | task registry (task 06 / ADR 0010) — payload shape still unverified | `test/hooks/fixtures/transcripts/manager_backgrounded_review.jsonl` (synthetic) | current task registry empty ⇒ no background wait; stale transcript matches must not hold the session open |
| H12 | `prompt_id` correlation between deliveries | docs (hooks reference) | **implemented (0.4.0)** — `prompt_seq`/`last_prompt_id` dedupe duplicate deliveries; never origin proof | `state.mjs` stores `last_prompt_id` for duplicate-detection only (ADR 0010); `hook-input.mjs` does not read the field as provenance | none | never treated as message-origin proof (F02) |
| H13 | `PostCompact` is **not** a documented synchronous context-injection channel | docs (hooks reference) | **implemented (0.4.0)** — ledger restoration moved to `SessionStart` `compact`/`resume` (`additionalContext` from `buildSessionStartRestore`); PostCompact is bounded metadata-only bookkeeping (text only behind `AGNTHIVE_VERBOSE_COMPACT_LOG=1`). Delivery of the `SessionStart` message on the pinned CLI is still **unverified** | `handleSessionStartRestore` / `handlePostCompact` (`hook-dispatcher.mjs`, `ledger.mjs`) | `post_compact_minimal.json`, `post_compact_manual.json` | if capture disproves the session-start delivery path, amend ADR 0013 with evidence before choosing another channel; never claim restoration from emitted JSON alone |
| H14 | `Notification` payload field `notification_type` | docs (hooks reference) | **implemented (0.4.0)** — `notificationPayload` writes `notification_type` (bridging the legacy `subtype` alias on read); the field's arrival on the pinned CLI is still **unverified** | `notifications.mjs` bridges `notification_type ?? subtype` | `notification_*.json` (synthetic) | the bridge keeps old runtimes working; never read either field as message content |
| H15 | `SubagentStart`/`SubagentStop` with separate parent `transcript_path` vs subagent transcript (`agent_transcript_path`) | nested subagents ≥ 2.1.219 (changelog — docs) | **docs** floor; per-agent counters verified locally by dispatcher tests, and ADR-0010 result ownership is implemented (0.4.0): `resolveSubagentReport` checks the delivered handback report, parent/child transcript fallbacks are separated, and missing data yields unknown | ADR 0010 identity model; ADR 0002/0005/0006 per-agent map ops; `transcripts.mjs` fallback | `subagent_start_*.json`, `subagent_stop_*.json`, `test/hooks/fixtures/transcripts/*.jsonl` (synthetic) | missing transcript data yields unknown, not another agent's result |
| H16 | `fork` agent type in headless runs (2.1.302, changelog) | 2.1.302 (docs) | **implemented (0.4.0)** — `isForeignOrForkType` exempts fork/foreign-namespace types from the footer contract before the missing-aliases safe floor (`agents.mjs`, ADR 0010); end-to-end host behavior still unverified | `shouldEnforceSubagentFooter` exempts generic + foreign/fork types (plan 06.5) | `subagent_stop_generic_type_passthrough.json` (covers `general-purpose`; fork-specific negative fixtures pending capture) | unknown/fork labels get passthrough, no footer contract |
| H17 | Native `PowerShell` tool parity | unknown locally | **implemented (0.4.0)** — `hooks.json` registers a native `PowerShell` matcher for the shared PreToolUse safety policy (`onFailure: "block"`) and PostToolUse verification routing on top of the existing `command-policy.mjs` patterns (shared `shellFamily` predicate); host canary still pending | PreToolUse + PostToolUse PowerShell rows (`hooks.json`); `PermissionRequest`/`PermissionDenied` remain Bash-only | `test/validators/hook-manifest-contract.test.mjs` (PowerShell parity), security corpus PowerShell cases | without a matcher a PowerShell tool call bypasses the policy — the parity check now fails registry drift; actual host dispatch is unverified until task 14 |
| H18 | Background command responses (`run_in_background`): real completion/error shapes | unknown locally | **implemented (0.4.0)** — `resultFromBashPayload` normalizes foreground/background/failed payloads into `verification[]` records scoped to the change revision; an unknown or launched-but-not-finished result is never `passed`, and a background launch without a completion signal requires a foreground rerun to close the gate. Real payload shapes remain **unverified** (F01's `backgroundTaskId` was synthetic) | `modules/verification.mjs` + PostToolUse/PostToolUseFailure routing | `post_bash_*.json` (synthetic; `test/compatibility/` background entries pending_capture) | unknown response is never treated as passed; conservative fallback (`fs_revision_hint`) bumps the revision for file-mutating shell commands the Edit/Write counters cannot see |
| H19 | `stop_hook_active` semantics (continue-after-block marker) | plugin-format baseline | plugin-side only; host cross-check **unverified** | `hook-input.mjs` reads `data.stop_hook_active` (ADR 0003 bounded retry) | fixtures in `test/hooks/` covering the flag | bounded one-cycle yield; never converts failed checks to passed |
| H21 | `StopFailure` telemetry event (turn/Stop failure record) | unknown locally | **implemented (0.4.0)** — async registration (`hooks.json`, `timeout: 30`, no `onFailure`: async telemetry has no blocking semantics per docs); writes one bounded `stop-failure.jsonl` record (`ts, session_id, error_name, exit_code, signal, agent_id`), API error text never logged. Arrival of the payload shape on the pinned CLI is **unverified** | `handleStopFailure` (`hook-dispatcher.mjs`) + `stopFailurePayload` (`notifications.mjs`) | `test/hooks/` StopFailure cases (synthetic) | failure of this telemetry write is nonblocking (ADR 0011 telemetry class) |
| H22 | `workflow_profile` selector: `userConfig.workflow_profile` + `AGNTHIVE_WORKFLOW_PROFILE` env override | plugin-format baseline | **implemented (0.4.0)** — resolver precedence env > `CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE` > `legacy`, invalid value falls back to `legacy` with a stderr note; `legacy` is **byte-stable**, `lean` is experimental | `modules/plugin-config.mjs`; `UserPromptSubmit` persists `workflow_profile`, Stop/TaskCompleted/TeammateIdle/SubagentStop consume the lean gate projection (`leanProfileGates`) | `test/unit/workflow-profile.test.mjs`, dispatcher/workflow unit tests | unknown/misconfigured value = legacy, never a silent behavior change |
| H23 | Hooks manifest contract in the validator: event vocabulary incl. the new `StopFailure` event, `timeout`/`onFailure` rules, PowerShell matcher parity | plugin-format baseline | **implemented (0.4.0)** — `scripts/validate.mjs` + `test/validators/hook-manifest-contract.test.mjs` enforce it (`PostToolUseFailure` predates 0.4.0; `StopFailure` is the 0.4.0 registration) | `hooks.json` + the repo validator | the validator manifest checks | unknown events stay passthrough; a registration missing its timeout or carrying `onFailure` outside PreToolUse shell rows fails validation |
| H20 | `claude plugin test` applies to mods only (`*.test.ts`/`*.test.tsx`), not a replacement for the Node suites | **captured** — `claude plugin test --help` | **captured**; no migration planned | none (documentation of scope) | n/a | Node `--test` suites remain the contract layer |

## Unverified rows that block further claims

After the 0.4.0 implementation wave, rows H06–H18 are **implemented** in the
plugin runtime with regression tests, but they are not host-captured: no host
canary on the pinned CLI has exercised them (plan task 14), and the
`test/compatibility/` capture entries for the runtime payloads are still
`pending_capture`, so nothing in README/ADR text may assert host behavior
beyond the captured rows (H01–H05, H20). What remains genuinely unimplemented
is plan task 16 (legacy compatibility-agent removal, deferred to the
compatibility window) and the lean **default** flip, which is gated by the
ADR 0012 outcome benchmark, not by these rows.

## Manifest shape contract (statically asserted)

`scripts/plugin-install-smoke.mjs` statically enforces the shape that the
pinned CLI accepted, so OS shards that never install the CLI still fail on
drift:

1. required manifest fields (`name`, `version`, `displayName`, `description`,
   `author`, `license`);
2. `defaultEnabled` is exactly `false` (the plugin ships disabled);
3. no invented version-policy key — the manifest must not declare
   `requirements`;
4. `userConfig` declares the contract keys `enforcement_mode`,
   `log_max_bytes`, `ledger_max_bytes` (extra keys allowed, missing required
   keys fail; the repo validator additionally type/default-checks
   `workflow_profile` — `legacy|lean`, default `legacy`);
5. hooks use exec form (`command:"node"` + `args`), no shell strings, no
   `shell:true`; every `${CLAUDE_PLUGIN_ROOT}` target resolves;
6. no `.py`/`.sh` in the packaged runtime (Node-only);
7. plugin `settings.json` carries only `agent`/`subagentStatusLine`.

## Minimum-version and upgrade policy

- **No minimum is declared yet.** A supported minimum comes only from a version
  matrix (plan task 14). Until then `2.1.292` (review-time baseline) describes
  what the review ran on, and `2.1.303` is the single pinned, validated target.
- **Never express the minimum in the manifest.** The plugin format has no
  supported `requirements` field; ADR 0012 forbids inventing one. The policy
  lives here (and after task 15 in the user-facing docs), not in
  `plugin.json`.
- **Field-specific floors.** `onFailure` requires ≥ 2.1.295 per the official
  changelog (docs-class evidence); 0.4.0 registers it — `onFailure: "block"` —
  only on the shared Bash/PowerShell PreToolUse shell-policy rows, where the
  hooks reference gives a failed hook blocking semantics. Other floors
  (2.1.299 expansion
  order, 2.1.219 nesting, 2.1.302 headless fork) are likewise docs-class
  claims used only to reason about regressions, not promises.
- **Required CI installs the pin.** `.github/workflows/validate.yml` and
  `.github/workflows/plugin-install-smoke.yml` install
  `@anthropic-ai/claude-code@2.1.303` and run strict manifest/agents/skills
  validation; a failed install is an infrastructure failure, never a silently
  skipped check. Floating `latest` runs as a separate non-required canary job —
  red there is an early warning, not a release gate.
- **Moving the pin.** Update `CLAUDE_CLI_PINNED_VERSION` in the two workflows
  and re-capture this document (version, SHA, matrix evidence) in the same
  change; the npm registry must still serve the exact version
  (`npm view @anthropic-ai/claude-code@<pin> version`).
- **Baseline compatibility.** Behavior on CLIs older than the pin is a
  compatibility concern (plan task 14 checks the 2.1.292 baseline), not
  something this repository silently supports: unsupported paths must be
  documented, not discovered.

## Captured command evidence (2026-10-19, git `8f21a6b`, plugin 0.3.0)

```text
$ claude --version
2.1.303 (Claude Code)

$ node --version
v22.22.2

$ npm view @anthropic-ai/claude-code version
2.1.303

$ npm view @anthropic-ai/claude-code@2.1.303 version
2.1.303

$ claude plugin validate --strict plugins/agnthive
Validating plugin manifest: .../plugins/agnthive/.claude-plugin/plugin.json
  Validation passed          (exit 0)

$ claude plugin validate --strict plugins/agnthive/agents
Validating components in: .../plugins/agnthive/agents
  Validation passed          (exit 0)

$ claude plugin validate --strict plugins/agnthive/skills
Validating components in: .../plugins/agnthive/skills
  Validation passed          (exit 0)
```

`claude plugin validate --help` confirms `--strict` treats warnings as errors
(exit 1) and is the CI-grade switch. `claude plugin eval --help` was captured
for planning only: it launches model runs, so it is excluded from offline
verification (plan rule: no paid eval inside `make precommit`; offline runs
stay cost-free). `claude plugin test --help` (row H20) confirms it runs only
`*.test.ts`/`*.test.tsx` mod tests in child processes of the CLI binary.

`claude --help` (first 50 lines) additionally confirms, at 2.1.303: `--bg`/
`--background` background start with session IDs, and `--bare` which skips
plugin hooks entirely — a bare-mode session receives no agnthive gating by
design, and canaries must not run with `--bare`.
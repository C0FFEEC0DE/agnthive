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
layer `test/compatibility/` (18 manifest entries: 16 `active` — the
dispatcher is spawned and the output class asserted today, 14 of them holding
a payload observed in a live host canary on 2.1.303 — and 2
`pending_capture`). The host canary of 2026-10-21 is described in
*Host canary 2026-10-21* below; the rows labelled captured are backed by it.

**The two entries that stay `pending_capture`** are not missing captures: the
host does not expose the scenario at all, so no payload can be recorded.

- `compat_post_compact` — the host DOES run the PostCompact hook (debug log:
  "Registering async hook … (PostCompact:manual)"), but the async hook is
  **cancelled at session end** before its stdin can be read, and its output is
  never delivered to the model (which is the F07 claim itself).
- `compat_subagent_start_resume` — on 2.1.303 a resumed agent re-fires
  **SubagentStop** (with `stop_hook_active: true`) and does **not** re-fire
  SubagentStart, so the repeated-SubagentStart marker does not exist on this
  host. The real dispatch payload is captured as `compat_subagent_start_dispatch`.

| # | Event / field | Known floor | Status | Plugin use | Fixture | Fallback when unsupported |
|---|---|---|---|---|---|---|
| H01 | Plugin manifest validation: `claude plugin validate --strict` on manifest, `agents/`, `skills/` | 2.1.303 (the pinned CLI) | **captured** — all three targets exit 0 on 2.1.303 | CI required gate; plan task 14 repeats it | the CLI is the oracle | structural smoke (`scripts/plugin-install-smoke.mjs`) is tier-1 and runs CLI-free on every OS |
| H02 | Exec-form hook registration: `hooks[].{type:"command",command:"node",args[]}`, no shell string, no `shell:true` | plugin-format baseline (tested at 2.1.292) | **captured** — strict validation passes on 2.1.303 (20 registrations) | `plugins/agnthive/hooks/hooks.json` | `test/hooks/fixtures/*.json` | none — structural smoke fails any regression (check 4) |
| H03 | Manifest `defaultEnabled: false` (plugin ships disabled) | plugin-format baseline | **captured** — strict pass on 2.1.303; asserted by smoke check 8 | manifest contract | `test/unit/plugin-install-smoke.test.mjs` | none |
| H04 | Manifest `userConfig` (`enforcement_mode`, `log_max_bytes`, `ledger_max_bytes`, `workflow_profile`) | plugin-format baseline | **captured** — strict pass on 2.1.303; contract keys asserted by smoke check 10 (smoke requires the first three; `workflow_profile` is type/default-validated by the repo validator and allowed as an extra key there) | runtime reads config values with env-var overrides | `test/unit/plugin-install-smoke.test.mjs`, `test/validators/hook-manifest-contract.test.mjs` | absent/mis-typed userConfig fails the smoke |
| H05 | No `requirements` manifest key (invented minimum-version field is forbidden) | n/a | **captured** — strict pass without it; smoke check 9 forbids reintroduction | docs-level policy only | `test/unit/plugin-install-smoke.test.mjs` | minimum-version policy lives in this document (below) |
| H06 | `PermissionDenied` event-specific envelope `hookSpecificOutput: {hookEventName:"PermissionDenied", retry:<bool>}` | 2.1.303 (host canary) | **captured** — 2026-10-21: the runtime answered exactly `{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}` and the host enforced the denial; the legacy bare `{retry}` shorthand was not emitted | `handlePermissionDenied` (`hook-dispatcher.mjs`), `permissionDeniedResult` (`hook-output.mjs`) | `test/compatibility/payloads/compat_permission_denied.json` (captured 2026-10-21), `test/compatibility/captures/permission_denied.*` | the legacy bare `{ retry }` shorthand is not emitted; the host emits the event only for **auto-mode classifier** denials — a settings deny rule, an unanswered prompt and a PreToolUse deny do NOT emit it (see *Host canary 2026-10-21*) |
| H07 | Hook config field `onFailure` (host failure behavior) | ≥ 2.1.295 (changelog — docs) | **implemented (0.4.0)** — the shared Bash and PowerShell PreToolUse shell-policy registrations carry `onFailure: "block"` (`hooks.json`); the docs-class floor (a hook that cannot start, times out, or exits non-zero/2 blocks the tool call) is still **unverified on host** | `enforce`-class safety registration (ADR 0011) — a handler that never runs cannot decide advisory vs enforce | `test/validators/hook-manifest-contract.test.mjs` (onFailure:"block" only on PreToolUse shell rows) | without it, host-level launcher failures are invisible to the plugin; advisory rows deliberately omit it (working advisory handlers keep the native permission flow) and async telemetry gets none |
| H08 | Hook config field `timeout` (bounded host wait) | unknown locally | **implemented (0.4.0)** — every registration declares `timeout` (`10s` sync, `30s` async), validator-enforced; host-side enforcement of the value is **unverified** | all hook registrations (`hooks.json`) | `test/validators/hook-manifest-contract.test.mjs` | undefined host hang; dispatcher cannot detect a hung host. Note (docs): `timeout` on `async: true` hooks is declarative only |
| H09 | `UserPromptSubmit` fires when background work returns (not only on user input) | 2.1.303 (host canary) | **captured** — 2026-10-21: a background **subagent** completion is delivered as UserPromptSubmit with a `<task-notification>` body (task-id, tool-use-id, output-file, status, summary, note, result, usage) and a **new** `prompt_id`, so the delivery is distinguishable from the user turn that launched the agent (F02) | `handleUserPromptSubmit` (task identity, `taskTransition`, duplicate-submission dedupe) | `test/compatibility/payloads/compat_user_prompt_submit_background_return.json` (captured 2026-10-21) | the delivery classifies as task type `other` and the runtime answers with a passthrough (no additionalContext) — a background return must never be treated as a new user task |
| H10 | User slash command arrives before prompt/skill expansion (2.1.299, changelog) | 2.1.303 (host canary) | **captured** — 2026-10-21: the raw text `/agnthive:manager hello` reached the UserPromptSubmit hook **unexpanded** (F06 closed on the host) | `workflow.mjs` typed-command classification (F06) | `test/compatibility/payloads/compat_user_prompt_submit_namespace_slash.json` (captured 2026-10-21) | the delivery routes the session into manager mode but classifies as task type `other`, so the runtime answers with a passthrough; foreign plugin namespaces must not trigger local roles |
| H11 | `Stop` payload carries background-task information | 2.1.303 (host canary) | **captured** — 2026-10-21: the real Stop payload carries `background_tasks: []` and `session_crons: []` — an explicit empty registry, not a missing field | task registry (task 06 / ADR 0010) | `test/compatibility/captures/stop_active_work.stdin.json` (captured 2026-10-21) | current task registry empty ⇒ no background wait; stale transcript matches must not hold the session open |
| H12 | `prompt_id` correlation between deliveries | 2.1.303 (host canary) | **captured** (field) / **implemented (0.4.0)** (dedupe) — the field is present in every UserPromptSubmit/PostToolUse/Stop delivery observed on 2026-10-21, and a background return carries a **new** prompt_id; `prompt_seq`/`last_prompt_id` dedupe is plugin-side | `state.mjs` stores `last_prompt_id` for duplicate-detection only (ADR 0010); `hook-input.mjs` does not read the field as provenance | `test/compatibility/payloads/compat_user_prompt_submit_*.json` (captured 2026-10-21) | never treated as message-origin proof (F02) |
| H13 | `PostCompact` is **not** a documented synchronous context-injection channel | 2.1.303 (host canary) | **captured** — 2026-10-21: the host DOES register and run the PostCompact hook, but the async hook is **cancelled at session end** (`Hook PostCompact:manual (PostCompact) cancelled:`) and its output never reaches the model — the F07 claim is confirmed. The restoration channel is `SessionStart` `source=compact`, whose ledger-restore envelope WAS observed live | `handleSessionStartRestore` / `handlePostCompact` (`hook-dispatcher.mjs`, `ledger.mjs`) | `test/compatibility/captures/session_start_compact.*` (captured 2026-10-21); the PostCompact **stdin** was never observable (async hook cancelled) | if capture disproves the session-start delivery path, amend ADR 0013 with evidence before choosing another channel; never claim restoration from emitted JSON alone |
| H14 | `Notification` payload field `notification_type` | docs (hooks reference) | **implemented (0.4.0)** — `notificationPayload` writes `notification_type` (bridging the legacy `subtype` alias on read); the field's arrival on the pinned CLI is still **unverified** | `notifications.mjs` bridges `notification_type ?? subtype` | `notification_*.json` (synthetic) | the bridge keeps old runtimes working; never read either field as message content |
| H15 | `SubagentStart`/`SubagentStop` with separate parent `transcript_path` vs subagent transcript (`agent_transcript_path`) | 2.1.303 (host canary) | **captured** — 2026-10-21: the real SubagentStop payload carries BOTH `transcript_path` (parent) and `agent_transcript_path` (the subagent transcript, a different file), plus `agent_id`, `agent_type` and the `background_tasks` registry | ADR 0010 identity model; `transcripts.mjs` fallback | `test/compatibility/payloads/compat_subagent_stop_return.json`, `test/compatibility/payloads/compat_subagent_start_dispatch.json` (captured 2026-10-21) | missing transcript data yields unknown, not another agent's result |
| H16 | `fork` agent type in headless runs (2.1.302, changelog) | 2.1.302 (docs) | **implemented (0.4.0)** — `isForeignOrForkType` exempts fork/foreign-namespace types from the footer contract before the missing-aliases safe floor (`agents.mjs`, ADR 0010); end-to-end host behavior still unverified | `shouldEnforceSubagentFooter` exempts generic + foreign/fork types (plan 06.5) | `subagent_stop_generic_type_passthrough.json` (covers `general-purpose`; fork-specific negative fixtures pending capture) | unknown/fork labels get passthrough, no footer contract |
| H17 | Native `PowerShell` tool parity | unknown locally | **implemented (0.4.0)** — `hooks.json` registers a native `PowerShell` matcher for the shared PreToolUse safety policy (`onFailure: "block"`) and PostToolUse verification routing on top of the existing `command-policy.mjs` patterns (shared `shellFamily` predicate); host canary still pending | PreToolUse + PostToolUse PowerShell rows (`hooks.json`); `PermissionRequest`/`PermissionDenied` remain Bash-only | `test/validators/hook-manifest-contract.test.mjs` (PowerShell parity), security corpus PowerShell cases | without a matcher a PowerShell tool call bypasses the policy — the parity check now fails registry drift; actual host dispatch is unverified until task 14 |
| H18 | Background command responses (`run_in_background`): real completion/error shapes | 2.1.303 (host canary) | **captured** — 2026-10-21: a background launch delivers `tool_input.run_in_background: true` and a `tool_response` of `{stdout:"", stderr:"", interrupted:false, isImage:false, noOutputExpected:false, backgroundTaskId:"<id>"}`; the **completion arrives as a UserPromptSubmit `<task-notification>`**, not as a second PostToolUse. The host sends **no exit code** in `tool_response`, so an undeterminable outcome is recorded as `status: "unknown"` — never `passed` (F01). Re-measured 2026-10-22 in the ADR-0012 matrix: the completion envelope carries the original `<tool-use-id>` and the summary carries the exit code (`Background command "…" completed (exit code 0)`), and when the turn is still running the host **absorbs the notification mid-turn** (it is enqueued and then removed with reason `absorbed_mid_turn`, so no UserPromptSubmit fires) | `modules/verification.mjs` + PostToolUse/PostToolUseFailure routing; the completion is completed from the `<task-notification>` prompt | `test/compatibility/payloads/compat_post_tool_use_background_bash.json`, `test/compatibility/payloads/compat_user_prompt_submit_background_return.json` (captured 2026-10-21) | unknown response is never treated as passed; a background launch without a completion signal (or one absorbed mid-turn) requires a foreground rerun to close the gate |
| H19 | `stop_hook_active` semantics (continue-after-block marker) | 2.1.303 (host canary) | **captured** — 2026-10-21: after the plugin blocked a Stop, the host re-fired Stop with `stop_hook_active: true` and the runtime answered `{}` — the bounded one-cycle yield (ADR 0003) | `hook-input.mjs` reads `data.stop_hook_active` (ADR 0003 bounded retry) | `test/compatibility/captures/stop_active_work.*`, `test/compatibility/captures/stop_after_own_block.*` (captured 2026-10-21) | bounded one-cycle yield; never converts failed checks to passed |
| H21 | `StopFailure` telemetry event (turn/Stop failure record) | unknown locally | **implemented (0.4.0)** — async registration (`hooks.json`, `timeout: 30`, no `onFailure`: async telemetry has no blocking semantics per docs); writes one bounded `stop-failure.jsonl` record (`ts, session_id, error_name, exit_code, signal, agent_id`), API error text never logged. Arrival of the payload shape on the pinned CLI is **unverified** | `handleStopFailure` (`hook-dispatcher.mjs`) + `stopFailurePayload` (`notifications.mjs`) | `test/hooks/` StopFailure cases (synthetic) | failure of this telemetry write is nonblocking (ADR 0011 telemetry class) |
| H22 | `workflow_profile` selector: `userConfig.workflow_profile` + `AGNTHIVE_WORKFLOW_PROFILE` env override | plugin-format baseline | **implemented (0.4.0)** — resolver precedence env > `CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE` > `lean` (the default since the ADR 0012 rollout gate passed), invalid value falls back to `legacy` — the stricter profile — with a stderr note; `legacy` is **byte-stable** and stays selectable for one transition release | `modules/plugin-config.mjs`; `UserPromptSubmit` persists `workflow_profile`, Stop/TaskCompleted/TeammateIdle/SubagentStop consume the lean gate projection (`leanProfileGates`) | `test/unit/workflow-profile.test.mjs`, dispatcher/workflow unit tests | unknown/misconfigured value = legacy, never a silent behavior change |
| H23 | Hooks manifest contract in the validator: event vocabulary incl. the new `StopFailure` event, `timeout`/`onFailure` rules, PowerShell matcher parity | plugin-format baseline | **implemented (0.4.0)** — `scripts/validate.mjs` + `test/validators/hook-manifest-contract.test.mjs` enforce it (`PostToolUseFailure` predates 0.4.0; `StopFailure` is the 0.4.0 registration) | `hooks.json` + the repo validator | the validator manifest checks | unknown events stay passthrough; a registration missing its timeout or carrying `onFailure` outside PreToolUse shell rows fails validation |
| H20 | `claude plugin test` applies to mods only (`*.test.ts`/`*.test.tsx`), not a replacement for the Node suites | **captured** — `claude plugin test --help` | **captured**; no migration planned | none (documentation of scope) | n/a | Node `--test` suites remain the contract layer |
| H24 | Headless compaction of a live session (`claude -p --resume <id> "/compact"`) | 2.1.303 (host canary) | **captured** — 2026-10-22: in print mode the host accepts `/compact` on a resumed session; the compaction is delivered as SessionStart with `source=compact` (and the resumed session as `source=resume`), and the plugin's ledger restoration runs on it (`restored_task_seq` incremented twice per compact+resume cycle in the live probe) | `handleSessionStartRestore` (`hook-dispatcher.mjs`) + `buildSessionStartRestore` (`ledger.mjs`) | `test/compatibility/payloads/compat_session_start_compact.json`, `test/compatibility/payloads/compat_session_start_resume.json` (captured 2026-10-21, replayed with the live state seed) | without a compaction the restore channel never fires and the session keeps its own context only |

## Unverified rows that block further claims

The host canary of 2026-10-21 exercised rows H06 and H09–H19 on the pinned
CLI and turned them into **captured** rows; the redacted evidence is under
`test/compatibility/captures/` and the payloads that could be asserted
end-to-end are under `test/compatibility/payloads/` with
`source: "captured"`.

**The four state-dependent captures are now active contract fixtures.** The
Stop payloads and the two SessionStart payloads were recorded live, but their
verdict depends on the state the live session had (a prior block; an open
task). The manifest declares that prior state per entry (`state_seed`), the
contract test writes it into the probe's data root through the plugin's own
state writer, and the probe then reproduces the **live** verdict. Before that,
these entries were held at `pending_capture` even though the payload existed —
the capture was real, only the assertion was missing.

What is still **not** host-verified:

- **H07** (`onFailure`) and **H08** (`timeout`) — the canary never produced a
  hook that failed to start or timed out, so the host-side failure behaviour of
  both fields stays docs/implemented-class only.
- **H14** (`notification_type`) — the canary produced no Notification event,
  so the field was never observed on the host.
- **H16** (fork agent type) — a compaction fork did emit a SubagentStop with an
  empty `agent_type`, but no fork-typed *agent* dispatch was observed.
- **H17** (native PowerShell tool parity) — the canary ran on Linux with the
  Bash tool only; the PowerShell matcher was not exercised.
- The PostCompact **stdin** — the host cancels that async hook at session end,
  so the payload itself is still unobserved (the event's *existence* and the
  cancellation are observed, see H13).

What remains genuinely unimplemented is plan task 16 (legacy
compatibility-agent removal, deferred to the compatibility window). The lean
**default** flip is done: the ADR 0012 outcome-benchmark rollout gate passed on
the live arm x repetition matrix, so `lean` is the default profile and `legacy`
stays selectable for one transition release.

## Host canary 2026-10-21 (CLI 2.1.303)

**Method.** Real `claude -p` sessions against the pinned CLI
(`2.1.303 (Claude Code)`, `node --version` → `v22.22.2`) with the local
ollama provider (`ANTHROPIC_BASE_URL=http://127.0.0.1:11434`, model
`glm-5.2:cloud`). The plugin was loaded from an instrumented **copy** in
`/tmp` whose `hooks/hooks.json` registers a wrapper that tees the raw hook
stdin to a file and then re-runs the unmodified dispatcher — the repository
tree `plugins/agnthive/` was never modified, and `defaultEnabled` stayed
`false`. The session was enabled with `--plugin-dir <copy> --settings <file>`
and `{"enabledPlugins": {"agnthive@inline": true}}`; without that settings
file the host registers **zero** hooks from the plugin and there is nothing
to capture.

**What the host actually sends** (redacted, `test/compatibility/captures/`):

- `UserPromptSubmit`: `session_id, transcript_path, cwd, prompt_id,
  permission_mode, hook_event_name, prompt`.
- `PostToolUse` (Bash): the same header plus `effort`, `tool_name`,
  `tool_input`, `tool_response`, `tool_use_id`, `duration_ms`. The
  `tool_response` is `{stdout, stderr, interrupted, isImage,
  noOutputExpected}` — **no exit code**; a background launch adds
  `backgroundTaskId`.
- `SubagentStart`: `agent_id` + `agent_type` (host-assigned, e.g. `Explore`),
  no `agent_alias`.
- `SubagentStop`: the above plus `agent_transcript_path` (a different file
  from the parent `transcript_path`), `stop_hook_active`,
  `last_assistant_message`, `background_tasks`, `session_crons`.
- `Stop`: `stop_hook_active`, `last_assistant_message`, `background_tasks`,
  `session_crons`.
- `SessionStart`: `source` = `startup` | `resume` | `compact`; the `resume`
  delivery adds `seconds_since_last_response`, `context_tokens`,
  `prompt_cache_likely_expired`, `estimated_cache_write_usd`; the `compact`
  delivery adds `prompt_id` and `model`.
- `PermissionDenied`: `tool_name`, `tool_input`, `tool_use_id` and a `reason`
  string (the classifier verdict).

**Behaviours the canary pinned** (all reproduced in the contract test, see
`test/compatibility/manifest.json`):

1. The feature classification is **text driven**: `Add support for provider
   failover and integrate OpenRouter.` classifies as a feature workflow
   (envelope + `task_type=feature`, `required_subagents=[t, cr]`), while
   `Add a helper function parseDuration ...` classifies as `other` and the
   runtime answers with a **passthrough** (no additionalContext). Both are real
   captures (`compat_user_prompt_submit_normal`,
   `compat_user_prompt_submit_other_classified`).
2. A background **subagent** completion is delivered as UserPromptSubmit with a
   `<task-notification>` body and a new `prompt_id`.
3. A resumed background agent re-fires **SubagentStop** (with
   `stop_hook_active=true` for the same `agent_id`) and does **not** re-fire
   SubagentStart — the repeated-SubagentStart marker does not exist on 2.1.303.
4. The host emits **PermissionDenied** only for auto-mode *classifier* denials.
   A settings deny rule, an unanswered permission prompt and a PreToolUse deny
   were all measured and did **not** emit the event. With the plugin as shipped
   every policy-hard-denied command is blocked at PreToolUse before the
   permission stage, so the `retry:false` (hard-denied) variant of the event
   was not observed; the captured variant answered `retry:true`.
5. The `PostCompact` hook is registered and run, then **cancelled** at session
   end — its stdin could not be observed, and its output never reaches the
   model. The restoration channel is `SessionStart` `source=compact`, whose
   ledger-restore envelope was observed live.

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
   `workflow_profile` — `legacy|lean`, default `lean`);
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
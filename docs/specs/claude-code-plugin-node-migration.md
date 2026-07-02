# Traceability matrix: Claude Code plugin and Node.js migration

Status: **Completed — historical traceability record.** The Node runtime now
ships under `plugins/agent-hive/modules/`; the Bash runtime was
removed. This document preserves the source-to-target mapping and the accepted
behavioral deltas from the migration.

It maps the former Bash hook runtime (`claudecfg/hooks/*.sh` + shared
`lib.sh`) to the shipped Node ESM modules defined in the production plan
(`docs/plans/2026-06-21-claude-code-plugin-node-production.md`), and freezes
the public compatibility policy.

## Public compatibility policy

| Policy | Value |
|---|---|
| Runtime prerequisite | **Node.js 22 or newer** on `PATH`. Node is an explicit plugin prerequisite, not an implicit dependency on a Claude Code installer. The dispatcher preflights `node --version` and, on failure, writes an actionable install hint to stderr + a non-blocking `additionalContext` message; it never fails silently. |
| Supported Claude Code versions | Plugin format (`hooks/hooks.json`, `.claude-plugin/plugin.json`, exec-form `command: "node"`) targets Claude Code plugin support as documented in the Plugins / Hooks reference. Minimum supported version is pinned in `plugin.json` `requirements` and noted in the README; the plugin does not depend on unreleased hook events. |
| Dangerous-intent default | `enforcement_mode` defaults to `advisory`. Users opt into `enforce` through plugin user configuration. In `enforce` mode, an unparseable command is **denied with an explanation** rather than guessed safe. (The current Bash runtime hard-denies unconditionally via `command_is_hard_denied_by_profile`; `advisory`/`enforce` is a new Node-default policy, not a port of existing behavior.) |
| Privacy | Telemetry stores session metadata and notification events under `${CLAUDE_PLUGIN_DATA}` only. The runtime never logs credentials, full environment variables, or unnecessary prompt/transcript contents. JSONL telemetry is size-bounded and rotated. |
| Plugin / settings boundary | Plugin `settings.json` supports only `agent` and `subagentStatusLine`. The plugin **cannot** auto-install this profile's global permissions, sandbox, auto-execution, output style, or main status line. These are documented as opt-in copy-paste snippets; the plugin never overwrites a user's `~/.claude/settings.json`. |
| State location | Mutable installation roots are forbidden. All state lives in `${CLAUDE_PLUGIN_DATA}/<validated-session-id>`. The plugin never writes into `${CLAUDE_PLUGIN_ROOT}` or outside the project paths hooks explicitly provide. |

Non-migratable settings behavior (product-owner-accepted): global
permissions, sandbox, auto-execution, output style, and the main status line
remain user-managed opt-in snippets. This is a deliberate boundary, not a gap.

## Event and registration map

18 events, 19 registrations, 20 shell files (19 registration scripts + shared
`lib.sh`). Confirmed against `claudecfg/settings.json`.

| ID | Event | Matcher | Shell file | Async | Target Node module(s) |
|---|---|---|---:|---|---|
| E01 | SessionStart | `*` | session-start.sh | | `verification.mjs` (command detection), `state.mjs` (session init) |
| E02 | InstructionsLoaded | `session_start\|compact\|nested_traversal\|path_glob_match\|include` | instructions-loaded.sh | async | `workflow.mjs` (context injection gating) |
| E03 | UserPromptSubmit | `*` | user-prompt-submit.sh | | `workflow.mjs` (classification, manager modes, docs/role requirements, stop-loop reset) |
| E04 | PreToolUse | `Bash` | pre-tool-use.sh | | `command-policy.mjs`, `hook-output.mjs` |
| E05 | PermissionRequest | `Bash` | permission-request.sh | | `command-policy.mjs`, `hook-output.mjs` |
| E06 | PermissionDenied | `Bash` | permission-denied.sh | | `command-policy.mjs` (retry decision), `hook-output.mjs` |
| E07 | PostToolUse | `Edit\|MultiEdit\|Write\|NotebookEdit` | post-edit-write.sh | | `state.mjs` (code_changed/docs_changed flags), `summary-contract.mjs` |
| E08 | PostToolUse | `Bash` | post-bash.sh | | `verification.mjs` (test/lint/build outcome capture) |
| E09 | PostToolUseFailure | `Bash` | post-tool-failure.sh | | `verification.mjs` (failure state) |
| E10 | SubagentStart | `*` | subagent-start.sh | | `transcripts.mjs`, `agents.mjs` (role/alias normalization) |
| E11 | SubagentStop | `*` | subagent-stop-guard.sh | | `summary-contract.mjs` (handoff footer), `agents.mjs` |
| E12 | Stop | `*` | stop-guard.sh | | `summary-contract.mjs` (footer gates, terminal response), `workflow.mjs` (loop counter) |
| E13 | TeammateIdle | `*` | teammate-idle.sh | | `workflow.mjs` (manager-led gate), `summary-contract.mjs` |
| E14 | TaskCompleted | `*` | task-completed.sh | | `summary-contract.mjs` (completion gates), `agents.mjs` |
| E15 | Notification | `*` | notification.sh | async | `notifications.mjs` (telemetry, rotation) |
| E16 | ConfigChange | `*` | config-change.sh | | `notifications.mjs` (config-change JSONL log; no state field) |
| E17 | PreCompact | `*` | pre-compact.sh | async | `state.mjs` (compact lifecycle) |
| E18 | PostCompact | `*` | post-compact.sh | async | `ledger.mjs` (progress-ledger re-injection), `state.mjs` |
| E19 | SessionEnd | `*` | session-end.sh | async | `state.mjs` (session lifecycle), `notifications.mjs` |

`PostToolUse` is the only event with two registrations (E07 edit/write family
+ E08 Bash). The dispatcher routes by event name plus the `tool_name` /
matcher the runtime supplies, so a single `hook-dispatcher.mjs` entry point
serves all 19 registrations via `--event`.

> **Dispatcher path deviation (documented).** The production plan references
> `dist/hook-dispatcher.mjs` as the hook exec target. The implementation
> instead points `hooks/hooks.json` at `${CLAUDE_PLUGIN_ROOT}/modules/hook-dispatcher.mjs`
> — committed source under `modules/`, not a build output under `dist/`.
> Rationale: a marketplace install copies the plugin source directory into the
> cache with **no install-time build step**, so any path under a gitignored
> `dist/` would not exist at runtime. The runtime therefore must live in
> committed source. `dist/` is reserved for Phase 5 release artifacts, and
> `scripts/build.mjs` validates the committed `modules/` tree rather than
> transpiling into `dist/`. This deviation is reviewed and intentional; it
> does not change the event map, the module split, or any contract above.

## lib.sh function → Node module assignment

75 functions in `claudecfg/hooks/lib.sh` (1564 lines). Each maps to exactly
one target module (or `util` if truly generic). Module names match the
production plan's `modules/` tree.

### state.mjs — session IDs, paths, locking, snapshots, atomic update, retention
`json_get`, `json_get_bool`, `timestamp_utc`, `safe_session_id`, `state_file`,
`progress_ledger_path`, `ensure_dirs`, `ensure_state`, `_acquire_state_lock`,
`_release_state_lock`, `_atomic_state_update`, `update_state`.

> **Intentional delta:** the mkdir-based directory lock + non-atomic initial
> write + stale-lock TOCTOU are **not** ported mechanically. They are replaced
> by append-only event records created with exclusive creation (`wx`) plus a
> pure reducer that derives latest state; snapshots are disposable caches
> written via temp-file + `fsync` (where supported) + atomic rename. A migration
> version is stamped on every event and snapshot. See [Behavior deltas](#intentional-behavior-deltas).

### hook-input.mjs — stdin JSON parsing, field extraction, transcript path resolution
`resolve_transcript_path`, `json_get`, `json_get_bool` (shared with `state.mjs`;
the Node port factors a single input parser used by both).

### hook-output.mjs — output decision construction (fixed constructors only)
`emit_context`, `emit_pretool_decision`, `emit_permission_request_deny`,
`emit_permission_denied_retry`, `emit_permission_denied_no_retry`,
`emit_loop_aware_block`.

> **Intentional delta:** `emit_loop_aware_block` already branches on
> `hard_stop` so the terminal response omits `decision: "block"` (see commit
> `b97210b`). The Node port preserves this: normal guards use
> `decision: "block"` + reason / `additionalContext`; terminal cancellation
> uses **only** `continue: false` + `stopReason`; the two are never combined.

### workflow.mjs — classification, manager modes, docs/role requirements, stop-loop
`task_type_requires_implementation_summary`,
`task_type_requires_specialist_handoffs`, `record_loop_block`,
`clear_loop_block`, `loop_block_count`, `session_background_manager_pending`.

### verification.mjs — test/lint/build discovery and outcome tracking
`detect_node_script`, `detect_make_target`, `detect_test_cmd`,
`detect_lint_cmd`, `detect_build_cmd`, `command_class`,
`is_release_or_deploy_command`.

> `message_mentions_verification_status` is a `message_has_any_line_prefix`
> wrapper and lives with its `message_mentions_*` family in
> `summary-contract.mjs` (see below), not here.

### summary-contract.mjs — footer parsing, completion gates, block checklists
`stop_safe_no_change_footer_hint`, `checklist_status_line`,
`message_has_line_prefix`, `message_has_any_line_prefix`,
`message_mentions_review_outcome`, `message_mentions_verification_status`,
`message_mentions_docs_status`,
`message_mentions_changed_files`, `message_mentions_remaining_risks`,
`message_mentions_next_step`, `message_mentions_concrete_outcome`,
`message_reports_no_changes`, `block_checklist_summary_requirements`,
`block_checklist_gate_requirements`, `block_checklist_fix_template`,
`build_block_checklist`, `session_block_reason`,
`session_agent_enforcement_reason`, `session_manager_idle_reason`.

### command-policy.mjs — dangerous-intent detection (platform-neutral)
`normalize_command_for_policy`, `is_dangerous_rm_command`,
`rm_command_targets_home_or_current`, `is_force_push_command`,
`is_remote_shell_bootstrap_command`, `command_is_hard_denied_by_profile`,
`permission_denied_should_retry` (retry-eligibility decision for the
PermissionDenied event).

> **Intentional delta:** the current policy only recognizes POSIX spellings.
> The replacement adds PowerShell + CMD support (at minimum: destructive
> recursive deletion, disk formatting / raw disk writes, privilege escalation,
> force pushes / destructive reset, remote-script bootstrap pipes, release and
> deploy automation, and Windows `Remove-Item`/`del`/`rmdir`/`Format-Volume`/
> `Clear-Disk`/`diskpart`/`Invoke-WebRequest | Invoke-Expression`). Advisory
> default; `enforce` mode fails closed on unparseable input. No
> `child_process.exec`, shell interpolation, or `spawn(..., { shell: true })`.

### transcripts.mjs — transcript parsing, last-message extraction
`tail_jsonl_lines`, `extract_last_assistant_message_from_jsonl_stream`,
`extract_last_assistant_message_from_transcript`,
`resolved_last_assistant_message`,
`transcript_indicates_backgrounded_agent`.

### agents.mjs — role inference, alias normalization, subagent labeling
`extract_subagent_label`, `extract_subagent_scope`,
`canonicalize_subagent_label`, `infer_started_roles_from_transcript`,
`effective_started_roles`, `format_subagent_list`, `format_subagent_group`.
Backed by `assets/aliases.json` for transcript compatibility; no packaged
symlink aliases.

### notifications.mjs + ledger.mjs — telemetry, rotation, progress ledger
`append_jsonl`, `rotate_jsonl_if_needed` (notifications). `ledger.mjs` owns
the progress-ledger re-injection logic and **calls** `progress_ledger_path`,
which remains owned by `state.mjs` (listed there above) — no double ownership.

### util — generic helpers
`array_contains`, `sorted_unique_lines`, `is_docs_path`. These live in a
shared `modules/util.mjs`, an eleventh module alongside the plan's ten; the
plan's `modules/` tree (plan lines 74-83) should be read to include it.

## Session state field map

State fields read via `jq -r '.field'` in `lib.sh` (19 distinct reads) and the
fields written by `_atomic_state_update` / hook scripts. All live in
`state.mjs` and persist under `${CLAUDE_PLUGIN_DATA}/<session-id>/state.json`
(derived from event records in the Node port).

| Field | Kind | Module | Meaning |
|---|---|---|---|
| `session_id`, `cwd`, `transcript_path`, `created_at` | session meta | state | Identity and routing |
| `task_type` | classified | workflow | feature / bugfix / refactor / review / docs / other |
| `manager_mode` | classified | workflow | Manager-led flag |
| `docs_required` | classified | workflow | Docs gate active |
| `required_subagents`, `required_subagent_any_of` | classified | workflow | Role gate (all-of / any-of) |
| `edited`, `code_changed`, `docs_changed` | flags | state / summary | Edit/write observations |
| `tests_ok`, `tests_failed`, `lint_ok`, `lint_failed`, `build_ok`, `build_failed` | verification | verification | Last command outcomes |
| `detected_test_command`, `detected_lint_command`, `detected_build_command` | detected | verification | SessionStart-discovered task runners |
| `last_test_command`, `last_lint_command`, `last_build_command` | tracked | verification | Last observed commands |
| `subagents_started` | tracked | agents | Roles seen via SubagentStart/transcript |
| `stop_block_count`, `stop_block_reason`, `stop_block_message` | loop | workflow / summary | Stop-loop counter + last reason |
| `stalled_by_policy`, `policy_stall_reason` | terminal | summary | Policy-stall terminal state |
| `files` | tracked | state | Edited file paths accumulated by post-edit-write |
| `subagent_start_count` | tracked | agents | SubagentStart counter |
| `subagent_instance_count_by_role` | tracked | agents | Per-role instance counts |
| `subagent_events` | tracked | agents | SubagentStart event log |
| `subagent_stop_block_count` | loop | summary | SubagentStop loop counter (parallel to `stop_block_count`) |
| `subagent_stop_block_reason` | loop | summary | SubagentStop last block reason |
| `subagent_stop_block_message` | loop | summary | SubagentStop last block message |
| `progress_ledger` (file) | ledger | ledger | Re-injected compact context |

> **Intentional delta:** the 11 fields currently mutated directly by hook
> scripts that source `lib.sh` move behind `state.mjs` accessors so all writes
> live in one module and flow through the append-only reducer.

## Fixture and case coverage

142 isolated cases (`test/hooks/cases.json`) across the 19 registration
scripts, plus 2 stateful scenarios (`test/hooks/scenarios.json`) and ~196
fixtures (182 top-level + 14 transcripts under `test/hooks/fixtures/`).
Fixtures are the compatibility contract: they are copied into the new Node
test tree first, then intentional deltas appear as new fixtures with a
documented reason.

| Shell script | Cases | Primary Node module(s) under test |
|---|---:|---|
| stop-guard.sh | 38 | summary-contract, workflow |
| user-prompt-submit.sh | 21 | workflow |
| task-completed.sh | 15 | summary-contract, agents |
| pre-tool-use.sh | 12 | command-policy |
| subagent-start.sh | 10 | agents, transcripts |
| subagent-stop-guard.sh | 10 | summary-contract, agents |
| post-edit-write.sh | 5 | state, summary-contract |
| notification.sh | 5 | notifications |
| permission-request.sh | 3 | command-policy |
| permission-denied.sh | 3 | command-policy |
| post-bash.sh | 3 | verification |
| teammate-idle.sh | 3 | workflow, summary-contract |
| config-change.sh | 2 | state |
| instructions-loaded.sh | 2 | workflow |
| post-compact.sh | 2 | ledger, state |
| post-tool-failure.sh | 2 | verification |
| pre-compact.sh | 2 | state |
| session-end.sh | 2 | state, notifications |
| session-start.sh | 2 | verification, state |

Fixture groups (top-level, by prefix): `user_prompt_*` (models, manager, bugfix,
no-session, etc.), `stop_guard_*` (missing review, alias, policy-stalled),
`state_*` (~41 state seeds), `post_edit_write_*`, `notification_*`,
`permission_request_*` / `permission_denied_*`, `pre_tool_use_*`,
`post_bash_*`, `task_completed_*`, `subagent_stop_*`, `teammate_idle_*`,
`session_*`, `pre_compact_*` / `post_compact_*`, `instructions_loaded_*`,
`config_change_*`, plus 14 `transcripts/*` fixtures.

Runner mechanics to reproduce in Node (`scripts/test-hooks.sh` +
`test/hooks/test-lib.sh`): a case pipes its `stdin` fixture into the hook
script, seeds shared state from `seed_state`, then asserts via `stdout_jq`,
`state_jq`, and file assertions; scenario mode shares a state sandbox across
steps. `test-lib.sh` direct-sources `lib.sh` for ~49 helper unit tests. The
Node port replaces the runner with `node --test` suites while preserving every
JSON fixture and assertion.

## Intentional behavior deltas

1. **State model:** live mutable read-modify-write JSON → append-only event
   records + pure reducer + disposable snapshots. Removes the non-atomic
   initial write, shared-state update race, and stale-lock TOCTOU. Differential
   fixture tests document every observable delta; approved deltas only.
2. **Terminal stop response:** already fixed in `b97210b` (no
   `decision: "block"` + `continue: false` combo). Node port preserves it and
   adds explicit regression tests for `stop_hook_active` and the runtime's
   consecutive-block cap as integration constraints.
3. **Policy-stall reset:** only a genuine `UserPromptSubmit` clears terminal
   `stalled_by_policy` state (`b97210b`). Preserved.
4. **Security policy scope:** POSIX-only → platform-neutral (POSIX +
   PowerShell + CMD), advisory default, fail-closed enforce. New corpus under
   `test/security/`.
5. **Agent names:** eight agents → kebab-case canonical names; alias
   recognition stays in `assets/aliases.json` only where transcript
   compatibility needs it; no packaged symlinks.
6. **Commands/skills:** flat command Markdown + legacy skill Markdown →
   `skills/<name>/SKILL.md` with namespaced invocation
   (`/agent-hive:review`).
7. **Workflows:** `workflows/` → on-demand skill references (no permanent
   session context).
8. **Settings:** plugin cannot silently take over global settings/statusline;
   documented opt-in snippets only.

## Coverage verification (completed migration gate)

The migration exit gate was satisfied by the repository validation, smoke
install, and runtime test suites:

- [x] All 18 events and 19 registrations in the [event map](#event-and-registration-map) have a target Node module.
- [x] All 75 `lib.sh` functions are assigned to exactly one module in the [function map](#libsh-function--node-module-assignment).
- [x] All session state fields are owned by `state.mjs` (or `ledger.mjs` for the ledger file) in the [state map](#session-state-field-map).
- [x] Every case in `cases.json` (142) and every fixture group is reachable from a module row in [fixture coverage](#fixture-and-case-coverage).
- [x] Every [intentional behavior delta](#intentional-behavior-deltas) has a corresponding differential fixture or documented rationale.
- [x] The [public compatibility policy](#public-compatibility-policy) records product-owner acceptance of non-migratable settings behavior.

The shipped runtime uses committed `modules/*.mjs`; it has no installation-time
build step.

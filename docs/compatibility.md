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
| **unverified** | Not provable in this environment; requires a runtime fixture (plan task 02) or a host canary (plan task 14). Never assert it as supported. |

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
synthetic unless marked otherwise; real-payload capture is pending (plan task
02).

| # | Event / field | Known floor | Status | Plugin use | Fixture | Fallback when unsupported |
|---|---|---|---|---|---|---|
| H01 | Plugin manifest validation: `claude plugin validate --strict` on manifest, `agents/`, `skills/` | 2.1.303 (the pinned CLI) | **captured** — all three targets exit 0 on 2.1.303 | CI required gate; plan task 14 repeats it | the CLI is the oracle | structural smoke (`scripts/plugin-install-smoke.mjs`) is tier-1 and runs CLI-free on every OS |
| H02 | Exec-form hook registration: `hooks[].{type:"command",command:"node",args[]}`, no shell string, no `shell:true` | plugin-format baseline (tested at 2.1.292) | **captured** — strict validation passes on 2.1.303 (20 registrations) | `plugins/agnthive/hooks/hooks.json` | `test/hooks/fixtures/*.json` | none — structural smoke fails any regression (check 4) |
| H03 | Manifest `defaultEnabled: false` (plugin ships disabled) | plugin-format baseline | **captured** — strict pass on 2.1.303; asserted by smoke check 8 | manifest contract | `test/unit/plugin-install-smoke.test.mjs` | none |
| H04 | Manifest `userConfig` (`enforcement_mode`, `log_max_bytes`, `ledger_max_bytes`) | plugin-format baseline | **captured** — strict pass on 2.1.303; contract keys asserted by smoke check 10 | runtime reads config values with env-var overrides | `test/unit/plugin-install-smoke.test.mjs` | absent/mis-typed userConfig fails the smoke |
| H05 | No `requirements` manifest key (invented minimum-version field is forbidden) | n/a | **captured** — strict pass without it; smoke check 9 forbids reintroduction | docs-level policy only | `test/unit/plugin-install-smoke.test.mjs` | minimum-version policy lives in this document (below) |
| H06 | `PermissionDenied` event-specific envelope `hookSpecificOutput: {hookEventName:"PermissionDenied", retry:<bool>}` | docs (hooks reference) | **docs** — plugin today emits legacy shorthand `{retry:true}` (`modules/hook-output.mjs`, F05) | `handlePermissionDenied` (`hook-dispatcher.mjs`), corrected to the envelope by plan task 03 / ADR 0011 | `test/hooks/fixtures/permission_denied_*.json` (synthetic) | legacy shorthand is historically accepted but not per-version verified — keep until task 03 |
| H07 | Hook config field `onFailure` (host failure behavior) | ≥ 2.1.295 (changelog — docs) | **docs** version floor; plugin registration **not shipped yet** | planned by task 08 (ADR 0011); `hooks.json` does not register it today | none yet | without it, host-level launcher failures are invisible to the plugin; dispatcher currently swallows handler exceptions (F09) |
| H08 | Hook config field `timeout` (bounded host wait) | unknown locally | **unverified** — confirm field name and semantics on the pinned CLI before relying on it | planned by task 08 with `onFailure` | none | undefined host hang; dispatcher cannot detect a hung host |
| H09 | `UserPromptSubmit` fires when background work returns (not only on user input) | docs (hooks reference) | **unverified** | `handleUserPromptSubmit` re-classifies every delivery (F02; task 05 separates task identity from incoming message) | `user_prompt_*.json` are synthetic; no background-return fixture | treat any delivery as a possible background return; do not reset sibling counters on unproven provenance |
| H10 | User slash command arrives before prompt/skill expansion (2.1.299, changelog) | 2.1.299 (docs) | **docs** floor; routing hazard reproduced locally (F06) | `workflow.mjs` typed-command classification; namespaced `/agnthive:*` currently misses manager mode (F06) | `user_prompt_manager_feature.json`, `user_prompt_manager_plan_only.json` (synthetic) | naive text matching; foreign plugin namespaces must not trigger local roles (task 05) |
| H11 | `Stop` payload carries background-task information | docs (hooks reference) | **unverified** | background-manager detection currently uses transcript heuristics, not payload fields (F08; task 06 replaces with the task registry) | `test/hooks/fixtures/transcripts/manager_backgrounded_review.jsonl` (synthetic) | current task registry empty ⇒ no background wait; stale transcript matches must not hold the session open |
| H12 | `prompt_id` correlation between deliveries | docs (hooks reference) | **unverified** — not observed in a local payload | `state.mjs` stores `last_prompt_id` for duplicate-detection only (ADR 0010); `hook-input.mjs` does not read the field | none | never treated as message-origin proof (F02) |
| H13 | `PostCompact` is **not** a documented synchronous context-injection channel | docs (hooks reference) | **unverified** — async delivery not proven on host (F07) | `handlePostCompact` emits `additionalContext(..., "PostCompact")` (`hook-dispatcher.mjs`) | `post_compact_minimal.json`, `post_compact_manual.json` | task 07 moves ledger restoration to `SessionStart` `compact`/`resume`; PostCompact becomes bounded bookkeeping only |
| H14 | `Notification` payload field `notification_type` | docs (hooks reference) | **docs** field name; local behavior **unverified** | `notifications.mjs` stores a legacy `subtype` field today (F10) | `notification_*.json` (synthetic) | task 07 emits `notification_type` and keeps read compatibility for old logs |
| H15 | `SubagentStart`/`SubagentStop` with separate parent `transcript_path` vs subagent transcript (`agent_transcript_path`) | nested subagents ≥ 2.1.219 (changelog — docs) | **docs** floor; per-agent counters verified locally by dispatcher tests only | ADR 0010 identity model; ADR 0002/0005/0006 per-agent map ops; `transcripts.mjs` fallback | `subagent_start_*.json`, `subagent_stop_*.json`, `test/hooks/fixtures/transcripts/*.jsonl` (synthetic) | missing transcript data yields unknown, not another agent's result |
| H16 | `fork` agent type in headless runs (2.1.302, changelog) | 2.1.302 (docs) | **docs** floor; plugin handling **unverified end-to-end** | `GENERIC_TYPES` lacks `fork` today (F08); fork must not inherit agnthive footer requirements (task 06) | `subagent_stop_generic_type_passthrough.json` (covers `general-purpose` only) | unknown/fork labels get passthrough, no footer contract |
| H17 | Native `PowerShell` tool parity | unknown locally | **unverified / documented gap** | `command-policy.mjs` has PowerShell patterns but `hooks.json` matchers register `Bash` only (F09) — PowerShell commands never reach the policy | none | task 03 adds a shared shell predicate and matcher coverage; until then enforcement is documented as Bash-only |
| H18 | Background command responses (`run_in_background`): real completion/error shapes | unknown locally | **unverified** — review's `backgroundTaskId` example is synthetic (F01) | `verification.mjs` currently treats any PostToolUse Bash as non-failed; task 04 must bind outcome + completion + cwd/revision | `post_bash_*.json` (synthetic) | unknown response is never treated as passed; background launch without a completion signal requires a foreground rerun |
| H19 | `stop_hook_active` semantics (continue-after-block marker) | plugin-format baseline | plugin-side only; host cross-check **unverified** | `hook-input.mjs` reads `data.stop_hook_active` (ADR 0003 bounded retry) | fixtures in `test/hooks/` covering the flag | bounded one-cycle yield; never converts failed checks to passed |
| H20 | `claude plugin test` applies to mods only (`*.test.ts`/`*.test.tsx`), not a replacement for the Node suites | **captured** — `claude plugin test --help` | **captured**; no migration planned | none (documentation of scope) | n/a | Node `--test` suites remain the contract layer |

## Unverified rows that block further claims

Until plan tasks 02 and 14 close them, these stay marked unverified and nothing
in README/ADR text may assert them as working: H07–H14, H16, H17, H18, H19,
plus any per-version floor below 2.1.303. H06's corrected envelope (task 03)
becomes a captured row only after a host run on the pinned CLI.

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
   keys fail);
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
  changelog (docs-class evidence). Until task 08 actually registers it, the
  plugin makes no claim about that field. Other floors (2.1.299 expansion
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
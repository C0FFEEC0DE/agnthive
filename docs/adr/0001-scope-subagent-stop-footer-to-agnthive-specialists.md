# ADR 0001: Scope SubagentStop footer contract to AgntHive specialist agents

- **Status:** Accepted; specialist scoping implemented in baseline `2cd40df`. Lean replacement accepted in ADR 0009, implementation pending.
- **Decides:** SubagentStop footer enforcement applies only to recognized
  AgntHive specialist roles; generic dispatch types and unrecognized subagents
  pass through.

## Review update (2026-10-19)

The context below describes the original defect, not the current implementation.
`shouldEnforceSubagentFooter` now scopes recognized agents, but its missing-alias
fallback still enforces non-generic unknown labels. That is a remaining gap,
not a guarantee that every unidentified agent passes through.

[ADR 0009](0009-completion-evidence-over-role-quotas.md) replaces mandatory footer
gates with completion evidence in lean. During legacy compatibility, keep local
specialist scoping and correct the fallback: an unavailable alias map must not
impose local prose contracts on foreign, fork, or internal agents. See also
[ADR 0010](0010-task-and-agent-lifecycle-identity.md) for report ownership.
The old eight-role list below describes legacy, not the target inventory.

## Context

`SubagentStop` is registered with `matcher: "*"`
(`plugins/agnthive/hooks/hooks.json:133-144`) and `handleSubagentStop`
(`plugins/agnthive/modules/hook-dispatcher.mjs:341-363`) unconditionally
enforces the text footer (`Outcome:`, `Changed files:`, `Verification status:`,
`Remaining risks:`/`Next step:`) on every subagent.

Generic Task dispatch types (`general-purpose`, `workflow-subagent`) and
structured-output workflow agents return JSON without these prose prefixes, so
they are blocked and forced to retry with appended footer text — corrupting the
result the main agent receives. This contradicts the project's stated design
(`CLAUDE.md`: "Generic Task tool types (`general-purpose`, `workflow-subagent`)
are filtered from role enforcement"), but that filtering only covers role
counting (`effectiveStartedRoles`, `agents.mjs:137`), not the SubagentStop
footer contract.

**Failure mode:** A workflow StructuredOutput agent returning
`{"findings":[...]}` has no `Changed files:` line → blocked → retries with
`Outcome: ...` appended → the main agent receives the modified result instead
of clean JSON. Verified in the local trace referenced in bug report `1`.

## Decision

Enforce the SubagentStop footer contract **only** for recognized AgntHive
specialist roles. Resolve the subagent's role via `extractSubagentLabel`; if it
is not a recognized canonical AgntHive role (one of the alias-map keys), pass
through without footer enforcement. This scopes the contract to AgntHive agents
(matching the report's recommendation "ограничить footer-проверку агентами
AgntHive") and exempts generic, workflow, and unidentified agents.

## Pinned interface contract

- **`agents.mjs`** exports a new helper:
  ```js
  isAgntHiveSpecialistRole(label, aliases)
  // returns true iff `label` is a non-empty string that is a key of `aliases`
  // (i.e., a recognized canonical role: a | e | bug | dbg | t | cr | doc | m).
  ```
  `extractSubagentLabel` already returns the canonical role when matched, or
  the raw normalized label when not — so a generic type like `general-purpose`
  canonicalizes to `general-purpose`, which is not an alias key.

- **`hook-dispatcher.mjs` `handleSubagentStop`:** immediately after
  `loadStateFor`, compute `const label = extractSubagentLabel(parsed.data, ALIASES);`.
  If `!isAgntHiveSpecialistRole(label, ALIASES)` → `return passthrough();`
  **before** any footer check or the `lastMessage` lookup. Otherwise proceed
  with the existing footer enforcement, threading `agent_id` per ADR 0002.

## Consequences

Generic/workflow agents and unidentified subagents are no longer
footer-enforced, so structured output is not corrupted. Trade-off: an AgntHive
specialist that omits its `agent_type`/alias would not be footer-enforced —
acceptable because the runtime provides `agent_type` per the Claude Code
SubagentStop contract. The prompt-level handoff footer contract documented in
`CLAUDE.md` is unchanged.

## Test plan

- Unit (`test/unit/dispatcher.test.mjs`): `agent_alias: "cr"` + incomplete
  footer → block; `agent_type: "general-purpose"` → passthrough; no agent_type
  → passthrough; `agent_type: "workflow-subagent"` → passthrough;
  `agent_type: "agnthive:Code Reviewer"` → block (recognized as `cr` via
  ADR 0004).
- Hook integration: update existing subagent_stop enforcement fixtures to
  include a recognized `agent_alias` (e.g. `"cr"`) so they still block; add a
  new case `subagent_stop_passthrough_for_generic_type` with
  `agent_type: "general-purpose"` expecting passthrough (exit 0, no
  `decision: "block"` in stdout). The `subagent_stop_no_message` fixture keeps
  blocking (recognized role + no message → "No assistant summary" block).

## Files in scope

- `plugins/agnthive/modules/agents.mjs` (new export)
- `plugins/agnthive/modules/hook-dispatcher.mjs` (`handleSubagentStop` only)
- `test/unit/dispatcher.test.mjs`, `test/hooks/fixtures/subagent_stop_*.json`,
  `test/hooks/cases.json`

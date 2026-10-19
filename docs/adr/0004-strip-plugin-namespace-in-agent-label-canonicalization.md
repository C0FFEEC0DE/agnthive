# ADR 0004: Strip plugin-namespace prefix when canonicalizing agent labels

- **Status:** Accepted as narrowed by ADR 0007; implemented in baseline `2cd40df`.
- **Decides:** `canonicalizeSubagentLabel` strips the local `agnthive:` prefix
  before normalizing, so `agnthive:Explorer` → `e`.

## Review update (2026-10-19)

The arbitrary-prefix algorithm in the original decision below is superseded
by [ADR 0007](0007-namespace-prefix-is-plugin-identity.md). The shipped code
strips only `agnthive:`; a foreign `other:Explorer` must not become local `e`.
Do not implement the historical `indexOf(':')` snippet as a new change.

Namespaced agent recognition is already implemented. Namespaced slash-command
routing is a separate remaining change under
[ADR 0010](0010-task-and-agent-lifecycle-identity.md); it does not require
weakening plugin identity boundaries or treating frontmatter `type` as runtime
permission policy.

## Context

`canonicalizeSubagentLabel` (`agents.mjs:51-66`) lowercases, strips `@`,
replaces whitespace/underscore with dash, and replaces any non-`[a-z0-9.-]`
character — including the colon — with dash. So a plugin-namespaced agent type
like `agnthive:Explorer` becomes `agnthive-explorer`, which is **not** in the
alias map (`e: ["e", "explorer", "explore", "nerd"]`) and is returned as-is,
unrecognized.

If Claude Code emits plugin agent types as `<plugin>:<Agent>` (e.g.
`agnthive:Explorer`, `agnthive:Code Reviewer`), role recognition fails:
`SubagentStart` records `agnthive-explorer` instead of `e`, and workflow gates
requiring `e` would block completion even though Explorer ran. The plugin's own
agent frontmatter uses bare `type:` values (`Explore`, `Code Reviewer`,
`Plan`, …); whether the runtime namespaces them is unverified, so this is a
**latent** hardening.

**Failure mode:** A specialist agent whose type is namespaced is not recognized
→ `subagents_started` contains the wrong token →
`sessionAgentEnforcementReason` reports the role missing → completion blocked
despite the agent having run. Mechanism confirmed (bug report `1`, claim 5);
live impact depends on runtime behavior.

## Decision

In `canonicalizeSubagentLabel`, strip a leading `namespace:` prefix (everything
up to and including the first colon) before normalizing, so
`agnthive:Explorer` → `Explorer` → `explorer` → `e` and
`agnthive:Code Reviewer` → `code-reviewer` → `cr`. Safe because no alias value
or canonical role contains a colon.

## Pinned interface contract

- **`agents.mjs` `canonicalizeSubagentLabel`:** after
  `let n = String(raw).toLowerCase().replace(/^@/, '');` and **before** the
  length guard / dash normalization, add:
  ```js
  const colon = n.indexOf(':');
  if (colon >= 0) n = n.slice(colon + 1);
  ```
  Then continue the existing normalization (length guard, whitespace/underscore
  → dash, non-`[a-z0-9.-]` → dash, collapse, alias lookup).

  - Edge cases verified: `@agnthive:Explorer` → strip `@` →
    `agnthive:Explorer` → lower → `agnthive:explorer` → strip prefix →
    `explorer` → `e`. Bare `Explore` (no colon) → unchanged → `explore` → `e`.
    `code-reviewer` (no colon) → unchanged → `code-reviewer` → `cr`.
    `general-purpose` (no colon) → unchanged → `general-purpose` (not a role).
    `workflow-subagent` → unchanged → `workflow-subagent` (not a role).

## Consequences

Namespaced plugin agent types are recognized. Bare types still work. No
`aliases.json` changes required. This also unblocks ADR 0001's test case
(`agent_type: "agnthive:Code Reviewer"` → recognized as `cr` → block).

## Test plan

- Unit (`test/unit/agents.test.mjs`):
  `canonicalizeSubagentLabel('agnthive:Explorer', aliases) === 'e'`;
  `('agnthive:Code Reviewer') === 'cr'`; `('agnthive:architect') === 'a'`;
  `('AGNTHIVE:Tester') === 't'`; `('@agnthive:Manager') === 'm'`; bare unchanged:
  `('Explorer') === 'e'`, `('Code Reviewer') === 'cr'`,
  `('general-purpose') === 'general-purpose'`,
  `('workflow-subagent') === 'workflow-subagent'`.

## Files in scope

- `plugins/agnthive/modules/agents.mjs` (`canonicalizeSubagentLabel` only)
- `test/unit/agents.test.mjs`

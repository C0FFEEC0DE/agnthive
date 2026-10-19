# ADR 0007: The `agnthive:` namespace prefix is plugin identity, not config

- **Status:** Accepted; fixed-prefix behavior present in baseline `2cd40df`. Repository documentation is the durable rename record.
- **Decides:** The `agnthive:` prefix stripped by
  `canonicalizeSubagentLabel` is fixed plugin identity; it is not configurable
  and must be updated alongside the other plugin metadata surfaces on a rename.

## Review update (2026-10-19)

Retained: only the local plugin prefix is stripped. This ADR narrows the broad
algorithm originally written in ADR 0004. The repository is the durable source
of the rename obligation; no external/private memory note is required to
understand or implement it. Historical references below to writing such a note
are optional supporting practice, not an outstanding runtime requirement.

A rename must update manifest/marketplace/package identity, canonicalization,
documented commands, and identity fixtures together. Apply the same boundary
to command routing under [ADR 0010](0010-task-and-agent-lifecycle-identity.md).

## Context

ADR-0004 narrowed the namespace strip in `canonicalizeSubagentLabel`
(`agents.mjs`) to only the `agnthive:` prefix, so foreign namespaces
(`mcp:tester`, `workflow:docs`) are no longer misrecognized as AgntHive
specialists. The prefix is hardcoded:

```js
if (n.startsWith('agnthive:')) n = n.slice('agnthive:'.length);
```

The repository already tracks plugin-metadata consistency across
`plugin.json`, `marketplace.json`, `package.json`, the README value prop, the
GitHub repo description, the agent/slash-command inventories, and the install
commands (see the project memory index). The `agnthive:` literal is a further
rename-drift point: if the plugin is ever renamed, this literal must change too,
but it is not covered by the existing sync memories.

**Failure mode:** a plugin rename that updates `plugin.json`/`marketplace.json`
but not this literal would silently stop recognizing namespaced specialist types
(`agnthive:Code Reviewer` would no longer canonicalize to `cr`), re-introducing
the ADR-0001 footer-scope gap for namespaced types — with no test failing,
because the existing tests use the current `agnthive:` spelling.

## Decision

Record that the `agnthive:` prefix is plugin identity (it matches the plugin
name in `plugin.json` / `marketplace.json` / `package.json` and the install
commands), not a tunable. Keep it hardcoded (deriving it from plugin metadata at
runtime would read a constant string — over-engineering; adding it to
`aliases.json` would imply it varies per install, which it cannot). Close the
sync-tracking gap with a memory note so a future rename updates this literal
alongside the other metadata surfaces.

## Pinned interface contract

- **`agents.mjs` `canonicalizeSubagentLabel`:** unchanged — keeps
  `if (n.startsWith('agnthive:')) n = n.slice('agnthive:'.length);`. The prefix
  is documented as plugin identity tied to the metadata surfaces.
- **Memory:** a `reference`/`project` memory note records that the `agnthive:`
  literal in `canonicalizeSubagentLabel` is part of the plugin-metadata sync
  set and must be updated on rename.

## Consequences

No code change. The rename-drift risk is made explicit and tracked. A future
plugin rename now has a documented obligation to update the namespace literal.

## Test plan

- No new tests (no behavior change). The existing ADR-0004 canonicalization
  tests pin the current `agnthive:` spelling.

## Files in scope

- `docs/adr/0007-namespace-prefix-is-plugin-identity.md` (this file)
- Project memory (`agent-inventory-sync` / a new namespace-sync note)

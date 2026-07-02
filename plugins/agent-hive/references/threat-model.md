# Plugin threat model

A focused, honest threat model for the
`agent-hive` Claude Code plugin. It covers what the plugin's Node.js
hook runtime does, the boundaries it enforces, and the risks that remain. It is
written for a reviewer, not for marketing: where a guarantee is bounded, the
bound is stated.

The runtime lives under `modules/` and is invoked by `hooks/hooks.json`. The
manifest is `.claude-plugin/plugin.json`.

## Trust boundary

The hook runtime executes as the user, with the user's privileges, whenever
Claude Code fires a hook event. The command policy (`modules/command-policy.mjs`)
is a **static command-string inspector** and a **defense-in-depth** layer — it is
not a sandbox. It cannot see the runtime environment, the working directory, file
contents, shell variable resolution, or what a command will actually do after it
runs. Its guarantees are bounded by what a static string inspection of
`tool_input.command` can establish. State this explicitly when reasoning about any
finding: the policy reduces the chance that an agent runs a destructive command;
it does not make destructive execution impossible.

This is the same posture documented in
[command policy](command-policy.md) §1 ("a safety net, not a
sandbox") and the repo-root [`SECURITY.md`](../SECURITY.md).

## Threats and mitigations

### T1. Command-policy bypass (shell dialect parsing limits)

The command policy normalizes the command string (lowercase, collapse whitespace,
strip `"`, `'`, `\`) and matches anchored regular expressions over
whitespace-delimited tokens. It is **not** a shell parser. The supported syntax and
the fail-closed `enforce` behavior are explicit in
[command policy](command-policy.md) §4–§5.

Documented, accepted limitations (hold in both modes):

- No shell-grammar parsing. Quoting/escaping/tokenization are approximated by
  normalization, not modeled. The corpus at
  `test/security/command-policy.corpus.mjs` pins the exact behavior.
- No homoglyph normalization. A Cyrillic lookalike of `sudo` is not the ASCII verb
  and is not denied.
- No environment or working-directory awareness. `rm -rf build` is allowed even if
  `build` is a symlink to `/`; the policy cannot resolve it.
- Bare-path shells (`curl … | /bin/bash`) are not matched by the pipe-shell
  heuristic; only `| sh|bash|zsh|dash|ksh` (optionally behind `env`/`sudo`) is.

Mode-dependent behavior:

- **`advisory` (default)** — fail-open on the unknown. A command whose real target
  cannot be statically determined (indirection: command substitution, `eval` of a
  variable, decoded payloads, variable-only commands) is **allowed**.
- **`enforce`** — fail-closed on the unparseable. The same indirection is **denied
  with an explanation**. This is the hardened-mode contract; set
  `CLAUDE_CREW_POLICY=enforce` only in hardened contexts.

The one hard rule that holds in both modes: a command the policy identifies as
dangerous is always denied. Mode only changes what happens to commands it cannot
classify. See [command policy](command-policy.md) §3.

### T2. Hook exec form integrity (injection resistance)

Every hook registration in `hooks/hooks.json` uses exec form: `"command": "node"`
with a non-empty `args` array. There is **no shell string** and no `shell: true`.
This matters because a shell-string hook would let a crafted path or value reach a
shell interpreter; exec form passes an explicit argv to `node` with no
intermediary shell, so spaces in paths and `${CLAUDE_PLUGIN_ROOT}` expansion are
handled as literal arguments, not shell tokens.

The structural guarantee is enforced by
`scripts/plugin-install-smoke.mjs` (Check 4), which validates the **packaged**
plugin layout — not the source tree — and fails if any hook entry:

- is not `type: "command"`,
- does not use `command: "node"`,
- lacks a non-empty `args` array,
- sets `shell: true`, or
- has a `command` string containing shell metacharacters (`; & | < > \` $ \n`).

The release workflow (`docs/release.md`, "Test-the-exact-artifact") re-runs this
validator against the unpacked release artifact, so a regression that slipped into
a tagged commit is caught before the GitHub Release is created.

### T3. Path resolution / `${CLAUDE_PLUGIN_ROOT}` expansion

`${CLAUDE_PLUGIN_ROOT}` expands to the plugin's installed root. Every hook target
in `hooks.json` is `${CLAUDE_PLUGIN_ROOT}/modules/hook-dispatcher.mjs`, so hook
execution always resolves inside the plugin directory. The
`plugin-install-smoke.mjs` validator (Check 2) resolves every
`${CLAUDE_PLUGIN_ROOT}/...` reference against the packaged dir and fails if any
target does not exist inside it.

The runtime writes state only under `${CLAUDE_PLUGIN_DATA}` (per-plugin data root)
or project-provided paths (the progress ledger under `<projectDir>/.claude-crew/`,
controlled by `CLAUDE_CREW_PROGRESS_FILE`). It does **not** write into
`${CLAUDE_PLUGIN_ROOT}` or outside the paths hooks are explicitly given. This is
the public compatibility policy recorded in
`docs/specs/claude-code-plugin-node-migration.md` ("State location"): "Mutable
installation roots are forbidden."

### T4. Telemetry / log injection

Telemetry is append-only JSONL under `${CLAUDE_PLUGIN_DATA}/logs`. Each payload is
built from a **fixed field whitelist** (session id, cwd, transcript path, reason,
title, message, subtype, etc.) and serialized with `JSON.stringify`, which escapes
quotes, backslashes, and control characters — so a crafted field value cannot
break out of its JSON field or inject another record. Each stream rotates to
`<name>.old` at `CLAUDE_CREW_LOG_MAX_BYTES` (1 MiB default), so no stream grows
unbounded.

**What is never logged:** no credentials, no full environment variables, and no
prompt or transcript contents. Only the explicitly-listed hook fields are recorded.
The streams are: `notification.jsonl`, `session-index.jsonl`, `pre-compact.jsonl`,
`post-compact.jsonl`, `config-change.jsonl`, `instructions-loaded.jsonl` (see the
plugin README, "Privacy & telemetry").

### T5. Network / privacy

The runtime makes **no network calls** and sends **nothing** off the local machine.
All state is local under `${CLAUDE_PLUGIN_DATA}` or project-provided paths. This
was verified by scanning `plugins/agent-hive/modules/` and `scripts/`
for network primitives: no `fetch`, `http`/`https`/`net`/`dns`/`undici` imports, no
`child_process` usage in the runtime (the only `child_process` reference is in the
off-runtime `plugin-install-smoke.mjs` validator, which uses `spawnSync` with an
explicit argv for `node --check` — no shell). The `modules/*.mjs` files carry
inline comments stating "Node standard library only: no child_process.exec, no
shell:true, no interpolated command strings."

### T6. Global config takeover

The plugin never reads or writes `~/.claude/settings.json`. All configuration is
environment variables and the plugin-scoped `userConfig`
(`enforcement_mode` in `plugin.json`). The statusline is opt-in via the plugin's
own `statusLine` setting, not the global status line. The plugin's
`settings.json` (if present) supports only the `agent` and `subagentStatusLine`
keys — it cannot auto-install the profile's global permissions, sandbox,
auto-execution, output style, or main status line. This is the plugin/settings
boundary recorded in `docs/specs/claude-code-plugin-node-migration.md` ("Plugin /
settings boundary") and the plugin README ("Settings limitations"). The legacy
copied-`~/.claude` profile did mutate global config in place; the plugin does not.

### T7. Supply chain

- **No runtime `npm install`.** The runtime ships as committed ES modules under
  `modules/` and uses the Node standard library only — no Bash, Python, `jq`, or
  GNU/coreutils dependency. Marketplace distribution copies the plugin directory
  with no install-time build step.
- **No npm publication.** Distribution is source-repository-based; the release flow
  is tag-only (`docs/release.md`). npm provenance (sigstore) is N/A.
- **SBOM.** An SPDX JSON SBOM is generated with Syft
  (`anchore/sbom-action@v0`) scanning the unpacked release artifact and is attached
  to the GitHub Release (`docs/release.md`, "SBOM attachment").
- **CI controls** present in `.github/`: `codeql.yml` (CodeQL JS/TS), 
  `dependency-review.yml` (dependency-review on PRs), `dependabot.yml`, and
  `security-scan.yml`. The release workflow uses minimal token permissions
  (`contents: write` for release creation, `id-token: write` reserved for future
  signing) and `--verify-tag` to catch accidental tag movement.
- **Legacy runtime exclusion.** `scripts/plugin-install-smoke.mjs` (Check 3) and
  `scripts/check-no-legacy-runtime.mjs` fail if any `.py`/`.sh` file appears in the
  packaged plugin runtime, so a Bash/Python regression cannot silently return.

## Residual risks

- **Node availability on PATH.** A native Claude Code installation may not place
  Node on `PATH`. The dispatcher preflights `node --version` and, on failure, writes
  an actionable install hint to stderr plus a non-blocking `additionalContext`
  message; it never fails silently. But a missing Node still means hooks do not
  run, so the gates are only as good as Node being present. See the README
  "Troubleshooting" and `docs/specs/claude-code-plugin-node-migration.md`
  ("Runtime prerequisite").
- **Marketplace review is external.** Approval and catalog sync for the Anthropic
  community marketplace are external steps outside this repository's control. Beta
  distribution through the repository marketplace remains available while
  community review is pending.
- **Command inspection is not execution isolation.** Even in `enforce` mode, the
  policy cannot see what a command does after it starts, resolve symlinks, or
  inspect file contents. It is a safety net layered on the user's existing Claude
  Code permission flow, not a replacement for that flow or for host-level
  controls.
- **Security parser scope.** It is impossible to perfectly interpret every
  arbitrary shell dialect from a command string. The supported syntax and
  fail-closed behavior are explicit (T1); novel obfuscation that defeats static
  inspection is an accepted, documented risk.

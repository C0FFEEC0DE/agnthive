# Security Policy

## Supported versions

Only the latest release of this plugin is supported with security fixes. The
version is declared in `.claude-plugin/plugin.json` and mirrored in `package.json`.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Use GitHub's private vulnerability reporting ("Report a vulnerability" under the
repository's Security tab), or email the maintainer directly. Include:

- a description of the issue and its impact
- steps to reproduce
- the affected file or hook path, if known (paths under `modules/` or
  `hooks/hooks.json` are the most useful)

You should receive an initial response within 72 hours. Please allow reasonable
time for a fix before public disclosure.

This reporting path and the 72-hour initial-response target are consistent with the
repository-root [`SECURITY.md`](https://github.com/C0FFEEC0DE/agent-hive/blob/main/SECURITY.md).

## Scope

This plugin is a Claude Code **hook-gated SDLC profile** (hooks, agents, skills, a
Node.js hook runtime, and a static command policy). Security-relevant issues
include:

- **hook bypasses** that let a blocked dangerous command execute
- **circumventable `deny` rules** — commands the policy should block but does not
- **world-readable logs** — sensitive data written to telemetry streams under
  `${CLAUDE_PLUGIN_DATA}/logs` that are readable by other users
- **command-policy bypasses** that defeat the static command-string inspection
- **path escape** — the plugin writing outside `${CLAUDE_PLUGIN_DATA}` or the
  project-provided paths it is given
- **global config takeover** — the plugin writing `~/.claude/settings.json`

Out of scope: the behavior of the Claude Code runtime itself, and any model or
third-party provider routed through the profile.

## Hardening defaults

The plugin ships defense-in-depth controls. See the plugin README ("Configuration"
and "Privacy & telemetry") and the repository
[`references/threat-model.md`](references/threat-model.md)
for how they fit together:

- The command policy (`modules/command-policy.mjs`) blocks destructive, privileged,
  and remote-bootstrap commands. It runs in `advisory` mode by default (fail-open on
  the unknown) or `enforce` mode (fail-closed on unparseable input) — set via the
  plugin's `enforcement_mode` user config or `CLAUDE_CREW_POLICY`.
- Every hook uses exec form (`command: "node"` + `args` array, no `shell: true`), so
  crafted paths cannot reach a shell interpreter.
- The runtime makes **no network calls** and sends nothing off the local machine.
- Telemetry JSONL streams rotate at 1 MiB and are built from a fixed field
  whitelist; no credentials, full environment variables, or prompt/transcript
  contents are logged.
- The plugin never writes `~/.claude/settings.json`; the statusline is opt-in via
  plugin-scoped config only.
- Release/deploy automation is intentionally disabled.

## Portable command-policy limitations

The plugin's `PreToolUse` / `PermissionRequest` / `PermissionDenied` hooks classify
a Bash command string with a portable, Node-stdlib-only policy. It is a static
string inspector, **not** a shell parser, so the following are accepted limitations
(documented, not silently "fixed"). See
[`references/command-policy.md`](references/command-policy.md)
for the full contract.

- **No shell-grammar parsing.** Quoting/escaping/tokenization are approximated by
  normalization (lowercase, collapse whitespace, strip `"`, `'`, `\`).
- **Homoglyphs.** A Cyrillic lookalike of `sudo` is not the ASCII verb and is not
  denied. Aggressive Unicode normalization can itself mask real commands.
- **Bare-path shells.** `curl … | /bin/bash` (a path, not a bare shell name) is not
  matched by the pipe-shell heuristic; only `| sh|bash|zsh|dash|ksh` (optionally
  behind a known arg-passer like `env`/`sudo`) is.
- **No environment or working-directory awareness.** `rm -rf build` is allowed even
  if `build` is a symlink to `/`; the policy cannot resolve it.
- **Enforce mode fails closed on substitution-wrapping-a-variable.** In `enforce`
  mode, `echo $(foo $bar)` is denied as unparseable even though it may be benign —
  fail-closed is the hardened-mode contract. Advisory (default) mode allows it.

The narrow catastrophic-target rule is intentional: recursive force-delete is
blocked only for standalone `/`, `~`, `$home`, `${home}`, `.`, `..`, or a bare
Windows drive root. Named paths (`/etc`, `~/foo`, `build/`, `*`) are allowed so
legitimate cleanup is not blocked.

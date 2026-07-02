# Security Policy

## Supported versions

Only the latest `main` branch of this repository is supported with security fixes.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Email the maintainer directly, or use GitHub's private vulnerability reporting
("Report a vulnerability" under the Security tab). Include:

- a description of the issue and its impact
- steps to reproduce
- the affected file or hook path, if known

You should receive an initial response within 72 hours. Please allow reasonable
time for a fix before public disclosure.

## Scope

This project is a Claude Code **configuration profile** (hooks, agents, settings).
Security-relevant issues include:

- hook bypasses that allow a blocked dangerous command to execute
- permission `deny` rules that can be circumvented
- secret/credential leakage in committed files
- hook scripts that write sensitive data to world-readable logs

Out of scope: the behavior of the Claude Code runtime itself, and any model or
third-party provider routed through the profile.

## Hardening defaults

The profile ships defense-in-depth controls; see [`plugin architecture`](plugins/agent-hive/references/architecture.md)
and [`token-cost notes`](plugins/agent-hive/references/token-cost.md) for how they fit together:

- `permissions.deny` blocks `sudo`, `mkfs`, `dd`, `rm -rf /`, `rm -rf ~`,
  `git push --force`, and reads of `.env*`, `secrets/**`, `credentials/**`
- `PreToolUse` / `PermissionRequest` hooks block dangerous and out-of-scope commands
- release/deploy automation is intentionally disabled
- hook JSONL logs rotate past 1 MB to bound growth
- an optional local pre-push secret-scan hook can be installed per-repo with
  `node scripts/install-git-hooks.mjs` (the authoritative scan is TruffleHog in CI)

## Portable command-policy limitations (Node hook runtime)

The plugin's `PreToolUse` / `PermissionRequest` / `PermissionDenied` hooks
classify a Bash command string with a portable, Node-stdlib-only policy
([`command policy`](plugins/agent-hive/references/command-policy.md)). It is a
static string inspector, **not** a shell parser, so the following are accepted
limitations (documented, not silently "fixed"):

- **No shell-grammar parsing.** Quoting/escaping/tokenization are approximated
  by normalization (lowercase, collapse whitespace, strip `"`, `'`, `\`).
- **Homoglyphs.** A Cyrillic lookalike of `sudo` is not the ASCII verb and is
  not denied. Aggressive Unicode normalization can itself mask real commands.
- **Bare-path shells.** `curl … | /bin/bash` (a path, not a bare shell name) is
  not matched by the pipe-shell heuristic; only `| sh|bash|zsh|dash|ksh` (optionally
  behind a known arg-passer like `env`/`sudo`) is.
- **Windows named paths escape the catastrophic-target rule** because
  normalization strips `\`, so `C:\Foo` → `c:foo` (not a bare drive). Only a
  bare `C:` / drive root is treated as destructive; named Windows paths are
  allowed (narrow targeting, matching the legacy bash policy).
- **Enforce mode fails closed on substitution-wrapping-a-variable.** In
  `enforce` mode, `echo $(foo $bar)` is denied as unparseable even though it
  may be benign — fail-closed is the hardened-mode contract. Advisory (default)
  mode allows it. Set `CLAUDE_CREW_POLICY=enforce` only in hardened contexts.

The narrow catastrophic-target rule is intentional: recursive force-delete is
blocked only for standalone `/`, `~`, `$home`, `${home}`, `.`, `..`, or a bare
Windows drive root. Named paths (`/etc`, `~/foo`, `build/`, `*`) are allowed so
legitimate cleanup is not blocked. `/` and drive roots report `destructive`;
`~`/`$home`/`${home}`/`.`/`..` report `home or current directory`.

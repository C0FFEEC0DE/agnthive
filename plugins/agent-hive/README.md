# Agent Hive

A **hook-gated SDLC profile for Claude Code**, packaged as a distributable
plugin. The Node.js hook runtime enforces a `discover → design → implement →
verify → review → docs` workflow, specialist-role contracts, and a stop/handoff
footer contract so multi-agent sessions stay deterministic. Where benchmarks
need a visible role-usage marker, they also recognize explicit
`Handoff evidence: @alias ...` transcript lines. A static command
policy adds defense-in-depth blocking of destructive, privileged, and
remote-bootstrap commands. Everything runs in the plugin's Node 22+ runtime —
no Bash, Python, jq, or GNU/coreutils dependencies, so it works the same on
Linux, macOS, and Windows.

## Requirements

- **Claude Code** with plugin support.
- **Node.js 22 or newer** on your `PATH` (the runtime invokes hooks as
  `node …module.mjs`).

## Installation

Two paths.

**(a) From the community marketplace** (once published):

```bash
claude plugin marketplace add C0FFEEC0DE/agent-hive
claude plugin install agent-hive@C0FFEEC0DE
```

**(b) Local / dev install** from a checkout of this repository:

```bash
# add this repo as a local marketplace, then install the plugin
claude plugin marketplace add /path/to/agent-hive
claude plugin install agent-hive@C0FFEEC0DE

# or load the plugin directory directly for development
claude --plugin-dir /path/to/agent-hive/plugins/agent-hive
```

Restart Claude Code after installing. The marketplace name (`C0FFEEC0DE`) is the
publisher identifier declared in `.claude-plugin/plugin.json`.

## Update

```bash
claude plugin update agent-hive@C0FFEEC0DE
```

If you installed from a local marketplace, re-run the install command you used
in [Installation](#installation) after pulling the latest source. Claude Code
reloads the plugin from the updated marketplace cache. There is no in-place
patch — the marketplace copy is replaced wholesale, so the runtime you run is
always the published tree.

## Configuration

All configuration is **environment variables and the plugin-scoped
`userConfig`**. The plugin never reads or writes `~/.claude/settings.json`, so
installation is non-destructive and nothing leaks into your global config.

### Command policy mode (`userConfig.enforcement_mode` / `CLAUDE_CREW_POLICY`)

The command policy has two modes. Set it through the plugin's
`enforcement_mode` user config (default `advisory`) or override with the
`CLAUDE_CREW_POLICY` env var. See [`references/command-policy.md`](references/command-policy.md) for the full
contract.

| Knob | Default | Effect |
|---|---|---|
| `CLAUDE_CREW_POLICY` | `advisory` | `advisory` denies known-dangerous commands and allows commands whose real target cannot be statically determined (fail-open on the unknown). `enforce` also denies unparseable indirection with an explanation (fail-closed). A command identified as dangerous is always denied in both modes. Any value other than `enforce` is treated as `advisory` by the runtime. |

### Log rotation and ledger size

| Knob | Default | Effect |
|---|---|---|
| `CLAUDE_CREW_LOG_MAX_BYTES` | `1048576` (1 MiB) | A telemetry JSONL stream is rotated to `<name>.old` when it reaches this many bytes, so no stream grows unbounded. Invalid/non-numeric values fall back to the default. |
| `CLAUDE_CREW_LEDGER_MAX_BYTES` | `65536` (64 KiB) | Byte cap on the durable progress ledger re-injected after context compaction. Truncation is UTF-8 safe (a cut inside a multibyte sequence drops the partial sequence rather than emitting invalid UTF-8). Invalid/non-numeric values fall back to the default. |
| `CLAUDE_CREW_PROGRESS_FILE` | unset | Overrides the progress-ledger location. By default the ledger lives at `<projectDir>/.claude-crew/progress.md` (gitignored scratch, never committed). |

### Paths provided by the Claude Code runtime

These are set by the runtime, not by the user. They are documented here so you
can reason about where state lands when you run hooks directly (for debugging).

| Variable | Meaning |
|---|---|
| `CLAUDE_PLUGIN_DATA` | Per-plugin data root. All hook state and logs write under here. Falls back to `~/.claude/plugins/data/agent-hive` when unset. |
| `CLAUDE_PROJECT_DIR` | The project directory the hook is running in. Falls back to the hook's cwd. |
| `CLAUDE_PLUGIN_ROOT` | The plugin root, used to locate bundled assets. Falls back to the module's own directory. |

## Optional status line

The plugin ships a Node status-line helper at
`scripts/statusline.mjs`. It reads one JSON object from stdin (the Claude Code
status-line payload) and prints one line:

```
<cwd basename> | <model display name> | <output style>
```

To opt in, set the plugin's `statusLine` setting in your plugin-scoped config
(not your global `~/.claude/settings.json`). The script uses the Node standard
library only — no subprocess spawning, no shell, no reads of arbitrary user
files.

## Settings limitations

The plugin scopes itself and never touches your global config:

- **It never reads or writes `~/.claude/settings.json`.** Installation is
  non-destructive — nothing is added to or restored from your global settings.
  This is the explicit difference from the legacy copied-`~/.claude` profile,
  which mutated `~/.claude` in place (see [Legacy migration](#legacy-migration)).
- **All configuration is environment variables and the plugin-scoped
  `userConfig`.** The only `userConfig` key is `enforcement_mode`
  (see [Command policy mode](#command-policy-mode-userconfigenforcement_mode--claude_crew_policy)).
  The plugin's own `settings.json`, if present, supports only the `agent` and
  `subagentStatusLine` keys — it cannot install the profile's global
  permissions, sandbox, auto-execution, output style, or main status line.
- **The statusline is opt-in via plugin-scoped config only.** The plugin does
  not set your global status line; you must enable the bundled
  `scripts/statusline.mjs` through the plugin's `statusLine` setting.

## Privacy & telemetry

The runtime appends structured JSONL records under `${CLAUDE_PLUGIN_DATA}/logs`
and rotates each stream at 1 MiB (`CLAUDE_CREW_LOG_MAX_BYTES`). The streams are:

- `notification.jsonl` — runtime notification events (title, message, subtype, context).
- `session-index.jsonl` — session-end index entries (session id, cwd, transcript path, reason, state snapshot).
- `pre-compact.jsonl` / `post-compact.jsonl` — compaction markers (session id, trigger, state/summary).
- `config-change.jsonl` — config-change audit records (session id, source, file path).
- `instructions-loaded.jsonl` — memory/instructions load audit (session id, file path, memory type, load reason).

Each payload is built from a **fixed field whitelist** and serialized with
`JSON.stringify`, which escapes quotes, backslashes, and control characters.

**What is never logged:** no credentials, no full environment variables, and no
prompt or transcript contents. Only the explicitly-listed hook fields above are
recorded. All writes stay inside `${CLAUDE_PLUGIN_DATA}` or project-provided
paths (the progress ledger).

**No network calls.** The runtime makes no network calls and sends nothing off
the local machine — all state is local under `${CLAUDE_PLUGIN_DATA}` or
project-provided paths. The `modules/*.mjs` runtime imports only the Node
standard library (no `fetch`, `http`/`https`, or `child_process`), verified by
scanning the shipped modules.

## Disable

To stop the hooks from running without removing the plugin:

```bash
claude plugin disable agent-hive@C0FFEEC0DE
```

Disabled plugins stay installed but their hooks no longer fire, so the
workflow gates and footer contracts go quiet until you re-enable:

```bash
claude plugin enable agent-hive@C0FFEEC0DE
```

Use this when you want a vanilla Claude Code session in a project that has the
plugin loaded. For a full removal, see [Uninstallation](#uninstallation).

## Uninstallation

```bash
claude plugin uninstall agent-hive@C0FFEEC0DE
claude plugin marketplace remove C0FFEEC0DE   # if you no longer want the marketplace
```

Because the plugin never touched `~/.claude/settings.json`, there is nothing to
restore there. Confirm with:

```bash
claude plugin list   # agent-hive should no longer appear
```

Only plugin-scoped data under `${CLAUDE_PLUGIN_DATA}` (logs and session state)
remains on disk; remove that directory manually if you want a full clean sweep.

## Legacy migration

If you previously used the **old copied-into-`~/.claude` profile** (the
`claudecfg/` layout installed via `./install.sh`), migrate as follows.

1. Remove the old profile's entries from `~/.claude/`: the `hooks/`, `agents/`,
   and `skills/` directories (and any `settings.json` keys) that came from this
   profile. The old installer copied these directly into `~/.claude` and
   mutated your global config — be honest about that: **the old profile
   modified `~/.claude` in place, the plugin does not.**
2. Install the plugin as described above.
3. The hook-gated behavior (workflow gates, footer/role/verification contracts,
   command policy, telemetry) now comes from the plugin, scoped to sessions
   that load it.

If you relied on the old `statusline.sh`, switch to the plugin's
`scripts/statusline.mjs` via the plugin's `statusLine` setting.

## Troubleshooting

- **Hooks are not firing.** Confirm Node 22+ is on your `PATH`
  (`node --version`) and that the plugin is enabled (`claude plugin list`). The
  runtime invokes hooks as `node`; an older or missing Node will silently skip
  them.
- **Enforce mode is denying legitimate commands.** Switch back to `advisory`
  (the default) by setting `enforcement_mode` to `advisory` or unsetting
  `CLAUDE_CREW_POLICY`. Enforce fails closed on commands whose real target
  cannot be statically resolved; advisory allows them.
- **Where are the logs?** Under `${CLAUDE_PLUGIN_DATA}/logs` (default
  `~/.claude/plugins/data/agent-hive/logs`). Each stream rotates to
  `<name>.old` at 1 MiB.
- **Progress ledger not surviving compaction.** Check
  `CLAUDE_CREW_PROGRESS_FILE` and that `<projectDir>/.claude-crew/progress.md`
  is writable. The ledger is capped at `CLAUDE_CREW_LEDGER_MAX_BYTES` (64 KiB
  default); larger ledgers are UTF-8-safe truncated with a note.

## Support & security reporting

- **Bugs and feature requests:** open an issue at
  <https://github.com/C0FFEEC0DE/agent-hive/issues>.
- **Security vulnerabilities:** do **not** open a public issue. Report
  privately via GitHub's "Report a vulnerability" option under the repository's
  Security tab, or email the maintainer directly (see `SECURITY.md` for the
  responsible-disclosure address and the 72-hour initial-response target).
  Security-relevant issues include hook bypasses that let a blocked command
  execute, circumventable `deny` rules, and any sensitive data written to
  world-readable logs.

## License

MIT, matching `.claude-plugin/plugin.json`.

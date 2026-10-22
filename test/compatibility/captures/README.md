# Live host canary captures (CLI 2.1.303)

Redacted evidence of the host canary run on **2026-10-21** against the pinned
CLI **2.1.303** (`claude --version` → `2.1.303 (Claude Code)`) with the local
ollama provider (`ANTHROPIC_BASE_URL=http://127.0.0.1:11434`, model
`glm-5.2:cloud`).

## How these were captured

The plugin was loaded from an **instrumented copy** in `/tmp` (the repository
tree `plugins/agnthive/` was never modified). The copy's `hooks/hooks.json`
registers a wrapper instead of the dispatcher; the wrapper tees the **raw hook
stdin** to a file and then re-runs the unmodified dispatcher with the same
stdin, so the hook behaviour of the session is the shipped behaviour. The
session was enabled with `--plugin-dir <copy> --settings <file>` where the
settings file carries `{"enabledPlugins": {"agnthive@inline": true}}` — without
it the host registers zero hooks from the plugin.

Each `*.stdin.json` file is the **observed** hook stdin, redacted:

- session ids, prompt ids, agent ids, tool-use ids and background task ids are
  replaced by synthetic placeholders (`compat-capture-*`);
- every path of the canary machine is replaced by `/tmp/compat-capture/...`;
- free text (assistant messages, command output, denial reasons) is truncated.

The field set, the field order and the value types are the host's, unchanged.

Each `*.runtime-answer.json` file is the **answer the plugin runtime produced
in that live session** for the payload next to it.

## What is here and what is not

`index.json` lists every capture in this directory. These files back the
manifest entries that stay `pending_capture`: their **input** was observed
live, but the documented output class cannot be asserted from the payload
alone, because the live answer depends on session state that the stateless
contract probe (`test/compatibility/contract.test.mjs`) does not have. The
reason is recorded per entry in `test/compatibility/manifest.json`
(`capture_blocked_reason`) and summarised in `docs/compatibility.md`.

The scenarios whose input shape **and** output class were both reproduced are
stored as the manifest's own fixtures under `../payloads/` with
`source: "captured"`.

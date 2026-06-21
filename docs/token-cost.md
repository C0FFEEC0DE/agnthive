# Token-cost optimization

This profile is built to spend as few tokens as possible while staying correct.
Six concrete levers do the work. Each is tied to the file that implements it, so
"how" and "where" are never separate.

## The six levers

### 1. Context minimization

Keep what enters the model small by default.

- `CLAUDE.md` is kept short and project-context-only — no narrative, no
  redundant rules, so it stays cheap to load every session.
- `claudecfg/GUIDE.md` enforces a **search discipline**: targeted search or file
  listing first, read ranges not whole files, reuse reads already in the
  session. (`GUIDE.md` → *Search Discipline*, *Planning*.)
- Agent prompts are short and role-focused (each `claudecfg/agents/*.md` is
  well under the 150-line budget in `CONTRIBUTING.md`).

Small inputs → small contexts → cheaper every turn.

### 2. Deterministic handoff contract

Instead of freeform prose summaries, every subagent handoff uses fixed line
prefixes:

```text
Outcome: ...
Changed files: ... | No files changed: ...
Verification status: ...
Remaining risks: ... | Next step: ...
```

Predictable shape means short, parseable summaries — no token-hungry
narrative. Enforced by `claudecfg/hooks/subagent-stop-guard.sh` and
`stop-guard.sh`; documented in `claudecfg/GUIDE.md` → *Standard Output*.

### 3. Policy-stall break

If the stop gate blocks the same summary three times in a row,
`stop-guard.sh` emits a terminal `continue: false` response without `decision: "block"` — the runtime signal to stop retrying.
Without it, a stuck session would loop forever, burning tokens on identical
summaries. Implemented in `claudecfg/hooks/lib.sh` (`emit_loop_aware_block`,
`record_loop_block`) and `stop-guard.sh`.

### 4. Subagent fan-out

Broad work goes to short-context specialists (e.g. parallel Explore agents)
rather than one giant main context. Each specialist owns a narrow scope and
returns a compact conclusion. The main loop keeps only the conclusions, not the
search. See `claudecfg/agents/` and the agent table in `README.md`.

### 5. Off-critical-path logging

`Notification`, `PreCompact`, `PostCompact`, `SessionEnd`, and `ConfigChange`
hooks run `async:true` in `claudecfg/settings.json` — they never block the
model's response. Their JSONL output rotates past 1 MB
(`claudecfg/hooks/lib.sh` → `rotate_jsonl_if_needed`), so observability doesn't
become unbounded disk or context drag.

### 6. Output caps and knobs

- Benchmarks cap output at `CLAUDE_CODE_MAX_OUTPUT_TOKENS=768` (`Makefile`).
- `effortLevel` in `claudecfg/settings.json` defaults to `medium` — lower spend.
  Raise to `high` only for hard design/verify/judge stages.
- No model is pinned; your runtime default applies, so you control cost per
  model.

## Tuning spend

| Want | Set |
|---|---|
| Lowest spend (advisory work, small fixes) | `effortLevel: medium`, default model, tight `CLAUDE_CODE_MAX_OUTPUT_TOKENS` |
| Hard verify / design / multi-file review | `effortLevel: high` for that turn only, then back to `medium` |
| Benchmarks | `make bench-mock` (no model, no spend) for shape; `make bench-smoke` with a chosen `OLLAMA_MODEL` for behavior |

## What this does *not* do

- It does not cache prompts for you (prompt caching is a runtime/provider
  feature). It does keep sections stable and short so caching, where available,
  works well.
- It does not skip verification to save tokens — the gates enforce that
  verification runs after code changes. The spend savings come from shape and
  caps, not from cutting safety.

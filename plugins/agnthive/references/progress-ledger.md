# Durable progress ledger

The controller can keep completed work across context compaction in a plain
Markdown ledger. The runtime resolves its location in this order:

1. `AGNTHIVE_PROGRESS_FILE`, when set.
2. `<projectDir>/.agnthive/progress.md`.
3. `<cwd>/.agnthive/progress.md` when no project directory is available.

`.agnthive/` is scratch data and is gitignored. A compact entry is enough:

```text
Task N: complete (commits <base7>..<head7>, review clean)
```

Read the ledger before resuming a workflow and after compaction. Since
ADR 0013 the ledger is restored through the verified lifecycle channel: a
`SessionStart` with the `compact`/`resume` source re-injects a **bounded
summary** (open task id/kind, current revision, and the explicit ledger path —
never the full ledger text) once per restoration cycle, tracked by
`restored_task_seq` in session state. `PostCompact` is bookkeeping telemetry
only (metadata: `compact_summary_present`/`compact_summary_bytes`, plus the
bounded summary text only when the explicit
`AGNTHIVE_VERBOSE_COMPACT_LOG=1` opt-in is set); it is not a context-injection
channel. The ledger file itself remains the source of truth. A missing, empty,
or oversized (past `AGNTHIVE_LEDGER_MAX_BYTES`) ledger produces a bounded
diagnostic with an explicit reconstruction step, never false progress. See
[subagent-driven development](subagent-driven-development.md) and
[agent contracts](agent-contracts.md).

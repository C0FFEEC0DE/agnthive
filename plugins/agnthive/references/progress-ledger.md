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

Read the ledger before resuming a workflow and after compaction. The
`PostCompact` handler may inject the current ledger into context as a
best-effort convenience; the file itself remains the source of truth. See
[subagent-driven development](subagent-driven-development.md) and
[agent contracts](agent-contracts.md).

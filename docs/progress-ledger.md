# Durable progress ledger

A plain-markdown ledger the controller appends to during Subagent-Driven
Development so completed work survives context compaction.

## Why

Conversation memory does not survive compaction. After a compaction, a
controller that lost its place has re-dispatched entire completed task
sequences — the single most expensive failure observed in subagent-driven
work. The ledger is the recovery map: the commits it names exist in git even
when the context no longer remembers creating them.

## Location

Resolved by `progress_ledger_path()` in `claudecfg/hooks/lib.sh`:

1. `$CLAUDE_CREW_PROGRESS_FILE` if set, else
2. `$(git rev-parse --show-toplevel)/.claude-crew/progress.md`, else
3. `$PWD/.claude-crew/progress.md`

`.claude-crew/` is gitignored (see `.gitignore`) so the scratch never gets
committed.

## Format

One line per completed task, appended in the same message as your other
bookkeeping once a task's review comes back clean:

```text
Task N: complete (commits <base7>..<head7>, review clean)
```

## Recovery

- At Subagent-Driven Development start, read the ledger:
  `cat "$(git rev-parse --show-toplevel)/.claude-crew/progress.md"`.
  Tasks listed there as complete are DONE — do not re-dispatch them; resume at
  the first task not marked complete.
- After any compaction, trust the ledger and `git log` over your own
  recollection.
- `git clean -fdx` destroys the ledger (it is gitignored scratch). Recover
  from `git log` if that happens.

## PostCompact re-injection

`claudecfg/hooks/post-compact.sh` re-injects a non-empty ledger as
`additionalContext` on the PostCompact event, so the freshly compacted context
sees your progress. This is a best-effort convenience; the primary mechanism is
the agent reading the file at skill start. When no ledger exists the hook emits
nothing, preserving prior behavior.

See `claudecfg/workflows/subagent-driven-development.md` and `docs/agent-contracts.md`.
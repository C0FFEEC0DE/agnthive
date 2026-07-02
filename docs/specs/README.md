# Design specs

Dated design documents produced during the **brainstorm/design** phase, before a plan is written.

## Convention

- One file per design: `YYYY-MM-DD-<slug>-design.md`
- A design describes *what* and *why* (problem, options, tradeoffs, chosen approach, constraints). It does not contain task-by-task implementation steps — that is the plan's job.
- Commit the design; it is the audit trail for the decision.
- Pairs with `docs/plans/<date>-<slug>.md` (the execution plan) and the durable progress ledger.

## Where this fits

Design → Plan (docs/plans/) → Subagent-Driven Development → Review.

The shipped workflow and contracts live in
`plugins/agent-hive/references/`.

## Exceptions to the dated-design convention

`claude-code-plugin-node-migration.md` is a **completed migration
traceability matrix**, not a brainstorm design. It pairs with
`docs/plans/2026-06-21-claude-code-plugin-node-production.md` and uses the
non-dated path dictated by that plan. It records the coverage gate used for the
completed Node port.

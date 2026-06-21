# Design specs

Dated design documents produced during the **brainstorm/design** phase, before a plan is written.

## Convention

- One file per design: `YYYY-MM-DD-<slug>-design.md`
- A design describes *what* and *why* (problem, options, tradeoffs, chosen approach, constraints). It does not contain task-by-task implementation steps — that is the plan's job.
- Commit the design; it is the audit trail for the decision.
- Pairs with `docs/plans/<date>-<slug>.md` (the execution plan) and the durable progress ledger.

## Where this fits

Design → Plan (docs/plans/) → Subagent-Driven Development → Review.

See `claudecfg/workflows/subagent-driven-development.md` and `docs/agent-contracts.md`.
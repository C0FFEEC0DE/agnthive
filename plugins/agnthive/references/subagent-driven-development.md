# Subagent-Driven Development Workflow

## When

You have an approved plan (see `docs/plans/`) derived from a design
(`docs/specs/`) and want to execute it in this session with a fresh,
focused subagent per task plus a review after each. Use this instead of
editing files directly when the plan has mostly-independent tasks. The **root
session** runs this workflow directly — there is no separate Manager step
([ADR 0008](../../../docs/adr/0008-root-orchestration-and-three-specialists.md)).

## Why subagents

Delegation is by need, not by role quota. Dispatch a fresh implementer with
curated, isolated context when that isolation is genuinely useful: the
implementer never inherits your session history — you construct exactly what
it needs, your own context stays free for coordination, and independent work
items can proceed in parallel. For tasks that are small, or tightly coupled to
context you already hold, do them in the root session instead of paying for a
handoff.

The ledger (see [progress ledger](progress-ledger.md)) keeps your place across
compaction so completed work is never re-dispatched.

## Steps

### 1. Read the plan once, create todos, note global constraints

Read the plan file a single time. Create a todo per task. Copy the plan's
**Global Constraints** (exact values, formats, component relationships) into
your working notes — every reviewer dispatch carries them verbatim as its
attention lens.

### 2. Pre-flight plan conflict scan

Before dispatching Task 1, scan the whole plan once for:

- tasks that contradict each other or the plan's Global Constraints
- anything the plan mandates that the review rubric treats as a defect
  (a test that asserts nothing, verbatim duplication of a logic block)

Present everything you find to your human partner as **one batched question** —
each finding beside the plan text that mandates it, asking which governs —
before execution begins. Do not interrupt once per discovery mid-plan. If the
scan is clean, proceed without comment. The per-task review loop is the net
for conflicts that only emerge from implementation.

### 3. Per task: dispatch a fresh implementer with file handoffs

For each task, do **not** paste the whole plan or prior-task summaries into the
dispatch. Hand artifacts over as files:

```bash
node scripts/task-brief.mjs docs/plans/<date>-<slug>.md <N>
# prints: .agnthive/briefs/task-<N>-brief.md  (your single source of requirements)
```

Compose the dispatch so the brief is the single source of requirements. The
dispatch contains: (1) one line on where this task fits; (2) the brief path,
introduced as "read this first — it is your requirements, with exact values to
use verbatim"; (3) interfaces/decisions from earlier tasks the brief cannot know;
(4) your resolution of any ambiguity you noticed in the brief; (5) the
report-file path and report contract. Name the report file after the brief
(`…/task-<N>-report.md`) and put its path in the dispatch.

Choose the model and effort per task by the complexity of the work, and
respect any explicitly selected model. The cheapest tier suits tasks whose
plan already contains the complete code; prose-driven implementers and
reviewers generally need a mid-tier floor because turn count, not token
price, tends to dominate multi-step cost. Treat every cost comparison as a
hypothesis until measured ([ADR
0008](../../../docs/adr/0008-root-orchestration-and-three-specialists.md) Consequences).

### 4. Handle the implementer status

Implementers report one of four statuses. Handle each:

- **DONE** — generate the review package and dispatch the task reviewer.
- **DONE_WITH_CONCERNS** — read the concerns first. Correctness/scope concerns
  are addressed before review; observations ("this file is getting large") are
  noted and you proceed to review.
- **NEEDS_CONTEXT** — provide the missing context and re-dispatch.
- **BLOCKED** — assess: context problem → re-dispatch same model with more
  context; needs more reasoning → re-dispatch on a more capable model; task too
  large → break it up; plan is wrong → escalate to the human. Never force the
  same model to retry without changing something.

Never ignore an escalation or force the same model to retry without changes.

### 5. Task review: spec compliance + code quality

Generate the review package and dispatch the task reviewer (`@cr`), handing it
the brief file, the report file, and the review package path, plus the global
constraints that bind the task:

```bash
node scripts/review-package.mjs <BASE> HEAD
# prints: .agnthive/reviews/<base7>..<head7>-review.md
```

`<BASE>` is the commit you recorded **before** dispatching the implementer —
never `HEAD~1`, which silently drops all but the last commit of a multi-commit
task. The reviewer returns **two** verdicts: spec compliance (✅/❌) and code
quality (Approved/Rejected). Both are required; self-review does not replace it.

If the reviewer reports **⚠️ Cannot verify from diff** items (requirements in
unchanged code or spanning tasks), resolve each yourself before marking the
task complete — you hold the cross-task context the reviewer lacks. Confirm a
real gap → send it back to the implementer and re-review.

Dispatch fix subagents for Critical and Important findings. Record Minor
findings in the ledger as you go and point the final whole-branch review at that
list so it can triage which must be fixed before merge. Re-review after every
fix; confirm the fix report contains the covering test, the command run, and
the output before re-dispatching the reviewer.

### 6. Mark the task complete in the ledger

When a task's review comes back clean, append one line to the durable progress
ledger in the same message as your other bookkeeping:

```text
Task N: complete (commits <base7>..<head7>, review clean)
```

The ledger is your recovery map; see [progress ledger](progress-ledger.md).
Do not re-dispatch a task the ledger already marks complete — check the ledger
and `git log` after any compaction or resume.

### 7. Final whole-branch review

After all tasks, dispatch one final `@cr` on the whole-branch review package
with the effort the task's size justifies:

```bash
node scripts/review-package.mjs MERGE_BASE HEAD
# prints: .agnthive/reviews/<mergebase7>..<head7>-review.md
```

If it returns findings, dispatch **one** fix subagent with the complete findings
list — not one fixer per finding (per-finding fixers each rebuild context and
re-run suites).

### 8. Finish

Completed verification is required before completion — a run counts only when
it finished successfully for the current diff, not when it launched or when a
named stage started ([ADR
0009](../../../docs/adr/0009-completion-evidence-over-role-quotas.md)). Run the
final whole-branch review (step 7) and record the docs decision for user-facing
behavior changes — `updated`, `not_required`, or `pending`, with a reason —
per the root [contracts](agent-contracts.md). This workflow governs the
**implement** and **review** internals of the normal
discover → design → implement → verify → review → docs flow.

## Red flags

Never:

- start implementation on main/master without explicit user consent
- skip the task review, or accept a report missing either verdict
- proceed with unfixed Critical/Important issues
- dispatch multiple implementation subagents in parallel (they conflict)
- make a subagent read the whole plan file — hand it its task brief instead
- move to the next task while the review has open Critical/Important issues
- re-dispatch a task the ledger already marks complete
- tell a reviewer what not to flag, or pre-rate a finding's severity in the
  dispatch prompt
- count a started run or a started specialist toward completion — only completed evidence counts

## Companion references

- Plan/spec convention: keep repository design and planning records with the project that owns them.
- File-handoff scripts: `scripts/task-brief.mjs`, `scripts/review-package.mjs`
- Recovery: [progress ledger](progress-ledger.md)
- Contracts: [agent contracts](agent-contracts.md)
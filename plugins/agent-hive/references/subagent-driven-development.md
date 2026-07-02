# Subagent-Driven Development Workflow

## When

You have an approved plan (see `docs/plans/`) derived from a design
(`docs/specs/`) and want to execute it in this session with a fresh,
focused subagent per task plus a review after each. Use this instead of
editing files directly when the plan has mostly-independent tasks.

## Why subagents

Delegating each task to a fresh implementer with curated, isolated context
keeps it focused and preserves your own context for coordination. The
implementer never inherits your session history — you construct exactly what
it needs. The ledger (see [progress ledger](progress-ledger.md))
keeps your place across compaction so completed work is never re-dispatched.

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
# prints: .claude-crew/briefs/task-<N>-brief.md  (your single source of requirements)
```

Compose the dispatch so the brief is the single source of requirements. The
dispatch contains: (1) one line on where this task fits; (2) the brief path,
introduced as "read this first — it is your requirements, with exact values to
use verbatim"; (3) interfaces/decisions from earlier tasks the brief cannot know;
(4) your resolution of any ambiguity you noticed in the brief; (5) the
report-file path and report contract. Name the report file after the brief
(`…/task-<N>-report.md`) and put its path in the dispatch.

Always specify the model explicitly when dispatching — an omitted model inherits
your session's model (often the most capable and most expensive). Use the
cheapest model that handles the role: cheap for mechanical/transcription tasks
where the plan contains the complete code, mid-tier floor for reviewers and for
implementers working from prose, most-capable for architecture and the final
whole-branch review.

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
# prints: .claude-crew/reviews/<base7>..<head7>-review.md
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

After all tasks, dispatch one final `@cr` on the most capable available model
with the whole-branch review package:

```bash
node scripts/review-package.mjs MERGE_BASE HEAD
# prints: .claude-crew/reviews/<mergebase7>..<head7>-review.md
```

If it returns findings, dispatch **one** fix subagent with the complete findings
list — not one fixer per finding (per-finding fixers each rebuild context and
re-run suites; a real session's final-review fix wave cost more than all its
tasks combined).

### 8. Finish

Successful verification is required before completion (the hooks enforce it).
Run the final review gate (`@cr`) — the whole-branch review in step 7 — and
then document any user-facing behavior change (`@doc`) per the profile's
[agent contracts](agent-contracts.md). Use the normal
discover → design → implement → verify → review → docs flow for the branch as a
whole; this workflow governs the **implement** and **review** internals.

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

## Companion references

- Plan/spec convention: keep repository design and planning records with the project that owns them.
- File-handoff scripts: `scripts/task-brief.mjs`, `scripts/review-package.mjs`
- Recovery: [progress ledger](progress-ledger.md)
- Contracts: [agent contracts](agent-contracts.md)

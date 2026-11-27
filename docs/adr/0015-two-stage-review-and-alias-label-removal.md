# ADR 0015: Two-stage review and removal of compatibility alias labels

- Status: Accepted
- Date: 2026-11-27
- Amends: [0008](0008-root-orchestration-and-three-specialists.md) (review is no
  longer a forked skill; the alias map no longer keeps removed labels), and the
  transcript-fallback rule in
  [`references/agent-contracts.md`](../../plugins/agnthive/references/agent-contracts.md).
- Baseline: `02393fa`, plugin `0.5.0`.

## Context

Two leftovers from the compatibility era cost more than they buy.

1. **Review ran only as a forked read-only skill.** `/review` declared
   `agent: Code Reviewer` and `context: fork`, so the whole skill process was
   the review. That is the right shape for independence, but it makes the first
   half of a review impossible: mechanical cleanups — duplicated blocks, dead
   branches, one-use abstractions, needless options — are found and applied only
   by code that may edit. The reviewer then spends its read-only budget reading
   code that a simplification pass would have deleted.
2. **The alias map still carried the five removed roles** (`a/architect`,
   `bug/bugbuster`, `t/tester`, `doc/docwriter`, `m/manager`) plus their
   nicknames, and the transcript patterns mapped `skill(/test)`,
   `skill(/design)`, `skill(/refactor)`, `skill(/bug)`, `skill(/docs)`,
   `skill(/manager)` to those roles. Since 0.5.0 those skills are root
   procedures, so a skill-load line was being read as a specialist dispatch —
   a false claim in exactly the evidence layer ADR 0009 demoted to "claimed".

## Decision

1. **`/review` is a root procedure with two stages.**
   - Stage 1, simplify: apply behavior-preserving reductions to the change
     (duplication, dead code, one-use abstractions, needless parameters and
     config), then re-run verification. This stage may edit files.
   - Stage 2, review: dispatch the Code Reviewer in a read-only subagent on the
     simplified diff, then report its findings. This stage is still independent
     — the reviewer neither wrote the change nor the simplification.
   The `@cr` completion gate is unchanged: it is satisfied by the
   `SubagentStart` record of the review dispatch, not by loading a skill.
2. **`/simplify` ships as a standalone root command** running stage 1 only, for
   a change that does not need a separate reviewer.
3. **Only the three shipped agents remain addressable.** `assets/aliases.json`
   and the transcript patterns carry `cr`, `e`, and `dbg` with their real names
   (`code-reviewer`, `explorer`, `debugger`, and the skill-free synonyms). The
   removed labels and nicknames are deleted rather than retained for reading old
   benchmark evidence; those reports stay valid as artifacts but are no longer
   re-derivable from transcripts.
4. **Root-procedure skill loads no longer imply a role.** `skill(/test)`,
   `skill(/design)`, `skill(/refactor)`, `skill(/bug)`, `skill(/docs)`,
   `skill(/manager)`, `skill(/explore)` and `skill(/debug)` are not dispatch
   evidence. A role is observed from `SubagentStart`, from a launch line that
   names a shipped specialist (`Code Reviewer(`, `Explorer(`, `Debugger(`), or
   from an `@cr`/`@e`/`@dbg` mention — the pre-existing transcript fallback for
   runtimes that omit `SubagentStart`. The mention still satisfies the role
   gate, but it is text rather than observation: ADR 0009's evidence model
   treats it as a claim, and the benchmark records it in the `claimed` tier
   (ADR 0012).
5. **No skill is forked.** The frontmatter validator still enforces the full
   forked dispatch contract (`agent`, `context: fork`,
   `disable-model-invocation: true`, `allowed-tools`, `paths`) for any future
   skill that declares `agent:`; the shipped inventory is empty and pinned.

## Alternatives considered

- **Keep `/review` forked and require `/simplify` first.** Preserves the fork,
  but the two stages become two commands the user must sequence, and a single
  "review this" request cannot perform the cleanup.
- **Let the forked reviewer do both stages.** The fork is read-only, so stage 1
  could only produce advice, not apply it — the cost ADR 0014 targeted.
- **Keep the legacy labels for historical evidence.** They are the only place
  the removed roles still resolve, but they also keep misclassifying root
  procedures as dispatches; ADR 0009 already treats transcript text as claims.

## Consequences

- The reviewer reads a smaller, cleaner diff; simplification cost is paid once,
  in the root, with the change context already loaded.
- Reviewers can no longer rely on the skill-load line as proof of dispatch;
  benchmark `hook` evidence keeps using `SubagentStart` (authoritative) and the
  launch-line fallback now names only shipped specialists.
- Historical benchmark reports that cite `@a`/`@t`/`@bug`/`@doc`/`@m` are
  historical artifacts; re-running them is a new measurement, not a re-read.
- Enforcement semantics are unchanged: verification evidence and the `@cr` gate
  behave as before, and nothing here relaxes a failure classification.

## Acceptance evidence

- `scripts/validate.mjs` passes with `AGENT_BACKED_SKILLS = []`, `simplify` in the
  slash-command inventory, and a review-BODY check that names both stages and
  `@cr` (frontmatter excluded, with a negative test for a stage-less body).
- `node scripts/test-hooks.mjs` passes, and no fixture relies on a removed label
  resolving to a role (fixtures that keep the old text assert it no longer
  canonicalizes).
- `node --test test/**/*.test.mjs` passes, including the agent-normalization
  tests asserting that removed labels no longer canonicalize to a role.

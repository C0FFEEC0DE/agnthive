# Outcome benchmark suite

Tasks that score END STATES, not footers: each task declares an observable
outcome (files, repo state, verified behavior) plus the minimum role protocol
surface (none). Role dispatch compliance stays covered by the legacy
`subagents` suite under `bench/tasks/subagents/`; this suite measures what the
work ended up as, so the two suites can be run side by side (ADR-0012).

Layout:

- tasks/ — one JSON per task (see Schema below)
- seeds/ — task seed sources copied into a run's work area by the runner; each
  task pins the seed files it uses with sha256 digests, and the suite checks
  the digests on every emit
- schema/outcome-schema.mjs — task contract + metrics contract (source of truth)
- tools/emit-outcome-metrics.mjs — writes the per-arm metrics document

## Arms and repetitions

At most three arms: `native` (no plugin loaded), `legacy` (current plugin
profile), `lean` (candidate slimmed profile). A task declares the arms it runs
on (its `arms` array); lifecycle scenarios and evidence-flag predicates only
apply to plugin arms, so `native` never carries evidence flags. Each task runs
at least MIN_LIVE_REPS = 3 paired repetitions per arm in the RUNNER CONFIG for
gate-eligible live runs; the suite declares the floor, the runner (plan task
09) owns the actual rep loop. Smaller-than-floor runs are exploratory and are
excluded from gate inputs by the emitter.

Orchestrator ablation (Manager vs root) is declared per task through the
`ablation` field; one ablation task ships (two independent subtasks).

## Mock-first

Every task is runnable with no model spend:

- Mock predicates (`evaluate_in: "mock"`) check the task's DECLARED initial
  state (fixture and seed files). The suite validator runs them at PR time,
  and every mock-mode run evaluates them again.
- Live predicates (`evaluate_in: "live"`) assert the run's end state. Only the
  runner evaluates them in live runs. In mock mode they are `unverified`, and
  outcome pass rates stay null — mock verifies plumbing, live verifies quality
  (ADR-0012).

Run the suite in mock mode (no model, no network):

    node scripts/run-benchmark.mjs --output-dir /tmp/agnthive-outcomes \
      --task-glob 'bench/tasks/outcomes/tasks/*.json' --mode mock

Then emit the metrics document:

    node bench/tasks/outcomes/tools/emit-outcome-metrics.mjs \
      --run /tmp/agnthive-outcomes --arm lean --out /tmp/agnthive-outcomes/outcome-metrics.json

`--run DIR [--arm NAME]` repeats per run; `BENCH_ARM` provides the arm for a
single run. `BENCH_MOCK=1` is a mode-integrity marker: the emitter refuses live
runs while it is set.

## Task schema (v1)

Common fields, all required unless noted:

- id — `outcome-…`; suite — `outcomes`; schema_kind — `outcome-task-v1`
- title, category (`feature|bugfix|refactor|docs|review|support`)
- fixture — a directory under `bench/fixtures/` (the run's starting work area)
- seed_files — optional array of {path, source, sha256}: `source` is
  suite-root-relative under outcomes/seeds/, `path` is the work-area-relative
  destination the runner seeds
- arms — 1..3 of `native|legacy|lean`; budget_class — `small|medium|large`
  (suggested turn/timeout caps: 12/240s, 24/400s, 40/800s; the runner may
  tighten but not silently loosen)
- coverage_tags — exactly one of: minor-code-change, nontrivial-bug,
  security-review, cross-file-refactor, docs-only, unfamiliar-subsystem,
  two-independent-subtasks, compact-resume, background-verification; the suite
  enforces one task per tag.
- prompt — role-free and footer-free (no `@alias` dispatch, no handoff footers)
- verification_required / docs_required / review_required booleans (docs tasks
  are verification-free)
- related_agents — diagnostic metadata only, never scored
- success_criteria, must_not — non-empty string arrays
- ground_truth — optional: findings [{id, material, report_pattern}] for
  findings-coverage metrics
- scenario — optional lifecycle type; ablation — optional {axis, variants}
- expected_outcome — verification_commands (when verification_required) and
  predicates

## Predicate vocabulary

Mock (evaluated offline against declared files):

| kind | fields |
| --- | --- |
| initial_file_matches | where (fixture or seed), path, pattern, min_occurrences |

Live (runner-evaluated, end state):

| kind | fields |
| --- | --- |
| file_exists | path |
| file_unchanged | path, base (fixture or seed) |
| file_matches / file_not_matches | path, pattern (regex) |
| commands_pass | commands (plain command strings) |
| changed_paths_within | allow (path globs; empty allow = nothing may change) |
| findings_cover | min_matches (material ground-truth findings the run must have covered) |
| evidence_flag | field, op (equals or exists or absent or gte or lte), equals |

Every task carries at least one mock and one live predicate. Evidence flags
resolve against the plugin's ADR-0009 state vocabulary (verification.latest,
verification.current, restored_task_seq, docs_status, revision,
workflow_profile, review_results); an unknown evidence field evaluates as a
failed predicate, never as a silent skip.

## Metrics document (for the rollout gate, plan tasks 11/15)

The emitter writes ONE document per invocation (recommended path
`${BENCH_OUTPUT_DIR}/outcome-metrics.json`), validated by
`validateOutcomeMetrics` in the schema module before it is written:

- schema_kind — `outcome-metrics`; schema_version — `1.0`; suite — `outcomes`
- emitter_version, mode (`mock` or `live`, never mixed), generated_at
- contracts_revision — `sha256:…` over bench/fixtures + suite seeds/schema code
  + bench/patterns/forbidden-meta-chatter.json (record this with every run)
- run_metadata — model, provider, effort, token_cap, cli_version (null when
  unknown; sourced from run summaries or BENCH_* environment)
- arms — the labels present
- per_arm — keyed by arm: reps (distinct rep slots), task_executions, tasks,
  completed_rate, outcome_pass_rate (null unless live predicates were fully
  evaluated), false_completions (null when not measurable; completed-but-failed
  count), permission_denials, verification_pass_rate, material_findings
  ({expected, found, missed, claimed_total} over ground-truth materials),
  median_turns, median_runtime_seconds, median_dispatches, token_usage
  ({input, output, cache_read, cache_write}), cost ({usd, estimated} —
  estimated unless every cost row came from provider data), predicates
  ({mock: {total, passed, failed}, live: {total, passed, failed, unverified,
  evaluated}})
- records — one row per (task, rep) with the full metric mapping (outcome,
  live predicate results, findings, token usage)
- gate_inputs — lean-vs-baseline ADR-0012 gate deltas, available ONLY when the
  metrics are live, every involved arm fully evaluated and findings-evidenced,
  and every involved arm ran >= 3 reps per task; otherwise
  {available: false, reason}. Shape when available:
  `gate_inputs.lean.<baseline>` (baseline = native or legacy) with
  new_false_completions (count delta), permission_denials_delta (count delta),
  lost_material_findings (max over paired reps of baseline-matched minus
  lean-matched material findings, floored at 0, summed per task), paired
  (pairable (task, rep) count).

Gate decision rule (ADR-0012): lean may become the default only when
`gate_inputs` is available and every baseline shows no new false completions,
no permission regressions, and no lost material findings.

Seeds are integrity-checked before every emit; ANY contract violation exits 1
without writing the metrics file. The metrics contract itself is revalidated
before writing, so an invalid document can never appear on disk.

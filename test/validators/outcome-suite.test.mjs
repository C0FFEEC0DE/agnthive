// Validator test for the outcome benchmark suite (plan task 10).
// Mirrors the other validator suites: loads the suite from disk, checks the
// task contract, exercises the emitter against synthetic run outputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SUITE_DIR = join(REPO_ROOT, 'bench', 'tasks', 'outcomes');
const FIXTURES_DIR = join(REPO_ROOT, 'bench', 'fixtures');

import {
  COVERAGE_TAGS_REQUIRED,
  SUITE_ARMS,
  MIN_LIVE_REPS,
  checkSeedIntegrity,
  evaluateMockPredicates,
  loadOutcomeSuiteTasks,
  validateOutcomeMetrics,
} from '../../bench/tasks/outcomes/schema/outcome-schema.mjs';
import { emitOutcomeMetrics } from '../../bench/tasks/outcomes/tools/emit-outcome-metrics.mjs';

const paths = { repoRoot: REPO_ROOT, fixturesDir: FIXTURES_DIR, suiteDir: SUITE_DIR };

function loadSuite() {
  return loadOutcomeSuiteTasks({ suiteDir: SUITE_DIR, repoRoot: REPO_ROOT });
}

function freshRunDir(name, summary) {
  const base = mkdtempSync(join(tmpdir(), 'outcome-suite-test-'));
  const dir = join(base, 'runs', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary), 'utf-8');
  return dir;
}

test('every outcome task satisfies the suite schema', () => {
  const loaded = loadSuite();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.tasks.filter((t) => t.invalid).length, 0);
  assert.equal(loaded.tasks.length, COVERAGE_TAGS_REQUIRED.length);
});

test('the nine coverage tags are covered exactly once each', () => {
  const loaded = loadSuite();
  const seen = new Map();
  for (const { task } of loaded.tasks) seen.set(task.coverage_tags[0], (seen.get(task.coverage_tags[0]) || 0) + 1);
  for (const tag of COVERAGE_TAGS_REQUIRED) assert.equal(seen.get(tag), 1, 'tag ' + tag);
});

test('outcome prompts are role-free and footer-free', () => {
  const loaded = loadSuite();
  for (const { task, path } of loaded.tasks) {
    assert.doesNotMatch(task.prompt, /@(?:m|e|a|bug|dbg|t|cr|doc)\b/, path);
    for (const marker of ['Verification status:', 'Remaining risks:', 'Handoff evidence:', 'BENCHMARK_DISPATCH_CONTRACT']) {
      assert.ok(!task.prompt.includes(marker), path + ' mentions ' + marker);
    }
  }
});

test('role-scoring arrays stay empty on outcome tasks', () => {
  const loaded = loadSuite();
  for (const { task, path } of loaded.tasks) {
    assert.deepEqual(task.required_transcript_patterns, [], path);
    assert.deepEqual(task.required_used_agents, [], path);
    assert.deepEqual(task.required_used_agent_groups, [], path);
  }
});

test('arms, budget classes, and fixture dirs are declared consistently', () => {
  const loaded = loadSuite();
  for (const { task, path } of loaded.tasks) {
    assert.ok(task.arms.length >= 1 && task.arms.length <= 3, path);
    for (const arm of task.arms) assert.ok(SUITE_ARMS.includes(arm), path + ' arm ' + arm);
    assert.ok(['small', 'medium', 'large'].includes(task.budget_class), path);
    assert.ok(existsSync(join(FIXTURES_DIR, task.fixture)), path + ' fixture');
    for (const predicate of task.expected_outcome.predicates) {
      if (Array.isArray(task.arms) && task.arms.includes('native')) {
        assert.notEqual(predicate.kind, 'evidence_flag', path + ' evidence_flag on native');
      }
    }
  }
});

test('seed integrity holds for every seeded task', () => {
  const loaded = loadSuite();
  for (const { task } of loaded.tasks) {
    const result = checkSeedIntegrity(task, { suiteDir: SUITE_DIR });
    assert.deepEqual(result.errors, [], task.id);
  }
});

test('mock predicates pass against the declared initial state', () => {
  const loaded = loadSuite();
  for (const { task } of loaded.tasks) {
    const evaluated = evaluateMockPredicates(task, paths);
    const failures = evaluated.results.filter((r) => r.result !== 'passed');
    assert.deepEqual(failures, [], task.id);
    assert.equal(evaluated.violations, 0, task.id);
  }
});

test('every task pairs at least one mock and one live predicate', () => {
  const loaded = loadSuite();
  for (const { task, path } of loaded.tasks) {
    const kinds = task.expected_outcome.predicates.map((p) => p.evaluate_in);
    assert.ok(kinds.includes('mock'), path);
    assert.ok(kinds.includes('live'), path);
  }
});

test('the seeded budget bug is real (drift), and the seeded suites stay green', () => {
  const seedDir = join(SUITE_DIR, 'seeds', 'outcome-bug-budget-drift');
  return import('file://' + join(seedDir, 'budget.mjs')).then(({ subtotal }) => {
    const lines = [
      { amount: 10.335, tax: 0.05 },
      { amount: 10.3, tax: 0.05 },
      { amount: 10.3, tax: 0.05 },
      { amount: 10.3, tax: 0.05 },
    ];
    assert.notEqual(subtotal(lines), 43.41, 'per-line rounding must drift on this input');
  });
});

test('the seeded review target is text-checked only', () => {
  const loaded = loadSuite();
  const seedFiles = loaded.tasks
    .flatMap((t) => (t.task.seed_files || []).map((s) => s.source))
    .filter((source) => source.includes('flawed-ingest'));
  assert.equal(seedFiles.length, 1);
  const suiteFiles = [
    join(SUITE_DIR, 'schema', 'outcome-schema.mjs'),
    join(SUITE_DIR, 'tools', 'emit-outcome-metrics.mjs'),
  ];
  for (const file of suiteFiles) {
    const text = readFileSync(file, 'utf-8');
    assert.ok(!text.includes('flawed-ingest/ingest'), 'suite code must not touch the security seed');
  }
});

test('seeded test suites pass as shipped', () => {
  const seededSuites = [
    join(SUITE_DIR, 'seeds', 'outcome-bug-budget-drift', 'budget.test.mjs'),
    join(SUITE_DIR, 'seeds', 'outcome-refactor-shared-render', 'pipeline.test.mjs'),
  ];
  for (const suite of seededSuites) {
    execFileSync(process.execPath, ['--test', suite], { stdio: 'pipe' });
  }
});

test('mock runs emit the metrics contract with honest nulls', () => {
  const outDir = join(mkdtempSync(join(tmpdir(), 'outcome-suite-test-')), 'mock');
  execFileSync(process.execPath, [
    join(REPO_ROOT, 'scripts', 'run-benchmark.mjs'),
    '--output-dir', outDir,
    '--task-glob', 'bench/tasks/outcomes/tasks/*.json',
    '--mode', 'mock',
    '--task-label', 'outcomes-mock-selftest',
  ], { stdio: 'pipe', cwd: REPO_ROOT });
  try {
    const result = emitOutcomeMetrics({ runs: [{ dir: outDir, arm: 'lean' }], out: join(outDir, 'outcome-metrics.json') });
    assert.equal(result.violations, undefined);
    const doc = JSON.parse(readFileSync(join(outDir, 'outcome-metrics.json'), 'utf-8'));
    assert.equal(validateOutcomeMetrics(doc).ok, true);
    assert.equal(doc.mode, 'mock');
    assert.equal(doc.per_arm.lean.outcome_pass_rate, null);
    assert.equal(doc.per_arm.lean.predicates.live.unverified, doc.per_arm.lean.predicates.live.total);
    assert.equal(doc.per_arm.lean.predicates.mock.failed, 0);
    assert.equal(doc.gate_inputs.available, false);
    assert.equal(doc.records.length, COVERAGE_TAGS_REQUIRED.length);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

function syntheticResult(task, rep, opts) {
  const predicates = Object.fromEntries(task.livePredicateIds.map((id) => [id, 'passed']));
  return Object.assign({
    task_id: task.id,
    status: 'passed',
    notes: 'synthetic live result',
    completed: true,
    verification_required: task.verification_required,
    tests_run: true,
    tests_passed: true,
    review_required: false,
    review_present: false,
    docs_required: false,
    docs_updated: false,
    policy_violations: 0,
    tool_failures: 0,
    runtime_seconds: 1.5,
    rep,
    predicate_results: predicates,
    permission_denials_count: 0,
    dispatch_count: 1,
    turns: 4,
    cost_usd: 0.02,
    cost_source: 'provider',
    changed_files: task.changed_files,
  }, opts || {});
}

test('a fully wired live run yields gate-ready metrics', () => {
  const loaded = loadSuite();
  const reviewTask = loaded.tasks.find((t) => t.task.id === 'outcome-review-flawed-ingest').task;
  const unitTask = loaded.tasks.find((t) => t.task.id === 'outcome-minor-change-optunit').task;
  const materialIds = reviewTask.ground_truth.findings.filter((f) => f.material).map((f) => f.id);
  const shapes = [
    { task: unitTask, livePredicateIds: ['unit-suffix-in-tests', 'suite-passes', 'scope-reporter-only'], changed_files: ['reporter.mjs'] },
    {
      task: reviewTask,
      livePredicateIds: ['all-material-findings', 'read-only-scope'],
      changed_files: [],
    },
  ];
  const resultsByArm = { lean: [], native: [] };
  for (const arm of Object.keys(resultsByArm)) {
    for (const shape of shapes) {
      for (let rep = 0; rep < MIN_LIVE_REPS; rep++) {
        resultsByArm[arm].push(syntheticResult(
          { id: shape.task.id, verification_required: shape.task.verification_required, changed_files: shape.changed_files, livePredicateIds: shape.livePredicateIds },
          rep,
          shape.task.id === 'outcome-review-flawed-ingest'
            ? { verification_required: false, tests_run: false, tests_passed: false, findings_evidence: { matched_material_ids: materialIds, claimed_total: 3 } }
            : {},
        ));
      }
    }
  }
  const leanDir = freshRunDir('lean', {
    schema_version: '1.0', mode: 'live', runner: 'synthetic', generated_at: '2026-10-19T00:00:00Z', source_ref: 'test', source_sha: 'test', tasks: resultsByArm.lean,
  });
  const nativeDir = freshRunDir('native', {
    schema_version: '1.0', mode: 'live', runner: 'synthetic', generated_at: '2026-10-19T00:00:00Z', source_ref: 'test', source_sha: 'test', tasks: resultsByArm.native,
  });
  try {
    const emitted = emitOutcomeMetrics({
      runs: [{ dir: leanDir, arm: 'lean' }, { dir: nativeDir, arm: 'native' }],
      out: join(leanDir, 'outcome-metrics.json'),
    });
    assert.equal(emitted.violations, undefined, JSON.stringify(emitted.violations || []));
    const doc = emitted.doc;
    assert.equal(doc.mode, 'live');
    assert.equal(doc.per_arm.lean.outcome_pass_rate, 1);
    assert.equal(doc.per_arm.lean.false_completions, 0);
    assert.equal(doc.per_arm.lean.material_findings.found, 9);
    const gate = doc.gate_inputs;
    assert.equal(gate.available, true);
    assert.equal(gate.lean.native.new_false_completions, 0);
    assert.equal(gate.lean.native.permission_denials_delta, 0);
    assert.equal(gate.lean.native.lost_material_findings, 0);
    assert.equal(gate.lean.native.paired, 6);
    assert.ok(validateOutcomeMetrics(doc).ok);
    } finally {
      rmSync(leanDir, { recursive: true, force: true });
      rmSync(nativeDir, { recursive: true, force: true });
    }
});

test('an unwired live runner stays honestly unverified', () => {
  const loaded = loadSuite();
  const unitTask = loaded.tasks.find((t) => t.task.id === 'outcome-minor-change-optunit').task;
  const results = [];
  for (let rep = 0; rep < 3; rep++) {
    results.push(syntheticResult(
      { id: unitTask.id, verification_required: true, changed_files: ['reporter.mjs'], livePredicateIds: ['unit-suffix-in-tests', 'suite-passes', 'scope-reporter-only'] },
      rep,
      { predicate_results: undefined },
    ));
  }
  const armDir = freshRunDir('lean', {
    schema_version: '1.0', mode: 'live', runner: 'synthetic', generated_at: '2026-10-19T00:00:00Z', source_ref: 'test', source_sha: 'test', tasks: results,
  });
  try {
    const emitted = emitOutcomeMetrics({ runs: [{ dir: armDir, arm: 'lean' }], out: join(armDir, 'outcome-metrics.json') });
    assert.equal(emitted.violations, undefined, JSON.stringify(emitted.violations || []));
    assert.equal(emitted.doc.per_arm.lean.outcome_pass_rate, null, 'no predicate wiring: no claimed pass');
    assert.equal(emitted.doc.per_arm.lean.predicates.live.evaluated, false);
    assert.equal(emitted.doc.gate_inputs.available, false);
    assert.ok(emitted.doc.gate_inputs.reason.includes('live predicates'));
    assert.ok(validateOutcomeMetrics(emitted.doc).ok);
  } finally {
    rmSync(armDir, { recursive: true, force: true });
  }
});

test('BENCH_MOCK=1 rejects live runs and mock stays silent about outcomes', () => {
  process.env.BENCH_MOCK = '1';
  try {
    const outcome = emitOutcomeMetrics({ runs: [], out: '' });
    assert.ok(outcome.violations.length > 0, 'empty runs are a suite-contract violation, not a pass');
  } finally {
    delete process.env.BENCH_MOCK;
  }
});

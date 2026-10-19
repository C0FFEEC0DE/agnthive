// Node tests for run-benchmark.mjs outcome-suite staging (BLOCK 2 + M4):
// pinned seeds must be staged into the run workarea (and sha256-verified)
// before the runner spawns; drifted/tampered/traversing tasks fail with a
// clear code and never run with unsatisfiable live predicates.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'run-benchmark.mjs');
const BASE_TASK = join(REPO, 'bench', 'tasks', 'outcomes', 'tasks', 'outcome-review-flawed-ingest.json');

function tmpd(t, prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function writeSeedTask(p, id, seedPatch) {
  const src = JSON.parse(readFileSync(BASE_TASK, 'utf-8'));
  src.id = id;
  for (const s of src.seed_files || []) {
    if (seedPatch && seedPatch.sha256 && s.path === seedPatch.path) s.sha256 = seedPatch.sha256;
    if (seedPatch && seedPatch.source && s.path === seedPatch.path) s.source = seedPatch.source;
  }
  writeFileSync(p, JSON.stringify(src, null, 2));
}

// Fake runner: passes only when every pinned seed is already staged in the
// workdir it was given (i.e. staging happened before the child spawned).
function writeSeedCheckerRunner(p) {
  writeFileSync(p, `#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const outDir = process.env.BENCH_OUTPUT_DIR;
mkdirSync(outDir, { recursive: true });
let task = {};
try { task = JSON.parse(readFileSync(process.env.BENCH_TASK_FILE, 'utf-8')); } catch {}
const workdir = process.env.BENCH_WORKDIR;
const missing = (task.seed_files || []).filter((s) => s && s.path && !existsSync(join(workdir, s.path))).map((s) => s.path);
const status = missing.length === 0 ? 'passed' : 'failed';
writeFileSync(join(outDir, 'result.json'), JSON.stringify({
  task_id: process.env.BENCH_TASK_ID, status, completed: true,
  verification_required: false, tests_run: false, tests_passed: false,
  review_required: false, review_present: false, docs_required: false,
  docs_updated: false, policy_violations: 0, tool_failures: 0,
  runtime_seconds: 1, notes: missing.length === 0 ? 'seeds-staged' : 'missing: ' + missing.join(','),
}));
`);
}

function runSeedScenario(t, { id, seedPatch } = {}) {
  const d = tmpd(t, 'rb-seed-');
  const outputDir = join(d, 'out');
  const taskFile = join(d, id + '.json');
  writeSeedTask(taskFile, id, seedPatch);
  const taskList = join(d, 'tasks.txt');
  writeFileSync(taskList, taskFile + '\n');
  const runner = join(d, 'seed-checker.mjs');
  writeSeedCheckerRunner(runner);
  const r = spawnSync(process.execPath, [SCRIPT,
    '--output-dir', outputDir, '--mode', 'command',
    '--task-list-file', taskList, '--task-label', 'staging:test',
  ], { cwd: REPO, encoding: 'utf-8', env: { ...process.env, BENCH_RUNNER_CMD: process.execPath + ' ' + runner } });
  let summary = null;
  try { summary = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf-8')); } catch {}
  return { r, summary, outputDir, d };
}

test('seed staging: pinned outcome seed is staged into the workarea before the runner spawns', (t) => {
  const id = 'outcome-stage-seed';
  const { r, summary, outputDir } = runSeedScenario(t, { id });
  assert.equal(r.status, 0, r.stderr);
  const rec = summary.tasks.find((x) => x.task_id === id);
  assert.ok(rec, 'task record exists');
  assert.equal(rec.status, 'passed');
  assert.match(rec.notes, /seeds-staged/);
  const workSeed = join(outputDir, 'tasks', id, 'workdir', 'ingest.mjs');
  assert.ok(existsSync(workSeed), 'seed staged in workdir');
  const pin = JSON.parse(readFileSync(BASE_TASK, 'utf-8')).seed_files[0].sha256;
  assert.equal(createHash('sha256').update(readFileSync(workSeed)).digest('hex'), pin);
});

test('seed staging: tampered sha pin fails the task with seed_integrity_mismatch and never spawns the runner', (t) => {
  const id = 'outcome-stage-tamper';
  const { r, summary, outputDir } = runSeedScenario(t, { id, seedPatch: { path: 'ingest.mjs', sha256: '0'.repeat(64) } });
  assert.equal(r.status, 0, r.stderr);
  const rec = summary.tasks.find((x) => x.task_id === id);
  assert.ok(rec);
  assert.equal(rec.status, 'failed');
  assert.match(rec.notes, /seed_integrity_mismatch/);
  assert.ok(!existsSync(join(outputDir, 'tasks', id, 'workdir', 'ingest.mjs')), 'tampered seed never staged');
  assert.deepEqual(summary.unresolved_task_ids, [id]);
});

test('seed staging: traversal seed source is rejected by schema validation', (t) => {
  const id = 'outcome-stage-traversal';
  const { r, summary } = runSeedScenario(t, { id, seedPatch: { path: 'ingest.mjs', source: '../secrets.mjs' } });
  assert.equal(r.status, 0, r.stderr);
  const rec = summary.tasks.find((x) => x.task_id === id);
  assert.ok(rec);
  assert.equal(rec.status, 'failed');
  assert.match(rec.notes, /outcome_task_validation_failed/);
  assert.match(rec.notes, /traversal/);
});

test('staging: malformed task JSON is a synthetic failed task and the run continues', (t) => {
  const d = tmpd(t, 'rb-badjson-');
  const outputDir = join(d, 'out');
  const bad = join(d, 'broken.json');
  writeFileSync(bad, '{ not json');
  const good = join(d, 'good.json');
  writeFileSync(good, JSON.stringify({ id: 'good-task', category: 'bugfix', fixture: 'text-report', review_required: false, docs_required: false, verification_required: false }));
  const taskList = join(d, 'tasks.txt');
  writeFileSync(taskList, bad + '\n' + good + '\n');
  const runner = join(d, 'fake-runner.mjs');
  writeFileSync(runner, `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
mkdirSync(process.env.BENCH_OUTPUT_DIR, { recursive: true });
writeFileSync(join(process.env.BENCH_OUTPUT_DIR, 'result.json'), JSON.stringify({
  task_id: process.env.BENCH_TASK_ID, status: 'passed', completed: true,
  verification_required: false, tests_run: false, tests_passed: false,
  review_required: false, review_present: false, docs_required: false,
  docs_updated: false, policy_violations: 0, tool_failures: 0,
  runtime_seconds: 1, notes: 'ok',
}));
`);
  const r = spawnSync(process.execPath, [SCRIPT,
    '--output-dir', outputDir, '--mode', 'command',
    '--task-list-file', taskList, '--task-label', 'staging:test',
  ], { cwd: REPO, encoding: 'utf-8', env: { ...process.env, BENCH_RUNNER_CMD: process.execPath + ' ' + runner } });
  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf-8'));
  assert.equal(summary.totals.executed_tasks, 2);
  const badRec = summary.tasks.find((x) => x.task_id === 'task-broken');
  assert.ok(badRec);
  assert.equal(badRec.status, 'failed');
  assert.match(badRec.notes, /outcome_task_validation_failed/);
  const goodRec = summary.tasks.find((x) => x.task_id === 'good-task');
  assert.equal(goodRec.status, 'passed');
});

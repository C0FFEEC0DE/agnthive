// Node tests for scripts/mock-benchmark-runner.mjs.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildMockResult } from '../../scripts/mock-benchmark-runner.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'mock-benchmark-runner.mjs');

function writeTask(p, id, fixture, category, overrides = {}) {
  writeFileSync(p, JSON.stringify({
    id, category, fixture, review_required: false, docs_required: false, verification_required: false, ...overrides,
  }));
}

test('buildMockResult strips repo root prefix from task_path', () => {
  const d = join('/tmp', 'mock-task-' + Date.now());
  const tf = join(d, 'task.json');
  mkdirSync(d, { recursive: true });
  writeTask(tf, 't1', 'text-report', 'feature', { verification_required: true, review_required: true, docs_required: true });
  const r = buildMockResult(tf, d);
  assert.equal(r.task_id, 't1');
  assert.equal(r.task_path, 'task.json');
  assert.equal(r.status, 'passed');
  assert.equal(r.runtime_seconds, 26);
  assert.equal(r.verification_required, true);
  assert.equal(r.tests_run, true);
  assert.equal(r.review_present, true);
  assert.equal(r.docs_updated, true);
});

test('runtime seconds by category', () => {
  const d = join('/tmp', 'mock-cat-' + Date.now());
  mkdirSync(d, { recursive: true });
  const cases = { bugfix: 18, feature: 26, refactor: 20, docs: 8, other: 15 };
  for (const [cat, sec] of Object.entries(cases)) {
    const tf = join(d, `${cat}.json`);
    writeTask(tf, cat, 'text-report', cat);
    assert.equal(buildMockResult(tf, d).runtime_seconds, sec, cat);
  }
});

test('CLI writes result.json with required fields', () => {
  const d = join('/tmp', 'mock-cli-' + Date.now());
  const outDir = join(d, 'out');
  mkdirSync(outDir, { recursive: true });
  const tf = join(d, 'task.json');
  writeTask(tf, 'cli-task', 'text-report', 'bugfix');
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf-8',
    env: { ...process.env, BENCH_TASK_FILE: tf, BENCH_OUTPUT_DIR: outDir, BENCH_REPO_ROOT: d },
  });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf-8'));
  for (const f of ['task_id', 'task_path', 'status', 'completed', 'verification_required', 'tests_run', 'tests_passed', 'review_required', 'review_present', 'docs_required', 'docs_updated', 'policy_violations', 'tool_failures', 'runtime_seconds', 'notes']) {
    assert.ok(f in result, `missing ${f}`);
  }
});
// Node tests for scripts/run-benchmark.mjs (port of the Python fail-fast test).
// Uses a Node-based fake runner (no jq/bash dependency in test fixtures).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, readFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from '../../scripts/run-benchmark.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'run-benchmark.mjs');

function writeTask(p, id, fixture, category) {
  writeFileSync(p, JSON.stringify({
    id, category, fixture, review_required: false, docs_required: false, verification_required: false,
  }));
}

// A Node-based fake runner: writes result.json, fails for a configured task id.
function writeFakeRunner(p, failId) {
  writeFileSync(p, `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const outDir = process.env.BENCH_OUTPUT_DIR;
mkdirSync(outDir, { recursive: true });
const taskId = process.env.BENCH_TASK_ID;
const taskFile = process.env.BENCH_TASK_FILE;
const repoRoot = process.env.BENCH_REPO_ROOT;
const rel = taskFile.startsWith(repoRoot + '/') ? taskFile.slice(repoRoot.length + 1) : taskFile;
const status = taskId === ${JSON.stringify(failId)} ? 'failed' : 'passed';
writeFileSync(join(outDir, 'result.json'), JSON.stringify({
  task_id: taskId, task_path: rel, status, completed: true,
  verification_required: false, tests_run: false, tests_passed: false,
  review_required: false, review_present: false, docs_required: false,
  docs_updated: false, policy_violations: 0, tool_failures: 0,
  runtime_seconds: 1, notes: 'synthetic result',
}));
`);
  // spawnSync executes via the shebang; ensure executable bit.
  chmodSync(p, 0o755);
}

function createTestDirectory(t, prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test('run-benchmark records unexecuted tasks after fail-fast', (t) => {
  const d = createTestDirectory(t, 'rb-');
  const outputDir = join(d, 'bench-output');
  const profileDir = join(d, 'claude-profile');
  const firstTask = join(d, 'first.json');
  const secondTask = join(d, 'second.json');
  const taskList = join(d, 'tasks.txt');
  const runner = join(d, 'fake-runner.mjs');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(d, { recursive: true });
  writeTask(firstTask, 'fail-fast-first', 'python-math', 'bugfix');
  writeTask(secondTask, 'unexecuted-second', 'text-report', 'docs');
  writeFileSync(taskList, `${firstTask}\n${secondTask}\n`);
  writeFakeRunner(runner, 'fail-fast-first');

  const r = spawnSync(process.execPath, [SCRIPT,
    '--output-dir', outputDir, '--mode', 'command',
    '--task-list-file', taskList, '--task-label', 'task-list:test',
  ], {
    cwd: REPO, encoding: 'utf-8',
    // Invoke the Node fake runner via `node <script>` rather than relying on the
    // `#!/usr/bin/env node` shebang: run-benchmark.mjs spawns the runner with
    // shell:false, and Windows CreateProcess cannot exec a shebang script (only
    // .com/.exe). Explicit `node` mirrors the production `python3 script.py`
    // form and works on all three OSes. On GHA Windows process.execPath is
    // space-free (hostedtoolcache), so the runner-cmd whitespace split is safe.
    env: { ...process.env, BENCH_RUNNER_CMD: `${process.execPath} ${runner}`, BENCH_FAIL_FAST: '1', BENCH_CLAUDE_PROFILE_DIR: profileDir },
  });
  assert.equal(r.status, 0, r.stderr);

  const summary = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf-8'));
  assert.deepEqual(summary.selected_task_ids, ['fail-fast-first', 'unexecuted-second']);
  assert.deepEqual(summary.executed_task_ids, ['fail-fast-first']);
  assert.deepEqual(summary.unexecuted_task_ids, ['unexecuted-second']);
  assert.deepEqual(summary.unresolved_task_ids, ['fail-fast-first', 'unexecuted-second']);
  assert.equal(summary.totals.configured_tasks, 2);
  assert.equal(summary.totals.selected_tasks, 2);
  assert.equal(summary.totals.executed_tasks, 1);
  assert.equal(summary.totals.unexecuted_tasks, 1);
  assert.equal(summary.totals.unresolved_tasks, 2);
});

test('run() mock mode unit produces passing summary', (t) => {
  const d = createTestDirectory(t, 'rb-mock-');
  const outputDir = join(d, 'out');
  mkdirSync(d, { recursive: true });
  const summary = run({
    outputDir, mode: 'mock', ref: 'test-ref',
    taskGlob: 'bench/tasks/subagents/smoke/*.json',
  });
  assert.ok(summary);
  assert.equal(summary.mode, 'mock');
  assert.ok(summary.totals.executed_tasks > 0);
  assert.equal(summary.totals.passed, summary.totals.executed_tasks);
  const fromFile = JSON.parse(readFileSync(join(outputDir, 'summary.json'), 'utf-8'));
  assert.equal(fromFile.totals.executed_tasks, summary.totals.executed_tasks);
});

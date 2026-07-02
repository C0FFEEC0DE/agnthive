// Node tests for scripts/merge-benchmark-summaries.mjs (port of the Python test).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  mergeSummaries, median, rate, normalizeStringList, countPreferred,
  mergeStringLists, taskIds, taskPaths, mergeUnique,
} from '../../scripts/merge-benchmark-summaries.mjs';
import { sanitize } from '../../scripts/bench/lib.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'merge-benchmark-summaries.mjs');

function makeTask(taskId, overrides = {}) {
  return {
    task_id: taskId, status: 'passed', completed: true, task_path: null,
    verification_required: false, tests_run: false, tests_passed: false,
    review_required: false, review_present: true, docs_required: false,
    docs_updated: true, policy_violations: 0, tool_failures: 0,
    runtime_seconds: 10, recovered_nonzero_exit: false,
    timeout_recovered: false, max_turns_recovered: false,
    summary_repaired_by: 'none', ...overrides,
  };
}
function makeSummary(tasks, configured = 1, executed = 1, extra = {}) {
  return {
    schema_version: '1.0', mode: 'cmd', runner: 'r',
    generated_at: '2026-01-01T00:00:00Z', source_ref: 'ref', source_sha: 'sha',
    task_glob: 'g', totals: { configured_tasks: configured, executed_tasks: executed },
    tasks, ...extra,
  };
}

test('median odd', () => assert.equal(median([1, 3, 2]), 2));
test('median even', () => assert.equal(median([1, 4, 2, 3]), 2.5));
test('median empty', () => assert.equal(median([]), 0));
test('median single', () => assert.equal(median([42]), 42));
test('rate divide-by-zero', () => { assert.equal(rate(1, 2), 0.5); assert.equal(rate(0, 0), 0); assert.equal(rate(3, 3), 1.0); });

// sanitize escapes backslashes before pipes so a trailing "\" cannot escape the
// injected "\|" (CodeQL js/incomplete-string-escaping regression guard).
test('sanitize escapes backslash and pipe', () => {
  assert.equal(sanitize('a|b'), 'a\\|b');
  assert.equal(sanitize('a\\b'), 'a\\\\b');
  assert.equal(sanitize('a\\|b'), 'a\\\\\\|b');
  assert.equal(sanitize('line1\nline2'), 'line1 / line2');
  assert.equal(sanitize(null), '');
});

test('count_preferred primary', () => assert.equal(countPreferred(['a', 'b'], ['c']), 2));
test('count_preferred secondary fallback', () => assert.equal(countPreferred([], ['c', 'd']), 2));
test('count_preferred default fallback', () => assert.equal(countPreferred([], [], 7), 7));

test('normalize_string_list rejects non-list and non-strings', () => {
  assert.deepEqual(normalizeStringList('nope'), []);
  assert.deepEqual(normalizeStringList(['ok', 3, '  ', 'good']), ['ok', 'good']);
});

test('merge_string_lists dedups across payloads', () => {
  assert.deepEqual(mergeStringLists([{ ids: ['a', 'b'] }, { ids: ['b', 'c'] }, { ids: 'not-a-list' }], 'ids'), ['a', 'b', 'c']);
});

test('task_ids filters non-string ids', () => {
  assert.deepEqual(taskIds([{ task_id: 'x' }, { task_id: 5 }, { other: 1 }]), ['x']);
});

test('task_paths collects aliases and strips', () => {
  assert.deepEqual(taskPaths([{ task_path: '  a.json  ' }, { task_file: 'b.json' }, { path: 'c.json' }, { path: '   ' }, { nope: 1 }]), ['a.json', 'b.json', 'c.json']);
});

test('merge_unique dedups', () => {
  assert.deepEqual(mergeUnique(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
});

test('merge summaries passes and failures', () => {
  const m = mergeSummaries([makeSummary([makeTask('a', { status: 'passed' }), makeTask('b', { status: 'failed' })], 2, 2)]);
  assert.equal(m.totals.passed, 1);
  assert.equal(m.totals.executed_tasks, 2);
});

test('merge summaries clean_passed excludes recovered', () => {
  const m = mergeSummaries([makeSummary([makeTask('clean', { recovered_nonzero_exit: false, summary_repaired_by: 'none' }), makeTask('rec', { recovered_nonzero_exit: true, summary_repaired_by: 'synthetic-footer' })], 2, 2)]);
  assert.equal(m.totals.passed, 2);
  assert.equal(m.totals.clean_passed, 1);
  assert.equal(m.totals.recovered_tasks, 1);
  assert.equal(m.totals.summary_repaired, 1);
});

test('merge summaries multiple shards accumulate', () => {
  const m = mergeSummaries([makeSummary([makeTask('s1-a'), makeTask('s1-b')], 2, 2), makeSummary([makeTask('s2-c')], 1, 1)]);
  assert.equal(m.totals.configured_tasks, 3);
  assert.equal(m.totals.executed_tasks, 3);
  assert.equal(m.tasks.length, 3);
});

test('merge summaries median runtime', () => {
  const m = mergeSummaries([makeSummary([makeTask('fast', { runtime_seconds: 5 }), makeTask('slow', { runtime_seconds: 15 })], 2, 2)]);
  assert.equal(m.median_runtime_seconds, 10.0);
});

test('merge summaries tool failures summed', () => {
  const m = mergeSummaries([makeSummary([makeTask('a', { tool_failures: 2 }), makeTask('b', { tool_failures: 3 })], 2, 2)]);
  assert.equal(m.totals.tool_failures, 5);
});

test('merge summaries merges resume lists and totals', () => {
  const m = mergeSummaries([
    { ...makeSummary([makeTask('task-a', { task_path: 'bench/tasks/smoke/task-a.json' })], 2, 1), selected_task_ids: ['task-a', 'task-b'], selected_task_paths: ['bench/tasks/smoke/task-a.json', 'bench/tasks/smoke/task-b.json'], executed_task_ids: ['task-a'], executed_task_paths: ['bench/tasks/smoke/task-a.json'], unexecuted_task_ids: ['task-b'], unexecuted_task_paths: ['bench/tasks/smoke/task-b.json'], unresolved_task_ids: ['task-b'], unresolved_task_paths: ['bench/tasks/smoke/task-b.json'] },
    { ...makeSummary([makeTask('task-c', { status: 'failed', task_path: 'bench/tasks/smoke/task-c.json' })], 1, 1), selected_task_ids: ['task-c'], selected_task_paths: ['bench/tasks/smoke/task-c.json'], executed_task_ids: ['task-c'], executed_task_paths: ['bench/tasks/smoke/task-c.json'], unexecuted_task_ids: [], unexecuted_task_paths: [], unresolved_task_ids: ['task-c'], unresolved_task_paths: ['bench/tasks/smoke/task-c.json'] },
  ]);
  assert.deepEqual(m.selected_task_ids, ['task-a', 'task-b', 'task-c']);
  assert.deepEqual(m.selected_task_paths, ['bench/tasks/smoke/task-a.json', 'bench/tasks/smoke/task-b.json', 'bench/tasks/smoke/task-c.json']);
  assert.deepEqual(m.executed_task_ids, ['task-a', 'task-c']);
  assert.deepEqual(m.unexecuted_task_ids, ['task-b']);
  assert.deepEqual(m.unresolved_task_ids, ['task-b', 'task-c']);
  assert.equal(m.totals.selected_tasks, 3);
  assert.equal(m.totals.executed_tasks, 2);
  assert.equal(m.totals.unexecuted_tasks, 1);
  assert.equal(m.totals.unresolved_tasks, 2);
});

test('merge summaries derives resume totals without explicit lists', () => {
  const m = mergeSummaries([makeSummary([makeTask('task-a', { status: 'passed' }), makeTask('task-b', { status: 'failed' })], 3, 2)]);
  assert.equal(m.totals.selected_tasks, 3);
  assert.equal(m.totals.executed_tasks, 2);
  assert.equal(m.totals.unexecuted_tasks, 1);
  assert.equal(m.totals.unresolved_tasks, 2);
  assert.deepEqual(m.unresolved_task_ids, ['task-b']);
});

test('merge summaries empty raises', () => {
  assert.throws(() => mergeSummaries([]), /at least one summary is required/);
});

test('merge summaries derives executed paths from tasks when missing', () => {
  const m = mergeSummaries([makeSummary([makeTask('task-a', { status: 'failed', task_path: 'bench/tasks/smoke/task-a.json' })], 1, 1)]);
  assert.deepEqual(m.executed_task_paths, ['bench/tasks/smoke/task-a.json']);
  assert.deepEqual(m.unresolved_task_paths, ['bench/tasks/smoke/task-a.json']);
  assert.deepEqual(m.unresolved_task_ids, ['task-a']);
});

test('main writes merged summary', () => {
  const d = mkdtempSync(join(tmpdir(), 'merge-'));
  const a = join(d, 'a.json');
  const b = join(d, 'b.json');
  const out = join(d, 'merged.json');
  writeFileSync(a, JSON.stringify(makeSummary([makeTask('task-a')], 1, 1)));
  writeFileSync(b, JSON.stringify(makeSummary([makeTask('task-b')], 1, 1)));
  const r = spawnSync(process.execPath, [SCRIPT, '--output', out, a, b], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
  const merged = JSON.parse(readFileSync(out, 'utf-8'));
  assert.equal(merged.totals.configured_tasks, 2);
  assert.deepEqual(new Set(merged.tasks.map((t) => t.task_id)), new Set(['task-a', 'task-b']));
});
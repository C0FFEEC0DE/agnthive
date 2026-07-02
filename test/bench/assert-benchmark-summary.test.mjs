// Node tests for scripts/assert-benchmark-summary.mjs (port of the Python test).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { summaryPassesGate, summaryFunctionalPassesGate, renderGateLines } from '../../scripts/assert-benchmark-summary.mjs';
import { dispatchLineReport, taskFunctionalFailures, taskDispatchLineFailures } from '../../scripts/bench/lib.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'assert-benchmark-summary.mjs');

function passingTotals() {
  return {
    configured_tasks: 2, selected_tasks: 2, executed_tasks: 2, unexecuted_tasks: 0,
    unresolved_tasks: 0, tasks: 2, passed: 2, clean_passed: 2, completed: 2,
    verification_required: 2, tests_run: 2, review_required: 2, review_present: 2,
    docs_required: 0, docs_updated: 0, recovered_tasks: 0, timeout_recovered: 0,
    max_turns_recovered: 0, summary_repaired: 0, policy_violations: 0, tool_failures: 0,
  };
}
function summary(overrides = {}) {
  const totals = passingTotals();
  if (overrides.totals) Object.assign(totals, overrides.totals);
  const { totals: _omit, ...rest } = overrides;
  return {
    schema_version: '1.0', mode: 'cmd', runner: 'r', generated_at: 'x',
    source_ref: 'ref', source_sha: 'sha', task_glob: 'g', totals,
    rates: { task_pass_rate: 1, clean_pass_rate: 1, completion_rate: 1, verification_pass_rate: 1, review_compliance_rate: 1, docs_compliance_rate: 1, execution_coverage_rate: 1, recovered_task_rate: 0, summary_repair_rate: 0 },
    median_runtime_seconds: 1, tasks: [], ...rest,
  };
}
function runCli(file, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf-8', env: { ...process.env, ...extraEnv } });
}

test('passing summary exits zero', () => {
  const d = mkdtempSync(join(tmpdir(), 'assert-'));
  const f = join(d, 'summary.json');
  writeFileSync(f, JSON.stringify(summary()));
  const r = runCli(f);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Checking summary file/);
});

test('missing file exits one', () => {
  const r = runCli(join(tmpdir(), 'nope-' + Date.now() + '.json'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found/);
});

test('wrong arg count exits one', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage/);
});

test('executed != configured fails', () => {
  assert.equal(summaryPassesGate(summary({ totals: { configured_tasks: 2, executed_tasks: 1, tasks: 1, passed: 1 } })), false);
});
test('passed != tasks fails', () => {
  assert.equal(summaryPassesGate(summary({ totals: { passed: 1 } })), false);
});
test('tool_failures fails', () => {
  assert.equal(summaryPassesGate(summary({ totals: { tool_failures: 1 } })), false);
});
test('policy_violations fails', () => {
  assert.equal(summaryPassesGate(summary({ totals: { policy_violations: 1 } })), false);
});
test('unresolved_tasks fails', () => {
  assert.equal(summaryPassesGate(summary({ totals: { unresolved_tasks: 1 } })), false);
});
test('zero configured fails', () => {
  assert.equal(summaryPassesGate(summary({ totals: { configured_tasks: 0, executed_tasks: 0, tasks: 0, passed: 0 } })), false);
});
test('missing unresolved field treated as zero passes', () => {
  const s = summary(); delete s.totals.unresolved_tasks;
  assert.equal(summaryPassesGate(s), true);
});
test('recovered ceiling passes when under', () => {
  assert.equal(summaryPassesGate(summary({ totals: { recovered_tasks: 2 } }), { maxRecoveredTasks: '2' }), true);
});
test('recovered ceiling fails when over', () => {
  assert.equal(summaryPassesGate(summary({ totals: { recovered_tasks: 3 } }), { maxRecoveredTasks: '2' }), false);
});
test('summary repaired ceiling passes when under', () => {
  assert.equal(summaryPassesGate(summary({ totals: { summary_repaired: 1 } }), { maxSummaryRepairedTasks: '1' }), true);
});
test('summary repaired ceiling fails when over', () => {
  assert.equal(summaryPassesGate(summary({ totals: { summary_repaired: 5 } }), { maxSummaryRepairedTasks: '2' }), false);
});
test('both ceilings set pass', () => {
  assert.equal(summaryPassesGate(summary({ totals: { recovered_tasks: 1, summary_repaired: 1 } }), { maxRecoveredTasks: '2', maxSummaryRepairedTasks: '2' }), true);
});

// ---------- Stage 6 gate-line split (functional / dispatch-observed / dispatch-enforced) ----------

// A summary whose only failing tasks are observed-mode dispatch failures:
// the functional line passes (the fix + pytest are correct), dispatch-observed
// fails (honest capability signal). This is the glm-5.2:cloud under-delegation
// shape — functional progress must not be masked by the dispatch signal.
function taskWith(id, mode, failures) {
  return { task_id: id, status: failures.length ? 'failed' : 'passed', dispatch_mode: mode, failures };
}
function summaryWithTasks(tasks) {
  const s = summary();
  s.totals.configured_tasks = tasks.length;
  s.totals.executed_tasks = tasks.length;
  s.totals.tasks = tasks.length;
  s.totals.passed = tasks.filter((t) => t.status === 'passed').length;
  s.totals.tool_failures = tasks.filter((t) => t.status !== 'passed').length;
  s.totals.unresolved_tasks = tasks.filter((t) => t.status !== 'passed').length;
  s.tasks = tasks;
  return s;
}

test('observed dispatch failure does not fail the functional gate', () => {
  const s = summaryWithTasks([
    taskWith('bug-lite', 'observed', ['required_used_agents_missing']),
    taskWith('tester-lite', 'observed', ['required_used_agent_groups_missing']),
  ]);
  assert.equal(summaryFunctionalPassesGate(s), true);
  assert.equal(taskFunctionalFailures(s.tasks[0]).length, 0);
  assert.equal(taskDispatchLineFailures(s.tasks[0], 'observed').length, 1);
});

test('observed dispatch failure is reported as a failed dispatch-observed line', () => {
  const s = summaryWithTasks([
    taskWith('bug-lite', 'observed', ['required_used_agents_missing']),
  ]);
  const obs = dispatchLineReport(s, 'observed');
  assert.equal(obs.status, 'failed');
  assert.equal(obs.failed, 1);
  assert.deepEqual(obs.failedTaskIds, ['bug-lite']);
});

test('a real functional failure on an observed task fails the functional gate', () => {
  const s = summaryWithTasks([
    taskWith('bug-lite', 'observed', ['verification_failed', 'required_used_agents_missing']),
  ]);
  assert.equal(summaryFunctionalPassesGate(s), false);
  // dispatch failure is still partitioned out of functional failures
  assert.deepEqual(taskFunctionalFailures(s.tasks[0]), ['verification_failed']);
});

test('standard-mode dispatch failure stays in the functional line (union-credited)', () => {
  const s = summaryWithTasks([
    taskWith('review-task', 'standard', ['required_used_agents_missing']),
  ]);
  assert.equal(summaryFunctionalPassesGate(s), false);
  assert.deepEqual(taskFunctionalFailures(s.tasks[0]), ['required_used_agents_missing']);
  // standard-mode tasks do not appear on the dispatch-observed line
  assert.equal(dispatchLineReport(s, 'observed').status, 'no-observed-tasks');
});

test('enforced-mode dispatch failure is excluded from functional, counted on its own line', () => {
  const s = summaryWithTasks([
    taskWith('bug-forced', 'enforced', ['required_used_agents_missing']),
  ]);
  assert.equal(summaryFunctionalPassesGate(s), true);
  const enf = dispatchLineReport(s, 'enforced');
  assert.equal(enf.status, 'failed');
  assert.equal(enf.failed, 1);
});

test('no observed tasks -> dispatch-observed line is n/a', () => {
  const s = summaryWithTasks([taskWith('review-task', 'standard', [])]);
  assert.equal(dispatchLineReport(s, 'observed').status, 'no-observed-tasks');
  assert.equal(dispatchLineReport(s, 'enforced').status, 'no-enforced-tasks');
});

test('renderGateLines labels the three named lines', () => {
  const s = summaryWithTasks([
    taskWith('bug-lite', 'observed', ['required_used_agents_missing']),
  ]);
  const text = renderGateLines(true, dispatchLineReport(s, 'observed'), dispatchLineReport(s, 'enforced'));
  assert.match(text, /- functional: PASSED \(merge-blocking\)/);
  assert.match(text, /- dispatch-observed: FAILED — 1\/1 observed tasks did NOT call the Agent tool/);
  assert.match(text, /bug-lite/);
  assert.match(text, /- dispatch-enforced: n\/a \(no enforced-mode tasks; Stage 5 not wired\)/);
});

test('CLI exits 0 when only dispatch-observed fails (functional passes)', () => {
  const d = mkdtempSync(join(tmpdir(), 'assert-'));
  const f = join(d, 'summary.json');
  writeFileSync(f, JSON.stringify(summaryWithTasks([
    taskWith('bug-lite', 'observed', ['required_used_agents_missing']),
    taskWith('tester-lite', 'observed', ['required_used_agents_missing']),
  ])));
  const r = runCli(f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /functional: PASSED/);
  assert.match(r.stdout, /dispatch-observed: FAILED/);
  assert.match(r.stdout, /honest capability signal/);
});

test('CLI exits 1 when the functional gate fails', () => {
  const d = mkdtempSync(join(tmpdir(), 'assert-'));
  const f = join(d, 'summary.json');
  writeFileSync(f, JSON.stringify(summaryWithTasks([
    taskWith('bug-lite', 'observed', ['verification_failed', 'required_used_agents_missing']),
  ])));
  const r = runCli(f);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /functional gate FAILED/);
  assert.match(r.stdout, /functional: FAILED/);
});
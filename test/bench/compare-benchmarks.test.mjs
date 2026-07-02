// Node tests for scripts/compare-benchmarks.mjs (port of the Python test).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildComparison } from '../../scripts/compare-benchmarks.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'compare-benchmarks.mjs');

function summary(overrides = {}) {
  const totals = { configured_tasks: 2, selected_tasks: 2, executed_tasks: 2, unexecuted_tasks: 0, unresolved_tasks: 0, tasks: 2, passed: 2, clean_passed: 2, completed: 2, verification_required: 0, tests_run: 0, review_required: 0, review_present: 0, docs_required: 0, docs_updated: 0, recovered_tasks: 0, timeout_recovered: 0, max_turns_recovered: 0, summary_repaired: 0, policy_violations: 0, tool_failures: 0, ...(overrides.totals || {}) };
  const rates = { task_pass_rate: 1.0, clean_pass_rate: 1.0, completion_rate: 1.0, verification_pass_rate: 1.0, review_compliance_rate: 1.0, docs_compliance_rate: 1.0, execution_coverage_rate: 1.0, recovered_task_rate: 0.0, summary_repair_rate: 0.0, ...(overrides.rates || {}) };
  const { totals: _t, rates: _r, ...rest } = overrides;
  return { schema_version: '1.0', mode: 'cmd', runner: 'r', generated_at: '2026-01-01T00:00:00Z', source_ref: 'ref', source_sha: 'sha', task_glob: 'g', totals, rates, median_runtime_seconds: 10.0, tasks: [], ...rest };
}

function runCli(d, baseline, candidate) {
  const b = join(d, 'baseline.json');
  const c = join(d, 'candidate.json');
  writeFileSync(b, JSON.stringify(baseline));
  writeFileSync(c, JSON.stringify(candidate));
  const r = spawnSync(process.execPath, [SCRIPT, b, c], { encoding: 'utf-8' });
  return { rc: r.status, doc: r.status === 0 && r.stdout.trim() ? JSON.parse(r.stdout) : {} };
}

test('no significant change', () => {
  const d = mkdtempSync(join(tmpdir(), 'cmp-'));
  const { rc, doc } = runCli(d, summary(), summary());
  assert.equal(rc, 0);
  assert.equal(doc.verdict, 'no_significant_change');
  assert.deepEqual(doc.reasons, []);
  assert.equal(doc.schema_version, '1.0');
  for (const v of Object.values(doc.deltas)) assert.equal(v, 0);
});

test('regressed on task_pass_rate', () => {
  const d = mkdtempSync(join(tmpdir(), 'cmp-'));
  const { rc, doc } = runCli(d, summary({ rates: { task_pass_rate: 0.9 } }), summary({ rates: { task_pass_rate: 0.8 } }));
  assert.equal(rc, 0);
  assert.equal(doc.verdict, 'regressed');
  assert.ok(doc.reasons.includes('task_pass_rate decreased'));
  assert.ok(Math.abs(doc.deltas.task_pass_rate - (-0.1)) < 1e-9);
});

test('regressed on policy_violations', () => {
  const d = mkdtempSync(join(tmpdir(), 'cmp-'));
  const { rc, doc } = runCli(d, summary({ totals: { policy_violations: 0 } }), summary({ totals: { policy_violations: 2 } }));
  assert.equal(rc, 0);
  assert.equal(doc.verdict, 'regressed');
  assert.ok(doc.reasons.includes('policy_violations increased'));
  assert.equal(doc.deltas.policy_violations, 2);
});

test('regressed on tool_failures', () => {
  const d = mkdtempSync(join(tmpdir(), 'cmp-'));
  const { rc, doc } = runCli(d, summary({ totals: { tool_failures: 0 } }), summary({ totals: { tool_failures: 1 } }));
  assert.equal(rc, 0);
  assert.equal(doc.verdict, 'regressed');
  assert.ok(doc.reasons.includes('tool_failures increased'));
});

test('regressed on docs_compliance', () => {
  const d = mkdtempSync(join(tmpdir(), 'cmp-'));
  const { rc, doc } = runCli(d, summary({ rates: { docs_compliance_rate: 1.0 } }), summary({ rates: { docs_compliance_rate: 0.5 } }));
  assert.equal(rc, 0);
  assert.equal(doc.verdict, 'regressed');
  assert.ok(doc.reasons.includes('docs_compliance_rate decreased'));
});

test('improved on task_pass_rate', () => {
  const d = mkdtempSync(join(tmpdir(), 'cmp-'));
  const { rc, doc } = runCli(d, summary({ rates: { task_pass_rate: 0.7 } }), summary({ rates: { task_pass_rate: 0.9 } }));
  assert.equal(rc, 0);
  assert.equal(doc.verdict, 'improved');
  assert.ok(Math.abs(doc.deltas.task_pass_rate - 0.2) < 1e-9);
});

test('improved on fewer policy_violations', () => {
  const d = mkdtempSync(join(tmpdir(), 'cmp-'));
  const { rc, doc } = runCli(d, summary({ totals: { policy_violations: 3 } }), summary({ totals: { policy_violations: 0 } }));
  assert.equal(rc, 0);
  assert.equal(doc.verdict, 'improved');
  assert.equal(doc.deltas.policy_violations, -3);
});

test('improved on faster runtime with equal rates', () => {
  const d = mkdtempSync(join(tmpdir(), 'cmp-'));
  const { rc, doc } = runCli(d, summary({ median_runtime_seconds: 20.0 }), summary({ median_runtime_seconds: 10.0 }));
  assert.equal(rc, 0);
  assert.equal(doc.verdict, 'improved');
  assert.ok(doc.reasons.includes('median_runtime_seconds improved'));
  assert.equal(doc.deltas.median_runtime_seconds, -10.0);
});

test('faster runtime alone with rate drop is regression', () => {
  const d = mkdtempSync(join(tmpdir(), 'cmp-'));
  const { rc, doc } = runCli(d, summary({ rates: { task_pass_rate: 0.9 }, median_runtime_seconds: 20.0 }), summary({ rates: { task_pass_rate: 0.8 }, median_runtime_seconds: 10.0 }));
  assert.equal(rc, 0);
  assert.equal(doc.verdict, 'regressed');
  assert.ok(!doc.reasons.includes('median_runtime_seconds improved'));
});

test('baseline candidate snapshots copied', () => {
  const d = mkdtempSync(join(tmpdir(), 'cmp-'));
  const base = summary({ source_ref: 'main', source_sha: 'aaa', mode: 'mock' });
  const cand = summary({ source_ref: 'feat', source_sha: 'bbb', mode: 'cmd' });
  const { rc, doc } = runCli(d, base, cand);
  assert.equal(rc, 0);
  assert.equal(doc.baseline.ref, 'main');
  assert.equal(doc.baseline.sha, 'aaa');
  assert.equal(doc.baseline.mode, 'mock');
  assert.equal(doc.candidate.ref, 'feat');
  assert.equal(doc.candidate.sha, 'bbb');
  assert.equal(doc.candidate.mode, 'cmd');
});

test('wrong arg count exits one', () => {
  let r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage/);
  r = spawnSync(process.execPath, [SCRIPT, 'only-one'], { encoding: 'utf-8' });
  assert.equal(r.status, 1);
});

test('buildComparison unit no change', () => {
  const doc = buildComparison(summary(), summary());
  assert.equal(doc.verdict, 'no_significant_change');
});
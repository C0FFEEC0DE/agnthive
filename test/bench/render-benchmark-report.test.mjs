// Node tests for scripts/render-benchmark-report.mjs (port of the Python test).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderReport } from '../../scripts/render-benchmark-report.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'render-benchmark-report.mjs');
const COMPARE = join(REPO, 'scripts', 'compare-benchmarks.mjs');

function comparison({ verdict = 'improved', reasons = null, baselineMode = 'cmd', candidateMode = 'cmd' } = {}) {
  return {
    schema_version: '1.0',
    baseline: { ref: 'main', sha: 'aaa', mode: baselineMode, totals: { configured_tasks: 2, executed_tasks: 2, policy_violations: 1, tool_failures: 0, recovered_tasks: 0, summary_repaired: 0 }, rates: { execution_coverage_rate: 1.0, task_pass_rate: 0.8, clean_pass_rate: 0.8, completion_rate: 1.0, verification_pass_rate: 0.9, review_compliance_rate: 1.0, docs_compliance_rate: 1.0, recovered_task_rate: 0.0, summary_repair_rate: 0.0 }, median_runtime_seconds: 20.0 },
    candidate: { ref: 'feat', sha: 'bbb', mode: candidateMode, totals: { configured_tasks: 2, executed_tasks: 2, policy_violations: 0, tool_failures: 0, recovered_tasks: 0, summary_repaired: 0 }, rates: { execution_coverage_rate: 1.0, task_pass_rate: 0.9, clean_pass_rate: 0.9, completion_rate: 1.0, verification_pass_rate: 0.9, review_compliance_rate: 1.0, docs_compliance_rate: 1.0, recovered_task_rate: 0.0, summary_repair_rate: 0.0 }, median_runtime_seconds: 10.0 },
    deltas: { task_pass_rate: 0.1, clean_pass_rate: 0.1, completion_rate: 0.0, verification_pass_rate: 0.0, review_compliance_rate: 0.0, docs_compliance_rate: 0.0, execution_coverage_rate: 0.0, recovered_task_rate: 0.0, summary_repair_rate: 0.0, policy_violations: -1, tool_failures: 0, median_runtime_seconds: -10.0 },
    verdict, reasons: reasons || [],
  };
}

function runCli(d, doc) {
  const p = join(d, 'cmp.json');
  writeFileSync(p, JSON.stringify(doc));
  return spawnSync(process.execPath, [SCRIPT, p], { encoding: 'utf-8' });
}

test('renders table and verdict', () => {
  const d = mkdtempSync(join(tmpdir(), 'rbr-'));
  const r = runCli(d, comparison());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## Benchmark Report/);
  assert.match(r.stdout, /\| Metric \| Baseline \| Candidate \| Delta \|/);
  assert.match(r.stdout, /\| Task pass rate \| 80% \| 90% \| 10% \|/);
  assert.match(r.stdout, /\*\*Verdict:\*\* `improved`/);
});

test('negative delta percentage rendered', () => {
  const d = mkdtempSync(join(tmpdir(), 'rbr-'));
  // Write the comparison fixture as a raw string to preserve "20.0"/"10.0"/
  // "-10.0" number literals (JSON.stringify would collapse 20.0 -> 20).
  // render-benchmark-report uses a literal-preserving reader, so it must
  // reproduce the exact literals jq would pass through.
  const doc = comparison();
  const raw =
    '{\n' +
    `  "schema_version": "1.0",\n` +
    `  "baseline": {"ref":"main","sha":"aaa","mode":"cmd","totals":{"configured_tasks":2,"executed_tasks":2,"policy_violations":1,"tool_failures":0,"recovered_tasks":0,"summary_repaired":0},"rates":{"execution_coverage_rate":1.0,"task_pass_rate":0.8,"clean_pass_rate":0.8,"completion_rate":1.0,"verification_pass_rate":0.9,"review_compliance_rate":1.0,"docs_compliance_rate":1.0,"recovered_task_rate":0.0,"summary_repair_rate":0.0},"median_runtime_seconds":20.0},\n` +
    `  "candidate": {"ref":"feat","sha":"bbb","mode":"cmd","totals":{"configured_tasks":2,"executed_tasks":2,"policy_violations":0,"tool_failures":0,"recovered_tasks":0,"summary_repaired":0},"rates":{"execution_coverage_rate":1.0,"task_pass_rate":0.9,"clean_pass_rate":0.9,"completion_rate":1.0,"verification_pass_rate":0.9,"review_compliance_rate":1.0,"docs_compliance_rate":1.0,"recovered_task_rate":0.0,"summary_repair_rate":0.0},"median_runtime_seconds":10.0},\n` +
    `  "deltas":{"task_pass_rate":0.1,"clean_pass_rate":0.1,"completion_rate":0.0,"verification_pass_rate":0.0,"review_compliance_rate":0.0,"docs_compliance_rate":0.0,"execution_coverage_rate":0.0,"recovered_task_rate":0.0,"summary_repair_rate":0.0,"policy_violations":-1,"tool_failures":0,"median_runtime_seconds":-10.0},\n` +
    `  "verdict":"improved","reasons":[]\n` +
    '}';
  const p = join(d, 'cmp.json');
  writeFileSync(p, raw);
  const r = spawnSync(process.execPath, [SCRIPT, p], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\| Policy violations \| 1 \| 0 \| -1 \|/);
  assert.match(r.stdout, /\| Median runtime \(s\) \| 20.0 \| 10.0 \| -10.0 \|/);
});

test('mock mode note when either side mock', () => {
  const d = mkdtempSync(join(tmpdir(), 'rbr-'));
  const r = runCli(d, comparison({ baselineMode: 'mock' }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /at least one side ran in mock mode/);
  assert.match(r.stdout, /BENCH_RUNNER_CMD/);
});

test('no mock note when both cmd', () => {
  const d = mkdtempSync(join(tmpdir(), 'rbr-'));
  const r = runCli(d, comparison({ baselineMode: 'cmd', candidateMode: 'cmd' }));
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /ran in mock mode/);
});

test('reasons rendered when present', () => {
  const d = mkdtempSync(join(tmpdir(), 'rbr-'));
  const r = runCli(d, comparison({ reasons: ['task_pass_rate increased', 'policy_violations decreased'] }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\*\*Reasons:\*\*/);
  assert.match(r.stdout, /- task_pass_rate increased/);
  assert.match(r.stdout, /- policy_violations decreased/);
});

test('no reasons section when empty', () => {
  const d = mkdtempSync(join(tmpdir(), 'rbr-'));
  const r = runCli(d, comparison({ reasons: [] }));
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /\*\*Reasons:\*\*/);
});

test('wrong arg count exits one', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage/);
});

test('end to end compare then render', () => {
  const d = mkdtempSync(join(tmpdir(), 'rbr-'));
  // Summaries written as raw strings to preserve "20.0"/"10.0" float literals
  // so compare-benchmarks (literal-preserving) passes them through. The delta
  // is computed (10.0 - 20.0 = -10) and rendered canonically as "-10".
  const smryRaw = (taskPassRate, policyViolations, median) =>
    `{"schema_version":"1.0","mode":"cmd","runner":"r","generated_at":"x","source_ref":"r","source_sha":"s","task_glob":"g","totals":{"configured_tasks":2,"executed_tasks":2,"policy_violations":${policyViolations},"tool_failures":0,"recovered_tasks":0,"summary_repaired":0},"rates":{"task_pass_rate":${taskPassRate},"clean_pass_rate":${taskPassRate},"completion_rate":1.0,"verification_pass_rate":1.0,"review_compliance_rate":1.0,"docs_compliance_rate":1.0,"execution_coverage_rate":1.0,"recovered_task_rate":0.0,"summary_repair_rate":0.0},"median_runtime_seconds":${median},"tasks":[]}`;
  const b = join(d, 'b.json');
  const c = join(d, 'c.json');
  writeFileSync(b, smryRaw(0.8, 1, '20.0'));
  writeFileSync(c, smryRaw(0.9, 0, '10.0'));
  const cmp = spawnSync(process.execPath, [COMPARE, b, c], { encoding: 'utf-8' });
  assert.equal(cmp.status, 0, cmp.stderr);
  const cmpPath = join(d, 'cmp.json');
  writeFileSync(cmpPath, cmp.stdout);
  const r = spawnSync(process.execPath, [SCRIPT, cmpPath], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\*\*Verdict:\*\* `improved`/);
  assert.match(r.stdout, /\| Clean pass rate \|/);
  assert.match(r.stdout, /\| Recovered task rate \|/);
  assert.match(r.stdout, /\| Summary repair rate \|/);
  // Pass-through medians preserved; computed delta canonical (no trailing .0).
  assert.match(r.stdout, /\| Median runtime \(s\) \| 20.0 \| 10.0 \| -10 \|/);
});

test('renderReport unit verdict', () => {
  const out = renderReport(comparison());
  assert.match(out, /\*\*Verdict:\*\* `improved`/);
});
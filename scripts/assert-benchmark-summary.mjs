#!/usr/bin/env node
// assert-benchmark-summary: CI gate that decides whether a benchmark run passed.
// Node port of scripts/assert-benchmark-summary.sh — no jq, no Bash.
//
// Stage 6 of the dispatch-stabilization plan splits the result into three
// named lines. The CLI exits non-zero ONLY on the functional line (the
// merge-blocking check). The dispatch-observed and dispatch-enforced lines
// are printed as visible, non-blocking capability signals — they are never
// masked or "repaired" through final text; if dispatch-observed stays red,
// that is an honest model-capability signal, not a CI failure.
import { readFileSync, existsSync } from 'node:fs';
import { isMain, taskFunctionalFailures, dispatchLineReport } from './bench/lib.mjs';

function usage() {
  process.stderr.write('Usage: assert-benchmark-summary.mjs SUMMARY_JSON\n');
  process.exit(1);
}

function fail(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

export function summaryPassesGate(summary, opts = {}) {
  const t = summary.totals || {};
  const maxRecovered = opts.maxRecoveredTasks;
  const maxRepaired = opts.maxSummaryRepairedTasks;
  const checks = [
    t.configured_tasks > 0,
    t.executed_tasks > 0,
    t.executed_tasks === t.configured_tasks,
    t.tasks === t.executed_tasks,
    t.passed === t.tasks,
    t.tool_failures === 0,
    t.policy_violations === 0,
    (t.unresolved_tasks ?? 0) === 0,
  ];
  if (maxRecovered !== undefined && maxRecovered !== null && maxRecovered !== '') {
    checks.push((t.recovered_tasks ?? 0) <= Number(maxRecovered));
  }
  if (maxRepaired !== undefined && maxRepaired !== null && maxRepaired !== '') {
    checks.push((t.summary_repaired ?? 0) <= Number(maxRepaired));
  }
  return checks.every(Boolean);
}

// Functional line (merge-blocking): every task has no functional failures
// (dispatch-line failures excluded for observed/enforced tasks), plus the
// structural execution-coverage and policy checks. Replaces the strict
// `passed === tasks` / `tool_failures === 0` / `unresolved_tasks === 0`
// totals, which are polluted by dispatch-line failures — a dispatch-failed
// task still has status 'failed' and so depresses `passed` and inflates
// `tool_failures` / `unresolved_tasks` even when the fix itself is correct.
export function summaryFunctionalPassesGate(summary, opts = {}) {
  const t = summary.totals || {};
  const tasks = Array.isArray(summary.tasks) ? summary.tasks : [];
  const maxRecovered = opts.maxRecoveredTasks;
  const maxRepaired = opts.maxSummaryRepairedTasks;
  const checks = [
    Number(t.configured_tasks) > 0,
    Number(t.executed_tasks) > 0,
    Number(t.executed_tasks) === Number(t.configured_tasks),
    Number(t.tasks) === Number(t.executed_tasks),
    Number(t.policy_violations) === 0,
  ];
  for (const task of tasks) {
    checks.push(taskFunctionalFailures(task).length === 0);
  }
  if (maxRecovered !== undefined && maxRecovered !== null && maxRecovered !== '') {
    checks.push((t.recovered_tasks ?? 0) <= Number(maxRecovered));
  }
  if (maxRepaired !== undefined && maxRepaired !== null && maxRepaired !== '') {
    checks.push((t.summary_repaired ?? 0) <= Number(maxRepaired));
  }
  return checks.every(Boolean);
}

// Render the three named gate lines as plain text for CI step output.
export function renderGateLines(functionalOk, observed, enforced) {
  const lines = ['Benchmark gate lines:'];
  lines.push(`- functional: ${functionalOk ? 'PASSED (merge-blocking)' : 'FAILED (merge-blocking)'}`);
  lines.push(`- dispatch-observed: ${dispatchLineLabel(observed, { past: 'called the Agent tool', base: 'call the Agent tool' })}`);
  lines.push(`- dispatch-enforced: ${dispatchLineLabel(enforced, { past: 'dispatched after the hard guard', base: 'dispatch after the hard guard' })}`);
  return lines.join('\n');
}

function dispatchLineLabel(report, verbs) {
  if (report.status === 'no-observed-tasks') return 'n/a (no observed-mode tasks this run)';
  if (report.status === 'no-enforced-tasks') return 'n/a (no enforced-mode tasks; Stage 5 not wired)';
  if (report.status === 'passed') {
    return `PASSED — ${report.passed}/${report.total} ${report.mode} tasks ${verbs.past} (non-blocking capability signal)`;
  }
  const ids = report.failedTaskIds.length ? `: ${report.failedTaskIds.join(', ')}` : '';
  return `FAILED — ${report.failed}/${report.total} ${report.mode} tasks did NOT ${verbs.base} (non-blocking, honest capability signal)${ids}`;
}

function main() {
  if (process.argv.length !== 3) usage();
  const summaryFile = process.argv[2];
  if (!existsSync(summaryFile)) {
    process.stderr.write(`ERROR: Summary file not found: ${summaryFile}\n`);
    process.exit(1);
  }
  process.stdout.write(`Checking summary file: ${summaryFile}\n`);
  process.stdout.write('File contents:\n');
  try {
    process.stderr.write(readFileSync(summaryFile, 'utf-8') + '\n');
  } catch {
    process.stderr.write('(cannot read file)\n');
  }
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryFile, 'utf-8'));
  } catch {
    fail('Benchmark summary is not valid JSON!');
  }
  const opts = {
    maxRecoveredTasks: process.env.BENCH_MAX_RECOVERED_TASKS ?? '',
    maxSummaryRepairedTasks: process.env.BENCH_MAX_SUMMARY_REPAIRED_TASKS ?? '',
  };
  const functionalOk = summaryFunctionalPassesGate(summary, opts);
  const observed = dispatchLineReport(summary, 'observed');
  const enforced = dispatchLineReport(summary, 'enforced');
  process.stdout.write(renderGateLines(functionalOk, observed, enforced) + '\n');
  if (!functionalOk) {
    process.stderr.write('ERROR: Benchmark functional gate FAILED!\n');
    process.stderr.write('Summary contents:\n');
    process.stderr.write(readFileSync(summaryFile, 'utf-8') + '\n');
    process.exit(1);
  }
  // Functional gate passed. dispatch-observed / dispatch-enforced are visible
  // non-blocking capability signals (printed above) — they must NOT be masked
  // or repaired through final text. A red dispatch-observed line is an honest
  // model-capability signal, not a CI failure, so the step exits 0.
}

if (isMain(import.meta.url)) {
  main();
}
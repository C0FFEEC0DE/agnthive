#!/usr/bin/env node
// render-benchmark-summary: render a summary.json as markdown.
// Node port of scripts/render-benchmark-summary.sh — no jq, no Bash.
import { isMain, readJsonPreserving, pct, truncateCell, listOrDash, taskFunctionalFailures, dispatchLineReport } from './bench/lib.mjs';
import { summaryFunctionalPassesGate } from './assert-benchmark-summary.mjs';

function verificationStatus(t) {
  if (t.verification_required === true) {
    if (t.tests_run === true) return t.tests_passed === true ? 'passed' : 'failed';
    return 'not-run';
  }
  return 'not-required';
}
function reviewStatus(t) {
  if (t.review_required === true) return t.review_present === true ? 'done' : 'missing';
  return 'not-required';
}
function docsStatus(t) {
  if (t.docs_required === true) return t.docs_updated === true ? 'updated' : 'missing';
  return 'not-required';
}
function recoveryStatus(t) {
  if (t.timeout_recovered === true) return 'timeout';
  if (t.max_turns_recovered === true) return 'max-turns';
  if (t.recovered_nonzero_exit === true) return 'recovered';
  return 'none';
}
function dispatchLineDetail(report, verbs) {
  if (report.status === 'no-observed-tasks') return 'no observed-mode tasks this run';
  if (report.status === 'no-enforced-tasks') return 'no enforced-mode tasks (Stage 5 not wired)';
  if (report.status === 'passed') return `${report.passed}/${report.total} ${report.mode} tasks ${verbs.past}`;
  const ids = report.failedTaskIds.length ? ` — ${report.failedTaskIds.join(', ')}` : '';
  return `${report.failed}/${report.total} ${report.mode} tasks did NOT ${verbs.base}${ids}`;
}

function taskRows(ids, paths) {
  const idList = ids || [];
  const pathList = paths || [];
  const count = Math.max(idList.length, pathList.length);
  if (count === 0) return [];
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({ id: idList[i] || '', path: pathList[i] || '' });
  }
  return rows;
}

function renderTaskSection(title, ids, paths) {
  const rows = taskRows(ids, paths);
  if (rows.length === 0) return [];
  const out = ['', `### ${title}`, '', '| Task ID | Task Path |', '| --- | --- |'];
  for (const r of rows) out.push(`| \`${r.id}\` | \`${r.path}\` |`);
  return out;
}

export function renderSummary(summary) {
  const t = summary.totals || {};
  const r = summary.rates || {};
  const lines = [];
  lines.push('### Overview', '', '| Metric | Value |', '| --- | ---: |');
  lines.push(`| Configured tasks | ${t.configured_tasks} |`);
  lines.push(`| Selected tasks | ${t.selected_tasks ?? t.configured_tasks} |`);
  lines.push(`| Executed tasks | ${t.executed_tasks} |`);
  lines.push(`| Unexecuted tasks | ${t.unexecuted_tasks ?? 0} |`);
  lines.push(`| Unresolved tasks | ${t.unresolved_tasks ?? 0} |`);
  lines.push(`| Execution coverage | ${pct(r.execution_coverage_rate)} |`);
  lines.push(`| Pass rate | ${pct(r.task_pass_rate)} |`);
  lines.push(`| Clean pass rate | ${pct(r.clean_pass_rate)} |`);
  lines.push(`| Recovered tasks | ${t.recovered_tasks} |`);
  lines.push(`| Summary repaired tasks | ${t.summary_repaired} |`);
  lines.push(`| Median runtime (s) | ${summary.median_runtime_seconds} |`);

  // Stage 6 gate-line split: surface functional (merge-blocking) vs the
  // dispatch-observed / dispatch-enforced capability signals so a red
  // dispatch line cannot be confused with a functional regression (and vice
  // versa). The assert-benchmark-summary step is the merge-blocking authority;
  // this block mirrors its three named lines for the GitHub step summary.
  const functionalOk = summaryFunctionalPassesGate(summary);
  const observed = dispatchLineReport(summary, 'observed');
  const enforced = dispatchLineReport(summary, 'enforced');
  lines.push('', '### Gate lines', '',
    '| Line | Status | Detail |',
    '| --- | --- | --- |',
    `| functional (merge-blocking) | \`${functionalOk ? 'passed' : 'failed'}\` | fix + verification + review/docs/structure |`,
    `| dispatch-observed | \`${observed.status}\` | ${dispatchLineDetail(observed, { past: 'called the Agent tool', base: 'call the Agent tool' })} |`,
    `| dispatch-enforced | \`${enforced.status}\` | ${dispatchLineDetail(enforced, { past: 'dispatched after the hard guard', base: 'dispatch after the hard guard' })} |`,
    '',
    '> dispatch-observed / dispatch-enforced are visible, non-blocking capability signals. A red dispatch line is an honest model-capability signal, not a functional regression.');

  if ((t.unexecuted_tasks ?? 0) > 0) {
    lines.push('', `> Note: ${t.unexecuted_tasks} selected task(s) did not execute. These are the primary resume candidates after a fail-fast stop.`);
  } else if (t.executed_tasks < t.configured_tasks) {
    lines.push('', `> Note: only ${t.executed_tasks} of ${t.configured_tasks} selected tasks executed.`);
  }

  lines.push('', '### Executed Tasks', '',
    '| Task | Status | Runtime (s) | Verification | Review | Docs | Changed Files | Recovery | Summary Repair | Failures |',
    '| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |');

  const tasks = summary.tasks || [];
  if (tasks.length === 0) {
    lines.push('| — | — | — | — | — | — | — | — | — | No executed tasks |');
  } else {
    for (const task of tasks) {
      lines.push(`| \`${task.task_id}\` | \`${task.status}\` | ${task.runtime_seconds} | \`${verificationStatus(task)}\` | \`${reviewStatus(task)}\` | \`${docsStatus(task)}\` | ${listOrDash(task.changed_files, 72)} | \`${recoveryStatus(task)}\` | \`${task.summary_repaired_by ?? 'none'}\` | ${listOrDash(task.failures, 96)} |`);
    }
  }

  lines.push(...renderTaskSection('Unexecuted Tasks', summary.unexecuted_task_ids, summary.unexecuted_task_paths));
  lines.push(...renderTaskSection('Unresolved Tasks', summary.unresolved_task_ids, summary.unresolved_task_paths));
  return lines.join('\n') + '\n';
}

function usage() {
  process.stderr.write('Usage: render-benchmark-summary.mjs SUMMARY_JSON\n');
  process.exit(1);
}

function main() {
  if (process.argv.length !== 3) usage();
  const summary = readJsonPreserving(process.argv[2]);
  process.stdout.write(renderSummary(summary));
}

if (isMain(import.meta.url)) {
  main();
}
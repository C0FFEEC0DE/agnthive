#!/usr/bin/env node
// merge-benchmark-summaries: merge shard summaries into one aggregate summary.
// Node port of scripts/merge-benchmark-summaries.py — no Python.
import { isMain, readJson, writeJson, median, rate, normalizeStringList } from './bench/lib.mjs';

export { median, rate, normalizeStringList };

export function countPreferred(primary, secondary, fallback = 0) {
  if (primary && primary.length) return primary.length;
  if (secondary && secondary.length) return secondary.length;
  return fallback;
}

export function mergeStringLists(summaryPayloads, fieldName) {
  const merged = [];
  const seen = new Set();
  for (const payload of summaryPayloads) {
    for (const v of normalizeStringList(payload[fieldName])) {
      if (!seen.has(v)) { seen.add(v); merged.push(v); }
    }
  }
  return merged;
}

export function taskIds(tasks) {
  return tasks.map((t) => t.task_id).filter((id) => typeof id === 'string');
}

export function taskPaths(tasks) {
  const paths = [];
  for (const t of tasks) {
    const p = t.task_path || t.task_file || t.path;
    if (typeof p === 'string' && p.trim()) paths.push(p.trim());
  }
  return paths;
}

export function mergeUnique(primary, secondary) {
  const merged = [];
  const seen = new Set();
  for (const v of [...primary, ...secondary]) {
    if (!seen.has(v)) { seen.add(v); merged.push(v); }
  }
  return merged;
}

function countWhere(tasks, pred) {
  return tasks.filter(pred).length;
}

export function mergeSummaries(summaryPayloads) {
  if (!summaryPayloads || summaryPayloads.length === 0) {
    throw new Error('at least one summary is required');
  }
  const first = summaryPayloads[0];
  const tasks = [];
  let configuredTasks = 0;
  let executedTasks = 0;
  for (const p of summaryPayloads) {
    configuredTasks += Number(p.totals.configured_tasks);
    executedTasks += Number(p.totals.executed_tasks);
    for (const t of (p.tasks || [])) tasks.push(t);
  }

  const selectedTaskIds = mergeStringLists(summaryPayloads, 'selected_task_ids');
  const selectedTaskPaths = mergeStringLists(summaryPayloads, 'selected_task_paths');
  let executedTaskIds = mergeStringLists(summaryPayloads, 'executed_task_ids');
  let executedTaskPaths = mergeStringLists(summaryPayloads, 'executed_task_paths');
  const unexecutedTaskIds = mergeStringLists(summaryPayloads, 'unexecuted_task_ids');
  const unexecutedTaskPaths = mergeStringLists(summaryPayloads, 'unexecuted_task_paths');
  let unresolvedTaskIds = mergeStringLists(summaryPayloads, 'unresolved_task_ids');
  let unresolvedTaskPaths = mergeStringLists(summaryPayloads, 'unresolved_task_paths');

  const total = tasks.length;
  const failedTasks = tasks.filter((t) => t.status !== 'passed');
  const passed = countWhere(tasks, (t) => t.status === 'passed');
  const cleanPassed = countWhere(tasks, (t) => t.status === 'passed' && t.recovered_nonzero_exit !== true && (t.summary_repaired_by || 'none') === 'none');
  const completed = countWhere(tasks, (t) => t.completed === true);
  const verificationRequired = countWhere(tasks, (t) => t.verification_required === true);
  const testsRun = countWhere(tasks, (t) => t.tests_run === true);
  const testsPassed = countWhere(tasks, (t) => t.tests_passed === true);
  const reviewRequired = countWhere(tasks, (t) => t.review_required === true);
  const reviewPresent = countWhere(tasks, (t) => t.review_present === true);
  const docsRequired = countWhere(tasks, (t) => t.docs_required === true);
  const docsUpdated = countWhere(tasks, (t) => t.docs_updated === true);
  const recoveredTasks = countWhere(tasks, (t) => t.recovered_nonzero_exit === true);
  const timeoutRecovered = countWhere(tasks, (t) => t.timeout_recovered === true);
  const maxTurnsRecovered = countWhere(tasks, (t) => t.max_turns_recovered === true);
  const summaryRepaired = countWhere(tasks, (t) => (t.summary_repaired_by || 'none') !== 'none');
  const policyViolations = tasks.reduce((s, t) => s + Number(t.policy_violations || 0), 0);
  const toolFailures = tasks.reduce((s, t) => s + Number(t.tool_failures || 0), 0);

  const selectedTotal = countPreferred(selectedTaskIds, selectedTaskPaths, configuredTasks);
  const unexecutedTotal = countPreferred(unexecutedTaskIds, unexecutedTaskPaths, Math.max(selectedTotal - executedTasks, 0));
  const unresolvedTotal = countPreferred(unresolvedTaskIds, unresolvedTaskPaths, failedTasks.length + unexecutedTotal);

  if (!executedTaskIds.length) executedTaskIds = taskIds(tasks);
  if (!executedTaskPaths.length) executedTaskPaths = taskPaths(tasks);
  if (!unresolvedTaskIds.length) unresolvedTaskIds = mergeUnique(taskIds(failedTasks), unexecutedTaskIds);
  if (!unresolvedTaskPaths.length) unresolvedTaskPaths = mergeUnique(taskPaths(failedTasks), unexecutedTaskPaths);

  return {
    schema_version: first.schema_version,
    mode: first.mode,
    runner: first.runner,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source_ref: first.source_ref,
    source_sha: first.source_sha,
    task_glob: first.task_glob,
    selected_task_ids: selectedTaskIds,
    selected_task_paths: selectedTaskPaths,
    executed_task_ids: executedTaskIds,
    executed_task_paths: executedTaskPaths,
    unexecuted_task_ids: unexecutedTaskIds,
    unexecuted_task_paths: unexecutedTaskPaths,
    unresolved_task_ids: unresolvedTaskIds,
    unresolved_task_paths: unresolvedTaskPaths,
    totals: {
      configured_tasks: configuredTasks,
      selected_tasks: selectedTotal,
      executed_tasks: executedTasks,
      unexecuted_tasks: unexecutedTotal,
      unresolved_tasks: unresolvedTotal,
      tasks: executedTasks,
      passed,
      clean_passed: cleanPassed,
      completed,
      verification_required: verificationRequired,
      tests_run: testsRun,
      tests_passed: testsPassed,
      review_required: reviewRequired,
      review_present: reviewPresent,
      docs_required: docsRequired,
      docs_updated: docsUpdated,
      recovered_tasks: recoveredTasks,
      timeout_recovered: timeoutRecovered,
      max_turns_recovered: maxTurnsRecovered,
      summary_repaired: summaryRepaired,
      policy_violations: policyViolations,
      tool_failures: toolFailures,
    },
    rates: {
      task_pass_rate: rate(passed, total),
      clean_pass_rate: rate(cleanPassed, total),
      completion_rate: rate(completed, total),
      verification_rate: rate(countWhere(tasks, (t) => t.verification_required === false || t.tests_run === true), total),
      verification_pass_rate: rate(countWhere(tasks, (t) => t.verification_required === false || t.tests_passed === true), total),
      review_compliance_rate: rate(countWhere(tasks, (t) => t.review_required === false || t.review_present === true), total),
      docs_compliance_rate: rate(countWhere(tasks, (t) => t.docs_required === false || t.docs_updated === true), total),
      recovered_task_rate: rate(recoveredTasks, total),
      summary_repair_rate: rate(summaryRepaired, total),
      execution_coverage_rate: rate(executedTasks, configuredTasks),
      unexecuted_rate: rate(unexecutedTotal, selectedTotal),
      unresolved_rate: rate(unresolvedTotal, selectedTotal),
    },
    median_runtime_seconds: median(tasks.map((t) => Number(t.runtime_seconds))),
    tasks,
  };
}

function parseArgs(argv) {
  const out = { output: null, summaryFiles: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output') { out.output = argv[++i]; }
    else { out.summaryFiles.push(a); }
  }
  if (!out.output) { process.stderr.write('Usage: merge-benchmark-summaries.mjs --output FILE SUMMARY... \n'); process.exit(2); }
  if (out.summaryFiles.length === 0) { process.stderr.write('at least one summary is required\n'); process.exit(2); }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payloads = args.summaryFiles.map((f) => readJson(f));
  const merged = mergeSummaries(payloads);
  writeJson(args.output, merged);
}

if (isMain(import.meta.url)) {
  main();
}
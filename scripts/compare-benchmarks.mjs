#!/usr/bin/env node
// compare-benchmarks: diff two benchmark summaries into a comparison document
// with baseline/candidate snapshots, deltas, a verdict, and reasons.
// Node port of scripts/compare-benchmarks.sh — no jq, no Bash.
import { isMain, readJsonPreserving, stringifyJsonPreserving } from './bench/lib.mjs';

export function buildComparison(baseline, candidate) {
  const b = baseline, c = candidate;
  const deltas = {
    task_pass_rate: c.rates.task_pass_rate - b.rates.task_pass_rate,
    clean_pass_rate: c.rates.clean_pass_rate - b.rates.clean_pass_rate,
    completion_rate: c.rates.completion_rate - b.rates.completion_rate,
    verification_pass_rate: c.rates.verification_pass_rate - b.rates.verification_pass_rate,
    review_compliance_rate: c.rates.review_compliance_rate - b.rates.review_compliance_rate,
    docs_compliance_rate: c.rates.docs_compliance_rate - b.rates.docs_compliance_rate,
    execution_coverage_rate: c.rates.execution_coverage_rate - b.rates.execution_coverage_rate,
    recovered_task_rate: c.rates.recovered_task_rate - b.rates.recovered_task_rate,
    summary_repair_rate: c.rates.summary_repair_rate - b.rates.summary_repair_rate,
    policy_violations: c.totals.policy_violations - b.totals.policy_violations,
    tool_failures: c.totals.tool_failures - b.totals.tool_failures,
    median_runtime_seconds: c.median_runtime_seconds - b.median_runtime_seconds,
  };
  const cmp = {
    schema_version: '1.0',
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    baseline: {
      ref: b.source_ref, sha: b.source_sha, mode: b.mode,
      totals: b.totals, rates: b.rates, median_runtime_seconds: b.median_runtime_seconds,
    },
    candidate: {
      ref: c.source_ref, sha: c.source_sha, mode: c.mode,
      totals: c.totals, rates: c.rates, median_runtime_seconds: c.median_runtime_seconds,
    },
    deltas,
  };
  const regressed =
    c.rates.task_pass_rate < b.rates.task_pass_rate ||
    c.rates.verification_pass_rate < b.rates.verification_pass_rate ||
    c.rates.review_compliance_rate < b.rates.review_compliance_rate ||
    c.rates.docs_compliance_rate < b.rates.docs_compliance_rate ||
    c.totals.policy_violations > b.totals.policy_violations ||
    c.totals.tool_failures > b.totals.tool_failures;
  const improved =
    c.rates.task_pass_rate > b.rates.task_pass_rate ||
    c.rates.verification_pass_rate > b.rates.verification_pass_rate ||
    c.rates.review_compliance_rate > b.rates.review_compliance_rate ||
    c.rates.docs_compliance_rate > b.rates.docs_compliance_rate ||
    c.totals.policy_violations < b.totals.policy_violations ||
    c.totals.tool_failures < b.totals.tool_failures ||
    c.median_runtime_seconds < b.median_runtime_seconds;
  const verdict = regressed ? 'regressed' : improved ? 'improved' : 'no_significant_change';
  const reasons = [];
  if (c.rates.task_pass_rate < b.rates.task_pass_rate) reasons.push('task_pass_rate decreased');
  if (c.rates.verification_pass_rate < b.rates.verification_pass_rate) reasons.push('verification_pass_rate decreased');
  if (c.rates.review_compliance_rate < b.rates.review_compliance_rate) reasons.push('review_compliance_rate decreased');
  if (c.rates.docs_compliance_rate < b.rates.docs_compliance_rate) reasons.push('docs_compliance_rate decreased');
  if (c.totals.policy_violations > b.totals.policy_violations) reasons.push('policy_violations increased');
  if (c.totals.tool_failures > b.totals.tool_failures) reasons.push('tool_failures increased');
  if (c.median_runtime_seconds < b.median_runtime_seconds &&
      c.rates.task_pass_rate >= b.rates.task_pass_rate &&
      c.rates.verification_pass_rate >= b.rates.verification_pass_rate &&
      c.rates.review_compliance_rate >= b.rates.review_compliance_rate &&
      c.rates.docs_compliance_rate >= b.rates.docs_compliance_rate) {
    reasons.push('median_runtime_seconds improved');
  }
  return { ...cmp, verdict, reasons };
}

function usage() {
  process.stderr.write('Usage: compare-benchmarks.mjs BASELINE_SUMMARY CANDIDATE_SUMMARY\n');
  process.exit(1);
}

function main() {
  if (process.argv.length !== 4) usage();
  const baseline = readJsonPreserving(process.argv[2]);
  const candidate = readJsonPreserving(process.argv[3]);
  process.stdout.write(stringifyJsonPreserving(buildComparison(baseline, candidate)) + '\n');
}

if (isMain(import.meta.url)) {
  main();
}
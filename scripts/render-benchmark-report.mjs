#!/usr/bin/env node
// render-benchmark-report: render a comparison JSON (compare-benchmarks output)
// as a markdown table with verdict, optional mock-mode note, and reasons.
// Node port of scripts/render-benchmark-report.sh — no jq, no Bash.
import { isMain, readJsonPreserving, pct } from './bench/lib.mjs';

export function renderReport(cmp) {
  const b = cmp.baseline;
  const c = cmp.candidate;
  const d = cmp.deltas;
  const lines = [];
  lines.push('## Benchmark Report', '',
    '| Metric | Baseline | Candidate | Delta |',
    '| --- | ---: | ---: | ---: |');
  lines.push(`| Configured tasks | ${b.totals.configured_tasks} | ${c.totals.configured_tasks} | ${c.totals.configured_tasks - b.totals.configured_tasks} |`);
  lines.push(`| Executed tasks | ${b.totals.executed_tasks} | ${c.totals.executed_tasks} | ${c.totals.executed_tasks - b.totals.executed_tasks} |`);
  lines.push(`| Execution coverage | ${pct(b.rates.execution_coverage_rate)} | ${pct(c.rates.execution_coverage_rate)} | ${pct(d.execution_coverage_rate)} |`);
  lines.push(`| Task pass rate | ${pct(b.rates.task_pass_rate)} | ${pct(c.rates.task_pass_rate)} | ${pct(d.task_pass_rate)} |`);
  lines.push(`| Clean pass rate | ${pct(b.rates.clean_pass_rate)} | ${pct(c.rates.clean_pass_rate)} | ${pct(d.clean_pass_rate)} |`);
  lines.push(`| Completion rate | ${pct(b.rates.completion_rate)} | ${pct(c.rates.completion_rate)} | ${pct(d.completion_rate)} |`);
  lines.push(`| Verification pass rate | ${pct(b.rates.verification_pass_rate)} | ${pct(c.rates.verification_pass_rate)} | ${pct(d.verification_pass_rate)} |`);
  lines.push(`| Review compliance | ${pct(b.rates.review_compliance_rate)} | ${pct(c.rates.review_compliance_rate)} | ${pct(d.review_compliance_rate)} |`);
  lines.push(`| Docs compliance | ${pct(b.rates.docs_compliance_rate)} | ${pct(c.rates.docs_compliance_rate)} | ${pct(d.docs_compliance_rate)} |`);
  lines.push(`| Recovered task rate | ${pct(b.rates.recovered_task_rate)} | ${pct(c.rates.recovered_task_rate)} | ${pct(d.recovered_task_rate)} |`);
  lines.push(`| Summary repair rate | ${pct(b.rates.summary_repair_rate)} | ${pct(c.rates.summary_repair_rate)} | ${pct(d.summary_repair_rate)} |`);
  lines.push(`| Policy violations | ${b.totals.policy_violations} | ${c.totals.policy_violations} | ${d.policy_violations} |`);
  lines.push(`| Tool failures | ${b.totals.tool_failures} | ${c.totals.tool_failures} | ${d.tool_failures} |`);
  lines.push(`| Recovered tasks | ${b.totals.recovered_tasks} | ${c.totals.recovered_tasks} | ${c.totals.recovered_tasks - b.totals.recovered_tasks} |`);
  lines.push(`| Summary repaired tasks | ${b.totals.summary_repaired} | ${c.totals.summary_repaired} | ${c.totals.summary_repaired - b.totals.summary_repaired} |`);
  lines.push(`| Median runtime (s) | ${b.median_runtime_seconds} | ${c.median_runtime_seconds} | ${d.median_runtime_seconds} |`);
  lines.push('', `**Verdict:** \`${cmp.verdict}\``);
  if (b.mode === 'mock' || c.mode === 'mock') {
    lines.push('', '> Note: at least one side ran in mock mode. Configure `BENCH_RUNNER_CMD` for real agent measurements.');
  }
  const reasons = cmp.reasons || [];
  if (reasons.length > 0) {
    lines.push('', '**Reasons:**');
    for (const r of reasons) lines.push(`- ${r}`);
  }
  return lines.join('\n') + '\n';
}

function usage() {
  process.stderr.write('Usage: render-benchmark-report.mjs COMPARISON_JSON\n');
  process.exit(1);
}

function main() {
  if (process.argv.length !== 3) usage();
  const cmp = readJsonPreserving(process.argv[2]);
  process.stdout.write(renderReport(cmp));
}

if (isMain(import.meta.url)) {
  main();
}
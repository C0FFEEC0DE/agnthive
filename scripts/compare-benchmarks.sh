#!/bin/bash

set -euo pipefail

[ $# -eq 2 ] || {
    echo "Usage: $0 BASELINE_SUMMARY CANDIDATE_SUMMARY" >&2
    exit 1
}

jq -n \
    --slurpfile base "$1" \
    --slurpfile cand "$2" \
    '
    $base[0] as $b
    | $cand[0] as $c
    | {
        schema_version: "1.0",
        generated_at: (now | todateiso8601),
        baseline: {
            ref: $b.source_ref,
            sha: $b.source_sha,
            mode: $b.mode,
            totals: $b.totals,
            rates: $b.rates,
            median_runtime_seconds: $b.median_runtime_seconds
        },
        candidate: {
            ref: $c.source_ref,
            sha: $c.source_sha,
            mode: $c.mode,
            totals: $c.totals,
            rates: $c.rates,
            median_runtime_seconds: $c.median_runtime_seconds
        },
        deltas: {
            task_pass_rate: ($c.rates.task_pass_rate - $b.rates.task_pass_rate),
            clean_pass_rate: ($c.rates.clean_pass_rate - $b.rates.clean_pass_rate),
            completion_rate: ($c.rates.completion_rate - $b.rates.completion_rate),
            verification_pass_rate: ($c.rates.verification_pass_rate - $b.rates.verification_pass_rate),
            review_compliance_rate: ($c.rates.review_compliance_rate - $b.rates.review_compliance_rate),
            docs_compliance_rate: ($c.rates.docs_compliance_rate - $b.rates.docs_compliance_rate),
            execution_coverage_rate: ($c.rates.execution_coverage_rate - $b.rates.execution_coverage_rate),
            recovered_task_rate: ($c.rates.recovered_task_rate - $b.rates.recovered_task_rate),
            summary_repair_rate: ($c.rates.summary_repair_rate - $b.rates.summary_repair_rate),
            policy_violations: ($c.totals.policy_violations - $b.totals.policy_violations),
            tool_failures: ($c.totals.tool_failures - $b.totals.tool_failures),
            median_runtime_seconds: ($c.median_runtime_seconds - $b.median_runtime_seconds)
        }
    }
    | . as $cmp
    | $cmp + {
        verdict: (
            if (
                $cmp.candidate.rates.task_pass_rate < $cmp.baseline.rates.task_pass_rate
                or $cmp.candidate.rates.verification_pass_rate < $cmp.baseline.rates.verification_pass_rate
                or $cmp.candidate.rates.review_compliance_rate < $cmp.baseline.rates.review_compliance_rate
                or $cmp.candidate.rates.docs_compliance_rate < $cmp.baseline.rates.docs_compliance_rate
                or $cmp.candidate.totals.policy_violations > $cmp.baseline.totals.policy_violations
                or $cmp.candidate.totals.tool_failures > $cmp.baseline.totals.tool_failures
            ) then "regressed"
            elif (
                $cmp.candidate.rates.task_pass_rate > $cmp.baseline.rates.task_pass_rate
                or $cmp.candidate.rates.verification_pass_rate > $cmp.baseline.rates.verification_pass_rate
                or $cmp.candidate.rates.review_compliance_rate > $cmp.baseline.rates.review_compliance_rate
                or $cmp.candidate.rates.docs_compliance_rate > $cmp.baseline.rates.docs_compliance_rate
                or $cmp.candidate.totals.policy_violations < $cmp.baseline.totals.policy_violations
                or $cmp.candidate.totals.tool_failures < $cmp.baseline.totals.tool_failures
                or $cmp.candidate.median_runtime_seconds < $cmp.baseline.median_runtime_seconds
            ) then "improved"
            else "no_significant_change"
            end
        ),
        reasons: [
            if $cmp.candidate.rates.task_pass_rate < $cmp.baseline.rates.task_pass_rate then "task_pass_rate decreased" else empty end,
            if $cmp.candidate.rates.verification_pass_rate < $cmp.baseline.rates.verification_pass_rate then "verification_pass_rate decreased" else empty end,
            if $cmp.candidate.rates.review_compliance_rate < $cmp.baseline.rates.review_compliance_rate then "review_compliance_rate decreased" else empty end,
            if $cmp.candidate.rates.docs_compliance_rate < $cmp.baseline.rates.docs_compliance_rate then "docs_compliance_rate decreased" else empty end,
            if $cmp.candidate.totals.policy_violations > $cmp.baseline.totals.policy_violations then "policy_violations increased" else empty end,
            if $cmp.candidate.totals.tool_failures > $cmp.baseline.totals.tool_failures then "tool_failures increased" else empty end,
            if $cmp.candidate.median_runtime_seconds < $cmp.baseline.median_runtime_seconds and (
                $cmp.candidate.rates.task_pass_rate >= $cmp.baseline.rates.task_pass_rate
                and $cmp.candidate.rates.verification_pass_rate >= $cmp.baseline.rates.verification_pass_rate
                and $cmp.candidate.rates.review_compliance_rate >= $cmp.baseline.rates.review_compliance_rate
                and $cmp.candidate.rates.docs_compliance_rate >= $cmp.baseline.rates.docs_compliance_rate
            ) then "median_runtime_seconds improved" else empty end
        ]
    }
    '

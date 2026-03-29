#!/bin/bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR=""
TASK_GLOB="bench/tasks/*.json"
MODE="${BENCH_MODE:-}"
SOURCE_REF="${BENCH_SOURCE_REF:-working-tree}"
FAIL_FAST="${BENCH_FAIL_FAST:-0}"
PROJECT_CLAUDE_DIR="${REPO_ROOT}/.claude"

usage() {
    echo "Usage: $0 --output-dir DIR [--task-glob GLOB] [--mode mock|command] [--ref REF]" >&2
    exit 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --task-glob)
            TASK_GLOB="$2"
            shift 2
            ;;
        --mode)
            MODE="$2"
            shift 2
            ;;
        --ref)
            SOURCE_REF="$2"
            shift 2
            ;;
        *)
            usage
            ;;
    esac
done

[ -n "$OUTPUT_DIR" ] || usage

if [ -z "$MODE" ]; then
    if [ -n "${BENCH_RUNNER_CMD:-}" ]; then
        MODE="command"
    else
        MODE="mock"
    fi
fi

case "$MODE" in
    mock)
        RUNNER_CMD="$REPO_ROOT/scripts/mock-benchmark-runner.sh"
        RUNNER_DESCRIPTION="mock-benchmark-runner"
        ;;
    command)
        : "${BENCH_RUNNER_CMD:?BENCH_RUNNER_CMD is required in command mode}"
        RUNNER_CMD="$BENCH_RUNNER_CMD"
        RUNNER_DESCRIPTION="$BENCH_RUNNER_CMD"
        ;;
    *)
        echo "Unsupported benchmark mode: $MODE" >&2
        exit 1
        ;;
esac

mkdir -p "$OUTPUT_DIR/tasks"

shopt -s nullglob
task_files=("$REPO_ROOT"/$TASK_GLOB)
shopt -u nullglob

if [ "${#task_files[@]}" -eq 0 ]; then
    echo "No benchmark tasks matched glob: $TASK_GLOB" >&2
    exit 1
fi

result_files=()
for task_file in "${task_files[@]}"; do
    task_id="$(jq -r '.id' "$task_file")"
    category="$(jq -r '.category' "$task_file")"
    fixture_name="$(jq -r '.fixture' "$task_file")"
    fixture_dir="$REPO_ROOT/bench/fixtures/$fixture_name"
    task_output_dir="$OUTPUT_DIR/tasks/$task_id"
    task_workdir="$task_output_dir/workdir"

    if [ ! -d "$fixture_dir" ]; then
        echo "Missing benchmark fixture directory: $fixture_dir" >&2
        exit 1
    fi

    rm -rf "$task_output_dir"
    mkdir -p "$task_workdir"
    cp -R "$fixture_dir"/. "$task_workdir"/
    if [ -d "$PROJECT_CLAUDE_DIR" ]; then
        mkdir -p "$task_workdir/.claude"
        cp -R "$PROJECT_CLAUDE_DIR"/. "$task_workdir/.claude"/
    fi

    export BENCH_TASK_FILE="$task_file"
    export BENCH_TASK_ID="$task_id"
    export BENCH_OUTPUT_DIR="$task_output_dir"
    export BENCH_WORKDIR="$task_workdir"
    export BENCH_FIXTURE_DIR="$fixture_dir"
    export BENCH_REPO_ROOT="$REPO_ROOT"

    echo "=== Benchmark task: $task_id ==="
    echo "Runner: $RUNNER_DESCRIPTION"
    echo "Category: $category"
    echo "Fixture: $fixture_name"
    echo "Task file: $task_file"
    echo "Workdir: $task_workdir"
    echo "Model: ${OLLAMA_MODEL:-${OPENROUTER_MODEL:-<unset>}}"
    echo "Max output tokens: ${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-<unset>}"

    if [ "$MODE" = "mock" ]; then
        "$RUNNER_CMD"
    else
        bash -lc "$RUNNER_CMD"
    fi

    if [ ! -f "$task_output_dir/result.json" ]; then
        echo "Benchmark runner did not produce result.json for task: $task_id" >&2
        exit 1
    fi

    if ! jq -e '
        .task_id and .status and has("completed") and has("verification_required") and has("tests_run")
        and has("tests_passed") and has("review_required") and has("review_present")
        and has("docs_required") and has("docs_updated")
        and has("policy_violations") and has("tool_failures")
        and has("runtime_seconds") and .notes
    ' "$task_output_dir/result.json" >/dev/null; then
        echo "Benchmark result has missing required fields: $task_output_dir/result.json" >&2
        exit 1
    fi

    result_files+=("$task_output_dir/result.json")

    if [ -f "$task_output_dir/task-summary.txt" ]; then
        cat "$task_output_dir/task-summary.txt"
    else
        jq -r '
            "Status: \(.status)",
            "Changed files: \((.changed_files // []) | join(", "))",
            "Notes: \(.notes)"
        ' "$task_output_dir/result.json"
    fi
    echo "Structured result:"
    cat "$task_output_dir/result.json"

    if [ "$FAIL_FAST" = "1" ] || [ "$FAIL_FAST" = "true" ]; then
        if jq -e '.status != "passed"' "$task_output_dir/result.json" >/dev/null; then
            echo "Fail-fast enabled; stopping benchmark after first failing task: $task_id"
            break
        fi
    fi
done

source_sha="$(git rev-parse --short HEAD)"
generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

jq -s \
    --arg schema_version "1.0" \
    --arg mode "$MODE" \
    --arg runner "$RUNNER_DESCRIPTION" \
    --arg generated_at "$generated_at" \
    --arg source_ref "$SOURCE_REF" \
    --arg source_sha "$source_sha" \
    --arg task_glob "$TASK_GLOB" \
    '
    def rate($num; $den):
        if $den == 0 then 0 else ($num / $den) end;
    def median($arr):
        ($arr | sort) as $sorted
        | if ($sorted | length) == 0 then 0
          elif ($sorted | length) % 2 == 1 then $sorted[($sorted | length / 2 | floor)]
          else (($sorted[($sorted | length / 2 | floor) - 1] + $sorted[($sorted | length / 2 | floor)]) / 2)
          end;
    . as $tasks
    | ($tasks | length) as $total
    | {
        schema_version: $schema_version,
        mode: $mode,
        runner: $runner,
        generated_at: $generated_at,
        source_ref: $source_ref,
        source_sha: $source_sha,
        task_glob: $task_glob,
        totals: {
            tasks: $total,
            passed: ($tasks | map(select(.status == "passed")) | length),
            completed: ($tasks | map(select(.completed == true)) | length),
            verification_required: ($tasks | map(select(.verification_required == true)) | length),
            tests_run: ($tasks | map(select(.tests_run == true)) | length),
            tests_passed: ($tasks | map(select(.tests_passed == true)) | length),
            review_required: ($tasks | map(select(.review_required == true)) | length),
            review_present: ($tasks | map(select(.review_present == true)) | length),
            docs_required: ($tasks | map(select(.docs_required == true)) | length),
            docs_updated: ($tasks | map(select(.docs_updated == true)) | length),
            policy_violations: ($tasks | map(.policy_violations) | add),
            tool_failures: ($tasks | map(.tool_failures) | add)
        },
        rates: {
            task_pass_rate: rate(($tasks | map(select(.status == "passed")) | length); $total),
            completion_rate: rate(($tasks | map(select(.completed == true)) | length); $total),
            verification_rate: rate(($tasks | map(select((.verification_required == false) or (.tests_run == true))) | length); $total),
            verification_pass_rate: rate(($tasks | map(select((.verification_required == false) or (.tests_passed == true))) | length); $total),
            review_compliance_rate: rate(($tasks | map(select((.review_required == false) or (.review_present == true))) | length); $total),
            docs_compliance_rate: rate(($tasks | map(select((.docs_required == false) or (.docs_updated == true))) | length); $total)
        },
        median_runtime_seconds: median($tasks | map(.runtime_seconds)),
        tasks: $tasks
    }
    ' "${result_files[@]}" > "$OUTPUT_DIR/summary.json"

echo "Benchmark summary written to $OUTPUT_DIR/summary.json"
jq -r '
    "Benchmark totals:",
    "- tasks: \(.totals.tasks)",
    "- passed: \(.totals.passed)",
    "- tool_failures: \(.totals.tool_failures)",
    "- task_pass_rate: \(.rates.task_pass_rate)"
' "$OUTPUT_DIR/summary.json"

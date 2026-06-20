#!/bin/bash
# Re-run only the FAILED subagent smoke benchmark tasks, instead of the whole
# suite. This saves Ollama Cloud credits: a full smoke rerun re-executes all 11
# canary tasks; this re-executes only the tasks that did not resolve in a prior
# failed run.
#
# It triggers the smoke workflow's workflow_dispatch with a resume selection
# mode. The workflow then:
#   - auto_resume: finds the last failed smoke run (<=72h) and re-runs only its
#     unresolved tasks (default).
#   - resume: re-runs only the unresolved tasks from a specific run id
#     (--run-id <id>).
#
# Requires: gh authenticated with workflow permissions on the repo.

set -euo pipefail

WORKFLOW="behavior-benchmark-subagents-smoke.yml"
selection_mode="auto_resume"
resume_run_id=""
ref=""

usage() {
    cat <<'EOF'
Usage:
  rerun-failed-benchmark.sh [--run-id <id>] [--ref <branch>]

Modes:
  (default)     auto_resume: re-run only the unresolved tasks from the last
                failed smoke run (<=72h).
  --run-id <id> resume: re-run only the unresolved tasks from that specific
                smoke run id.

Options:
  --ref <branch>  branch/ref to dispatch on (defaults to the current branch).
  -h, --help      show this help.

Examples:
  ./scripts/rerun-failed-benchmark.sh
  ./scripts/rerun-failed-benchmark.sh --run-id 27872932481
  ./scripts/rerun-failed-benchmark.sh --ref main
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --run-id)
            [ $# -ge 2 ] || { echo "--run-id needs a value" >&2; exit 2; }
            resume_run_id="$2"; shift 2;;
        --ref)
            [ $# -ge 2 ] || { echo "--ref needs a value" >&2; exit 2; }
            ref="$2"; shift 2;;
        -h|--help) usage; exit 0;;
        *) echo "unknown argument: $1" >&2; usage >&2; exit 2;;
    esac
done

if [ -n "$resume_run_id" ]; then
    selection_mode="resume"
fi

if [ -z "$ref" ]; then
    ref="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [ -z "$ref" ] || [ "$ref" = "HEAD" ]; then
        echo "could not determine current branch (detached HEAD?); pass --ref <branch>" >&2
        exit 2
    fi
fi

gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated" >&2; exit 2; }

# Confirm the workflow exists on the target ref and has a workflow_dispatch
# trigger; otherwise the dispatch will fail opaquely.
if ! gh workflow view "$WORKFLOW" --ref "$ref" >/dev/null 2>&1; then
    echo "workflow '$WORKFLOW' not found on ref '$ref'" >&2
    exit 2
fi

if [ "$selection_mode" = "resume" ]; then
    echo "Dispatching smoke workflow on '$ref' in resume mode (run_id=$resume_run_id)..."
    gh workflow run "$WORKFLOW" --ref "$ref" \
        -f selection_mode=resume -f resume_run_id="$resume_run_id"
else
    echo "Dispatching smoke workflow on '$ref' in auto_resume mode (last failed run)..."
    gh workflow run "$WORKFLOW" --ref "$ref" -f selection_mode=auto_resume
fi

# Give GitHub a moment to register the new run, then surface it. Scope by branch
# so we don't print a run from a different ref.
sleep 4
gh run list --workflow="$WORKFLOW" --branch="$ref" --limit 1 \
    --json databaseId,url,status,createdAt \
    --jq '.[] | "Re-run triggered: \(.url)\nStatus: \(.status)\nWatch:     gh run watch \(.databaseId)\nLogs:      gh run view \(.databaseId) --log-failed"'
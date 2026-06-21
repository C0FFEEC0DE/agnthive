#!/usr/bin/env bash
# task-brief — extract task N's full text from a plan file to a brief file
# and print the path. Subagents read the brief path instead of receiving the
# whole plan pasted into their dispatch prompt, which keeps the controller's
# context clean and gives the implementer a single source of requirements.
#
# Usage: task-brief PLAN_FILE N
#
# Plan format: each task starts with a "## Task N: <title>" markdown header.
# The brief runs from that header up to (not including) the next "## " or
# "# " header, so "### " subsections inside a task are preserved. Fenced code
# blocks (``` ... ```) are tracked so header-like lines inside them do not
# falsely end the task.
#
# Output dir: $CLAUDE_CREW_BRIEF_DIR, else .claude-crew/briefs/ under the git
# toplevel (or cwd). That path is gitignored (see .gitignore).

set -euo pipefail

if [ $# -ne 2 ]; then
    echo "Usage: $(basename "$0") PLAN_FILE N" >&2
    exit 2
fi

plan_file="$1"
n="$2"

if ! printf '%s' "$n" | grep -Eq '^[0-9]+$'; then
    echo "task-brief: N must be a positive integer, got '$n'" >&2
    exit 2
fi

if [ ! -f "$plan_file" ]; then
    echo "task-brief: plan file not found: $plan_file" >&2
    exit 2
fi

brief_dir="${CLAUDE_CREW_BRIEF_DIR:-}"
if [ -z "$brief_dir" ]; then
    toplevel="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$toplevel" ]; then
        brief_dir="$toplevel/.claude-crew/briefs"
    else
        brief_dir="${PWD}/.claude-crew/briefs"
    fi
fi
mkdir -p "$brief_dir"

brief_file="$brief_dir/task-${n}-brief.md"

awk -v n="$n" '
    BEGIN { found = 0; in_fence = 0 }
    /^```/ {
        if (found) print
        in_fence = !in_fence
        next
    }
    in_fence {
        if (found) print
        next
    }
    /^[#][#] +Task +[0-9]+/ {
        line = $0
        sub(/^## +Task +/, "", line)
        sub(/[^0-9].*$/, "", line)
        if (line == n) { found = 1; print; next }
        if (found) { exit }
        next
    }
    /^[#][#] / || /^[#] / {
        if (found) { exit }
        next
    }
    { if (found) print }
' "$plan_file" > "$brief_file"

if [ ! -s "$brief_file" ]; then
    echo "task-brief: task $n not found in $plan_file (expected a '## Task $n:' header)" >&2
    rm -f "$brief_file"
    exit 1
fi

printf '%s\n' "$brief_file"
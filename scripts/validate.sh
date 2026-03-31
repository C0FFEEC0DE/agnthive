#!/bin/bash
# Validation script for claude-crew repository
# Checks: JSON validity, shell syntax, agent frontmatter, slash-command inventory,
# benchmark metadata, hook test manifests, and broken internal links.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ERRORS=0

report_error() {
    echo "ERROR: $1"
    ERRORS=$((ERRORS + 1))
}

echo "=== Validation Script ==="
echo "Repository: $REPO_ROOT"
echo ""

echo "--- Checking JSON files ---"
while IFS= read -r json_file; do
    if ! jq empty "$json_file" >/dev/null 2>&1; then
        report_error "Invalid JSON: $json_file"
    else
        echo "OK: $json_file"
    fi
done < <(find "$REPO_ROOT" -name "*.json" -type f | sort)
echo ""

echo "--- Checking shell syntax ---"
while IFS= read -r shell_file; do
    if ! bash -n "$shell_file"; then
        report_error "Shell syntax error: $shell_file"
    else
        echo "OK: $shell_file"
    fi
done < <(find "$REPO_ROOT/claudecfg" "$REPO_ROOT/scripts" -type f -name "*.sh" | sort)
echo ""

echo "--- Checking Python syntax ---"
while IFS= read -r py_file; do
    if ! python3 -m py_compile "$py_file"; then
        report_error "Python syntax error: $py_file"
    else
        echo "OK: $py_file"
    fi
done < <(find "$REPO_ROOT/scripts" "$REPO_ROOT/bench/fixtures" "$REPO_ROOT/tests" -type f -name "*.py" | sort)
echo ""

echo "--- Checking agent frontmatter ---"
AGENT_DIR="$REPO_ROOT/claudecfg/agents"
if [ -d "$AGENT_DIR" ]; then
    for agent_file in "$AGENT_DIR"/*.md; do
        [ -f "$agent_file" ] || continue

        filename="$(basename "$agent_file")"
        case_failed=0

        if ! head -1 "$agent_file" | grep -q "^---$"; then
            report_error "Missing frontmatter start in $filename"
            continue
        fi

        frontmatter="$(sed -n '/^---$/,/^---$/p' "$agent_file" | tail -n +2 | head -n -1)"
        for field in name alias description type; do
            if ! grep -q "^${field}:" <<<"$frontmatter"; then
                report_error "Missing '$field' in $filename frontmatter"
                case_failed=1
            fi
        done

        if [ "$case_failed" -eq 0 ]; then
            echo "OK: $filename"
        fi
    done
else
    report_error "Agent directory not found: $AGENT_DIR"
fi
echo ""

echo "--- Checking slash command inventory ---"
declare -A COMMAND_TO_ALIAS=(
    [manager]="m"
    [explore]="e"
    [bug]="bug"
    [debug]="dbg"
    [design]="a"
    [test]="t"
    [refactor]="hk"
    [review]="cr"
    [docs]="doc"
)
EXPECTED_COMMANDS=(manager explore bug debug design test refactor review docs)

compare_command_lists() {
    local file="$1"
    local label="$2"
    local start="$3"
    local end="$4"
    local actual expected

    if [ ! -f "$file" ]; then
        report_error "$label not found: $file"
        return
    fi

    mapfile -t actual < <(sed -n "/^${start}$/,/^${end}$/p" "$file" | grep -oP '^- `\/\K[^`]+(?=`)' | sort -u || true)
    mapfile -t expected < <(printf '%s\n' "${EXPECTED_COMMANDS[@]}" | sort -u)

    if ! diff -u <(printf '%s\n' "${expected[@]}") <(printf '%s\n' "${actual[@]}") >/dev/null; then
        report_error "$label does not match the bundled slash-command inventory: $file"
    else
        echo "OK: $label"
    fi
}

compare_command_file_inventory() {
    local actual expected

    mapfile -t actual < <(find "$REPO_ROOT/claudecfg/commands" -maxdepth 1 -type f -name "*.md" -printf '%f\n' | sed 's/\.md$//' | sort -u)
    mapfile -t expected < <(printf '%s\n' "${EXPECTED_COMMANDS[@]}" | sort -u)

    if ! diff -u <(printf '%s\n' "${expected[@]}") <(printf '%s\n' "${actual[@]}") >/dev/null; then
        report_error "claudecfg/commands file inventory does not match the bundled slash-command inventory"
    else
        echo "OK: claudecfg/commands file inventory"
    fi
}

compare_command_file_inventory

for command in "${EXPECTED_COMMANDS[@]}"; do
    command_file="$REPO_ROOT/claudecfg/commands/$command.md"
    expected_alias="${COMMAND_TO_ALIAS[$command]}"
    agent_file="$REPO_ROOT/claudecfg/agents/$expected_alias.md"

    if [ ! -f "$command_file" ]; then
        report_error "Missing slash command doc: $command_file"
        continue
    fi

    if ! head -1 "$command_file" | grep -q "^# /${command}$"; then
        report_error "Slash command doc header mismatch: $command_file"
    fi

    if [ ! -f "$agent_file" ]; then
        report_error "Missing agent file for slash command /$command: $agent_file"
        continue
    fi

    agent_alias="$(grep -m1 '^alias:' "$agent_file" | sed 's/^alias:[[:space:]]*//')"
    if [ "$agent_alias" != "$expected_alias" ]; then
        report_error "Agent alias mismatch for /$command: expected $expected_alias, found $agent_alias in $agent_file"
    fi
done

compare_command_lists "$REPO_ROOT/README.md" "README slash-command list" "### Slash Commands" "### Workflows"
compare_command_lists "$REPO_ROOT/claudecfg/GUIDE.md" "GUIDE slash-command list" "## Slash Commands" "## Auto-Execution"
compare_command_lists "$REPO_ROOT/claudecfg/README.md" "claudecfg README slash-command list" "Current bundled slash commands:" "## Installation"
echo ""

echo "--- Checking hook test manifests ---"
HOOK_CASES_FILE="$REPO_ROOT/tests/hooks/cases.json"
if [ -f "$HOOK_CASES_FILE" ]; then
    if ! jq -e 'type == "array"' "$HOOK_CASES_FILE" >/dev/null; then
        report_error "Hook cases manifest must be a JSON array"
    else
        while IFS= read -r case_json; do
            name="$(jq -r '.name' <<<"$case_json")"
            script_path="$(jq -r '.script' <<<"$case_json")"
            stdin_fixture="$(jq -r '.stdin' <<<"$case_json")"
            if [ ! -f "$REPO_ROOT/$script_path" ]; then
                report_error "Hook case '$name' references missing script: $script_path"
            fi
            if [ ! -f "$REPO_ROOT/$stdin_fixture" ]; then
                report_error "Hook case '$name' references missing fixture: $stdin_fixture"
            fi
        done < <(jq -c '.[]' "$HOOK_CASES_FILE")
        echo "OK: $HOOK_CASES_FILE"
    fi
else
    echo "No hook test manifest found"
fi
echo ""

echo "--- Checking benchmark tasks ---"
TASK_IDS=()
EXPECTED_SUBAGENT_ALIASES=(m e a bug dbg t cr doc hk)
SUBAGENT_ALIASES_SEEN=()
SUBAGENT_REQUIRED_FOOTER_REGEXES=(
    "Outcome:"
    "Changed files:|No files changed:"
    "Verification status:"
    "Remaining risks:|Next step:"
)
shopt -s nullglob
while IFS= read -r task_file; do
    task_id="$(jq -r '.id // empty' "$task_file")"
    fixture="$(jq -r '.fixture // empty' "$task_file")"
    agent_alias="$(jq -r '.agent_alias // empty' "$task_file")"

    if ! jq -e '
        .id and .category and .fixture and .prompt
        and has("review_required")
        and has("docs_required")
        and has("verification_required")
        and (.success_criteria | type == "array")
        and (.must_not | type == "array")
        and ((.forbidden_doc_patterns // []) | type == "array")
        and ((.forbidden_transcript_patterns // []) | type == "array")
        and ((.required_transcript_patterns // []) | type == "array")
    ' "$task_file" >/dev/null; then
        report_error "Benchmark task has missing required fields: $task_file"
        continue
    fi

    if [ ! -d "$REPO_ROOT/bench/fixtures/$fixture" ]; then
        report_error "Benchmark task '$task_id' references missing fixture: $fixture"
    fi

    if [[ "$task_file" == *"/bench/tasks/subagents/"* ]]; then
        if ! jq -e '
            .agent_alias
            and ((.required_transcript_patterns // []) | type == "array" and length > 0)
            and ((.forbidden_transcript_patterns // []) | type == "array" and length > 0)
        ' "$task_file" >/dev/null; then
            report_error "Subagent benchmark task must declare agent_alias plus non-empty required/forbidden transcript patterns: $task_file"
        else
            SUBAGENT_ALIASES_SEEN+=("$agent_alias")
        fi

        for required_regex in "${SUBAGENT_REQUIRED_FOOTER_REGEXES[@]}"; do
            if ! jq -e --arg pattern "$required_regex" '
                (.required_transcript_patterns // []) | any(test($pattern))
            ' "$task_file" >/dev/null; then
                report_error "Subagent benchmark task is missing required footer transcript pattern '$required_regex': $task_file"
            fi
        done

        if [ "$agent_alias" = "cr" ]; then
            if ! jq -e '
                (.required_transcript_patterns // []) | any(. == "Review outcome:")
            ' "$task_file" >/dev/null; then
                report_error "Code reviewer benchmark task must require 'Review outcome:' in transcript patterns: $task_file"
            fi
        fi
    fi

    if printf '%s\n' "${TASK_IDS[@]}" | grep -Fxq "$task_id"; then
        report_error "Duplicate benchmark task id: $task_id"
    else
        TASK_IDS+=("$task_id")
    fi

    echo "OK: $task_file"
done < <(find "$REPO_ROOT/bench/tasks" -type f -name "*.json" | sort)
shopt -u nullglob

for expected_alias in "${EXPECTED_SUBAGENT_ALIASES[@]}"; do
    if ! printf '%s\n' "${SUBAGENT_ALIASES_SEEN[@]}" | grep -Fxq "$expected_alias"; then
        report_error "Missing golden subagent benchmark coverage for agent alias: $expected_alias"
    fi
done
echo ""

echo "--- Checking internal links ---"
while IFS= read -r md_file; do
    md_dir="$(dirname "$md_file")"
    while IFS= read -r line; do
        while IFS= read -r link; do
            [ -z "$link" ] && continue

            if [[ "$link" =~ ^https?:// ]] || [[ "$link" =~ ^# ]] || [[ "$link" =~ ^mailto: ]]; then
                continue
            fi

            if [[ "$link" =~ ^/ ]]; then
                target="$REPO_ROOT$link"
            else
                target="$md_dir/$link"
            fi

            target="${target%%#*}"
            target="${target%/}"

            if [ ! -e "$target" ] && [ ! -e "${target}.md" ]; then
                report_error "Broken link in $md_file: $link (resolved to: $target)"
            fi
        done < <(grep -oP '\]\([^)]+\)' <<<"$line" | sed 's/\](\(.*\)/\1/' | tr -d ')' || true)
    done < "$md_file"
done < <(find "$REPO_ROOT" -name "*.md" -type f | sort)
echo ""

echo "=== Summary ==="
if [ "$ERRORS" -eq 0 ]; then
    echo "All checks passed!"
    exit 0
fi

echo "Found $ERRORS error(s)"
exit 1

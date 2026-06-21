#!/bin/bash
# Validation script for multi-agent-sdlc-crew repository
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

extract_frontmatter_value() {
    local frontmatter="$1"
    local field="$2"

    awk -F': *' -v field="$field" '$1 == field {print substr($0, index($0, ":") + 1); exit}' <<<"$frontmatter" | sed 's/^ *//'
}

extract_frontmatter_list_items() {
    local frontmatter="$1"
    local field="$2"

    awk -v field="$field" '
        $0 ~ ("^" field ":") {
            in_field = 1
            value = substr($0, index($0, ":") + 1)
            sub(/^[[:space:]]+/, "", value)
            if (length(value) > 0) {
                print value
            }
            next
        }
        in_field && $0 ~ /^  - / {
            item = $0
            sub(/^  - /, "", item)
            print item
            next
        }
        in_field {
            exit
        }
    ' <<<"$frontmatter"
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
# Prefer /bin/bash so macOS bash 3.2 parses the same way it does at runtime;
# Linux /bin/bash is bash 4/5 so this also works there. Fall back to PATH bash
# only if /bin/bash is missing (uncommon).
if [ -x /bin/bash ]; then
    SYNTAX_BASH="/bin/bash"
else
    SYNTAX_BASH="bash"
fi
while IFS= read -r shell_file; do
    if ! "$SYNTAX_BASH" -n "$shell_file"; then
        report_error "Shell syntax error: $shell_file"
    else
        echo "OK: $shell_file"
    fi
done < <(
    {
        printf '%s\n' \
            "$REPO_ROOT/install.sh" \
            "$REPO_ROOT/claudecfg/install.sh"
        find "$REPO_ROOT/claudecfg" "$REPO_ROOT/scripts" "$REPO_ROOT/tests/install" "$REPO_ROOT/tests/hooks" -type f -name "*.sh"
    } | sort
)
echo ""

echo "--- Checking workflow syntax ---"
if command -v actionlint >/dev/null 2>&1; then
    if ! actionlint "$REPO_ROOT"/.github/workflows/*.yml; then
        report_error "actionlint reported workflow syntax issues"
    else
        echo "OK: actionlint"
    fi
else
    echo "SKIP: actionlint not installed"
fi
echo ""

echo "--- Checking shellcheck lint ---"
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck_targets=(
        "$REPO_ROOT/install.sh"
        "$REPO_ROOT/claudecfg/install.sh"
        "$REPO_ROOT"/claudecfg/hooks/*.sh
        "$REPO_ROOT"/scripts/*.sh
        "$REPO_ROOT"/tests/install/*.sh
    )
    if ! shellcheck "${shellcheck_targets[@]}"; then
        report_error "shellcheck reported shell lint issues"
    else
        echo "OK: shellcheck"
    fi
else
    echo "SKIP: shellcheck not installed"
fi
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

        frontmatter="$(awk '/^---$/{n++; next} n==1' "$agent_file")"
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

echo "--- Checking skill frontmatter ---"
SKILL_DIR="$REPO_ROOT/claudecfg/skills"
if [ -d "$SKILL_DIR" ]; then
    for skill_file in "$SKILL_DIR"/*.md; do
        [ -f "$skill_file" ] || continue

        filename="$(basename "$skill_file")"
        case_failed=0

        if ! head -1 "$skill_file" | grep -q "^---$"; then
            report_error "Missing frontmatter start in skill $filename"
            continue
        fi

        frontmatter_end_line="$(awk 'NR>1 && /^---$/ {print NR; exit}' "$skill_file")"
        if [ -z "${frontmatter_end_line:-}" ]; then
            report_error "Missing frontmatter end in skill $filename"
            continue
        fi

        next_line="$((frontmatter_end_line + 1))"
        if sed -n "${next_line}p" "$skill_file" | grep -q "^---$"; then
            report_error "Duplicate frontmatter block in skill $filename"
            continue
        fi

        frontmatter="$(sed -n "2,$((frontmatter_end_line - 1))p" "$skill_file")"
        skill_agent="$(extract_frontmatter_value "$frontmatter" "agent")"
        for field in name description agent context disable-model-invocation allowed-tools paths; do
            if ! grep -q "^${field}:" <<<"$frontmatter"; then
                report_error "Missing '$field' in skill $filename frontmatter"
                case_failed=1
            fi
        done

        if ! grep -q '^disable-model-invocation:[[:space:]]*true$' <<<"$frontmatter"; then
            report_error "Skill frontmatter must pin disable-model-invocation: true in $filename"
            case_failed=1
        fi

        if ! grep -q '^context:[[:space:]]*fork$' <<<"$frontmatter"; then
            report_error "Skill frontmatter must pin context: fork in $filename"
            case_failed=1
        fi

        allowed_tools_items=()
    while IFS= read -r item; do
        [ -n "$item" ] && allowed_tools_items+=("$item")
    done < <(extract_frontmatter_list_items "$frontmatter" "allowed-tools")
        if [ "${#allowed_tools_items[@]}" -eq 0 ]; then
            report_error "Skill frontmatter must declare non-empty allowed-tools in $filename"
            case_failed=1
        fi

        path_items=()
        while IFS= read -r item; do
            [ -n "$item" ] && path_items+=("$item")
        done < <(extract_frontmatter_list_items "$frontmatter" "paths")
        if [ "${#path_items[@]}" -eq 0 ]; then
            report_error "Skill frontmatter must declare non-empty paths in $filename"
            case_failed=1
        fi

        if [ -n "$skill_agent" ] && ! grep -Eq "^name:[[:space:]]*${skill_agent}\$|^alias:[[:space:]]*${skill_agent}\$" "$AGENT_DIR"/*.md; then
            report_error "Skill frontmatter agent does not match a known agent name or alias in $filename"
            case_failed=1
        fi

        if [ "$case_failed" -eq 0 ]; then
            echo "OK: $filename"
        fi
    done
else
    report_error "Skill directory not found: $SKILL_DIR"
fi
echo ""

echo "--- Checking slash command inventory ---"
# bash 3.2 (macOS /bin/bash) does not support `declare -A` associative
# arrays. Use two parallel indexed arrays and a lookup function instead.
COMMAND_NAMES=(manager explore bug debug design test refactor review docs)
COMMAND_ALIASES=(m e bug dbg a t a cr doc)
EXPECTED_COMMANDS=("${COMMAND_NAMES[@]}")
EXPECTED_SKILLS=(design docs refactor review test)

# Look up the agent alias for a given command name. Returns empty string
# if the command is not in the table.
command_alias_for() {
    local name="$1"
    local i
    for i in "${!COMMAND_NAMES[@]}"; do
        if [ "${COMMAND_NAMES[$i]}" = "$name" ]; then
            printf '%s' "${COMMAND_ALIASES[$i]}"
            return 0
        fi
    done
    return 1
}

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

    actual=()
    while IFS= read -r item; do
        [ -n "$item" ] && actual+=("$item")
    # bash 3.2 (macOS /bin/bash) and BSD utilities do not support `grep -P`
    # (PCRE). Use sed -E for portable extended-regex matching. The original
    # PCRE used \K to drop the prefix and a lookahead for the trailing
    # backtick; sed -E captures both with a single group instead.
    done < <(sed -n "/^${start}$/,/^${end}$/p" "$file" | sed -nE "s|^- \`/([^\`]+)\`.*|\1|p" | sort -u || true)
    expected=()
    while IFS= read -r item; do
        [ -n "$item" ] && expected+=("$item")
    done < <(printf '%s\n' "${EXPECTED_COMMANDS[@]}" | sort -u)

    if ! diff -u <(printf '%s\n' "${expected[@]}") <(printf '%s\n' "${actual[@]}") >/dev/null; then
        report_error "$label does not match the bundled slash-command inventory: $file"
    else
        echo "OK: $label"
    fi
}

compare_command_file_inventory() {
    local actual expected

    actual=()
    while IFS= read -r item; do
        [ -n "$item" ] && actual+=("$item")
    done < <(find "$REPO_ROOT/claudecfg/commands" -maxdepth 1 -type f -name "*.md" | sed 's|.*/||; s/\.md$//' | sort -u)
    expected=()
    while IFS= read -r item; do
        [ -n "$item" ] && expected+=("$item")
    done < <(printf '%s\n' "${EXPECTED_COMMANDS[@]}" | sort -u)

    if ! diff -u <(printf '%s\n' "${expected[@]}") <(printf '%s\n' "${actual[@]}") >/dev/null; then
        report_error "claudecfg/commands file inventory does not match the bundled slash-command inventory"
    else
        echo "OK: claudecfg/commands file inventory"
    fi
}

compare_command_file_inventory

compare_skill_file_inventory() {
    local actual expected

    actual=()
    while IFS= read -r item; do
        [ -n "$item" ] && actual+=("$item")
    done < <(find "$REPO_ROOT/claudecfg/skills" -maxdepth 1 -type f -name "*.md" | sed 's|.*/||; s/\.md$//' | sort -u)
    expected=()
    while IFS= read -r item; do
        [ -n "$item" ] && expected+=("$item")
    done < <(printf '%s\n' "${EXPECTED_SKILLS[@]}" | sort -u)

    if ! diff -u <(printf '%s\n' "${expected[@]}") <(printf '%s\n' "${actual[@]}") >/dev/null; then
        report_error "claudecfg/skills file inventory does not match the bundled skill inventory"
    else
        echo "OK: claudecfg/skills file inventory"
    fi
}

compare_skill_file_inventory

for command in "${EXPECTED_COMMANDS[@]}"; do
    command_file="$REPO_ROOT/claudecfg/commands/$command.md"
    expected_alias="$(command_alias_for "$command" || true)"
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

compare_command_lists "$REPO_ROOT/README.md" "README slash-command list" "### Slash commands" "### Required handoffs"
compare_command_lists "$REPO_ROOT/claudecfg/GUIDE.md" "GUIDE slash-command list" "## Slash Commands" "## Auto-Execution"
compare_command_lists "$REPO_ROOT/claudecfg/README.md" "claudecfg README slash-command list" "## Bundled slash commands" "## Installation"
echo ""

echo "--- Checking settings policy invariants ---"
if jq -e '.outputStyle == "Default"' "$REPO_ROOT/claudecfg/settings.json" >/dev/null; then
    echo "OK: outputStyle stays Default"
else
    report_error "claudecfg/settings.json must keep outputStyle set to Default"
fi

if jq -e '.hooks.Notification[0].hooks[0].command == "\"$HOME\"/.claude/hooks/notification.sh"' "$REPO_ROOT/claudecfg/settings.json" >/dev/null; then
    echo "OK: Notification hook command"
else
    report_error "Notification hook must point to \"$HOME\"/.claude/hooks/notification.sh"
fi
echo ""

echo "--- Checking workflow policy invariants ---"
if grep -q 'uses: actions/setup-python@v6' "$REPO_ROOT/.github/workflows/hooks-test.yml"; then
    echo "OK: Hook Contracts uses setup-python@v6"
else
    report_error "Hook Contracts must use actions/setup-python@v6"
fi

if grep -q 'uses: actions/setup-python@v6' "$REPO_ROOT/.github/workflows/validate.yml"; then
    echo "OK: Repository Checks uses setup-python@v6"
else
    report_error "Repository Checks must use actions/setup-python@v6"
fi

if grep -q 'uses: actions/setup-go@v6' "$REPO_ROOT/.github/workflows/validate.yml"; then
    echo "OK: Repository Checks uses setup-go@v6"
else
    report_error "Repository Checks must use actions/setup-go@v6"
fi

# Verify benchmark task JSON files are actually valid by running jq on a sample.
sample_json_count="$(find "$REPO_ROOT/bench/tasks" -type f -name '*.json' -print 2>/dev/null | head -n 5 | wc -l)"
if [ "$sample_json_count" -eq 0 ]; then
    report_error "No benchmark task JSON files found under bench/tasks"
fi
failed=0
while IFS= read -r json_file; do
    [ -z "$json_file" ] && continue
    if ! jq empty "$json_file" 2>/dev/null; then
        failed=1
        break
    fi
done < <(find "$REPO_ROOT/bench/tasks" -type f -name '*.json' -print | head -n 5)
if [ "$failed" -eq 0 ]; then
    echo "OK: Benchmark task JSON files are valid (sample check)"
else
    report_error "Benchmark task JSON files under bench/tasks failed jq validation"
fi

if grep -q 'uses: actions/setup-python@v6' "$REPO_ROOT/.github/workflows/python-tests.yml"; then
    echo "OK: Python Tests uses setup-python@v6"
else
    report_error "Python Tests must use actions/setup-python@v6"
fi

if grep -q -- '--suite subagents_smoke' "$REPO_ROOT/.github/workflows/behavior-benchmark-subagents-smoke.yml" \
    && grep -q 'pull_request:' "$REPO_ROOT/.github/workflows/behavior-benchmark-subagents-smoke.yml" \
    && grep -q 'scripts/download-benchmark-summary.py' "$REPO_ROOT/.github/workflows/behavior-benchmark-subagents-smoke.yml" \
    && grep -q 'render-benchmark-summary.sh bench-output/summary.json' "$REPO_ROOT/.github/workflows/behavior-benchmark-subagents-smoke.yml" \
    && grep -q 'bench-output/benchmark-report.md' "$REPO_ROOT/.github/workflows/behavior-benchmark-subagents-smoke.yml" \
    && grep -q "'install.sh'" "$REPO_ROOT/.github/workflows/behavior-benchmark-subagents-smoke.yml" \
    && grep -q "'claudecfg/install.sh'" "$REPO_ROOT/.github/workflows/behavior-benchmark-subagents-smoke.yml" \
    && grep -Fq -- "--ref-name \"\${REF_NAME:-}\"" "$REPO_ROOT/.github/workflows/behavior-benchmark-subagents-smoke.yml" \
    && ! grep -q "if: github.event_name != 'workflow_dispatch'" "$REPO_ROOT/.github/workflows/behavior-benchmark-subagents-smoke.yml"; then
    echo "OK: Behavior Benchmark Subagents Smoke PR selector"
else
    report_error "Behavior Benchmark Subagents Smoke workflow must keep installer-trigger coverage, support manual changed-file collection, and publish markdown benchmark tables"
fi

echo ""
echo "--- Checking GitHub Actions Node.js 24 readiness ---"
if grep -q 'actions/cache@v4' "$REPO_ROOT/.github/workflows/"*.yml 2>/dev/null; then
    report_error "actions/cache@v4 targets deprecated Node.js 20 — use v5"
else
    echo "OK: No actions/cache@v4 (uses v5)"
fi
if grep -q 'FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true' "$REPO_ROOT/.github/workflows/"*.yml 2>/dev/null; then
    echo "OK: FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 set"
else
    report_error "Benchmark workflows must set env: FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true"
fi
echo ""

echo "--- Checking docs consistency for notification hook ---"
if grep -q "\`Notification\`" "$REPO_ROOT/README.md" && grep -q "\`Notification\`" "$REPO_ROOT/claudecfg/GUIDE.md"; then
    echo "OK: Notification hook documented"
else
    report_error "Notification hook must be documented in README.md and claudecfg/GUIDE.md"
fi
echo ""

echo "--- Checking hook test manifests ---"
HOOK_CASES_FILE="$REPO_ROOT/tests/hooks/cases.json"
HOOK_SCENARIOS_FILE="$REPO_ROOT/tests/hooks/scenarios.json"
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
    echo "No hook case manifest found"
fi

if [ -f "$HOOK_SCENARIOS_FILE" ]; then
    if ! jq -e 'type == "array"' "$HOOK_SCENARIOS_FILE" >/dev/null; then
        report_error "Hook scenarios manifest must be a JSON array"
    else
        while IFS= read -r scenario_json; do
            scenario_name="$(jq -r '.name' <<<"$scenario_json")"
            if [ -n "$(jq -r '.seed_state // empty' <<<"$scenario_json")" ] \
                && [ ! -f "$REPO_ROOT/$(jq -r '.seed_state' <<<"$scenario_json")" ]; then
                report_error "Hook scenario '$scenario_name' references missing seed_state: $(jq -r '.seed_state' <<<"$scenario_json")"
            fi

            while IFS= read -r step_json; do
                [ -z "$step_json" ] && continue
                step_name="$(jq -r '.name' <<<"$step_json")"
                script_path="$(jq -r '.script' <<<"$step_json")"
                stdin_fixture="$(jq -r '.stdin' <<<"$step_json")"
                cwd_path="$(jq -r '.cwd // empty' <<<"$step_json")"
                seed_state="$(jq -r '.seed_state // empty' <<<"$step_json")"

                if [ ! -f "$REPO_ROOT/$script_path" ]; then
                    report_error "Hook scenario '$scenario_name::$step_name' references missing script: $script_path"
                fi
                if [ ! -f "$REPO_ROOT/$stdin_fixture" ]; then
                    report_error "Hook scenario '$scenario_name::$step_name' references missing fixture: $stdin_fixture"
                fi
                if [ -n "$cwd_path" ] && [ ! -d "$REPO_ROOT/$cwd_path" ]; then
                    report_error "Hook scenario '$scenario_name::$step_name' references missing cwd: $cwd_path"
                fi
                if [ -n "$seed_state" ] && [ ! -f "$REPO_ROOT/$seed_state" ]; then
                    report_error "Hook scenario '$scenario_name::$step_name' references missing seed_state: $seed_state"
                fi
            done < <(jq -c '.steps[]' <<<"$scenario_json")
        done < <(jq -c '.[]' "$HOOK_SCENARIOS_FILE")
        echo "OK: $HOOK_SCENARIOS_FILE"
    fi
else
    echo "No hook scenario manifest found"
fi
echo ""

echo "--- Checking installer smoke test ---"
if ! bash "$REPO_ROOT/tests/install/install-smoke.sh" >/dev/null; then
    report_error "Installer smoke/idempotency test failed"
else
    echo "OK: installer smoke/idempotency"
fi
echo ""

echo "--- Checking benchmark tasks ---"
TASK_IDS=()
EXPECTED_SUBAGENT_ALIASES=(m e a bug dbg t cr doc)
SUBAGENT_SMOKE_ALIASES_SEEN=()
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
        .id and .suite and .category and .fixture and .prompt
        and (.related_agents | type == "array" and length > 0)
        and has("review_required")
        and has("docs_required")
        and has("verification_required")
        and (.success_criteria | type == "array")
        and (.must_not | type == "array")
        and ((.forbidden_doc_patterns // []) | type == "array")
        and ((.forbidden_transcript_patterns // []) | type == "array")
        and ((.required_transcript_patterns // []) | type == "array")
        and ((.required_used_agents // []) | type == "array")
        and ((.required_used_agent_groups // []) | type == "array")
        and ((.required_used_agent_groups // []) | all(.[]?; type == "array"))
    ' "$task_file" >/dev/null; then
        report_error "Benchmark task has missing required fields: $task_file"
        continue
    fi

    if [ ! -d "$REPO_ROOT/bench/fixtures/$fixture" ]; then
        report_error "Benchmark task '$task_id' references missing fixture: $fixture"
    fi

    while IFS= read -r required_alias; do
        [ -z "$required_alias" ] && continue
        if ! printf '%s\n' "${EXPECTED_SUBAGENT_ALIASES[@]}" | grep -Fxq "$required_alias"; then
            report_error "Benchmark task references unknown required_used_agents alias '$required_alias': $task_file"
        fi
    done < <(jq -r '.required_used_agents[]? // empty' "$task_file")

    while IFS= read -r required_alias; do
        [ -z "$required_alias" ] && continue
        if ! printf '%s\n' "${EXPECTED_SUBAGENT_ALIASES[@]}" | grep -Fxq "$required_alias"; then
            report_error "Benchmark task references unknown required_used_agent_groups alias '$required_alias': $task_file"
        fi
    done < <(jq -r '.required_used_agent_groups[]?[]? // empty' "$task_file")

    if [[ "$task_file" == *"/bench/tasks/subagents/"* ]]; then
        if ! jq -e '
            .agent_alias
            and ((.forbidden_transcript_patterns // []) | type == "array" and length > 0)
            and (
                ((.required_transcript_patterns // []) | type == "array" and length > 0)
                or ((.required_used_agents // []) | type == "array" and length > 0)
                or ((.required_used_agent_groups // []) | type == "array" and any(.[]?; type == "array" and length > 0))
            )
        ' "$task_file" >/dev/null; then
            report_error "Subagent benchmark task must declare agent_alias, non-empty forbidden transcript patterns, and at least one required transcript or used-agent assertion: $task_file"
        else
            if [[ "$task_file" == *"/bench/tasks/subagents/smoke/"* ]]; then
                SUBAGENT_SMOKE_ALIASES_SEEN+=("$agent_alias")
            fi
        fi

        if jq -e '(.required_transcript_patterns // []) | length > 0' "$task_file" >/dev/null; then
            for required_regex in "${SUBAGENT_REQUIRED_FOOTER_REGEXES[@]}"; do
                if ! jq -e --arg pattern "$required_regex" '
                    (.required_transcript_patterns // []) | any(test($pattern))
                ' "$task_file" >/dev/null; then
                    report_error "Subagent benchmark task is missing required footer transcript pattern '$required_regex': $task_file"
                fi
            done
        fi

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
    if ! printf '%s\n' "${SUBAGENT_SMOKE_ALIASES_SEEN[@]}" | grep -Fxq "$expected_alias"; then
        report_error "Missing subagent smoke benchmark coverage for agent alias: $expected_alias"
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
        # bash 3.2 / BSD grep does not support -P (PCRE). Use sed -E.
        done < <(sed -nE 's/.*\]\(([^)]*)\).*/\1/p' <<<"$line" | tr -d ')' || true)
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

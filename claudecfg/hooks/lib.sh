#!/bin/bash

set -euo pipefail

HOOK_INPUT="$(cat)"
STATE_ROOT="${HOME}/.claude/state"
LOG_ROOT="${HOME}/.claude/logs"

json_get() {
    local filter="$1"
    jq -r "$filter // empty" <<<"$HOOK_INPUT"
}

json_get_bool() {
    local filter="$1"
    jq -r "if ($filter) == true then \"true\" else \"false\" end" <<<"$HOOK_INPUT"
}

resolve_transcript_path() {
    local path

    path="$(json_get '.transcript_path')"
    if [ -z "$path" ] && [ -f "$(state_file)" ]; then
        path="$(jq -r '.transcript_path // empty' "$(state_file)")"
    fi

    printf "%s" "$path"
}

extract_last_assistant_message_from_transcript() {
    local transcript_path="$1"

    if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
        return 0
    fi

    jq -s -r '
        def flattened_text:
            if type == "array" then
                [
                    .[]?
                    | if type == "object" then
                        .text // .result // .content // empty
                    else
                        empty
                    end
                ]
                | map(select(type == "string" and (gsub("\\s+"; " ") | length) > 0))
                | join("\n")
            else
                empty
            end;

        def assistant_text:
            [
                .last_assistant_message?,
                .result?,
                .message?.content? | flattened_text,
                .content? | flattened_text,
                .message?.text?,
                .text?
            ]
            | map(select(type == "string" and (gsub("\\s+"; " ") | length) > 0))
            | .[0] // "";

        [
            reverse[]
            | select(
                (.type? == "assistant")
                or (.type? == "result")
                or (.role? == "assistant")
                or (.message?.role? == "assistant")
            )
            | assistant_text
            | select(length > 0)
        ][0] // ""
    ' "$transcript_path" 2>/dev/null || true
}

resolved_last_assistant_message() {
    local message transcript_path

    message="$(
        jq -r '
            .last_assistant_message
            // .assistant_message
            // .result
            // .message.text
            // .text
            // empty
        ' <<<"$HOOK_INPUT"
    )"
    if [ -n "$message" ]; then
        printf "%s" "$message"
        return 0
    fi

    transcript_path="$(resolve_transcript_path)"
    extract_last_assistant_message_from_transcript "$transcript_path"
}

timestamp_utc() {
    date -u +"%Y-%m-%dT%H:%M:%SZ"
}

safe_session_id() {
    local raw
    raw="$(json_get '.session_id')"
    if [ -z "$raw" ]; then
        raw="no-session"
    fi
    printf "%s" "$raw" | tr -c 'A-Za-z0-9._-' '_'
}

state_file() {
    printf "%s/%s.json" "$STATE_ROOT" "$(safe_session_id)"
}

ensure_dirs() {
    mkdir -p "$STATE_ROOT" "$LOG_ROOT"
}

ensure_state() {
    local file
    file="$(state_file)"
    ensure_dirs
    if [ -f "$file" ]; then
        return
    fi

    jq -n \
        --arg session_id "$(json_get '.session_id')" \
        --arg cwd "$(json_get '.cwd')" \
        --arg transcript_path "$(json_get '.transcript_path')" \
        --arg created_at "$(timestamp_utc)" \
        '{
            session_id: $session_id,
            cwd: $cwd,
            transcript_path: $transcript_path,
            created_at: $created_at,
            task_type: "other",
            manager_mode: "none",
            edited: false,
            code_changed: false,
            docs_changed: false,
            tests_ok: false,
            tests_failed: false,
            lint_ok: false,
            lint_failed: false,
            build_ok: false,
            build_failed: false,
            detected_test_command: "",
            detected_lint_command: "",
            detected_build_command: "",
            last_test_command: "",
            last_lint_command: "",
            last_build_command: "",
            subagent_start_count: 0,
            subagents_started: [],
            subagent_events: [],
            subagent_instance_count_by_role: {},
            required_subagents: [],
            required_subagent_any_of: [],
            stop_block_count: 0,
            stop_block_reason: "",
            stop_block_message: "",
            subagent_stop_block_count: 0,
            subagent_stop_block_reason: "",
            subagent_stop_block_message: "",
            files: []
        }' > "$file"
}

update_state() {
    local jq_program="$1"
    local file
    local tmp

    file="$(state_file)"
    tmp="$(mktemp)"
    jq "$jq_program" "$file" > "$tmp"
    mv "$tmp" "$file"
}

record_loop_block() {
    local prefix="$1"
    local reason="$2"
    local message="$3"
    local count_key reason_key message_key file tmp previous_reason previous_message previous_count next_count

    case "$prefix" in
        stop)
            count_key="stop_block_count"
            reason_key="stop_block_reason"
            message_key="stop_block_message"
            ;;
        subagent_stop)
            count_key="subagent_stop_block_count"
            reason_key="subagent_stop_block_reason"
            message_key="subagent_stop_block_message"
            ;;
        *)
            return 1
            ;;
    esac

    file="$(state_file)"
    previous_reason="$(jq -r --arg key "$reason_key" '.[$key] // empty' "$file")"
    previous_message="$(jq -r --arg key "$message_key" '.[$key] // empty' "$file")"
    previous_count="$(jq -r --arg key "$count_key" '.[$key] // 0' "$file")"

    if [ "$previous_reason" = "$reason" ] && [ "$previous_message" = "$message" ]; then
        next_count=$((previous_count + 1))
    else
        next_count=1
    fi

    tmp="$(mktemp)"
    jq \
        --arg count_key "$count_key" \
        --arg reason_key "$reason_key" \
        --arg message_key "$message_key" \
        --arg reason "$reason" \
        --arg message "$message" \
        --argjson count "$next_count" \
        '.[$count_key] = $count
        | .[$reason_key] = $reason
        | .[$message_key] = $message' "$file" > "$tmp"
    mv "$tmp" "$file"
}

clear_loop_block() {
    local prefix="$1"
    local count_key reason_key message_key tmp

    case "$prefix" in
        stop)
            count_key="stop_block_count"
            reason_key="stop_block_reason"
            message_key="stop_block_message"
            ;;
        subagent_stop)
            count_key="subagent_stop_block_count"
            reason_key="subagent_stop_block_reason"
            message_key="subagent_stop_block_message"
            ;;
        *)
            return 1
            ;;
    esac

    tmp="$(mktemp)"
    jq \
        --arg count_key "$count_key" \
        --arg reason_key "$reason_key" \
        --arg message_key "$message_key" \
        '.[$count_key] = 0
        | .[$reason_key] = ""
        | .[$message_key] = ""' "$(state_file)" > "$tmp"
    mv "$tmp" "$(state_file)"
}

loop_block_count() {
    local prefix="$1"
    local key

    case "$prefix" in
        stop)
            key="stop_block_count"
            ;;
        subagent_stop)
            key="subagent_stop_block_count"
            ;;
        *)
            return 1
            ;;
    esac

    jq -r --arg key "$key" '.[$key] // 0' "$(state_file)"
}

emit_loop_aware_block() {
    local prefix="$1"
    local reason="$2"
    local message="$3"
    local count final_reason error_message checklist_output

    record_loop_block "$prefix" "$reason" "$message"
    count="$(loop_block_count "$prefix")"
    final_reason="$reason"
    error_message="$reason"

    if [ "$count" -ge 3 ]; then
        final_reason="Repeated stop-block loop detected (${count}x): ${reason} Do not retry the same final response again; change the summary or perform the required action first."
        error_message="Repeated stop-block loop detected (${count}x)"
    fi

    checklist_output="$(build_block_checklist "$prefix" "$final_reason" "$message")"

    jq -n --arg checklist "$checklist_output" --arg reason "$final_reason" '{
        decision: "block",
        reason: $reason,
        errorDetails: $checklist
    }'
}

append_jsonl() {
    local name="$1"
    local payload="$2"
    ensure_dirs
    printf "%s\n" "$payload" >> "${LOG_ROOT}/${name}"
}

emit_context() {
    local event_name="$1"
    local message="$2"
    jq -n \
        --arg event_name "$event_name" \
        --arg message "$message" \
        '{
            hookSpecificOutput: {
                hookEventName: $event_name,
                additionalContext: $message
            }
        }'
}

emit_pretool_decision() {
    local decision="$1"
    local reason="$2"
    local error_details=""
    error_details+="### PreToolUse Decision\n\n"
    error_details+="- **Decision:** ${decision}\n"
    error_details+="- **Reason:** ${reason}\n"
    error_details+="\n### What to Do Instead\n\n"
    error_details+="- Use safe alternatives to blocked commands\n"
    error_details+="- For build/test/deploy, use the repo's CI/CD workflow\n"
    error_details+="\n---\n"
    error_details+="**Decision:** ${decision}\n"
    error_details+="**Reason:** ${reason}\n"
    jq -n \
        --arg decision "$decision" \
        --arg reason "$reason" \
        --arg error_details "$error_details" \
        '{
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: $decision,
                permissionDecisionReason: $reason,
                errorDetails: $error_details
            }
        }'
}

emit_permission_request_deny() {
    local message="$1"
    local error_details=""
    error_details+="### Permission Request Denied\n\n"
    error_details+="- **Decision:** deny\n"
    error_details+="- **Reason:** ${message}\n"
    error_details+="\n### What to Do Instead\n\n"
    error_details+="- Use allowed commands per the profile\n"
    error_details+="- For manual review, use the CLI directly with explicit approval\n"
    error_details+="\n---\n"
    error_details+="**Decision:** deny\n"
    error_details+="**Reason:** ${message}\n"
    jq -n \
        --arg message "$message" \
        --arg error_details "$error_details" \
        '{
            hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: {
                    behavior: "deny",
                    message: $message,
                    errorDetails: $error_details
                }
            }
        }'
}

emit_permission_denied_retry() {
    jq -n '{ retry: true }'
}

emit_permission_denied_no_retry() {
    jq -n '{ retry: false }'
}

permission_denied_should_retry() {
    if [ -n "${BENCH_TASK_ID:-}" ] || [ -n "${BENCH_TASK_FILE:-}" ] || [ -n "${BENCH_WORKDIR:-}" ]; then
        return 1
    fi

    return 0
}

stop_safe_no_change_footer_hint() {
    printf ' If this reply did not introduce additional changes, still report the actual verification, review, changed files, and remaining risks instead of using a no-change shortcut after code or config changes.'
}

checklist_status_line() {
    local status="$1"
    local label="$2"
    local detail="$3"

    printf -- "- [%s] %s" "$status" "$label"
    if [ -n "$detail" ]; then
        printf -- " %s" "$detail"
    fi
    printf "\n"
}

message_has_line_prefix() {
    local message="$1"
    local prefix="$2"
    local line=""

    while IFS= read -r line; do
        if [[ "$line" == "$prefix"* ]]; then
            return 0
        fi
    done <<<"$message"

    return 1
}

extract_subagent_label() {
    local raw

    raw="$(
        jq -r '
        .agent_alias
        // .agentAlias
        // .alias
        // .subagent_alias
        // .subagentAlias
        // .subagent_type
        // .subagentType
        // .tool_input.agent_alias
        // .tool_input.agentAlias
        // .tool_input.alias
        // .tool_input.subagent_alias
        // .tool_input.subagentAlias
        // .tool_input.subagent_type
        // .tool_input.subagentType
        // .agent_name
        // .agentName
        // .subagent_name
        // .subagentName
        // .name
        // .tool_input.agent
        // .tool_input.agent_name
        // .tool_input.agentName
        // .tool_input.subagent_name
        // .tool_input.subagentName
        // .tool_input.name
        // .tool_input.type
        // .tool_input.agent_type
        // .tool_input.agentType
        // .agent_type
        // .agentType
        // .type
        // empty
    ' <<<"$HOOK_INPUT"
    )"

    canonicalize_subagent_label "$raw"
}

extract_subagent_scope() {
    jq -r '
        .tool_input.description
        // .tool_input.prompt
        // .tool_input.task
        // .description
        // .prompt
        // .task
        // empty
    ' <<<"$HOOK_INPUT" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

canonicalize_subagent_label() {
    local raw="$1"
    local normalized

    normalized="$(printf "%s" "$raw" \
        | tr '[:upper:]' '[:lower:]' \
        | sed -E 's/^@//; s/[[:space:]_]+/-/g; s/[^a-z0-9.-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"

    case "$normalized" in
        "")
            printf ""
            ;;
        a|architect|the-architect)
            printf "a"
            ;;
        e|explorer|nerd)
            printf "e"
            ;;
        bug|bugbuster|bug-pattern-hunter|bug-pattern)
            printf "bug"
            ;;
        dbg|debugger|debugging-specialist)
            printf "dbg"
            ;;
        t|tester|paranoid)
            printf "t"
            ;;
        cr|code-reviewer|code-review|reviewer|toxic-senior)
            printf "cr"
            ;;
        doc|docwriter|wiki-wiki|documentation-writer|docs-writer)
            printf "doc"
            ;;
        hk|housekeeper|the-cleaner|cleaner)
            printf "hk"
            ;;
        m|manager|big-boss)
            printf "m"
            ;;
        *)
            printf "%s" "$normalized"
            ;;
    esac
}

array_contains() {
    local needle="$1"
    shift

    local item
    for item in "$@"; do
        if [ "$item" = "$needle" ]; then
            return 0
        fi
    done

    return 1
}

sorted_unique_lines() {
    awk 'NF { seen[$0] = 1 } END { for (line in seen) print line }' | sort
}

transcript_text_content() {
    local transcript_path="$1"

    if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
        return 0
    fi

    jq -Rr 'fromjson? | .. | strings?' "$transcript_path" 2>/dev/null || true
}

transcript_indicates_backgrounded_agent() {
    local transcript_path text

    transcript_path="$(resolve_transcript_path)"
    if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
        return 1
    fi

    text="$(transcript_text_content "$transcript_path" | tr '[:upper:]' '[:lower:]')"
    grep -Fq 'backgrounded agent' <<<"$text"
}

infer_started_roles_from_transcript() {
    local transcript_path text roles=""

    transcript_path="$(resolve_transcript_path)"
    if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
        return 0
    fi

    text="$(transcript_text_content "$transcript_path" | tr '[:upper:]' '[:lower:]')"
    [ -z "$text" ] && return 0

    if grep -Fq 'skill(/manager)' <<<"$text"; then
        roles="${roles}"$'\n''m'
    fi
    if grep -Fq 'skill(/review)' <<<"$text"; then
        roles="${roles}"$'\n''cr'
    fi
    if grep -Fq 'skill(/test)' <<<"$text"; then
        roles="${roles}"$'\n''t'
    fi
    if grep -Fq 'skill(/explore)' <<<"$text"; then
        roles="${roles}"$'\n''e'
    fi
    if grep -Fq 'skill(/design)' <<<"$text"; then
        roles="${roles}"$'\n''a'
    fi
    if grep -Fq 'skill(/bug)' <<<"$text"; then
        roles="${roles}"$'\n''bug'
    fi
    if grep -Fq 'skill(/debug)' <<<"$text"; then
        roles="${roles}"$'\n''dbg'
    fi
    if grep -Fq 'skill(/docs)' <<<"$text"; then
        roles="${roles}"$'\n''doc'
    fi
    if grep -Fq 'skill(/refactor)' <<<"$text"; then
        roles="${roles}"$'\n''hk'
    fi

    if grep -Eq '(^|[[:space:]])manager\(' <<<"$text"; then
        roles="${roles}"$'\n''m'
    fi
    if grep -Eq '(^|[[:space:]])code reviewer\(' <<<"$text"; then
        roles="${roles}"$'\n''cr'
    fi
    if grep -Eq '(^|[[:space:]])tester\(' <<<"$text"; then
        roles="${roles}"$'\n''t'
    fi
    if grep -Eq '(^|[[:space:]])explorer\(' <<<"$text"; then
        roles="${roles}"$'\n''e'
    fi
    if grep -Eq '(^|[[:space:]])architect\(' <<<"$text"; then
        roles="${roles}"$'\n''a'
    fi
    if grep -Eq '(^|[[:space:]])bugbuster\(' <<<"$text"; then
        roles="${roles}"$'\n''bug'
    fi
    if grep -Eq '(^|[[:space:]])debugger\(' <<<"$text"; then
        roles="${roles}"$'\n''dbg'
    fi
    if grep -Eq '(^|[[:space:]])docwriter\(' <<<"$text"; then
        roles="${roles}"$'\n''doc'
    fi
    if grep -Eq '(^|[[:space:]])(housekeeper|veles)\(' <<<"$text"; then
        roles="${roles}"$'\n''hk'
    fi

    printf "%s\n" "$roles" | sorted_unique_lines
}

effective_started_roles() {
    local state explicit_roles inferred_roles

    state="$(state_file)"
    explicit_roles="$(jq -r '.subagents_started[]? // empty' "$state")"
    inferred_roles="$(infer_started_roles_from_transcript)"

    printf "%s\n%s\n" "$explicit_roles" "$inferred_roles" | sorted_unique_lines
}

session_background_manager_pending() {
    local state task_type manager_mode code_changed started_roles

    state="$(state_file)"
    task_type="$(jq -r '.task_type // "other"' "$state")"
    manager_mode="$(jq -r '.manager_mode // "none"' "$state")"
    code_changed="$(jq -r '.code_changed // false' "$state")"

    case "$task_type" in
        feature|bugfix|refactor|review|docs)
            ;;
        *)
            return 1
            ;;
    esac

    if [ "$manager_mode" != "orchestrate" ] || [ "$code_changed" = "true" ]; then
        return 1
    fi

    if ! transcript_indicates_backgrounded_agent; then
        return 1
    fi

    started_roles="$(effective_started_roles)"
    if ! grep -Fxq 'm' <<<"$started_roles"; then
        return 1
    fi

    return 0
}

format_subagent_list() {
    local item result=""

    for item in "$@"; do
        if [ -n "$result" ]; then
            result="${result}, "
        fi
        result="${result}@${item}"
    done

    printf "%s" "${result:-none}"
}

format_subagent_group() {
    local item result=""

    for item in "$@"; do
        if [ -n "$result" ]; then
            result="${result}/"
        fi
        result="${result}@${item}"
    done

    printf "%s" "$result"
}

detect_node_script() {
    local script_name="$1"
    if [ -f package.json ] && jq -e --arg name "$script_name" '.scripts[$name] != null' package.json >/dev/null 2>&1; then
        printf "npm run %s" "$script_name"
        return 0
    fi
    return 1
}

detect_test_cmd() {
    local cmd=""

    if cmd="$(detect_node_script test)"; then
        printf "%s" "$cmd"
        return 0
    fi
    if [ -f Cargo.toml ]; then
        printf "cargo test"
        return 0
    fi
    if [ -f go.mod ]; then
        printf "go test ./..."
        return 0
    fi
    if [ -f pytest.ini ] || [ -f pyproject.toml ] || [ -d tests ]; then
        printf "pytest"
        return 0
    fi

    return 1
}

detect_lint_cmd() {
    local cmd=""

    if cmd="$(detect_node_script lint)"; then
        printf "%s" "$cmd"
        return 0
    fi
    if [ -f Cargo.toml ]; then
        printf "cargo clippy --all-targets --all-features -- -D warnings"
        return 0
    fi
    if [ -f pyproject.toml ] || [ -d tests ]; then
        printf "python -m compileall ."
        return 0
    fi

    return 1
}

detect_build_cmd() {
    local cmd=""

    if cmd="$(detect_node_script build)"; then
        printf "%s" "$cmd"
        return 0
    fi
    if [ -f Cargo.toml ]; then
        printf "cargo build"
        return 0
    fi
    if [ -f go.mod ]; then
        printf "go build ./..."
        return 0
    fi
    if [ -f Makefile ] || [ -f makefile ]; then
        printf "make"
        return 0
    fi

    return 1
}

command_class() {
    local command="$1"

    case "$command" in
        *"pytest"*|*"npm test"*|*"npm run test"*|*"pnpm test"*|*"yarn test"*|*"cargo test"*|*"go test"*|*"ctest"*|*"make test"*)
            printf "test"
            ;;
        *"npm run lint"*|*"pnpm lint"*|*"yarn lint"*|*"ruff"*|*"flake8"*|*"cargo clippy"*|*"golangci-lint"*|*"eslint"*|*"shellcheck"*|*"python -m compileall "*|*"make lint"*)
            printf "lint"
            ;;
        *"npm run build"*|*"pnpm build"*|*"yarn build"*|*"cargo build"*|*"go build"*|*"cmake --build"*|*"make"*)
            printf "build"
            ;;
        *)
            printf "other"
            ;;
    esac
}

is_release_or_deploy_command() {
    local command="$1"

    [[ "$command" == *"npm publish"* \
        || "$command" == *"cargo publish"* \
        || "$command" == *"docker push"* \
        || "$command" == *"gh release"* \
        || "$command" == *"kubectl apply"* \
        || "$command" == *"helm upgrade"* ]]
}

is_remote_shell_bootstrap_command() {
    local command="$1"

    if { [[ "$command" =~ (^|[[:space:]])curl($|[[:space:]]) ]] || [[ "$command" =~ (^|[[:space:]])wget($|[[:space:]]) ]]; } \
        && [[ "$command" =~ [|][[:space:]]*[[:alnum:]_./-]*(sh|bash|zsh|dash|ksh)($|[[:space:]]) ]]; then
        return 0
    fi

    return 1
}

command_is_hard_denied_by_profile() {
    local command="$1"

    if [[ "$command" =~ (^|[[:space:]])sudo($|[[:space:]]) ]]; then
        return 0
    fi

    if [[ "$command" =~ (^|[[:space:]])mkfs(\.[^[:space:]]+)?($|[[:space:]]) ]] || [[ "$command" =~ (^|[[:space:]])dd($|[[:space:]]) ]]; then
        return 0
    fi

    if [[ "$command" == *"rm -rf /"* || "$command" == *"git reset --hard"* ]] \
        || { [[ "$command" =~ git[[:space:]]+push ]] && [[ "$command" =~ (^|[[:space:]])(-f|--force|--force-with-lease)($|[[:space:]]) ]]; }; then
        return 0
    fi

    if is_release_or_deploy_command "$command"; then
        return 0
    fi

    if is_remote_shell_bootstrap_command "$command"; then
        return 0
    fi

    return 1
}

message_mentions_verification_status() {
    local message="$1"

    message_has_line_prefix "$message" "Verification status:" \
        || message_has_line_prefix "$message" "Verification:" \
        || message_has_line_prefix "$message" "Verification result:" \
        || message_has_line_prefix "$message" "Test status:" \
        || message_has_line_prefix "$message" "Tests:"
}

message_mentions_review_outcome() {
    local message="$1"

    message_has_line_prefix "$message" "Review outcome:" \
        || message_has_line_prefix "$message" "Review status:" \
        || message_has_line_prefix "$message" "Review:"
}

message_mentions_changed_files() {
    local message="$1"

    message_has_line_prefix "$message" "Changed files:" \
        || message_has_line_prefix "$message" "Key files changed:" \
        || message_has_line_prefix "$message" "Files changed:" \
        || message_has_line_prefix "$message" "Updated files:" \
        || message_has_line_prefix "$message" "Modified files:" \
        || message_has_line_prefix "$message" "No files changed:"
}

message_mentions_remaining_risks() {
    local message="$1"

    message_has_line_prefix "$message" "Remaining risks:" \
        || message_has_line_prefix "$message" "Residual risks:" \
        || message_has_line_prefix "$message" "Risks:"
}

message_mentions_next_step() {
    local message="$1"

    message_has_line_prefix "$message" "Next step:" \
        || message_has_line_prefix "$message" "Next steps:" \
        || message_has_line_prefix "$message" "Follow-up:" \
        || message_has_line_prefix "$message" "Follow up:" \
        || message_has_line_prefix "$message" "Pending next:" \
        || message_has_line_prefix "$message" "Следующий шаг:" \
        || message_has_line_prefix "$message" "Следующие шаги:" \
        || message_has_line_prefix "$message" "Дальше:" \
        || message_has_line_prefix "$message" "Следующее:"
}

message_mentions_concrete_outcome() {
    local message="$1"

    grep -Eiq '(outcome|result|implemented|updated|fixed|investigated|reviewed|documented|added|removed|refactored|changed|created|no changes|completed|done|исправил|обновил|добавил|удалил|проверил|нашел|сделал|без изменений)' <<<"$message"
}

message_reports_no_changes() {
    local message="$1"

    message_has_line_prefix "$message" "No changes were made." \
        || message_has_line_prefix "$message" "No files changed." \
        || message_has_line_prefix "$message" "Nothing changed."
}

block_checklist_summary_requirements() {
    local prefix="$1"
    local message="$2"
    local state code_changed task_type
    local verification_ok review_ok files_ok risks_ok next_ok outcome_ok

    state="$(state_file)"
    code_changed="$(jq -r '.code_changed // false' "$state")"
    task_type="$(jq -r '.task_type // "other"' "$state")"

    printf "### Requirement Checklist\n\n"

    if [ "$prefix" = "stop" ]; then
        if [ "$code_changed" != "true" ] || [ "$task_type" = "other" ]; then
            checklist_status_line "SKIP" "Implementation summary lines" "Not required for this stop event."
            return 0
        fi

        verification_ok="FAIL"
        review_ok="FAIL"
        files_ok="FAIL"
        risks_ok="FAIL"

        if message_mentions_verification_status "$message"; then
            verification_ok="PASS"
        fi
        if message_mentions_review_outcome "$message"; then
            review_ok="PASS"
        fi
        if message_mentions_changed_files "$message"; then
            files_ok="PASS"
        fi
        if message_mentions_remaining_risks "$message"; then
            risks_ok="PASS"
        fi

        checklist_status_line "$verification_ok" "Verification status line" 'Accepted prefixes: `Verification status:`, `Verification:`, `Verification result:`, `Test status:`, `Tests:`.'
        checklist_status_line "$review_ok" "Review outcome line" 'Accepted prefixes: `Review outcome:`, `Review status:`, `Review:`.'
        checklist_status_line "$files_ok" "Changed files line" 'Accepted prefixes: `Changed files:`, `Key files changed:`, `Files changed:`, `Updated files:`, `Modified files:`, `No files changed:`.'
        checklist_status_line "$risks_ok" "Remaining risks line" 'Accepted prefixes: `Remaining risks:`, `Residual risks:`, `Risks:`.'

        if message_reports_no_changes "$message"; then
            checklist_status_line "FAIL" "No-change shortcut" 'Do not use `No changes were made.` after code/config changes.'
        else
            checklist_status_line "PASS" "No-change shortcut" "No forbidden no-change shortcut detected."
        fi
        return 0
    fi

    outcome_ok="FAIL"
    files_ok="FAIL"
    verification_ok="FAIL"
    risks_ok="FAIL"
    next_ok="FAIL"

    if message_mentions_concrete_outcome "$message"; then
        outcome_ok="PASS"
    fi
    if message_mentions_changed_files "$message"; then
        files_ok="PASS"
    fi
    if message_mentions_verification_status "$message"; then
        verification_ok="PASS"
    fi
    if message_mentions_remaining_risks "$message"; then
        risks_ok="PASS"
    fi
    if message_mentions_next_step "$message"; then
        next_ok="PASS"
    fi

    checklist_status_line "$outcome_ok" "Concrete outcome" 'Example prefixes/content: `Outcome:`, `Result:`, or a concrete action like `fixed`, `updated`, `implemented`.'
    checklist_status_line "$files_ok" "Changed files line" 'Accepted prefixes: `Changed files:`, `Files changed:`, `Updated files:`, `Modified files:`, `No files changed:`.'
    checklist_status_line "$verification_ok" "Verification status line" 'Accepted prefixes: `Verification status:`, `Verification:`, `Verification result:`, `Test status:`, `Tests:`.'
    if [ "$risks_ok" = "PASS" ] || [ "$next_ok" = "PASS" ]; then
        checklist_status_line "PASS" "Closure line" 'Need either `Remaining risks:` or `Next step:`.'
    else
        checklist_status_line "FAIL" "Closure line" 'Add either `Remaining risks:` or `Next step:`.'
    fi
}

block_checklist_gate_requirements() {
    local prefix="$1"
    local state code_changed task_type
    local verification_reason handoff_reason

    state="$(state_file)"
    code_changed="$(jq -r '.code_changed // false' "$state")"
    task_type="$(jq -r '.task_type // "other"' "$state")"

    if [ "$prefix" != "stop" ]; then
        return 0
    fi

    printf "\n### Workflow Gates\n\n"

    if [ "$code_changed" = "true" ]; then
        verification_reason="$(session_block_reason || true)"
        if [ -n "$verification_reason" ]; then
            checklist_status_line "FAIL" "Verification gate" "$verification_reason"
        else
            checklist_status_line "PASS" "Verification gate" "No failing or missing required verification commands detected."
        fi
    else
        checklist_status_line "SKIP" "Verification gate" "No code/config changes recorded."
    fi

    case "$task_type" in
        feature|bugfix|refactor|review|docs)
            handoff_reason="$(session_agent_enforcement_reason || true)"
            if [ -n "$handoff_reason" ]; then
                checklist_status_line "FAIL" "Required specialist handoffs" "$handoff_reason"
            else
                checklist_status_line "PASS" "Required specialist handoffs" "All required roles for this workflow are satisfied."
            fi
            ;;
        *)
            checklist_status_line "SKIP" "Required specialist handoffs" "No workflow-specific handoff requirement for this task type."
            ;;
    esac
}

block_checklist_fix_template() {
    local prefix="$1"

    printf "\n### Minimal Valid Template\n\n"
    if [ "$prefix" = "stop" ]; then
        cat <<'EOF'
```text
Verification status: passed|failed|not run - <what you ran or why not>
Review outcome: done|pending - <what review happened or why pending>
Changed files: <path1>, <path2> | No files changed: <reason>
Remaining risks: none | <specific risk>
```
EOF
    else
        cat <<'EOF'
```text
Outcome: <concrete result>
Changed files: <path1>, <path2> | No files changed: <reason>
Verification status: passed|failed|not run - <command or reason>
Remaining risks: none | <specific risk>
```
If risks are not known yet, replace the last line with:
```text
Next step: <single concrete next action>
```
EOF
    fi
}

build_block_checklist() {
    local prefix="$1"
    local final_reason="$2"
    local message="$3"

    printf "### Block Reason\n\n"
    printf -- "- **Reason:** %s\n" "$final_reason"
    printf "\n"
    block_checklist_summary_requirements "$prefix" "$message"
    block_checklist_gate_requirements "$prefix"
    block_checklist_fix_template "$prefix"
    printf "\n### Your Current Response\n\n"
    printf "```text\n%s\n```\n" "$message"
    printf "\n---\n"
    printf "**Decision:** block\n"
    printf "**Reason:** %s\n" "$final_reason"
}

session_block_reason() {
    local state code_changed tests_ok tests_failed lint_ok lint_failed build_ok build_failed
    local detected_test_command detected_lint_command detected_build_command
    local last_test_command last_lint_command last_build_command
    local has_detected_verification="false"
    local has_behavior_verification="false"

    state="$(state_file)"
    code_changed="$(jq -r '.code_changed // false' "$state")"
    tests_ok="$(jq -r '.tests_ok // false' "$state")"
    tests_failed="$(jq -r '.tests_failed // false' "$state")"
    lint_ok="$(jq -r '.lint_ok // false' "$state")"
    lint_failed="$(jq -r '.lint_failed // false' "$state")"
    build_ok="$(jq -r '.build_ok // false' "$state")"
    build_failed="$(jq -r '.build_failed // false' "$state")"
    detected_test_command="$(jq -r '.detected_test_command // empty' "$state")"
    detected_lint_command="$(jq -r '.detected_lint_command // empty' "$state")"
    detected_build_command="$(jq -r '.detected_build_command // empty' "$state")"
    last_test_command="$(jq -r '.last_test_command // empty' "$state")"
    last_lint_command="$(jq -r '.last_lint_command // empty' "$state")"
    last_build_command="$(jq -r '.last_build_command // empty' "$state")"

    if [ -n "$detected_test_command" ] || [ -n "$detected_lint_command" ] || [ -n "$detected_build_command" ]; then
        has_detected_verification="true"
    fi

    if [ "$tests_ok" = "true" ]; then
        has_behavior_verification="true"
    elif [ -z "$detected_test_command" ] && { [ "$lint_ok" = "true" ] || [ "$build_ok" = "true" ]; }; then
        has_behavior_verification="true"
    fi

    if [ "$code_changed" = "true" ] && [ "$tests_failed" = "true" ]; then
        printf "Code or config changed, but the latest test command failed in this session (%s). Fix the failure and rerun verification before stopping." "${last_test_command:-test command}"
        return 0
    fi

    if [ "$code_changed" = "true" ] && [ "$lint_failed" = "true" ]; then
        printf "Code or config changed, but the latest lint/static-check command failed in this session (%s). Fix the failure and rerun it successfully before stopping." "${last_lint_command:-lint command}"
        return 0
    fi

    if [ "$code_changed" = "true" ] && [ "$build_failed" = "true" ]; then
        printf "Code or config changed, but the latest build command failed in this session (%s). Fix the failure and rerun it successfully before stopping." "${last_build_command:-build command}"
        return 0
    fi

    if [ "$code_changed" = "true" ] && [ "$has_detected_verification" = "true" ] && [ "$has_behavior_verification" != "true" ]; then
        if [ -n "$detected_test_command" ]; then
            printf "Code or config changed, and this repo has a detected test command (%s), but no successful test command was recorded in this session. Run the detected tests before stopping." "$detected_test_command"
        else
            printf "Code or config changed, but no successful verification command was recorded in this session. Run a detected lint or build command before stopping."
        fi
        return 0
    fi

    return 1
}

session_agent_enforcement_reason() {
    local state task_type manager_mode started_json group_json group_label missing_groups_text satisfied alias
    local tests_ok lint_ok build_ok detected_test_command successful_verification
    local -a started=() required=() group=() missing=() missing_groups=()

    state="$(state_file)"
    task_type="$(jq -r '.task_type // "other"' "$state")"
    manager_mode="$(jq -r '.manager_mode // "none"' "$state")"
    tests_ok="$(jq -r '.tests_ok // false' "$state")"
    lint_ok="$(jq -r '.lint_ok // false' "$state")"
    build_ok="$(jq -r '.build_ok // false' "$state")"
    detected_test_command="$(jq -r '.detected_test_command // empty' "$state")"
    successful_verification="false"
    if [ "$tests_ok" = "true" ]; then
        successful_verification="true"
    elif [ -z "$detected_test_command" ] && { [ "$lint_ok" = "true" ] || [ "$build_ok" = "true" ]; }; then
        successful_verification="true"
    fi

    mapfile -t started < <(effective_started_roles)
    mapfile -t required < <(jq -r '.required_subagents[]? // empty' "$state")

    while IFS= read -r group_json; do
        [ -z "$group_json" ] && continue
        mapfile -t group < <(jq -r '.[]? // empty' <<<"$group_json")
        [ "${#group[@]}" -eq 0 ] && continue

        satisfied="false"
        for alias in "${group[@]}"; do
            if array_contains "$alias" "${started[@]}"; then
                satisfied="true"
                break
            fi
        done
        if [ "$satisfied" != "true" ]; then
            group_label="$(format_subagent_group "${group[@]}")"
            missing_groups+=("$group_label")
        fi
    done < <(jq -c '.required_subagent_any_of[]? // empty' "$state")

    if [ "${#required[@]}" -eq 0 ] && [ "${#missing_groups[@]}" -eq 0 ]; then
        return 1
    fi

    for alias in "${required[@]}"; do
        if [ "$alias" = "t" ] && [ "$successful_verification" = "true" ]; then
            continue
        fi
        if ! array_contains "$alias" "${started[@]}"; then
            missing+=("$alias")
        fi
    done

    if [ "${#missing[@]}" -eq 0 ] && [ "${#missing_groups[@]}" -eq 0 ]; then
        return 1
    fi

    started_json="$(format_subagent_list "${started[@]}")"
    printf "Agent-enforced workflow requires specific subagent handoffs before completion for %s work." "$task_type"
    if [ "$manager_mode" = "orchestrate" ]; then
        printf " Manager-led orchestration is active."
    fi
    if [ "${#missing[@]}" -gt 0 ]; then
        printf " Missing required roles: %s." "$(format_subagent_list "${missing[@]}")"
    fi
    if [ "${#missing_groups[@]}" -gt 0 ]; then
        missing_groups_text="$(printf "%s\n" "${missing_groups[@]}" | paste -sd ',' - | sed 's/,/, /g')"
        printf " Missing one-of groups: %s." "$missing_groups_text"
    fi
    printf " Used so far: %s." "$started_json"
    return 0
}

session_manager_idle_reason() {
    local state task_type manager_mode specialist_count

    state="$(state_file)"
    task_type="$(jq -r '.task_type // "other"' "$state")"
    manager_mode="$(jq -r '.manager_mode // "none"' "$state")"

    case "$task_type" in
        feature|bugfix|refactor|review|docs)
            ;;
        *)
            return 1
            ;;
    esac

    if [ "$manager_mode" != "orchestrate" ]; then
        return 1
    fi

    specialist_count="$(effective_started_roles | grep -Ev '^(|m)$' | wc -l | tr -d ' ')"
    if [ "$specialist_count" = "0" ]; then
        printf "Manager-led orchestration has not handed off to any specialist yet. Start the first required specialist handoff before going idle."
        return 0
    fi

    return 1
}

is_docs_path() {
    local file_path="$1"

    case "$file_path" in
        *.md|*.mdx|*.txt|*.rst|*.adoc|*.markdown|*/docs/*|README*|CHANGELOG*|CLAUDE.md)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

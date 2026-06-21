#!/bin/bash

set -euo pipefail

# Read hook payload from stdin when piped; skip when stdin is a TTY so that
# sourcing lib.sh from an interactive shell or a test that forgot to pipe a
# fixture does not block forever on cat.
if [ -t 0 ]; then
    HOOK_INPUT="${HOOK_INPUT-}"
else
    HOOK_INPUT="$(cat)"
fi
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

tail_jsonl_lines() {
    local transcript_path="$1"
    local lines="${2:-200}"

    if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
        return 0
    fi

    tail -n "$lines" "$transcript_path" 2>/dev/null || cat "$transcript_path"
}

extract_last_assistant_message_from_jsonl_stream() {
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
                (.last_assistant_message?),
                (.assistant_message?),
                (.result?),
                ((.message?.content? // empty) | flattened_text),
                ((.content? // empty) | flattened_text),
                (.message?.text?),
                (.text?)
            ]
            | map(select(type == "string" and (gsub("\\s+"; " ") | length) > 0))
            | .[0] // "";

        [
            reverse[]
            | select(
                (.type? == "assistant")
                or (.type? == "result" and (has("tool_use_id") | not))
                or (.role? == "assistant")
                or (.message?.role? == "assistant")
            )
            | assistant_text
            | select(length > 0)
        ][0] // ""
    ' 2>/dev/null || true
}

extract_last_assistant_message_from_transcript() {
    local transcript_path="$1"
    local message=""

    if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
        return 0
    fi

    # The newest assistant entry is normally near the end of the JSONL transcript.
    # Tail-first avoids slurping the entire file on every subagent/stop guard event.
    message="$(tail_jsonl_lines "$transcript_path" 200 | extract_last_assistant_message_from_jsonl_stream)"
    if [ -n "$message" ]; then
        printf "%s" "$message"
        return 0
    fi

    extract_last_assistant_message_from_jsonl_stream < "$transcript_path"
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

# Durable progress ledger location. The controller appends one line per
# completed task during Subagent-Driven Development so work survives context
# compaction. Override with CLAUDE_CREW_PROGRESS_FILE; otherwise resolve to
# the git toplevel (or cwd when not in a repo) under .claude-crew/progress.md.
# That path is gitignored (see .gitignore) so scratch never gets committed.
progress_ledger_path() {
    if [ -n "${CLAUDE_CREW_PROGRESS_FILE:-}" ]; then
        printf '%s' "$CLAUDE_CREW_PROGRESS_FILE"
        return 0
    fi

    local toplevel
    toplevel="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$toplevel" ]; then
        printf '%s/.claude-crew/progress.md' "$toplevel"
    else
        printf '%s/.claude-crew/progress.md' "${PWD}"
    fi
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
            task_type: "other",
            manager_mode: "none",
            edited: false,
            code_changed: false,
            docs_changed: false,
            docs_required: false,
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
            stalled_by_policy: false,
            policy_stall_reason: "",
            subagent_stop_block_count: 0,
            subagent_stop_block_reason: "",
            subagent_stop_block_message: "",
            files: []
        }' > "$file"
}

_acquire_state_lock() {
    # Portable (POSIX) advisory lock: mkdir is atomic on every Unix
    # since 4.3 BSD. The lockfile sits next to the state file on the
    # same filesystem, so the mktemp+mv atomic-rename inside the
    # critical section remains valid. flock is Linux-only, so on macOS
    # we fall back to this.
    #
    # Stale recovery: if a hook process is killed mid-update (SIGKILL,
    # session abort, hook timeout) the RETURN trap never fires and the
    # lockdir is orphaned. We break stale locks on the FIRST failed
    # mkdir instead of after a long spin, and we break purely on age —
    # a holder older than stale_after is stuck regardless of whether its
    # recorded PID still looks alive (PID reuse would otherwise hang here
    # forever). A failed-recovery backstop guarantees we can never block the
    # agent indefinitely even if breaking the lock itself fails; it counts
    # only consecutive failed breaks, so legitimate contention (holders
    # turning over normally) can never trip it.
    local file="$1"
    local lockdir="${file}.lock"
    local stale_after="${CLAUDE_CREW_LOCK_STALE_SECONDS:-120}"
    local recover_attempts=0 missing_epoch_streak=0 metadata_epoch now age

    while ! mkdir "$lockdir" 2>/dev/null; do
        metadata_epoch=""
        if [ -f "$lockdir/created_epoch" ]; then
            metadata_epoch="$(cat "$lockdir/created_epoch" 2>/dev/null || true)"
        fi
        now="$(date +%s)"
        age=0
        case "$metadata_epoch" in
            ''|*[!0-9]*)
                age=0
                ;;
            *)
                age=$((now - metadata_epoch))
                ;;
        esac

        if [ "$age" -ge "$stale_after" ]; then
            # Stale by age: break it. Age alone decides so a holder whose
            # recorded PID was reused by a live process cannot hang us.
            rm -f "$lockdir/pid" "$lockdir/created_epoch" 2>/dev/null || true
            rmdir "$lockdir" 2>/dev/null || true
            recover_attempts=$((recover_attempts + 1))
            missing_epoch_streak=0
            if [ "$recover_attempts" -ge 50 ]; then
                # Recovery keeps failing (e.g. rmdir denied): give up rather
                # than hang the agent. Legitimate holders reset this counter,
                # so normal contention cannot trip it.
                return 0
            fi
            continue
        fi

        if [ -z "$metadata_epoch" ]; then
            # No recorded age yet. A real holder writes created_epoch
            # microseconds after mkdir, so a persistently missing epoch
            # means an orphaned lockdir whose holder died before recording
            # its age. Wait briefly, then treat a long enough streak as
            # stale and break it — well past the microsecond acquire race,
            # so a live holder will have recorded its epoch first.
            missing_epoch_streak=$((missing_epoch_streak + 1))
            if [ "$missing_epoch_streak" -ge 20 ]; then
                rm -f "$lockdir/pid" "$lockdir/created_epoch" 2>/dev/null || true
                rmdir "$lockdir" 2>/dev/null || true
                recover_attempts=$((recover_attempts + 1))
                missing_epoch_streak=0
                if [ "$recover_attempts" -ge 50 ]; then
                    return 0
                fi
                continue
            fi
            sleep 0.05
            continue
        fi

        # Legitimate holder still working (fresh epoch, age < stale_after):
        # wait and reset the failed-recovery counter, since the lock is
        # turning over normally and contention must not trip the backstop.
        recover_attempts=0
        missing_epoch_streak=0
        sleep 0.05
    done

    printf "%s\n" "$$" > "$lockdir/pid" 2>/dev/null || true
    date +%s > "$lockdir/created_epoch" 2>/dev/null || true
    LOCKDIR_HELD="$lockdir"
}

_release_state_lock() {
    if [ -n "${LOCKDIR_HELD:-}" ]; then
        rm -f "$LOCKDIR_HELD/pid" "$LOCKDIR_HELD/created_epoch" 2>/dev/null || true
        rmdir "$LOCKDIR_HELD" 2>/dev/null || true
        LOCKDIR_HELD=""
    fi
}

_atomic_state_update() {
    local file tmp
    file="$(state_file)"
    ensure_dirs
    _acquire_state_lock "$file"
    tmp="$(mktemp)"
    eval "trap 'rm -f \"$tmp\"; _release_state_lock' RETURN"
    jq "$@" "$file" > "$tmp"
    mv "$tmp" "$file"
}

update_state() {
    _atomic_state_update "$@"
}

record_loop_block() {
    local prefix="$1"
    local reason="$2"
    local message="$3"
    local count_key reason_key message_key file previous_reason previous_message previous_count next_count

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

    _atomic_state_update \
        --arg count_key "$count_key" \
        --arg reason_key "$reason_key" \
        --arg message_key "$message_key" \
        --arg reason "$reason" \
        --arg message "$message" \
        --argjson count "$next_count" \
        '.[$count_key] = $count
        | .[$reason_key] = $reason
        | .[$message_key] = $message'
}

clear_loop_block() {
    local prefix="$1"
    local count_key reason_key message_key

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

    _atomic_state_update \
        --arg count_key "$count_key" \
        --arg reason_key "$reason_key" \
        --arg message_key "$message_key" \
        '.[$count_key] = 0
        | .[$reason_key] = ""
        | .[$message_key] = ""
        | .stalled_by_policy = false
        | .policy_stall_reason = ""'
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
    local count final_reason checklist_output hard_stop file

    record_loop_block "$prefix" "$reason" "$message"
    count="$(loop_block_count "$prefix")"
    final_reason="$reason"
    hard_stop="false"
    if [ "$count" -ge 3 ]; then
        final_reason="Repeated stop-block loop detected (${count}x): ${reason} Do not retry the same final response again; change the summary or perform the required action first."
        hard_stop="true"
    fi

    if [ "$prefix" = "stop" ]; then
        _atomic_state_update \
            --arg reason "$final_reason" \
            --argjson hard_stop "$hard_stop" \
            '.stalled_by_policy = $hard_stop
            | .policy_stall_reason = (if $hard_stop then $reason else "" end)'
    fi

    checklist_output="$(build_block_checklist "$prefix" "$final_reason" "$message")"

    # A terminal stop must not also return decision: "block".  The latter asks
    # Claude Code to continue the conversation, while continue: false ends it.
    # Although current runtimes give continue: false precedence, emitting both
    # fields caused older runtimes to keep entering the Stop hook.
    if [ "$hard_stop" = "true" ]; then
        jq -n --arg checklist "$checklist_output" --arg reason "$final_reason" '{
            continue: false,
            stopReason: $reason,
            errorDetails: $checklist,
            hardStop: true
        }'
    else
        jq -n --arg checklist "$checklist_output" --arg reason "$final_reason" '{
            decision: "block",
            reason: $reason,
            errorDetails: $checklist,
            hardStop: false
        }'
    fi
}

task_type_requires_implementation_summary() {
    local task_type="${1:-}"

    case "$task_type" in
        feature|bugfix|refactor|review|docs)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

task_type_requires_specialist_handoffs() {
    local task_type="${1:-}"

    case "$task_type" in
        feature|bugfix|refactor|review|docs|support)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

append_jsonl() {
    local name="$1"
    local payload="$2"
    ensure_dirs
    rotate_jsonl_if_needed "$name"
    printf "%s\n" "$payload" >> "${LOG_ROOT}/${name}"
}

# Shared rotation threshold for every hook JSONL stream (notifications, session
# index, compact markers, config changes, instructions-loaded audit log). Keeps
# any single log from growing without bound; the .old sidecar is overwritten.
JSONL_MAX_SIZE="${CLAUDE_CREW_LOG_MAX_BYTES:-1048576}"

rotate_jsonl_if_needed() {
    local name="$1"
    local file="${LOG_ROOT}/${name}"
    [ -f "$file" ] || return 0

    # GNU stat uses -c%s; BSD/macOS stat uses -f%z. Probe once and cache the
    # correct flag so the size check works on every Unix.
    local size
    if stat -c%s "$file" >/dev/null 2>&1; then
        size="$(stat -c%s "$file" 2>/dev/null || echo 0)"
    else
        size="$(stat -f%z "$file" 2>/dev/null || echo 0)"
    fi

    if [ "${size:-0}" -ge "$JSONL_MAX_SIZE" ]; then
        rm -f "${file}.old"
        mv "$file" "${file}.old"
        touch "$file"
    fi
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
    local state docs_required
    state="$(state_file)"
    docs_required="$(jq -r '.docs_required // false' "$state")"
    if [ "$docs_required" = "true" ]; then
        printf ' If this reply did not introduce additional changes, still report the actual verification, review, changed files, docs status, and remaining risks instead of using a no-change shortcut after code or config changes.'
    else
        printf ' If this reply did not introduce additional changes, still report the actual verification, review, changed files, and remaining risks instead of using a no-change shortcut after code or config changes.'
    fi
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
    local lower_line=""
    local lower_prefix=""

    # bash 3.2 (macOS /bin/bash) does not support ${var,,}, so use tr for
    # case-folding. tr is POSIX and behaves identically on Linux/macOS.
    lower_prefix="$(printf '%s' "$prefix" | tr '[:upper:]' '[:lower:]')"

    while IFS= read -r line; do
        # Trim leading whitespace so indented footer lines still match.
        line="${line#"${line%%[![:space:]]*}"}"
        lower_line="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"
        if [[ "$lower_line" == "$lower_prefix"* ]]; then
            return 0
        fi
    done <<<"$message"

    return 1
}

# message_has_any_line_prefix MESSAGE PREFIX... — true if any line of MESSAGE
# starts with one of the given PREFIX strings. Same semantics as
# message_has_line_prefix (case-insensitive, leading whitespace trimmed); the
# first matching prefix wins, mirroring the short-circuit `||` chains this
# replaces in the message_mentions_* family.
message_has_any_line_prefix() {
    local message="$1"
    shift
    local prefix=""
    for prefix in "$@"; do
        if message_has_line_prefix "$message" "$prefix"; then
            return 0
        fi
    done
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

ALIASES_JSON="${SCRIPT_DIR}/../agents/aliases.json"

canonicalize_subagent_label() {
    local raw="$1"
    local normalized canonical

    normalized="$(printf "%s" "$raw" \
        | tr '[:upper:]' '[:lower:]' \
        | sed -E 's/^@//; s/[[:space:]_]+/-/g; s/[^a-z0-9.-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"

    [ -z "$normalized" ] && { printf ""; return; }

    if [ -f "$ALIASES_JSON" ]; then
        canonical="$(jq -r --arg n "$normalized" '
            to_entries[]
            | select(any(.value[]; . == $n))
            | .key
        ' "$ALIASES_JSON" | head -n1)"
        if [ -n "$canonical" ]; then
            printf "%s" "$canonical"
            return 0
        fi
    fi

    printf "%s" "$normalized"
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

transcript_indicates_backgrounded_agent() {
    local transcript_path

    transcript_path="$(resolve_transcript_path)"
    if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
        return 1
    fi

    if tail_jsonl_lines "$transcript_path" 400 | grep -Fiq 'backgrounded agent'; then
        return 0
    fi

    grep -Fiq 'backgrounded agent' "$transcript_path"
}

infer_started_roles_from_transcript() {
    local transcript_path matches match roles=""

    transcript_path="$(resolve_transcript_path)"
    if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
        return 0
    fi

    matches="$(
        grep -Eio 'skill\(/manager\)|skill\(/review\)|skill\(/test\)|skill\(/explore\)|skill\(/design\)|skill\(/bug\)|skill\(/debug\)|skill\(/docs\)|skill\(/refactor\)|manager\(|code reviewer\(|tester\(|explorer\(|architect\(|bugbuster\(|debugger\(|docwriter\(' "$transcript_path" \
            || true
    )"

    alias_matches=""
    if [ -n "$ALIASES_JSON" ] && [ -f "$ALIASES_JSON" ]; then
        alias_matches="$(
            grep -Eio '@(m|e|a|t|cr|bug|dbg|doc|manager|explorer|architect|tester|code-reviewer|code-review|reviewer|bugbuster|debugger|docwriter|big-boss|nerd|toxic-senior|paranoid|the-architect|wiki-wiki)($|[^a-z0-9-])' "$transcript_path" \
                | sed 's/^@//' \
                | while IFS= read -r raw; do
                    canonicalize_subagent_label "$raw"
                    printf '\n'
                done \
                || true
        )"
    fi

    [ -z "$matches" ] && [ -z "$alias_matches" ] && return 0

    while IFS= read -r match; do
        case "$(printf "%s" "$match" | tr '[:upper:]' '[:lower:]')" in
            skill\(/manager\)|manager\()
                roles="${roles}"$'\n''m'
                ;;
            skill\(/review\)|code\ reviewer\()
                roles="${roles}"$'\n''cr'
                ;;
            skill\(/test\)|tester\()
                roles="${roles}"$'\n''t'
                ;;
            skill\(/explore\)|explorer\()
                roles="${roles}"$'\n''e'
                ;;
            skill\(/design\)|skill\(/refactor\)|architect\()
                roles="${roles}"$'\n''a'
                ;;
            skill\(/bug\)|bugbuster\()
                roles="${roles}"$'\n''bug'
                ;;
            skill\(/debug\)|debugger\()
                roles="${roles}"$'\n''dbg'
                ;;
            skill\(/docs\)|docwriter\()
                roles="${roles}"$'\n''doc'
                ;;
        esac
    done <<<"$matches"

    while IFS= read -r alias; do
        [ -n "$alias" ] && roles="${roles}"$'\n'"$alias"
    done <<<"$alias_matches"

    printf "%s\n" "$roles" | sorted_unique_lines
}

effective_started_roles() {
    local state explicit_roles inferred_roles

    state="$(state_file)"
    explicit_roles="$(jq -r '.subagents_started[]? // empty' "$state" | grep -Ev '^(general-purpose|workflow-subagent)$' || true)"
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

detect_make_target() {
    local target="$1"
    local makefile=""

    if [ -f Makefile ]; then
        makefile="Makefile"
    elif [ -f makefile ]; then
        makefile="makefile"
    else
        return 1
    fi

    if grep -Eq "^${target}[[:space:]]*:" "$makefile"; then
        printf "make %s" "$target"
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
    if cmd="$(detect_make_target test)"; then
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
    if cmd="$(detect_make_target lint)"; then
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

    # shellcheck disable=SC2221,SC2222
    case "$command" in
        *"pytest"*|*"npm test"*|*"npm run test"*|*"pnpm test"*|*"yarn test"*|*"cargo test"*|*"go test"*|*"ctest"*|*"make test"*)
            printf "test"
            ;;
        *"npm run lint"*|*"pnpm lint"*|*"yarn lint"*|*"ruff"*|*"flake8"*|*"cargo clippy"*|*"golangci-lint"*|*"eslint"*|*"shellcheck"*|*"python -m compileall "*|*"make lint"*)
            printf "lint"
            ;;
        *"cmake --build"*|*"make all"*)
            printf "build"
            ;;
        *"make clean"*)
            printf "other"
            ;;
        "make"|"make "*)
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

normalize_command_for_policy() {
    local command="$1"
    local normalized

    normalized="$(printf "%s" "$command" | tr '[:upper:]' '[:lower:]' | sed -E 's/[[:space:]]+/ /g')"
    normalized="${normalized//\"/}"
    normalized="${normalized//\'/}"
    normalized="${normalized//\\/}"
    printf "%s" "$normalized"
}

is_dangerous_rm_command() {
    local command="$1"
    local normalized

    normalized="$(normalize_command_for_policy "$command")"
    if ! [[ "$normalized" =~ (^|[[:space:];|&])rm[[:space:]]+ ]]; then
        return 1
    fi

    if ! { [[ "$normalized" =~ (^|[[:space:]])-[[:alnum:]-]*r[[:alnum:]-]*f($|[[:space:]]) ]] \
        || [[ "$normalized" =~ (^|[[:space:]])-[[:alnum:]-]*f[[:alnum:]-]*r($|[[:space:]]) ]] \
        || { [[ "$normalized" =~ (^|[[:space:]])-[[:alnum:]-]*r($|[[:space:]]) ]] && [[ "$normalized" =~ (^|[[:space:]])-[[:alnum:]-]*f($|[[:space:]]) ]]; }; }; then
        return 1
    fi

    [[ "$normalized" =~ (^|[[:space:]])(--[[:space:]]+)?(/|~|\$home|\$\{home\}|\.|\.\.)($|[[:space:];|&]) ]]
}

rm_command_targets_home_or_current() {
    local command="$1"
    local normalized

    normalized="$(normalize_command_for_policy "$command")"
    [[ "$normalized" =~ (^|[[:space:]])(--[[:space:]]+)?(~|\$home|\$\{home\}|\.|\.\.)($|[[:space:];|&]) ]]
}


is_force_push_command() {
    local command="$1"

    [[ "$command" =~ git[[:space:]]+push ]] && [[ "$command" =~ (^|[[:space:]])(-f|--force|--force-with-lease)($|[[:space:]]) ]]
}

is_remote_shell_bootstrap_command() {
    local command="$1"
    local normalized

    normalized="$(normalize_command_for_policy "$command")"
    if { [[ "$normalized" =~ (^|[[:space:];|&])curl($|[[:space:]]) ]] || [[ "$normalized" =~ (^|[[:space:];|&])wget($|[[:space:]]) ]]; } \
        && [[ "$normalized" =~ [|][[:space:]]*([[:alnum:]_./-]+[[:space:]]+)*(sh|bash|zsh|dash|ksh)($|[[:space:]]) ]]; then
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

    if is_dangerous_rm_command "$command" || [[ "$command" == *"git reset --hard"* ]] || is_force_push_command "$command"; then
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
    message_has_any_line_prefix "$1" \
        "Verification status:" "Verification:" "Verification result:" "Test status:" "Tests:"
}

message_mentions_review_outcome() {
    message_has_any_line_prefix "$1" "Review outcome:" "Review status:" "Review:"
}

message_mentions_docs_status() {
    message_has_any_line_prefix "$1" "Docs status:" "Documentation:" "Docs:" "Документация:"
}

message_mentions_changed_files() {
    message_has_any_line_prefix "$1" \
        "Changed files:" "Key files changed:" "Files changed:" "Updated files:" "Modified files:" "No files changed:"
}

message_mentions_remaining_risks() {
    message_has_any_line_prefix "$1" "Remaining risks:" "Residual risks:" "Risks:"
}

message_mentions_next_step() {
    message_has_any_line_prefix "$1" \
        "Next step:" "Next steps:" "Follow-up:" "Follow up:" "Pending next:" \
        "Следующий шаг:" "Следующие шаги:" "Дальше:" "Следующее:"
}

message_mentions_concrete_outcome() {
    local message="$1"

    # Prefer exact line prefixes (footer contract)
    if message_has_any_line_prefix "$message" \
        "Outcome:" "Result:" "Fix:" "Implemented:" "Updated:" "Completed:" "Done:" \
        "No files changed:" "No changes:" "Status:"
    then
        return 0
    fi

    # Fallback: accept loose outcome-related keywords to avoid
    # unnecessary blocks when the model describes concrete work
    # in natural language (common with smaller/quantized models).
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
    local state code_changed task_type docs_required
    local verification_ok review_ok files_ok risks_ok next_ok outcome_ok

    state="$(state_file)"
    code_changed="$(jq -r '.code_changed // false' "$state")"
    task_type="$(jq -r '.task_type // "other"' "$state")"
    docs_required="$(jq -r '.docs_required // false' "$state")"

    printf "### Requirement Checklist\n\n"

    if [ "$prefix" = "stop" ]; then
        if [ "$code_changed" != "true" ] || ! task_type_requires_implementation_summary "$task_type"; then
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

        checklist_status_line "$verification_ok" "Verification status line" "Accepted prefixes: \`Verification status:\`, \`Verification:\`, \`Verification result:\`, \`Test status:\`, \`Tests:\`."
        checklist_status_line "$review_ok" "Review outcome line" "Accepted prefixes: \`Review outcome:\`, \`Review status:\`, \`Review:\`."
        checklist_status_line "$files_ok" "Changed files line" "Accepted prefixes: \`Changed files:\`, \`Key files changed:\`, \`Files changed:\`, \`Updated files:\`, \`Modified files:\`, \`No files changed:\`."
        checklist_status_line "$risks_ok" "Remaining risks line" "Accepted prefixes: \`Remaining risks:\`, \`Residual risks:\`, \`Risks:\`."

        if [ "$docs_required" = "true" ]; then
            local docs_ok="FAIL"
            if message_mentions_docs_status "$message"; then
                docs_ok="PASS"
            fi
            checklist_status_line "$docs_ok" "Docs status line" "Accepted prefixes: \`Docs status:\`, \`Documentation:\`, \`Docs:\`, \`Документация:\`."
        fi

        if message_reports_no_changes "$message"; then
            checklist_status_line "FAIL" "No-change shortcut" "Do not use \`No changes were made.\` after code/config changes."
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

    checklist_status_line "$outcome_ok" "Concrete outcome" "Example prefixes/content: \`Outcome:\`, \`Result:\`, or a concrete action like \`fixed\`, \`updated\`, \`implemented\`."
    checklist_status_line "$files_ok" "Changed files line" "Accepted prefixes: \`Changed files:\`, \`Files changed:\`, \`Updated files:\`, \`Modified files:\`, \`No files changed:\`."
    checklist_status_line "$verification_ok" "Verification status line" "Accepted prefixes: \`Verification status:\`, \`Verification:\`, \`Verification result:\`, \`Test status:\`, \`Tests:\`."
    if [ "$risks_ok" = "PASS" ] || [ "$next_ok" = "PASS" ]; then
        checklist_status_line "PASS" "Closure line" "Need either \`Remaining risks:\` or \`Next step:\`."
    else
        checklist_status_line "FAIL" "Closure line" "Add either \`Remaining risks:\` or \`Next step:\`."
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

    if task_type_requires_implementation_summary "$task_type"; then
        handoff_reason="$(session_agent_enforcement_reason || true)"
        if [ -n "$handoff_reason" ]; then
            checklist_status_line "FAIL" "Required specialist handoffs" "$handoff_reason"
        else
            checklist_status_line "PASS" "Required specialist handoffs" "All required roles for this workflow are satisfied."
        fi
    else
        checklist_status_line "SKIP" "Required specialist handoffs" "No workflow-specific handoff requirement for this task type."
    fi
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
Docs status: updated|not needed - <what docs changed or why not>
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
    printf '%s\n%s\n%s\n' '```text' "$message" '```'
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

    started=()
    while IFS= read -r alias; do
        [ -n "$alias" ] && started+=("$alias")
    done < <(effective_started_roles)

    required=()
    while IFS= read -r alias; do
        [ -n "$alias" ] && required+=("$alias")
    done < <(jq -r '.required_subagents[]? // empty' "$state")

    while IFS= read -r group_json; do
        [ -z "$group_json" ] && continue
        group=()
        while IFS= read -r alias; do
            [ -n "$alias" ] && group+=("$alias")
        done < <(jq -r '.[]? // empty' <<<"$group_json")
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

    specialist_count="$(effective_started_roles | grep -Ecv '^(|m)$')"
    if [ "$specialist_count" = "0" ]; then
        printf "Manager-led orchestration has not handed off to any specialist yet. Start the first required specialist handoff before going idle."
        return 0
    fi

    return 1
}

is_docs_path() {
    local file_path="$1"

    # shellcheck disable=SC2221,SC2222
    case "$file_path" in
        *.md|*.mdx|*.txt|*.rst|*.adoc|*.markdown|*/docs/*|README*|CHANGELOG*|CLAUDE.md)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

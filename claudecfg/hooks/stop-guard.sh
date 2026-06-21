#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib.sh"

ensure_state

code_changed="$(jq -r '.code_changed // false' "$(state_file)")"
task_type="$(jq -r '.task_type // "other"' "$(state_file)")"
last_message=""

# A previous stop-hook loop has already been terminated.  Do not re-enter the
# normal blocking path if a runtime invokes Stop once more while processing the
# terminal response; repeat only the unambiguous terminal signal.
if [ "$(jq -r '.stalled_by_policy // false' "$(state_file)")" = "true" ]; then
    policy_stall_reason="$(jq -r '.policy_stall_reason // "Stop hook policy stalled the session."' "$(state_file)")"
    jq -n --arg reason "$policy_stall_reason" '{
        continue: false,
        stopReason: $reason,
        hardStop: true
    }'
    exit 0
fi

load_last_message() {
    if [ -z "$last_message" ]; then
        last_message="$(resolved_last_assistant_message)"
    fi
}

if reason="$(session_block_reason)"; then
    load_last_message
    emit_loop_aware_block "stop" "$reason" "$last_message"
    exit 0
fi

if session_background_manager_pending; then
    clear_loop_block "stop"
    exit 0
fi

if reason="$(session_agent_enforcement_reason)"; then
    load_last_message
    emit_loop_aware_block "stop" "$reason" "$last_message"
    exit 0
fi

if [ "$code_changed" = "true" ]; then
    load_last_message
    if [ -z "$last_message" ]; then
        emit_loop_aware_block "stop" "Code or config changed (${task_type}), but no assistant summary message was found for this stop event." "$last_message"
        exit 0
    fi

    if message_reports_no_changes "$last_message"; then
        emit_loop_aware_block "stop" "Final response after code or config changes must describe the actual changes instead of saying no changes were made.$(stop_safe_no_change_footer_hint)" "$last_message"
        exit 0
    fi
fi

# Only enforce verification status, review outcome, changed files, and remaining
# risks for implementation workflows. Advisory/support tasks do not require the
# implementation footer even when the assistant discussed troubleshooting steps.
if [ "$code_changed" = "true" ] && task_type_requires_implementation_summary "$task_type"; then
    load_last_message
    if ! message_mentions_verification_status "$last_message"; then
        emit_loop_aware_block "stop" "Final response must include a Verification status: line after code or config changes.$(stop_safe_no_change_footer_hint)" "$last_message"
        exit 0
    fi

    if ! message_mentions_review_outcome "$last_message"; then
        emit_loop_aware_block "stop" "Final response must include a Review outcome: line after code or config changes.$(stop_safe_no_change_footer_hint)" "$last_message"
        exit 0
    fi

    if ! message_mentions_changed_files "$last_message"; then
        emit_loop_aware_block "stop" "Final response must include a Changed files: or No files changed: line after code or config changes.$(stop_safe_no_change_footer_hint)" "$last_message"
        exit 0
    fi

    if ! message_mentions_remaining_risks "$last_message"; then
        emit_loop_aware_block "stop" "Final response must include a Remaining risks: line after code or config changes.$(stop_safe_no_change_footer_hint)" "$last_message"
        exit 0
    fi

    docs_required="$(jq -r '.docs_required // false' "$(state_file)")"
    if [ "$docs_required" = "true" ] && ! message_mentions_docs_status "$last_message"; then
        emit_loop_aware_block "stop" "Final response must include a Docs status: line when behavior changes require documentation updates.$(stop_safe_no_change_footer_hint)" "$last_message"
        exit 0
    fi
fi

clear_loop_block "stop"

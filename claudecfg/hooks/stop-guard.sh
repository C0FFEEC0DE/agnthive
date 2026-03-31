#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib.sh"

ensure_state

code_changed="$(jq -r '.code_changed // false' "$(state_file)")"
task_type="$(jq -r '.task_type // "other"' "$(state_file)")"
last_message="$(resolved_last_assistant_message)"

if reason="$(session_block_reason)"; then
    emit_loop_aware_block "stop" "$reason" "$last_message"
    exit 0
fi

if session_background_manager_pending; then
    clear_loop_block "stop"
    exit 0
fi

if reason="$(session_agent_enforcement_reason)"; then
    emit_loop_aware_block "stop" "$reason" "$last_message"
    exit 0
fi

if [ "$code_changed" = "true" ] && [ -z "$last_message" ]; then
    emit_loop_aware_block "stop" "Code or config changed, but no assistant summary message was found for this stop event." "$last_message"
    exit 0
fi

if [ "$code_changed" = "true" ] && message_reports_no_changes "$last_message"; then
    emit_loop_aware_block "stop" "Final response after code or config changes must describe the actual changes instead of saying no changes were made.$(stop_safe_no_change_footer_hint)" "$last_message"
    exit 0
fi

# Only enforce verification status, review outcome, changed files, and remaining risks
# for implementation workflows (feature, bugfix, refactor, review, docs).
# For informational tasks (task_type=other), these are not required.
if [ "$code_changed" = "true" ] && [ "$task_type" != "other" ]; then
    if ! message_mentions_verification_status "$last_message"; then
        emit_loop_aware_block "stop" "Final response must mention verification status after code or config changes.$(stop_safe_no_change_footer_hint)" "$last_message"
        exit 0
    fi

    if ! message_mentions_review_outcome "$last_message"; then
        emit_loop_aware_block "stop" "Final response must mention review outcome or explicitly say review is pending after code or config changes.$(stop_safe_no_change_footer_hint)" "$last_message"
        exit 0
    fi

    if ! message_mentions_changed_files "$last_message"; then
        emit_loop_aware_block "stop" "Final response must name key changed files or explicitly say no files changed.$(stop_safe_no_change_footer_hint)" "$last_message"
        exit 0
    fi

    if ! message_mentions_remaining_risks "$last_message"; then
        emit_loop_aware_block "stop" "Final response must state remaining risks or explicitly mark them as none.$(stop_safe_no_change_footer_hint)" "$last_message"
        exit 0
    fi
fi

clear_loop_block "stop"

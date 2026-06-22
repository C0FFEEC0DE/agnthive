#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib.sh"

# Claude sets this while re-running a Stop hook after it returned a block.
# Do not re-enter the guard or perform any state writes in that recursion.
if [ "$(json_get_bool '.stop_hook_active')" = "true" ]; then
    exit 0
fi

ensure_state

last_message=""
load_last_message() {
    if [ -z "$last_message" ]; then
        last_message="$(resolved_last_assistant_message)"
    fi
}
load_last_message

if [ -z "$last_message" ]; then
    emit_loop_aware_block "subagent_stop" "No assistant summary message was found for this subagent stop event." "$last_message"
    exit 0
fi

if ! message_mentions_concrete_outcome "$last_message"; then
    emit_loop_aware_block "subagent_stop" "Subagent output must include a concrete outcome line (e.g. Outcome: <result>)." "$last_message"
    exit 0
fi

if ! message_mentions_changed_files "$last_message"; then
    emit_loop_aware_block "subagent_stop" "Subagent output must include a Changed files: or No files changed: line." "$last_message"
    exit 0
fi

if ! message_mentions_verification_status "$last_message"; then
    emit_loop_aware_block "subagent_stop" "Subagent output must include a Verification status: line." "$last_message"
    exit 0
fi

if ! message_mentions_remaining_risks "$last_message" && ! message_mentions_next_step "$last_message"; then
    emit_loop_aware_block "subagent_stop" "Subagent output must include a Remaining risks: or Next step: line." "$last_message"
    exit 0
fi

clear_loop_block "subagent_stop"

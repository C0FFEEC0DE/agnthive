#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib.sh"

ensure_state

file_path="$(
    jq -r '
        .tool_input.file_path
        // .tool_input.path
        // .tool_input.notebook_path
        // .file_path
        // .path
        // .notebook_path
        // empty
    ' <<<"$HOOK_INPUT"
)"
docs_changed="false"
code_changed="true"

if is_docs_path "$file_path"; then
    docs_changed="true"
    code_changed="false"
fi

_atomic_state_update \
    --arg file_path "$file_path" \
    --argjson docs_changed "$docs_changed" \
    --argjson code_changed "$code_changed" \
    '
    .edited = true
    | .code_changed = (.code_changed or $code_changed)
    | .docs_changed = (.docs_changed or $docs_changed)
    | .files = ((.files + [$file_path]) | map(select(length > 0)) | unique)
    '

if [ "$code_changed" = "true" ]; then
    emit_context "PostToolUse" "Recorded a code/config change in session state. This session now requires verification before completion."
fi

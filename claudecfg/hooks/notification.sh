#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib.sh"

payload="$(jq -cn \
    --arg ts "$(timestamp_utc)" \
    --arg session_id "$(json_get '.session_id')" \
    --arg title "$(json_get '.title')" \
    --arg message "$(json_get '.message')" \
    --arg subtype "$(json_get '.subtype')" \
    --arg context "$(json_get '.context')" \
    '{
        ts: $ts,
        session_id: $session_id,
        title: $title,
        message: $message,
        subtype: $subtype,
        context: $context
    }')"

# Rotate notification.jsonl if it exceeds 1 MB to prevent unbounded growth.
NOTIFICATION_LOG="${LOG_ROOT}/notification.jsonl"
MAX_SIZE=1048576

if [ -f "$NOTIFICATION_LOG" ]; then
    # GNU stat uses -c%s; BSD/macOS stat uses -f%z. Probe once and cache the
    # correct flag so the rotation check works on every Unix.
    if stat -c%s "$NOTIFICATION_LOG" >/dev/null 2>&1; then
        size="$(stat -c%s "$NOTIFICATION_LOG" 2>/dev/null || echo 0)"
    else
        size="$(stat -f%z "$NOTIFICATION_LOG" 2>/dev/null || echo 0)"
    fi
    if [ "$size" -ge "$MAX_SIZE" ]; then
        rm -f "${NOTIFICATION_LOG}.old"
        mv "$NOTIFICATION_LOG" "${NOTIFICATION_LOG}.old"
        touch "$NOTIFICATION_LOG"
    fi
fi

append_jsonl "notification.jsonl" "$payload"

title="$(json_get '.title')"
message="$(json_get '.message')"

if [ -z "$title" ]; then
    title="Claude Code"
fi

if [ -z "$message" ]; then
    message="Claude Code needs your attention"
fi

if command -v notify-send >/dev/null 2>&1; then
    notify-send -- "$title" "$message" >/dev/null 2>&1 || true
elif command -v osascript >/dev/null 2>&1; then
    safe_title="${title//\"/\\\"}"
    safe_message="${message//\"/\\\"}"
    osascript - "$safe_title" "$safe_message" >/dev/null 2>&1 <<'APPLESCRIPT' || true
on run argv
    display notification (item 2 of argv) with title (item 1 of argv)
end run
APPLESCRIPT
elif command -v powershell.exe >/dev/null 2>&1; then
    # shellcheck disable=SC2154
    TITLE="$title" MESSAGE="$message" powershell.exe -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.MessageBox]::Show($env:MESSAGE, $env:TITLE)" >/dev/null 2>&1 || true
fi

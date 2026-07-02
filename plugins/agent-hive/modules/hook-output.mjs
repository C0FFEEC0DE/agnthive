// hook-output.mjs — fixed output decision constructors for hook stdout.
// Node standard library only.
//
// Invariants (matching the terminal-response contract in commit b97210b and
// docs/specs/claude-code-plugin-node-migration.md):
//   - A normal guard block asks Claude Code to continue with feedback:
//     { decision: "block", reason, ... }. It NEVER carries continue: false.
//   - A terminal cancellation ends the turn: { continue: false, stopReason, ... }.
//     It NEVER carries decision: "block".
//   - PreToolUse permission decisions use hookSpecificOutput.permissionDecision.
//   - Context injection uses hookSpecificOutput.additionalContext.
// All constructors return plain JSON-serializable objects; serialize() emits
// exactly one JSON object with no trailing newline.

/** Normal guard: block with a reason so Claude Code continues with feedback. */
export function blockReason(reason, extra = {}) {
  if (reason == null) reason = 'blocked by hook policy';
  return { decision: 'block', reason, ...extra };
}

/** Terminal cancellation: end the turn. Never includes decision: "block". */
export function terminalCancel(stopReason, extra = {}) {
  if (stopReason == null) stopReason = 'hook policy stalled the session';
  return { continue: false, stopReason, ...extra };
}

/** PreToolUse / PermissionRequest / PermissionDenied permission decision. */
export function permissionDecision(decision, reason, hookEventName = 'PreToolUse') {
  return {
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * PreToolUse permission decision with an errorDetails markdown block. Mirrors
 * the legacy emit_pretool_decision shape: permissionDecision +
 * permissionDecisionReason + errorDetails under hookSpecificOutput.
 */
export function pretoolPermission(decision, reason, errorDetails) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
      errorDetails,
    },
  };
}

/**
 * PermissionRequest deny: decision.behavior "deny" with a message and
 * errorDetails markdown block. Mirrors the legacy emit_permission_request_deny
 * shape. An allow is a passthrough (no decision object) so the normal
 * permission flow proceeds.
 */
export function permissionRequestDeny(message, errorDetails) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message, errorDetails },
    },
  };
}

/** PermissionDenied retry verdict: { retry: true | false }. */
export function permissionDeniedResult(retry) {
  return { retry: Boolean(retry) };
}

/** Inject additional context into Claude's context as a system reminder. */
export function additionalContext(text, hookEventName) {
  const out = { hookSpecificOutput: { additionalContext: String(text ?? '') } };
  if (hookEventName) out.hookSpecificOutput.hookEventName = hookEventName;
  return out;
}

/** Show a warning to the user (not Claude). */
export function systemMessage(text, extra = {}) {
  return { systemMessage: String(text ?? ''), ...extra };
}

/** No decision: let Claude Code proceed unchanged. */
export function passthrough() {
  return {};
}

/** Serialize one output object as JSON (no trailing newline). */
export function serialize(obj) {
  return JSON.stringify(obj ?? {});
}
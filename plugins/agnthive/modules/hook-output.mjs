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

/**
 * PermissionDenied event envelope (F05; ADR 0011; plan task 03.1). The
 * documented contract is the event-specific form
 * `{ hookSpecificOutput: { hookEventName: 'PermissionDenied', retry } }` — the
 * legacy bare `{ retry }` shorthand predates the hooks reference and is not
 * the documented contract on the pinned CLI. `retry` is NOT permission
 * approval: the denial already happened, the flag only invites a different
 * command, and the host ignores `retry` when the denial carried no classifier
 * verdict, so no-verdict denials can never be bypassed from here. Call sites
 * (dispatcher `handlePermissionDenied`) are unchanged — same name, same
 * `(retry)` signature, only the envelope shape moves.
 */
export function permissionDeniedResult(retry) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionDenied',
      retry: Boolean(retry),
    },
  };
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

// --- failure-policy classes (ADR 0011; plan tasks 08.1-08.2) ---------------
//
// Enforcement, workflow guidance, and telemetry fail differently. These are
// pure data: the orchestrator wires a class-aware dispatch() against
// eventClass() + failurePolicy(); this module fixes what each failure mode
// must emit, so a swallowed handler exception can never silently degrade
// enforcement (F09). Host-level failure (cannot launch / timeout) is NOT part
// of this map — it is the hooks.json `timeout` / `onFailure` contract
// (ADR 0011): onFailure:"block" ships only on the shared PreToolUse safety
// registration, where the hooks reference confirms a PreToolUse failure blocks
// the tool call (>= 2.1.295); async telemetry gets no onFailure because the
// docs give background hooks no blocking semantics, and `timeout` on
// `async: true` hooks is declarative only (docs: not enforced for async).
//
// Output vocabulary (exactly what a class-aware dispatch() emits):
//   deny-with-diagnostic    — the event's deny/block constructor (PreToolUse /
//                             PermissionRequest deny decision, PermissionDenied
//                             retry:false, PostToolUseFailure failed) plus a
//                             stderr diagnostic. Never a fabricated allow and
//                             never a silent passthrough.
//   passthrough-degraded    — exit 0 with {} passthrough plus a stderr
//                             degradation note; recorded status stays unknown,
//                             success is never fabricated (ADR 0011 guidance
//                             row).
//   passthrough-diagnostic  — exit 0 with {} passthrough plus a stderr
//                             diagnostic (malformed stdin, telemetry write
//                             failures). Never exit non-zero with a
//                             fabricated allow.
//   emit-decision-diagnostic — the handler computed its decision from stdin
//                             BEFORE the write failed, so emit that decision
//                             plus a stderr diagnostic; only the bookkeeping
//                             is lost (state-write failure in enforce).

/**
 * Hook event -> failure-policy class (normative lists for ADR 0011).
 *   - enforce:  the classifier/permission events; a failed handler must not
 *     degrade to a silent passthrough.
 *   - guidance: workflow gates (stop guard, role gates, ledger); failure must
 *     preserve unknown/incomplete status, never fabricate success.
 *   - telemetry: pure observability writes; failure is nonblocking.
 * ConfigChange rides with telemetry (audit-log write, not a workflow
 * prerequisite) — vetoable: it is not named in the brief's class lists.
 */
export const HOOK_EVENT_CLASSES = Object.freeze({
  enforce: Object.freeze(['PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUseFailure']),
  guidance: Object.freeze(['UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop', 'TaskCompleted', 'TeammateIdle', 'SessionStart']),
  telemetry: Object.freeze(['Notification', 'InstructionsLoaded', 'PreCompact', 'PostCompact', 'StopFailure', 'SessionEnd', 'ConfigChange']),
});

const CLASS_BY_EVENT = Object.freeze(Object.fromEntries(
  Object.entries(HOOK_EVENT_CLASSES).flatMap(([cls, events]) => events.map((e) => [e, cls]))
));

/** The failure-policy class of a hook event, or null for unknown events
 *  (unknown events stay passthrough in dispatch(), unchanged by this map). */
export function eventClass(event) {
  return CLASS_BY_EVENT[event] ?? null;
}

/**
 * Per-class failure spec. `handlerThrow` splits by policy mode for the enforce
 * class only, because ADR 0011 makes the mode the decision boundary: an
 * enforce-mode handler that cannot classify/read required policy state blocks
 * the protected action with a diagnostic (never reports successful
 * enforcement), while an advisory handler that cannot evaluate stays NEUTRAL —
 * passthrough plus a degradation note, no blanket allow either way. Guidance
 * and telemetry never block.
 */
export const FAILURE_POLICY = Object.freeze({
  enforce: Object.freeze({
    handlerThrowEnforceMode: 'deny-with-diagnostic',
    handlerThrowAdvisoryMode: 'passthrough-degraded',
    // A failed state write does not invalidate a verdict computed from stdin:
    // emit it + a stderr diagnostic, never a silent loss.
    stateWriteFailure: 'emit-decision-diagnostic',
    // Malformed stdin is a passthrough (stderr diagnostic), never exit
    // non-zero with a fabricated allow (brief E / ADR 0011).
    malformedStdin: 'passthrough-diagnostic',
  }),
  guidance: Object.freeze({
    handlerThrow: 'passthrough-degraded',
    stateWriteFailure: 'passthrough-degraded',
    malformedStdin: 'passthrough-diagnostic',
  }),
  telemetry: Object.freeze({
    handlerThrow: 'passthrough-diagnostic',
    stateWriteFailure: 'passthrough-diagnostic',
    malformedStdin: 'passthrough-diagnostic',
  }),
});

/** The failure spec for a class, or null for an unknown class. */
export function failurePolicy(cls) {
  return FAILURE_POLICY[cls] ?? null;
}
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockReason,
  terminalCancel,
  permissionDecision,
  permissionDeniedResult,
  additionalContext,
  systemMessage,
  passthrough,
  serialize,
  HOOK_EVENT_CLASSES,
  eventClass,
  FAILURE_POLICY,
  failurePolicy,
} from '../../plugins/agnthive/modules/hook-output.mjs';

test('blockReason: normal guard carries decision:block + reason, never continue', () => {
  const o = blockReason('need verification');
  assert.equal(o.decision, 'block');
  assert.equal(o.reason, 'need verification');
  assert.equal('continue' in o, false, 'normal block must not carry continue');
  assert.equal('stopReason' in o, false);
});

test('blockReason: defaults reason and merges extras', () => {
  const o = blockReason(undefined, { errorDetails: 'checklist' });
  assert.equal(o.decision, 'block');
  assert.equal(o.reason, 'blocked by hook policy');
  assert.equal(o.errorDetails, 'checklist');
});

test('terminalCancel: carries continue:false + stopReason, never decision:block', () => {
  const o = terminalCancel('policy stalled');
  assert.equal(o.continue, false);
  assert.equal(o.stopReason, 'policy stalled');
  assert.equal('decision' in o, false, 'terminal cancel must not carry decision:block');
});

test('terminalCancel: defaults stopReason', () => {
  const o = terminalCancel(undefined);
  assert.equal(o.continue, false);
  assert.match(o.stopReason, /stalled/);
});

test('permissionDecision: allow/deny/ask/defer shape', () => {
  for (const d of ['allow', 'deny', 'ask', 'defer']) {
    const o = permissionDecision(d, 'r');
    assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(o.hookSpecificOutput.permissionDecision, d);
    assert.equal(o.hookSpecificOutput.permissionDecisionReason, 'r');
  }
});

test('additionalContext: injects context text', () => {
  const o = additionalContext('edit src instead', 'PostToolUse');
  assert.equal(o.hookSpecificOutput.additionalContext, 'edit src instead');
  assert.equal(o.hookSpecificOutput.hookEventName, 'PostToolUse');
});

test('systemMessage: surfaces a user-facing warning', () => {
  const o = systemMessage('be careful');
  assert.equal(o.systemMessage, 'be careful');
});

test('passthrough: empty object, no decision keys', () => {
  const o = passthrough();
  assert.deepEqual(o, {});
});

test('serialize: one valid JSON object, no trailing newline', () => {
  const s = serialize({ decision: 'block', reason: 'x' });
  assert.equal(s, '{"decision":"block","reason":"x"}');
  assert.equal(s.endsWith('\n'), false);
  // round-trips
  assert.deepEqual(JSON.parse(s), { decision: 'block', reason: 'x' });
  assert.equal(serialize(undefined), '{}');
});

test('invariant: blockReason and terminalCancel never combine fields', () => {
  const b = blockReason('r');
  const t = terminalCancel('r');
  assert.ok(!('continue' in b) && !('stopReason' in b));
  assert.ok(!('decision' in t));
});

// --- PermissionDenied envelope (F05; ADR 0011; plan task 03.1) -------------

test('permissionDeniedResult: event-specific envelope, not the legacy bare {retry} shorthand', () => {
  // Reproduces F05 on baseline: the old constructor returned { retry: true }.
  assert.deepEqual(permissionDeniedResult(true), {
    hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true },
  });
  assert.deepEqual(permissionDeniedResult(false), {
    hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: false },
  });
});

test('permissionDeniedResult: retry is Boolean-coerced and never a bare top-level key', () => {
  assert.equal(permissionDeniedResult(1).hookSpecificOutput.retry, true);
  assert.equal(permissionDeniedResult(0).hookSpecificOutput.retry, false);
  assert.equal(permissionDeniedResult(undefined).hookSpecificOutput.retry, false);
  const out = permissionDeniedResult(true);
  assert.equal('retry' in out, false, 'bare top-level retry must not reappear');
  // Round-trips through serialize() as exactly one JSON object.
  assert.equal(
    serialize(out),
    '{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}',
  );
  assert.equal(serialize(permissionDeniedResult(false)), '{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":false}}');
});

// --- failure-policy classes (ADR 0011; plan tasks 08.1-08.2) ---------------

test('FAILURE_POLICY/enforce: failed enforce classification never silently passes through', () => {
  const p = failurePolicy('enforce');
  assert.ok(p, 'enforce class must have a failure spec');
  assert.equal(p.handlerThrowEnforceMode, 'deny-with-diagnostic');
  assert.equal(p.handlerThrowAdvisoryMode, 'passthrough-degraded');
  assert.equal(p.stateWriteFailure, 'emit-decision-diagnostic');
  assert.equal(p.malformedStdin, 'passthrough-diagnostic');
});

test('failurePolicy: guidance failures preserve unknown status, telemetry failure is nonblocking', () => {
  assert.deepEqual(failurePolicy('guidance'), {
    handlerThrow: 'passthrough-degraded',
    stateWriteFailure: 'passthrough-degraded',
    malformedStdin: 'passthrough-diagnostic',
  });
  assert.deepEqual(failurePolicy('telemetry'), {
    handlerThrow: 'passthrough-diagnostic',
    stateWriteFailure: 'passthrough-diagnostic',
    malformedStdin: 'passthrough-diagnostic',
  });
  assert.equal(failurePolicy('no-such-class'), null);
});

test('eventClass: normative ADR 0011 class lists; unknown events are null (passthrough)', () => {
  assert.deepEqual([...HOOK_EVENT_CLASSES.enforce], ['PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUseFailure']);
  assert.deepEqual([...HOOK_EVENT_CLASSES.guidance], ['UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop', 'TaskCompleted', 'TeammateIdle', 'SessionStart']);
  assert.deepEqual([...HOOK_EVENT_CLASSES.telemetry], ['Notification', 'InstructionsLoaded', 'PreCompact', 'PostCompact', 'StopFailure', 'SessionEnd', 'ConfigChange']);
  for (const e of HOOK_EVENT_CLASSES.enforce) assert.equal(eventClass(e), 'enforce');
  for (const e of HOOK_EVENT_CLASSES.guidance) assert.equal(eventClass(e), 'guidance');
  for (const e of HOOK_EVENT_CLASSES.telemetry) assert.equal(eventClass(e), 'telemetry');
  assert.equal(eventClass('NotAHookEvent'), null);
  // Every registered event lands in exactly one class (StopFailure is the new
  // telemetry registration in hooks.json; ConfigChange is telemetry, vetoable).
  const seen = new Set();
  for (const events of Object.values(HOOK_EVENT_CLASSES)) {
    for (const e of events) assert.equal(seen.has(e), false, `${e} appears in two classes`);
    for (const e of events) seen.add(e);
  }
});
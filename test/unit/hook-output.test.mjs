import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockReason,
  terminalCancel,
  permissionDecision,
  additionalContext,
  systemMessage,
  passthrough,
  serialize,
} from '../../plugins/agent-hive/modules/hook-output.mjs';

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
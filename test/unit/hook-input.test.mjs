import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHookInput } from '../../plugins/agnthive/modules/hook-input.mjs';

test('valid JSON: extracts common fields', () => {
  const r = parseHookInput(JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    session_id: 's-1',
    cwd: '/proj',
    transcript_path: '/t.jsonl',
  }));
  assert.equal(r.ok, true);
  assert.equal(r.empty, false);
  assert.equal(r.error, null);
  assert.equal(r.event, 'PreToolUse');
  assert.equal(r.toolName, 'Bash');
  assert.deepEqual(r.toolInput, { command: 'npm test' });
  assert.equal(r.sessionId, 's-1');
  assert.equal(r.cwd, '/proj');
  assert.equal(r.transcriptPath, '/t.jsonl');
});

test('empty stdin is a neutral no-op, not an error', () => {
  for (const input of ['', '   ', '\n\t\n', null, Buffer.alloc(0)]) {
    const r = parseHookInput(input);
    assert.equal(r.ok, false);
    assert.equal(r.empty, true);
    assert.deepEqual(r.data, {});
  }
});

test('malformed JSON is reported without throwing', () => {
  const r = parseHookInput('{ not json ');
  assert.equal(r.ok, false);
  assert.equal(r.empty, false);
  assert.match(r.error, /invalid JSON/i);
});

test('non-object JSON payloads are rejected', () => {
  for (const payload of ['[]', '42', '"string"', 'true', 'null']) {
    const r = parseHookInput(payload);
    assert.equal(r.ok, false, `${payload} should not be ok`);
    assert.match(r.error, /not a JSON object/);
  }
});

test('arbitrary UTF-8 / Unicode round-trips through tool_input', () => {
  const unicode = { command: 'echo "naïve façade — ☃ — 日本語 — \\u0001"' };
  const r = parseHookInput(JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: unicode }));
  assert.equal(r.ok, true);
  assert.equal(r.toolInput.command, unicode.command);
});

test('Buffer input is decoded as UTF-8', () => {
  const json = JSON.stringify({ hook_event_name: 'Stop', session_id: 'buf-1' });
  const r = parseHookInput(Buffer.from(json, 'utf8'));
  assert.equal(r.ok, true);
  assert.equal(r.event, 'Stop');
  assert.equal(r.sessionId, 'buf-1');
});

test('missing fields degrade to null / empty defaults', () => {
  const r = parseHookInput(JSON.stringify({ hook_event_name: 'Stop' }));
  assert.equal(r.ok, true);
  assert.equal(r.toolName, null);
  assert.deepEqual(r.toolInput, {});
  assert.equal(r.sessionId, null);
  assert.equal(r.event, 'Stop');
});

test('tool_input that is not an object falls back to empty object', () => {
  const r = parseHookInput(JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: 'not-an-object' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.toolInput, {});
});

// --- stop_hook_active / agent_id / agent_type (ADR 0003) --------------------

test('stop_hook_active: true when present and truthy boolean', () => {
  const r = parseHookInput(JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: true }));
  assert.equal(r.ok, true);
  assert.equal(r.stopHookActive, true);
});

test('stop_hook_active: false when absent', () => {
  const r = parseHookInput(JSON.stringify({ hook_event_name: 'Stop' }));
  assert.equal(r.ok, true);
  assert.equal(r.stopHookActive, false);
});

test('stop_hook_active: false for non-boolean / falsy values', () => {
  for (const v of [false, 1, 'true', null, 0, 'yes']) {
    const r = parseHookInput(JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: v }));
    assert.equal(r.ok, true);
    assert.equal(r.stopHookActive, false, `expected false for stop_hook_active=${JSON.stringify(v)}`);
  }
});

test('agent_id / agent_type: extracted when string, else null', () => {
  const r = parseHookInput(JSON.stringify({
    hook_event_name: 'SubagentStop',
    agent_id: 'agent-7',
    agent_type: 'agnthive:Code Reviewer',
  }));
  assert.equal(r.ok, true);
  assert.equal(r.agentId, 'agent-7');
  assert.equal(r.agentType, 'agnthive:Code Reviewer');
});

test('agent_id / agent_type: null when absent or non-string', () => {
  const r = parseHookInput(JSON.stringify({
    hook_event_name: 'SubagentStop',
    agent_id: 42,
    agent_type: null,
  }));
  assert.equal(r.ok, true);
  assert.equal(r.agentId, null);
  assert.equal(r.agentType, null);
});
// --- ADR 0010 lifecycle identity fields ------------------------------------

test('parseHookInput surfaces prompt_id and agent_transcript_path (ADR 0010)', () => {
  const r = parseHookInput(JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'corr-42',
    agent_transcript_path: '/tmp/agent-transcript.jsonl',
  }));
  assert.equal(r.ok, true);
  assert.equal(r.promptId, 'corr-42');
  assert.equal(r.agentTranscriptPath, '/tmp/agent-transcript.jsonl');
});

test('parseHookInput leaves promptId and agentTranscriptPath null when absent', () => {
  const r = parseHookInput(JSON.stringify({ hook_event_name: 'Stop' }));
  assert.equal(r.promptId, null);
  assert.equal(r.agentTranscriptPath, null);
  const empty = parseHookInput('');
  assert.equal(empty.ok, false);
  assert.equal(empty.promptId, undefined); // early-return path has no identity fields
  assert.equal(empty.agentTranscriptPath, undefined); // early-return path has no identity fields
});

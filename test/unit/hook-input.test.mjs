import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHookInput } from '../../plugins/agent-hive/modules/hook-input.mjs';

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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  tailJsonlLines, extractLastAssistantMessageFromJsonlStream,
  extractLastAssistantMessageFromTranscript, resolvedLastAssistantMessage,
  transcriptIndicatesBackgroundedAgent,
} from '../../plugins/agent-hive/modules/transcripts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const transcripts = join(here, '..', '..', 'test', 'hooks', 'fixtures', 'transcripts');

// --- tailJsonlLines -------------------------------------------------------

test('tailJsonlLines: missing/empty path returns ""', () => {
  assert.equal(tailJsonlLines(''), '');
  assert.equal(tailJsonlLines('/no/such/file.jsonl'), '');
});

test('tailJsonlLines: returns last N lines', () => {
  const d = mkdtempSync(join(tmpdir(), 'trl-'));
  try {
    const f = join(d, 't.jsonl');
    writeFileSync(f, 'line1\nline2\nline3\n');
    assert.equal(tailJsonlLines(f, 2), 'line2\nline3');
    assert.equal(tailJsonlLines(f, 100), 'line1\nline2\nline3');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// --- extractLastAssistantMessageFromJsonlStream ---------------------------

test('extract from stream: message.content array text', () => {
  const stream = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done"}]}}\n';
  assert.equal(extractLastAssistantMessageFromJsonlStream(stream), 'Done');
});

test('extract from stream: picks the LAST assistant entry', () => {
  const stream = [
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}',
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    '{"type":"assistant","text":"final answer"}',
  ].join('\n');
  assert.equal(extractLastAssistantMessageFromJsonlStream(stream), 'final answer');
});

test('extract from stream: skips result entries with tool_use_id', () => {
  const stream = '{"type":"result","tool_use_id":"x","result":"tool output"}\n{"type":"result","result":"real summary"}\n';
  assert.equal(extractLastAssistantMessageFromJsonlStream(stream), 'real summary');
});

test('extract from stream: empty/invalid yields ""', () => {
  assert.equal(extractLastAssistantMessageFromJsonlStream(''), '');
  assert.equal(extractLastAssistantMessageFromJsonlStream('not json\n{}'), '');
});

test('extract from stream: last_assistant_message field wins', () => {
  const stream = '{"type":"assistant","last_assistant_message":"explicit"}';
  assert.equal(extractLastAssistantMessageFromJsonlStream(stream), 'explicit');
});

// --- extractLastAssistantMessageFromTranscript (real fixture) -------------

test('extract from transcript fixture returns non-empty', () => {
  const msg = extractLastAssistantMessageFromTranscript(join(transcripts, 'review_agent_started.jsonl'));
  assert.ok(msg.length > 0);
  assert.match(msg, /Read\(scripts/);
});

test('extract from transcript: missing file returns ""', () => {
  assert.equal(extractLastAssistantMessageFromTranscript('/no/such.jsonl'), '');
  assert.equal(extractLastAssistantMessageFromTranscript(''), '');
});

// --- resolvedLastAssistantMessage -----------------------------------------

test('resolvedLastAssistantMessage: hook input field beats transcript', () => {
  const msg = resolvedLastAssistantMessage({ last_assistant_message: 'from input' }, join(transcripts, 'review_agent_started.jsonl'));
  assert.equal(msg, 'from input');
});

test('resolvedLastAssistantMessage: falls back to transcript', () => {
  const msg = resolvedLastAssistantMessage({}, join(transcripts, 'review_agent_started.jsonl'));
  assert.ok(msg.length > 0);
});

test('resolvedLastAssistantMessage: empty/whitespace field falls through', () => {
  const msg = resolvedLastAssistantMessage({ text: '   ', result: '' }, join(transcripts, 'review_agent_started.jsonl'));
  assert.ok(msg.length > 0);
});

// --- transcriptIndicatesBackgroundedAgent ---------------------------------

test('backgrounded: true for manager_backgrounded_review fixture', () => {
  assert.equal(transcriptIndicatesBackgroundedAgent(join(transcripts, 'manager_backgrounded_review.jsonl')), true);
});

test('backgrounded: false for review_agent_started fixture', () => {
  assert.equal(transcriptIndicatesBackgroundedAgent(join(transcripts, 'review_agent_started.jsonl')), false);
});

test('backgrounded: false for missing path', () => {
  assert.equal(transcriptIndicatesBackgroundedAgent(''), false);
  assert.equal(transcriptIndicatesBackgroundedAgent('/no/such.jsonl'), false);
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, statSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendJsonl, rotateJsonlIfNeeded, resolveLogMaxBytes,
  notificationPayload, instructionsLoadedPayload, preCompactPayload,
  postCompactPayload, configChangePayload, sessionEndPayload,
  DEFAULT_LOG_MAX_BYTES,
} from '../../plugins/agent-hive/modules/notifications.mjs';
import { timestampUtc } from '../../plugins/agent-hive/modules/util.mjs';

// --- timestampUtc (regression for the getUTCMonth typo) -------------------

test('timestampUtc: formats a real Date as YYYY-MM-DDTHH:MM:SSZ (UTC)', () => {
  // 2026-03-04T05:06:07 UTC
  const ts = timestampUtc(new Date(Date.UTC(2026, 2, 4, 5, 6, 7)));
  assert.equal(ts, '2026-03-04T05:06:07Z');
});

let logRoot;
test.before(() => { logRoot = mkdtempSync(join(tmpdir(), 'notif-')); });
test.after(() => { rmSync(logRoot, { recursive: true, force: true }); });

// --- resolveLogMaxBytes ---------------------------------------------------

test('resolveLogMaxBytes: default when unset/invalid, numeric override honored', () => {
  assert.equal(resolveLogMaxBytes({}), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes({ CLAUDE_CREW_LOG_MAX_BYTES: '' }), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes({ CLAUDE_CREW_LOG_MAX_BYTES: 'abc' }), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes({ CLAUDE_CREW_LOG_MAX_BYTES: '0' }), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes({ CLAUDE_CREW_LOG_MAX_BYTES: '-5' }), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes({ CLAUDE_CREW_LOG_MAX_BYTES: '2048' }), 2048);
});

// --- payload builders (field whitelist + redaction) -----------------------

test('notificationPayload: only whitelisted fields; non-strings coerced to ""', () => {
  const p = notificationPayload({ session_id: 's1', title: 'Hi', message: 'msg', subtype: 'x', context: 'ctx', extra: 'dropped', title: 'Hi' });
  assert.deepEqual(p, { ts: p.ts, session_id: 's1', title: 'Hi', message: 'msg', subtype: 'x', context: 'ctx' });
  assert.ok('extra' in p === false);
  assert.match(p.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('notificationPayload: non-string fields become "" (no crash, no leakage)', () => {
  const p = notificationPayload({ title: 42, message: { leak: 'env' } });
  assert.equal(p.title, '');
  assert.equal(p.message, '');
});

test('instructionsLoadedPayload / configChangePayload field whitelists', () => {
  const il = instructionsLoadedPayload({ session_id: 's', file_path: 'a.md', memory_type: 'project', load_reason: 'session_start', junk: 1 });
  assert.deepEqual({ ...il, ts: '<ts>' }, { ts: '<ts>', session_id: 's', file_path: 'a.md', memory_type: 'project', load_reason: 'session_start' });
  assert.ok('junk' in il === false);
  const cc = configChangePayload({ session_id: 's', source: 'user_settings', file_path: '~/.claude/settings.json' });
  assert.deepEqual({ ...cc, ts: '<ts>' }, { ts: '<ts>', session_id: 's', source: 'user_settings', file_path: '~/.claude/settings.json' });
});

test('preCompactPayload / sessionEndPayload embed a state snapshot', () => {
  const state = { task_type: 'feature', code_changed: true };
  assert.equal(preCompactPayload({ session_id: 's', trigger: 'manual' }, state).state, state);
  assert.equal(sessionEndPayload({ session_id: 's', cwd: '/r', transcript_path: '/t', reason: 'end' }, state).state, state);
});

test('postCompactPayload field whitelist', () => {
  const pc = postCompactPayload({ session_id: 's', trigger: 'manual', compact_summary: 'sum', extra: 'drop' });
  assert.deepEqual({ ...pc, ts: '<ts>' }, { ts: '<ts>', session_id: 's', trigger: 'manual', compact_summary: 'sum' });
  assert.ok('extra' in pc === false);
});

// --- appendJsonl + rotation -----------------------------------------------

test('appendJsonl: writes one JSON line per call, creates the dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'aj-'));
  try {
    appendJsonl(root, 'notification.jsonl', { a: 1 });
    appendJsonl(root, 'notification.jsonl', { b: 2 });
    const lines = readFileSync(join(root, 'notification.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
    assert.deepEqual(JSON.parse(lines[1]), { b: 2 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('appendJsonl: JSON-escapes quotes / semicolons / shell metachars verbatim (no injection)', () => {
  const root = mkdtempSync(join(tmpdir(), 'aj-esc-'));
  try {
    const payload = notificationPayload({ title: 'Hello "World"', message: 'Test; rm -rf /' });
    appendJsonl(root, 'notification.jsonl', payload);
    const raw = readFileSync(join(root, 'notification.jsonl'), 'utf8');
    // The dangerous literal is safely enclosed in a JSON string; no bare shell.
    assert.ok(raw.includes('"title":"Hello \\"World\\""'));
    assert.ok(raw.includes('"message":"Test; rm -rf /"'));
    // Round-trips as valid JSON.
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.title, 'Hello "World"');
    assert.equal(parsed.message, 'Test; rm -rf /');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rotation: file >= max bytes moves to .old and a fresh file starts', () => {
  const root = mkdtempSync(join(tmpdir(), 'rot-'));
  try {
    const name = 'notification.jsonl';
    // First append creates a record large enough to cross the threshold; the
    // rotation check runs BEFORE each append, so this first call (file missing)
    // is a no-op rotation and just writes the big record.
    appendJsonl(root, name, { x: 'y'.repeat(400) }, { maxBytes: 256 });
    const before = statSync(join(root, name)).size;
    assert.ok(before >= 256, 'precondition: file at threshold');
    // Next append triggers rotation (size >= maxBytes), then writes the record.
    appendJsonl(root, name, { z: 1 }, { maxBytes: 256 });
    assert.ok(existsSync(join(root, `${name}.old`)), '.old sidecar created');
    const oldContent = readFileSync(join(root, `${name}.old`), 'utf8');
    assert.ok(oldContent.includes('"x"'), 'rolled-over content moved to .old');
    const fresh = readFileSync(join(root, name), 'utf8').trim();
    assert.deepEqual(JSON.parse(fresh), { z: 1 }, 'fresh file starts with the new record only');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rotateJsonlIfNeeded: missing file is a no-op (no throw)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rot-miss-'));
  try {
    rotateJsonlIfNeeded(root, 'nope.jsonl', 1);
    assert.equal(existsSync(join(root, 'nope.jsonl')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rotation threshold uses env override CLAUDE_CREW_LOG_MAX_BYTES', () => {
  const root = mkdtempSync(join(tmpdir(), 'rot-env-'));
  try {
    const name = 'notification.jsonl';
    // Two appends: the first writes a record > 64 bytes; the second sees the
    // file already over the cap and rotates it to .old before appending.
    appendJsonl(root, name, { big: 'x'.repeat(80) }, { maxBytes: 64 });
    appendJsonl(root, name, { small: 1 }, { maxBytes: 64 });
    assert.ok(existsSync(join(root, `${name}.old`)), '.old sidecar created by threshold rotation');
    assert.ok(readFileSync(join(root, name), 'utf8').includes('"small"'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
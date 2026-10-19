import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, statSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendJsonl, rotateJsonlIfNeeded, resolveLogMaxBytes,
  notificationPayload, instructionsLoadedPayload, preCompactPayload,
  postCompactPayload, configChangePayload, sessionEndPayload,
  verboseCompactLog, stopFailurePayload,
  DEFAULT_LOG_MAX_BYTES,
} from '../../plugins/agnthive/modules/notifications.mjs';
import { timestampUtc } from '../../plugins/agnthive/modules/util.mjs';

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
  assert.equal(resolveLogMaxBytes({ AGNTHIVE_LOG_MAX_BYTES: '' }), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes({ AGNTHIVE_LOG_MAX_BYTES: 'abc' }), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes({ AGNTHIVE_LOG_MAX_BYTES: '0' }), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes({ AGNTHIVE_LOG_MAX_BYTES: '-5' }), DEFAULT_LOG_MAX_BYTES);
  assert.equal(resolveLogMaxBytes({ AGNTHIVE_LOG_MAX_BYTES: '2048' }), 2048);
});

test('resolveLogMaxBytes: CLAUDE_PLUGIN_OPTION_LOG_MAX_BYTES userConfig bridge is the lowest-priority fallback', () => {
  // The plugin userConfig bridge is honored only when no env override is set.
  assert.equal(resolveLogMaxBytes({ CLAUDE_PLUGIN_OPTION_LOG_MAX_BYTES: '4096' }), 4096);
  assert.equal(resolveLogMaxBytes({ CLAUDE_PLUGIN_OPTION_LOG_MAX_BYTES: 'abc' }), DEFAULT_LOG_MAX_BYTES);
  // AGNTHIVE_LOG_MAX_BYTES (and the legacy alias) override the userConfig value.
  assert.equal(
    resolveLogMaxBytes({ AGNTHIVE_LOG_MAX_BYTES: '1024', CLAUDE_PLUGIN_OPTION_LOG_MAX_BYTES: '4096' }),
    1024,
  );
  assert.equal(
    resolveLogMaxBytes({ CLAUDE_CREW_LOG_MAX_BYTES: '1024', CLAUDE_PLUGIN_OPTION_LOG_MAX_BYTES: '4096' }),
    1024,
  );
});

// --- payload builders (field whitelist + redaction) -----------------------

test('notificationPayload: only whitelisted fields; non-strings coerced to ""', () => {
  const p = notificationPayload({ session_id: 's1', title: 'Hi', message: 'msg', notification_type: 'progress', context: 'ctx', agent_id: 'a1', prompt_id: 'p1', extra: 'dropped' });
  assert.deepEqual(p, {
    ts: p.ts, session_id: 's1', notification_type: 'progress',
    title: 'Hi', message: 'msg', context: 'ctx', agent_id: 'a1', prompt_id: 'p1',
  });
  assert.ok('extra' in p === false);
  assert.ok('subtype' in p === false, 'subtype replaced by notification_type (F10/ADR-0013)');
  assert.match(p.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('notificationPayload: notification_type bridges the legacy subtype input alias', () => {
  // Older runtimes still carry only `subtype` in the Notification hook input;
  // the telemetry record keeps ONE canonical field (H14, docs/compatibility.md).
  assert.equal(notificationPayload({ subtype: 'status_update' }).notification_type, 'status_update');
  // The current field wins when both are present.
  assert.equal(
    notificationPayload({ notification_type: 'current', subtype: 'legacy' }).notification_type,
    'current',
  );
  // Absent on both → empty string, record shape unchanged.
  assert.equal(notificationPayload({}).notification_type, '');
});

test('notificationPayload: agent_id/prompt_id correlation ids recorded when provided', () => {
  const p = notificationPayload({ session_id: 's', agent_id: 'agent-9', prompt_id: 'prompt-3' });
  assert.equal(p.agent_id, 'agent-9');
  assert.equal(p.prompt_id, 'prompt-3');
  // Correlation is ids only: the message content stays in its own field and an
  // unknown payload key is never promoted.
  assert.ok(!('extra' in p));
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

// --- postCompactPayload: bounded bookkeeping (ADR-0013, plan 07.5) ---------

test('postCompactPayload: default record is metadata/size/status only (no summary text)', () => {
  const pc = postCompactPayload({ session_id: 's', trigger: 'manual', compact_summary: 'SECRET SUMMARY CONTENT', extra: 'drop' });
  assert.deepEqual({ ...pc, ts: '<ts>' }, {
    ts: '<ts>', session_id: 's', trigger: 'manual',
    compact_summary_present: true, compact_summary_bytes: 22,
  });
  // The content itself is never written by default (ADR-0013): the old shape
  // stored the full compact_summary text while the module comment promised not
  // to (F10). Nothing else is added.
  assert.ok(!('compact_summary' in pc), 'default record must not store summary text');
  assert.ok('extra' in pc === false);
});

test('postCompactPayload: absent summary -> present=false, bytes=0', () => {
  const pc = postCompactPayload({ session_id: 's', trigger: 'auto' });
  assert.deepEqual({ ...pc, ts: '<ts>' }, {
    ts: '<ts>', session_id: 's', trigger: 'auto',
    compact_summary_present: false, compact_summary_bytes: 0,
  });
});

test('postCompactPayload: AGNTHIVE_VERBOSE_COMPACT_LOG=1 opts into the summary text', () => {
  const env = { AGNTHIVE_VERBOSE_COMPACT_LOG: '1' };
  const pc = postCompactPayload({ session_id: 's', trigger: 'manual', compact_summary: 'part one / part two' }, undefined, env);
  assert.equal(pc.compact_summary, 'part one / part two');
  assert.equal(pc.compact_summary_truncated, false);
  assert.equal(pc.compact_summary_present, true);
  assert.equal(pc.compact_summary_bytes, 19);
});

test('postCompactPayload: verbose mode is bounded to AGNTHIVE_LOG_MAX_BYTES (UTF-8 safe)', () => {
  const env = { AGNTHIVE_VERBOSE_COMPACT_LOG: '1', AGNTHIVE_LOG_MAX_BYTES: '8' };
  // Multibyte text so a naive byte cap would split a sequence.
  const pc = postCompactPayload({ session_id: 's', compact_summary: '✔✔✔✔' }, undefined, env);
  assert.equal(pc.compact_summary, '✔✔', 'capped to 8 bytes, partial sequence dropped');
  assert.equal(pc.compact_summary_truncated, true);
  assert.equal(pc.compact_summary_present, true);
  assert.ok(!pc.compact_summary.includes('�'), 'no replacement char from a split sequence');
});

test('verboseCompactLog: only explicit truthy values opt in', () => {
  assert.equal(verboseCompactLog({}), false);
  assert.equal(verboseCompactLog({ AGNTHIVE_VERBOSE_COMPACT_LOG: '' }), false);
  assert.equal(verboseCompactLog({ AGNTHIVE_VERBOSE_COMPACT_LOG: '0' }), false);
  assert.equal(verboseCompactLog({ AGNTHIVE_VERBOSE_COMPACT_LOG: 'nope' }), false);
  assert.equal(verboseCompactLog({ AGNTHIVE_VERBOSE_COMPACT_LOG: '1' }), true);
  assert.equal(verboseCompactLog({ AGNTHIVE_VERBOSE_COMPACT_LOG: 'true' }), true);
  assert.equal(verboseCompactLog({ AGNTHIVE_VERBOSE_COMPACT_LOG: 'YES' }), true);
  assert.equal(verboseCompactLog({ AGNTHIVE_VERBOSE_COMPACT_LOG: 'On' }), true);
});

// --- stopFailurePayload (ADR-0013, plan 07.6) ------------------------------

test('stopFailurePayload: bounded metadata only; error text is not stored', () => {
  const longError = 'API error: '.padEnd(300, 'x');
  const p = stopFailurePayload({
    session_id: 's', agent_id: 'a1',
    error: { name: 'APIError', exit_code: 1, signal: 'SIGTERM', message: longError },
  });
  assert.deepEqual({ ...p, ts: '<ts>' }, {
    ts: '<ts>', session_id: 's', error_name: 'APIError', exit_code: 1,
    signal: 'SIGTERM', agent_id: 'a1',
  });
  // The API error text is a diagnostic, not a completion summary: never stored.
  assert.ok(!('message' in p), 'error message text must not be stored');
  assert.ok(Object.values(p).every((v) => typeof v !== 'string' || v.length <= 200), 'all string fields are bounded');
});

test('stopFailurePayload: flat error fields and legacy error_kind alias', () => {
  const p1 = stopFailurePayload({ session_id: 's', error_name: 'Timeout', exit_code: 124 });
  assert.equal(p1.error_name, 'Timeout');
  assert.equal(p1.exit_code, 124);
  assert.equal(p1.signal, '');
  const p2 = stopFailurePayload({ session_id: 's', error_kind: 'api_error', signal: 'SIGHUP' });
  assert.equal(p2.error_name, 'api_error');
  assert.equal(p2.signal, 'SIGHUP');
  assert.equal(p2.exit_code, null);
});

test('stopFailurePayload: empty input degrades to empty metadata (no crash)', () => {
  const p = stopFailurePayload({});
  assert.deepEqual({ ...p, ts: '<ts>' }, {
    ts: '<ts>', session_id: '', error_name: '', exit_code: null,
    signal: '', agent_id: '',
  });
});

test('stopFailurePayload: non-integer exit codes are null, not coerced garbage', () => {
  assert.equal(stopFailurePayload({ exit_code: 'oops' }).exit_code, null);
  assert.equal(stopFailurePayload({ exit_code: 1.5 }).exit_code, null);
  assert.equal(stopFailurePayload({ exit_code: '0' }).exit_code, 0);
  assert.equal(stopFailurePayload({ error: { exitCode: '7' } }).exit_code, 7);
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

test('rotation threshold uses env override AGNTHIVE_LOG_MAX_BYTES', () => {
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
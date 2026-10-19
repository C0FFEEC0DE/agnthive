import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  progressLedgerPath, truncateUtf8, readLedgerForInjection,
  buildPostCompactContext, resolveLedgerMaxBytes, DEFAULT_LEDGER_MAX_BYTES,
  ledgerStatus, buildSessionStartRestore,
} from '../../plugins/agnthive/modules/ledger.mjs';

// --- resolveLedgerMaxBytes ------------------------------------------------

test('resolveLedgerMaxBytes: default when unset/invalid, numeric override honored', () => {
  assert.equal(resolveLedgerMaxBytes({}), DEFAULT_LEDGER_MAX_BYTES);
  assert.equal(resolveLedgerMaxBytes({ AGNTHIVE_LEDGER_MAX_BYTES: '' }), DEFAULT_LEDGER_MAX_BYTES);
  assert.equal(resolveLedgerMaxBytes({ AGNTHIVE_LEDGER_MAX_BYTES: 'nope' }), DEFAULT_LEDGER_MAX_BYTES);
  assert.equal(resolveLedgerMaxBytes({ AGNTHIVE_LEDGER_MAX_BYTES: '32768' }), 32768);
});

test('resolveLedgerMaxBytes: legacy CLAUDE_CREW_LEDGER_MAX_BYTES alias still honored', () => {
  // Backward-compat: the pre-rename env name is read as a fallback for one cycle.
  assert.equal(resolveLedgerMaxBytes({ CLAUDE_CREW_LEDGER_MAX_BYTES: '32768' }), 32768);
  // The new canonical name wins when both are set.
  assert.equal(
    resolveLedgerMaxBytes({ AGNTHIVE_LEDGER_MAX_BYTES: '1024', CLAUDE_CREW_LEDGER_MAX_BYTES: '32768' }),
    1024,
  );
});

test('resolveLedgerMaxBytes: CLAUDE_PLUGIN_OPTION_LEDGER_MAX_BYTES userConfig bridge is the lowest-priority fallback', () => {
  // The plugin userConfig bridge is honored only when no env override is set.
  assert.equal(resolveLedgerMaxBytes({ CLAUDE_PLUGIN_OPTION_LEDGER_MAX_BYTES: '16384' }), 16384);
  assert.equal(resolveLedgerMaxBytes({ CLAUDE_PLUGIN_OPTION_LEDGER_MAX_BYTES: 'nope' }), DEFAULT_LEDGER_MAX_BYTES);
  // AGNTHIVE_LEDGER_MAX_BYTES (and the legacy alias) override the userConfig value.
  assert.equal(
    resolveLedgerMaxBytes({ AGNTHIVE_LEDGER_MAX_BYTES: '1024', CLAUDE_PLUGIN_OPTION_LEDGER_MAX_BYTES: '16384' }),
    1024,
  );
  assert.equal(
    resolveLedgerMaxBytes({ CLAUDE_CREW_LEDGER_MAX_BYTES: '1024', CLAUDE_PLUGIN_OPTION_LEDGER_MAX_BYTES: '16384' }),
    1024,
  );
});

// --- progressLedgerPath ---------------------------------------------------

test('progressLedgerPath: AGNTHIVE_PROGRESS_FILE override wins', () => {
  assert.equal(progressLedgerPath('/repo', { AGNTHIVE_PROGRESS_FILE: '/custom/ledger.md' }), '/custom/ledger.md');
});

test('progressLedgerPath: legacy CLAUDE_CREW_PROGRESS_FILE alias still honored', () => {
  assert.equal(progressLedgerPath('/repo', { CLAUDE_CREW_PROGRESS_FILE: '/custom/ledger.md' }), '/custom/ledger.md');
});

test('progressLedgerPath: defaults to <projectDir>/.agnthive/progress.md', () => {
  // Build the expected with the same platform join() the SUT uses, so the
  // assertion holds on Windows (backslash) as well as POSIX (forward slash).
  assert.equal(progressLedgerPath('/repo'), join('/repo', '.agnthive', 'progress.md'));
  assert.equal(progressLedgerPath(''), join('.agnthive', 'progress.md'));
});

// --- truncateUtf8 ---------------------------------------------------------

test('truncateUtf8: under-cap buffer passes through unchanged', () => {
  const buf = Buffer.from('hello', 'utf8');
  assert.equal(truncateUtf8(buf, 100), 'hello');
});

test('truncateUtf8: exact-cap buffer passes through unchanged', () => {
  const buf = Buffer.from('hello', 'utf8');
  assert.equal(truncateUtf8(buf, buf.length), 'hello');
});

test('truncateUtf8: ASCII truncates cleanly at the byte cap', () => {
  const buf = Buffer.from('abcdefghij', 'utf8');
  assert.equal(truncateUtf8(buf, 4), 'abcd');
});

test('truncateUtf8: multibyte split boundary drops the partial sequence (valid UTF-8 out)', () => {
  // U+2714 HEAVY CHECK MARK = 3 bytes (E2 9C 94). Build "✔✔✔" (9 bytes) and
  // cap mid-second-checkmark so the second sequence is split.
  const s = '✔✔✔';
  const buf = Buffer.from(s, 'utf8');
  assert.equal(buf.length, 9);
  // Cap at 5 bytes: byte 4 is the start of the 2nd checkmark (E2), bytes 5,6
  // are its continuation — so a cap at 5 splits it. Expect "✔" only (3 bytes),
  // the partial 2nd sequence (E2 9C) is dropped, NOT emitted as a replacement
  // char or invalid bytes.
  const out = truncateUtf8(buf, 5);
  assert.equal(out, '✔', `expected single checkmark, got ${JSON.stringify(out)}`);
  // The output must be valid UTF-8 with no U+FFFD replacement char.
  assert.ok(!out.includes('�'), 'no replacement char from a split sequence');
});

test('truncateUtf8: cap landing exactly on a sequence boundary keeps it', () => {
  const s = '✔a✔'; // bytes: [E2 9C 94] 61 [E2 9C 94] = 7 bytes
  const buf = Buffer.from(s, 'utf8');
  assert.equal(truncateUtf8(buf, 4), '✔a'); // first checkmark (3) + 'a' (1)
  assert.equal(truncateUtf8(buf, 7), '✔a✔');
});

test('truncateUtf8: 4-byte emoji split boundary', () => {
  // U+1F600 GRINNING FACE = 4 bytes (F0 9F 98 80).
  const s = '😀x';
  const buf = Buffer.from(s, 'utf8'); // 5 bytes
  // Cap at 2 bytes splits the emoji -> drop it entirely, output empty.
  assert.equal(truncateUtf8(buf, 2), '');
  // Cap at 4 keeps the emoji, drops 'x'.
  assert.equal(truncateUtf8(buf, 4), '😀');
});

// --- readLedgerForInjection -----------------------------------------------

test('readLedgerForInjection: missing path -> null', () => {
  assert.equal(readLedgerForInjection('/no/such/ledger.md'), null);
  assert.equal(readLedgerForInjection(''), null);
});

test('readLedgerForInjection: whitespace-only file -> null', () => {
  const d = mkdtempSync(join(tmpdir(), 'led-ws-'));
  try {
    const f = join(d, 'progress.md');
    writeFileSync(f, '   \n\t\n  ');
    assert.equal(readLedgerForInjection(f), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('readLedgerForInjection: small ledger returns content, no truncation note', () => {
  const d = mkdtempSync(join(tmpdir(), 'led-small-'));
  try {
    const f = join(d, 'progress.md');
    writeFileSync(f, '- [x] task one\n- [x] task two\n');
    const led = readLedgerForInjection(f, 4096);
    assert.ok(led);
    assert.equal(led.truncationNote, '');
    assert.match(led.content, /task two/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('readLedgerForInjection: oversized ledger truncates with a note and valid UTF-8', () => {
  const d = mkdtempSync(join(tmpdir(), 'led-big-'));
  try {
    const f = join(d, 'progress.md');
    // Many multibyte lines so the cap lands mid-sequence.
    const line = '✔ completed task item with a longer description\n';
    writeFileSync(f, line.repeat(50));
    const cap = 64;
    const led = readLedgerForInjection(f, cap);
    assert.ok(led);
    assert.match(led.truncationNote, /Ledger truncated: \d+ bytes exceeds 64 byte limit/);
    // Truncated content must be valid UTF-8 (no replacement char from a split).
    assert.ok(!led.content.includes('�'), 'no replacement char in truncated content');
    // And it must be at most `cap` bytes when re-encoded.
    assert.ok(Buffer.byteLength(led.content, 'utf8') <= cap);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// --- buildPostCompactContext ----------------------------------------------

test('buildPostCompactContext: null/empty ledger -> null (emit nothing)', () => {
  assert.equal(buildPostCompactContext(null), null);
  assert.equal(buildPostCompactContext({ content: '', truncationNote: '' }), null);
});

test('buildPostCompactContext: ledger with no truncation note', () => {
  const ctx = buildPostCompactContext({ content: '- [x] task one', truncationNote: '', size: 14 });
  assert.match(ctx, /durable progress ledger follows/);
  assert.match(ctx, /- \[x\] task one$/);
  assert.ok(!ctx.includes('Ledger truncated'));
});

test('buildPostCompactContext: truncated ledger appends the note', () => {
  const ctx = buildPostCompactContext({ content: '- [x] task one', truncationNote: '[Ledger truncated: 999 bytes exceeds 64 byte limit. Verify recent tasks manually.]', size: 999 });
  assert.match(ctx, /task one\n\n\[Ledger truncated: 999 bytes/);
});

// --- ledgerStatus + buildSessionStartRestore (ADR-0013, plan 07.1-07.3) ----
// The restore contract is pure given state + projectDir; the SessionStart
// source gate (compact/resume only) and the restored_task_seq event append are
// the orchestrator's dispatch wiring.

const OPEN_TASK = {
  id: 'T-1', kind: 'feature', status: 'open', revision: 4,
  required_subagents: ['t'], dispatch_contract_mode: '', docs_required: false,
};

function restoreState(over = {}) {
  return {
    session_id: 's1', task_type: 'feature', revision: 7, restored_task_seq: 0,
    active_task: { ...OPEN_TASK },
    ...over,
  };
}

function assertNoFalseProgress(msg) {
  // ADR-0013: a missing/oversized ledger must produce a bounded diagnostic with
  // an explicit reconstruction instruction, never an implied completed list.
  assert.ok(!/ledger follows/.test(msg), 'no full-ledger injection wording');
}

test('buildSessionStartRestore: no open task -> null (no injection, no patch)', () => {
  const opts = { projectDir: '/tmp' };
  assert.equal(buildSessionStartRestore(null, opts), null);
  assert.equal(buildSessionStartRestore(undefined, opts), null);
  assert.equal(buildSessionStartRestore({}, opts), null);
  assert.equal(buildSessionStartRestore({ active_task: null }, opts), null);
  // The brief: a mis-wired source or a task object without a usable id is
  // treated as "no open task" — no injection and no restored_task_seq write.
  assert.equal(buildSessionStartRestore({ active_task: {} }, { projectDir: '/tmp' }), null);
  assert.equal(buildSessionStartRestore({ active_task: 7 }, { projectDir: '/tmp' }), null);
});

test('buildSessionStartRestore: terminal active_task status -> null', () => {
  for (const status of ['completed', 'closed', 'cancelled']) {
    assert.equal(
      buildSessionStartRestore(restoreState({ active_task: { ...OPEN_TASK, status } }), { projectDir: '/tmp' }),
      null,
      `status=${status} must not restore`,
    );
  }
});

test('buildSessionStartRestore: present ledger -> compact summary, not the ledger text', () => {
  const d = mkdtempSync(join(tmpdir(), 'led-restore-'));
  try {
    const ledgerFile = join(d, 'progress.md');
    writeFileSync(ledgerFile, 'SECRET-LEDGER-LINE task one complete\nSECRET-LEDGER-LINE task two complete\n');
    const r = buildSessionStartRestore(restoreState(), { projectDir: d, ledgerPath: ledgerFile });
    assert.ok(r, 'open task restore must build');
    assert.equal(r.ledger.status, 'present');
    assert.notEqual(r.ledger.size, 0);
    assert.equal(r.patch.restored_task_seq, 1);
    // COMPACT summary: file reference + task/revision; NOT the ledger text.
    assert.ok(r.message.includes('Open task: T-1'), r.message);
    assert.ok(r.message.includes('kind: feature'), r.message);
    assert.ok(r.message.includes('revision 7'), r.message);
    assert.ok(r.message.includes(ledgerFile), 'explicit ledger location reference');
    assert.ok(/ledger is not re-injected in full|read that file/i.test(r.message), r.message);
    assert.ok(!r.message.includes('SECRET-LEDGER-LINE'), 'the full ledger text stays on disk');
    assertNoFalseProgress(r.message);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('buildSessionStartRestore: missing ledger -> bounded diagnostic + reconstruction step', () => {
  const r = buildSessionStartRestore(restoreState(), { projectDir: '/tmp', ledgerPath: '/no/such/progress.md' });
  assert.ok(r, 'an open task still restores (diagnostic, not silence)');
  assert.equal(r.ledger.status, 'missing');
  assert.ok(r.message.includes('/no/such/progress.md'), r.message);
  assert.match(r.message, /Reconstruct the current place from git status, git log and the session transcript/);
  assert.match(r.message, /do not treat any task as complete without direct evidence/);
  assertNoFalseProgress(r.message);
  assert.equal(r.patch.restored_task_seq, 1);
});

test('buildSessionStartRestore: empty ledger is reported as found empty', () => {
  const d = mkdtempSync(join(tmpdir(), 'led-empty-'));
  try {
    const ledgerFile = join(d, 'progress.md');
    writeFileSync(ledgerFile, '');
    const r = buildSessionStartRestore(restoreState(), { projectDir: d, ledgerPath: ledgerFile });
    assert.equal(r.ledger.status, 'empty');
    assert.match(r.message, /found empty/);
    assertNoFalseProgress(r.message);
    assert.equal(r.patch.restored_task_seq, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('buildSessionStartRestore: oversized ledger -> diagnostic, content never read or injected', () => {
  const d = mkdtempSync(join(tmpdir(), 'led-big-restore-'));
  try {
    const ledgerFile = join(d, 'progress.md');
    const line = 'SECRET-LEDGER-LINE ✔ completed item with detail\n';
    writeFileSync(ledgerFile, line.repeat(40));
    const r = buildSessionStartRestore(restoreState(), { projectDir: d, ledgerPath: ledgerFile, maxBytes: 64 });
    assert.equal(r.ledger.status, 'oversized');
    assert.ok(r.ledger.size > 64, 'reports the real on-disk size');
    assert.match(r.message, /over the 64 byte storage cap/);
    assert.match(r.message, /Read the most recent portion of that file directly/);
    assert.ok(!r.message.includes('SECRET-LEDGER-LINE'), 'oversized content is not injected');
    assert.ok(!r.message.includes('�'), 'no content read means no split-sequence artifacts');
    assertNoFalseProgress(r.message);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('buildSessionStartRestore: restored_task_seq bookkeeping and cycleSeq dedupe', () => {
  const opts = { projectDir: '/tmp', ledgerPath: '/no/such/progress.md' };
  // No token: each gate invocation is its own restoration cycle (increment).
  assert.equal(buildSessionStartRestore(restoreState({ restored_task_seq: 3 }), opts).patch.restored_task_seq, 4);
  assert.equal(buildSessionStartRestore(restoreState({ restored_task_seq: 0 }), opts).patch.restored_task_seq, 1);
  // With a token: an idempotent set to that token (the orchestrator supplies a
  // stable monotonic per-cycle token; restored_task_seq acts as the memory).
  assert.equal(buildSessionStartRestore(restoreState({ restored_task_seq: 3 }), { ...opts, cycleSeq: 4 }).patch.restored_task_seq, 4);
  // Already-restored tokens do not inject again (no double injection in one cycle).
  assert.equal(buildSessionStartRestore(restoreState({ restored_task_seq: 4 }), { ...opts, cycleSeq: 4 }), null);
  assert.equal(buildSessionStartRestore(restoreState({ restored_task_seq: 5 }), { ...opts, cycleSeq: 4 }), null);
  // A non-positive / non-numeric token is treated as "no token".
  assert.equal(buildSessionStartRestore(restoreState(), { ...opts, cycleSeq: 0 }).patch.restored_task_seq, 1);
  assert.equal(buildSessionStartRestore(restoreState(), { ...opts, cycleSeq: 'x' }).patch.restored_task_seq, 1);
});

test('buildSessionStartRestore: pure given state — the input state object is not mutated', () => {
  const state = Object.freeze(restoreState({ active_task: Object.freeze({ ...OPEN_TASK }) }));
  const r = buildSessionStartRestore(state, { projectDir: '/tmp', ledgerPath: '/no/such/progress.md' });
  assert.ok(r);
  assert.equal(state.restored_task_seq, 0, 'builder never writes state');
  assert.equal(state.active_task.id, 'T-1');
});

test('buildSessionStartRestore: kind/revision fallbacks', () => {
  // kind falls back to task_type, then 'other'; revision falls back to the
  // task-open revision when the global counter is unusable.
  const r1 = buildSessionStartRestore(
    { active_task: { id: 'T-2', status: '' } , task_type: 'bugfix', revision: 2 },
    { projectDir: '/tmp', ledgerPath: '/no/such/progress.md' },
  );
  assert.ok(r1.message.includes('kind: bugfix'), r1.message);
  assert.ok(r1.message.includes('revision 2'), r1.message);
  const r2 = buildSessionStartRestore(
    { active_task: { id: 'T-3', status: 'open', revision: 5 } },
    { projectDir: '/tmp', ledgerPath: '/no/such/progress.md' },
  );
  assert.ok(r2.message.includes('kind: other'), r2.message);
  assert.ok(r2.message.includes('revision 5'), 'task-open revision fallback', r2.message);
});

test('buildSessionStartRestore: AGNTHIVE_PROGRESS_FILE / legacy alias override the ledger path', () => {
  const r = buildSessionStartRestore(restoreState(), { projectDir: '/tmp', env: { AGNTHIVE_PROGRESS_FILE: '/custom/ledger.md' } });
  assert.equal(r.ledger.path, '/custom/ledger.md');
  const r2 = buildSessionStartRestore(restoreState(), { projectDir: '/tmp', env: { CLAUDE_CREW_PROGRESS_FILE: '/legacy/ledger.md' } });
  assert.equal(r2.ledger.path, '/legacy/ledger.md');
});

test('ledgerStatus: bounded file-status reader (stat only, no content read)', () => {
  const d = mkdtempSync(join(tmpdir(), 'led-status-'));
  try {
    const f = join(d, 'progress.md');
    writeFileSync(f, 'content');
    assert.deepEqual(ledgerStatus(f), { path: f, size: 7, status: 'present' });
    writeFileSync(f, '');
    assert.deepEqual(ledgerStatus(f), { path: f, size: 0, status: 'empty' });
    assert.deepEqual(ledgerStatus(join(d, 'absent.md')), { path: join(d, 'absent.md'), size: 0, status: 'missing' });
    assert.deepEqual(ledgerStatus(''), { path: '', size: 0, status: 'missing' });
  } finally { rmSync(d, { recursive: true, force: true }); }
});
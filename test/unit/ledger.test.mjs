import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  progressLedgerPath, truncateUtf8, readLedgerForInjection,
  buildPostCompactContext, resolveLedgerMaxBytes, DEFAULT_LEDGER_MAX_BYTES,
} from '../../plugins/agent-hive/modules/ledger.mjs';

// --- resolveLedgerMaxBytes ------------------------------------------------

test('resolveLedgerMaxBytes: default when unset/invalid, numeric override honored', () => {
  assert.equal(resolveLedgerMaxBytes({}), DEFAULT_LEDGER_MAX_BYTES);
  assert.equal(resolveLedgerMaxBytes({ CLAUDE_CREW_LEDGER_MAX_BYTES: '' }), DEFAULT_LEDGER_MAX_BYTES);
  assert.equal(resolveLedgerMaxBytes({ CLAUDE_CREW_LEDGER_MAX_BYTES: 'nope' }), DEFAULT_LEDGER_MAX_BYTES);
  assert.equal(resolveLedgerMaxBytes({ CLAUDE_CREW_LEDGER_MAX_BYTES: '32768' }), 32768);
});

// --- progressLedgerPath ---------------------------------------------------

test('progressLedgerPath: CLAUDE_CREW_PROGRESS_FILE override wins', () => {
  assert.equal(progressLedgerPath('/repo', { CLAUDE_CREW_PROGRESS_FILE: '/custom/ledger.md' }), '/custom/ledger.md');
});

test('progressLedgerPath: defaults to <projectDir>/.claude-crew/progress.md', () => {
  // Build the expected with the same platform join() the SUT uses, so the
  // assertion holds on Windows (backslash) as well as POSIX (forward slash).
  assert.equal(progressLedgerPath('/repo'), join('/repo', '.claude-crew', 'progress.md'));
  assert.equal(progressLedgerPath(''), join('.claude-crew', 'progress.md'));
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
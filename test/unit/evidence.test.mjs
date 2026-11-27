import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileFingerprint, snapshotFiles, fingerprintsMatch, fingerprintMismatches } from '../../plugins/agnthive/modules/evidence.mjs';
import { successfulVerification, sessionBlockReason } from '../../plugins/agnthive/modules/summary-contract.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'agnthive-evidence-'));
}

// A record that passes every revision-scoped check; only the fingerprint can
// make it stale.
function currentRecord(files) {
  return { kind: 'test', status: 'passed', startedRevision: 0, completedRevision: 0, cwd: '', files };
}

test('snapshot then unchanged tree matches', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'app.mjs');
    writeFileSync(file, 'export const a = 1;\n');
    const snap = snapshotFiles(['app.mjs'], dir);
    assert.equal(snap.length, 1);
    assert.equal(snap[0].path, file);
    assert.equal(typeof snap[0].size, 'number');
    assert.ok(fingerprintsMatch(snap));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a later write invalidates the snapshot', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'app.mjs');
    writeFileSync(file, 'export const a = 1;\n');
    const snap = snapshotFiles([file]);
    writeFileSync(file, 'export const a = 2;\n');
    utimesSync(file, new Date(1700000000000), new Date(1700000000000));
    assert.equal(fingerprintsMatch(snap), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same-size rewrite is caught by mtime', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'app.mjs');
    writeFileSync(file, 'aaaa');
    const snap = snapshotFiles([file]);
    writeFileSync(file, 'bbbb');
    utimesSync(file, new Date(1700000001000), new Date(1700000001000));
    assert.equal(fingerprintsMatch(snap), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting a tracked file invalidates the snapshot', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'app.mjs');
    writeFileSync(file, 'x');
    const snap = snapshotFiles([file]);
    unlinkSync(file);
    assert.equal(fingerprintsMatch(snap), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that was missing stays fresh until it appears', () => {
  const dir = tempDir();
  try {
    const missing = join(dir, 'later.mjs');
    const snap = snapshotFiles([missing]);
    assert.equal(snap[0].missing, true);
    assert.ok(fingerprintsMatch(snap));
    writeFileSync(missing, 'now here');
    assert.equal(fingerprintsMatch(snap), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('records without a snapshot keep pre-amendment behavior', () => {
  assert.ok(fingerprintsMatch(undefined));
  assert.ok(fingerprintsMatch([]));
});

test('mismatches name the changed path', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'app.mjs');
    writeFileSync(file, 'aaa');
    const snap = snapshotFiles([file]);
    writeFileSync(file, 'bbbb');
    utimesSync(file, new Date(1700000003000), new Date(1700000003000));
    assert.deepEqual(fingerprintMismatches(snap), [file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relative paths resolve against the supplied cwd', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'rel.mjs'), 'x');
    const snap = snapshotFiles(['rel.mjs'], dir);
    assert.equal(snap[0].path, join(dir, 'rel.mjs'));
    assert.ok(fingerprintsMatch(snap));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileFingerprint records missing paths instead of dropping them', () => {
  const dir = tempDir();
  try {
    const entry = fileFingerprint(join(dir, 'nope.mjs'));
    assert.deepEqual(entry, { path: join(dir, 'nope.mjs'), missing: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed record cannot turn the verification block into a crash', () => {
  const state = {
    revision: 0,
    fs_revision_hint: 0,
    code_changed: true,
    detected_test_command: 'node --test',
    verification: [null],
  };
  assert.equal(successfulVerification(state), false);
  const reason = sessionBlockReason(state);
  assert.equal(typeof reason, 'string');
  assert.ok(reason.includes('no successful test command'));
});

test('a stale fingerprint stops a revision-current record from certifying', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'app.mjs');
    writeFileSync(file, 'v1');
    const state = {
      revision: 0,
      fs_revision_hint: 0,
      cwd: '',
      code_changed: true,
      detected_test_command: 'node --test',
      files: [file],
      verification: [currentRecord(snapshotFiles([file]))],
    };
    assert.equal(successfulVerification(state), true);
    writeFileSync(file, 'v2');
    utimesSync(file, new Date(1700000002000), new Date(1700000002000));
    assert.equal(successfulVerification(state), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

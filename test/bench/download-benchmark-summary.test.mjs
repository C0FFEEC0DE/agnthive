// Node tests for scripts/download-benchmark-summary.mjs (port of the Python test).
// Uses the exported `http` injection point and a minimal ZIP builder (store
// method, no compression) to exercise extractSummaryBytes.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  findArtifact, extractSummaryBytes, downloadSummary, HttpError, http, main,
} from '../../scripts/download-benchmark-summary.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'download-benchmark-summary.mjs');

/** Build a minimal ZIP archive (store method, no compression) from entries. */
function buildZip(entries) {
  const fileNames = Object.keys(entries);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const name of fileNames) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const data = Buffer.from(entries[name], 'utf-8');
    // Local file header (30 bytes + name)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(0, 6); // method 0 = store
    lh.writeUInt16LE(0, 8); // crc (not validated by our reader)
    lh.writeUInt32LE(data.length, 18); // compressed size
    lh.writeUInt32LE(data.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    localParts.push(lh, nameBuf, data);
    const localHeaderOffset = offset;
    offset += 30 + nameBuf.length + data.length;
    // Central directory entry (46 bytes + name)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0, 10); // method 0
    cd.writeUInt32LE(data.length, 20); // compressed size
    cd.writeUInt32LE(data.length, 24); // uncompressed size
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(localHeaderOffset, 42);
    centralParts.push(cd, nameBuf);
  }
  const cdOffset = offset;
  const centralBuf = Buffer.concat(centralParts);
  const cdSize = centralBuf.length;
  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(fileNames.length, 8); // total entries on disk
  eocd.writeUInt16LE(fileNames.length, 10); // total entries
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt32LE(cdSize, 12);
  return Buffer.concat([Buffer.concat(localParts), centralBuf, eocd]);
}

test('findArtifact returns named non-expired artifact', () => {
  const a = findArtifact(
    [{ id: 1, name: 'other', expired: false }, { id: 2, name: 'behavior-benchmark-smoke-123', expired: false }],
    'behavior-benchmark-smoke-123',
  );
  assert.equal(a.id, 2);
});

test('findArtifact rejects expired match', () => {
  assert.throws(
    () => findArtifact([{ id: 2, name: 'behavior-benchmark-smoke-123', expired: true }], 'behavior-benchmark-smoke-123'),
    /Artifact not found or expired/,
  );
});

test('extractSummaryBytes reads nested summary json', () => {
  const bytes = extractSummaryBytes(buildZip({
    'bench-output/summary.json': '{"status":"ok"}',
    'bench-output/benchmark-report.md': '# report',
  }));
  assert.deepEqual(JSON.parse(bytes.toString('utf-8')), { status: 'ok' });
});

test('extractSummaryBytes requires summary file', () => {
  assert.throws(
    () => extractSummaryBytes(buildZip({ 'report.md': 'missing summary' })),
    /summary.json/,
  );
});

test('extractSummaryBytes throws on truncated buffer (no EOCD)', () => {
  // A buffer too short to contain a 22-byte EOCD record must fail closed.
  assert.throws(
    () => extractSummaryBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])),
    /summary.json/,
  );
  // Empty buffer likewise.
  assert.throws(() => extractSummaryBytes(Buffer.alloc(0)), /summary.json/);
});

test('extractSummaryBytes matches summary.json by basename, not full path', () => {
  // An entry whose basename is summary.json is returned regardless of its
  // directory path. Extraction only returns bytes; the output path is
  // caller-supplied, so a traversal-style entry name cannot redirect the write.
  const bytes = extractSummaryBytes(buildZip({
    'some/nested/dir/summary.json': '{"status":"nested"}',
    'other.json': 'ignored',
  }));
  assert.deepEqual(JSON.parse(bytes.toString('utf-8')), { status: 'nested' });
});

test('downloadSummary fetches listing then redirected zip', async () => {
  const calls = [];
  const origJson = http.githubGetJson, origRedirect = http.githubGetRedirectUrl, origBytes = http.publicGetBytes;
  http.githubGetJson = async (url, token) => { calls.push(['json', url, token]); return { artifacts: [{ id: 42, name: 'behavior-benchmark-smoke-123', expired: false }] }; };
  http.githubGetRedirectUrl = async (url, token) => { calls.push(['redirect', url, token]); return 'https://example.invalid/artifact.zip'; };
  http.publicGetBytes = async (url) => { calls.push(['public-bytes', url]); return buildZip({ 'summary.json': '{"ok": true}' }); };
  try {
    const summary = await downloadSummary('octo/repo', 123, 'behavior-benchmark-smoke-123', 'token');
    assert.deepEqual(JSON.parse(summary.toString('utf-8')), { ok: true });
    assert.deepEqual(calls, [
      ['json', 'https://api.github.com/repos/octo/repo/actions/runs/123/artifacts', 'token'],
      ['redirect', 'https://api.github.com/repos/octo/repo/actions/artifacts/42/zip', 'token'],
      ['public-bytes', 'https://example.invalid/artifact.zip'],
    ]);
  } finally {
    http.githubGetJson = origJson; http.githubGetRedirectUrl = origRedirect; http.publicGetBytes = origBytes;
  }
});

test('HttpError constructor', () => {
  const e = new HttpError(404, 'not found');
  assert.equal(e.code, 404);
  assert.match(e.message, /HTTP 404/);
});

test('main missing token exits one', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', 'o/r', '--run-id', '1', '--artifact-name', 'a', '--output', '/tmp/x.json'], {
    encoding: 'utf-8', env: { ...process.env, GITHUB_TOKEN: '' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GITHUB_TOKEN is required/);
});

test('main success writes output', async () => {
  const d = mkdtempSync(join(tmpdir(), 'dl-'));
  const out = join(d, 'summary.json');
  const origArgv = process.argv;
  const origToken = process.env.GITHUB_TOKEN;
  process.argv = ['node', SCRIPT, '--repo', 'o/r', '--run-id', '1', '--artifact-name', 'a', '--output', out];
  process.env.GITHUB_TOKEN = 'tok';
  const origJson = http.githubGetJson, origRedirect = http.githubGetRedirectUrl, origBytes = http.publicGetBytes;
  http.githubGetJson = async () => ({ artifacts: [{ id: 1, name: 'a', expired: false }] });
  http.githubGetRedirectUrl = async () => 'https://example.invalid/zip';
  http.publicGetBytes = async () => buildZip({ 'summary.json': '{"status":"ok"}' });
  try {
    await main();
    assert.equal(readFileSync(out, 'utf-8'), '{"status":"ok"}');
  } finally {
    process.argv = origArgv;
    if (origToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = origToken;
    http.githubGetJson = origJson; http.githubGetRedirectUrl = origRedirect; http.publicGetBytes = origBytes;
  }
});
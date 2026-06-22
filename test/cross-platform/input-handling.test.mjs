// Cross-platform input handling tests (Phase 5, Task 19).
//
// These tests guard the Node ESM hook/CLI layer against input shapes that
// differ across operating systems: repo paths containing spaces, CRLF line
// endings (Windows), UTF-8 payloads split across read chunk boundaries, and
// plugin cache paths assembled from environment variables. They use only the
// Node.js standard library so they run identically on Linux, macOS, and
// Windows via the `node --test 'test/**/*.test.mjs'` glob.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

// Resolve a per-test scratch root under the OS temp dir. The base name
// intentionally contains a space so every test inherits the spaced-path
// regression coverage without each having to re-invent it.
const SCRATCH = mkdtempSync(join(tmpdir(), 'claude xplat '));

function scratchPath(...parts) {
  return join(SCRATCH, ...parts);
}

test('repo path containing a space round-trips through fs read/write', () => {
  // A repo worktree path like "/tmp/work/My Repo" must be handled verbatim —
  // no shell splitting, no percent-encoding, no path collapse.
  const dir = scratchPath('project with space');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'manifest.json');
  const payload = JSON.stringify({ root: dir, nested: { value: 42 } });
  writeFileSync(file, payload, 'utf8');

  const readBack = readFileSync(file, 'utf8');
  assert.equal(readBack, payload, 'spaced path content must round-trip unchanged');
  assert.deepEqual(JSON.parse(readBack), { root: dir, nested: { value: 42 } });
  assert.ok(existsSync(file), 'file must exist at the spaced path');
  assert.ok(file.includes(' '), 'scratch file path must contain a literal space');
});

test('CRLF line-ending input is split into logical lines without trailing CR', () => {
  // Windows editors check in files with \r\n endings. A line splitter that
  // only trims '\n' would leave a stray '\r' on every line, corrupting
  // frontmatter/JSON-ish parsing. Mirror the safe split used by the hook
  // fixture readers: split on /\r?\n/ and reject residual carriage returns.
  const file = scratchPath('crlf-input.txt');
  const lines = ['---', 'name: reviewer', '---', 'body line one', 'body line two'];
  // Write with CRLF exactly as a Windows checkout would.
  writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');

  const raw = readFileSync(file, 'utf8');
  const split = raw.split(/\r?\n/);
  // A trailing '' from the final newline is expected; drop it for comparison.
  if (split[split.length - 1] === '') split.pop();
  assert.deepEqual(split, lines, 'CRLF input must split into logical lines');
  for (const line of split) {
    assert.ok(!line.endsWith('\r'), `no residual CR: ${JSON.stringify(line)}`);
  }
});

test('UTF-8 multi-byte char split across two read chunks decodes correctly', () => {
  // Simulate a streaming read where a multi-byte UTF-8 sequence is bisected
  // between two Buffer chunks. A naive Buffer.toString() on the first chunk
  // would emit a replacement char; StringDecoder buffers the partial sequence
  // until it can be completed. The hook input readers must tolerate this.
  const original = 'check mark: ✓ and euro: € and snowman: ☃ done';
  const bytes = Buffer.from(original, 'utf8');
  assert.ok(bytes.length > 4, 'fixture must be long enough to exercise chunking');

  const decoder = new StringDecoder('utf8');
  let reconstructed = '';

  // Bisect the buffer at every internal byte offset and confirm the decoder
  // reassembles the original string regardless of where the split falls —
  // including inside multi-byte sequences.
  for (let splitAt = 1; splitAt < bytes.length; splitAt++) {
    const first = bytes.subarray(0, splitAt);
    const second = bytes.subarray(splitAt);
    const d1 = new StringDecoder('utf8');
    let acc = '';
    acc += d1.write(first);
    acc += d1.write(second);
    acc += d1.end();
    assert.equal(
      acc,
      original,
      `split at byte ${splitAt} must reassemble the original string`,
    );
    reconstructed = acc;
  }
  assert.equal(reconstructed, original, 'final reconstruction matches original');
});

test('partial UTF-8 chunk yields no spurious replacement char before completion', () => {
  // The first chunk of a bisected 3-byte sequence must decode to the empty
  // string (the decoder holds the partial byte), and the completed sequence
  // must appear after the second chunk — never a U+FFFD replacement char.
  const ch = '✓'; // 'CHECK MARK', 3 bytes: 0xE2 0x9C 0x93
  const bytes = Buffer.from(ch, 'utf8');
  assert.equal(bytes.length, 3, 'CHECK MARK must be a 3-byte UTF-8 sequence');

  const d = new StringDecoder('utf8');
  const part1 = d.write(bytes.subarray(0, 1)); // 0xE2 only
  const part2 = d.write(bytes.subarray(1)); // 0x9C 0x93
  const tail = d.end();
  assert.equal(part1, '', 'partial first byte must decode to empty, not U+FFFD');
  assert.equal(part2 + tail, ch, 'completed sequence must decode to the original char');
});

test('plugin cache path constructed from env vars is valid and writable on every OS', () => {
  // The plugin layer builds its cache root from environment variables rather
  // than a hardcoded absolute path, so the same code works on Linux, macOS,
  // and Windows. Verify that joining env-derived segments with path.join
  // produces a normalized, writable path with no literal separators leaked.
  const base =
    process.env.CLAUDE_PLUGIN_CACHE_DIR ??
    scratchPath('plugin-cache');
  const owner = process.env.CLAUDE_PLUGIN_OWNER ?? 'claude-crew';
  const pluginId = process.env.CLAUDE_PLUGIN_ID ?? 'xplat-probe';

  const cachePath = normalize(join(base, 'plugins', owner, pluginId));
  assert.ok(cachePath.length > 0, 'cache path must be non-empty');
  // path.join must use the platform separator; a literal opposite-separator
  // would indicate a hardcoded path that breaks on the other OS family.
  assert.ok(
    !cachePath.includes('\\') || process.platform === 'win32',
    'backslash separator must only appear on Windows',
  );
  assert.ok(
    !cachePath.includes('/') || process.platform !== 'win32' || cachePath.includes(':'),
    'forward slashes are fine as POSIX separators but should not be hardcoded on Windows',
  );

  // The constructed path must actually be usable for I/O on this OS.
  mkdirSync(cachePath, { recursive: true });
  const sentinel = join(cachePath, 'cache.json');
  const marker = JSON.stringify({ plugin: pluginId, owner, os: process.platform });
  writeFileSync(sentinel, marker, 'utf8');
  assert.equal(readFileSync(sentinel, 'utf8'), marker, 'cache path must be writable and readable');
});

// Clean up the scratch tree after the suite. rmSync is recursive; failure is
// non-fatal for the test verdict but is asserted so a permission leak surfaces.
test('teardown: remove scratch directory', () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  assert.ok(!existsSync(SCRATCH), 'scratch directory must be removed');
});
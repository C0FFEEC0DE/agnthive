// Node tests for scripts/find-failed-benchmark-run.mjs (port of the Python test).
// findFailedRun is tested via the deps.runGh injection point; main() is tested
// via subprocess with PATH-stubbed gh/git executables.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, chmodSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findFailedRun, deps } from '../../scripts/find-failed-benchmark-run.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'find-failed-benchmark-run.mjs');

function iso(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function withRunGh(fn) {
  const orig = deps.runGh;
  deps.runGh = fn;
  try { return fn; } finally { deps.runGh = orig; }
}

test('returns recent failed run', () => {
  withRunGh(() => [{ databaseId: 7, status: 'completed', conclusion: 'failure', createdAt: iso(1), headBranch: 'main', displayTitle: 't' }]);
  const orig = deps.runGh;
  deps.runGh = () => [{ databaseId: 7, status: 'completed', conclusion: 'failure', createdAt: iso(1), headBranch: 'main', displayTitle: 't' }];
  const got = findFailedRun('wf', null, 72, 'failed', null);
  deps.runGh = orig;
  assert.ok(got);
  assert.equal(got.databaseId, 7);
});

test('returns none when no runs (null)', () => {
  const orig = deps.runGh; deps.runGh = () => null;
  assert.equal(findFailedRun('wf', null, 72, 'failed', null), null);
  deps.runGh = orig;
});

test('returns none when runs empty', () => {
  const orig = deps.runGh; deps.runGh = () => [];
  assert.equal(findFailedRun('wf', null, 72, 'failed', null), null);
  deps.runGh = orig;
});

test('skips runs older than cutoff', () => {
  const orig = deps.runGh; deps.runGh = () => [{ databaseId: 1, status: 'completed', conclusion: 'failure', createdAt: iso(100), headBranch: 'main', displayTitle: 't' }];
  assert.equal(findFailedRun('wf', null, 72, 'failed', null), null);
  deps.runGh = orig;
});

test('skips non-completed runs', () => {
  const orig = deps.runGh; deps.runGh = () => [{ databaseId: 2, status: 'in_progress', conclusion: null, createdAt: iso(1), headBranch: 'main', displayTitle: 't' }];
  assert.equal(findFailedRun('wf', null, 72, 'failed', null), null);
  deps.runGh = orig;
});

test('skips run with no createdAt', () => {
  const orig = deps.runGh; deps.runGh = () => [{ databaseId: 3, status: 'completed', conclusion: 'failure', createdAt: '', headBranch: 'main', displayTitle: 't' }];
  assert.equal(findFailedRun('wf', null, 72, 'failed', null), null);
  deps.runGh = orig;
});

test('skips run with unparseable createdAt', () => {
  const orig = deps.runGh; deps.runGh = () => [{ databaseId: 4, status: 'completed', conclusion: 'failure', createdAt: 'not-a-date', headBranch: 'main', displayTitle: 't' }];
  assert.equal(findFailedRun('wf', null, 72, 'failed', null), null);
  deps.runGh = orig;
});

test('unresolved status matches failure', () => {
  const orig = deps.runGh; deps.runGh = () => [{ databaseId: 5, status: 'completed', conclusion: 'failure', createdAt: iso(1), headBranch: 'main', displayTitle: 't' }];
  const got = findFailedRun('wf', null, 72, 'unresolved', null);
  deps.runGh = orig;
  assert.ok(got && got.databaseId === 5);
});

test('skips successful run', () => {
  const orig = deps.runGh; deps.runGh = () => [{ databaseId: 6, status: 'completed', conclusion: 'success', createdAt: iso(1), headBranch: 'main', displayTitle: 't' }];
  assert.equal(findFailedRun('wf', null, 72, 'failed', null), null);
  deps.runGh = orig;
});

test('unresolved status skips non-failure conclusion', () => {
  const orig = deps.runGh; deps.runGh = () => [{ databaseId: 7, status: 'completed', conclusion: 'success', createdAt: iso(1), headBranch: 'main', displayTitle: 't' }];
  assert.equal(findFailedRun('wf', null, 72, 'unresolved', null), null);
  deps.runGh = orig;
});

test('unknown status never matches', () => {
  const orig = deps.runGh; deps.runGh = () => [{ databaseId: 8, status: 'completed', conclusion: 'failure', createdAt: iso(1), headBranch: 'main', displayTitle: 't' }];
  assert.equal(findFailedRun('wf', null, 72, 'other', null), null);
  deps.runGh = orig;
});

test('passes branch and repo to gh', () => {
  let captured = null;
  const orig = deps.runGh;
  deps.runGh = (args) => { captured = [...args]; return [{ databaseId: 8, status: 'completed', conclusion: 'failure', createdAt: iso(1), headBranch: 'feat', displayTitle: 't' }]; };
  findFailedRun('wf', 'feat', 72, 'failed', 'owner/repo');
  deps.runGh = orig;
  assert.ok(captured.includes('--branch') && captured.includes('feat'));
  assert.ok(captured.includes('--repo') && captured.includes('owner/repo'));
});

// ---- main() via subprocess with PATH stubs ----

function writeStubs(d) {
  const bin = join(d, 'bin');
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/bash
echo "gh $*" >> "$GH_CALLS_FILE"
case "$1" in
  run)
    printf '[{"databaseId":42,"status":"completed","conclusion":"failure","createdAt":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","headBranch":"trunk","displayTitle":"t"}]\\n'
    exit 0;;
  *) exit 0;;
esac
`);
  chmodSync(gh, 0o755);
  const git = join(bin, 'git');
  writeFileSync(git, `#!/bin/bash
if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then
  printf 'trunk\\n'
  exit 0
fi
exit 0
`);
  chmodSync(git, 0o755);
  return bin;
}

// These subprocess tests drive main() through PATH-stubbed bash gh/git stubs.
// Node's shell-less spawnSync cannot exec a `#!/bin/bash` shebang script on
// Windows: CreateProcess handles only .com/.exe, and .cmd needs a shell (which
// the SUTs deliberately avoid for security — no spawn shell:true/exec). The
// findFailedRun logic itself is covered cross-platform by the in-process
// deps.runGh tests above; in production the SUT invokes real gh.exe/git.exe
// (found via the .exe PATHEXT lookup). So the stub-driven CLI wiring is
// POSIX-only — skip it on Windows rather than rely on stubs that cannot run.
const stubSubprocessOnly = process.platform === 'win32'
  ? { skip: 'POSIX-only: PATH-stubbed bash gh/git cannot exec via shell-less spawn on Windows' }
  : {};

test('main prints found json to stdout', stubSubprocessOnly, () => {
  const d = mkdtempSync(join(tmpdir(), 'ff-'));
  const bin = writeStubs(d);
  const calls = join(d, 'calls.log');
  const r = spawnSync(process.execPath, [SCRIPT, '--workflow', 'wf'], {
    encoding: 'utf-8', cwd: d,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_CALLS_FILE: calls, GITHUB_OUTPUT: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.found, true);
  assert.equal(out.run_id, '42');
});

test('main writes github output file', stubSubprocessOnly, () => {
  const d = mkdtempSync(join(tmpdir(), 'ff-'));
  const bin = writeStubs(d);
  const calls = join(d, 'calls.log');
  const outFile = join(d, 'out.txt');
  const r = spawnSync(process.execPath, [SCRIPT, '--workflow', 'wf', '--branch', 'main', '--output-file', outFile], {
    encoding: 'utf-8', cwd: d,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_CALLS_FILE: calls },
  });
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(outFile, 'utf-8');
  assert.match(text, /found=true/);
  assert.match(text, /run_id=42/);
});

test('main missing workflow exits two', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--workflow is required/);
});
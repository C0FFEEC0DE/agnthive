// Node tests for scripts/rerun-failed-benchmark.mjs (port of the Python test).
// Uses PATH-stubbed gh/git executables; no network, no real gh.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'rerun-failed-benchmark.mjs');

function makeStubs(d) {
  const bin = join(d, 'bin');
  mkdirSync(bin, { recursive: true });
  const calls = join(d, 'calls.log');
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/bash
echo "gh $*" >> "$GH_CALLS_FILE"
case "$1" in
  auth)
    [ "$GH_AUTH_FAIL" != "1" ] && exit 0; exit 1;;
  workflow)
    if [ "$2" = "view" ]; then
      [ "$GH_VIEW_FAIL" != "1" ] && exit 0; exit 1
    fi
    exit 0;;
  run)
    printf '[{"databaseId":123,"url":"http://x/123","status":"in_progress","createdAt":"t"}]\\n'
    exit 0;;
  *) exit 0;;
esac
`);
  chmodSync(gh, 0o755);
  const git = join(bin, 'git');
  writeFileSync(git, `#!/bin/bash
if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then
  if [ -z "$FAKE_GIT_REF" ]; then exit 1; fi
  printf '%s\\n' "$FAKE_GIT_REF"
  exit 0
fi
exit 0
`);
  chmodSync(git, 0o755);
  return { bin, calls };
}

function runCli(d, args, envExtra = {}) {
  const { bin, calls } = makeStubs(d);
  const home = join(d, 'home');
  mkdirSync(home, { recursive: true });
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home,
    GH_CALLS_FILE: calls, ...envExtra,
  };
  return { result: spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8', env }), calls };
}

// The runCli tests below drive the CLI through PATH-stubbed bash gh/git stubs.
// Node's shell-less spawnSync cannot exec a `#!/bin/bash` shebang script on
// Windows (CreateProcess handles only .com/.exe; .cmd needs a shell, which the
// SUT deliberately avoids for security). The SUT hardcodes `gh`/`git` (no
// configurable binary, unlike run-benchmark.mjs's BENCH_RUNNER_CMD), so the stub
// mechanism is fundamentally POSIX-only. In production the SUT invokes real
// gh.exe/git.exe. Skip the stub-driven tests on Windows; the arg-validation
// tests above (help/missing-value) still run cross-platform.
const stubSubprocessOnly = process.platform === 'win32'
  ? { skip: 'POSIX-only: PATH-stubbed bash gh/git cannot exec via shell-less spawn on Windows' }
  : {};

function callsList(d) {
  const calls = join(d, 'calls.log');
  if (!existsSync(calls)) return [];
  return readFileSync(calls, 'utf-8').split('\n').filter(Boolean);
}

test('help exits zero', () => {
  const d = mkdtempSync(join(tmpdir(), 'rr-'));
  const { result } = runCli(d, ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /auto_resume/);
});

test('unknown arg exits two', () => {
  const d = mkdtempSync(join(tmpdir(), 'rr-'));
  const { result } = runCli(d, ['--bogus'], { FAKE_GIT_REF: 'main' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument/);
});

test('run-id without value exits two', () => {
  const d = mkdtempSync(join(tmpdir(), 'rr-'));
  const { result } = runCli(d, ['--run-id']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--run-id needs a value/);
});

test('ref without value exits two', () => {
  const d = mkdtempSync(join(tmpdir(), 'rr-'));
  const { result } = runCli(d, ['--ref']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--ref needs a value/);
});

test('detached head exits two', () => {
  const d = mkdtempSync(join(tmpdir(), 'rr-'));
  const { result } = runCli(d, [], { FAKE_GIT_REF: 'HEAD' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /detached HEAD/);
});

test('no ref no git exits two', () => {
  const d = mkdtempSync(join(tmpdir(), 'rr-'));
  const { result } = runCli(d, []);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not determine current branch/);
});

test('auth failure exits two', () => {
  const d = mkdtempSync(join(tmpdir(), 'rr-'));
  const { result } = runCli(d, ['--ref', 'main'], { GH_AUTH_FAIL: '1' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /gh is not authenticated/);
});

test('workflow missing on ref exits two', stubSubprocessOnly, () => {
  const d = mkdtempSync(join(tmpdir(), 'rr-'));
  const { result } = runCli(d, ['--ref', 'main'], { GH_VIEW_FAIL: '1' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not found on ref/);
});

test('auto_resume dispatch', stubSubprocessOnly, () => {
  const d = mkdtempSync(join(tmpdir(), 'rr-'));
  const { result } = runCli(d, ['--ref', 'main']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /auto_resume mode/);
  const calls = callsList(d);
  assert.ok(calls.some((c) => c.includes('workflow run') && c.includes('selection_mode=auto_resume')));
  assert.ok(calls.some((c) => c.includes('run list') && c.includes('--branch=main')));
});

test('resume dispatch with run id', stubSubprocessOnly, () => {
  const d = mkdtempSync(join(tmpdir(), 'rr-'));
  const { result } = runCli(d, ['--run-id', '27872932481', '--ref', 'main']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /resume mode/);
  assert.match(result.stdout, /run_id=27872932481/);
  const calls = callsList(d);
  assert.ok(calls.some((c) => c.includes('workflow run') && c.includes('selection_mode=resume') && c.includes('resume_run_id=27872932481')));
});

test('ref defaults to current branch', stubSubprocessOnly, () => {
  const d = mkdtempSync(join(tmpdir(), 'rr-'));
  const { result } = runCli(d, [], { FAKE_GIT_REF: 'develop' });
  assert.equal(result.status, 0, result.stderr);
  const calls = callsList(d);
  assert.ok(calls.some((c) => c.includes('--ref develop')));
});
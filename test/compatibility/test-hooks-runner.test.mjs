// Compatibility seam tests for scripts/test-hooks.mjs (plan 02.5).
//
// The fixture runner previously mis-read a spawnSync result that failed before
// the dispatcher ran (res.error such as the sandbox EPERM, or a kill signal):
// the case surfaced as "empty stdout" or as the opaque "expected exit 0, got
// null" — or, worse, silently passed when stdout_jq was skipped by a delta.
// These tests pin the two seams that fix that:
//   1. spawnFailureReason — the classifier for pre-exec failures;
//   2. executeEntry — the per-fixture pipeline, checked with an injected fake
//      spawn plus one real ENOENT, so the diagnostics stay independent of any
//      runtime module (stdlib-only, no dispatcher execution).
//
// Importing the runner module must stay side-effect-free (its isMain guard
// keeps main() from running), so these tests can wire the seams without
// executing the ~160-fixture corpus.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnFailureReason, __runnerInternals } from '../../scripts/test-hooks.mjs';

const { executeEntry, failures } = __runnerInternals;

// Fake raw spawnSync shape for res.error results (status/signal null, the
// message field carrying the errno rendering).
function epermResult() {
  return {
    status: null,
    signal: null,
    error: { code: 'EPERM', message: 'spawnSync /usr/bin/node-22 EPERM' },
    stdout: '',
    stderr: '',
  };
}

test('spawnFailureReason: res.error (EPERM) is an independent failure, never "empty stdout"', () => {
  const reason = spawnFailureReason(epermResult());
  assert.match(reason, /spawn failed \[EPERM\]: spawnSync \/usr\/bin\/node-22 EPERM/);
  assert.ok(!/empty stdout/i.test(reason), `must not read as an output mismatch: ${reason}`);
  assert.ok(!/expected exit/.test(reason), `must not read as an exit mismatch: ${reason}`);
});

test('spawnFailureReason: a kill signal is its own failure kind', () => {
  const reason = spawnFailureReason({ status: null, signal: 'SIGTERM', error: null, stdout: '', stderr: '' });
  assert.match(reason, /terminated by signal SIGTERM/);
  assert.ok(!/empty stdout/i.test(reason));
});

test('spawnFailureReason: missing status without error/signal is reported as such', () => {
  const reason = spawnFailureReason({ status: null, signal: null, error: null, stdout: '', stderr: '' });
  assert.match(reason, /no exit status was reported/);
});

test('spawnFailureReason: a healthy result classifies as null (no spawn failure)', () => {
  assert.equal(spawnFailureReason({ status: 0, signal: null, error: null, stdout: '{}', stderr: '' }), null);
  // Nonzero exit is NOT a spawn failure: the runtime ran, and the exit/output
  // assertions own that verdict.
  assert.equal(spawnFailureReason({ status: 2, signal: null, error: null, stdout: '', stderr: 'block' }), null);
});

test('spawnFailureReason: a non-object result fails with its own diagnostic', () => {
  assert.equal(spawnFailureReason(null), 'spawn returned no result object');
  assert.equal(spawnFailureReason(undefined), 'spawn returned no result object');
  assert.equal(spawnFailureReason('nope'), 'spawn returned no result object');
});

test('spawnFailureReason: a real spawnSync ENOENT reaches the classifier', () => {
  const res = spawnSync('agnthive-compat-no-such-dispatcher-probe', ['--help']);
  assert.ok(res.error, 'the platform must surface a real spawnSync error here');
  const reason = spawnFailureReason(res);
  assert.match(reason, /spawn failed \[ENOENT\]/);
  assert.match(reason, /ENOENT/);
  assert.ok(!/empty stdout/i.test(reason));
});

// --- executeEntry end-to-end with an injected fake spawn --------------------

const tmp = mkdtempSync(join(tmpdir(), 'compat-runner-'));
try {
  const ctx = { caseTmp: tmp, caseHome: tmp, sessionId: null };
  // A real, repo-root-relative fixture plus stdout/state assertions copied
  // from the user-prompt class in cases.json, so the only variable is the
  // spawn result the fake returns.
  const entry = {
    name: 'compat_runner_seam_eperm',
    script: 'user-prompt-submit.sh',
    stdin: 'test/hooks/fixtures/user_prompt_feature.json',
    expect_exit: 0,
    stdout_jq: '.hookSpecificOutput.hookEventName == "UserPromptSubmit"',
    state_jq: '.task_type == "feature"',
  };

  test('executeEntry: a fake-spawn EPERM fails the case with the spawn diagnostic', () => {
    const before = failures.length;
    const ok = executeEntry(entry.name, entry, ctx, null, () => epermResult());
    assert.equal(ok, false, 'a spawn failure must fail the case');
    const last = failures[failures.length - 1];
    assert.equal(last.runName, entry.name);
    assert.match(last.reason, /dispatcher spawn failed, hook never ran/);
    assert.match(last.reason, /spawn failed \[EPERM\]/);
    assert.ok(!/empty stdout/i.test(last.reason), `must not read as "empty stdout": ${last.reason}`);
    assert.ok(!/expected exit/.test(last.reason), `must not read as the opaque exit message: ${last.reason}`);
    assert.equal(failures.length, before + 1, 'exactly one failure is recorded');
  });

  test('executeEntry: nonzero exit with stdout_jq is a distinct, contract-naming diagnostic', () => {
    const before = failures.length;
    const ok = executeEntry(`${entry.name}_exit1`, entry, ctx, null, () => ({
      status: 1,
      signal: null,
      error: null,
      stdout: '',
      stderr: 'hook-dispatcher: boom',
    }));
    assert.equal(ok, false, 'a nonzero exit must fail the case');
    const last = failures[failures.length - 1];
    assert.match(last.reason, /expected exit 0, got 1/);
    assert.match(last.reason, /stderr: hook-dispatcher: boom/);
    assert.match(last.reason, /also asserts stdout output/);
    assert.ok(!/empty stdout/i.test(last.reason), `the status branch must not double-report stdout: ${last.reason}`);
    assert.equal(failures.length, before + 1, 'exactly one failure is recorded');
  });

  test('executeEntry: a real dispatcher run through the same seam still passes', () => {
    // Sanity: with the real spawnSync injected, executeEntry passes this case,
    // proving the seam wiring itself does not change verdicts.
    const ok = executeEntry(`${entry.name}_real`, entry, ctx, null, spawnSync);
    assert.equal(ok, true, 'the same case must pass through the real spawn');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
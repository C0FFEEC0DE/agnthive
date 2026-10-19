import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { statePaths, loadState, appendEvent } from '../../plugins/agnthive/modules/state.mjs';
import {
  resultFromBashPayload, verificationAppendEvent, currentRevision,
  nextRevisionValue, isMutatingShellCommand,
} from '../../plugins/agnthive/modules/verification.mjs';
import { successfulVerification, sessionBlockReason } from '../../plugins/agnthive/modules/summary-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dispatcher = join(root, 'plugins', 'agnthive', 'modules', 'hook-dispatcher.mjs');
const fixtures = join(root, 'test', 'hooks', 'fixtures');

function runDispatcher(event, fixtureName, dataRoot, matcher = 'Bash') {
  const stdin = readFileSync(join(fixtures, `${fixtureName}.json`), 'utf8');
  const args = [dispatcher, '--event', event];
  if (matcher) args.push('--matcher', matcher);
  return spawnSync(process.execPath, args, {
    input: stdin, encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot },
  });
}

let dataRoot;
test.before(() => { dataRoot = mkdtempSync(join(tmpdir(), 'ptu-int-')); });
test.after(() => { rmSync(dataRoot, { recursive: true, force: true }); });

test('PostToolUse Bash test with no tool response: unknown, last command recorded, never a fabricated pass (ADR-0009)', () => {
  const res = runDispatcher('PostToolUse', 'post_bash_test_success', dataRoot);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /Verification outcome could not be determined from the tool response: pytest -q/);
  const state = loadState(statePaths(dataRoot, 'case-post-bash'));
  assert.equal(state.tests_ok, false);
  assert.equal(state.tests_failed, false);
  assert.equal(state.last_test_command, 'pytest -q');
  assert.equal(state.verification.length, 1);
  assert.equal(state.verification[0].status, 'unknown');
});

test('PostToolUse Bash cmake (no tool response): unknown, never a fabricated pass', () => {
  const res = runDispatcher('PostToolUse', 'post_bash_cmake', dataRoot);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Verification outcome could not be determined from the tool response: cmake --build \./);
  const state = loadState(statePaths(dataRoot, 'case-post-bash-cmake'));
  assert.equal(state.build_ok, false);
  assert.equal(state.last_build_command, 'cmake --build .');
});

test('PostToolUse Bash make lint (no tool response): unknown, never a fabricated pass', () => {
  const res = runDispatcher('PostToolUse', 'post_bash_make_lint_success', dataRoot);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Verification outcome could not be determined from the tool response: make lint/);
  const state = loadState(statePaths(dataRoot, 'case-post-bash-make-lint'));
  assert.equal(state.lint_ok, false);
  assert.equal(state.last_lint_command, 'make lint');
});

// Dispatcher-level graduation (plan task 04): the payload fixtures carry real
// tool_response shapes, so a foreground exit 0 records a valid pass, a
// background marker stays pending, and an interrupted run stays unknown with
// the signal preserved.
test('PostToolUse Bash foreground test pass: record + legacy flags through the real payload', () => {
  const cases = [
    { fixtureName: 'verif_post_bash_test_foreground_object', sessionId: 'verif-fg-object' },
    { fixtureName: 'verif_post_bash_test_foreground_string', sessionId: 'verif-fg-string' },
  ];
  for (const { fixtureName, sessionId } of cases) {
    const res = runDispatcher('PostToolUse', fixtureName, dataRoot);
    assert.equal(res.status, 0, fixtureName);
    const out = JSON.parse(res.stdout);
    const expectedStatus = fixtureName === 'verif_post_bash_test_foreground_object' ? 'passed' : 'unknown';
    if (expectedStatus === 'passed') {
      assert.match(out.hookSpecificOutput.additionalContext, /Successful verification command recorded: pytest -q/, fixtureName);
    } else {
      assert.match(out.hookSpecificOutput.additionalContext, /Verification outcome could not be determined from the tool response: pytest -q/, fixtureName);
    }
    const state = loadState(statePaths(dataRoot, sessionId));
    assert.equal(state.tests_ok, expectedStatus === 'passed', fixtureName);
    assert.equal(state.verification.length, 1, fixtureName);
    assert.equal(state.verification[0].status, expectedStatus, fixtureName);
    if (expectedStatus === 'passed') {
      assert.equal(state.verification[0].startedRevision, state.verification[0].completedRevision, fixtureName);
    }
  }
});

test('PostToolUse Bash background marker: pending record, no pass flags (F01)', () => {
  const res = runDispatcher('PostToolUse', 'verif_post_bash_test_background', dataRoot);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /launched but not completed yet: npm test/);
  const state = loadState(statePaths(dataRoot, 'verif-bg'));
  assert.equal(state.tests_ok, false);
  assert.equal(state.verification.length, 1);
  assert.equal(state.verification[0].status, 'pending');
  assert.equal(Object.hasOwn(state.verification[0], 'tests_ok'), false);
});

test('PostToolUseFailure Bash test: records tests_failed', () => {
  const res = runDispatcher('PostToolUseFailure', 'post_tool_failure_test', dataRoot);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(out.hookSpecificOutput.additionalContext, /Verification command failed: pytest -q/);
  const state = loadState(statePaths(dataRoot, 'case-post-failure'));
  assert.equal(state.tests_failed, true);
  assert.equal(state.tests_ok, false);
});

test('PostToolUseFailure make lint: records lint_failed', () => {
  const res = runDispatcher('PostToolUseFailure', 'post_tool_failure_make_lint', dataRoot);
  assert.equal(res.status, 0);
  const state = loadState(statePaths(dataRoot, 'case-post-failure-make-lint'));
  assert.equal(state.lint_failed, true);
  assert.equal(state.lint_ok, false);
});

test('PostToolUse non-Bash/non-Edit tool: neutral passthrough', () => {
  const stdin = JSON.stringify({ session_id: 'case-read', tool_name: 'Read', tool_input: { file_path: '/x' } });
  const res = spawnSync(process.execPath, [dispatcher, '--event', 'PostToolUse'], {
    input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot },
  });
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), {});
});

test('PostToolUse Edit (no matcher) falls back to EditWrite via tool_name and records code change', () => {
  const stdin = JSON.stringify({ session_id: 'case-edit', tool_name: 'Edit', tool_input: { file_path: '/repo/src/app.js' } });
  const res = spawnSync(process.execPath, [dispatcher, '--event', 'PostToolUse'], {
    input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot },
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Recorded a code\/config change/);
  const state = loadState(statePaths(dataRoot, 'case-edit'));
  assert.equal(state.edited, true);
  assert.equal(state.code_changed, true);
  assert.equal(state.docs_changed, false);
  assert.deepEqual(state.files, ['/repo/src/app.js']);
});

test('PostToolUse EditWrite docs path sets docs_changed (not code_changed)', () => {
  const stdin = JSON.stringify({ session_id: 'case-docs', tool_input: { file_path: '/repo/docs/guide.md' } });
  const res = spawnSync(process.execPath, [dispatcher, '--event', 'PostToolUse', '--matcher', 'EditWrite'], {
    input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot },
  });
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), {});
  const state = loadState(statePaths(dataRoot, 'case-docs'));
  assert.equal(state.edited, true);
  assert.equal(state.code_changed, false);
  assert.equal(state.docs_changed, true);
  assert.deepEqual(state.files, ['/repo/docs/guide.md']);
});

// --- ADR-0009 revision-aware gate: seam composition (plan task 04) ----------
//
// The dispatcher still records the legacy flags directly; the payload adapter
// and the revision bumps are wired by the orchestrator (its file). These cases
// therefore compose the exported seam functions — resultFromBashPayload →
// verificationAppendEvent → currentRevision/nextRevisionValue bumps →
// sessionBlockReason — over real append-only event logs, which is exactly what
// the orchestrator's wiring will drive.
//
// TODO(orchestrator): when handlePostToolUseBash, handlePostToolUseFailure and
// handlePostToolUseEditWrite are rewired (resultFromBashPayload +
// verificationAppendEvent + 'append' events + revision bumps), these seam
// cases can graduate to dispatcher-level spawns; and the legacy fixture cases
// above must be revisited, because a record-less Bash post (the fixtures above
// carry no tool_response) then derives status 'unknown' instead of a flag pass
// — extend them with the verif_* tool_response fixtures at that point.

function loadFixture(name) {
  return JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8'));
}

// Build a session state through the real append-only event log so the gate
// reads a state the runtime would actually load.
function buildState(sessionId, events) {
  const paths = statePaths(dataRoot, sessionId);
  for (const [type, payload] of events) appendEvent(paths, type, payload);
  return loadState(paths);
}

const CWD = '/repo';

// Record a foreground pass through the seam exactly as the orchestrator's
// wiring will: read state, pass its currentRevision as ctx.revision, append the
// record event, and persist the legacy fields patch alongside the record.
function recordForegroundPass(state, opts = {}) {
  const command = opts.command ?? 'pytest -q';
  return resultFromBashPayload('test', command, { exitCode: 0, stdout: 'ok', stderr: '' }, opts.toolUseId ?? 't1', {
    revision: currentRevision(state),
    cwd: opts.cwd ?? CWD,
    now: opts.now ?? 1,
    seq: opts.seq ?? 1,
    ...(opts.startedRevision === undefined ? {} : { startedRevision: opts.startedRevision }),
  });
}

// [wiring] test → edit → stop
test('test then edit then stop: the record is invalidated by the later tracked edit', () => {
  const sid = 'verif-test-edit-stop';
  let state = buildState(sid, [['set_many', { fields: { code_changed: true, revision: 1, cwd: CWD, detected_test_command: 'pytest -q' } }]]);
  state = buildState(sid, [['append', verificationAppendEvent(recordForegroundPass(state, { toolUseId: 't1', seq: 1 }))]]);
  assert.equal(successfulVerification(state), true);
  assert.equal(sessionBlockReason(state), null);
  // EditWrite bump — the orchestrator's wiring point for task 04.4.
  state = buildState(sid, [['set_many', { fields: { revision: nextRevisionValue(state) } }]]);
  assert.equal(state.revision, 2);
  assert.equal(successfulVerification(state), false);
  assert.match(sessionBlockReason(state), /no successful test command was recorded/);
});

// [wiring] edit → test → stop
test('edit then test then stop: verification recorded after the edit closes the gate', () => {
  const sid = 'verif-edit-test-stop';
  let state = buildState(sid, [['set_many', { fields: { code_changed: true, revision: 1, cwd: CWD, detected_test_command: 'pytest -q' } }]]);
  // No record yet: the detected-but-no-success branch blocks even though the
  // edit predates any verification attempt.
  assert.notEqual(sessionBlockReason(state), null);
  state = buildState(sid, [['append', verificationAppendEvent(recordForegroundPass(state, { toolUseId: 't1', seq: 1 }))]]);
  assert.equal(successfulVerification(state), true);
  assert.equal(sessionBlockReason(state), null);
});

// [wiring] edit during test — the orchestrator stamps the pending record at
// PreToolUse (Bash) and passes ctx.startedRevision when the completion lands.
test('edit during test: a completion observed from an earlier revision never closes the gate', () => {
  const sid = 'verif-edit-during-test';
  let state = buildState(sid, [['set_many', { fields: { code_changed: true, revision: 1, cwd: CWD, detected_test_command: 'npm test' } }]]);
  // Launch stamp at revision 1 (PreToolUse-time pending record).
  const launch = resultFromBashPayload('test', 'npm test', { stdout: 'running in background' }, 't_launch', {
    revision: currentRevision(state), cwd: CWD, now: 1, seq: 1,
  });
  state = buildState(sid, [['append', verificationAppendEvent(launch)]]);
  assert.equal(launch.record.startedRevision, 1);
  // The edit lands while the check is running (bump → 2), then the completion
  // arrives with the launch revision in ctx.
  state = buildState(sid, [['set_many', { fields: { revision: nextRevisionValue(state) } }]]);
  const completion = resultFromBashPayload('test', 'npm test', { exitCode: 0, stdout: 'ok', stderr: '' }, 't_done', {
    revision: currentRevision(state), cwd: CWD, now: 2, seq: 2, startedRevision: 1,
  });
  assert.equal(completion.record.startedRevision, 1);
  assert.equal(completion.record.completedRevision, 2);
  state = buildState(sid, [['append', verificationAppendEvent(completion)]]);
  assert.equal(successfulVerification(state), false);
  assert.notEqual(sessionBlockReason(state), null);
  // A fresh foreground rerun at the new revision is what closes the gate.
  state = buildState(sid, [['append', verificationAppendEvent(
    resultFromBashPayload('test', 'npm test', { exitCode: 0, stdout: 'ok', stderr: '' }, 't_done2', {
      revision: currentRevision(state), cwd: CWD, now: 3, seq: 3, startedRevision: 2,
    }),
  )]]);
  assert.equal(successfulVerification(state), true);
  assert.equal(sessionBlockReason(state), null);
});

// Plan 04.5: documents are checked separately when they do not change the
// required build/test inputs — a docs-path edit does not bump the revision, so
// it does not invalidate the record.
test('docs edit does not invalidate a current record', () => {
  const sid = 'verif-docs-edit';
  let state = buildState(sid, [['set_many', { fields: { code_changed: true, revision: 1, cwd: CWD, detected_test_command: 'pytest -q' } }]]);
  state = buildState(sid, [['append', verificationAppendEvent(recordForegroundPass(state, { toolUseId: 't1', seq: 1 }))]]);
  assert.equal(sessionBlockReason(state), null);
  // Docs-path EditWrite: docs_changed/edited flags only — no revision bump.
  state = buildState(sid, [['set_many', { fields: { edited: true, docs_changed: true, code_changed: false } }]]);
  assert.equal(state.revision, 1);
  assert.equal(successfulVerification(state), true);
  assert.equal(sessionBlockReason(state), null);
});

// A config edit is a tracked edit like any code edit: it bumps and invalidates.
// (The dispatcher's EditWrite class treats every non-docs path as code/config.)
test('config edit invalidates a current record', () => {
  const sid = 'verif-config-edit';
  let state = buildState(sid, [['set_many', { fields: { code_changed: true, revision: 1, cwd: CWD, detected_lint_command: 'make lint' } }]]);
  state = buildState(sid, [['append', verificationAppendEvent(
    resultFromBashPayload('lint', 'make lint', { exitCode: 0, stdout: 'ok', stderr: '' }, 't1', {
      revision: currentRevision(state), cwd: CWD, now: 1, seq: 1,
    }),
  )]]);
  assert.equal(successfulVerification(state), true);
  assert.equal(sessionBlockReason(state), null);
  state = buildState(sid, [['set_many', { fields: { revision: nextRevisionValue(state), code_changed: true } }]]);
  assert.equal(state.revision, 2);
  assert.equal(successfulVerification(state), false);
  assert.match(sessionBlockReason(state), /Run a detected lint or build command before stopping/);
});

// ADR-0009: "A task without an applicable automated check reports an explicit
// verification gap and rationale; it does not manufacture passed or loop
// forever." Without a detected command and without records the gate keeps
// today's shape (null) — the lean explicit-gap note is deferred to plan task
// 11. The gate must NOT manufacture a pass from the absence of commands.
test('no detected command and no records: explicit gap, no manufactured pass', () => {
  const sid = 'verif-no-detected-gap';
  const state = buildState(sid, [['set_many', { fields: { code_changed: true, cwd: CWD, workflow_profile: 'legacy' } }]]);
  assert.equal(successfulVerification(state), false);
  assert.equal(sessionBlockReason(state), null);
  // With a detected command and zero current records, the existing
  // detected-but-no-success text is kept verbatim.
  const detected = buildState(sid, [['set_many', { fields: { detected_test_command: 'pytest -q' } }]]);
  assert.match(sessionBlockReason(detected), /no successful test command was recorded/);
});

// F01: a background launch is pending evidence — it never satisfies the gate;
// the foreground rerun (the plan's rule when no reliable completion signal
// arrives) is what closes it. Fixture-driven through the payload adapter.
test('background launch -> pending never passes; foreground rerun closes the gate', () => {
  const sid = 'verif-bg-rerun';
  const fixture = loadFixture('verif_post_bash_test_background');
  let state = buildState(sid, [['set_many', { fields: { code_changed: true, revision: 1, cwd: fixture.cwd, detected_test_command: 'npm test' } }]]);
  const launch = resultFromBashPayload('test', fixture.tool_input.command, fixture.tool_response, fixture.tool_use_id, {
    revision: currentRevision(state), cwd: fixture.cwd, now: 1, seq: 1,
  });
  assert.equal(launch.status, 'pending');
  assert.equal(Object.prototype.hasOwnProperty.call(launch.fields, 'tests_ok'), false);
  state = buildState(sid, [['append', verificationAppendEvent(launch)]]);
  assert.equal(successfulVerification(state), false);
  assert.notEqual(sessionBlockReason(state), null);
  const rerun = recordForegroundPass(state, { command: 'npm test', toolUseId: 't2', seq: 2, cwd: fixture.cwd });
  state = buildState(sid, [['append', verificationAppendEvent(rerun)]]);
  assert.equal(successfulVerification(state), true);
  assert.equal(sessionBlockReason(state), null);
});

// Plan 04: results from another worktree do not certify the integrated diff.
test('record from another worktree does not certify this tree; same-cwd record does', () => {
  const sid = 'verif-worktree';
  let state = buildState(sid, [['set_many', { fields: { code_changed: true, revision: 1, cwd: '/w/b', detected_test_command: 'pytest -q' } }]]);
  const foreign = resultFromBashPayload('test', 'pytest -q', { exitCode: 0, stdout: 'ok', stderr: '' }, 't_a', {
    revision: 1, cwd: '/w/a', now: 1, seq: 1,
  });
  state = buildState(sid, [['append', verificationAppendEvent(foreign)]]);
  assert.equal(successfulVerification(state), false);
  assert.notEqual(sessionBlockReason(state), null);
  const local = resultFromBashPayload('test', 'pytest -q', { exitCode: 0, stdout: 'ok', stderr: '' }, 't_b', {
    revision: 1, cwd: '/w/b', now: 2, seq: 2,
  });
  state = buildState(sid, [['append', verificationAppendEvent(local)]]);
  assert.equal(successfulVerification(state), true);
  assert.equal(sessionBlockReason(state), null);
});

// Plan 04.05: file-mutating shell commands the Edit/Write counters cannot see
// bump fs_revision_hint (the conservative fallback), which invalidates earlier
// evidence (ADR-0009).
test('mutating shell command (other class) bumps fs_revision_hint and invalidates a record', () => {
  const sid = 'verif-fs-bump';
  let state = buildState(sid, [['set_many', { fields: { code_changed: true, revision: 1, cwd: CWD, detected_test_command: 'pytest -q' } }]]);
  state = buildState(sid, [['append', verificationAppendEvent(recordForegroundPass(state, { toolUseId: 't1', seq: 1 }))]]);
  assert.equal(sessionBlockReason(state), null);
  assert.equal(isMutatingShellCommand('sed -i s/a/b/ src/app.js'), true);
  // The orchestrator's wiring: PostToolUse Bash class 'other' +
  // isMutatingShellCommand(command) → fs_revision_hint = nextRevisionValue(state).
  state = buildState(sid, [['set_many', { fields: { fs_revision_hint: nextRevisionValue(state) } }]]);
  assert.equal(currentRevision(state), 2);
  assert.equal(successfulVerification(state), false);
  assert.notEqual(sessionBlockReason(state), null);
});

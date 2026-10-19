import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  detectNodeScript, detectMakeTarget, detectTestCmd, detectLintCmd,
  detectBuildCmd, commandClass, isReleaseOrDeployCommand, verificationOutcome,
  resultFromBashPayload, isMutatingShellCommand, currentRevision,
  nextRevisionValue, verificationAppendEvent,
} from '../../plugins/agnthive/modules/verification.mjs';
import { successfulVerification } from '../../plugins/agnthive/modules/summary-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projects = join(here, '..', '..', 'test', 'hooks', 'projects');
const nodeApp = join(projects, 'node-app');
const makeProject = join(projects, 'make-any-language');

// --- commandClass (pure) --------------------------------------------------

const CLASS_CASES = [
  ['pytest -q', 'test'],
  ['npm test', 'test'],
  ['npm run test', 'test'],
  ['pnpm test', 'test'],
  ['yarn test', 'test'],
  ['cargo test', 'test'],
  ['go test ./...', 'test'],
  ['ctest', 'test'],
  ['make test', 'test'],
  ['npm run lint', 'lint'],
  ['pnpm lint', 'lint'],
  ['yarn lint', 'lint'],
  ['ruff check .', 'lint'],
  ['flake8', 'lint'],
  ['cargo clippy --all-targets', 'lint'],
  ['golangci-lint run', 'lint'],
  ['eslint .', 'lint'],
  ['shellcheck *.sh', 'lint'],
  ['python -m compileall .', 'lint'],
  ['make lint', 'lint'],
  ['cmake --build .', 'build'],
  ['make all', 'build'],
  ['make clean', 'other'],
  ['make', 'build'],
  ['make install', 'build'],
  // A bare "make:" (colon, no space) is not "make" and not "make <target>":
  // it must fall through to "other" rather than match a build pattern.
  ['make:', 'other'],
  ['make something', 'build'],
  ['echo hello', 'other'],
  ['git status', 'other'],
  ['', 'other'],
];
for (const [cmd, expected] of CLASS_CASES) {
  test(`commandClass(${JSON.stringify(cmd)}) -> ${expected}`, () => {
    assert.equal(commandClass(cmd), expected);
  });
}

// --- isReleaseOrDeployCommand (pure) --------------------------------------

test('isReleaseOrDeployCommand flags release/deploy, ignores others', () => {
  for (const c of ['npm publish', 'cargo publish', 'docker push img', 'gh release create v1', 'kubectl apply -f x.yaml', 'helm upgrade repo chart']) {
    assert.equal(isReleaseOrDeployCommand(c), true, c);
  }
  for (const c of ['npm test', 'git push', 'make build', 'docker build', 'echo hi']) {
    assert.equal(isReleaseOrDeployCommand(c), false, c);
  }
});

// --- discovery (filesystem) -----------------------------------------------

test('node-app project: npm scripts detected', () => {
  assert.equal(detectNodeScript('test', { cwd: nodeApp }), 'npm run test');
  assert.equal(detectNodeScript('lint', { cwd: nodeApp }), 'npm run lint');
  assert.equal(detectNodeScript('build', { cwd: nodeApp }), 'npm run build');
  assert.equal(detectNodeScript('nope', { cwd: nodeApp }), null);
  assert.equal(detectTestCmd({ cwd: nodeApp }), 'npm run test');
  assert.equal(detectLintCmd({ cwd: nodeApp }), 'npm run lint');
  assert.equal(detectBuildCmd({ cwd: nodeApp }), 'npm run build');
});

test('make-any-language project: make targets detected, build falls back to bare make', () => {
  assert.equal(detectMakeTarget('test', { cwd: makeProject }), 'make test');
  assert.equal(detectMakeTarget('lint', { cwd: makeProject }), 'make lint');
  assert.equal(detectMakeTarget('build', { cwd: makeProject }), 'make build');
  assert.equal(detectMakeTarget('phony', { cwd: makeProject }), null);
  assert.equal(detectTestCmd({ cwd: makeProject }), 'make test');
  assert.equal(detectLintCmd({ cwd: makeProject }), 'make lint');
  assert.equal(detectBuildCmd({ cwd: makeProject }), 'make');
});

test('empty project: no commands detected (language-neutral no-command case)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'ver-empty-'));
  try {
    assert.equal(detectTestCmd({ cwd: empty }), null);
    assert.equal(detectLintCmd({ cwd: empty }), null);
    assert.equal(detectBuildCmd({ cwd: empty }), null);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('cargo project: cargo commands detected', () => {
  const d = mkdtempSync(join(tmpdir(), 'ver-cargo-'));
  try {
    writeFileSync(join(d, 'Cargo.toml'), '[package]\nname="x"\n');
    assert.equal(detectTestCmd({ cwd: d }), 'cargo test');
    assert.equal(detectLintCmd({ cwd: d }), 'cargo clippy --all-targets --all-features -- -D warnings');
    assert.equal(detectBuildCmd({ cwd: d }), 'cargo build');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('go project: go test/build detected; lint has no default', () => {
  const d = mkdtempSync(join(tmpdir(), 'ver-go-'));
  try {
    writeFileSync(join(d, 'go.mod'), 'module x\ngo 1.22\n');
    assert.equal(detectTestCmd({ cwd: d }), 'go test ./...');
    assert.equal(detectLintCmd({ cwd: d }), null);
    assert.equal(detectBuildCmd({ cwd: d }), 'go build ./...');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('pytest project: pytest detected via tests/ dir and pyproject.toml', () => {
  const d1 = mkdtempSync(join(tmpdir(), 'ver-py1-'));
  const d2 = mkdtempSync(join(tmpdir(), 'ver-py2-'));
  try {
    mkdirSync(join(d1, 'tests'));
    assert.equal(detectTestCmd({ cwd: d1 }), 'pytest');
    assert.equal(detectLintCmd({ cwd: d1 }), 'python -m compileall .');
    writeFileSync(join(d2, 'pyproject.toml'), '[project]\nname="x"\n');
    assert.equal(detectTestCmd({ cwd: d2 }), 'pytest');
    assert.equal(detectLintCmd({ cwd: d2 }), 'python -m compileall .');
  } finally {
    rmSync(d1, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  }
});

// --- verificationOutcome (state patch + message) --------------------------

test('verificationOutcome: test success and failure', () => {
  assert.deepEqual(verificationOutcome('test', 'pytest -q'), {
    patch: { tests_ok: true, tests_failed: false, last_test_command: 'pytest -q' },
    message: 'Successful verification command recorded: pytest -q',
    event: 'PostToolUse',
  });
  assert.deepEqual(verificationOutcome('test', 'pytest -q', { failed: true, error: 'AssertionError' }), {
    patch: { tests_failed: true, tests_ok: false, last_test_command: 'pytest -q' },
    message: 'Verification command failed: pytest -q. Fix the failure before marking the task done. Error: AssertionError',
    event: 'PostToolUseFailure',
  });
});

test('verificationOutcome: lint and build; other returns null', () => {
  assert.equal(verificationOutcome('lint', 'make lint').event, 'PostToolUse');
  assert.match(verificationOutcome('lint', 'make lint', { failed: true, error: 'x' }).message, /Lint\/static-check command failed/);
  assert.equal(verificationOutcome('build', 'cmake --build .').event, 'PostToolUse');
  assert.match(verificationOutcome('build', 'cmake --build .', { failed: true, error: 'x' }).message, /Build command failed/);
  assert.equal(verificationOutcome('other', 'echo hi'), null);
});

// --- resultFromBashPayload (ADR-0009 record model, plan task 04.1-02) ------
// Canonical shapes live in test/hooks/fixtures/verif_*.json; these unit cases
// pin the derivation rules directly.

const NOW = 1735689000000;
const CTX = { revision: 3, cwd: '/repo', toolUseId: 'toolu_unit', now: NOW, seq: 7 };

test('resultFromBashPayload: non-verification class returns null (passthrough contract)', () => {
  assert.equal(resultFromBashPayload('other', 'echo hi', { exitCode: 0 }, 't1', CTX), null);
});

test('resultFromBashPayload: background launch -> pending, never passed, no ok flag (F01)', () => {
  const res = resultFromBashPayload(
    'test',
    'npm test',
    {
      stdout: 'Command running in background (shell ID: bash_1). You will be notified when it completes.',
      stderr: '',
    },
    'toolu_bg',
    CTX,
  );
  assert.equal(res.kind, 'test');
  assert.equal(res.status, 'pending');
  assert.equal(res.eventClass, 'PostToolUse');
  assert.equal(res.record.status, 'pending');
  assert.equal(res.record.completedRevision, null);
  assert.equal(res.record.finishedAt, null);
  // A launch never flips an ok/failed flag: last-command trail only.
  assert.deepEqual(res.fields, { last_test_command: 'npm test' });
  assert.match(res.message, /not completed yet/);
});

test('resultFromBashPayload: background marker accepted on whichever field carries it', () => {
  const payloads = [
    { backgroundTaskId: 'bash_1' },
    { background_task_id: 'bash_1' },
    { backgroundShellId: 'ws_1' },
    { run_in_background: true },
    { runInBackground: true },
    { isBackground: true },
    { status: 'running' },
    { taskStatus: 'started' },
    'Command running in background.',
    { stdout: 'Task launched in background. You will be notified when it completes.' },
    { stdout: 'Command running in background (shell ID: bash_1).' },
  ];
  for (const payload of payloads) {
    const res = resultFromBashPayload('test', 'npm test', payload, 't', CTX);
    assert.equal(res.status, 'pending', JSON.stringify(payload));
    assert.equal(res.record.status, 'pending', JSON.stringify(payload));
  }
});

test('resultFromBashPayload: foreground completion success -> passed, legacy flags stay in sync', () => {
  const res = resultFromBashPayload('test', 'pytest -q', { stdout: '3 passed', stderr: '', exitCode: 0 }, 'toolu_ok', CTX);
  assert.equal(res.status, 'passed');
  assert.equal(res.eventClass, 'PostToolUse');
  // Legacy flags-sync contract: the patch is byte-identical to verificationOutcome.
  assert.deepEqual(res.fields, { tests_ok: true, tests_failed: false, last_test_command: 'pytest -q' });
  assert.equal(res.message, 'Successful verification command recorded: pytest -q');
  assert.deepEqual(res.record, {
    id: 'v7',
    kind: 'test',
    command: 'pytest -q',
    toolUseId: 'toolu_ok',
    status: 'passed',
    startedRevision: 3,
    completedRevision: 3,
    cwd: '/repo',
    exitStatus: 0,
    signal: null,
    error: '',
    startedAt: new Date(NOW).toISOString(),
    finishedAt: new Date(NOW).toISOString(),
    source: 'post_tool_use',
  });
  assert.deepEqual(verificationAppendEvent(res), { field: 'verification', value: res.record });
});

test('resultFromBashPayload: foreground completion failure -> failed, legacy failure flags in sync', () => {
  const res = resultFromBashPayload('test', 'pytest -q', { stdout: '1 failed', stderr: 'AssertionError: expected 2 == 3', exitCode: 1 }, 't', CTX);
  assert.equal(res.status, 'failed');
  assert.equal(res.eventClass, 'PostToolUseFailure');
  assert.deepEqual(res.fields, { tests_failed: true, tests_ok: false, last_test_command: 'pytest -q' });
  assert.match(res.message, /Verification command failed: pytest -q/);
  assert.equal(res.record.exitStatus, 1);
  assert.equal(res.record.error, 'AssertionError: expected 2 == 3');
  assert.equal(res.record.completedRevision, 3);
  assert.equal(res.record.finishedAt, new Date(NOW).toISOString());
});

test('resultFromBashPayload: exit code read on whichever field carries it', () => {
  for (const payload of [{ exitCode: 0 }, { exit_code: 0 }, { exitStatus: 0 }, { exit_status: 0 }]) {
    assert.equal(resultFromBashPayload('lint', 'make lint', payload, 't', CTX).status, 'passed', JSON.stringify(payload));
  }
  for (const payload of [{ exitCode: 1 }, { exit_code: 2 }, { exitStatus: -1 }, { exit_status: 125 }]) {
    assert.equal(resultFromBashPayload('build', 'cmake --build .', payload, 't', CTX).status, 'failed', JSON.stringify(payload));
  }
});

test('resultFromBashPayload: interrupted -> unknown (never passed), signal recorded', () => {
  const res = resultFromBashPayload('test', 'npm test', { stdout: 'partial output', interrupted: true }, 't', CTX);
  assert.equal(res.status, 'unknown');
  assert.equal(res.record.status, 'unknown');
  assert.equal(res.record.signal, 'interrupted');
  assert.equal(res.record.exitStatus, null);
  assert.equal(res.record.completedRevision, null);
  assert.equal(res.record.finishedAt, new Date(NOW).toISOString());
  assert.deepEqual(res.fields, { last_test_command: 'npm test' });
  assert.match(res.message, /did not complete \(interrupted\)/);
});

test('resultFromBashPayload: missing or unrecognized response -> unknown (NEVER passed)', () => {
  for (const payload of [null, undefined, '', 'all tests passed', 42, {}, { stdout: 'no exit code here' }]) {
    const res = resultFromBashPayload('test', 'pytest -q', payload, 't', CTX);
    assert.equal(res.status, 'unknown', JSON.stringify(payload));
    assert.equal(res.record.status, 'unknown', JSON.stringify(payload));
    assert.deepEqual(res.fields, { last_test_command: 'pytest -q' });
  }
});

test('resultFromBashPayload: assumeFailure keeps event-sourced failure evidence when the response is unusable', () => {
  const res = resultFromBashPayload('test', 'pytest -q', null, null, { ...CTX, assumeFailure: true, error: 'AssertionError: expected 2 == 3' });
  assert.equal(res.status, 'failed');
  assert.deepEqual(res.fields, { tests_failed: true, tests_ok: false, last_test_command: 'pytest -q' });
  assert.equal(res.eventClass, 'PostToolUseFailure');
  assert.equal(res.record.error, 'AssertionError: expected 2 == 3');
});

test('resultFromBashPayload: assumeFailure is overridden by the real response (exit code wins)', () => {
  const res = resultFromBashPayload('test', 'pytest -q', { exitCode: 0 }, null, { ...CTX, assumeFailure: true });
  assert.equal(res.status, 'passed');
});

test('resultFromBashPayload: explicit error excerpt is bounded and trimmed', () => {
  const long = `AssertionError: ${'x'.repeat(500)}`;
  const res = resultFromBashPayload('test', 'pytest -q', { stderr: long, exitCode: 1 }, 't', CTX);
  assert.equal(res.record.error.length, 200);
  assert.match(res.record.error, /^AssertionError: x+…$/);
});

test('resultFromBashPayload: v<seq> ids fall back to the timestamp; revision fields are threaded', () => {
  const sequenced = resultFromBashPayload('test', 'npm test', { exitCode: 0 }, 't', { revision: 0, seq: 12 });
  assert.equal(sequenced.record.id, 'v12');
  const timestamped = resultFromBashPayload('test', 'npm test', { exitCode: 0 }, 't', { revision: 0, now: NOW });
  assert.match(timestamped.record.id, /^v\d+$/);
  assert.equal(timestamped.record.startedRevision, 0);
  assert.equal(timestamped.record.completedRevision, 0);
  // ctx.revision absent -> no revisions on the record -> the gate can never
  // treat it as evidence (honest unknown provenance).
  const bare = resultFromBashPayload('test', 'npm test', { exitCode: 0 }, 't', {});
  assert.equal(bare.record.startedRevision, null);
  assert.equal(bare.record.completedRevision, null);
});

test('resultFromBashPayload: ctx.startedRevision carries the launch revision (edit-during-test input)', () => {
  const res = resultFromBashPayload('test', 'npm test', { exitCode: 0 }, 't', { revision: 3, startedRevision: 2, now: NOW });
  assert.equal(res.record.startedRevision, 2);
  assert.equal(res.record.completedRevision, 3);
  assert.equal(res.status, 'passed');
});

test('verificationAppendEvent: returns null for a null result or a recordless result', () => {
  assert.equal(verificationAppendEvent(null), null);
  assert.equal(verificationAppendEvent({}), null);
});

test('currentRevision/nextRevisionValue: fs_revision_hint participates in the current revision', () => {
  assert.equal(currentRevision({}), 0);
  assert.equal(currentRevision({ revision: 3 }), 3);
  assert.equal(currentRevision({ revision: 3, fs_revision_hint: 5 }), 5);
  assert.equal(currentRevision({ revision: 8, fs_revision_hint: 5 }), 8);
  assert.equal(nextRevisionValue({}), 1);
  assert.equal(nextRevisionValue({ revision: 3, fs_revision_hint: 5 }), 6);
});

// --- successfulVerification: revision-aware gate (ADR-0009, plan 04.3) ------
// Gate-level pinning; the end-to-end scenarios live in
// test/integration/post-tool-use.test.mjs.

const record = (over = {}) => ({
  id: 'v1', kind: 'test', command: 'npm test', toolUseId: 't', status: 'passed',
  startedRevision: 2, completedRevision: 2, cwd: '', exitStatus: 0, signal: null,
  error: '', startedAt: 't', finishedAt: 't', source: 'post_tool_use', ...over,
});

test('successfulVerification: legacy fallback without records is unchanged', () => {
  assert.equal(successfulVerification({ tests_ok: true }), true);
  assert.equal(successfulVerification({ tests_ok: true, verification: [] }), true);
  assert.equal(successfulVerification({ lint_ok: true }), true);
  assert.equal(successfulVerification({ build_ok: true }), true);
  assert.equal(successfulVerification({}), false);
  assert.equal(successfulVerification({ lint_ok: true, detected_test_command: 'npm test' }), false);
  assert.equal(successfulVerification(null), false);
});

test('successfulVerification: a current same-revision pass from records closes the gate', () => {
  assert.equal(successfulVerification({
    revision: 2,
    detected_test_command: 'npm test',
    verification: [record({ completedRevision: 2 })],
  }), true);
  // No cwd on the state: the record cwd is not bound.
  assert.equal(successfulVerification({
    revision: 0,
    verification: [record({ startedRevision: 0, completedRevision: 0 })],
  }), true);
});

test('successfulVerification: stale, pending, failed, unknown, and foreign-worktree records never pass', () => {
  const detected = { revision: 3, detected_test_command: 'npm test' };
  assert.equal(successfulVerification({ ...detected, verification: [record({ startedRevision: 2, completedRevision: 2 })] }), false);
  assert.equal(successfulVerification({ ...detected, verification: [record({ startedRevision: 2, completedRevision: 3 })] }), false);
  assert.equal(successfulVerification({ ...detected, verification: [record({ status: 'pending', completedRevision: null })] }), false);
  assert.equal(successfulVerification({ ...detected, verification: [record({ status: 'unknown', completedRevision: null })] }), false);
  assert.equal(successfulVerification({ ...detected, verification: [record({ status: 'failed', startedRevision: 3, completedRevision: 3 })] }), false);
  assert.equal(successfulVerification({
    revision: 3, cwd: '/repo', detected_test_command: 'npm test',
    verification: [record({ startedRevision: 3, completedRevision: 3, cwd: '/other-worktree' })],
  }), false);
  // fs_revision_hint ahead of the record => stale (the conservative fallback
  // for file-mutating shell commands invalidates evidence).
  assert.equal(successfulVerification({
    revision: 2, fs_revision_hint: 5, detected_test_command: 'npm test',
    verification: [record({ completedRevision: 2 })],
  }), false);
  assert.equal(successfulVerification({
    revision: 2, fs_revision_hint: 5, detected_test_command: 'npm test',
    verification: [record({ startedRevision: 5, completedRevision: 5 })],
  }), true);
});

test('successfulVerification: records are authoritative over legacy *_ok flags', () => {
  // A record-bearing session must not ride on flags of a pre-bump run.
  assert.equal(successfulVerification({
    revision: 2, tests_ok: true, detected_test_command: 'npm test',
    verification: [record({ completedRevision: 1, startedRevision: 1 })],
  }), false);
  // ... and non-passthrough record shapes beat bogus flags in the reverse
  // direction too (a flag can never upgrade a record that fails its checks).
  assert.equal(successfulVerification({
    revision: 2, lint_ok: true, build_ok: true,
    verification: [record({ status: 'failed', kind: 'lint' })],
  }), false);
});

test('successfulVerification: lint/build records substitute only without a detected test command', () => {
  assert.equal(successfulVerification({
    revision: 5, detected_test_command: '', detected_lint_command: 'make lint',
    verification: [record({ kind: 'lint', startedRevision: 5, completedRevision: 5, cwd: '' })],
  }), true);
  assert.equal(successfulVerification({
    revision: 5, detected_test_command: '', detected_build_command: 'make',
    verification: [record({ kind: 'build', startedRevision: 5, completedRevision: 5, cwd: '' })],
  }), true);
  // A detected test command keeps the legacy chain shape: lint/build passes do
  // not close it.
  assert.equal(successfulVerification({
    revision: 5, detected_test_command: 'npm test', detected_lint_command: 'make lint',
    verification: [record({ kind: 'lint', startedRevision: 5, completedRevision: 5, cwd: '' })],
  }), false);
});

// --- isMutatingShellCommand (conservative fallback, plan task 04.05)--------

test('isMutatingShellCommand: mutating shell shapes are flagged', () => {
  const mutating = [
    'sed -i "s/a/b/" src.js',
    "sed -ie 's/a/b/' src.js",
    'sed --in-place -e s/a/b/ f',
    'echo hi > out.txt',
    'echo hi >> out.log',
    'ls 2>err.txt',
    'npm run format > fix.log',
    'cat x | tee y',
    'tee -a f',
    'mv a b', 'cp a b', 'rm -rf build', 'rm x', 'rmdir d',
    'dd if=x of=y', 'ln -s a b', 'mkdir -p d', 'touch file', 'truncate -s 0 f',
    'patch -p1 < f.diff',
    'git checkout main', 'git restore .', 'git apply x.diff', 'git merge other',
    'git rebase main', 'git stash', 'git stash pop', 'git reset --hard',
    'git clean -fd', 'git pull', 'git cherry-pick x', 'git revert HEAD',
    'git worktree add ../w2', 'git rm file', 'git mv a b', 'git am 0001.patch',
    'git submodule update --init',
    'chmod +x run.sh', 'chown u:g f', 'mkdir -p d', 'touch file',
    'npm install', 'npm install -D pkg', 'npm ci', 'yarn add x', 'pnpm remove x', 'npm run codemod',
    'pip install -r requirements.txt', 'python -m pip install x', 'cargo add serde',
    'cargo fmt', 'apt-get install -y x', 'brew install x', 'uv sync', 'gem install x',
    'rsync -a a b', 'wget https://example.com/f', 'tar -xf a.tar', 'unzip a.zip',
    'gzip -k f', 'node index.js', 'python app.py', 'bash setup.sh', './deploy.py',
    'node script.mjs',
    'gofmt -w x.go', 'black .', 'isort .', 'go get x', 'go mod tidy', 'go generate ./...',
    'npx prettier --write .', 'npx eslint --fix .',
    'sudo rm -rf /tmp/x',
    'FOO=1 rm x',
    'env FLAG=1 rm x',
    'nohup make install > /dev/null & mkdir dist',
  ];
  for (const cmd of mutating) {
    assert.equal(isMutatingShellCommand(cmd), true, cmd);
  }
});

test('isMutatingShellCommand: readers, checks, and fd-dup noise stay unflagged', () => {
  const safe = [
    'npm test', 'npm run test', 'pytest -q', 'cargo test', 'go test ./...', 'make lint',
    'npm run build', 'npm run build >/dev/null', 'make clean',
    'npm test 2>&1', 'npm test > /dev/null 2>&1', 'ls >/dev/null',
    'cat f', 'ls', 'echo hi', 'git status', 'git log', 'git diff', 'git add f',
    'git commit -m msg', 'git push', 'git branch', 'git tag v1', 'git fetch',
    'node --version', 'python --version',
    'bash -c "echo hi"', 'node -e "console.log(1)"',
    'npx tsc --noEmit', 'uvx ruff check .',
    'grep -r pattern .', 'man git merge', 'git log --grep=merge',
    'sed -n 1p f', 'awk "{print $1}" f',
  ];
  for (const cmd of safe) {
    assert.equal(isMutatingShellCommand(cmd), false, cmd);
  }
});
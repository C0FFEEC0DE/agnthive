import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  detectNodeScript, detectMakeTarget, detectTestCmd, detectLintCmd,
  detectBuildCmd, commandClass, isReleaseOrDeployCommand, verificationOutcome,
} from '../../plugins/agent-hive/modules/verification.mjs';

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
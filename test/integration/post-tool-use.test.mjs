import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { statePaths, loadState } from '../../plugins/agent-hive/modules/state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dispatcher = join(root, 'plugins', 'agent-hive', 'modules', 'hook-dispatcher.mjs');
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

test('PostToolUse Bash test success: records tests_ok and emits context', () => {
  const res = runDispatcher('PostToolUse', 'post_bash_test_success', dataRoot);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /Successful verification command recorded: pytest -q/);
  const state = loadState(statePaths(dataRoot, 'case-post-bash'));
  assert.equal(state.tests_ok, true);
  assert.equal(state.tests_failed, false);
  assert.equal(state.last_test_command, 'pytest -q');
});

test('PostToolUse Bash cmake: classified as build', () => {
  const res = runDispatcher('PostToolUse', 'post_bash_cmake', dataRoot);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Successful build command recorded: cmake --build \./);
  const state = loadState(statePaths(dataRoot, 'case-post-bash-cmake'));
  assert.equal(state.build_ok, true);
  assert.equal(state.last_build_command, 'cmake --build .');
});

test('PostToolUse Bash make lint: classified as lint', () => {
  const res = runDispatcher('PostToolUse', 'post_bash_make_lint_success', dataRoot);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /Successful lint\/static-check command recorded: make lint/);
  const state = loadState(statePaths(dataRoot, 'case-post-bash-make-lint'));
  assert.equal(state.lint_ok, true);
  assert.equal(state.last_lint_command, 'make lint');
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

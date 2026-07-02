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

function runDispatcher(event, fixtureName, dataRoot) {
  const stdin = readFileSync(join(fixtures, `${fixtureName}.json`), 'utf8');
  return spawnSync(process.execPath, [dispatcher, '--event', event], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot },
  });
}

let dataRoot;
test.before(() => { dataRoot = mkdtempSync(join(tmpdir(), 'ups-int-')); });
test.after(() => { rmSync(dataRoot, { recursive: true, force: true }); });

function parseOut(res) {
  if (!res.stdout || res.stdout.trim() === '') return null;
  return JSON.parse(res.stdout);
}

test('UserPromptSubmit feature: emits workflow context and persists classification', () => {
  const res = runDispatcher('UserPromptSubmit', 'user_prompt_feature', dataRoot);
  assert.equal(res.status, 0);
  const out = parseOut(res);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('successful'));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('feature workflow'));

  const fixture = JSON.parse(readFileSync(join(fixtures, 'user_prompt_feature.json'), 'utf8'));
  const state = loadState(statePaths(dataRoot, fixture.session_id));
  assert.equal(state.task_type, 'feature');
  assert.equal(state.manager_mode, 'none');
  assert.equal(state.docs_required, true);
  assert.deepEqual(state.required_subagents, ['t', 'cr']);
  assert.deepEqual(state.required_subagent_any_of, [['e', 'a']]);
  // stop-loop reset applied
  assert.equal(state.stop_block_count, 0);
  assert.equal(state.stalled_by_policy, false);
});

test('UserPromptSubmit review: context mentions @cr', () => {
  const res = runDispatcher('UserPromptSubmit', 'user_prompt_review', dataRoot);
  assert.equal(res.status, 0);
  const out = parseOut(res);
  assert.ok(out.hookSpecificOutput.additionalContext.includes('@cr'));
});

test('UserPromptSubmit docs: context mentions @doc', () => {
  const res = runDispatcher('UserPromptSubmit', 'user_prompt_docs', dataRoot);
  assert.equal(res.status, 0);
  const out = parseOut(res);
  assert.ok(out.hookSpecificOutput.additionalContext.includes('@doc'));
});

test('UserPromptSubmit support: tech-support reclassification with bug word', () => {
  const res = runDispatcher('UserPromptSubmit', 'user_prompt_tech_support_bug_word', dataRoot);
  assert.equal(res.status, 0);
  const out = parseOut(res);
  assert.ok(out.hookSpecificOutput.additionalContext.includes('support workflow'));
  const fixture = JSON.parse(readFileSync(join(fixtures, 'user_prompt_tech_support_bug_word.json'), 'utf8'));
  assert.equal(loadState(statePaths(dataRoot, fixture.session_id)).task_type, 'support');
});

test('UserPromptSubmit informational model question: neutral passthrough, task_type other', () => {
  const res = runDispatcher('UserPromptSubmit', 'user_prompt_model_question', dataRoot);
  assert.equal(res.status, 0);
  const out = parseOut(res);
  assert.deepEqual(out, {}, 'no context emitted for informational query');
  const fixture = JSON.parse(readFileSync(join(fixtures, 'user_prompt_model_question.json'), 'utf8'));
  assert.equal(loadState(statePaths(dataRoot, fixture.session_id)).task_type, 'other');
});

test('UserPromptSubmit casual hey: neutral passthrough', () => {
  const res = runDispatcher('UserPromptSubmit', 'user_prompt_hey', dataRoot);
  assert.equal(res.status, 0);
  assert.deepEqual(parseOut(res), {});
});

test('UserPromptSubmit empty session_id: graceful, still classifies', () => {
  const res = runDispatcher('UserPromptSubmit', 'user_prompt_no_session_id', dataRoot);
  assert.equal(res.status, 0);
  const out = parseOut(res);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  // state written under the no-session fallback id
  assert.equal(loadState(statePaths(dataRoot, 'no-session')).task_type, 'feature');
});

test('UserPromptSubmit plan-only: required roles empty, context is Plan-only', () => {
  const res = runDispatcher('UserPromptSubmit', 'user_prompt_models_manager_plan_only', dataRoot);
  assert.equal(res.status, 0);
  const out = parseOut(res);
  assert.ok(out.hookSpecificOutput.additionalContext.includes('Plan-only'));
  const fixture = JSON.parse(readFileSync(join(fixtures, 'user_prompt_models_manager_plan_only.json'), 'utf8'));
  const state = loadState(statePaths(dataRoot, fixture.session_id));
  assert.equal(state.manager_mode, 'plan_only');
  assert.deepEqual(state.required_subagents, []);
  assert.deepEqual(state.required_subagent_any_of, []);
});

test('UserPromptSubmit override: benchmark refactor override wins', () => {
  const res = runDispatcher('UserPromptSubmit', 'user_prompt_benchmark_refactor_override', dataRoot);
  assert.equal(res.status, 0);
  const fixture = JSON.parse(readFileSync(join(fixtures, 'user_prompt_benchmark_refactor_override.json'), 'utf8'));
  const state = loadState(statePaths(dataRoot, fixture.session_id));
  assert.equal(state.task_type, 'refactor');
  assert.deepEqual(state.required_subagents, ['t', 'cr']);
  assert.deepEqual(state.required_subagent_any_of, [['a', 'e']]);
});

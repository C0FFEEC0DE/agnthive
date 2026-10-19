import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { statePaths, loadState, reducer } from '../../plugins/agnthive/modules/state.mjs';
import {
  classifyPrompt, promptCorrelationPatch, taskTransition, loopBlockResetKeys,
} from '../../plugins/agnthive/modules/workflow.mjs';
import { parseHookInput } from '../../plugins/agnthive/modules/hook-input.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dispatcher = join(root, 'plugins', 'agnthive', 'modules', 'hook-dispatcher.mjs');
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

// --- plan 05 integration: slash routing through the real dispatcher ---------

function runPromptInline(prompt, sessionId, dataRootLocal = dataRoot) {
  const payload = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    prompt,
    session_id: sessionId,
    source: 'user',
  });
  return spawnSync(process.execPath, [dispatcher, '--event', 'UserPromptSubmit'], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRootLocal },
  });
}

test('UserPromptSubmit namespaced /agnthive:manager routes to manager orchestrate (F06)', () => {
  const res = runPromptInline('/agnthive:manager coordinate this feature build', 'upslash-own');
  assert.equal(res.status, 0);
  const state = loadState(statePaths(dataRoot, 'upslash-own'));
  assert.equal(state.manager_mode, 'orchestrate');
  assert.equal(state.task_type, 'feature');
  assert.deepEqual(state.required_subagents, ['t', 'cr']);
});

test('UserPromptSubmit plain /manager keeps legacy routing and args classification', () => {
  const res = runPromptInline('/manager run the review and docs pass', 'upslash-plain');
  assert.equal(res.status, 0);
  const state = loadState(statePaths(dataRoot, 'upslash-plain'));
  assert.equal(state.manager_mode, 'orchestrate');
  assert.equal(state.task_type, 'review', 'the args still classify (review words)');
  assert.deepEqual(state.required_subagents, ['cr']);
});

test('UserPromptSubmit foreign /other:manager never activates local roles (F06)', () => {
  const res = runPromptInline('/other:manager do things', 'upslash-foreign');
  assert.equal(res.status, 0);
  const state = loadState(statePaths(dataRoot, 'upslash-foreign'));
  assert.equal(state.manager_mode, 'none');
  assert.equal(state.task_type, 'other');
  assert.deepEqual(state.required_subagents, []);
  assert.deepEqual(state.required_subagent_any_of, []);
});

// --- plan 05 lifecycle compositions: the ADR-0010 handler contract the
// --- orchestrator wires, exercised against the real state.mjs reducer -------

function setMany(fields) { return { type: 'set_many', payload: { fields } }; }
function mapClear(mapField) { return { type: 'map_clear', payload: { mapField } }; }
function mapSet(mapField, key, value) { return { type: 'map_set', payload: { mapField, key, value } }; }
function mapDelete(mapField, key) { return { type: 'map_delete', payload: { mapField, key } }; }

// Compose ONE classified submission the way the ADR-0010 UserPromptSubmit
// handler will: correlation fields, per-key loop-block reset on a new task
// (replacing the legacy whole-map clear, ADR-0010 amendment), transition
// fields, and the transition's whole-map clears. state must be the CURRENT
// composed state (reducer(events) so far); events is grown in place.
function applySubmission(events, state, prompt, promptId, inputExtra = {}, resetOnNewTask = true) {
  const cls = classifyPrompt(prompt);
  const parsed = parseHookInput(JSON.stringify({ prompt, prompt_id: promptId }));
  const corr = promptCorrelationPatch(parsed, state, cls);
  const tt = taskTransition(state, cls, {
    prompt, promptId, dedupe: corr.dedupe, seq: corr.fields.prompt_seq, ...inputExtra,
  });
  events.push(setMany(corr.fields));
  if (resetOnNewTask && tt.isNewTask) {
    const rs = loopBlockResetKeys(state.agents, state.subagent_stop_blocks);
    for (const key of rs.mapDeletes) events.push(mapDelete(rs.mapField, key));
    events.push(setMany(rs.scalarResets));
  }
  events.push(setMany(tt.fields));
  for (const mapField of tt.mapClears) events.push(mapClear(mapField));
  return { cls, corr, tt, state: reducer(events) };
}

test('lifecycle composition: two different tasks in one session reset role satisfaction', () => {
  const events = [];
  const p1 = 'Implement a retry policy for the sync worker and document it';
  const s1 = applySubmission(events, reducer(events), p1, 'p1');
  assert.equal(s1.state.task_id, 'task-1');
  assert.equal(s1.state.prompt_seq, 1);
  assert.equal(s1.state.last_prompt_id, 'p1');
  assert.equal(s1.cls.taskType, 'docs');
  assert.deepEqual(s1.state.required_subagents, ['doc']);
  assert.notEqual(s1.state.active_task, null);
  assert.equal(s1.state.active_task.status, 'open');
  // the role counts map starts empty on task 1
  assert.deepEqual(s1.state.subagent_instance_count_by_role, {});

  // a verified completion releases the contract and records history
  const complete = taskTransition(s1.state, s1.cls, { completed: true, seq: 2 });
  events.push(setMany(complete.fields));
  const released = reducer(events);
  assert.equal(released.task_id, '');
  assert.equal(released.active_task, null);
  assert.equal(released.last_task_id, 'task-1');

  // prompt 2: a bugfix task — fresh contract, satisfaction reset, no carry-over
  const p2 = 'Fix the login redirect loop';
  const s2 = applySubmission(events, released, p2, 'p2');
  assert.equal(s2.state.task_id, 'task-2');
  assert.equal(s2.state.last_task_id, 'task-1');
  assert.equal(s2.cls.taskType, 'bugfix');
  assert.deepEqual(s2.state.required_subagents, ['t', 'cr']);
  assert.deepEqual(s2.state.required_subagent_any_of, [['bug', 'e', 'dbg']]);
  assert.equal(s2.state.task_type, 'bugfix');
  assert.equal(s2.state.prompt_seq, 2);
  assert.notStrictEqual(s2.state.active_task, released.active_task);
});

test('lifecycle composition: duplicate prompt_id dedupes (no seq bump, no reset)', () => {
  const events = [];
  const p1 = 'Fix the login redirect loop';
  const s1 = applySubmission(events, reducer(events), p1, 'corr-x');
  assert.equal(s1.state.prompt_seq, 1);
  const again = applySubmission(events, s1.state, p1, 'corr-x', {}, false);
  assert.equal(again.corr.dedupe, true, 'same id and same classification dedupes');
  assert.equal(again.state.prompt_seq, 1, 'a deduped delivery does not bump prompt_seq');
  assert.equal(again.state.task_id, 'task-1');
  assert.equal(again.tt.fields.task_id, undefined, 'a deduped delivery writes no transition fields');
});

test('lifecycle composition: new task keeps a running sibling loop-block, drops the rest', () => {
  const events = [];
  events.push(
    mapSet('agents', 'w1', { role: 't', status: 'running', starts: 1 }),
    mapSet('agents', 'w2', { role: 'cr', status: 'completed', starts: 1 }),
    mapSet('subagent_stop_blocks', 'w1', { count: 2, reason: 'r', message: 'm' }),
    mapSet('subagent_stop_blocks', 'w2', { count: 1, reason: 'r', message: 'm' }),
    mapSet('subagent_stop_blocks', '_session', { count: 1, reason: 'r', message: 'm' }),
  );
  const seeded = reducer(events);
  const fresh = applySubmission(events, { ...seeded, task_id: '', active_task: null }, 'Fix the login redirect loop', 'p-live', {}, true);
  assert.equal(fresh.state.task_id, 'task-1');
  const blocks = fresh.state.subagent_stop_blocks;
  assert.deepEqual(Object.keys(blocks).sort(), ['w1'], 'only the running sibling keeps its counter');
  assert.deepEqual(blocks.w1, { count: 2, reason: 'r', message: 'm' });
  assert.deepEqual(fresh.state.agents.w1.status, 'running');
});

test('lifecycle composition: plan-only contract keeps implementation gates off', () => {
  const events = [];
  const open = { id: 'task-1', kind: 'feature', required_subagents: ['t', 'cr'], required_subagent_any_of: [['e', 'a']], dispatch_contract_mode: '', docs_required: true, status: 'open', revision: 0, refinements: [] };
  events.push(
    setMany({ task_id: 'task-1', ...open, active_task: open, required_subagents: ['t', 'cr'] }),
  );
  const seeded = reducer(events);
  const r = applySubmission(events, seeded, 'Plan-only: sketch the migration approach, do not implement yet', 'p-plan');
  assert.equal(r.tt.transition, 'plan_only');
  assert.equal(r.state.manager_mode, 'plan_only');
  assert.deepEqual(r.state.required_subagents, []);
  assert.deepEqual(r.state.required_subagent_any_of, []);
  assert.equal(r.state.active_task.status, 'plan_only');
  assert.equal(r.state.active_task.id, 'task-1');
  assert.equal(r.tt.fields.dispatch_contract_mode, '', 'an empty mode stays empty');
});

test('lifecycle composition: background deliverable continues without opening a task', () => {
  const events = [];
  events.push(
    setMany({
      required_subagents: ['t', 'cr'],
      required_subagent_any_of: [['e', 'a']],
      dispatch_contract_mode: 'observed',
      task_type: 'bugfix',
    }),
    mapSet('background_tasks', 'bg1', { role: 't', status: 'running', updatedAt: 3 }),
  );
  const seeded = reducer(events);

  // (a) an open contract: the background deliverable must NOT weaken it
  const open = { id: 'task-1', kind: 'bugfix', required_subagents: ['t', 'cr'], required_subagent_any_of: [['e', 'a']], dispatch_contract_mode: 'observed', docs_required: true, status: 'open', revision: 1, refinements: [] };
  events.push(setMany({ task_id: 'task-1', active_task: open }));
  const withOpen = reducer(events);
  const a = applySubmission(events, withOpen, 'The background test run finished, results below', 'p-bg', { backgroundCorrelation: true });
  assert.equal(a.tt.transition, 'continue');
  assert.equal(a.state.task_id, 'task-1');
  assert.deepEqual(a.state.required_subagents, ['t', 'cr'], 'the open contract is not weakened');
  assert.equal(a.state.dispatch_contract_mode, 'observed');

  // (b) no open task: the deliverable never opens one and satisfaction stays untouched
  const base2 = [{ type: 'set_many', payload: { fields: {
    subagent_instance_count_by_role: { t: 3 },
    required_subagents: ['t', 'cr'],
    tests_ok: true,
  } } }, mapSet('background_tasks', 'bg1', { role: 't', status: 'running', updatedAt: 3 })];
  const seeded2 = reducer(base2);
  const events2 = base2;
  const b = applySubmission(events2, seeded2, 'The background test run finished, results below', 'p-bg2', { backgroundCorrelation: true });
  assert.equal(b.tt.transition, 'continue');
  assert.equal(b.tt.isNewTask, false);
  assert.equal(b.state.task_id, '');
  assert.equal(b.state.active_task, null);
  assert.deepEqual(b.state.subagent_instance_count_by_role, { t: 3 }, 'satisfaction counters not cleared by a background deliverable');  assert.equal(b.corr.fields.prompt_seq, 1);
});

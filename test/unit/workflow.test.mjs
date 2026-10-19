import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  classifyPrompt, taskTypeRequiresImplementationSummary,
  taskTypeRequiresSpecialistHandoffs, loopBlockFields, loopBlockCount,
  recordLoopBlock, clearLoopBlockPatch, userPromptResetPatch,
  sessionBackgroundManagerPending, STOP_SAFE_HINT, parseDispatchContractMarker,
  agentLoopKey, hasPriorStopBlock,
  parseSlashedCommand, promptCorrelationPatch, taskTransition,
  loopBlockResetKeys,
} from '../../plugins/agnthive/modules/workflow.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'test', 'hooks', 'fixtures');
function loadPrompt(name) {
  return JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8')).prompt;
}

// Fixture -> expected classification. Each row preserves the task type and
// role state the migrated UserPromptSubmit hook must produce.
const EXPECT = [
  ['user_prompt_feature', { taskType: 'feature', managerMode: 'none', docsRequired: true, requiredSubagents: ['t', 'cr'], anyOf: [['e', 'a']], ctx: 'feature workflow' }],
  ['user_prompt_bugfix', { taskType: 'bugfix', managerMode: 'none', docsRequired: true, requiredSubagents: ['t', 'cr'], anyOf: [['bug', 'e', 'dbg']], ctx: 'bugfix workflow' }],
  ['user_prompt_bugfix_ru', { taskType: 'bugfix', managerMode: 'none', docsRequired: true, requiredSubagents: ['t', 'cr'], anyOf: [['bug', 'e', 'dbg']], ctx: 'bugfix workflow' }],
  ['user_prompt_refactor', { taskType: 'refactor', managerMode: 'none', docsRequired: true, requiredSubagents: ['t', 'cr'], anyOf: [['a', 'e']], ctx: 'refactor workflow' }],
  ['user_prompt_review', { taskType: 'review', managerMode: 'none', docsRequired: false, requiredSubagents: ['cr'], anyOf: [], ctx: '@cr' }],
  ['user_prompt_docs', { taskType: 'docs', managerMode: 'none', docsRequired: true, requiredSubagents: ['doc'], anyOf: [], ctx: '@doc' }],
  ['user_prompt_model_question', { taskType: 'other', managerMode: 'none', docsRequired: false, requiredSubagents: [], anyOf: [], ctx: '' }],
  ['user_prompt_models_info', { taskType: 'other', managerMode: 'none', docsRequired: false, requiredSubagents: [], anyOf: [], ctx: '' }],
  ['user_prompt_models_creative_typo_info', { taskType: 'other', managerMode: 'none', docsRequired: false, requiredSubagents: [], anyOf: [], ctx: '' }],
  ['user_prompt_models_compare_repo', { taskType: 'other', managerMode: 'none', docsRequired: false, requiredSubagents: [], anyOf: [], ctx: '' }],
  ['user_prompt_models_feature', { taskType: 'feature', managerMode: 'none', docsRequired: true, requiredSubagents: ['t', 'cr'], anyOf: [['e', 'a']], ctx: 'feature workflow' }],
  ['user_prompt_models_mixed_feature', { taskType: 'feature', managerMode: 'none', docsRequired: true, requiredSubagents: ['t', 'cr'], anyOf: [['e', 'a']], ctx: 'feature workflow' }],
  ['user_prompt_models_manager_plan_only', { taskType: 'feature', managerMode: 'plan_only', docsRequired: true, requiredSubagents: [], anyOf: [], ctx: 'Plan-only' }],
  ['user_prompt_models_review', { taskType: 'review', managerMode: 'none', docsRequired: false, requiredSubagents: ['cr'], anyOf: [], ctx: '@cr' }],
  ['user_prompt_models_docs', { taskType: 'docs', managerMode: 'none', docsRequired: true, requiredSubagents: ['doc'], anyOf: [], ctx: '@doc' }],
  ['user_prompt_tech_support_bug_word', { taskType: 'support', managerMode: 'none', docsRequired: false, requiredSubagents: [], anyOf: [], ctx: 'support workflow' }],
  ['user_prompt_benchmark_refactor_override', { taskType: 'refactor', managerMode: 'none', docsRequired: true, requiredSubagents: ['t', 'cr'], anyOf: [['a', 'e']], ctx: 'refactor workflow' }],
  ['user_prompt_mixed_intent', { taskType: 'bugfix', managerMode: 'none', docsRequired: true, requiredSubagents: ['t', 'cr'], anyOf: [['bug', 'e', 'dbg']], ctx: 'bugfix workflow' }],
  ['user_prompt_hey', { taskType: 'other', managerMode: 'none', docsRequired: false, requiredSubagents: [], anyOf: [], ctx: '' }],
  ['user_prompt_manager_plan_only', { taskType: 'feature', managerMode: 'plan_only', docsRequired: true, requiredSubagents: [], anyOf: [], ctx: 'Plan-only' }],
  ['user_prompt_no_session_id', { taskType: 'feature', managerMode: 'none', docsRequired: true, requiredSubagents: ['t', 'cr'], anyOf: [['e', 'a']], ctx: 'feature workflow' }],
];

for (const [name, exp] of EXPECT) {
  test(`classifyPrompt: ${name} -> ${exp.taskType}/${exp.managerMode}`, () => {
    const r = classifyPrompt(loadPrompt(name));
    assert.equal(r.taskType, exp.taskType, `taskType for ${name}`);
    assert.equal(r.managerMode, exp.managerMode, `managerMode for ${name}`);
    assert.equal(r.docsRequired, exp.docsRequired, `docsRequired for ${name}`);
    assert.deepEqual(r.requiredSubagents, exp.requiredSubagents, `requiredSubagents for ${name}`);
    assert.deepEqual(r.requiredSubagentAnyOf, exp.anyOf, `requiredSubagentAnyOf for ${name}`);
    if (exp.ctx === '') assert.equal(r.contextMessage, '', `contextMessage for ${name} should be empty`);
    else assert.ok(r.contextMessage.includes(exp.ctx), `contextMessage for ${name} should contain "${exp.ctx}", got: ${r.contextMessage}`);
  });
}

test('stop-safe hint appears on non-plan-only gated contexts', () => {
  const r = classifyPrompt(loadPrompt('user_prompt_feature'));
  assert.ok(r.contextMessage.includes(STOP_SAFE_HINT.trim().slice(0, 40)));
});

test('plan-only context omits the stop-safe hint', () => {
  const r = classifyPrompt(loadPrompt('user_prompt_models_manager_plan_only'));
  assert.ok(!r.contextMessage.includes('If a later reply'));
});

test('classifyPrompt: dispatch-contract marker overrides category-default roles', () => {
  const prompt = 'Workflow override: treat this as a bugfix workflow, not a review-only workflow.\n'
    + 'BENCHMARK_DISPATCH_CONTRACT: root_only; mode=observed; roles=bug\n'
    + 'Task: fix the divide-by-zero in calculator.py.';
  const r = classifyPrompt(prompt);
  // Category still classified (for docs/verification gating)...
  assert.equal(r.taskType, 'bugfix');
  // ...but required roles come from the marker only; any-of groups cleared.
  assert.deepEqual(r.requiredSubagents, ['bug']);
  assert.deepEqual(r.requiredSubagentAnyOf, []);
  assert.ok(r.contextMessage.includes('Required specialist handoff before completion: @bug'), r.contextMessage);
  assert.ok(r.contextMessage.includes('do not add category-default'), r.contextMessage);
  // The marker mode is surfaced for persistence to session state.
  assert.equal(r.dispatchContractMode, 'observed');
});

test('classifyPrompt: enforced dispatch-contract mode is surfaced for the hard guard', () => {
  const prompt = 'BENCHMARK_DISPATCH_CONTRACT: root_only; mode=enforced; roles=a\n'
    + 'Use @a to extract the duplicated normalization into a shared helper.';
  const r = classifyPrompt(prompt);
  assert.equal(r.dispatchContractMode, 'enforced');
  assert.deepEqual(r.requiredSubagents, ['a']);
});

test('classifyPrompt: no marker yields empty dispatchContractMode (guard inert)', () => {
  const r = classifyPrompt(loadPrompt('user_prompt_feature'));
  assert.equal(r.dispatchContractMode, '');
});

test('parseDispatchContractMarker parses well-formed markers and rejects malformed ones', () => {
  assert.equal(parseDispatchContractMarker('nothing here'), null);
  assert.equal(parseDispatchContractMarker('BENCHMARK_DISPATCH_CONTRACT: root_only; mode=observed; roles='), null);
  const m = parseDispatchContractMarker('BENCHMARK_DISPATCH_CONTRACT: root_only; mode=enforced; roles=t,cr');
  assert.deepEqual(m, { rootOnly: true, mode: 'enforced', roles: ['t', 'cr'] });
  const m2 = parseDispatchContractMarker('BENCHMARK_DISPATCH_CONTRACT: mode=observed; roles=Bug');
  assert.deepEqual(m2, { rootOnly: false, mode: 'observed', roles: ['bug'] });
});

// --- task type predicates --------------------------------------------------

test('taskTypeRequiresImplementationSummary', () => {
  for (const t of ['feature', 'bugfix', 'refactor', 'review', 'docs']) {
    assert.equal(taskTypeRequiresImplementationSummary(t), true, t);
  }
  for (const t of ['support', 'other', '', 'random']) {
    assert.equal(taskTypeRequiresImplementationSummary(t), false, t);
  }
});

test('taskTypeRequiresSpecialistHandoffs', () => {
  for (const t of ['feature', 'bugfix', 'refactor', 'review', 'docs', 'support']) {
    assert.equal(taskTypeRequiresSpecialistHandoffs(t), true, t);
  }
  for (const t of ['other', '', 'random']) {
    assert.equal(taskTypeRequiresSpecialistHandoffs(t), false, t);
  }
});

// --- loop-block accounting -------------------------------------------------

test('agentLoopKey returns the agent id or the shared _session fallback (ADR 0006)', () => {
  assert.equal(agentLoopKey('agent-a'), 'agent-a');
  assert.equal(agentLoopKey(undefined), '_session');
  assert.equal(agentLoopKey(''), '_session');
  assert.equal(agentLoopKey(null), '_session');
});

test('loopBlockFields maps stop and subagent_stop, rejects others', () => {
  assert.deepEqual(loopBlockFields('stop'), { countKey: 'stop_block_count', reasonKey: 'stop_block_reason', messageKey: 'stop_block_message', perAgent: false });
  assert.deepEqual(loopBlockFields('subagent_stop'), { mapKey: 'subagent_stop_blocks', perAgent: true });
  assert.equal(loopBlockFields('nope'), null);
});

test('recordLoopBlock increments on matching reason+message, resets otherwise', () => {
  const s = { stop_block_count: 2, stop_block_reason: 'r', stop_block_message: 'm' };
  assert.deepEqual(recordLoopBlock(s, 'stop', 'r', 'm'), { stop_block_count: 3, stop_block_reason: 'r', stop_block_message: 'm' });
  assert.deepEqual(recordLoopBlock(s, 'stop', 'r2', 'm'), { stop_block_count: 1, stop_block_reason: 'r2', stop_block_message: 'm' });
  assert.equal(recordLoopBlock(s, 'bad', 'r', 'm'), null);
});

test('recordLoopBlock: subagent_stop is per-agent (increment/reset per agent key)', () => {
  const s = { subagent_stop_blocks: { 'agent-a': { count: 2, reason: 'r', message: 'm' } } };
  // ADR-0005: the per-agent return is { mapKey, key, entry } — the single
  // changed key plus its new entry, no full-map snapshot.
  // same agent, same reason+message -> increment
  assert.deepEqual(recordLoopBlock(s, 'subagent_stop', 'r', 'm', 'agent-a'), {
    mapKey: 'subagent_stop_blocks', key: 'agent-a', entry: { count: 3, reason: 'r', message: 'm' },
  });
  // same agent, new reason -> reset to 1
  assert.deepEqual(recordLoopBlock(s, 'subagent_stop', 'r2', 'm', 'agent-a'), {
    mapKey: 'subagent_stop_blocks', key: 'agent-a', entry: { count: 1, reason: 'r2', message: 'm' },
  });
  // different agent starts at 1 even with the same reason+message as agent-a
  assert.deepEqual(recordLoopBlock(s, 'subagent_stop', 'r', 'm', 'agent-b'), {
    mapKey: 'subagent_stop_blocks', key: 'agent-b', entry: { count: 1, reason: 'r', message: 'm' },
  });
  // absent agent_id falls back to the shared _session key
  assert.deepEqual(recordLoopBlock({}, 'subagent_stop', 'r', 'm'), {
    mapKey: 'subagent_stop_blocks', key: '_session', entry: { count: 1, reason: 'r', message: 'm' },
  });
  assert.equal(recordLoopBlock(s, 'bad', 'r', 'm', 'agent-a'), null);
});

test('loopBlockCount reads defensively', () => {
  assert.equal(loopBlockCount({ stop_block_count: 5 }, 'stop'), 5);
  assert.equal(loopBlockCount({}, 'stop'), 0);
  assert.equal(loopBlockCount({ subagent_stop_blocks: { 'agent-a': { count: 3 } } }, 'subagent_stop', 'agent-a'), 3);
  // different agent -> 0 (per-agent isolation)
  assert.equal(loopBlockCount({ subagent_stop_blocks: { 'agent-a': { count: 3 } } }, 'subagent_stop', 'agent-b'), 0);
  // absent agent_id falls back to _session
  assert.equal(loopBlockCount({ subagent_stop_blocks: { _session: { count: 2 } } }, 'subagent_stop'), 2);
  assert.equal(loopBlockCount({}, 'subagent_stop', 'agent-a'), 0);
  assert.equal(loopBlockCount({}, 'subagent_stop'), 0);
  assert.equal(loopBlockCount({}, 'bad'), 0);
});

// ADR-0003 amendment: the stop_hook_active yield is gated on this predicate so
// a runtime that erroneously sets the flag on a first Stop invocation cannot
// silently disable enforcement. It reads the count through loopBlockCount (the
// declared single read path) and ORs in the terminal policy-stall flag.
test('hasPriorStopBlock is true only when a prior stop block or policy stall exists', () => {
  assert.equal(hasPriorStopBlock({}), false, 'fresh session has no prior block');
  assert.equal(hasPriorStopBlock({ stop_block_count: 0, stalled_by_policy: false }), false);
  assert.equal(hasPriorStopBlock({ stop_block_count: 1 }), true, 'one prior block counts');
  assert.equal(hasPriorStopBlock({ stop_block_count: '2' }), true, 'coerces a string count');
  assert.equal(hasPriorStopBlock({ stop_block_count: 0, stalled_by_policy: true }), true, 'terminal policy stall counts');
  // A non-numeric / NaN count with no stall is NOT a prior block (Number(NaN)||0 = 0).
  assert.equal(hasPriorStopBlock({ stop_block_count: 'oops' }), false);
});

test('clearLoopBlockPatch zeroes stop fields and policy-stall state', () => {
  assert.deepEqual(clearLoopBlockPatch('stop'), {
    stop_block_count: 0, stop_block_reason: '', stop_block_message: '',
    stalled_by_policy: false, policy_stall_reason: '',
  });
  assert.equal(clearLoopBlockPatch('bad'), null);
  // The per-agent `subagent_stop` clear is no longer routed through this
  // function (the dispatcher clears one agent key via a map_delete event); it
  // returns null for a per-agent prefix instead of a full-map snapshot that
  // would re-introduce the ADR-0002 race clobber.
  assert.equal(clearLoopBlockPatch('subagent_stop'), null);
});

test('userPromptResetPatch returns scalar reset + mapClears for the per-agent map', () => {
  // ADR-0002 amendment: the per-agent map is cleared via a map_clear event
  // (listed in mapClears), not folded into the scalar set_many, so a
  // concurrent SubagentStop writer's key survives the turn reset.
  assert.deepEqual(userPromptResetPatch(), {
    scalar: {
      stop_block_count: 0, stop_block_reason: '', stop_block_message: '',
      stalled_by_policy: false, policy_stall_reason: '',
    },
    mapClears: ['subagent_stop_blocks'],
  });
});

// --- session_background_manager_pending ------------------------------------

test('sessionBackgroundManagerPending gating', () => {
  const base = { taskType: 'feature', managerMode: 'orchestrate', codeChanged: false, backgroundedAgent: true, startedRoles: ['m'] };
  assert.equal(sessionBackgroundManagerPending(base), true);
  assert.equal(sessionBackgroundManagerPending({ ...base, taskType: 'other' }), false);
  assert.equal(sessionBackgroundManagerPending({ ...base, managerMode: 'none' }), false);
  assert.equal(sessionBackgroundManagerPending({ ...base, codeChanged: true }), false);
  assert.equal(sessionBackgroundManagerPending({ ...base, backgroundedAgent: false }), false);
  assert.equal(sessionBackgroundManagerPending({ ...base, startedRoles: ['e'] }), false);
  assert.equal(sessionBackgroundManagerPending({ ...base, taskType: 'support' }), false);
});
// --- ADR-0010 (plan 05): slash routing + task identity ---------------------

test('parseSlashedCommand parses namespaced, plain, and foreign tokens', () => {
  assert.deepEqual(parseSlashedCommand('/agnthive:manager implement new feature'),
    { namespace: 'agnthive', command: 'manager', args: 'implement new feature' });
  assert.deepEqual(parseSlashedCommand('/manager do it'), { namespace: '', command: 'manager', args: 'do it' });
  assert.deepEqual(parseSlashedCommand('/manager'), { namespace: '', command: 'manager', args: '' });
  assert.deepEqual(parseSlashedCommand('/other:manager x'), { namespace: 'other', command: 'manager', args: 'x' });
  assert.deepEqual(parseSlashedCommand('/:manager x'), null);
  assert.equal(parseSlashedCommand('wordy /manager'), null);
  assert.equal(parseSlashedCommand(42), null);
});

test('parseSlashedCommand rejects prompts without a leading slash token', () => {
  assert.equal(parseSlashedCommand('no slash at all'), null);
  assert.equal(parseSlashedCommand(null), null);
});

test('classifyPrompt routes namespaced manager slash command', () => {
  assert.equal(classifyPrompt('/agnthive:manager implement new feature').managerMode, 'orchestrate');
});

test('classifyPrompt keeps plain /manager legacy routing', () => {
  assert.equal(classifyPrompt('/manager implement new feature').managerMode, 'orchestrate');
});

test('classifyPrompt ignores foreign-namespace manager slash command (F06)', () => {
  assert.equal(classifyPrompt('/other:manager do it').managerMode, 'none');
  assert.equal(classifyPrompt('/other:manager do it').taskType, 'other');
  assert.deepEqual(classifyPrompt('/other:server:manager x').requiredSubagents, []);
});

test('classifyPrompt honors AGNTHIVE:Manager case-insensitive route', () => {
  assert.equal(classifyPrompt('/AGNTHIVE:Manager do it').managerMode, 'orchestrate');
});

test('classifyPrompt keeps @m/@manager regex routing (legacy unchanged)', () => {
  assert.equal(classifyPrompt('@m coordinate the work').managerMode, 'orchestrate');
});

// --- ADR-0010 (plan 05.2): prompt correlation ------------------------------

test('promptCorrelationPatch dedupes an unchanged re-delivery and bumps seq on a new prompt', () => {
  const base = { prompt_seq: 5, last_prompt_id: 'p1', task_type: 'other', manager_mode: 'none', docs_required: false, dispatch_contract_mode: '', required_subagents: [], required_subagent_any_of: [] };
  const cls = { taskType: 'other', managerMode: 'none', docsRequired: false, dispatchContractMode: '', requiredSubagents: [], requiredSubagentAnyOf: [] };
  const same = promptCorrelationPatch({ promptId: 'p1' }, base, cls);
  assert.equal(same.dedupe, true);
  assert.deepEqual(same.fields, { prompt_seq: 5, last_prompt_id: 'p1' });
  const sameNoState = promptCorrelationPatch({ promptId: 'p1' }, null, cls);
  assert.equal(sameNoState.dedupe, false);
  const missing = promptCorrelationPatch({ promptId: 'p2' }, base, cls);
  assert.equal(missing.dedupe, false);
  assert.deepEqual(missing.fields, { prompt_seq: 6, last_prompt_id: 'p2' });
  const noId = promptCorrelationPatch({}, base, cls);
  assert.equal(noId.dedupe, false);
  assert.deepEqual(noId.fields, { prompt_seq: 6, last_prompt_id: '' });
});

test('promptCorrelationPatch does not dedupe when classification drifted (same id)', () => {
  const stateWithRoles = { prompt_seq: 5, last_prompt_id: 'p9', task_type: 'feature', manager_mode: 'none', docs_required: true, dispatch_contract_mode: '', required_subagents: ['t', 'cr'], required_subagent_any_of: [['e', 'a']] };
  const drifted = { taskType: 'feature', managerMode: 'none', docsRequired: true, dispatchContractMode: '', requiredSubagents: ['t', 'cr'], requiredSubagentAnyOf: [['e', 'a']] };
  const same = promptCorrelationPatch({ promptId: 'p9' }, stateWithRoles, drifted);
  assert.equal(same.dedupe, true);
  const roleDrift = { taskType: 'feature', managerMode: 'none', docsRequired: true, dispatchContractMode: '', requiredSubagents: ['t'], requiredSubagentAnyOf: [] };
  const driftedPatch = promptCorrelationPatch({ promptId: 'p9' }, stateWithRoles, roleDrift);
  assert.equal(driftedPatch.dedupe, false);
  const markerDrift = { taskType: 'feature', managerMode: 'none', docsRequired: true, dispatchContractMode: 'enforced', requiredSubagents: ['t', 'cr'], requiredSubagentAnyOf: [['e', 'a']] };
  const drift2 = promptCorrelationPatch({ promptId: 'p9' }, stateWithRoles, markerDrift);
  assert.equal(drift2.dedupe, false);
});

// --- ADR-0010 (plan 05.3-05.5): task identity ------------------------------

const NONE_CLS = Object.freeze({ taskType: 'other', managerMode: 'none', docsRequired: false, requiredSubagents: [], requiredSubagentAnyOf: [], dispatchContractMode: '' });

test('taskTransition: start', () => {
  const r = taskTransition({}, NONE_CLS, { seq: 3 });
  assert.equal(r.transition, 'start');
  assert.equal(r.isNewTask, true);
  assert.equal(r.task_id, 'task-3');
  assert.equal(r.fields.task_id, 'task-3');
  assert.equal(r.fields.active_task.id, 'task-3');
  assert.equal(r.fields.active_task.status, 'open');
  assert.equal(r.fields.active_task.revision, 0);
  assert.deepEqual(r.fields.active_task.required_subagents, []);
  assert.deepEqual(r.mapClears, ['subagent_instance_count_by_role']);
  const feat = taskTransition({}, { taskType: 'feature', managerMode: 'none', docsRequired: true, requiredSubagents: ['t', 'cr'], requiredSubagentAnyOf: [['e', 'a']], dispatchContractMode: '' }, { seq: 4 });
  assert.equal(feat.fields.task_type, 'feature');
  assert.equal(feat.fields.manager_mode, 'none');
  assert.equal(feat.fields.docs_required, true);
  assert.deepEqual(feat.fields.required_subagents, ['t', 'cr']);
  assert.deepEqual(feat.fields.active_task.required_subagent_any_of, [['e', 'a']]);
  assert.deepEqual(feat.fields.active_task.refinements, []);
});

test('taskTransition: continue preserves the open contract and appends a refinement', () => {
  const open = { id: 'task-2', kind: 'feature', required_subagents: ['t', 'cr'], required_subagent_any_of: [['e', 'a']], dispatch_contract_mode: '', docs_required: true, status: 'open', revision: 3, refinements: [] };
  const r = taskTransition({ task_id: 'task-2', active_task: open }, NONE_CLS, { prompt: 'also update the readme', seq: 5 });
  assert.equal(r.transition, 'continue');
  assert.equal(r.isNewTask, false);
  assert.equal(r.task_id, 'task-2');
  assert.equal(r.fields.active_task.id, 'task-2');
  assert.deepEqual(r.fields.active_task.required_subagents, ['t', 'cr']);
  assert.deepEqual(r.fields.active_task.dispatch_contract_mode, '');
  assert.deepEqual(r.fields, { active_task: r.fields.active_task });
  assert.equal(r.fields.active_task.refinements.length, 1);
  assert.deepEqual(r.fields.active_task.refinements[0], { seq: 5, text: 'also update the readme' });
});

test('taskTransition: continue caps refinements at 10 and truncates text at 240', () => {
  let prev = { task_id: 'task-2', active_task: { id: 'task-2', kind: 'other', required_subagents: [], required_subagent_any_of: [], dispatch_contract_mode: '', docs_required: false, status: 'open', revision: 0, refinements: [] } };
  for (let n = 1; n <= 12; n++) {
    prev = taskTransition({ task_id: 'task-2', active_task: prev }, NONE_CLS, { prompt: `refinement ${n}`.repeat(40), seq: n + 1 }).fields.active_task;
  }
  assert.equal(prev.refinements.length, 10);
  assert.equal(prev.refinements[0].text.length, 240);
  assert.deepEqual(prev.refinements.map((x) => x.seq), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test('taskTransition: complete releases the contract and records history', () => {
  const prev = { task_id: 'task-2', docs_required: true, active_task: { id: 'task-2', kind: 'feature', required_subagents: ['t', 'cr'], required_subagent_any_of: [['e', 'a']], dispatch_contract_mode: 'observed', docs_required: true, status: 'open', revision: 2, refinements: [] } };
  const r = taskTransition(prev, NONE_CLS, { completed: true, seq: 6 });
  assert.equal(r.transition, 'complete');
  assert.equal(r.isNewTask, false);
  assert.equal(r.task_id, '');
  assert.equal(r.active_task, null);
  assert.deepEqual(r.fields, {
    task_id: '', active_task: null, last_task_id: 'task-2',
    required_subagents: [], required_subagent_any_of: [], dispatch_contract_mode: '',
  });
});

test('taskTransition: new_task boundary from an explicit benchmark dispatch marker', () => {
  const prev = { task_id: 'task-2', active_task: { id: 'task-2', kind: 'other', required_subagents: [], required_subagent_any_of: [], dispatch_contract_mode: '', docs_required: false, status: 'open', revision: 0, refinements: [] } };
  const markerCls = { taskType: 'bugfix', managerMode: 'none', docsRequired: false, requiredSubagents: ['bug'], requiredSubagentAnyOf: [], dispatchContractMode: 'enforced' };
  const r = taskTransition(prev, markerCls, { seq: 7 });
  assert.equal(r.transition, 'new_task');
  assert.equal(r.isNewTask, true);
  assert.equal(r.task_id, 'task-7');
  assert.equal(r.fields.last_task_id, 'task-2');
  assert.equal(r.fields.active_task.id, 'task-7');
  assert.deepEqual(r.fields.active_task.required_subagents, ['bug']);
  assert.deepEqual(r.fields.active_task.dispatch_contract_mode, 'enforced');
  assert.deepEqual(r.fields.subagents_started, []);
  assert.equal(r.fields.tests_ok, false);
  assert.deepEqual(r.mapClears, ['subagent_instance_count_by_role']);
});

test('taskTransition: dedupe and background correlation never open a task', () => {
  const open = { id: 'task-2', kind: 'other', required_subagents: [], required_subagent_any_of: [], dispatch_contract_mode: '', docs_required: false, status: 'open', revision: 1, refinements: [] };
  const prev = { task_id: 'task-2', active_task: open };
  const d = taskTransition(prev, NONE_CLS, { dedupe: true, seq: 8 });
  assert.equal(d.transition, 'continue');
  assert.equal(d.isNewTask, false);
  assert.equal(d.active_task.id, 'task-2');
  assert.deepEqual(d.active_task.refinements, []);
  const bg = taskTransition({}, NONE_CLS, { backgroundCorrelation: true, seq: 9 });
  assert.equal(bg.transition, 'continue');
  assert.equal(bg.isNewTask, false);
  assert.equal(bg.task_id, '');
  assert.equal(bg.active_task, null);
  assert.deepEqual(bg.fields, {});
  assert.deepEqual(bg.mapClears, []);
});

test('taskTransition: plan-only switches the open contract to plan_only status', () => {
  const open = { id: 'task-2', kind: 'feature', required_subagents: ['t', 'cr'], required_subagent_any_of: [['e', 'a']], dispatch_contract_mode: '', docs_required: true, status: 'open', revision: 2, refinements: [] };
  const r = taskTransition({ task_id: 'task-2', active_task: open }, { taskType: 'feature', managerMode: 'plan_only', docsRequired: true, requiredSubagents: [], requiredSubagentAnyOf: [], dispatchContractMode: '' }, { prompt: 'plan the feature first', seq: 9 });
  assert.equal(r.transition, 'plan_only');
  assert.equal(r.isNewTask, false);
  assert.equal(r.fields.active_task.status, 'plan_only');
  assert.equal(r.fields.active_task.id, 'task-2');
  assert.equal(r.fields.manager_mode, 'plan_only');
  assert.deepEqual(r.fields.required_subagents, []);
  assert.equal(r.fields.dispatch_contract_mode, '');
  assert.equal(r.fields.active_task.refinements[0].text, 'plan the feature first');
});

test('taskTransition: completion signal beats plan-only and markers need an open contract', () => {
  const open = { id: 'task-2', kind: 'other', required_subagents: [], required_subagent_any_of: [], dispatch_contract_mode: '', docs_required: false, status: 'plan_only', revision: 0, refinements: [] };
  const comp = taskTransition({ task_id: 'task-2', active_task: open }, NONE_CLS, { completed: true, seq: 10 });
  assert.equal(comp.transition, 'complete');
  const noOpenMarker = taskTransition({}, { ...NONE_CLS, dispatchContractMode: 'enforced' }, { seq: 11 });
  assert.equal(noOpenMarker.transition, 'start');
  assert.equal(noOpenMarker.fields.active_task.dispatch_contract_mode, 'enforced');
});

test('loopBlockResetKeys deletes non-running keys and preserves running siblings', () => {
  const registry = { keepLive: { status: 'running' }, oldWork: { status: 'completed' }, stale: { status: 'unknown' } };
  const loopMap = { keepLive: { count: 2 }, oldWork: { count: 1 }, stale: { count: 3 }, ghost: { count: 9 } };
  const r = loopBlockResetKeys(registry, loopMap);
  assert.equal(r.mapField, 'subagent_stop_blocks');
  assert.deepEqual(r.mapDeletes, ['ghost', 'oldWork', 'stale']);
  assert.deepEqual(r.scalarResets, {
    stop_block_count: 0, stop_block_reason: '', stop_block_message: '',
    stalled_by_policy: false, policy_stall_reason: '',
  });
});

test('loopBlockResetKeys preserves the _session key when any missing-id agent is running', () => {
  const r = loopBlockResetKeys({ _session: { status: 'running' } }, { _session: { count: 1 }, w1: { count: 2 } });
  assert.deepEqual(r.mapDeletes, ['w1']);
  const r2 = loopBlockResetKeys({ _session: { status: 'unknown' } }, { _session: { count: 1 } });
  assert.deepEqual(r2.mapDeletes, ['_session']);
});
// --- workflow profile: routing cases only (plan task 11). The profile
// --- resolver/gate-flag contract lives in workflow-profile.test.mjs.
import { leanProfileGates, leanRequiredRoles, DEFAULT_WORKFLOW_PROFILE, WORKFLOW_PROFILES } from '../../plugins/agnthive/modules/workflow.mjs';
import { resolveWorkflowProfile, reportWorkflowProfileNote } from '../../plugins/agnthive/modules/plugin-config.mjs';

test('classifyPrompt: legacy routing survives absent and invalid profile opts', () => {
  const r = classifyPrompt(loadPrompt('user_prompt_feature'));
  assert.equal(r.profile, 'legacy');
  assert.deepEqual(r.requiredSubagents, ['t', 'cr']);
  assert.deepEqual(r.requiredSubagentAnyOf, [['e', 'a']]);
  const bad = classifyPrompt(loadPrompt('user_prompt_feature'), { profile: 'turbo' });
  assert.equal(bad.profile, 'legacy');
  assert.deepEqual(bad.requiredSubagents, ['t', 'cr']);
});

test('classifyPrompt: lean routing drops quotas and keeps @cr', () => {
  const r = classifyPrompt(loadPrompt('user_prompt_feature'), { profile: 'lean' });
  assert.equal(r.taskType, 'feature');
  assert.deepEqual(r.requiredSubagents, ['cr'], 'feature keeps only @cr');
  assert.deepEqual(r.requiredSubagentAnyOf, [], 'one-of groups cleared');
  assert.equal(r.docsRequired, true, 'docs decision flag is a decision, not a quota');
  assert.equal(r.profile, 'lean');
  assert.ok(r.contextMessage.includes('Lean profile'), 'lean context re-wording present');
});

test('classifyPrompt: lean routing keeps @cr but drops the @doc quota for docs work', () => {
  const d = classifyPrompt(loadPrompt('user_prompt_docs'), { profile: 'lean' });
  assert.equal(d.taskType, 'docs');
  assert.deepEqual(d.requiredSubagents, []);
  assert.equal(d.docsRequired, true);
  const rv = classifyPrompt(loadPrompt('user_prompt_review'), { profile: 'lean' });
  assert.equal(rv.taskType, 'review');
  assert.deepEqual(rv.requiredSubagents, ['cr']);
});

test('classifyPrompt: lean scopes the benchmark dispatch contract to test contexts', () => {
  const prompt = 'BENCHMARK_DISPATCH_CONTRACT: root_only; mode=enforced; roles=t,cr implement the login flow';
  const out = classifyPrompt(prompt, { profile: 'lean', benchContext: true });
  assert.deepEqual(out.requiredSubagents, ['t', 'cr'], 'bench marker honored in a test context');
  assert.equal(out.dispatchContractMode, 'enforced');
  assert.equal(out.dispatchContractClaimOnly, false);
  const nonBench = classifyPrompt(prompt, { profile: 'lean', benchContext: false });
  assert.deepEqual(nonBench.requiredSubagents, ['cr'], 'non-bench lean keeps only category @cr');
  assert.equal(nonBench.dispatchContractMode, '', 'mode not persisted outside a test context');
  assert.equal(nonBench.dispatchContractClaimOnly, true);
  assert.ok(nonBench.contextMessage.includes('ignored'), 'scoping note emitted');
  const legacyBench = classifyPrompt(prompt);
  assert.deepEqual(legacyBench.requiredSubagents, ['t', 'cr'], 'legacy applies the marker unconditionally');
  assert.equal(legacyBench.dispatchContractMode, 'enforced');
  assert.equal(legacyBench.dispatchContractClaimOnly, false);
});

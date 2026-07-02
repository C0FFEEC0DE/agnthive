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

function run(event, fixtureName, dataRoot) {
  const stdin = readFileSync(join(fixtures, `${fixtureName}.json`), 'utf8');
  return spawnSync(process.execPath, [dispatcher, '--event', event], {
    input: stdin, encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot },
  });
}

let dataRoot;
test.before(() => { dataRoot = mkdtempSync(join(tmpdir(), 'ss-int-')); });
test.after(() => { rmSync(dataRoot, { recursive: true, force: true }); });

function sid(name) { return JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8')).session_id; }
function ctx(res) { return JSON.parse(res.stdout).hookSpecificOutput.additionalContext; }
function state(name) { return loadState(statePaths(dataRoot, sid(name))); }

test('SubagentStart code_reviewer -> @cr, records role', () => {
  const res = run('SubagentStart', 'subagent_start_code_reviewer', dataRoot);
  assert.equal(res.status, 0);
  assert.match(ctx(res), /Recorded subagent handoff: @cr/);
  const s = state('subagent_start_code_reviewer');
  assert.deepEqual(s.subagents_started, ['cr']);
  assert.equal(s.subagent_instance_count_by_role.cr, 1);
  assert.equal(s.subagent_start_count, 1);
  assert.equal(s.subagent_events[0].role, 'cr');
});

test('SubagentStart designer_alias -> @a (alias from aliases.json)', () => {
  const res = run('SubagentStart', 'subagent_start_designer_alias', dataRoot);
  assert.match(ctx(res), /Recorded subagent handoff: @a/);
  assert.deepEqual(state('subagent_start_designer_alias').subagents_started, ['a']);
});

test('SubagentStart prefers tool_input.name over generic type -> @t', () => {
  const res = run('SubagentStart', 'subagent_start_tool_input_name_over_type', dataRoot);
  assert.match(ctx(res), /Recorded subagent handoff: @t/);
});

test('SubagentStart tool_input.subagent_type over agent_type -> @t', () => {
  const res = run('SubagentStart', 'subagent_start_tool_input_subagent_type_over_agent_type', dataRoot);
  assert.match(ctx(res), /@t/);
  const s = state('subagent_start_tool_input_subagent_type_over_agent_type');
  assert.equal(s.subagent_events[0].purpose, 'Verify Mars Colony game files');
});

test('SubagentStart camelCase subagentType -> @e', () => {
  const res = run('SubagentStart', 'subagent_start_camelcase_subagent_type_over_agent_type', dataRoot);
  assert.match(ctx(res), /@e/);
});

test('SubagentStart top-level subagent_type -> @a', () => {
  const res = run('SubagentStart', 'subagent_start_top_level_subagent_type_over_type', dataRoot);
  assert.match(ctx(res), /@a/);
});

test('SubagentStart tool_input.agentName -> @cr', () => {
  const res = run('SubagentStart', 'subagent_start_tool_input_agent_name_over_type', dataRoot);
  assert.match(ctx(res), /@cr/);
});

test('SubagentStart tool_input.agentAlias -> @dbg', () => {
  const res = run('SubagentStart', 'subagent_start_tool_input_agent_alias_over_type', dataRoot);
  assert.match(ctx(res), /@dbg/);
});

test('SubagentStart keeps started roles unique across duplicate tester', () => {
  run('SubagentStart', 'subagent_start_duplicate_tester', dataRoot);
  run('SubagentStart', 'subagent_start_duplicate_tester', dataRoot);
  const s = state('subagent_start_duplicate_tester');
  assert.deepEqual(s.subagents_started, ['t']);
  assert.equal(s.subagent_instance_count_by_role.t, 2);
  assert.equal(s.subagent_start_count, 2);
  assert.equal(s.subagent_events.length, 2);
});

test('SubagentStart tracks parallel same-role instances with distinct scope', () => {
  // seed the first explorer via its seed-state fixture: emulate by running a
  // first explorer start, then the second-scope fixture
  const first = { session_id: sid('subagent_start_second_explorer_scope'), tool_input: { description: 'Trace workflow A', subagentType: 'Explorer' } };
  spawnSync(process.execPath, [dispatcher, '--event', 'SubagentStart'], {
    input: JSON.stringify(first), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataRoot },
  });
  const res = run('SubagentStart', 'subagent_start_second_explorer_scope', dataRoot);
  assert.match(ctx(res), /Parallel same-role handoffs are allowed/);
  const s = state('subagent_start_second_explorer_scope');
  assert.deepEqual(s.subagents_started, ['e']);
  assert.equal(s.subagent_instance_count_by_role.e, 2);
  assert.equal(s.subagent_events.length, 2);
  assert.equal(s.subagent_events[1].purpose, 'Trace workflow B');
});

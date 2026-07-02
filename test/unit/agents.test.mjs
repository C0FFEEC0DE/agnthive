import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadAliases, canonicalizeSubagentLabel, extractSubagentLabel, extractSubagentScope,
  inferStartedRolesFromTranscript, effectiveStartedRoles, formatSubagentList,
  formatSubagentGroup, GENERIC_TYPES,
} from '../../plugins/agent-hive/modules/agents.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..', '..', 'plugins', 'agent-hive');
const aliases = loadAliases(pluginRoot);
const transcripts = join(here, '..', '..', 'test', 'hooks', 'fixtures', 'transcripts');
import { readFileSync } from 'node:fs';
function readTranscript(name) { return readFileSync(join(transcripts, name), 'utf8'); }

test('loadAliases reads the bundled alias map', () => {
  assert.equal(aliases.cr.includes('code-reviewer'), true);
  assert.equal(aliases.a.includes('design'), true);
  assert.equal(aliases.e.includes('nerd'), true);
});

// --- canonicalizeSubagentLabel --------------------------------------------

const CANON_CASES = [
  ['Code Reviewer', 'cr'],
  ['code reviewer', 'cr'],
  ['@toxic-senior', 'cr'],
  ['design', 'a'],
  ['the-architect', 'a'],
  ['Tester', 't'],
  ['@paranoid', 't'],
  ['Explorer', 'e'],
  ['nerd', 'e'],
  ['Architect', 'a'],
  ['dbg', 'dbg'],
  ['manager', 'm'],
  ['big-boss', 'm'],
  ['general-purpose', 'general-purpose'],
  ['  @Code_Reviewer  ', 'cr'],
  ['', ''],
  [null, ''],
];
for (const [raw, expected] of CANON_CASES) {
  test(`canonicalizeSubagentLabel(${JSON.stringify(raw)}) -> ${expected}`, () => {
    assert.equal(canonicalizeSubagentLabel(raw, aliases), expected);
  });
}

// --- extractSubagentLabel (fixture-driven) --------------------------------

const LABEL_FIXTURES = [
  ['subagent_start_code_reviewer', 'cr'],
  ['subagent_start_designer_alias', 'a'],
  ['subagent_start_tool_input_name_over_type', 't'],
  ['subagent_start_tool_input_subagent_type_over_agent_type', 't'],
  ['subagent_start_camelcase_subagent_type_over_agent_type', 'e'],
  ['subagent_start_top_level_subagent_type_over_type', 'a'],
  ['subagent_start_tool_input_agent_name_over_type', 'cr'],
  ['subagent_start_tool_input_agent_alias_over_type', 'dbg'],
];
for (const [name, expected] of LABEL_FIXTURES) {
  test(`extractSubagentLabel: ${name} -> @${expected}`, () => {
    const fx = JSON.parse(readFileSync(join(here, '..', '..', 'test', 'hooks', 'fixtures', `${name}.json`), 'utf8'));
    assert.equal(extractSubagentLabel(fx, aliases), expected);
  });
}

test('extractSubagentScope: tool_input.description normalized', () => {
  const fx = { tool_input: { description: '  Trace   workflow\nB  ', subagentType: 'Explorer' } };
  assert.equal(extractSubagentScope(fx), 'Trace workflow B');
});

test('extractSubagentScope: falls back through prompt/task', () => {
  assert.equal(extractSubagentScope({ tool_input: { prompt: 'Run it' } }), 'Run it');
  assert.equal(extractSubagentScope({ task: 'do thing' }), 'do thing');
  assert.equal(extractSubagentScope({}), '');
});

// --- inferStartedRolesFromTranscript --------------------------------------

test('infer roles: alias_pattern_multiple -> cr, e, t', () => {
  assert.deepEqual(inferStartedRolesFromTranscript(readTranscript('alias_pattern_multiple.jsonl'), aliases), ['cr', 'e', 't']);
});

test('infer roles: review_agent_started -> cr, m (Manager( + Code Reviewer()', () => {
  assert.deepEqual(inferStartedRolesFromTranscript(readTranscript('review_agent_started.jsonl'), aliases), ['cr', 'm']);
});

test('infer roles: review_skill_started -> cr, m (skill loads)', () => {
  assert.deepEqual(inferStartedRolesFromTranscript(readTranscript('review_skill_started.jsonl'), aliases), ['cr', 'm']);
});

test('infer roles: short @cr -> cr', () => {
  assert.deepEqual(inferStartedRolesFromTranscript(readTranscript('alias_pattern_short_cr.jsonl'), aliases), ['cr']);
});

test('infer roles: no false positives (@example.com / @email-settings), real @e kept', () => {
  const roles = inferStartedRolesFromTranscript(readTranscript('alias_pattern_no_false_positive.jsonl'), aliases);
  assert.deepEqual(roles, ['e']);
});

test('infer roles: empty/missing text -> []', () => {
  assert.deepEqual(inferStartedRolesFromTranscript('', aliases), []);
});

// --- effectiveStartedRoles ------------------------------------------------

test('effectiveStartedRoles merges explicit + inferred, filters generic types', () => {
  const state = { subagents_started: ['e', 'general-purpose', 'workflow-subagent'] };
  const text = '@cr confirmed';
  assert.deepEqual(effectiveStartedRoles(state, text, aliases), ['cr', 'e']);
});

test('effectiveStartedRoles with no transcript still returns explicit non-generic', () => {
  assert.deepEqual(effectiveStartedRoles({ subagents_started: ['t', 'general-purpose'] }, '', aliases), ['t']);
});

test('GENERIC_TYPES lists the Task dispatch types', () => {
  assert.deepEqual(GENERIC_TYPES, ['general-purpose', 'workflow-subagent']);
});

// --- formatting -----------------------------------------------------------

test('formatSubagentList / formatSubagentGroup', () => {
  assert.equal(formatSubagentList(['a', 'b']), '@a, @b');
  assert.equal(formatSubagentList([]), 'none');
  assert.equal(formatSubagentGroup(['e', 'a']), '@e/@a');
  assert.equal(formatSubagentGroup([]), '');
});
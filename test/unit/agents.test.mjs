import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadAliases, canonicalizeSubagentLabel, extractSubagentLabel, extractSubagentScope,
  inferStartedRolesFromTranscript, effectiveStartedRoles, formatSubagentList,
  formatSubagentGroup, GENERIC_TYPES, isAgntHiveSpecialistRole,
  shouldEnforceSubagentFooter, isGenericType, isAliasesLoaded,
  upsertAgent, startedRolesFromRegistry, isForeignOrForkType,
} from '../../plugins/agnthive/modules/agents.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..', '..', 'plugins', 'agnthive');
const aliases = loadAliases(pluginRoot);
const transcripts = join(here, '..', '..', 'test', 'hooks', 'fixtures', 'transcripts');
import { readFileSync, readdirSync } from 'node:fs';
function readTranscript(name) { return readFileSync(join(transcripts, name), 'utf8'); }

test('loadAliases reads the bundled alias map', () => {
  assert.equal(aliases.cr.includes('code-reviewer'), true);
  assert.equal(aliases.a.includes('design'), true);
  assert.equal(aliases.e.includes('nerd'), true);
});

// --- the new roster contract (ADR 0008; modernization plan task 12) --------
//
// Explicit migration of the old implicit "eight agents" contract: the plugin
// now ships three primary specialists as agents (Code Reviewer, Explorer,
// Debugger) and five legacy compatibility agents (Manager, Architect, Tester,
// Docwriter, Bugbuster), which remain only for explicit legacy use and are
// not recommended delegates. The file set and the legacy marker in the
// frontmatter descriptions are pinned here so roster drift cannot happen
// silently. Legacy role gates themselves live in the runtime until the lean
// profile switch (plan tasks 11/16) and are NOT weakened by this test.

const AGENT_DIR = join(pluginRoot, 'agents');
// Deliberately not a Set: the exact file name list is part of the contract.
const PRIMARY_AGENT_FILES = ['code-reviewer.md', 'explorer.md', 'debugger.md'];
const LEGACY_AGENT_FILES = ['manager.md', 'architect.md', 'tester.md', 'docwriter.md', 'bugbuster.md'];

test('plugin ships exactly three primary specialist agents plus five legacy compatibility agents', () => {
  const files = readdirSync(AGENT_DIR).filter((f) => f.endsWith('.md')).sort();
  const expected = [...PRIMARY_AGENT_FILES, ...LEGACY_AGENT_FILES].sort();
  assert.deepEqual(files, expected, `agents/ must be exactly the primary specialists ${JSON.stringify(PRIMARY_AGENT_FILES)} plus the legacy compatibility files ${JSON.stringify(LEGACY_AGENT_FILES)}`);
});

test('primary specialist agents carry the primary aliases cr, e, dbg', () => {
  const expectedAlias = { 'code-reviewer.md': 'cr', 'explorer.md': 'e', 'debugger.md': 'dbg' };
  for (const f of PRIMARY_AGENT_FILES) {
    const lines = readFileSync(join(AGENT_DIR, f), 'utf8').split('\n');
    const name = lines.find((l) => l.startsWith('name:'));
    const alias = lines.find((l) => l.startsWith('alias:'));
    assert.ok(name, `${f}: missing name field`);
    assert.ok(alias, `${f}: missing alias field`);
    assert.equal(alias.slice('alias:'.length).trim(), expectedAlias[f], `${f}: primary alias must be '${expectedAlias[f]}'`);
  }
});

test('legacy compatibility agents are marked as legacy in their description', () => {
  for (const f of LEGACY_AGENT_FILES) {
    const lines = readFileSync(join(AGENT_DIR, f), 'utf8').split('\n');
    const descLine = lines.find((l) => l.startsWith('description:'));
    assert.ok(descLine, `${f}: missing description field`);
    assert.ok(
      /Legacy compatibility agent/.test(descLine),
      `${f}: description must mark the agent as a legacy compatibility agent (found: ${descLine})`,
    );
  }
});

test('legacy alias map keeps the full 8-role mapping for historical evidence (plan task 12.5)', () => {
  for (const role of ['a', 'e', 'bug', 'dbg', 't', 'cr', 'doc', 'm']) {
    assert.ok(Array.isArray(aliases[role]) && aliases[role].length > 0, `alias '${role}' must stay mapped for legacy evidence compatibility`);
  }
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
  // ADR 0004: strip a leading namespace: prefix before normalizing.
  ['agnthive:Explorer', 'e'],
  ['agnthive:Code Reviewer', 'cr'],
  ['agnthive:architect', 'a'],
  ['AGNTHIVE:Tester', 't'],
  ['@agnthive:Manager', 'm'],
  // Bare labels (no colon) are unchanged — general-purpose/workflow-subagent
  // are generic dispatch types, not canonical roles.
  ['workflow-subagent', 'workflow-subagent'],
  // ADR-0004 over-match guard: a foreign namespace prefix must NOT be stripped.
  // mcp:tester -> 'mcp-tester' (kept whole), NOT 'tester' -> 't'.
  // workflow:docs -> 'workflow-docs', NOT 'docs' -> 'doc'. Only the plugin's own
  // 'agnthive:' prefix is stripped; anything else is left intact and so is not
  // misrecognized as an AgntHive specialist.
  ['mcp:tester', 'mcp-tester'],
  ['workflow:docs', 'workflow-docs'],
  ['mcp:Code Reviewer', 'mcp-code-reviewer'],
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

// The role lists below span all eight aliases on purpose: runtime alias
// recognition and footer enforcement stay scoped to the legacy alias map
// (aliases.json is kept byte-identical so old evidence keeps its meaning)
// until the lean profile switch — plan tasks 11/16. New contract lives at
// the top: three primary specialists, five marked legacy agents.
//
// --- isAgntHiveSpecialistRole (ADR 0001) -----------------------------------

test('isAgntHiveSpecialistRole: true for recognized canonical roles', () => {
  for (const role of ['a', 'e', 'bug', 'dbg', 't', 'cr', 'doc', 'm']) {
    assert.equal(isAgntHiveSpecialistRole(role, aliases), true, `expected ${role} to be recognized`);
  }
});

test('isAgntHiveSpecialistRole: false for generic dispatch types and unrecognized labels', () => {
  for (const label of ['general-purpose', 'workflow-subagent', 'agnthive-explorer', 'explorer', '', null, undefined, 42]) {
    assert.equal(isAgntHiveSpecialistRole(label, aliases), false, `expected ${JSON.stringify(label)} to not be recognized`);
  }
});

test('isAgntHiveSpecialistRole: false when aliases is empty', () => {
  assert.equal(isAgntHiveSpecialistRole('cr', {}), false);
});

test('isAgntHiveSpecialistRole: only own-property keys count, not inherited', () => {
  const proto = { cr: ['cr'] };
  const child = Object.create(proto);
  assert.equal(isAgntHiveSpecialistRole('cr', child), false);
});

// --- shouldEnforceSubagentFooter (ADR-0001 hardened scope) -----------------
// Guards the two regressions the adversarial review caught: (1) generic dispatch
// types are always exempt even when the alias map is missing, and (2) a missing
// alias map degrades to enforcing on all non-generic subagents (safe floor),
// never to silently disabling the footer contract.

test('isAliasesLoaded: shared predicate for alias-map loaded-ness', () => {
  assert.equal(isAliasesLoaded({ cr: 'Code Reviewer' }), true);
  assert.equal(isAliasesLoaded({}), false, 'an empty map is not loaded');
  assert.equal(isAliasesLoaded(null), false);
  assert.equal(isAliasesLoaded(undefined), false);
  assert.equal(isAliasesLoaded('not-an-object'), false);
  // The alias map is always a JSON object in practice; the predicate (shared
  // with shouldEnforceSubagentFooter's fallback, behavior-preserving) treats any
  // non-empty object as loaded, so a non-empty array reads as loaded too.
  assert.equal(isAliasesLoaded(['x']), true);
});

test('shouldEnforceSubagentFooter: generic types are exempt even with an empty alias map', () => {
  for (const label of GENERIC_TYPES) {
    assert.equal(shouldEnforceSubagentFooter(label, label, {}), false, `${label} must pass through with no aliases`);
    assert.equal(shouldEnforceSubagentFooter(label, null, {}), false, `${label} must pass through via label`);
  }
});

test('shouldEnforceSubagentFooter: raw agent_type also exempts generics', () => {
  assert.equal(shouldEnforceSubagentFooter('cr', 'general-purpose', aliases), false);
  assert.equal(shouldEnforceSubagentFooter('cr', 'workflow-subagent', aliases), false);
});

test('shouldEnforceSubagentFooter: recognized specialists are enforced when aliases loaded', () => {
  for (const role of ['a', 'e', 'bug', 'dbg', 't', 'cr', 'doc', 'm']) {
    assert.equal(shouldEnforceSubagentFooter(role, role, aliases), true, `${role} should be enforced`);
  }
});

test('shouldEnforceSubagentFooter: unrecognized non-generic labels pass through when aliases loaded', () => {
  for (const label of ['agnthive-explorer', 'explorer', 'mcp-tester', 'workflow-docs']) {
    assert.equal(shouldEnforceSubagentFooter(label, label, aliases), false, `${label} should pass through`);
  }
});

test('shouldEnforceSubagentFooter: safe floor — missing alias map enforces on all non-generic', () => {
  // loadAliases swallowed an error and returned {}: specialists must still be
  // enforced (not silently passed through), and unidentified non-generic labels
  // too. Only generic types and blank labels are exempt.
  assert.equal(shouldEnforceSubagentFooter('cr', 'cr', {}), true);
  assert.equal(shouldEnforceSubagentFooter('some-other-agent', 'some-other-agent', {}), true);
  assert.equal(shouldEnforceSubagentFooter('', '', {}), false);
  assert.equal(shouldEnforceSubagentFooter(null, null, {}), false);
  assert.equal(shouldEnforceSubagentFooter('general-purpose', 'general-purpose', {}), false);
});
// --- ADR 0010 agent lifecycle registry (plan 06) ---------------------------

test('isForeignOrForkType detects forks and foreign namespaces, keeps our own', () => {
  assert.equal(isForeignOrForkType('fork'), true);
  assert.equal(isForeignOrForkType('Fork'), true);
  assert.equal(isForeignOrForkType('mcp:tester'), true);
  assert.equal(isForeignOrForkType('Other:runner'), true);
  assert.equal(isForeignOrForkType('agnthive:Explorer'), false);
  assert.equal(isForeignOrForkType('Tester'), false);
  assert.equal(isForeignOrForkType(null, 'fork'), true);
  assert.equal(isForeignOrForkType('Tester', 'cr'), false);
});

test('shouldEnforceSubagentFooter: fork and foreign types carry no footer duty (plan 06.5)', () => {
  const aliases = { cr: ['code-reviewer'], t: ['tester'] };
  assert.equal(shouldEnforceSubagentFooter('fork', 'fork', aliases, true), false);
  assert.equal(shouldEnforceSubagentFooter('fork', null, aliases, true), false);
  assert.equal(shouldEnforceSubagentFooter('mcp-tester', 'mcp:tester', aliases, true), false);
  const foreignLabel = shouldEnforceSubagentFooter('other-runner', 'Other:runner', aliases, true);
  assert.equal(foreignLabel, false);
});

test('shouldEnforceSubagentFooter: fork/foreign stay exempt even at the missing-alias floor', () => {
  assert.equal(shouldEnforceSubagentFooter('fork', 'fork', {}, false), false);
  assert.equal(shouldEnforceSubagentFooter('mcp-tester', 'mcp:tester', {}, false), false);
  assert.equal(shouldEnforceSubagentFooter('some-label', 'Other:thing', {}, false), false);
  assert.equal(shouldEnforceSubagentFooter('unknown-label', null, {}, false), true);
  assert.equal(shouldEnforceSubagentFooter('cr', 'cr', {}, false), true);
});

test('upsertAgent: first start, resume no double-count, and completion flow', () => {
  const registry = {};
  const first = upsertAgent(registry, { agentId: 'w1', role: 't', scope: 'run tests', taskId: 'task-1', status: 'running', seq: 5 });
  assert.equal(first.w1.starts, 1);
  assert.equal(first.w1.status, 'running');
  assert.equal(first.w1.provenance, 'normal');
  assert.equal(registry.w1, undefined, 'input registry never mutated');
  const resume = upsertAgent(first, { agentId: 'w1', status: 'running', seq: 6 });
  assert.equal(resume.w1.starts, 2, 'resume moves starts 1->2 without a new role bump');
  assert.equal(resume.w1.role, 't');
  assert.equal(resume.w1.scope, 'run tests');
  assert.equal(resume.w1.taskId, 'task-1');
  const done = upsertAgent(resume, { agentId: 'w1', status: 'completed', seq: 7 });
  assert.equal(done.w1.starts, 2, 'completion upserts leave starts untouched');
  assert.equal(done.w1.status, 'completed');
  assert.equal(done.w1.role, 't');
});

test('upsertAgent: _session fallback for missing ids (provenance missing-id)', () => {
  const out = upsertAgent({}, { role: 'cr', scope: 'review the patch', status: 'running', seq: 5 });
  const rec = out._session;
  assert.equal(rec.provenance, 'missing-id');
  assert.equal(rec.status, 'unknown');
  assert.equal(rec.role, 'cr');
  assert.equal(rec.starts, 0, 'missing-id records never count starts');
  const again = upsertAgent(out, { role: 't', status: 'running', seq: 6 });
  assert.equal(again._session.role, 't', 'the shared _session key holds only the latest record');
});

test('upsertAgent: null role records an unrecognized foreign agent', () => {
  const out = upsertAgent({}, { agentId: 'f1', role: null, scope: 'external fork work', status: 'completed', seq: 8 });
  const rec = out.f1;
  assert.equal(rec.role, null);
  assert.equal(rec.provenance, 'unrecognized');
  assert.equal(rec.status, 'unknown', 'null role forces status unknown');
  assert.equal(rec.starts, 0);
  assert.equal(rec.scope, 'external fork work');
});

test('startedRolesFromRegistry filters to recognized roles only', () => {
  const aliases = { cr: ['code-reviewer'], t: ['tester'], m: ['manager'] };
  const state = {
    agents: {
      w1: { role: 't', status: 'completed' },
      w2: { role: 'cr', status: 'running' },
      f1: { role: null, status: 'unknown' },
      g1: { role: 'general-purpose', status: 'completed' },
      s1: { role: 'stranger', status: 'completed' },
    },
  };
  assert.deepEqual(startedRolesFromRegistry(state, aliases), ['cr', 't']);
  assert.deepEqual(startedRolesFromRegistry(state), ['cr', 'stranger', 't']);
  assert.deepEqual(startedRolesFromRegistry({}, aliases), []);
  // A missing taskId on both sides counts as the unscoped scope: records seeded
  // without taskId aggregate under a state with no open task (assertions above).
});

test('startedRolesFromRegistry: records are task-scoped (CR MED-LOW 8)', () => {
  const aliases = { cr: ['code-reviewer'], t: ['tester'], m: ['manager'] };
  const active = startedRolesFromRegistry({
    task_id: 'task-1',
    agents: {
      live: { role: 'cr', taskId: 'task-1', status: 'running' },
      live2: { role: 't', taskId: 'task-1', status: 'completed' },
      stale: { role: 'a', taskId: 'task-0', status: 'completed' },
    },
  }, aliases);
  assert.deepEqual(active, ['cr', 't'], 'records from an earlier task id are filtered');
  const unscoped = startedRolesFromRegistry({
    agents: { w1: { role: 't', taskId: 'task-0', status: 'completed' }, w2: { role: 'cr', status: 'running' } },
  }, aliases);
  assert.deepEqual(unscoped, ['cr'], 'a no-task session only counts unscoped records');
});

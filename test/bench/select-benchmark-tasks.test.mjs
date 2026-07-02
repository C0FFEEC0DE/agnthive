// Node tests for scripts/select-benchmark-tasks.mjs (port of the Python logic test).
// Covers selectTasks branches, helpers, loaders, output helpers, and maps.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SEL_REPO = join(import.meta.dirname, '..', '..');
const SEL_SCRIPT = join(SEL_REPO, 'scripts', 'select-benchmark-tasks.mjs');

function runSelect(args, env = {}) {
  return spawnSync(process.execPath, [SEL_SCRIPT, ...args], {
    encoding: 'utf-8', env: { ...process.env, ...env },
  });
}
import {
  SUITE_DEFAULTS, PRIORITY_PROFILES, config,
  AGENT_FILE_TO_ALIAS, AGENT_NAME_TO_ALIAS, SKILL_TO_ALIAS,
  buildAgentFileMap, buildAgentNameMap, buildSkillMap,
  loadChangedFiles, loadPreviousSummary, FileNotFoundError,
  impactedAgents, impactedFixtures, changedTaskPaths,
  isGlobalBehaviorChange, taskOverlapKey, dedupeTasks,
  unresolvedPreviousTasks, selectTasks, ValueError,
  applyPriorityProfile, limitTasks, formatLabel, writeGithubOutput,
} from '../../scripts/select-benchmark-tasks.mjs';

const SUITE = 'subagents_smoke';

function task(tid, suite, opts = {}) {
  return {
    id: tid, suite, _path: opts.path || `bench/tasks/${tid}.json`,
    related_agents: opts.related_agents || [], fixture: opts.fixture || '',
    overlap_key: opts.overlap_key,
  };
}

// ---- isGlobalBehaviorChange ----

test('isGlobalBehaviorChange global file', () => {
  assert.equal(isGlobalBehaviorChange(['CLAUDE.md']), true);
});
test('isGlobalBehaviorChange global prefix', () => {
  assert.equal(isGlobalBehaviorChange(['plugins/agent-hive/modules/hook-dispatcher.mjs']), true);
});
test('isGlobalBehaviorChange unrelated', () => {
  assert.equal(isGlobalBehaviorChange(['docs/readme.md']), false);
});
test('isGlobalBehaviorChange empty', () => {
  assert.equal(isGlobalBehaviorChange([]), false);
});

// ---- impactedFixtures ----

test('impactedFixtures matches fixture dir', () => {
  assert.deepEqual([...impactedFixtures(['bench/fixtures/text-report/x.py', 'docs/a.md'])], ['text-report']);
});
test('impactedFixtures no match', () => {
  assert.deepEqual([...impactedFixtures(['src/app.py'])], []);
});

// ---- impactedAgents ----

test('impactedAgents resolves and skips unknown', () => {
  AGENT_FILE_TO_ALIAS['known_agent.md'] = 'k';
  SKILL_TO_ALIAS['known_skill'] = 's';
  const aliases = impactedAgents([
    'plugins/agent-hive/agents/known_agent.md',
    'plugins/agent-hive/agents/unknown_agent.md',
    'plugins/agent-hive/skills/known_skill/SKILL.md',
    'plugins/agent-hive/skills/unknown_skill/SKILL.md',
    'docs/unrelated.md',
  ]);
  assert.deepEqual([...aliases], ['k', 's']);
  delete AGENT_FILE_TO_ALIAS['known_agent.md'];
  delete SKILL_TO_ALIAS['known_skill'];
});

// ---- taskOverlapKey ----

test('taskOverlapKey valid', () => {
  assert.equal(taskOverlapKey({ overlap_key: '  k  ' }), 'k');
});
test('taskOverlapKey missing', () => {
  assert.equal(taskOverlapKey({}), null);
  assert.equal(taskOverlapKey({ overlap_key: '   ' }), null);
});

// ---- loadChangedFiles ----

test('loadChangedFiles none', () => assert.deepEqual(loadChangedFiles(null), []));
test('loadChangedFiles missing', () => assert.deepEqual(loadChangedFiles(join(tmpdir(), 'nope-' + Date.now() + '.txt')), []));
test('loadChangedFiles reads', () => {
  const d = mkdtempSync(join(tmpdir(), 'sel-'));
  const p = join(d, 'c.txt');
  writeFileSync(p, 'a.py\n\n  b.py  \n');
  assert.deepEqual(loadChangedFiles(p), ['a.py', 'b.py']);
});

// ---- loadPreviousSummary ----

test('loadPreviousSummary none', () => assert.equal(loadPreviousSummary(null), null));
test('loadPreviousSummary missing raises', () => {
  assert.throws(() => loadPreviousSummary(join(tmpdir(), 'nope-' + Date.now() + '.json')), FileNotFoundError);
});
test('loadPreviousSummary reads', () => {
  const d = mkdtempSync(join(tmpdir(), 'sel-'));
  const p = join(d, 's.json');
  writeFileSync(p, JSON.stringify({ unresolved_task_ids: ['t1'] }));
  assert.deepEqual(loadPreviousSummary(p), { unresolved_task_ids: ['t1'] });
});

// ---- selectTasks ----

test('selectTasks all mode', () => {
  const tasks = [task('t1', SUITE), task('t2', SUITE), task('t3', 'other')];
  const [sel, reasons] = selectTasks(tasks, SUITE, [], 'all');
  assert.deepEqual(sel.map((t) => t.id), ['t1', 't2']);
  assert.ok(reasons.includes('manual_all'));
});

test('selectTasks global behavior selects all', () => {
  const tasks = [task('t1', SUITE), task('t2', SUITE)];
  const [sel, reasons] = selectTasks(tasks, SUITE, ['CLAUDE.md'], 'changed');
  assert.deepEqual(sel.map((t) => t.id), ['t1', 't2']);
  assert.ok(reasons.includes('global_behavior_change'));
});

test('selectTasks task path hit', () => {
  const tasks = [task('t1', SUITE, { path: 'bench/tasks/t1.json' }), task('t2', SUITE, { path: 'bench/tasks/t2.json' })];
  const [sel, reasons] = selectTasks(tasks, SUITE, ['bench/tasks/t2.json'], 'changed');
  assert.deepEqual(sel.map((t) => t.id), ['t2']);
  assert.ok(reasons.includes('task_file_change'));
});

test('selectTasks fixture hit', () => {
  const tasks = [task('t1', SUITE, { fixture: 'text-report' }), task('t2', SUITE, { fixture: 'other' })];
  const [sel, reasons] = selectTasks(tasks, SUITE, ['bench/fixtures/text-report/x.py'], 'changed');
  assert.deepEqual(sel.map((t) => t.id), ['t1']);
  assert.ok(reasons.includes('fixture_change'));
});

test('selectTasks agent hit', () => {
  SKILL_TO_ALIAS['test'] = 't';
  try {
    const tasks = [task('t1', SUITE, { related_agents: ['t'] }), task('t2', SUITE, { related_agents: ['cr'] })];
    const [sel, reasons] = selectTasks(tasks, SUITE, ['plugins/agent-hive/skills/test/SKILL.md'], 'changed');
    assert.deepEqual(sel.map((t) => t.id), ['t1']);
    assert.ok(reasons.includes('agent_or_skill_change'));
  } finally { delete SKILL_TO_ALIAS['test']; }
});

test('selectTasks overlap exclusion', () => {
  const otherSuite = 'other_suite';
  SUITE_DEFAULTS[otherSuite] = 'bench/tasks/other/*.json';
  try {
    const shared = 'shared-behavior';
    const thisTasks = [task('t1', SUITE, { overlap_key: shared }), task('t2', SUITE, { overlap_key: null })];
    const other = [task('o1', otherSuite, { overlap_key: shared })];
    const [sel, reasons] = selectTasks(thisTasks.concat(other), SUITE, ['CLAUDE.md'], 'changed', { excludeOverlapWithSuites: [otherSuite] });
    assert.deepEqual(sel.map((t) => t.id), ['t2']);
    assert.ok(reasons.includes('overlap_excluded:other_suite'));
  } finally { delete SUITE_DEFAULTS[otherSuite]; }
});

test('selectTasks overlap exclusion skips self suite', () => {
  const tasks = [task('t1', SUITE, { overlap_key: 'k' })];
  const [sel, reasons] = selectTasks(tasks, SUITE, ['CLAUDE.md'], 'changed', { excludeOverlapWithSuites: [SUITE] });
  assert.deepEqual(sel.map((t) => t.id), ['t1']);
  assert.ok(!reasons.some((r) => r.startsWith('overlap_excluded')));
});

test('selectTasks no changes selects nothing', () => {
  const tasks = [task('t1', SUITE)];
  const [sel, reasons] = selectTasks(tasks, SUITE, ['docs/unrelated.md'], 'changed');
  assert.deepEqual(sel, []);
  assert.deepEqual(reasons, []);
});

test('selectTasks resume requires previous summary', () => {
  const tasks = [task('t1', SUITE)];
  assert.throws(() => selectTasks(tasks, SUITE, [], 'resume', { previousSummary: null }), ValueError);
});

test('selectTasks resume selects unresolved', () => {
  const tasks = [task('t1', SUITE, { path: 'bench/tasks/t1.json' }), task('t2', SUITE, { path: 'bench/tasks/t2.json' })];
  const [sel, reasons] = selectTasks(tasks, SUITE, [], 'resume', { previousSummary: { unresolved_task_ids: ['t2'] } });
  assert.deepEqual(sel.map((t) => t.id), ['t2']);
  assert.ok(reasons.includes('resume_previous_unresolved'));
});

test('selectTasks resume no resolvable selects nothing', () => {
  const tasks = [task('t1', SUITE, { path: 'bench/tasks/t1.json' })];
  const [sel, reasons] = selectTasks(tasks, SUITE, [], 'resume', { previousSummary: { unresolved_task_ids: ['ghost'] } });
  assert.deepEqual(sel, []);
  assert.ok(!reasons.includes('resume_previous_unresolved'));
});

// ---- unresolvedPreviousTasks ----

test('unresolvedPreviousTasks explicit ids and paths', () => {
  const suiteTasks = [task('t1', SUITE, { path: 'bench/tasks/t1.json' }), task('t2', SUITE, { path: 'bench/tasks/t2.json' })];
  const prev = { unresolved_task_ids: ['t1'], unresolved_task_paths: ['bench/tasks/t2.json'] };
  assert.deepEqual(new Set(unresolvedPreviousTasks(prev, suiteTasks).map((t) => t.id)), new Set(['t1', 't2']));
});

test('unresolvedPreviousTasks fallback to tasks status', () => {
  const suiteTasks = [task('t1', SUITE, { path: 'bench/tasks/t1.json' }), task('t2', SUITE, { path: 'bench/tasks/t2.json' })];
  const prev = { tasks: [{ task_id: 't1', status: 'failed', task_path: 'bench/tasks/t1.json' }, { task_id: 't2', status: 'passed', task_path: 'bench/tasks/t2.json' }] };
  assert.deepEqual(unresolvedPreviousTasks(prev, suiteTasks).map((t) => t.id), ['t1']);
});

test('unresolvedPreviousTasks no previous returns empty', () => {
  assert.deepEqual(unresolvedPreviousTasks(null, [task('t1', SUITE)]), []);
});

// ---- limitTasks / applyPriorityProfile ----

test('limitTasks none', () => {
  const tasks = [task('t1', SUITE), task('t2', SUITE)];
  assert.deepEqual(limitTasks(tasks, null, []), tasks);
});
test('limitTasks truncates', () => {
  const tasks = [task('t1', SUITE), task('t2', SUITE), task('t3', SUITE)];
  const reasons = [];
  const out = limitTasks(tasks, 2, reasons);
  assert.deepEqual(out.map((t) => t.id), ['t1', 't2']);
  assert.ok(reasons.includes('task_limit:2'));
});
test('applyPriorityProfile no profile', () => {
  const tasks = [task('t1', SUITE), task('t2', SUITE)];
  assert.deepEqual(applyPriorityProfile(tasks, null), tasks);
});
test('applyPriorityProfile orders by profile', () => {
  PRIORITY_PROFILES['p'] = ['t2', 't1'];
  try {
    const tasks = [task('t1', SUITE), task('t2', SUITE), task('t3', SUITE)];
    assert.deepEqual(applyPriorityProfile(tasks, 'p').map((t) => t.id), ['t2', 't1', 't3']);
  } finally { delete PRIORITY_PROFILES['p']; }
});

// ---- formatLabel ----

test('formatLabel empty', () => assert.equal(formatLabel([], SUITE), ''));
test('formatLabel small set', () => {
  assert.equal(formatLabel([task('t1', SUITE), task('t2', SUITE)], SUITE), 't1, t2');
});
test('formatLabel large set', () => {
  const tasks = Array.from({ length: 6 }, (_, i) => task(`t${i}`, SUITE));
  assert.match(formatLabel(tasks, SUITE), /\+2 more$/);
});

// ---- writeGithubOutput ----

test('writeGithubOutput file with tasks', () => {
  const d = mkdtempSync(join(tmpdir(), 'sel-'));
  const outFile = join(d, 'gh.txt');
  const orig = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = outFile;
  try {
    writeGithubOutput([task('t1', SUITE, { path: 'bench/tasks/t1.json' })], ['task_file_change'], SUITE);
    const text = readFileSync(outFile, 'utf-8');
    assert.match(text, /should_run=true/);
    assert.match(text, /task_files<<__TASKS__/);
    assert.match(text, /bench\/tasks\/t1\.json/);
    assert.match(text, /__TASKS__/);
  } finally { if (orig === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = orig; }
});

test('writeGithubOutput file empty tasks', () => {
  const d = mkdtempSync(join(tmpdir(), 'sel-'));
  const outFile = join(d, 'gh.txt');
  const orig = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = outFile;
  try {
    writeGithubOutput([], ['no_matching_changes'], SUITE);
    const text = readFileSync(outFile, 'utf-8');
    assert.match(text, /should_run=false/);
    assert.match(text, /task_files<<__TASKS__\n__TASKS__/);
  } finally { if (orig === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = orig; }
});

// ---- build_*_map ----

test('buildAgentFileMap skips no alias', () => {
  const d = mkdtempSync(join(tmpdir(), 'sel-'));
  const agentsDir = join(d, 'plugins', 'agent-hive', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'noalias.md'), '---\nname: NoAlias\n---\nbody');
  writeFileSync(join(agentsDir, 'has.md'), '---\nname: Has\nalias: h\n---\nbody');
  const orig = config.repoRoot;
  config.repoRoot = d;
  try { assert.deepEqual(buildAgentFileMap(), { 'has.md': 'h' }); }
  finally { config.repoRoot = orig; }
});

test('buildSkillMap skips unmapped agent', () => {
  const d = mkdtempSync(join(tmpdir(), 'sel-'));
  const skillsDir = join(d, 'plugins', 'agent-hive', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  // Plugin skills are nested: skills/<name>/SKILL.md.
  for (const [name, body] of [['noagent', '---\n---\nbody'], ['unknown', '---\nagent: Ghost\n---\nbody'], ['known', '---\nagent: Tester\n---\nbody']]) {
    mkdirSync(join(skillsDir, name), { recursive: true });
    writeFileSync(join(skillsDir, name, 'SKILL.md'), body);
  }
  const origRoot = config.repoRoot;
  config.repoRoot = d;
  AGENT_NAME_TO_ALIAS['tester'] = 't';
  try { assert.deepEqual(buildSkillMap(), { 'known': 't' }); }
  finally { config.repoRoot = origRoot; delete AGENT_NAME_TO_ALIAS['tester']; }
});

// --- CLI arg validation (parity with legacy argparse choices + exit codes) ---

test('main: missing --suite exits 2', () => {
  const r = runSelect([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--suite is required/);
});

test('main: invalid --suite exits 2', () => {
  const r = runSelect(['--suite', 'nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--suite is required/);
});

test('main: invalid --selection-mode exits 2', () => {
  const r = runSelect(['--suite', 'subagents_smoke', '--selection-mode', 'resum']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--selection-mode must be one of/);
});

test('main: --max-tasks with missing value exits 2', () => {
  const r = runSelect(['--suite', 'subagents_smoke', '--max-tasks']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--max-tasks requires an argument/);
});

test('main: --max-tasks non-integer exits 2', () => {
  const r = runSelect(['--suite', 'subagents_smoke', '--max-tasks', 'abc']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--max-tasks requires a positive integer/);
});

test('main: --priority-profile unknown exits 2', () => {
  const r = runSelect(['--suite', 'subagents_smoke', '--priority-profile', 'ghost']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--priority-profile must be one of/);
});

test('main: valid --selection-mode all produces selection', () => {
  const r = runSelect(['--suite', 'subagents_smoke', '--selection-mode', 'all'], { GITHUB_OUTPUT: '' });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.should_run, true);
  assert.equal(out.selection_reason, 'manual_all');
});
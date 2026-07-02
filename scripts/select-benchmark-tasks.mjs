#!/usr/bin/env node
// select-benchmark-tasks: choose which benchmark tasks to run based on changed
// files, selection mode, and an optional previous summary. Emits GitHub Actions
// output (or stdout JSON when GITHUB_OUTPUT is unset).
// Node port of scripts/select-benchmark-tasks.py — no Python.
import { readdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, normalizeStringList, frontmatterField } from './bench/lib.mjs';

export const SUITE_DEFAULTS = { subagents_smoke: 'bench/tasks/subagents/smoke/*.json' };
export const PRIORITY_PROFILES = {};

// The legacy claudecfg/ profile was removed when the repo migrated to the
// distributable plugin; a change to the plugin runtime core (modules, hooks
// manifest, plugin manifest, or bundled alias map) is a global behavior change
// that should re-run the whole behavior smoke suite.
export const GLOBAL_BEHAVIOR_PREFIXES = [
  'plugins/agent-hive/modules/',
  'plugins/agent-hive/hooks/hooks.json',
  'plugins/agent-hive/.claude-plugin/plugin.json',
  'plugins/agent-hive/assets/aliases.json',
  'plugins/agent-hive/package.json',
  'scripts/assert-benchmark-summary.mjs',
  'scripts/bench/lib.mjs',
  'scripts/bench_runner_claude_code.mjs',
  'scripts/bench_runner_openrouter.mjs',
  'scripts/build-benchmark-matrix.mjs',
  'scripts/collect-benchmark-changes.mjs',
  'scripts/compare-benchmarks.mjs',
  'scripts/download-benchmark-summary.mjs',
  'scripts/find-failed-benchmark-run.mjs',
  'scripts/merge-benchmark-summaries.mjs',
  'scripts/mock-benchmark-runner.mjs',
  'scripts/render-benchmark-report.mjs',
  'scripts/render-benchmark-summary.mjs',
  'scripts/rerun-failed-benchmark.mjs',
  'scripts/run-benchmark.mjs',
  'scripts/select-benchmark-tasks.mjs',
  'scripts/wait-for-benchmark-slot.mjs',
];

export const GLOBAL_BEHAVIOR_FILES = new Set([
  'CLAUDE.md',
  '.github/workflows/behavior-benchmark-subagents-smoke.yml',
]);

export const config = {
  repoRoot: join(fileURLToPath(import.meta.url), '..', '..'),
};

export const AGENT_FILE_TO_ALIAS = {};
export const AGENT_NAME_TO_ALIAS = {};
export const SKILL_TO_ALIAS = {};

export function tasksRoot() { return join(config.repoRoot, 'bench', 'tasks'); }

// The agent/skill source-of-truth moved from claudecfg/ to the bundled plugin.
// Plugin agents are flat: plugins/agent-hive/agents/<name>.md.
// Plugin skills are nested: plugins/agent-hive/skills/<skill>/SKILL.md.
function pluginAgentsDir() { return join(config.repoRoot, 'plugins', 'agent-hive', 'agents'); }
function pluginSkillsDir() { return join(config.repoRoot, 'plugins', 'agent-hive', 'skills'); }

export function buildAgentFileMap() {
  const mapping = {};
  const dir = pluginAgentsDir();
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return mapping; }
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    const alias = frontmatterField(join(dir, ent.name), 'alias');
    if (alias) mapping[ent.name] = alias;
  }
  return mapping;
}

export function buildAgentNameMap() {
  const mapping = {};
  const dir = pluginAgentsDir();
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return mapping; }
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    const alias = frontmatterField(join(dir, ent.name), 'alias');
    const name = frontmatterField(join(dir, ent.name), 'name');
    if (alias) mapping[alias.toLowerCase()] = alias;
    if (alias && name) mapping[name.toLowerCase()] = alias;
  }
  return mapping;
}

export function buildSkillMap() {
  // Plugin skills are nested: skills/<skill>/SKILL.md. The map is keyed by the
  // skill directory name (e.g. "review") so impactedAgents can look up a changed
  // .../skills/<skill>/SKILL.md by its parent directory.
  const mapping = {};
  const dir = pluginSkillsDir();
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return mapping; }
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isDirectory()) continue;
    const agent = frontmatterField(join(dir, ent.name, 'SKILL.md'), 'agent');
    const alias = agent ? AGENT_NAME_TO_ALIAS[agent.toLowerCase()] : undefined;
    if (alias) mapping[ent.name] = alias;
  }
  return mapping;
}

function refreshMaps() {
  Object.keys(AGENT_FILE_TO_ALIAS).forEach((k) => delete AGENT_FILE_TO_ALIAS[k]);
  Object.assign(AGENT_FILE_TO_ALIAS, buildAgentFileMap());
  Object.keys(AGENT_NAME_TO_ALIAS).forEach((k) => delete AGENT_NAME_TO_ALIAS[k]);
  Object.assign(AGENT_NAME_TO_ALIAS, buildAgentNameMap());
  Object.keys(SKILL_TO_ALIAS).forEach((k) => delete SKILL_TO_ALIAS[k]);
  Object.assign(SKILL_TO_ALIAS, buildSkillMap());
}
refreshMaps();

export function iterTasks() {
  const root = tasksRoot();
  const out = [];
  function walk(dir) {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith('.json')) {
        const payload = JSON.parse(readFileSync(p, 'utf-8'));
        payload._path = relative(config.repoRoot, p).split(/[\\/]/).join('/');
        out.push(payload);
      }
    }
  }
  walk(root);
  out.sort((a, b) => a._path < b._path ? -1 : a._path > b._path ? 1 : 0);
  return out;
}

export function loadChangedFiles(path) {
  if (!path) return [];
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  return raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

export function loadPreviousSummary(path) {
  if (!path) return null;
  if (!existsSync(path)) throw new FileNotFoundError(`Previous summary file does not exist: ${path}`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

class FileNotFoundError extends Error {
  constructor(msg) { super(msg); this.name = 'FileNotFoundError'; }
}
export { FileNotFoundError };

export function impactedAgents(changedFiles) {
  const aliases = new Set();
  const AGENTS_PREFIX = 'plugins/agent-hive/agents/';
  const SKILLS_PREFIX = 'plugins/agent-hive/skills/';
  for (const changed of changedFiles) {
    const parts = changed.split(/[\\/]/);
    const name = parts[parts.length - 1];
    if (changed.startsWith(AGENTS_PREFIX)) {
      const alias = AGENT_FILE_TO_ALIAS[name];
      if (alias) aliases.add(alias);
    }
    if (changed.startsWith(SKILLS_PREFIX)) {
      // Nested skill layout: .../skills/<skill>/SKILL.md -> key by <skill>.
      const skillsIdx = parts.indexOf('skills');
      const skillName = skillsIdx >= 0 ? parts[skillsIdx + 1] : undefined;
      const alias = skillName ? SKILL_TO_ALIAS[skillName] : undefined;
      if (alias) aliases.add(alias);
    }
  }
  return aliases;
}

export function impactedFixtures(changedFiles) {
  const fixtures = new Set();
  for (const changed of changedFiles) {
    const parts = changed.split(/[\\/]/);
    if (parts.length >= 3 && parts[0] === 'bench' && parts[1] === 'fixtures') {
      fixtures.add(parts[2]);
    }
  }
  return fixtures;
}

export function changedTaskPaths(changedFiles) {
  return new Set(changedFiles.filter((c) => c.startsWith('bench/tasks/')));
}

export function isGlobalBehaviorChange(changedFiles) {
  for (const changed of changedFiles) {
    if (GLOBAL_BEHAVIOR_FILES.has(changed)) return true;
    if (GLOBAL_BEHAVIOR_PREFIXES.some((p) => changed.startsWith(p))) return true;
  }
  return false;
}

export function taskOverlapKey(task) {
  const key = task.overlap_key;
  if (typeof key === 'string' && key.trim()) return key.trim();
  return null;
}

export function dedupeTasks(tasks) {
  const seen = new Set();
  const out = [];
  for (const t of tasks) {
    const p = String(t._path);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(t);
  }
  return out;
}

export function unresolvedPreviousTasks(previousSummary, suiteTasks) {
  if (!previousSummary) return [];
  const tasksById = new Map(suiteTasks.map((t) => [String(t.id), t]));
  const tasksByPath = new Map(suiteTasks.map((t) => [String(t._path), t]));
  const selected = [];

  let unresolvedIds = normalizeStringList(previousSummary.unresolved_task_ids);
  let unresolvedPaths = normalizeStringList(previousSummary.unresolved_task_paths);
  if (!unresolvedIds.length && !unresolvedPaths.length) {
    unresolvedIds = (previousSummary.tasks || [])
      .filter((t) => String(t.status) !== 'passed' && typeof t.task_id === 'string' && String(t.task_id).trim())
      .map((t) => String(t.task_id).trim());
    unresolvedPaths = (previousSummary.tasks || [])
      .filter((t) => String(t.status) !== 'passed')
      .map((t) => t.task_path || t._path)
      .filter((p) => typeof p === 'string' && p.trim());
  }

  for (const id of unresolvedIds) {
    const t = tasksById.get(id);
    if (t) selected.push(t);
  }
  for (const p of unresolvedPaths) {
    const t = tasksByPath.get(p);
    if (t) selected.push(t);
  }
  for (const t of (previousSummary.tasks || [])) {
    if (String(t.status) === 'passed') continue;
    const id = t.task_id;
    const p = t.task_path || t._path;
    if (typeof id === 'string' && tasksById.has(id)) { selected.push(tasksById.get(id)); continue; }
    if (typeof p === 'string' && tasksByPath.has(p)) { selected.push(tasksByPath.get(p)); }
  }
  return dedupeTasks(selected);
}

export function selectTasks(tasks, suite, changedFiles, selectionMode, opts = {}) {
  const previousSummary = opts.previousSummary ?? null;
  const excludeOverlap = opts.excludeOverlapWithSuites ?? [];
  const suiteTasks = tasks.filter((t) => t.suite === suite);
  const reasons = [];
  let selected;

  if (selectionMode === 'all') {
    reasons.push('manual_all');
    selected = [...suiteTasks];
  } else {
    const taskPathHits = changedTaskPaths(changedFiles);
    const fixtures = impactedFixtures(changedFiles);
    const agents = impactedAgents(changedFiles);
    const globalBehavior = isGlobalBehaviorChange(changedFiles);

    selected = [];
    if (globalBehavior) {
      reasons.push('global_behavior_change');
      selected = [...suiteTasks];
    } else {
      if (selectionMode === 'resume') {
        if (previousSummary === null) throw new ValueError('previous summary is required when selection_mode=resume');
        const resumed = unresolvedPreviousTasks(previousSummary, suiteTasks);
        if (resumed.length) {
          reasons.push('resume_previous_unresolved');
          selected.push(...resumed);
        }
      }
      for (const task of suiteTasks) {
        const taskPath = String(task._path);
        const relatedAgents = new Set(task.related_agents || []);
        const fixture = String(task.fixture || '');
        if (taskPathHits.has(taskPath)) { selected.push(task); continue; }
        if (fixture && fixtures.has(fixture)) { selected.push(task); continue; }
        if (agents.size && setIntersection(relatedAgents, agents).size) { selected.push(task); continue; }
      }
    }
    if (taskPathHits.size) reasons.push('task_file_change');
    if (fixtures.size) reasons.push('fixture_change');
    if (agents.size) reasons.push('agent_or_skill_change');
  }

  selected = dedupeTasks(selected);

  for (const excludedSuite of excludeOverlap) {
    if (excludedSuite === suite || !selected.length) continue;
    const [overlapping] = selectTasks(tasks, excludedSuite, changedFiles, selectionMode, { excludeOverlapWithSuites: [] });
    const overlapKeys = new Set(overlapping.map(taskOverlapKey).filter(Boolean));
    if (!overlapKeys.size) continue;
    const filtered = selected.filter((t) => !overlapKeys.has(taskOverlapKey(t)));
    if (filtered.length !== selected.length) {
      selected = filtered;
      reasons.push(`overlap_excluded:${excludedSuite}`);
    }
  }
  return [selected, reasons];
}

class ValueError extends Error { constructor(m) { super(m); this.name = 'ValueError'; } }
export { ValueError };

function setIntersection(a, b) {
  const out = new Set();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

export function applyPriorityProfile(selected, profile) {
  if (!profile) return selected;
  const order = PRIORITY_PROFILES[profile];
  const index = new Map(order.map((id, i) => [id, i]));
  return [...selected].sort((a, b) => {
    const ia = index.get(String(a.id)) ?? order.length;
    const ib = index.get(String(b.id)) ?? order.length;
    if (ia !== ib) return ia - ib;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
}

export function limitTasks(selected, maxTasks, reasons) {
  if (maxTasks === null || maxTasks === undefined || maxTasks <= 0 || selected.length <= maxTasks) return selected;
  reasons.push(`task_limit:${maxTasks}`);
  return selected.slice(0, maxTasks);
}

export function formatLabel(selected, suite) {
  if (!selected.length) return '';
  const suiteCount = iterTasks().filter((t) => t.suite === suite).length;
  if (selected.length === suiteCount) return SUITE_DEFAULTS[suite];
  const ids = selected.map((t) => String(t.id));
  if (ids.length <= 4) return ids.join(', ');
  return ids.slice(0, 4).join(', ') + `, +${ids.length - 4} more`;
}

export function writeGithubOutput(selected, reasons, suite) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    process.stdout.write(JSON.stringify({
      suite,
      should_run: selected.length > 0,
      task_files: selected.map((t) => t._path),
      task_ids: selected.map((t) => t.id),
      selection_reason: reasons.length ? reasons.join(',') : 'no_matching_changes',
    }, null, 2) + '\n');
    return;
  }
  const suiteCount = iterTasks().filter((t) => t.suite === suite).length;
  const label = selected.length && selected.length === suiteCount ? SUITE_DEFAULTS[suite] : formatLabel(selected, suite);
  const taskLines = selected.map((t) => String(t._path)).join('\n');
  const taskIds = selected.map((t) => String(t.id)).join(',');
  const reason = reasons.length ? reasons.join(',') : 'no_matching_changes';
  let body = '';
  body += `should_run=${selected.length > 0 ? 'true' : 'false'}\n`;
  body += `selection_reason=${reason}\n`;
  body += `task_count=${selected.length}\n`;
  body += `task_label=${label}\n`;
  body += `task_ids=${taskIds}\n`;
  body += 'task_files<<__TASKS__\n';
  if (taskLines) body += taskLines + '\n';
  body += '__TASKS__\n';
  appendFileSync(outputPath, body, 'utf-8');
}

const SELECTION_MODES = ['all', 'changed', 'resume'];

function failArg(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

function requireValue(flag, value) {
  if (value === undefined) failArg(`--${flag} requires an argument`);
  return value;
}

function parseArgs(argv) {
  const out = { suite: null, changedFilesFile: null, previousSummaryFile: null, selectionMode: 'changed', excludeOverlap: [], priorityProfile: null, maxTasks: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--suite') out.suite = requireValue('suite', argv[++i]);
    else if (a === '--changed-files-file') out.changedFilesFile = requireValue('changed-files-file', argv[++i]);
    else if (a === '--previous-summary-file') out.previousSummaryFile = requireValue('previous-summary-file', argv[++i]);
    else if (a === '--selection-mode') out.selectionMode = requireValue('selection-mode', argv[++i]);
    else if (a === '--exclude-overlap-with-suite') out.excludeOverlap.push(requireValue('exclude-overlap-with-suite', argv[++i]));
    else if (a === '--priority-profile') out.priorityProfile = requireValue('priority-profile', argv[++i]);
    else if (a === '--max-tasks') {
      const v = requireValue('max-tasks', argv[++i]);
      const n = Number.parseInt(v, 10);
      if (!Number.isInteger(n)) failArg(`--max-tasks requires a positive integer (got: ${v})`);
      out.maxTasks = n;
    }
    else { process.stderr.write(`unknown argument: ${a}\n`); process.exit(2); }
  }
  if (!out.suite || !SUITE_DEFAULTS[out.suite]) failArg(`--suite is required (one of: ${Object.keys(SUITE_DEFAULTS).join(', ')})`);
  if (!SELECTION_MODES.includes(out.selectionMode)) failArg(`--selection-mode must be one of: ${SELECTION_MODES.join(', ')} (got: ${out.selectionMode})`);
  const suiteKeys = Object.keys(SUITE_DEFAULTS);
  for (const s of out.excludeOverlap) if (!suiteKeys.includes(s)) failArg(`--exclude-overlap-with-suite must be one of: ${suiteKeys.join(', ')} (got: ${s})`);
  const profileKeys = Object.keys(PRIORITY_PROFILES);
  if (out.priorityProfile !== null && !profileKeys.includes(out.priorityProfile)) failArg(`--priority-profile must be one of: ${profileKeys.join(', ') || '(none defined)'} (got: ${out.priorityProfile})`);
  return out;
}

export function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = iterTasks();
  const changedFiles = loadChangedFiles(args.changedFilesFile);
  const previousSummary = loadPreviousSummary(args.previousSummaryFile);
  let [selected, reasons] = selectTasks(tasks, args.suite, changedFiles, args.selectionMode, {
    previousSummary,
    excludeOverlapWithSuites: args.excludeOverlap,
  });
  selected = applyPriorityProfile(selected, args.priorityProfile);
  selected = limitTasks(selected, args.maxTasks, reasons);
  writeGithubOutput(selected, reasons, args.suite);
}

if (isMain(import.meta.url)) {
  main();
}
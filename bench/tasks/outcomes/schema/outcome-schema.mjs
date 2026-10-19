// Outcome benchmark suite contract (ADR-0012, plan task 10).
//
// Node stdlib only, ESM. Single source of truth for two contracts:
//   1. the outcome task shape under bench/tasks/outcomes/tasks/ (fields,
//      arms, budget classes, coverage tags, predicate vocabulary, mock
//      evaluation)
//  2. the per-arm metrics document the suite emitter writes for the rollout
//      gate (plan tasks 11/15)
//
// Layering: the suite DECLARES (tasks, arms, declarations) and the benchmark
// runner (plan task 09) EXECUTES arms, reps, scenarios and live predicates;
// the suite emitter aggregates metrics; the rollout gate (plan tasks 11/15)
// decides. No runner logic is duplicated here.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUITE_ID = 'outcomes';
export const SCHEMA_KIND_TASK = 'outcome-task-v1';
export const METRICS_SCHEMA_KIND = 'outcome-metrics';
export const METRICS_SCHEMA_VERSION = '1.0';
export const EMITTER_VERSION = '1.0';

// Arm matrix (ADR-0012): at most three comparable arms. The suite declares the
// arms and the rep floor per arm; the runner config owns the actual per-arm
// rep count for live runs (>= MIN_LIVE_REPS for gate-eligible runs).
export const SUITE_ARMS = Object.freeze(['native', 'legacy', 'lean']);
export const ABLATION_AXES = Object.freeze(['orchestrator']);
export const ABLATION_VARIANTS = Object.freeze(['manager', 'root']);

// ADR-0012: "aim for at least three paired repetitions per task/arm; smaller
// runs are exploratory". Live gate-eligible runs must execute at least
// MIN_LIVE_REPS reps of every task per arm. Mock runs have no variance signal
// and always report one record per task.
export const MIN_LIVE_REPS = 3;

// Suggested per-task caps the runner config may override (suite declares
// budget; runner caps it).
export const BUDGET_CLASSES = Object.freeze({
  small: { max_turns: 12, timeout_seconds: 240, note: 'single-file change, one verification cycle' },
  medium: { max_turns: 24, timeout_seconds: 400, note: 'multi-step work, seeded assets or lifecycle scenario' },
  large: { max_turns: 40, timeout_seconds:  800, note: 'open synthesis over several seeded modules' },
});

// Plan task 10 coverage list: each tag must appear on exactly one task.
export const COVERAGE_TAGS_REQUIRED = Object.freeze([
  'minor-code-change',
  'nontrivial-bug',
  'security-review',
  'cross-file-refactor',
  'docs-only',
  'unfamiliar-subsystem',
  'two-independent-subtasks',
  'compact-resume',
  'background-verification',
]);
// Categories restricted to the taxonomy the existing runner/tooling already
// understands (mock runtime seconds, CI file mapping).
export const TASK_CATEGORIES = Object.freeze(['feature', 'bugfix', 'refactor', 'docs', 'review', 'support']);

// Lifecycle scenarios; the runner must support the listed types.
export const SCENARIO_TYPES = Object.freeze(['parallel_subtasks', 'compact_resume', 'background_verify']);

// ---------- predicate vocabulary ----------
// `evaluate_in: "mock"` predicates check the TASK/FIXTURE CONTRACT only
// (initial state as declared). They run offline with no model spend: at PR
// time in the suite validator, and in every mock-mode run via the suite
// emitter. `evaluate_in: "live"` predicates assert the run's END-STATE; only
// the runner evaluates them, and only in live runs. In mock mode every live
// predicate is `unverified` — never passed (ADR-0012: mock verifies plumbing;
// live verifies quality).
export const MOCK_PREDICATE_KINDS = Object.freeze(['initial_file_matches']);

export const LIVE_PREDICATE_KINDS = Object.freeze([
  'file_exists',
  'file_unchanged',
  'file_matches',
  'file_not_matches',
  'commands_pass',
  'changed_paths_within',
  'findings_cover',
  'evidence_flag',
]);

// Structured state flags a live run may assert through `evidence_flag`
// predicates. Vocabulary mirrors the plugin's ADR-0009 evidence model
// (plugins/agnthive/modules/state.mjs, DEFAULT_STATE). The runner resolves a
// dotted field against the per-run structured evidence index (plan task 09):
//   verification[] records: {id, kind, command, toolUseId, status
//     (pending|passed|failed|unknown), startedRevision, completedRevision, ...}
//   review_results[] shapes: {id, agentId, role, taskId,
//     status (completed|unknown), revision, source, finishedAt}
// `verification.latest` = last record; `verification.current` = the record
// current with the final change revision (completedRevision == revision).
// An unknown evidence field must evaluate as predicate FAILURE, never
// silently unverified — silently skipped evidence flags would let a runner
// dodge the gate.
export const EVIDENCE_FIELD_VOCABULARY = Object.freeze([
  'verification.latest.status',
  'verification.latest.completedRevision',
  'verification.current',
  'review_results.latest.status',
  'docs_status',
  'revision',
  'workflow_profile',
  'restored_task_seq',
]);

// Outcome tasks must not require roles, footer markers, role quotas, footer
// markers, or the dispatch-contract marker (plan task 10). Enforced on every
// prompt by validateOutcomeTask.
const FORBIDDEN_PROMPT_MARKERS = Object.freeze([
  'Verification status:',
  'Review outcome:',
  'Changed files:',
  'No files changed:',
  'Remaining risks:',
  'Next step:',
  'Outcome:',
  'Handoff evidence:',
  'BENCHMARK_DISPATCH_CONTRACT',
]);
const PROMPT_ROLE_ALIAS_RE = /@(?:m|e|a|bug|dbg|t|cr|doc)\b/;

const ID_RE = /^outcome-[a-z0-9-]+$/;
const PREDICATE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_PATH_RE = /(^|[\\/])\.\.([\\/]|$)|^~|^[a-zA-Z]:[\\/]/;
const SAFE_COMMAND_CHARS = /^[A-Za-z0-9_./:@%+=,-]+( [A-Za-z0-9_./:@%+=,-]+)*$/;

function err(list, message) {
  list.push(message);
}

// ---------- outcome task validation ----------
/**
 * Validate one outcome task document.
 * @param {object} task parsed task JSON
 * @param {object} [opts] {taskPath, suiteDir, fixturesDir, repoRoot}
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateOutcomeTask(task, opts = {}) {
  const errors = [];
  const label = opts.taskPath || '<task>';
  if (!isPlainObject(task)) return { ok: false, errors: [`${label}: task must be a JSON object`] };

  if (task.schema_kind !== SCHEMA_KIND_TASK) err(errors, `${label}: schema_kind must be "${SCHEMA_KIND_TASK}"`);
  if (task.suite !== SUITE_ID) err(errors, `${label}: suite must be "${SUITE_ID}"`);
  if (typeof task.id !== 'string' || !ID_RE.test(task.id)) err(errors, `${label}: id must match ^outcome-[a-z0-9-]+$`);
  if (typeof task.title !== 'string' || !task.title.trim()) err(errors, `${label}: title must be a non-empty string`);
  if (!TASK_CATEGORIES.includes(task.category)) {
    err(errors, `${label}: category must be one of ${TASK_CATEGORIES.join('|')}`);
  }

  // Role-free, footer-free prompt (plan task 10). Outcome prompts never ask
  // for aliases, footers, or the dispatch-contract marker.
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) {
    err(errors, `${label}: prompt must be a non-empty string`);
  } else {
    for (const marker of FORBIDDEN_PROMPT_MARKERS) {
      if (task.prompt.includes(marker)) {
        err(errors, `${label}: prompt must not require protocol/footer marker "${marker}"`);
      }
    }
    const aliasMention = task.prompt.match(PROMPT_ROLE_ALIAS_RE);
    if (aliasMention) {
      err(errors, `${label}: prompt must not require a role alias (role-free scoring): "${aliasMention[0]}"`);
    }
  }

  // Arms: subset of the suite arms, 1..3, no repeats. Lifecycle scenarios and
  // evidence flags run on plugin arms only; a subset is allowed.
  if (!Array.isArray(task.arms) || task.arms.length < 1 || task.arms.length > 3) {
    err(errors, `${label}: arms must be an array of 1..3 suite arms`);
  } else {
    for (const arm of task.arms) {
      if (!SUITE_ARMS.includes(arm)) err(errors, `${label}: unknown arm "${arm}" (suite arms: ${SUITE_ARMS.join('|')})`);
    }
    if (new Set(task.arms).size !== task.arms.length) err(errors, `${label}: arms must not repeat`);
  }

  if (!BUDGET_CLASSES[task.budget_class]) {
    err(errors, `${label}: budget_class must be one of ${Object.keys(BUDGET_CLASSES).join('|')}`);
  }

  if (!Array.isArray(task.coverage_tags) || task.coverage_tags.length !== 1) {
    err(errors, `${label}: coverage_tags must be exactly one tag`);
  } else if (!COVERAGE_TAGS_REQUIRED.includes(task.coverage_tags[0])) {
    err(errors, `${label}: coverage_tags tag must be one of ${COVERAGE_TAGS_REQUIRED.join('|')}`);
  }

  // Boolean flags (legacy contract shared with validate.mjs).
  if (!isBoolean(task.verification_required) || !isBoolean(task.docs_required) || !isBoolean(task.review_required)) {
    err(errors, `${label}: verification_required, docs_required, review_required must be booleans`);
  }
  if (task.verification_required === true && task.category === 'docs') {
    err(errors, `${label}: docs-category tasks must set verification_required=false`);
  }

  // related_agents: CI file-mapping metadata only, never scored. Kept
  // non-empty because scripts/validate.mjs requires it for bench tasks.
  if (!Array.isArray(task.related_agents) || task.related_agents.length === 0 || !task.related_agents.every((a) => typeof a === 'string')) {
    err(errors, `${label}: related_agents must be a non-empty string array (diagnostic metadata, never scored)`);
  }
  if (!Array.isArray(task.success_criteria) || task.success_criteria.length === 0 || !task.success_criteria.every((c) => typeof c === 'string')) {
    err(errors, `${label}: success_criteria must be a non-empty string array`);
  }
  if (!Array.isArray(task.must_not) || task.must_not.length === 0 || !task.must_not.every((c) => typeof c === 'string')) {
    err(errors, `${label}: must_not must be a non-empty string array`);
  }
  // Legacy contract: these three arrays must exist AND stay empty on outcome
  // tasks (role-free, footer-free scoring, plan task 10). validate.mjs only
  // requires them to be arrays for bench tasks; the outcome suite is stricter.
  for (const field of ['required_transcript_patterns', 'required_used_agents', 'required_used_agent_groups']) {
    if (!Array.isArray(task[field]) || task[field].length > 0) {
      err(errors, `${label}: ${field} must be present and EMPTY (role-free scoring)`);
    }
  }
  for (const field of ['forbidden_transcript_patterns', 'forbidden_doc_patterns']) {
    if (task[field] !== undefined && !Array.isArray(task[field])) {
      err(errors, `${label}: ${field} must be an array when present`);
    }
  }

  // Fixture: shared set under bench/fixtures (mock runs need an existing dir).
  if (typeof task.fixture !== 'string' || !task.fixture) {
    err(errors, `${label}: fixture must be a non-empty string`);
  } else if (opts.fixturesDir) {
    const fixturePath = join(opts.fixturesDir, task.fixture);
    if (!(existsSync(fixturePath) && statSync(fixturePath).isDirectory())) {
      err(errors, `${label}: fixture "${task.fixture}" does not exist under ${opts.fixturesDir}`);
    }
  }

  const eo = task.expected_outcome;
  if (!isPlainObject(eo)) {
    err(errors, `${label}: expected_outcome must be an object`);
    return { ok: errors.length === 0, errors };
  }
  if (eo.verification_commands !== undefined && !Array.isArray(eo.verification_commands)) {
    err(errors, `${label}: expected_outcome.verification_commands must be an array when present`);
  }
  if (task.verification_required === true && (!Array.isArray(eo.verification_commands) || eo.verification_commands.length === 0 || !eo.verification_commands.every((c) => SAFE_COMMAND_CHARS.test(c)))) {
    err(errors, `${label}: expected_outcome.verification_commands must be a non-empty array of plain commands when verification_required=true`);
  }
  if (!Array.isArray(eo.predicates) || eo.predicates.length === 0) {
    err(errors, `${label}: expected_outcome.predicates must be a non-empty array`);
    return { ok: errors.length === 0, errors };
  }

  const seenPredicates = new Set();
  let mockCount = 0;
  let liveCount = 0;
  const evidenceFlagIds = [];
  for (const p of eo.predicates) {
    if (!isPlainObject(p)) {
      err(errors, `${label}: each predicate must be an object`);
      continue;
    }
    if (typeof p.id !== 'string' || !PREDICATE_ID_RE.test(p.id)) {
      err(errors, `${label}: predicate id must match ^[a-z0-9][a-z0-9-]*$`);
      continue;
    }
    if (seenPredicates.has(p.id)) err(errors, `${label}: duplicate predicate id "${p.id}"`);
    seenPredicates.add(p.id);
    if (p.evaluate_in === 'mock') {
      mockCount++;
      validateMockPredicate(task, p, errors, label);
    } else if (p.evaluate_in === 'live') {
      liveCount++;
      validateLivePredicate(task, p, errors, label, evidenceFlagIds);
    } else {
      err(errors, `${label}: predicate "${p.id}" evaluate_in must be "mock" or "live"`);
    }
  }
  if (mockCount === 0) err(errors, `${label}: at least one mock predicate is required`);
  if (liveCount === 0) err(errors, `${label}: at least one live predicate is required`);
  if (evidenceFlagIds.length > 0 && Array.isArray(task.arms) && task.arms.includes('native')) {
    err(errors, `${label}: evidence_flag predicates cannot be evaluated on the native arm (no plugin state)`);
  }

  validateGroundTruth(task, errors, label);
  validateSeedFiles(task, opts, errors, label);
  validateScenarioAblation(task, errors, label);

  return { ok: errors.length === 0, errors };
}

// ---------- predicate field validation ----------
function validateMockPredicate(task, p, errors, label) {
  if (p.kind !== 'initial_file_matches') {
    err(errors, `${label}: unknown mock predicate kind "${p.kind}" (allowed: ${MOCK_PREDICATE_KINDS.join('|')})`);
    return;
  }
  if (p.where !== 'fixture' && p.where !== 'seed') err(errors, `${label}: predicate "${p.id}" where must be "fixture" or "seed"`);
  if (typeof p.path !== 'string' || !p.path || SAFE_PATH_RE.test(p.path)) {
    err(errors, `${label}: predicate "${p.id}" path must be relative, no traversal`);
  }
  const compiled = compilePattern(p.pattern);
  if (compiled.error) err(errors, `${label}: predicate "${p.id}" ${compiled.error}`);
  if (p.min_occurrences !== undefined && (!Number.isInteger(p.min_occurrences) || p.min_occurrences < 1)) {
    err(errors, `${label}: predicate "${p.id}" min_occurrences must be a positive integer`);
  }
  if (p.where === 'seed' && typeof p.path === 'string' && !findSeed(task, p.path) && Array.isArray(task.seed_files)) {
    err(errors, `predicate "${p.id}" references seed path "${p.path}" with no seed_files entry`);
  }
}

function validateLivePredicate(task, p, errors, label, evidenceFlagIds) {
  switch (p.kind) {
    case 'file_exists':
      requirePath(p, errors, label);
      break;
    case 'file_unchanged': {
      requirePath(p, errors, label);
      if (p.base !== 'fixture' && p.base !== 'seed') {
        err(errors, `${label}: predicate "${p.id}" base must be "fixture" or "seed"`);
      }
      if (p.base === 'seed' && typeof p.path === 'string' && Array.isArray(task.seed_files) && !findSeed(task, p.path)) {
        err(errors, `${label}: predicate "${p.id}" references seed path "${p.path}" with no seed_files entry`);
      }
      break;
    }
    case 'file_matches':
    case 'file_not_matches':
      requirePath(p, errors, label);
      if (compilePattern(p.pattern).error) err(errors, `${label}: predicate "${p.id}" ${compilePattern(p.pattern).error}`);
      break;
    case 'commands_pass':
      if (!Array.isArray(p.commands) || p.commands.length === 0 || !p.commands.every((c) => typeof c === 'string' && SAFE_COMMAND_CHARS.test(c))) {
        err(errors, `${label}: predicate ${p.id} commands must be a non-empty array of plain commands`);
      }
      break;
    case 'changed_paths_within':
      if (!Array.isArray(p.allow) || !p.allow.every((a) => typeof a === 'string')) {
        err(errors, `${label}: predicate "${p.id}" allow must be an array of path globs (empty = no changes)`);
      }
      break;
    case 'findings_cover': {
      const gt = task && task.ground_truth;
      const materials = gt && Array.isArray(gt.findings) ? gt.findings.filter((f) => f && f.material === true) : [];
      if (materials.length === 0) {
        err(errors, `${label}: predicate "${p.id}" (findings_cover) requires ground_truth.findings material entries`);
      }
      if (p.min_matches !== undefined && (!Number.isInteger(p.min_matches) || p.min_matches < 1)) {
        err(errors, `${label}: predicate "${p.id}" min_matches must be a positive integer`);
      }
      break;
    }
    case 'evidence_flag':
      if (typeof p.field !== 'string' || !EVIDENCE_FIELD_VOCABULARY.includes(p.field)) {
        err(errors, `${label}: predicate "${p.id}" field not in the documented evidence vocabulary`);
      }
      if (!['equals', 'exists', 'absent', 'gte', 'lte'].includes(p.op)) {
        err(errors, `${label}: predicate "${p.id}" op must be equals|exists|absent|gte|lte`);
      } else if ((p.op === 'equals' || p.op === 'gte' || p.op === 'lte') && p.equals === undefined) {
        err(errors, `${label}: predicate "${p.id}" requires "equals" for op "${p.op}"`);
      }
      evidenceFlagIds.push(p.id);
      break;
    default:
      err(errors, `${label}: unknown live predicate kind "${p.kind}"`);
      break;
  }
}

function requirePath(p, errors, label) {
  if (typeof p.path !== 'string' || !p.path) err(errors, `${label}: predicate "${p.id}" path must be a relative path`);
}

// ---------- ground truth / seeds / scenario ----------
function validateGroundTruth(task, errors, label) {
  if (task.ground_truth === undefined) return;
  if (!isPlainObject(task.ground_truth)) {
    err(errors, `${label}: ground_truth must be an object`);
    return;
  }
  if (task.ground_truth.findings === undefined) return;
  const findings = task.ground_truth.findings;
  if (!Array.isArray(findings) || findings.length === 0) {
    err(errors, `${label}: ground_truth.findings must be a non-empty array`);
    return;
  }
  for (const f of findings) {
    if (!isPlainObject(f) || typeof f.id !== 'string' || !f.id) {
      err(errors, `${label}: each ground_truth finding needs a non-empty id`);
      continue;
    }
    if (!isBoolean(f.material)) err(errors, `${label}: finding "${f.id}" material must be boolean`);
    const compiled = compilePattern(f.report_pattern);
    if (compiled.error) err(errors, `${label}: finding "${f.id}" ${compiled.error}`);
  }
}

function validateSeedFiles(task, opts, errors, label) {
  if (task.seed_files === undefined) return;
  if (!Array.isArray(task.seed_files)) {
    err(errors, `${label}: seed_files must be an array`);
    return;
  }
  const seen = new Set();
  for (const seed of task.seed_files) {
    if (!isPlainObject(seed) || typeof seed.path !== 'string' || !seed.path || SAFE_PATH_RE.test(seed.path)) {
      err(errors, `${label}: each seed_files entry needs a relative "path" without traversal`);
      continue;
    }
    if (seen.has(seed.path)) err(errors, `${label}: duplicate seed path "${seed.path}"`);
    seen.add(seed.path);
    if (typeof seed.source !== 'string' || !seed.source || SAFE_PATH_RE.test(seed.source)) {
      err(errors, `${label}: seed "${seed.path}" needs a suite-root-relative "source" without traversal`);
    } else if (opts.suiteDir && !existsSync(join(opts.suiteDir, seed.source))) {
      err(errors, `${label}: seed "${seed.path}" source ${seed.source} missing under suite dir`);
    }
    if (typeof seed.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(seed.sha256)) {
      err(errors, `${label}: seed "${seed.path}" sha256 must be a 64-hex digest`);
    }
  }
}

function validateScenarioAblation(task, errors, label) {
  if (task.scenario !== undefined) {
    if (!isPlainObject(task.scenario) || !SCENARIO_TYPES.includes(task.scenario.type)) {
      err(errors, `${label}: scenario.type must be one of ${SCENARIO_TYPES.join('|')}`);
    }
  }
  if (task.ablation !== undefined) {
    const ab = task.ablation;
    const okAblation = isPlainObject(ab)
      && ABLATION_AXES.includes(ab.axis)
      && Array.isArray(ab.variants)
      && ab.variants.length > 0
      && ab.variants.length <= 2
      && ab.variants.every((v) => ABLATION_VARIANTS.includes(v));
    if (!okAblation) err(errors, `${label}: ablation must be {axis: "orchestrator", variants: [manager|root]}`);
  }
}

// ---------- suite loader ----------
/**
 * Load + validate every task JSON under <suiteDir>/tasks (sorted). Enforces
 * unique ids and the nine required coverage tags, each exactly once.
 */
export function loadOutcomeSuiteTasks(opts = {}) {
  const errors = [];
  const suiteDir = opts.suiteDir || defaultSuiteDir();
  const fixturesDir = tasksFixtureDir(opts);
  const byId = new Map();
  const coverageSeen = new Map();
  const tasks = [];
  const files = listJsonFiles(join(suiteDir, 'tasks'));
  if (files.length === 0) errors.push(`no outcome task files under ${join(suiteDir, 'tasks')}`);
  for (const path of files) {
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e) {
      errors.push(`${path}: invalid JSON (${e.message})`);
      continue;
    }
    const res = validateOutcomeTask(parsed, { taskPath: relativeLabel(path, suiteDir), suiteDir, fixturesDir });
    if (res.ok) tasks.push({ task: parsed, path });
    else tasks.push({ task: parsed, path, invalid: true });
    errors.push(...res.errors);
    if (parsed.id) {
      if (byId.has(parsed.id)) errors.push(`duplicate outcome task id "${parsed.id}": ${path}`);
      byId.set(parsed.id, path);
    }
    const tags = Array.isArray(parsed.coverage_tags) ? parsed.coverage_tags : [];
    for (const tag of tags) coverageSeen.set(tag, (coverageSeen.get(tag) || 0) + 1);
  }
  for (const tag of COVERAGE_TAGS_REQUIRED) {
    const n = coverageSeen.get(tag) || 0;
    if (n !== 1) errors.push(`coverage_tag "${tag}" must appear on exactly one outcome task (found ${n})`);
  }
  return { tasks, errors };
}

function relativeLabel(path, suiteDir) {
  if (path.startsWith(suiteDir)) return path.slice(suiteDir.length + 1);
  return path;
}

function listJsonFiles(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).sort().map((n) => join(dir, n));
}

function defaultSuiteDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

function tasksFixtureDir(opts) {
  return opts.fixturesDir || (opts.repoRoot ? join(opts.repoRoot, 'bench', 'fixtures') : '');
}

// ---------- mock predicate evaluation (no model spend) ----------
/**
 * Evaluate the mock predicates of a task against the DECLARED initial state.
 * Used by the suite validator and by the metrics emitter; shares no runner
 * code. Seeded code is text-checked only; the security seed is never imported
 * or executed.
 */
export function evaluateMockPredicates(task, paths) {
  const results = [];
  const predicates = task.expected_outcome && Array.isArray(task.expected_outcome.predicates)
    ? task.expected_outcome.predicates
    : [];
  for (const p of predicates) {
    if (p.evaluate_in !== 'mock') continue;
    if (p.kind !== 'initial_file_matches') {
      results.push({ id: p.id, result: 'failed', detail: `unknown mock kind ${p.kind}` });
      continue;
    }
    const file = p.where === 'seed'
      ? seedSourcePath(task, p.path, paths)
      : join(tasksFixtureDir({ repoRoot: paths.repoRoot, fixturesDir: paths.fixturesDir }), task.fixture, p.path);
    let text = null;
    if (file && existsSync(file) && statSync(file).isFile()) {
      text = readFileSync(file, 'utf-8');
    }
    if (text === null) {
      results.push({ id: p.id, result: 'failed', detail: `missing file: ${p.path}` });
      continue;
    }
    const min = p.min_occurrences === undefined ? 1 : p.min_occurrences;
    let matches = 0;
    try {
      matches = [...text.matchAll(new RegExp(p.pattern, 'g'))].length;
    } catch {
      results.push({ id: p.id, result: 'failed', detail: 'pattern failed to compile at evaluation time' });
      continue;
    }
    results.push({ id: p.id, result: matches >= min ? 'passed' : 'failed', detail: `${matches} occurrence(s)` });
  }
  return { results, violations: results.filter((r) => r.result === 'failed').length };
}

// Seed integrity + contracts revision helpers.
/**
 * Recompute each declared seed's digest and report mismatches.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function checkSeedIntegrity(task, opts = {}) {
  const errors = [];
  const suiteDir = opts.suiteDir || defaultSuiteDir();
  for (const seed of Array.isArray(task.seed_files) ? task.seed_files : []) {
    const source = join(suiteDir, seed.source);
    if (!existsSync(source)) {
      errors.push(`${task.id}: seed source ${seed.source} missing`);
      continue;
    }
    const digest = createHash('sha256').update(readFileSync(source)).digest('hex');
    if (digest !== seed.sha256) errors.push(`${task.id}: seed ${seed.source} sha256 mismatch (task may drift from the seed file)`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Deterministic digest of everything the outcome contract depends on: shared
 * fixtures, suite seeds/schema code, and the forbidden pattern set. ADR-0012
 * requires recording this fixture revision with every run. Task JSON files are
 * validated, not digested (they may legitimately evolve between runs; the
 * digest pins the code the tasks assert against).
 */
export function contractsRevision(repoRoot, suiteDir) {
  const fixturesDir = join(repoRoot, 'bench', 'fixtures');
  const patternsFile = join(repoRoot, 'bench', 'patterns', 'forbidden-meta-chatter.json');
  const files = [...listFilesRecursive(fixturesDir), ...listFilesRecursive(suiteDir)];
  if (existsSync(patternsFile)) files.push(patternsFile);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file}\0${createHash('sha256').update(readFileSync(file)).digest('hex')}\n`);
  }
  if (files.length === 0) hash.update('empty');
  return `sha256:${hash.digest('hex')}`;
}

function listFilesRecursive(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.pop();
    let names = [];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const p = join(current, name);
      let st = null;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) queue.push(p);
      else if (st.isFile() && !name.endsWith('.json')) out.push(p);
    }
  }
  return out;
}

// ---------- metrics contract (consumed by plan tasks 11/15) ----------
/**
 * Validate a per-arm metrics document emitted by the suite emitter.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateOutcomeMetrics(doc) {
  const errors = [];
  if (!isPlainObject(doc)) return { ok: false, errors: ['metrics document must be a JSON object'] };
  if (doc.schema_kind !== METRICS_SCHEMA_KIND) err(errors, `schema_kind must be "${METRICS_SCHEMA_KIND}"`);
  if (doc.schema_version !== METRICS_SCHEMA_VERSION) err(errors, `schema_version must be "${METRICS_SCHEMA_VERSION}"`);
  if (doc.suite !== SUITE_ID) err(errors, `suite must be "${SUITE_ID}"`);
  if (!['mock', 'live'].includes(doc.mode)) err(errors, 'mode must be "mock" or "live"');
  if (!Array.isArray(doc.arms)) err(errors, 'arms must be an array of arm labels');
  if (!isPlainObject(doc.run_metadata)) err(errors, 'run_metadata must be an object');
  else {
    for (const key of ['model', 'provider', 'effort', 'token_cap', 'cli_version']) {
      if (!Object.prototype.hasOwnProperty.call(doc.run_metadata, key)) {
        err(errors, `run_metadata.${key} must be recorded (null when unknown)`);
      }
    }
  }
  if (!isPlainObject(doc.per_arm)) err(errors, 'per_arm must be an object keyed by arm label');
  else {
    for (const [arm, agg] of Object.entries(doc.per_arm)) {
      if (!isPlainObject(agg)) { err(errors, `per_arm.${arm} must be an object`); continue; }
      for (const key of ['reps', 'outcome_pass_rate', 'false_completions', 'permission_denials', 'material_findings', 'predicates']) {
        if (!Object.prototype.hasOwnProperty.call(agg, key)) err(errors, `per_arm.${arm}.${key} must be recorded`);
      }
      if (doc.mode === 'mock' && agg.outcome_pass_rate !== null) {
        err(errors, `per_arm.${arm}.outcome_pass_rate must be null in mock mode (mock never proves outcomes)`);
      }
      const preds = isPlainObject(agg.predicates) ? agg.predicates : {};
      const live = isPlainObject(preds.live) ? preds.live : {};
      if (!isBoolean(live.evaluated)) err(errors, `per_arm.${arm}.predicates.live.evaluated must be a boolean`);
      if (live.evaluated === false && agg.outcome_pass_rate !== null) {
        err(errors, `per_arm.${arm}.outcome_pass_rate must be null when live predicates were not evaluated`);
      }
    }
  }
  if (!Array.isArray(doc.records)) err(errors, 'records must be an array');
  if (!isPlainObject(doc.gate_inputs)) err(errors, 'gate_inputs must be an object');
  else {
    if (!isBoolean(doc.gate_inputs.available)) err(errors, 'gate_inputs.available must be a boolean');
    if (doc.gate_inputs.available === false && typeof doc.gate_inputs.reason !== 'string') {
      err(errors, 'gate_inputs.reason must be a string when gate inputs are unavailable');
    }
    if (doc.gate_inputs.available === true && doc.mode !== 'live') {
      err(errors, 'gate_inputs only from live runs');
    }
    if (doc.gate_inputs.available === true) {
      const lean = doc.gate_inputs.lean;
      if (!isPlainObject(lean)) err(errors, 'gate_inputs.lean must map compared arms to gate deltas');
      else {
        for (const [base, gi] of Object.entries(lean)) {
          for (const key of ['new_false_completions', 'permission_denials_delta', 'lost_material_findings', 'paired']) {
            if (!Object.prototype.hasOwnProperty.call(gi, key)) err(errors, `gate_inputs.lean.${base}.${key} must be recorded`);
          }
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isBoolean(v) {
  return typeof v === 'boolean';
}

function compilePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return { error: 'pattern must be a non-empty string' };
  try {
    return { re: new RegExp(pattern, 'g') };
  } catch (e) {
    return { error: `invalid pattern: ${e.message}` };
  }
}

function findSeed(task, seedPath) {
  const list = Array.isArray(task.seed_files) ? task.seed_files : [];
  return list.find((s) => s && s.path === seedPath) || null;
}

/**
 * Resolve a mock predicate's `where: "seed"` target to the DECLARED seed
 * source under the suite dir. Mock predicates check the initial state the
 * suite ships, so the source file (not a prepared worktree copy) is canonical.
 * Returns null when the path is not a declared seed of the task, which
 * evaluateMockPredicates reports as a failed predicate, never a silent skip.
 */
function seedSourcePath(task, seedPath, paths) {
  const seed = findSeed(task, seedPath);
  if (!seed || typeof seed.source !== 'string' || !seed.source) return null;
  const suiteDir = paths && paths.suiteDir ? paths.suiteDir : defaultSuiteDir();
  return join(suiteDir, seed.source);
}


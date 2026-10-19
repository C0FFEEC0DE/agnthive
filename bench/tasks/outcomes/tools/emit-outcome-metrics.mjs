#!/usr/bin/env node
// Suite-owned emitter for the outcome benchmark suite (ADR-0012, plan task 10).
//
// Reads one or more benchmark run output dirs (summary.json produced by
// scripts/run-benchmark.mjs) and emits ONE per-arm metrics document the
// rollout gate (plan tasks 11/15) consumes:
//
//   ${BENCH_OUTPUT_DIR}/outcome-metrics.json
//
// The suite DECLARES arms/predicates; the runner (plan task 09) EXECUTES and
// evaluates live predicates by writing `predicate_results` into each task's
// result.json. Until that runner wiring exists, live predicates stay
// `unverified` and outcome pass rates stay null — an honest gap, never a
// fabricated pass (ADR-0012: missing live verification is unverified, not
// passed).
//
// Node stdlib only, ESM.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Suite contract is imported from the suite schema module; no runner imports.
import {
  EMITTER_VERSION,
  METRICS_SCHEMA_KIND,
  METRICS_SCHEMA_VERSION,
  MIN_LIVE_REPS,
  SUITE_ARMS,
  SUITE_ID,
  contractsRevision,
  evaluateMockPredicates,
  loadOutcomeSuiteTasks,
  checkSeedIntegrity,
  validateOutcomeMetrics,
} from '../schema/outcome-schema.mjs';

// ---------- tiny local helpers (no runner imports) ----------
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

/** Median over numbers; null when no datapoints (never a fake 0). */
function medianOrNull(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const m = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return m;
}

function rateOrNull(numerator, denominator) {
  if (denominator === 0) return null;
  return numerator / denominator;
}

// ---------- emitter CLI options ----------
const OUTCOME_VALUES = Object.freeze(['passed', 'failed', 'unverified']);
const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SUITE_DIR = resolvePath(TOOL_DIR, '..');
const DEFAULT_REPO_ROOT = resolvePath(TOOL_DIR, '..', '..', '..', '..');

function envArm() {
  const raw = process.env.BENCH_ARM;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}


function numOr0(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// ---------- run collection ----------
/**
 * Normalize one runner result (a summary.json tasks[] entry, which is the
 * full result.json object run-benchmark.mjs embeds verbatim) into an outcome
 * record. Runner-optional keys (predicate_results, findings_evidence, turns,
 * token_usage, cost_usd, cost_source, permission_denials_count,
 * dispatch_count, changed_files, rep) stay null when absent — the task 09
 * runner owns filling them in; the emitter never invents values.
 */
function normalizePredicateResults(raw) {
  const map = {};
  if (!plainObject(raw)) return map;
  for (const [id, value] of Object.entries(raw)) {
    const result = plainObject(value) ? value.result : value;
    map[id] = OUTCOME_VALUES.includes(result) ? result : 'unverified';
  }
  return map;
}

function mapFindings(task, raw) {
  const truth = task.ground_truth && Array.isArray(task.ground_truth.findings)
    ? task.ground_truth.findings
    : [];
  const material = truth.filter((f) => f && f.material === true);
  const matched = raw && Array.isArray(raw.matched_material_ids)
    ? raw.matched_material_ids.filter((id) => material.some((f) => f.id === id)).length
    : null;
  const claimed = raw && Number.isFinite(Number(raw.claimed_total)) ? Number(raw.claimed_total) : null;
  return {
    ground_truth_total: truth.length,
    ground_truth_material: material.length,
    matched, // matched material findings
    claimed_total: claimed,
    missed: matched === null ? null : Math.max(0, material.length - matched),
  };
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build one outcome record from a runner result. `task` is the validated
 * suite task (expected_outcome.predicates etc.). Live predicates come ONLY
 * from the runner's predicate_results; in mock mode they stay unverified.
 * Mock predicates are NOT part of the record — they are evaluated offline
 * from the declared files and shared suite-wide (see suiteMockCounts).
 */
function recordFromResult(result, task, arm, mode, rep) {
  const preds = task.expected_outcome && Array.isArray(task.expected_outcome.predicates)
    ? task.expected_outcome.predicates
    : [];
  const liveIds = preds.filter((p) => p && p.evaluate_in === 'live').map((p) => p.id);
  const runnerResults = normalizePredicateResults(result.predicate_results);
  const liveFailures = liveIds.filter((id) => runnerResults[id] === 'failed').length;
  const livePasses = liveIds.filter((id) => runnerResults[id] === 'passed').length;
  const liveEvaluated = liveIds.length > 0 && liveIds.every((id) => runnerResults[id] === 'passed' || runnerResults[id] === 'failed');
  let outcome = 'unverified';
  if (mode === 'mock') {
    outcome = 'unverified';
  } else if (result.status === 'failed') {
    outcome = 'failed';
  } else if (liveEvaluated) {
    outcome = liveFailures > 0 ? 'failed' : livePasses === liveIds.length ? 'passed' : 'unverified';
  }
  return {
    task_id: task.id,
    task_path: asString(result.task_path) || null,
    arm,
    rep,
    mode,
    runner_status: asString(result.status) || null,
    completed: result.completed === true,
    verification_required: result.verification_required === true,
    tests_run: result.tests_run === true,
    tests_passed: result.tests_passed === true,
    review_required: result.review_required === true,
    review_present: result.review_present === true,
    docs_required: result.docs_required === true,
    docs_updated: result.docs_updated === true,
    policy_violations: numOr0(result.policy_violations),
    tool_failures: numOr0(result.tool_failures),
    runtime_seconds: num(result.runtime_seconds),
    turns: num(result.turns),
    dispatch_count: num(result.dispatch_count),
    permission_denials_count: num(result.permission_denials_count),
    token_usage: plainObject(result.token_usage) ? {
      input: numOr0(result.token_usage.input),
      output: numOr0(result.token_usage.output),
      cache_read: numOr0(result.token_usage.cache_read),
      cache_write: numOr0(result.token_usage.cache_write),
    } : null,
    cost_usd: num(result.cost_usd), // null when the runner reported no cost
    cost_source: asString(result.cost_source), // 'provider' means the runner's number is measured, not estimated
    changed_files: Array.isArray(result.changed_files)
      ? result.changed_files.filter((f) => typeof f === 'string').filter((f) => f !== '')
      : null, // null: the runner did not report changed files
    findings: mapFindings(task, result.findings_evidence),
    live_predicates: liveIds,
    live_results: Object.fromEntries(liveIds.map((id) => [id, runnerResults[id] || 'unverified'])),
    live_evaluated: liveEvaluated,
    outcome,
  };
}

/**
 * Normalize one run output dir (summary.json written by run-benchmark.mjs)
 * into `{dir, arm, mode, records}`. `index` is the suite task index (Map of
 * valid task id -> task) produced by the suite loader; results for task ids
 * outside the outcomes suite get an `ignored` marker record instead of an
 * outcome record (a run may include other suites).
 */
export function collectRun(runDir, arm, index) {
  // LOW (a) (@cr 0.4.0): a malformed summary.json is a reported violation,
  // never an uncaught throw and never silently dropped.
  let summary = null;
  let parseError = null;
  try { summary = readJson(join(runDir, 'summary.json')); } catch (e) {
    parseError = String((e && e.message) || e);
  }
  if (summary === null) {
    return {
      dir: resolvePath(runDir),
      arm: arm || envArm() || 'unassigned',
      mode: 'unparseable',
      records: [],
      runViolations: ['summary.json could not be parsed: ' + parseError],
    };
  }
  const mode = summary.mode === 'mock' ? 'mock' : 'live';
  const runArm = arm || envArm() || 'unassigned';
  const run = {
    dir: resolvePath(runDir),
    arm: runArm,
    mode,
    source_ref: asString(summary.source_ref) || asString(summary.source) || null,
    source_sha: asString(summary.source_sha) || null,
    generated_at: asString(summary.generated_at) || null,
    metadata: extractRunMetadata([summary]),
    records: [],
  };
  const entries = Array.isArray(summary.tasks) ? summary.tasks : [];
  const repCounter = new Map();
  for (const result of entries) {
    if (!plainObject(result)) continue;
    const taskId = asString(result.task_id);
    const task = taskId && index ? index.get(taskId) : null;
    if (!task) {
      run.records.push({
        task_id: taskId || '(none)',
        arm: runArm,
        mode,
        outcome: 'unverified',
        ignored: 'task id is not part of the outcomes suite',
      });
      continue;
    }
    const rep = Number.isInteger(result.rep) ? result.rep : repCounter.get(taskId) || 0;
    repCounter.set(taskId, rep + 1);
    run.records.push(recordFromResult(result, task, runArm, mode, rep));
  }
  return run;
}


// ---------- per-arm aggregation ----------
// Honest nulls: outcome_pass_rate and false_completions stay null unless the
// arm's records carried evaluated live predicate results (mock mode and
// unwired runners can never prove outcomes). mockTotals is the suite-wide
// offline mock-predicate tally shared by every arm (arm-independent).
function countLive(records, value) {
  let n = 0;
  for (const r of records) {
    for (const id of r.live_predicates) {
      if (r.live_results[id] === value) n++;
    }
  }
  return n;
}

export function aggregateArm(arm, records, mockTotals) {
  const measurable = records.length > 0 && records.every((r) => r.live_evaluated === true);
  const passedCount = records.filter((r) => r.outcome === 'passed').length;
  const verifiedRows = records.filter((r) => r.verification_required === true);
  const verifiedPassed = verifiedRows.filter((r) => r.tests_passed === true).length;
  const findingsRows = records.filter((r) => r.findings.matched !== null);
  const materialTotal = records.reduce((s, r) => s + r.findings.ground_truth_material, 0);
  const materialMatched = findingsRows.reduce((s, r) => s + r.findings.matched, 0);
  const claimedTotal = findingsRows.reduce((s, r) => s + (r.findings.claimed_total || 0), 0);
  const tokenRows = records.filter((r) => r.token_usage);
  const costRows = records.filter((r) => r.cost_usd !== null);
  const completedRows = records.filter((r) => r.completed === true);
  const liveTotal = records.reduce((s, r) => s + r.live_predicates.length, 0);
  const tokenSum = (key) => tokenRows.reduce((sum, r) => sum + (Number(r.token_usage[key]) || 0), 0);
  return {
    arm,
    reps: new Set(records.map((r) => r.rep)).size,
    task_executions: records.length,
    tasks: new Set(records.map((r) => r.task_id)).size,
    completed_rate: rateOrNull(completedRows.length, records.length),
    outcome_pass_rate: measurable ? rateOrNull(passedCount, records.length) : null,
    false_completions: measurable
      ? records.filter((r) => r.completed === true && r.outcome === 'failed').length
      : null,
    permission_denials: records.reduce((s, r) => s + (r.permission_denials_count || 0), 0),
    verification_pass_rate: rateOrNull(verifiedPassed, verifiedRows.length),
    material_findings: {
      expected: materialTotal,
      found: findingsRows.length > 0 ? materialMatched : null,
      missed: findingsRows.length > 0 ? Math.max(0, materialTotal - materialMatched) : null,
      claimed_total: findingsRows.some((r) => r.findings.claimed_total !== null)
        ? claimedTotal
        : null,
    },
    median_turns: medianOrNull(records.map((r) => r.turns)),
    median_runtime_seconds: medianOrNull(records.map((r) => r.runtime_seconds)),
    median_dispatches: medianOrNull(records.map((r) => r.dispatch_count)),
    token_usage: tokenRows.length > 0 ? {
      input: tokenSum('input'),
      output: tokenSum('output'),
      cache_read: tokenSum('cache_read'),
      cache_write: tokenSum('cache_write'),
    } : null,
    cost: costRows.length > 0 ? {
      usd: costRows.reduce((s, r) => s + r.cost_usd, 0),
      estimated: costRows.some((r) => r.cost_source !== 'provider'),
    } : null,
    predicates: {
      mock: {
        total: mockTotals.total,
        passed: mockTotals.passed,
        failed: mockTotals.failed,
      },
      live: {
        total: liveTotal,
        passed: countLive(records, 'passed'),
        failed: countLive(records, 'failed'),
        unverified: countLive(records, 'unverified'),
        evaluated: measurable,
      },
    },
  };
}

// ---------- ADR-0012 rollout-gate inputs ----------
/**
 * Gate deltas lean-vs-baseline (ADR-0012). Available ONLY from live-mode runs
 * where every involved-arm record carried evaluated live predicate results,
 * every ground-truth task's records carried findings evidence, and every
 * involved arm ran >= MIN_LIVE_REPS per task. Missing evidence means
 * available:false with a reason — never a fabricated "available".
 */
function computeGateInputs(perArm, records, mode) {
  const reasons = [];
  if (mode !== 'live') reasons.push('metrics are not from a live-mode run');
  const lean = perArm.lean;
  if (!lean) reasons.push('no lean-arm run present');
  const bases = ['native', 'legacy'].filter((b) => perArm[b]);
  if (bases.length === 0) reasons.push('no baseline arm present (need native or legacy)');
  const involved = lean ? [...bases, 'lean'] : [];
  const evalOk = involved.every((a) => perArm[a].predicates.live.evaluated === true);
  if (!evalOk) reasons.push('live predicates not fully evaluated on every involved arm');
  const floorOk = perTaskRepFloorOk(involved, records);
  if (!floorOk) reasons.push('an involved arm ran fewer than ' + MIN_LIVE_REPS + ' reps for some task');
  if (!findingsEvidenceOk(involved, records)) {
    reasons.push('findings evidence missing on an involved arm');
  }
  if (reasons.length > 0) return { available: false, reason: reasons.join('; ') };
  const comparisons = {};
  for (const base of bases) {
    comparisons[base] = {
      new_false_completions: (perArm.lean.false_completions || 0) - (perArm[base].false_completions || 0),
      permission_denials_delta: perArm.lean.permission_denials - perArm[base].permission_denials,
      lost_material_findings: lostMaterialFindings("lean", base, records).value,
      paired: pairedCount('lean', base, records),
    };
  }
  return { available: true, lean: comparisons };
}

/** True when every task of every involved arm has >= MIN_LIVE_REPS records. */
function perTaskRepFloorOk(involved, records) {
  const counts = {};
  for (const r of records) {
    if (!r.ignored && involved.includes(r.arm)) {
      const key = r.arm + '|' + r.task_id;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return Object.values(counts).every((n) => n >= MIN_LIVE_REPS);
}

/**
 * Pairable (task, rep) pairs across two arms: reps both arms executed for the
 * same task. Pairing by rep NUMBER is what makes the comparison paired rather
 * than pooled (ADR-0012).
 */
function pairedCount(armA, armB, records) {
  const perArm = new Map();
  for (const r of records) {
    if (r.ignored || (r.arm !== armA && r.arm !== armB)) continue;
    const tasks = perArm.get(r.arm) || new Map();
    const reps = tasks.get(r.task_id) || new Set();
    reps.add(r.rep);
    tasks.set(r.task_id, reps);
    perArm.set(r.arm, tasks);
  }
  return perTaskPairCount(perArm.get(armA), perArm.get(armB));
}

function perTaskPairCount(a, b) {
  if (!a || !b) return 0;
  let pairs = 0;
  for (const [taskId, reps] of a) {
    const other = b.get(taskId);
    if (!other) continue;
    for (const rep of reps) {
      if (other.has(rep)) pairs++;
    }
  }
  return pairs;
}

/**
 * lost_material_findings per ADR-0012: for each ground-truth task, the worst
 * paired-rep drop in MATCHED MATERIAL findings (baseline minus lean, floored
 * at 0), summed across tasks. Findings evidence must be present on both arms
 * (checked by the availability gate); a missing count here cannot silently
 * become a zero loss.
 */
function lostMaterialFindings(armA, armB, records) {
  const perArmTask = new Map();
  for (const r of records) {
    if (r.ignored || (r.arm !== armA && r.arm !== armB)) continue;
    if (r.findings.ground_truth_material === 0) continue; // no findings expected on this task
    if (r.findings.matched === null) return { value: null, paired: 0, undermeasured: true };
    const tasks = perArmTask.get(r.arm) || new Map();
    const key = r.task_id + '|' + r.rep;
    tasks.set(key, r.findings.matched);
    perArmTask.set(r.arm, tasks);
  }
  return { value: lostFromPerArmTask(perArmTask.get(armA), perArmTask.get(armB)), paired: 0 };
}

function lostFromPerArmTask(a, b) {
  if (!a || !b) return 0;
  let lost = 0;
  for (const [key, baseMatched] of a) {
    const leanMatched = b.get(key);
    if (leanMatched === undefined) continue;
    lost += Math.max(0, baseMatched - leanMatched);
  }
  return lost;
}

/** True when involved-arm ground-truth records all carry matched counts. */
function findingsEvidenceOk(involved, records) {
  const rows = records.filter((r) => !r.ignored
    && involved.includes(r.arm)
    && r.findings.ground_truth_material > 0);
  if (rows.length === 0) return false;
  return rows.every((r) => r.findings.matched !== null);
}

// ---------- metrics document ----------
const METADATA_FIELDS = ['model', 'provider', 'effort', 'token_cap', 'cli_version'];

function firstValueFrom(summaries, field) {
  for (const summary of summaries) {
    const value = summary[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (Number.isFinite(value)) return value;
  }
  const env = process.env['BENCH_' + field.toUpperCase()];
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return null;
}

function extractRunMetadata(summaries) {
  const metadata = {};
  for (const field of METADATA_FIELDS) {
    metadata[field] = firstValueFrom(summaries, field);
  }
  return metadata;
}

function buildDocument(context) {
  const { runs, mockTotals, suiteDir, repoRoot } = context;
  const taskRecords = runs.flatMap((run) => run.records).filter((r) => !r.ignored);
  const mode = runs[0].mode;
  const records = runs.flatMap((run) => run.records);
  const perArm = {};
  for (const arm of SUITE_ARMS) {
    const rows = taskRecords.filter((r) => r.arm === arm);
    if (rows.length === 0) continue;
    perArm[arm] = aggregateArm(arm, rows, mockTotals);
  }
  return {
    schema_kind: METRICS_SCHEMA_KIND,
    schema_version: METRICS_SCHEMA_VERSION,
    suite: SUITE_ID,
    emitter_version: EMITTER_VERSION,
    mode,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    contracts_revision: contractsRevision(repoRoot, suiteDir),
    run_metadata: extractRunMetadata(runs.map((run) => run.metadata || {})),
    arms: Object.keys(perArm),
    per_arm: perArm,
    records,
    gate_inputs: computeGateInputs(perArm, taskRecords, mode),
  };
}

// ---------- violations guard ----------
/**
 * Suite-contract violations that must FAIL the emitter before any metrics
 * file is written: invalid task JSON, drifted seeds, failing initial-state
 * (mock) predicates, mixed run modes, BENCH_MOCK contradiction, unknown or
 * unassigned arms on task records, duplicate (arm, task, rep) indices.
 */
function collectViolations(loaded, paths, runs, mockTotals) {
  const violations = [];
  for (const error of loaded.errors) {
    violations.push('outcome task contract: ' + error);
  }
  for (const entry of loaded.tasks) {
    if (entry.invalid) continue;
    for (const error of checkSeedIntegrity(entry.task, { suiteDir: paths.suiteDir }).errors) {
      violations.push('seed integrity: ' + error);
    }
    const evaluated = evaluateMockPredicates(entry.task, paths);
    for (const item of evaluated.results) {
      mockTotals.total += 1;
      if (item.result === 'passed') mockTotals.passed += 1; else mockTotals.failed += 1;
    }
    for (const item of evaluated.results) {
      if (item.result !== 'passed') {
        violations.push('mock predicate: ' + entry.task.id + '/' + item.id + ': ' + item.detail);
      }
    }
  }
  // LOW (a) (@cr 0.4.0): hoist run-level (parse) violations into the guard.
  for (const run of runs) {
    for (const line of run.runViolations || []) violations.push('run ' + run.dir + ': ' + line);
  }
  // 'unparseable' runs are already violations above; exclude them from the
  // mock/live mix check so a corrupt summary cannot fake a mode conflict.
  const modes = new Set(runs.filter((run) => run.mode !== 'unparseable').map((run) => run.mode));
  if (modes.size > 1) violations.push('mixed mock and live runs in one metrics document');
  if (process.env.BENCH_MOCK === '1' && runs.some((run) => run.mode === 'live')) {
    violations.push('BENCH_MOCK=1 set but a run is live-mode');
  }
  const seen = new Map();
  for (const run of runs) {
    for (const record of run.records) {
      if (record.ignored) continue;
      if (!SUITE_ARMS.includes(record.arm)) {
        violations.push('task records must be assigned a suite arm: task ' + record.task_id + ' arm ' + record.arm);
        continue;
      }
      const key = record.arm + '|' + record.task_id + '|' + record.rep;
      if (seen.has(key)) violations.push('duplicate rep index: ' + key);
      seen.set(key, true);
    }
  }
  return violations;
}

// ---------- entry point ----------
/**
 * Emit the suite's per-arm metrics document. Returns {written, doc} on
 * success or {violations} without writing anything when the suite contract or
 * run inputs are broken. Pure enough for the validator test: no process.exit
 * and no global stdout writes.
 */
export function emitOutcomeMetrics(opts = {}) {
  const suiteDir = opts.suiteDir ? resolvePath(opts.suiteDir) : DEFAULT_SUITE_DIR;
  const repoRoot = opts.repoRoot ? resolvePath(opts.repoRoot) : DEFAULT_REPO_ROOT;
  const loaded = loadOutcomeSuiteTasks({ suiteDir, repoRoot });
  const paths = { repoRoot, fixturesDir: join(repoRoot, 'bench', 'fixtures'), suiteDir };
  const index = new Map();
  const mockTotals = { total: 0, passed: 0, failed: 0 };
  for (const entry of loaded.tasks) {
    if (!entry.invalid && entry.task.id) index.set(entry.task.id, entry.task);
  }
  const runs = (opts.runs || []).map((run) => collectRun(run.dir, run.arm || null, index));
  const violations = collectViolations(loaded, paths, runs, mockTotals);
  if (runs.length === 0) violations.push('at least one --run DIR with a summary.json is required');
  if (violations.length > 0) return { violations };
  return writeMetricsDocument(runs, mockTotals, { suiteDir, repoRoot }, opts.out);
}

function writeMetricsDocument(runs, mockTotals, dirs, out) {
  const doc = buildDocument({ runs, mockTotals, suiteDir: dirs.suiteDir, repoRoot: dirs.repoRoot });
  const path = out ? resolvePath(out) : join(runs[0].dir, 'outcome-metrics.json');
  writeJson(path, doc);
  return { written: path, doc };
}

// ---------- CLI ----------
function parseEmitterArgs(argv) {
  const out = { runs: [], out: '', suiteDir: '', repoRoot: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') out.runs.push({ dir: argv[++i] || '', arm: null });
    else if (a === '--arm') {
      const last = out.runs[out.runs.length - 1];
      if (!last) {
        process.stderr.write('Usage: --arm NAME must follow a --run DIR\n');
        process.exit(1);
      }
      last.arm = argv[++i] || '';
    } else if (a === '--out') out.out = argv[++i];
    else if (a === '--suite-dir') out.suiteDir = argv[++i];
    else if (a === '--repo-root') out.repoRoot = argv[++i];
    else {
      process.stderr.write('Usage: emit-outcome-metrics.mjs --run DIR [--arm NAME] [--run DIR ...]\n' +
        '  [--out FILE] [--suite-dir DIR] [--repo-root DIR]  (arm fallback: BENCH_ARM)\n');
      process.exit(1);
    }
  }
  if (out.runs.length === 0) {
    process.stderr.write('Usage: emit-outcome-metrics.mjs --run DIR [--arm NAME] [--run DIR ...]\n');
    process.exit(1);
  }
  return out;
}

export function main(argv) {
  const result = emitOutcomeMetrics(parseEmitterArgs(argv));
  if (result.violations) {
    for (const line of result.violations) process.stderr.write('- ' + line + '\n');
    process.stderr.write('outcome metrics not written: ' + result.violations.length + ' violation(s)\n');
    return 1;
  }
  const doc = result.doc;
  process.stdout.write('outcome metrics written to ' + result.written + '\n');
  for (const arm of doc.arms) {
    const agg = doc.per_arm[arm];
    const rate = agg.outcome_pass_rate === null ? 'null' : agg.outcome_pass_rate.toFixed(3);
    process.stdout.write('- ' + arm + ': reps=' + agg.reps + ' outcome_pass_rate=' + rate
      + ' gate_inputs=' + (doc.gate_inputs.available ? 'ready' : 'unavailable') + '\n');
  }
  return 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) process.exit(main(process.argv.slice(2)));

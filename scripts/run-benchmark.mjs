#!/usr/bin/env node
// run-benchmark: orchestrates a benchmark run over a set of task files.
// Mock mode uses the Node mock runner; command mode spawns BENCH_RUNNER_CMD
// (split into an explicit argv — never a shell string).
// Node port of scripts/run-benchmark.sh — no Bash, no jq.
import { mkdirSync, rmSync, cpSync, copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative as relPath, isAbsolute, sep, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isMain, readJson, writeJson, median, rate } from './bench/lib.mjs';
import { validateOutcomeTask, SUITE_ARMS, MIN_LIVE_REPS } from '../bench/tasks/outcomes/schema/outcome-schema.mjs';
import { renderSummary } from './render-benchmark-summary.mjs';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');

function relativeTaskPath(p) {
  if (p.startsWith(REPO_ROOT + '/')) return p.slice(REPO_ROOT.length + 1);
  return p;
}

/** Minimal glob: supports * (one path segment) and ** (recursive). */
function globMatch(pattern, root) {
  const segments = pattern.split('/');
  function walk(dir, segs, out) {
    if (segs.length === 0) {
      if (existsSync(dir)) out.push(dir);
      return;
    }
    const [seg, ...rest] = segs;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (seg === '**') {
      walk(dir, rest, out);
      for (const ent of entries) {
        if (ent.isDirectory()) walk(join(dir, ent.name), ['**', ...rest], out);
      }
    } else if (seg.includes('*')) {
      const re = new RegExp('^' + seg.replace(/[.+^$(){}|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
      for (const ent of entries) {
        if (re.test(ent.name)) {
          if (rest.length === 0) out.push(join(dir, ent.name));
          else if (ent.isDirectory()) walk(join(dir, ent.name), rest, out);
        }
      }
    } else {
      const next = join(dir, seg);
      if (rest.length === 0) { if (existsSync(next)) out.push(next); }
      else { try { if (statSync(next).isDirectory()) walk(next, rest, out); } catch {} }
    }
  }
  const out = [];
  walk(root, segments, out);
  return out.sort();
}

const USAGE = 'Usage: run-benchmark.mjs --output-dir DIR [--task-glob GLOB | --task-list-file FILE] [--task-label LABEL] [--mode mock|command] [--ref REF] [--arms a,b,c] [--reps N] [--arm-profile legacy|lean]\n';

function parseArgs(argv) {
  const out = {
    outputDir: '', taskGlob: 'bench/tasks/subagents/smoke/*.json', taskListFile: '', taskLabel: '',
    mode: process.env.BENCH_MODE || '', ref: process.env.BENCH_SOURCE_REF || 'working-tree',
    arms: null, reps: null, armProfile: DEFAULT_ARM_PROFILE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output-dir') out.outputDir = argv[++i];
    else if (a === '--task-glob') out.taskGlob = argv[++i];
    else if (a === '--task-list-file') out.taskListFile = argv[++i];
    else if (a === '--task-label') out.taskLabel = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--ref') out.ref = argv[++i];
    else if (a === '--arms') out.arms = argv[++i];
    else if (a === '--reps') out.reps = argv[++i];
    else if (a === '--arm-profile') out.armProfile = argv[++i];
    else { process.stderr.write(USAGE); process.exit(1); }
  }
  if (!out.outputDir) { process.stderr.write(USAGE); process.exit(1); }
  return out;
}

// ---------- arm x repetition matrix (ADR-0012 outcome benchmark) ----------
// The outcome suite compares up to three ARMS of the same task — `native`
// (no plugin loaded), `legacy` (plugin, legacy workflow profile) and `lean`
// (plugin, lean workflow profile) — over PAIRED REPETITIONS. This
// orchestrator owns the execution side of that matrix:
//
//   * the arms of a task come from the task's own `arms` declaration (or from
//     --arms, which is intersected with that declaration);
//   * every (task, arm) pair is executed `--reps` times (default
//     MIN_LIVE_REPS for arm-matrix tasks), each repetition in its own FRESH
//     work area with its own result.json;
//   * the runner child sees BENCH_ARM / BENCH_REP, plus
//     BENCH_DISABLE_PLUGIN=1 for the no-plugin `native` arm and
//     AGNTHIVE_WORKFLOW_PROFILE for the plugin arms (the plugin reads the
//     profile from that variable — see plugins/agnthive/modules/
//     plugin-config.mjs resolveWorkflowProfile);
//   * every summary task entry carries its `arm` and `rep`, and the run
//     writes one summary per arm (<output-dir>/arms/<arm>/summary.json) so
//     the suite emitter (bench/tasks/outcomes/tools/emit-outcome-metrics.mjs),
//     which takes ONE arm per run directory, can be pointed at a single arm.
//
// The helpers below are pure so the matrix contract stays unit-testable
// without spawning a runner.

// The workflow profile of the default arm (the arm a task runs on when it
// declares no arm matrix of its own) and the fallback for plugin arms. 'lean'
// is the only profile the plugin runs, so that is what a run reports.
export const DEFAULT_ARM_PROFILE = 'lean';

// Parse --arms: a comma-separated subset of the suite arms.
export function parseArmsFlag(value) {
  if (value === undefined || value === null || value === '') return { ok: true, arms: null };
  const list = Array.isArray(value) ? value : String(value).split(',');
  const arms = [];
  for (const raw of list) {
    const arm = String(raw).trim();
    if (arm === '') continue;
    if (!SUITE_ARMS.includes(arm)) {
      return { ok: false, error: `unknown arm "${arm}" (suite arms: ${SUITE_ARMS.join('|')})` };
    }
    if (!arms.includes(arm)) arms.push(arm);
  }
  if (arms.length === 0) return { ok: false, error: '--arms needs at least one arm' };
  return { ok: true, arms };
}

// Parse --reps: a positive integer (default MIN_LIVE_REPS).
export function parseRepsFlag(value) {
  if (value === undefined || value === null || value === '') return { ok: true, reps: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return { ok: false, error: `--reps must be a positive integer (got "${value}")` };
  return { ok: true, reps: n };
}

// Parse --arm-profile: the workflow profile of the default arm.
export function parseArmProfileFlag(value) {
  if (value === undefined || value === null || value === '') return { ok: true, profile: DEFAULT_ARM_PROFILE };
  const profile = String(value).trim();
  if (profile !== 'legacy' && profile !== 'lean') {
    return { ok: false, error: `--arm-profile must be legacy or lean (got "${value}")` };
  }
  return { ok: true, profile };
}

// The workflow profile a plugin arm runs with. The arm names the profile it
// stands for (legacy arm -> legacy profile, lean arm -> lean profile); the
// native arm loads NO plugin and therefore has no profile at all.
export function profileForArm(arm) {
  if (arm === 'native') return null;
  if (arm === 'lean') return 'lean';
  if (arm === 'legacy') return 'legacy';
  return null;
}

/**
 * The arms ONE task runs on.
 *
 * A task that declares its own `arms` runs the intersection of the requested
 * arms (--arms) with its declaration: the suite contract says a task declares
 * the arms it runs on, so an arm the task does not declare is NOT executed
 * for it (the gap stays visible as an unexecuted task, never as a pass).
 * A task that declares no arms runs the requested arms, or the default arm
 * (named by --arm-profile) when no arms were requested.
 */
export function resolveTaskArms(task, requestedArms, defaultArm) {
  const declared = Array.isArray(task && task.arms) ? task.arms.filter((a) => SUITE_ARMS.includes(a)) : [];
  if (Array.isArray(requestedArms) && requestedArms.length > 0) {
    if (declared.length === 0) return requestedArms.slice();
    return requestedArms.filter((a) => declared.includes(a));
  }
  // No --arms: the run stays on ONE arm. The matrix is opt-in, so the existing
  // CI invocation (and its model spend) is unchanged, and a task that
  // declares the full arm matrix is not silently multiplied to 9 executions.
  // The declared arms still act as the FILTER whenever a matrix IS requested
  // (see the --arms branch above): an arm a task does not declare is never
  // executed for it.
  return [defaultArm];
}

/**
 * The repetitions ONE task runs per arm.
 *
 * --reps wins when given. Otherwise an arm-matrix run (the task declares arms
 * or the operator asked for arms) repeats MIN_LIVE_REPS times, so the suite
 * gate can compare paired repetitions; a single-arm compatibility run keeps
 * its historical ONE execution per task, so the existing CI invocation does
 * not silently multiply its model spend.
 */
export function resolveTaskReps(task, requestedReps, inMatrix) {
  if (Number.isInteger(requestedReps) && requestedReps > 0) return requestedReps;
  return inMatrix ? MIN_LIVE_REPS : 1;
}

/**
 * The environment additions for one (task, arm, rep) cell.
 *
 * BENCH_ARM / BENCH_REP identify the cell for the runner and for the suite
 * emitter. The native arm is the NO-PLUGIN baseline: BENCH_DISABLE_PLUGIN=1
 * tells the runner not to load the plugin. Plugin arms get
 * AGNTHIVE_WORKFLOW_PROFILE (the profile the plugin reads) and no
 * BENCH_DISABLE_PLUGIN, so an inherited value cannot silently disable the
 * plugin of a plugin arm.
 */
export function cellEnv(arm, rep) {
  const env = { BENCH_ARM: arm, BENCH_REP: String(rep) };
  if (arm === 'native') env.BENCH_DISABLE_PLUGIN = '1';
  else env.AGNTHIVE_WORKFLOW_PROFILE = profileForArm(arm);
  return env;
}

const REQUIRED_RESULT_FIELDS = ['completed', 'verification_required', 'tests_run', 'tests_passed', 'review_required', 'review_present', 'docs_required', 'docs_updated', 'policy_violations', 'tool_failures', 'runtime_seconds'];

function validateResult(result) {
  if (!result.task_id || !result.status || !result.notes) return false;
  for (const f of REQUIRED_RESULT_FIELDS) if (!(f in result)) return false;
  return true;
}
// ---------- outcome suite staging (BLOCK 2 + M4, @cr 0.4.0 fix-first) ----------
// Outcome tasks gate live predicates on pinned seed files. Validate the task
// contract with the schema module (M4), then copy each pinned seed into the
// run workarea and sha256-verify it before the agent spawns; a drifted or
// tampered pin fails with a clear code instead of running with unsatisfiable
// live predicates.
const OUTCOME_SUITE_DIR = join(REPO_ROOT, 'bench', 'tasks', 'outcomes');
const OUTCOME_FIXTURES_DIR = join(REPO_ROOT, 'bench', 'fixtures');

// Returns {ok:true} or {ok:false, code, detail}; never reads agent output.
function stageOutcomeTask(task, taskFile, taskWorkdir) {
  if (task.suite === 'outcomes') {
    const v = validateOutcomeTask(task, { taskPath: relPath(REPO_ROOT, taskFile), suiteDir: OUTCOME_SUITE_DIR, fixturesDir: OUTCOME_FIXTURES_DIR });
    if (!v.ok) return { ok: false, code: 'outcome_task_validation_failed', detail: 'schema violations: ' + v.errors.slice(0, 3).join('; ') };
  }
  const workdirAbs = resolve(taskWorkdir);
  const workPrefix = workdirAbs + sep;
  for (const seed of Array.isArray(task.seed_files) ? task.seed_files : []) {
    const source = typeof seed.source === 'string' ? seed.source : '';
    const destRel = typeof seed.path === 'string' ? seed.path : '';
    if (!source || !destRel) {
      return { ok: false, code: 'seed_staging_rejected', detail: 'seed_files entries need source and path strings' };
    }
    const src = resolve(OUTCOME_SUITE_DIR, source);
    const dest = resolve(workdirAbs, destRel);
    if (src !== OUTCOME_SUITE_DIR && !src.startsWith(OUTCOME_SUITE_DIR + sep)) {
      return { ok: false, code: 'seed_staging_rejected', detail: 'seed source escapes the outcome suite dir: ' + source };
    }
    if (!dest.startsWith(workPrefix)) {
      return { ok: false, code: 'seed_staging_rejected', detail: 'seed path escapes the task workdir: ' + destRel };
    }
    if (!existsSync(src)) {
      return { ok: false, code: 'seed_missing', detail: 'seed source missing under the outcome suite dir: ' + source };
    }
    const digest = createHash('sha256').update(readFileSync(src)).digest('hex');
    if (digest !== seed.sha256) {
      return { ok: false, code: 'seed_integrity_mismatch', detail: 'seed ' + source + ' sha256 mismatch (task may drift from the pinned seed)' };
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    const stagedDigest = createHash('sha256').update(readFileSync(dest)).digest('hex');
    if (stagedDigest !== seed.sha256) {
      rmSync(dest, { force: true });
      return { ok: false, code: 'seed_integrity_mismatch', detail: 'staged seed ' + seed.path + ' failed sha256 verification; removed' };
    }
  }
  return { ok: true };
}

// Synthetic failed result so a staged-out task still lands in the summary
// (kept consistent with the selected/executed/unresolved slice arithmetic).
function syntheticFailureResult(taskId, code, detail) {
  return {
    task_id: taskId,
    status: 'failed',
    notes: code + ': ' + detail,
    completed: false,
    verification_required: true,
    tests_run: false,
    tests_passed: false,
    review_required: true,
    review_present: false,
    docs_required: false,
    docs_updated: false,
    policy_violations: 0,
    tool_failures: 0,
    runtime_seconds: 0,
    changed_files: [],
  };
}

function fallbackTaskId(p) {
  // Deterministic, filesystem-safe id for tasks whose JSON cannot be read.
  // basename() (not a relPath + split('/')) so the id is stable on win32,
  // where a cross-drive relative() keeps backslashes and abs shape.
  const base = (basename(p) || 'task').replace(/\.json$/i, '').replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase();
  return 'task-' + base;
}

// A task id becomes a DIRECTORY name under the run output, and a task id is
// untrusted input: it comes from a task file, not from a trusted source.
// Two hazards follow, and both are silent:
//   - traversal: an id like "../../elsewhere" makes the artifacts land OUTSIDE
//     the run directory, so a task can write into an arbitrary location;
//   - length: a long id exceeds the 255-byte filename limit, and mkdir/unlink
//     then throws ENAMETOOLONG and aborts the WHOLE run - including the tasks
//     that were fine - instead of failing just that one task.
// A SAFE id (plain characters, no separators, short enough) is used verbatim,
// so the historical artifact paths stay byte-for-byte the same and the CI
// artifact layout does not move. Only an unsafe id is rewritten, to a
// readable slug plus a digest of the original id: the digest keeps the
// mapping collision-free and deterministic, so the same task always lands in
// the same directory and two different ids never share one.
// The REPORTED task id is untouched: summary.json and result.json keep the
// original id, so the emitter and the reports still name the real task.
const MAX_DIR_NAME = 60;
const SAFE_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

function taskDirName(taskId) {
  const raw = String(taskId == null ? '' : taskId);
  // ".." is rejected by the regex above (it starts with a dot), but a name
  // that merely CONTAINS ".." is harmless; the check is only about the
  // segment as a whole.
  if (SAFE_TASK_ID_RE.test(raw)) return raw;
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const slug = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')      // no leading dot/dash: no "." / ".." segments
    .replace(/-+$/, '')
    .slice(0, MAX_DIR_NAME)
    .replace(/[.-]+$/, '');
  return (slug || 'task') + '-' + digest;
}

// Summary builder.
//
// `cells` are the executed (task, arm, rep) records; every cell is stamped
// with its `arm` and `rep`, so the suite emitter can pair repetitions across
// arms and count them per (arm, task). `scope` carries the planned-cell
// accounting for the scope (the whole run, or ONE arm), so a matrix run
// reports coverage honestly instead of pretending every planned repetition
// ran. The counters count EXECUTIONS (cells), the id lists name tasks.
function buildSummary(args, mode, runnerDescription, cells, scope) {
  const tasks = cells.map((c) => ({ ...c.result, arm: c.arm, rep: c.rep }));
  const total = tasks.length;
  const countWhere = (pred) => tasks.filter(pred).length;
  const gitSha = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' });
  const sourceSha = gitSha.status === 0 ? gitSha.stdout.trim() : 'unknown';
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const taskLabel = args.taskLabel || (args.taskListFile ? `task-list:${args.taskListFile.split('/').pop()}` : args.taskGlob);

  const passed = countWhere((t) => t.status === 'passed');
  const cleanPassed = countWhere((t) => t.status === 'passed' && t.recovered_nonzero_exit !== true && (t.summary_repaired_by || 'none') === 'none');
  const unexecutedCells = Math.max(0, scope.plannedCells - total);
  const unresolvedTaskPaths = [...scope.failedTaskPaths, ...scope.unexecutedTaskPaths];
  const unresolvedTaskIds = [...scope.failedTaskIds, ...scope.unexecutedTaskIds];

  const summary = {
    schema_version: '1.0',
    mode,
    runner: runnerDescription,
    generated_at: generatedAt,
    source_ref: args.ref,
    source_sha: sourceSha,
    task_glob: taskLabel,
    selected_task_paths: scope.selectedTaskPaths,
    selected_task_ids: scope.selectedTaskIds,
    executed_task_paths: scope.executedTaskPaths,
    executed_task_ids: scope.executedTaskIds,
    unexecuted_task_paths: scope.unexecutedTaskPaths,
    unexecuted_task_ids: scope.unexecutedTaskIds,
    unresolved_task_paths: unresolvedTaskPaths,
    unresolved_task_ids: unresolvedTaskIds,
    totals: {
      configured_tasks: scope.plannedCells,
      selected_tasks: scope.selectedTaskPaths.length,
      executed_tasks: total,
      unexecuted_tasks: unexecutedCells,
      unresolved_tasks: unresolvedTaskPaths.length,
      tasks: total,
      passed,
      clean_passed: cleanPassed,
      completed: countWhere((t) => t.completed === true),
      verification_required: countWhere((t) => t.verification_required === true),
      tests_run: countWhere((t) => t.tests_run === true),
      tests_passed: countWhere((t) => t.tests_passed === true),
      review_required: countWhere((t) => t.review_required === true),
      review_present: countWhere((t) => t.review_present === true),
      docs_required: countWhere((t) => t.docs_required === true),
      docs_updated: countWhere((t) => t.docs_updated === true),
      recovered_tasks: countWhere((t) => t.recovered_nonzero_exit === true),
      timeout_recovered: countWhere((t) => t.timeout_recovered === true),
      max_turns_recovered: countWhere((t) => t.max_turns_recovered === true),
      summary_repaired: countWhere((t) => (t.summary_repaired_by || 'none') !== 'none'),
      policy_violations: tasks.reduce((s, t) => s + Number(t.policy_violations || 0), 0),
      tool_failures: tasks.reduce((s, t) => s + Number(t.tool_failures || 0), 0),
    },
    rates: {
      task_pass_rate: rate(passed, total),
      clean_pass_rate: rate(cleanPassed, total),
      completion_rate: rate(countWhere((t) => t.completed === true), total),
      verification_rate: rate(countWhere((t) => t.verification_required === false || t.tests_run === true), total),
      verification_pass_rate: rate(countWhere((t) => t.verification_required === false || t.tests_passed === true), total),
      review_compliance_rate: rate(countWhere((t) => t.review_required === false || t.review_present === true), total),
      docs_compliance_rate: rate(countWhere((t) => t.docs_required === false || t.docs_updated === true), total),
      recovered_task_rate: rate(countWhere((t) => t.recovered_nonzero_exit === true), total),
      summary_repair_rate: rate(countWhere((t) => (t.summary_repaired_by || 'none') !== 'none'), total),
      execution_coverage_rate: rate(total, scope.plannedCells),
      unexecuted_rate: rate(unexecutedCells, scope.plannedCells),
      unresolved_rate: rate(unresolvedTaskPaths.length, scope.selectedTaskPaths.length),
    },
    median_runtime_seconds: median(tasks.map((t) => Number(t.runtime_seconds))),
    tasks,
  };
  return summary;
}

export function run(args) {
  const opts = args || parseArgs(process.argv.slice(2));
  // The Claude Code CLI keeps a background daemon in the session's process
  // group. When that daemon hits the filesystem race on the shared
  // ~/.claude/state lock file it aborts with a C++ filesystem_error, and the
  // abort signal reaches the WHOLE process group - including this
  // orchestrator, which can be killed while it is setting up the next cell.
  // A Node process never raises SIGABRT on its own (a JS error exits 1 with a
  // stack trace), so a SIGABRT here always comes from the child side.
  // Catching it keeps the orchestrator alive: the affected cell is reported
  // as a failed cell and the rest of the matrix still runs.
  process.on('SIGABRT', () => {
    process.stderr.write('run-benchmark: SIGABRT received (a child crashed) - the affected cell is recorded as failed\n');
  });
  let projectClaudeDir = process.env.BENCH_CLAUDE_PROFILE_DIR || '';
  if (!projectClaudeDir) {
    projectClaudeDir = existsSync(join(process.env.HOME || '', '.claude')) ? join(process.env.HOME, '.claude') : join(REPO_ROOT, '.claude');
  }
  mkdirSync(join(process.env.HOME || '', '.claude'), { recursive: true });
  mkdirSync(join(process.env.HOME || '', '.claude', 'state'), { recursive: true });
  mkdirSync(join(process.env.HOME || '', '.claude', 'logs'), { recursive: true });

  if (opts.taskListFile && opts.taskGlob && opts.taskGlob !== 'bench/tasks/subagents/smoke/*.json') {
    process.stderr.write('Usage: pass either --task-glob or --task-list-file, not both\n'); process.exit(1);
  }

  let mode = opts.mode;
  if (!mode) mode = process.env.BENCH_RUNNER_CMD ? 'command' : 'mock';
  let runnerArgv, runnerDescription;
  if (mode === 'mock') {
    runnerArgv = [process.execPath, join(REPO_ROOT, 'scripts', 'mock-benchmark-runner.mjs')];
    runnerDescription = 'mock-benchmark-runner';
  } else if (mode === 'command') {
    const cmd = process.env.BENCH_RUNNER_CMD;
    if (!cmd) { process.stderr.write('BENCH_RUNNER_CMD is required in command mode\n'); process.exit(1); }
    runnerArgv = cmd.split(/\s+/).filter(Boolean);
    runnerDescription = cmd;
  } else {
    process.stderr.write(`Unsupported benchmark mode: ${mode}\n`); process.exit(1);
  }

  mkdirSync(join(opts.outputDir, 'tasks'), { recursive: true });

  let taskFiles = [];
  if (opts.taskListFile) {
    if (!existsSync(opts.taskListFile)) { process.stderr.write(`Task list file does not exist: ${opts.taskListFile}\n`); process.exit(1); }
    const raw = readFileSync(opts.taskListFile, 'utf-8');
    for (let line of raw.split('\n')) {
      line = line.trim();
      if (!line) continue;
      // isAbsolute (not startsWith('/')) so Windows drive-absolute task paths
      // (C:\...) are used as-is instead of re-joined under REPO_ROOT, which
      // would yield an invalid concatenated path.
      taskFiles.push(isAbsolute(line) ? line : join(REPO_ROOT, line));
    }
  } else {
    taskFiles = globMatch(opts.taskGlob, REPO_ROOT);
  }
  const configuredTaskCount = taskFiles.length;
  if (taskFiles.length === 0) {
    const where = opts.taskListFile ? `task list file: ${opts.taskListFile}` : `glob: ${opts.taskGlob}`;
    process.stderr.write(`No benchmark tasks matched ${where}\n`); process.exit(1);
  }

  const taskLabel = opts.taskLabel || (opts.taskListFile ? `task-list:${opts.taskListFile.split('/').pop()}` : opts.taskGlob);

  const selectedTaskPaths = [];
  const selectedTaskIds = [];
  for (const tf of taskFiles) {
    selectedTaskPaths.push(relativeTaskPath(tf));
    // Malformed task JSON must not crash selection; the per-task loop
    // records it as a synthetic failed task.
    let selectedId = null;
    try { selectedId = readJson(tf).id; } catch { selectedId = null; }
    selectedTaskIds.push(typeof selectedId === 'string' && selectedId ? selectedId : fallbackTaskId(tf));
  }

  // ---------- arm x repetition plan ----------
  // The matrix is resolved BEFORE the first spawn: a task's arms come from
  // its own declaration (intersected with --arms), and the repetition count
  // follows the suite floor for a matrix run. Planning up front keeps the
  // accounting honest - a cell that is planned but never executed shows up
  // as unexecuted instead of disappearing.
  const armsFlag = parseArmsFlag(opts.arms);
  if (!armsFlag.ok) { process.stderr.write(`Invalid --arms: ${armsFlag.error}\n`); process.exit(1); }
  const repsFlag = parseRepsFlag(opts.reps);
  if (!repsFlag.ok) { process.stderr.write(`Invalid --reps: ${repsFlag.error}\n`); process.exit(1); }
  const profileFlag = parseArmProfileFlag(opts.armProfile);
  if (!profileFlag.ok) { process.stderr.write(`Invalid --arm-profile: ${profileFlag.error}\n`); process.exit(1); }
  const defaultArm = profileFlag.profile;

  const failFast = process.env.BENCH_FAIL_FAST === '1' || process.env.BENCH_FAIL_FAST === 'true';

  const plans = [];
  for (const taskFile of taskFiles) {
    let task = null;
    let taskParseError = null;
    try { task = readJson(taskFile); } catch (e) { taskParseError = String((e && e.message) || e); }
    if (task === null || typeof task !== 'object') {
      // A malformed task cannot declare arms: it gets the default arm and a
      // single repetition, and fails synthetically when it is executed.
      plans.push({
        taskFile, malformed: true, parseError: taskParseError,
        taskId: fallbackTaskId(taskFile), taskPathRel: relativeTaskPath(taskFile),
        arms: [defaultArm], reps: 1,
      });
      continue;
    }
    const taskArms = resolveTaskArms(task, armsFlag.arms, defaultArm);
    plans.push({
      taskFile, malformed: false, task,
      taskId: task.id, taskPathRel: relativeTaskPath(taskFile),
      category: task.category, fixtureName: task.fixture,
      arms: taskArms,
      reps: resolveTaskReps(task, repsFlag.reps, taskArms.length > 1),
    });
  }
  // A matrix run (more than one arm, or more than one repetition) writes one
  // summary per arm so the suite emitter - which takes ONE arm per run
  // directory - can be pointed at a single arm. A single-arm, single-
  // repetition run keeps the historical flat layout, so the existing CI
  // invocation and its artifact paths are unchanged.
  const matrixMode = plans.some((p) => p.arms.length > 1) || plans.some((p) => p.reps > 1);
  const plannedCells = plans.reduce((n, p) => n + p.arms.length * p.reps, 0);

  // One executed cell per (task, arm, repetition). Every cell gets a FRESH
  // work area and its own result.json, so repetitions never share state.
  const cells = [];
  const perArmCells = new Map();   // arm -> cells of that arm
  const executedTaskPaths = new Set();
  const executedTaskIds = new Set();
  const failedTaskPaths = new Set();
  const failedTaskIds = new Set();
  const unexecutedTaskPaths = [];
  const unexecutedTaskIds = [];
  // Cells whose runner could not run at all (crash/signal/missing result).
  // They are reported as failed cells like any other failure, and they also
  // keep the process exit code non-zero: an infrastructure failure must never
  // look like a clean run.
  const runnerInfrastructureFailures = [];
  let stopped = false;

  for (const plan of plans) {
    if (stopped) break;
    const { taskFile, malformed, parseError, task, taskId, taskPathRel } = plan;
    const category = malformed ? 'unknown' : plan.category;
    const fixtureName = malformed ? '' : plan.fixtureName;
    const fixtureDir = malformed ? '' : join(REPO_ROOT, 'bench', 'fixtures', fixtureName);
    if (!malformed && !existsSync(fixtureDir)) { process.stderr.write(`Missing benchmark fixture directory: ${fixtureDir}\n`); process.exit(1); }

    for (const arm of plan.arms) {
      if (stopped) break;
      for (let rep = 1; rep <= plan.reps; rep++) {
        if (stopped) break;
        // A matrix run keeps one directory per arm; the flat layout is kept
        // for a single-arm, single-repetition run so the existing CI artifact
        // paths (and the staging test's expectations) stay valid.
        const armRoot = matrixMode ? join(opts.outputDir, 'arms', arm) : opts.outputDir;
        // The directory NAME is derived from the task id, the reported id is
        // not: an unsafe id must not steer the artifacts out of the run
        // directory or abort the run with ENAMETOOLONG.
        const dirName = taskDirName(taskId);
        const cellDir = matrixMode
          ? join(armRoot, 'tasks', dirName, 'rep-' + String(rep))
          : join(armRoot, 'tasks', dirName);
        const taskWorkdir = join(cellDir, 'workdir');

        rmSync(cellDir, { recursive: true, force: true });
        mkdirSync(taskWorkdir, { recursive: true });

        let result = null;
        if (malformed) {
          // Malformed task JSON (LOW a/M4) becomes a synthetic failed task so
          // the run continues and the task stays visible as unresolved — never
          // a crash.
          result = syntheticFailureResult(taskId, 'outcome_task_validation_failed', 'task JSON could not be parsed: ' + (parseError || 'task is not a JSON object'));
          writeJson(join(cellDir, 'result.json'), result);
          process.stdout.write(`Staging failed for task: ${taskId} (outcome_task_validation_failed)\n`);
        } else {
          cpSync(fixtureDir, taskWorkdir, { recursive: true });
          if (existsSync(projectClaudeDir)) {
            mkdirSync(join(taskWorkdir, '.claude'), { recursive: true });
            cpSync(projectClaudeDir, join(taskWorkdir, '.claude'), { recursive: true });
          }

          // BLOCK 2/M4: validate the task contract and stage pinned seeds into
          // the workarea before the agent spawns; staging failure = synthetic
          // failure.
          const staged = stageOutcomeTask(task, taskFile, taskWorkdir);
          if (!staged.ok) {
            process.stdout.write(`Staging failed for task: ${taskId} (${staged.code}: ${staged.detail})\n`);
            result = syntheticFailureResult(taskId, staged.code, staged.detail);
            writeJson(join(cellDir, 'result.json'), result);
          } else {
            const childEnv = {
              ...process.env,
              ...cellEnv(arm, rep),
              BENCH_TASK_FILE: taskFile,
              BENCH_TASK_ID: taskId,
              BENCH_OUTPUT_DIR: cellDir,
              BENCH_WORKDIR: taskWorkdir,
              BENCH_FIXTURE_DIR: fixtureDir,
              BENCH_REPO_ROOT: REPO_ROOT,
            };

            process.stdout.write(`=== Benchmark task: ${taskId} (arm: ${arm}, rep: ${rep}) ===\n`);
            process.stdout.write(`Runner: ${runnerDescription}\n`);
            process.stdout.write(`Category: ${category}\n`);
            process.stdout.write(`Fixture: ${fixtureName}\n`);
            process.stdout.write(`Task file: ${taskFile}\n`);
            process.stdout.write(`Workdir: ${taskWorkdir}\n`);
            process.stdout.write(`Model: ${process.env.OLLAMA_MODEL || '<unset>'}\n`);
            process.stdout.write(`Max output tokens: ${process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '<unset>'}\n`);

            // A runner that dies (crash, signal, missing result) must not
            // destroy the rest of the matrix: the cell becomes a FAILED cell
            // and the remaining cells keep running. One retry absorbs the
            // known infrastructure flake - a concurrent Claude Code session can
            // abort the child with a filesystem error on the shared
            // ~/.claude/state - without hiding it: an infrastructure failure
            // still leaves the process exit code non-zero at the end.
            const maxRunnerAttempts = matrixMode ? 2 : 1;
            let runnerProblem = null;
            for (let attempt = 1; attempt <= maxRunnerAttempts && result === null; attempt++) {
              const res = spawnSync(runnerArgv[0], runnerArgv.slice(1), { stdio: 'inherit', env: childEnv });
              const resultPath = join(cellDir, 'result.json');
              if (res.status === 0) {
                let candidate = null;
                try { candidate = existsSync(resultPath) ? readJson(resultPath) : null; } catch { candidate = null; }
                if (candidate && validateResult(candidate)) {
                  result = candidate;
                  runnerProblem = null;
                } else {
                  runnerProblem = candidate ? 'result.json is missing required fields' : 'runner did not produce result.json';
                }
              } else if (res.signal) {
                runnerProblem = `runner was killed by ${res.signal}`;
              } else {
                runnerProblem = `runner exited with code ${res.status}`;
              }
              if (result !== null) break;
              process.stderr.write(`Benchmark runner problem for task: ${taskId} (arm: ${arm}, rep: ${rep}) - ${runnerProblem}\n`);
              if (attempt < maxRunnerAttempts) {
                process.stderr.write(`Retrying the cell (attempt ${attempt + 1} of ${maxRunnerAttempts})\n`);
                // A crashed attempt can leave a half-written workdir and a
                // stale result.json: reset both so the repeated cell starts
                // from the same state the first attempt had.
                rmSync(join(cellDir, 'result.json'), { force: true });
                rmSync(taskWorkdir, { recursive: true, force: true });
                mkdirSync(taskWorkdir, { recursive: true });
                cpSync(fixtureDir, taskWorkdir, { recursive: true });
                if (existsSync(projectClaudeDir)) {
                  mkdirSync(join(taskWorkdir, '.claude'), { recursive: true });
                  cpSync(projectClaudeDir, join(taskWorkdir, '.claude'), { recursive: true });
                }
                const restaged = stageOutcomeTask(task, taskFile, taskWorkdir);
                if (!restaged.ok) { runnerProblem = restaged.code + ': ' + restaged.detail; break; }
              }
            }
            if (result === null) {
              result = syntheticFailureResult(taskId, 'runner_failed', runnerProblem || 'benchmark runner failed');
              writeJson(join(cellDir, 'result.json'), result);
              runnerInfrastructureFailures.push({ task: taskId, arm, rep, reason: runnerProblem });
            }
          }
        }

        cells.push({ arm, rep, result });
        if (!perArmCells.has(arm)) perArmCells.set(arm, []);
        perArmCells.get(arm).push({ arm, rep, result });
        executedTaskPaths.add(taskPathRel);
        executedTaskIds.add(taskId);
        if (result.status !== 'passed') {
          failedTaskPaths.add(taskPathRel);
          failedTaskIds.add(taskId);
        }

        const summaryPath = join(cellDir, 'task-summary.txt');
        if (existsSync(summaryPath)) {
          process.stdout.write(readFileSync(summaryPath, 'utf-8'));
        } else {
          process.stdout.write(`Status: ${result.status}\n`);
          process.stdout.write(`Changed files: ${(result.changed_files || []).join(', ')}\n`);
          process.stdout.write(`Notes: ${result.notes}\n`);
        }
        process.stdout.write('Structured result:\n');
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');

        if (result.status !== 'passed' && failFast) {
          process.stdout.write(`Fail-fast enabled; stopping benchmark after first failing task: ${taskId}\n`);
          stopped = true;
          break;
        }
      }
    }
  }

  // Everything planned but not executed (fail-fast stopped the run) stays
  // visible as unexecuted — never as a pass.
  for (const plan of plans) {
    if (!executedTaskIds.has(plan.taskId)) {
      unexecutedTaskPaths.push(plan.taskPathRel);
      unexecutedTaskIds.push(plan.taskId);
    }
  }

  // The run-level scope: every planned cell, with the task-level id lists.
  const scope = {
    plannedCells,
    selectedTaskPaths,
    selectedTaskIds,
    executedTaskPaths: [...executedTaskPaths],
    executedTaskIds: [...executedTaskIds],
    unexecutedTaskPaths,
    unexecutedTaskIds,
    failedTaskPaths: [...failedTaskPaths],
    failedTaskIds: [...failedTaskIds],
  };
  const summary = buildSummary(opts, mode, runnerDescription, cells, scope);
  writeJson(join(opts.outputDir, 'summary.json'), summary);
  process.stdout.write(`Benchmark summary written to ${opts.outputDir}/summary.json\n`);

  // Per-arm summaries: the suite emitter takes ONE arm per run directory, so
  // a matrix run writes one summary per arm next to that arm's artifacts.
  // The emitter is then pointed at <output-dir>/arms/<arm>.
  if (matrixMode) {
    for (const [arm, armCells] of perArmCells) {
      const armScope = {
        plannedCells: armCells.length,
        selectedTaskPaths: [...new Set(armCells.map((c) => c.result.task_path).filter(Boolean))],
        selectedTaskIds: [...new Set(armCells.map((c) => c.result.task_id).filter(Boolean))],
        executedTaskPaths: [...new Set(armCells.map((c) => c.result.task_path).filter(Boolean))],
        executedTaskIds: [...new Set(armCells.map((c) => c.result.task_id).filter(Boolean))],
        unexecutedTaskPaths: [],
        unexecutedTaskIds: [],
        failedTaskPaths: [...new Set(armCells.filter((c) => c.result.status !== 'passed').map((c) => c.result.task_path).filter(Boolean))],
        failedTaskIds: [...new Set(armCells.filter((c) => c.result.status !== 'passed').map((c) => c.result.task_id).filter(Boolean))],
      };
      const armSummary = buildSummary(opts, mode, runnerDescription, armCells, armScope);
      armSummary.arm = arm;
      const armDir = join(opts.outputDir, 'arms', arm);
      mkdirSync(armDir, { recursive: true });
      writeJson(join(armDir, 'summary.json'), armSummary);
      writeFileSync(join(armDir, 'benchmark-report.md'), renderSummary(armSummary), 'utf-8');
      process.stdout.write(`Arm summary written to ${join(armDir, 'summary.json')} (${armCells.length} cell(s))\n`);
    }
  }

  const report = renderSummary(summary);
  const reportPath = join(opts.outputDir, 'benchmark-report.md');
  writeFileSync(reportPath, report, 'utf-8');
  process.stdout.write(`Benchmark markdown report written to ${reportPath}\n`);
  process.stdout.write(report);
  process.stdout.write('Benchmark totals:\n');
  process.stdout.write(`- configured tasks: ${summary.totals.configured_tasks}\n`);
  process.stdout.write(`- executed tasks: ${summary.totals.executed_tasks}\n`);
  process.stdout.write(`- execution coverage: ${summary.rates.execution_coverage_rate}\n`);
  process.stdout.write(`- unexecuted tasks: ${summary.totals.unexecuted_tasks}\n`);
  process.stdout.write(`- unresolved tasks: ${summary.totals.unresolved_tasks}\n`);
  process.stdout.write(`- tasks: ${summary.totals.tasks}\n`);
  process.stdout.write(`- passed: ${summary.totals.passed}\n`);
  process.stdout.write(`- clean_passed: ${summary.totals.clean_passed}\n`);
  process.stdout.write(`- recovered_tasks: ${summary.totals.recovered_tasks}\n`);
  process.stdout.write(`- summary_repaired: ${summary.totals.summary_repaired}\n`);
  process.stdout.write(`- tool_failures: ${summary.totals.tool_failures}\n`);
  process.stdout.write(`- task_pass_rate: ${summary.rates.task_pass_rate}\n`);
  process.stdout.write(`- clean_pass_rate: ${summary.rates.clean_pass_rate}\n`);
  process.stdout.write(`- recovered_task_rate: ${summary.rates.recovered_task_rate}\n`);
  process.stdout.write(`- summary_repair_rate: ${summary.rates.summary_repair_rate}\n`);
  // An infrastructure failure is reported as a failed cell AND as a non-zero
  // exit code: the artifacts are already written, so the run stays inspectable
  // while CI still sees that the matrix was not complete.
  if (runnerInfrastructureFailures.length > 0) {
    process.stderr.write(`Benchmark infrastructure failures: ${runnerInfrastructureFailures.length} cell(s) could not run\n`);
    for (const f of runnerInfrastructureFailures) {
      process.stderr.write(`- ${f.task} (arm: ${f.arm}, rep: ${f.rep}): ${f.reason}\n`);
    }
    process.exitCode = 1;
  }
  return summary;
}

if (isMain(import.meta.url)) {
  run();
}
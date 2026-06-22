#!/usr/bin/env node
// run-benchmark: orchestrates a benchmark run over a set of task files.
// Mock mode uses the Node mock runner; command mode spawns BENCH_RUNNER_CMD
// (split into an explicit argv — never a shell string).
// Node port of scripts/run-benchmark.sh — no Bash, no jq.
import { mkdirSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative as relPath, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isMain, readJson, writeJson, median, rate } from './bench/lib.mjs';
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

function parseArgs(argv) {
  const out = { outputDir: '', taskGlob: 'bench/tasks/subagents/smoke/*.json', taskListFile: '', taskLabel: '', mode: process.env.BENCH_MODE || '', ref: process.env.BENCH_SOURCE_REF || 'working-tree' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output-dir') out.outputDir = argv[++i];
    else if (a === '--task-glob') out.taskGlob = argv[++i];
    else if (a === '--task-list-file') out.taskListFile = argv[++i];
    else if (a === '--task-label') out.taskLabel = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--ref') out.ref = argv[++i];
    else { process.stderr.write(`Usage: run-benchmark.mjs --output-dir DIR [--task-glob GLOB | --task-list-file FILE] [--task-label LABEL] [--mode mock|command] [--ref REF]\n`); process.exit(1); }
  }
  if (!out.outputDir) { process.stderr.write('Usage: run-benchmark.mjs --output-dir DIR [...]\n'); process.exit(1); }
  return out;
}

const REQUIRED_RESULT_FIELDS = ['completed', 'verification_required', 'tests_run', 'tests_passed', 'review_required', 'review_present', 'docs_required', 'docs_updated', 'policy_violations', 'tool_failures', 'runtime_seconds'];

function validateResult(result) {
  if (!result.task_id || !result.status || !result.notes) return false;
  for (const f of REQUIRED_RESULT_FIELDS) if (!(f in result)) return false;
  return true;
}

function buildSummary(args, mode, runnerDescription, resultFiles, selectedTaskPaths, selectedTaskIds, executedTaskPaths, executedTaskIds, failedTaskPaths, failedTaskIds, configuredTaskCount, executedTaskCount) {
  const tasks = resultFiles.map((f) => readJson(f));
  const unexecutedTaskPaths = selectedTaskPaths.slice(executedTaskCount);
  const unexecutedTaskIds = selectedTaskIds.slice(executedTaskCount);
  const unresolvedTaskPaths = [...failedTaskPaths, ...unexecutedTaskPaths];
  const unresolvedTaskIds = [...failedTaskIds, ...unexecutedTaskIds];
  const total = tasks.length;
  const countWhere = (pred) => tasks.filter(pred).length;
  const gitSha = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' });
  const sourceSha = gitSha.status === 0 ? gitSha.stdout.trim() : 'unknown';
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const taskLabel = args.taskLabel || (args.taskListFile ? `task-list:${args.taskListFile.split('/').pop()}` : args.taskGlob);

  const passed = countWhere((t) => t.status === 'passed');
  const cleanPassed = countWhere((t) => t.status === 'passed' && t.recovered_nonzero_exit !== true && (t.summary_repaired_by || 'none') === 'none');

  const summary = {
    schema_version: '1.0',
    mode,
    runner: runnerDescription,
    generated_at: generatedAt,
    source_ref: args.ref,
    source_sha: sourceSha,
    task_glob: taskLabel,
    selected_task_paths: selectedTaskPaths,
    selected_task_ids: selectedTaskIds,
    executed_task_paths: executedTaskPaths,
    executed_task_ids: executedTaskIds,
    unexecuted_task_paths: unexecutedTaskPaths,
    unexecuted_task_ids: unexecutedTaskIds,
    unresolved_task_paths: unresolvedTaskPaths,
    unresolved_task_ids: unresolvedTaskIds,
    totals: {
      configured_tasks: configuredTaskCount,
      selected_tasks: selectedTaskPaths.length,
      executed_tasks: executedTaskCount,
      unexecuted_tasks: unexecutedTaskPaths.length,
      unresolved_tasks: unresolvedTaskPaths.length,
      tasks: executedTaskCount,
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
      execution_coverage_rate: rate(executedTaskCount, configuredTaskCount),
      unexecuted_rate: rate(unexecutedTaskPaths.length, selectedTaskPaths.length),
      unresolved_rate: rate(unresolvedTaskPaths.length, selectedTaskPaths.length),
    },
    median_runtime_seconds: median(tasks.map((t) => Number(t.runtime_seconds))),
    tasks,
  };
  return summary;
}

export function run(args) {
  const opts = args || parseArgs(process.argv.slice(2));
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
    selectedTaskIds.push(readJson(tf).id);
  }

  const resultFiles = [];
  const executedTaskPaths = [];
  const executedTaskIds = [];
  const failedTaskPaths = [];
  const failedTaskIds = [];
  let executedTaskCount = 0;
  const failFast = process.env.BENCH_FAIL_FAST === '1' || process.env.BENCH_FAIL_FAST === 'true';

  for (const taskFile of taskFiles) {
    const task = readJson(taskFile);
    const taskId = task.id;
    const taskPathRel = relativeTaskPath(taskFile);
    const category = task.category;
    const fixtureName = task.fixture;
    const fixtureDir = join(REPO_ROOT, 'bench', 'fixtures', fixtureName);
    const taskOutputDir = join(opts.outputDir, 'tasks', taskId);
    const taskWorkdir = join(taskOutputDir, 'workdir');
    if (!existsSync(fixtureDir)) { process.stderr.write(`Missing benchmark fixture directory: ${fixtureDir}\n`); process.exit(1); }

    rmSync(taskOutputDir, { recursive: true, force: true });
    mkdirSync(taskWorkdir, { recursive: true });
    cpSync(fixtureDir, taskWorkdir, { recursive: true });
    if (existsSync(projectClaudeDir)) {
      mkdirSync(join(taskWorkdir, '.claude'), { recursive: true });
      cpSync(projectClaudeDir, join(taskWorkdir, '.claude'), { recursive: true });
    }

    const childEnv = {
      ...process.env,
      BENCH_TASK_FILE: taskFile,
      BENCH_TASK_ID: taskId,
      BENCH_OUTPUT_DIR: taskOutputDir,
      BENCH_WORKDIR: taskWorkdir,
      BENCH_FIXTURE_DIR: fixtureDir,
      BENCH_REPO_ROOT: REPO_ROOT,
    };

    process.stdout.write(`=== Benchmark task: ${taskId} ===\n`);
    process.stdout.write(`Runner: ${runnerDescription}\n`);
    process.stdout.write(`Category: ${category}\n`);
    process.stdout.write(`Fixture: ${fixtureName}\n`);
    process.stdout.write(`Task file: ${taskFile}\n`);
    process.stdout.write(`Workdir: ${taskWorkdir}\n`);
    process.stdout.write(`Model: ${process.env.OLLAMA_MODEL || '<unset>'}\n`);
    process.stdout.write(`Max output tokens: ${process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '<unset>'}\n`);

    const res = spawnSync(runnerArgv[0], runnerArgv.slice(1), { stdio: 'inherit', env: childEnv });
    if (res.status !== 0) {
      process.stderr.write(`Benchmark runner failed for task: ${taskId} (exit ${res.status})\n`);
      process.exit(res.status ?? 1);
    }

    const resultPath = join(taskOutputDir, 'result.json');
    if (!existsSync(resultPath)) { process.stderr.write(`Benchmark runner did not produce result.json for task: ${taskId}\n`); process.exit(1); }
    const result = readJson(resultPath);
    if (!validateResult(result)) { process.stderr.write(`Benchmark result has missing required fields: ${resultPath}\n`); process.exit(1); }

    resultFiles.push(resultPath);
    executedTaskCount++;
    executedTaskPaths.push(taskPathRel);
    executedTaskIds.push(taskId);

    let taskFailed = false;
    if (result.status !== 'passed') {
      failedTaskPaths.push(taskPathRel);
      failedTaskIds.push(taskId);
      taskFailed = true;
    }

    const summaryPath = join(taskOutputDir, 'task-summary.txt');
    if (existsSync(summaryPath)) {
      process.stdout.write(readFileSync(summaryPath, 'utf-8'));
    } else {
      process.stdout.write(`Status: ${result.status}\n`);
      process.stdout.write(`Changed files: ${(result.changed_files || []).join(', ')}\n`);
      process.stdout.write(`Notes: ${result.notes}\n`);
    }
    process.stdout.write('Structured result:\n');
    process.stdout.write(readFileSync(resultPath, 'utf-8').replace(/\n*$/, '') + '\n');

    if (taskFailed && failFast) {
      process.stdout.write(`Fail-fast enabled; stopping benchmark after first failing task: ${taskId}\n`);
      break;
    }
  }

  const summary = buildSummary(opts, mode, runnerDescription, resultFiles, selectedTaskPaths, selectedTaskIds, executedTaskPaths, executedTaskIds, failedTaskPaths, failedTaskIds, configuredTaskCount, executedTaskCount);
  writeJson(join(opts.outputDir, 'summary.json'), summary);
  process.stdout.write(`Benchmark summary written to ${opts.outputDir}/summary.json\n`);
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
  return summary;
}

if (isMain(import.meta.url)) {
  run();
}
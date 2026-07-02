#!/usr/bin/env node
// bench-precheck: run the "Behavior Benchmark Subagents Smoke Precheck" job locally.
//
// Reproduces the deterministic steps of the `precheck` job in
// .github/workflows/behavior-benchmark-subagents-smoke.yml without a GitHub
// Actions runner: collect changed files, select subagent smoke tasks, render a
// precheck summary, validate task/fixture alignment, and build the shard
// matrix. Finally it prints a ready-to-run `make bench-smoke` command for the
// selected tasks.
//
// The changed-file collection shells out to the SAME scripts the CI uses
// (collect-benchmark-changes / select-benchmark-tasks / build-benchmark-matrix
//  / download-benchmark-summary / find-failed-benchmark-run), so local and CI
// selection stay byte-identical. No code is duplicated — this is a thin
// orchestrator that drives the existing Node CLIs.
//
// Defaults mirror the CI: event=pull_request, base-ref=main, suite=
// subagents_smoke, selection-mode=changed, max-shards=3. Resume/auto-resume
// modes additionally need network + a GITHUB_TOKEN (and gh for auto-resume),
// exactly as in CI.
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const SELECTION_MODES = new Set(['changed', 'all', 'resume', 'auto-resume']);

function parseArgs(argv) {
  const out = {
    event: 'pull_request',
    baseRef: 'main',
    refName: '',
    suite: 'subagents_smoke',
    selectionMode: 'changed',
    resumeRunId: '',
    maxShards: 3,
    maxAgeHours: 72,
    outputDir: process.env.BENCH_OUTPUT_DIR || '/tmp/claude-bench',
    runValidators: true,
    repo: '',
  };
  const need = (flag, val) => {
    if (val === undefined) { process.stderr.write(`--${flag} requires an argument\n`); process.exit(2); }
    return val;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--event') out.event = need('event', argv[++i]);
    else if (a === '--base-ref') out.baseRef = need('base-ref', argv[++i]);
    else if (a === '--ref-name') out.refName = need('ref-name', argv[++i]);
    else if (a === '--suite') out.suite = need('suite', argv[++i]);
    else if (a === '--selection-mode') out.selectionMode = need('selection-mode', argv[++i]);
    else if (a === '--resume-run-id') out.resumeRunId = need('resume-run-id', argv[++i]);
    else if (a === '--max-shards') out.maxShards = Number.parseInt(need('max-shards', argv[++i]), 10);
    else if (a === '--max-age-hours') out.maxAgeHours = Number.parseInt(need('max-age-hours', argv[++i]), 10);
    else if (a === '--output-dir') out.outputDir = need('output-dir', argv[++i]);
    else if (a === '--repo') out.repo = need('repo', argv[++i]);
    else if (a === '--no-validators') out.runValidators = false;
    else if (a === '--run-validators') out.runValidators = true;
    else if (a === '-h' || a === '--help') { printUsage(); process.exit(0); }
    else { process.stderr.write(`unknown argument: ${a}\n`); printUsage(); process.exit(2); }
  }
  if (!SELECTION_MODES.has(out.selectionMode)) {
    process.stderr.write(`--selection-mode must be one of: ${[...SELECTION_MODES].join(', ')}\n`);
    process.exit(2);
  }
  if (out.selectionMode === 'resume' && !out.resumeRunId) {
    process.stderr.write('--resume-run-id is required when --selection-mode=resume\n');
    process.exit(2);
  }
  return out;
}

function printUsage() {
  process.stdout.write(
    `Usage: bench-precheck.mjs [options]\n` +
    `  --event EVENT             pull_request (default) | workflow_dispatch\n` +
    `  --base-ref REF            base ref to diff against (default: main)\n` +
    `  --ref-name REF            current ref name (default: current git branch)\n` +
    `  --suite SUITE             task suite (default: subagents_smoke)\n` +
    `  --selection-mode MODE     changed (default) | all | resume | auto-resume\n` +
    `  --resume-run-id ID        run id for --selection-mode=resume\n` +
    `  --max-age-hours N         auto-resume lookback (default: 72)\n` +
    `  --max-shards N            shard matrix width (default: 3)\n` +
    `  --output-dir DIR          scratch dir (default: \$BENCH_OUTPUT_DIR or /tmp/claude-bench)\n` +
    `  --repo OWNER/NAME         repo for resume modes (default: parsed from origin)\n` +
    `  --no-validators           skip the task/fixture alignment validator step\n` +
    `  -h, --help\n`,
  );
}

function node(args, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function gitOut(argv) {
  const r = spawnSync('git', argv, { cwd: repoRoot, encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function currentBranch() {
  return gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
}

function defaultRepo() {
  const fromEnv = (process.env.GITHUB_REPOSITORY || '').trim();
  if (fromEnv) return fromEnv;
  const url = gitOut(['config', '--get', 'remote.origin.url']);
  // ssh: git@github.com:OWNER/NAME[.git]  https: https://github.com/OWNER/NAME[.git]
  const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : '';
}

function banner(lines) {
  const bar = '─'.repeat(60);
  process.stdout.write(`\n${bar}\n${lines.join('\n')}\n${bar}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const refName = args.refName || currentBranch();
  const repo = args.repo || defaultRepo();
  mkdirSync(args.outputDir, { recursive: true });

  const changedFile = join(args.outputDir, '.bench-changed-files.txt');
  const selectedFile = join(args.outputDir, '.bench-selected-tasks.txt');
  const prevSummaryFile = join(args.outputDir, '.bench-previous-summary.json');
  const failedRunFile = join(args.outputDir, '.bench-failed-run.txt');

  // --- step 1: collect changed files (skipped for --all) ---------------------
  if (args.selectionMode !== 'all') {
    banner([`## Behavior Benchmark Subagents Smoke Precheck`, ``, `Collecting changed files…`]);
    const r = node([
      join('scripts', 'collect-benchmark-changes.mjs'),
      '--event', args.event,
      '--output', changedFile,
      '--base-ref', args.baseRef,
      '--ref-name', refName,
    ]);
    if (r.status !== 0) {
      process.stderr.write(`collect-benchmark-changes failed:\n${r.stderr}\n`);
      process.exit(1);
    }
    process.stdout.write(r.stdout);
  } else {
    writeFileSync(changedFile, '', 'utf-8');
  }

  // --- step 2: select tasks -------------------------------------------------
  const selectArgs = [
    join('scripts', 'select-benchmark-tasks.mjs'),
    '--suite', args.suite,
    '--selection-mode', args.selectionMode === 'auto-resume' ? 'resume' : args.selectionMode,
    '--changed-files-file', changedFile,
  ];

  // Resume modes: resolve a previous summary first (needs network + GITHUB_TOKEN).
  let resumeSourceRunId = '';
  if (args.selectionMode === 'resume' || args.selectionMode === 'auto-resume') {
    let runId = args.resumeRunId;
    if (args.selectionMode === 'auto-resume') {
      if (!repo) { process.stderr.write('Could not determine --repo from origin; pass --repo OWNER/NAME\n'); process.exit(1); }
      const fr = node([
        join('scripts', 'find-failed-benchmark-run.mjs'),
        '--workflow', 'Behavior Benchmark Subagents Smoke',
        '--max-age-hours', String(args.maxAgeHours),
        '--status', 'failed',
        '--repo', repo,
        '--output-file', failedRunFile,
      ]);
      if (fr.status !== 0) { process.stderr.write(`find-failed-benchmark-run failed:\n${fr.stderr}\n`); process.exit(1); }
      const found = /^found=true$/m.test(readFileSync(failedRunFile, 'utf-8'));
      if (!found) {
        banner([`auto-resume: no failed run in last ${args.maxAgeHours}h; falling back to changed mode.`]);
        const idx = selectArgs.indexOf('--selection-mode');
        selectArgs[idx + 1] = 'changed';
      } else {
        const m = readFileSync(failedRunFile, 'utf-8').match(/^run_id=(\d+)/m);
        runId = m ? m[1] : '';
        if (!runId) { process.stderr.write('auto-resume: failed run found but no run_id parsed\n'); process.exit(1); }
        resumeSourceRunId = runId;
      }
    } else {
      resumeSourceRunId = runId;
    }
    if (resumeSourceRunId) {
      if (!repo) { process.stderr.write('Could not determine --repo from origin; pass --repo OWNER/NAME\n'); process.exit(1); }
      const dl = node([
        join('scripts', 'download-benchmark-summary.mjs'),
        '--repo', repo,
        '--run-id', resumeSourceRunId,
        '--artifact-name', `behavior-benchmark-subagents-smoke-${resumeSourceRunId}`,
        '--output', prevSummaryFile,
      ]);
      if (dl.status !== 0) { process.stderr.write(`download-benchmark-summary failed:\n${dl.stderr}\n`); process.exit(1); }
      selectArgs.push('--previous-summary-file', prevSummaryFile);
    }
  }

  banner([`Selecting ${args.suite} tasks (mode=${args.selectionMode})…`]);
  const sel = node(selectArgs);
  if (sel.status !== 0) { process.stderr.write(`select-benchmark-tasks failed:\n${sel.stderr}\n`); process.exit(1); }
  let selection;
  try { selection = JSON.parse(sel.stdout); }
  catch { process.stderr.write(`select-benchmark-tasks produced no JSON:\n${sel.stdout}\n${sel.stderr}\n`); process.exit(1); }

  const taskFiles = Array.isArray(selection.task_files) ? selection.task_files : [];
  writeFileSync(selectedFile, taskFiles.map((p) => String(p)).join('\n') + (taskFiles.length ? '\n' : ''), 'utf-8');

  // --- step 3: render precheck summary --------------------------------------
  banner([
    `## Behavior Benchmark Subagents Smoke Precheck`,
    ``,
    `- Event: \`${args.event}\``,
    `- Selection mode: \`${args.selectionMode}\``,
    `- Resume source run id: \`${resumeSourceRunId || 'n/a'}\``,
    `- Selected tasks: \`${taskFiles.length}\``,
    `- Task ids: \`${(selection.task_ids || []).join(',') || 'none'}\``,
    `- Selection reason: \`${selection.selection_reason || 'no_matching_changes'}\``,
    `- Will run subagent smoke suite: \`${selection.should_run ? 'true' : 'false'}\``,
    `- Selected task files written to: \`${selectedFile}\``,
  ]);

  if (!selection.should_run) {
    banner([`No benchmark tasks selected — nothing to run.`, `Set --selection-mode=all to run the whole suite.`]);
    return;
  }

  // --- step 4: validate task/fixture alignment -------------------------------
  // Runs the Node --test validator suite (ported from the former pytest suite).
  // The glob is quoted so Node --test expands it itself (mirrors the Makefile
  // node-test target); spawnSync passes it as a literal argv element.
  if (args.runValidators) {
    banner([`Validating task/fixture alignment…`]);
    const v = spawnSync(process.execPath, ['--test', 'test/validators/**/*.test.mjs'], { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
    process.stdout.write(v.stdout);
    if (v.stderr) process.stderr.write(v.stderr);
    if (v.status !== 0) { process.stderr.write(`\nValidation FAILED (exit ${v.status}).\n`); process.exit(1); }
    process.stdout.write(`Validator: PASSED\n`);
  }

  // --- step 5: build shard matrix -------------------------------------------
  banner([`Building shard matrix (max-shards=${args.maxShards})…`]);
  const mx = node([
    join('scripts', 'build-benchmark-matrix.mjs'),
    '--task-list-file', selectedFile,
    '--max-shards', String(args.maxShards),
  ]);
  if (mx.status !== 0) { process.stderr.write(`build-benchmark-matrix failed:\n${mx.stderr}\n`); process.exit(1); }
  let matrix;
  try { matrix = JSON.parse(mx.stdout); }
  catch { matrix = []; }
  process.stdout.write(`Matrix (${Array.isArray(matrix) ? matrix.length : 0} shard(s)):\n${mx.stdout.trim()}\n`);

  // --- step 6: ready-to-run local command -----------------------------------
  const smokeTarget = `make bench-smoke BENCH_TASK_LIST='${selectedFile}'`;
  const shardLines = [];
  if (Array.isArray(matrix)) {
    matrix.forEach((s, i) => {
      const shardFile = join(args.outputDir, `.bench-selected-tasks.shard${i + 1}.txt`);
      writeFileSync(shardFile, String(s.task_files) + '\n', 'utf-8');
      shardLines.push(`  make bench-smoke BENCH_TASK_LIST='${shardFile}'   # shard ${s.shard_index}: ${s.task_count} task(s)`);
    });
  }
  banner([
    `Ready to run locally (all selected tasks in one process):`,
    `  ${smokeTarget}`,
    ``,
    `Per-shard (mirrors CI matrix) — run each in its own shell:`,
    ...shardLines,
    ``,
    `Scratch files live under: ${args.outputDir}  (cleaned by \`make clean\`)`,
  ]);
}

main();
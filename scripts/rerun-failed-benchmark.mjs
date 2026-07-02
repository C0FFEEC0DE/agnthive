#!/usr/bin/env node
// rerun-failed-benchmark: re-dispatch the smoke workflow for unresolved tasks.
// Node port of scripts/rerun-failed-benchmark.sh — no Bash. Spawns gh/git with
// explicit argv; no jq (parses gh JSON output in JS).
import { spawnSync } from 'node:child_process';
import { isMain } from './bench/lib.mjs';

const WORKFLOW = 'behavior-benchmark-subagents-smoke.yml';

function sleepMs(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function gh(argv) {
  return spawnSync('gh', argv, { encoding: 'utf-8', stdio: 'pipe' });
}

function gitCurrentBranch() {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' });
  if (r.status !== 0) return '';
  return r.stdout.trim();
}

function usage() {
  process.stdout.write(
    `Usage:
  rerun-failed-benchmark.mjs [--run-id <id>] [--ref <branch>]

Modes:
  (default)     auto_resume: re-run only the unresolved tasks from the last
                failed smoke run (<=72h).
  --run-id <id> resume: re-run only the unresolved tasks from that specific
                smoke run id.

Options:
  --ref <branch>  branch/ref to dispatch on (defaults to the current branch).
  -h, --help      show this help.

Examples:
  node scripts/rerun-failed-benchmark.mjs
  node scripts/rerun-failed-benchmark.mjs --run-id 27872932481
  node scripts/rerun-failed-benchmark.mjs --ref main
`);
}

function parseArgs(argv) {
  const out = { runId: '', ref: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-id') {
      if (i + 1 >= argv.length) { process.stderr.write('--run-id needs a value\n'); process.exit(2); }
      out.runId = argv[++i];
    } else if (a === '--ref') {
      if (i + 1 >= argv.length) { process.stderr.write('--ref needs a value\n'); process.exit(2); }
      out.ref = argv[++i];
    } else if (a === '-h' || a === '--help') {
      usage(); process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${a}\n`); usage(); process.exit(2);
    }
  }
  return out;
}

export function main() {
  const args = parseArgs(process.argv.slice(2));
  const selectionMode = args.runId ? 'resume' : 'auto_resume';

  let ref = args.ref;
  if (!ref) {
    ref = gitCurrentBranch();
    if (!ref || ref === 'HEAD') {
      process.stderr.write('could not determine current branch (detached HEAD?); pass --ref <branch>\n');
      process.exit(2);
    }
  }

  if (gh(['auth', 'status']).status !== 0) { process.stderr.write('gh is not authenticated\n'); process.exit(2); }
  if (gh(['workflow', 'view', WORKFLOW, '--ref', ref]).status !== 0) {
    process.stderr.write(`workflow '${WORKFLOW}' not found on ref '${ref}'\n`); process.exit(2);
  }

  if (selectionMode === 'resume') {
    process.stdout.write(`Dispatching smoke workflow on '${ref}' in resume mode (run_id=${args.runId})...\n`);
    gh(['workflow', 'run', WORKFLOW, '--ref', ref, '-f', 'selection_mode=resume', '-f', `resume_run_id=${args.runId}`]);
  } else {
    process.stdout.write(`Dispatching smoke workflow on '${ref}' in auto_resume mode (last failed run)...\n`);
    gh(['workflow', 'run', WORKFLOW, '--ref', ref, '-f', 'selection_mode=auto_resume']);
  }

  sleepMs(4000);
  const list = gh(['run', 'list', `--workflow=${WORKFLOW}`, `--branch=${ref}`, '--limit', '1', '--json', 'databaseId,url,status,createdAt']);
  if (list.status === 0 && list.stdout.trim()) {
    try {
      const runs = JSON.parse(list.stdout);
      for (const run of runs) {
        process.stdout.write(`Re-run triggered: ${run.url}\n`);
        process.stdout.write(`Status: ${run.status}\n`);
        process.stdout.write(`Watch:     gh run watch ${run.databaseId}\n`);
        process.stdout.write(`Logs:      gh run view ${run.databaseId} --log-failed\n`);
      }
    } catch {
      // ignore parse errors; the dispatch already succeeded.
    }
  }
}

if (isMain(import.meta.url)) {
  main();
}
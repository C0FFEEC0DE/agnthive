#!/usr/bin/env node
// find-failed-benchmark-run: find the last failed benchmark run via `gh`.
// Node port of scripts/find-failed-benchmark-run.py — no Python. Spawns gh/git
// with explicit argv; testable via the exported `deps` injection point.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isMain } from './bench/lib.mjs';

/** Run a gh CLI command and return parsed JSON (or null on failure). */
export function runGh(args, check = true) {
  const r = spawnSync('gh', args, { encoding: 'utf-8' });
  if (r.status !== 0) {
    if (!check) return null;
    process.stderr.write(`gh command failed: gh ${args.join(' ')}\n`);
    process.stderr.write(`stderr: ${r.stderr}\n`);
    process.exit(1);
  }
  return JSON.parse(r.stdout);
}

function defaultGitCurrentBranch() {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

// Mutable dependency injection point for tests.
export const deps = { runGh, gitCurrentBranch: defaultGitCurrentBranch };

export function findFailedRun(workflow, branch, maxAgeHours, status, repo) {
  const cmdArgs = ['run', 'list', '--workflow', workflow, '--limit', '50',
    '--json', 'databaseId,status,conclusion,createdAt,headBranch,displayTitle'];
  if (branch) cmdArgs.push('--branch', branch);
  if (repo) cmdArgs.push('--repo', repo);

  const runs = deps.runGh(cmdArgs, false);
  if (!runs || runs.length === 0) return null;

  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  for (const run of runs) {
    const createdStr = run.createdAt || '';
    if (!createdStr) continue;
    const created = new Date(createdStr);
    if (Number.isNaN(created.getTime())) continue;
    if (created.getTime() < cutoff) continue;
    if (run.status !== 'completed') continue;
    if (status === 'failed') {
      if (run.conclusion === 'failure') return run;
    } else if (status === 'unresolved') {
      if (run.conclusion === 'failure') return run;
    }
  }
  return null;
}

function parseArgs(argv) {
  const out = { workflow: null, branch: null, maxAgeHours: 72, status: 'failed', repo: null, outputFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workflow') out.workflow = argv[++i];
    else if (a === '--branch') out.branch = argv[++i];
    else if (a === '--max-age-hours') out.maxAgeHours = Number.parseInt(argv[++i], 10);
    else if (a === '--status') out.status = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--output-file') out.outputFile = argv[++i];
    else { process.stderr.write(`unknown argument: ${a}\n`); process.exit(2); }
  }
  if (!out.workflow) { process.stderr.write('--workflow is required\n'); process.exit(2); }
  if (!['failed', 'unresolved'].includes(out.status)) { process.stderr.write("--status must be 'failed' or 'unresolved'\n"); process.exit(2); }
  return out;
}

export function main() {
  const args = parseArgs(process.argv.slice(2));
  const branch = args.branch || deps.gitCurrentBranch();
  const runInfo = findFailedRun(args.workflow, branch, args.maxAgeHours, args.status, args.repo);
  const outputPath = args.outputFile || process.env.GITHUB_OUTPUT || '';
  if (runInfo) {
    const runId = runInfo.databaseId ?? '';
    const displayTitle = runInfo.displayTitle ?? '';
    const created = runInfo.createdAt ?? '';
    if (outputPath) {
      appendFileSync(outputPath, `found=true\nrun_id=${runId}\ndisplay_title=${displayTitle}\ncreated_at=${created}\n`, 'utf-8');
    } else {
      process.stdout.write(JSON.stringify({ found: true, run_id: String(runId), display_title: displayTitle, created_at: created }, null, 2) + '\n');
    }
  } else {
    if (outputPath) {
      appendFileSync(outputPath, 'found=false\n', 'utf-8');
    } else {
      process.stdout.write(JSON.stringify({ found: false, run_id: '', display_title: '', created_at: '' }, null, 2) + '\n');
    }
  }
}

if (isMain(import.meta.url)) {
  main();
}
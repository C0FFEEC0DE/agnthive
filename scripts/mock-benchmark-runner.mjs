#!/usr/bin/env node
// mock-benchmark-runner: synthetic passing result for CI smoke tests.
// Node port of scripts/mock-benchmark-runner.sh — no jq, no Bash.
import { mkdirSync, writeFileSync } from 'node:fs';
import { sep } from 'node:path';
import { isMain, readJson } from './bench/lib.mjs';

export function buildMockResult(taskFile, repoRoot) {
  const task = readJson(taskFile);
  let taskPath = taskFile;
  // Match the repo-root prefix with the platform separator (backslash on
  // Windows), then normalize to '/' so task_path is stable across OSes — the
  // benchmark renders it in JSON/markdown and git itself emits forward slashes.
  if (repoRoot && taskFile.startsWith(repoRoot + sep)) {
    taskPath = taskFile.slice(repoRoot.length + 1).split(sep).join('/');
  }
  const category = task.category;
  let runtimeSeconds = 15;
  if (category === 'bugfix') runtimeSeconds = 18;
  else if (category === 'feature') runtimeSeconds = 26;
  else if (category === 'refactor') runtimeSeconds = 20;
  else if (category === 'docs') runtimeSeconds = 8;
  const verificationRequired = task.verification_required === true;
  const reviewRequired = task.review_required === true;
  const docsRequired = task.docs_required === true;
  return {
    task_id: task.id,
    task_path: taskPath,
    status: 'passed',
    completed: true,
    verification_required: verificationRequired,
    tests_run: verificationRequired,
    tests_passed: verificationRequired,
    review_required: reviewRequired,
    review_present: reviewRequired,
    docs_required: docsRequired,
    docs_updated: docsRequired,
    policy_violations: 0,
    tool_failures: 0,
    runtime_seconds: runtimeSeconds,
    notes: 'Mock runner produced a synthetic passing result. Configure BENCH_RUNNER_CMD for real agent evaluation.',
  };
}

function main() {
  const taskFile = process.env.BENCH_TASK_FILE;
  const outputDir = process.env.BENCH_OUTPUT_DIR;
  if (!taskFile) { process.stderr.write('BENCH_TASK_FILE is required\n'); process.exit(1); }
  if (!outputDir) { process.stderr.write('BENCH_OUTPUT_DIR is required\n'); process.exit(1); }
  const repoRoot = process.env.BENCH_REPO_ROOT || '';
  const result = buildMockResult(taskFile, repoRoot);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(`${outputDir}/result.json`, JSON.stringify(result, null, 2) + '\n', 'utf-8');
}

if (isMain(import.meta.url)) {
  main();
}
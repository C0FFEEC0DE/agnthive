#!/usr/bin/env node
// collect-benchmark-changes: list files changed for a given GitHub event.
// Node port of scripts/collect-benchmark-changes.sh — no Bash. Spawns git with
// an explicit argv.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMain } from './bench/lib.mjs';

function git(argv, cwd) {
  const r = spawnSync('git', argv, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) {
    process.stderr.write(`git ${argv.join(' ')} failed: ${r.stderr}\n`);
    process.exit(1);
  }
  return r.stdout;
}

function sortedUnique(lines) {
  return [...new Set(lines.map((l) => l.trim()).filter((l) => l.length > 0))].sort();
}

export function collectChangedFiles(event, baseRef, lookbackHours, refName, cwd) {
  if (event === 'pull_request') {
    git(['fetch', '--no-tags', '--prune', '--depth=1', 'origin', baseRef], cwd);
    return sortedUnique(git(['diff', '--name-only', `origin/${baseRef}...HEAD`], cwd).split('\n'));
  }
  if (event === 'schedule') {
    git(['fetch', '--no-tags', '--prune', '--depth=1', 'origin', 'main'], cwd);
    return sortedUnique(git(['log', `--since=${lookbackHours} hours ago`, '--name-only', '--pretty=format:', 'origin/main'], cwd).split('\n'));
  }
  if (event === 'workflow_dispatch') {
    git(['fetch', '--no-tags', '--prune', '--depth=1', 'origin', baseRef], cwd);
    if (refName && refName !== baseRef) {
      return sortedUnique(git(['diff', '--name-only', `origin/${baseRef}...HEAD`], cwd).split('\n'));
    }
    return sortedUnique(git(['log', `--since=${lookbackHours} hours ago`, '--name-only', '--pretty=format:', 'HEAD'], cwd).split('\n'));
  }
  process.stderr.write(`Unsupported event for benchmark change collection: ${event}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { event: '', output: '', baseRef: 'main', lookbackHours: '24', refName: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--event') out.event = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--base-ref') out.baseRef = argv[++i];
    else if (a === '--lookback-hours') out.lookbackHours = argv[++i];
    else if (a === '--ref-name') out.refName = argv[++i];
    else { process.stderr.write(`Usage: collect-benchmark-changes.mjs --event EVENT --output FILE [--base-ref REF] [--lookback-hours HOURS] [--ref-name REF]\n`); process.exit(1); }
  }
  if (!out.event || !out.output) { process.stderr.write('Usage: collect-benchmark-changes.mjs --event EVENT --output FILE [...]\n'); process.exit(1); }
  return out;
}

export function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  mkdirSync(dirname(args.output), { recursive: true });
  const files = collectChangedFiles(args.event, args.baseRef, args.lookbackHours, args.refName, cwd);
  writeFileSync(args.output, files.join('\n') + (files.length ? '\n' : ''), 'utf-8');
  process.stdout.write(`Collected ${files.length} changed files for ${args.event}\n`);
  if (files.length) {
    process.stdout.write('Changed files:\n');
    process.stderr.write(files.join('\n') + '\n');
  } else {
    process.stderr.write(`WARNING: No changed files collected for ${args.event}\n`);
  }
}

if (isMain(import.meta.url)) {
  main();
}
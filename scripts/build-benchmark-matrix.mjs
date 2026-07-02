#!/usr/bin/env node
// build-benchmark-matrix: shard a task list across N matrix entries.
// Node port of scripts/build-benchmark-matrix.py — no Python.
import { readFileSync, existsSync } from 'node:fs';
import { isMain } from './bench/lib.mjs';

export function loadTaskPaths(taskListFile) {
  if (!existsSync(taskListFile)) return [];
  const raw = readFileSync(taskListFile, 'utf-8');
  return raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

export function chunkTaskPaths(taskPaths, maxShards) {
  if (!taskPaths || taskPaths.length === 0) return [];
  const shardCount = Math.max(1, Math.min(maxShards, taskPaths.length));
  const shards = Array.from({ length: shardCount }, () => []);
  taskPaths.forEach((p, i) => shards[i % shardCount].push(p));
  return shards.filter((s) => s.length > 0);
}

export function buildMatrix(taskPaths, maxShards) {
  const chunks = chunkTaskPaths(taskPaths, maxShards);
  return chunks.map((shard, i) => ({
    shard_index: i + 1,
    task_files: shard.join('\n'),
    task_count: shard.length,
  }));
}

function parseArgs(argv) {
  const out = { taskListFile: null, maxShards: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task-list-file') { out.taskListFile = argv[++i]; }
    else if (a === '--max-shards') { out.maxShards = Number.parseInt(argv[++i], 10); }
    else { process.stderr.write(`unknown argument: ${a}\n`); process.exit(2); }
  }
  if (!out.taskListFile) { process.stderr.write('Usage: build-benchmark-matrix.mjs --task-list-file FILE [--max-shards N]\n'); process.exit(2); }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = loadTaskPaths(args.taskListFile);
  process.stdout.write(JSON.stringify(buildMatrix(paths, args.maxShards), null, 0));
}

if (isMain(import.meta.url)) {
  main();
}
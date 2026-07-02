// Node tests for scripts/build-benchmark-matrix.mjs (port of the Python test).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chunkTaskPaths, buildMatrix, loadTaskPaths } from '../../scripts/build-benchmark-matrix.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'build-benchmark-matrix.mjs');

test('chunk even distribution', () => {
  assert.deepEqual(chunkTaskPaths(['a', 'b', 'c', 'd', 'e'], 2), [['a', 'c', 'e'], ['b', 'd']]);
});
test('chunk fewer tasks than shards', () => {
  assert.deepEqual(chunkTaskPaths(['a'], 3), [['a']]);
});
test('chunk empty', () => {
  assert.deepEqual(chunkTaskPaths([], 2), []);
});
test('chunk single shard', () => {
  assert.deepEqual(chunkTaskPaths(['a', 'b', 'c'], 1), [['a', 'b', 'c']]);
});
test('chunk more shards than tasks', () => {
  assert.deepEqual(chunkTaskPaths(['a', 'b'], 5), [['a'], ['b']]);
});
test('build matrix shard metadata', () => {
  const m = buildMatrix(['a', 'b', 'c', 'd', 'e'], 3);
  assert.equal(m.length, 3);
  assert.deepEqual(m[0], { shard_index: 1, task_count: 2, task_files: 'a\nd' });
  assert.deepEqual(m[1], { shard_index: 2, task_count: 2, task_files: 'b\ne' });
  assert.deepEqual(m[2], { shard_index: 3, task_count: 1, task_files: 'c' });
});
test('build matrix empty', () => {
  assert.deepEqual(buildMatrix([], 2), []);
});
test('load task paths missing file', () => {
  assert.deepEqual(loadTaskPaths(join(tmpdir(), 'nope-' + Date.now() + '.txt')), []);
});
test('load task paths strips and filters blanks', () => {
  const d = mkdtempSync(join(tmpdir(), 'mx-'));
  const p = join(d, 'tasks.txt');
  writeFileSync(p, 'a.json\n\n  b.json  \n   \n');
  assert.deepEqual(loadTaskPaths(p), ['a.json', 'b.json']);
});

test('main prints matrix json', () => {
  const d = mkdtempSync(join(tmpdir(), 'mx-'));
  const p = join(d, 'tasks.txt');
  writeFileSync(p, 'a.json\nb.json\nc.json\n');
  const r = spawnSync(process.execPath, [SCRIPT, '--task-list-file', p, '--max-shards', '2'], { encoding: 'utf-8' });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.length, 2);
  assert.equal(out[0].shard_index, 1);
  assert.equal(out[1].shard_index, 2);
});
test('main missing task list file prints empty array', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--task-list-file', join(tmpdir(), 'nope-' + Date.now() + '.txt')], { encoding: 'utf-8' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), []);
});
test('main default max-shards', () => {
  const d = mkdtempSync(join(tmpdir(), 'mx-'));
  const p = join(d, 'tasks.txt');
  writeFileSync(p, 'a.json\n');
  const r = spawnSync(process.execPath, [SCRIPT, '--task-list-file', p], { encoding: 'utf-8' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), [{ shard_index: 1, task_files: 'a.json', task_count: 1 }]);
});
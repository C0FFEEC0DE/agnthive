import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  safeSessionId, statePaths, ensureStateDir, appendEvent, readEvents,
  reducer, writeSnapshot, readSnapshot, loadState, trimEvents, DEFAULT_STATE,
} from '../../plugins/agent-hive/modules/state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workerScript = join(here, 'parallel-writer-worker.mjs');

let root;
test.before(() => { root = mkdtempSync(join(tmpdir(), 'state-stress-')); });
test.after(() => { rmSync(root, { recursive: true, force: true }); });

// --- path traversal rejection ---------------------------------------------

test('DEFAULT_STATE carries the dispatch-contract mode default for the PreToolUse guard', () => {
  assert.equal(DEFAULT_STATE.dispatch_contract_mode, '');
  // The guard keys off required_subagents + subagents_started; both default empty.
  assert.deepEqual(DEFAULT_STATE.required_subagents, []);
  assert.deepEqual(DEFAULT_STATE.subagents_started, []);
});

test('safeSessionId accepts simple ids and sanitizes allowed chars', () => {
  assert.equal(safeSessionId('abc-123_DEF'), 'abc-123_DEF');
  assert.equal(safeSessionId('session_1'), 'session_1');
});

test('safeSessionId rejects path traversal and separators', () => {
  for (const bad of ['../etc', '..\\etc', '/abs', 'a/b', 'a\\b', '.', '..', '']) {
    assert.throws(() => safeSessionId(bad), Error, `${JSON.stringify(bad)} should be rejected`);
  }
});

test('safeSessionId rejects non-strings', () => {
  for (const bad of [undefined, null, 42, {}, [], true]) {
    assert.throws(() => safeSessionId(bad), Error);
  }
});

test('safeSessionId sanitizes disallowed chars to "-" and caps length', () => {
  const long = 'x'.repeat(200);
  const got = safeSessionId(long);
  assert.equal(got.length, 128);
  assert.match(got, /^x+$/);
  assert.equal(safeSessionId('a b.c:d'), 'a-b-c-d');
});

test('statePaths never escapes the data root for a traversal id', () => {
  assert.throws(() => statePaths(root, '../escape'), Error);
  const p = statePaths(root, 'safe-1');
  assert.ok(p.dir.startsWith(root));
  assert.ok(p.eventsDir.startsWith(root));
});

// --- reducer / append / read ----------------------------------------------

test('append + reducer: init, set, increment, append_unique, clear', () => {
  const p = statePaths(root, 'reducer-1');
  appendEvent(p, 'init', { session_id: 'reducer-1', cwd: '/proj' });
  appendEvent(p, 'set', { field: 'task_type', value: 'feature' });
  appendEvent(p, 'increment', { field: 'stop_block_count', by: 1 });
  appendEvent(p, 'increment', { field: 'stop_block_count', by: 1 });
  appendEvent(p, 'append_unique', { field: 'files', value: 'a.mjs' });
  appendEvent(p, 'append_unique', { field: 'files', value: 'b.mjs' });
  appendEvent(p, 'append_unique', { field: 'files', value: 'a.mjs' }); // dedup
  appendEvent(p, 'clear', { field: 'stop_block_count' });

  const state = reducer(readEvents(p));
  assert.equal(state.session_id, 'reducer-1');
  assert.equal(state.cwd, '/proj');
  assert.equal(state.task_type, 'feature');
  assert.equal(state.stop_block_count, 0);
  assert.deepEqual(state.files, ['a.mjs', 'b.mjs']);
  assert.equal(state._last_seq, 8);
});

test('appendEvent produces monotonically increasing, unique seqs', () => {
  const p = statePaths(root, 'seq-1');
  const seqs = [];
  for (let i = 0; i < 20; i++) seqs.push(appendEvent(p, 'increment', { field: 'c', by: 1 }));
  const sorted = [...seqs].sort((a, b) => a - b);
  assert.deepEqual(seqs, sorted);
  assert.equal(new Set(seqs).size, seqs.length, 'seqs must be unique');
});

test('readEvents skips a corrupt event file and returns the rest', () => {
  const p = statePaths(root, 'corrupt-1');
  appendEvent(p, 'increment', { field: 'c', by: 1 });
  const files = readdirSync(p.eventsDir).filter((f) => f.endsWith('.json')).sort();
  writeFileSync(join(p.eventsDir, files[0]), '{ not json');
  const events = readEvents(p);
  assert.equal(events.length, 0, 'the single event was corrupted');
  // a fresh append still works after corruption
  appendEvent(p, 'increment', { field: 'c', by: 1 });
  assert.equal(readEvents(p).length, 1);
});

// --- snapshot recovery -----------------------------------------------------

test('writeSnapshot + readSnapshot round-trip', () => {
  const p = statePaths(root, 'snap-1');
  appendEvent(p, 'init', { session_id: 'snap-1' });
  appendEvent(p, 'increment', { field: 'c', by: 5 });
  const state = reducer(readEvents(p));
  writeSnapshot(p, state);
  const snap = readSnapshot(p);
  assert.deepEqual(snap.state, state);
});

test('interrupted snapshot recovery: corrupt snapshot rebuilt from events', () => {
  const p = statePaths(root, 'snap-corrupt');
  appendEvent(p, 'init', { session_id: 'snap-corrupt' });
  appendEvent(p, 'increment', { field: 'c', by: 3 });
  const before = reducer(readEvents(p));
  writeSnapshot(p, before);
  // simulate a torn write: overwrite snapshot with garbage
  writeFileSync(p.snapshot, 'GARBAGE{not-json');
  assert.equal(readSnapshot(p), null, 'corrupt snapshot reads as null');
  const loaded = loadState(p);
  assert.deepEqual({ ...loaded }, { ...before });
  // a fresh snapshot was written during recovery
  const snap = readSnapshot(p);
  assert.equal(snap.state.c, 3);
});

test('missing snapshot: loadState rebuilds from events and writes one', () => {
  const p = statePaths(root, 'snap-missing');
  appendEvent(p, 'increment', { field: 'c', by: 7 });
  assert.equal(existsSync(p.snapshot), false);
  const loaded = loadState(p);
  assert.equal(loaded.c, 7);
  assert.equal(existsSync(p.snapshot), true, 'recovery writes a snapshot');
});

test('stale snapshot: newer events replayed onto snapshot base', () => {
  const p = statePaths(root, 'snap-stale');
  appendEvent(p, 'init', { session_id: 'snap-stale' });
  appendEvent(p, 'increment', { field: 'c', by: 2 });
  writeSnapshot(p, reducer(readEvents(p))); // snapshot covers seq 1..2
  // events arrive after the snapshot
  appendEvent(p, 'increment', { field: 'c', by: 3 });
  appendEvent(p, 'set', { field: 'task_type', value: 'bugfix' });
  const loaded = loadState(p);
  assert.equal(loaded.c, 5, '2 (snapshot) + 3 (replay)');
  assert.equal(loaded.task_type, 'bugfix');
});

// --- retention -------------------------------------------------------------

test('trimEvents removes captured events; loadState stays correct via snapshot', () => {
  const p = statePaths(root, 'trim-1');
  appendEvent(p, 'init', { session_id: 'trim-1' });
  for (let i = 0; i < 5; i++) appendEvent(p, 'increment', { field: 'c', by: 1 });
  const state = reducer(readEvents(p));
  writeSnapshot(p, state); // snapshot covers seq 1..6
  assert.equal(readEvents(p).length, 6);
  trimEvents(p, state._last_seq); // remove all captured events
  assert.equal(readdirSync(p.eventsDir).length, 0, 'all events trimmed');
  const loaded = loadState(p);
  assert.equal(loaded.c, 5, 'state preserved via snapshot after trimming');
});

// --- parallel writer stress test (no lost updates) ------------------------

test('parallel writers: no lost updates, unique monotonic seqs', async () => {
  const N = 4;
  const M = 60;
  const p = statePaths(root, 'sess-parallel');
  const workers = [];
  for (let i = 0; i < N; i++) {
    workers.push(new Promise((resolve, reject) => {
      const w = new Worker(workerScript, { workerData: { dataRoot: root, sessionId: 'sess-parallel', count: M } });
      w.on('message', resolve);
      w.on('error', reject);
    }));
  }
  await Promise.all(workers);

  const events = readEvents(p);
  assert.equal(events.length, N * M, `expected ${N * M} events, got ${events.length}`);
  const seqs = events.map((e) => e.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'every event has a unique seq');
  const maxSeq = Math.max(...seqs);
  const minSeq = Math.min(...seqs);
  assert.equal(maxSeq - minSeq + 1, N * M, 'seqs form a contiguous range');
  const state = reducer(events);
  assert.equal(state.counter, N * M, 'reducer applied every increment exactly once');
});
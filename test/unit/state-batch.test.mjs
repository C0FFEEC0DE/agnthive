import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  statePaths, appendEvent, appendEvents, queueEvent, flushEvents,
  readEvents, reducer, writeSnapshot, readSnapshot, loadState,
  snapshotThreshold, eventRetentionLimit,
} from '../../plugins/agnthive/modules/state.mjs';

const stateUrl = new URL('../../plugins/agnthive/modules/state.mjs', import.meta.url).href;

let root;
test.before(() => { root = mkdtempSync(join(tmpdir(), 'state-batch-')); });
test.after(() => { rmSync(root, { recursive: true, force: true }); });

/** Event file seqs (filenames) for a session, ascending. */
function eventSeqs(paths) {
  return readdirSync(paths.eventsDir)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => Number(f.replace('.json', '')))
    .sort((a, b) => a - b);
}

async function runBatchWorker(dataRoot, sessionId, count) {
  // Eval worker = an isolated module instance, like a separate hook process.
  const src = `
    (async () => {
      const { parentPort, workerData } = await import('node:worker_threads');
      try {
        const { statePaths, queueEvent, flushEvents } = await import(workerData.stateUrl);
        const paths = statePaths(workerData.dataRoot, workerData.sessionId);
        for (let i = 0; i < workerData.count; i++) {
          queueEvent(paths, 'increment', { field: 'counter', by: 1 });
        }
        parentPort.postMessage({ seq: flushEvents(paths) });
      } catch (e) {
        parentPort.postMessage({ error: String(e && e.stack ? e.stack : e) });
      }
    })();
  `;
  return new Promise((resolve, reject) => {
    const w = new Worker(src, {
      eval: true,
      workerData: { dataRoot, sessionId, count, stateUrl },
    });
    w.on('message', (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg)));
    w.on('error', reject);
  });
}

// --- batching --------------------------------------------------------------

test('appendEvents writes one batch file that reads back in array order', () => {
  const p = statePaths(root, 'batch-order');
  const seq = appendEvents(p, [
    { type: 'init', payload: { session_id: 'batch-order' } },
    { type: 'increment', payload: { field: 'n', by: 1 } },
    { type: 'append_unique', payload: { field: 'files', value: 'a.mjs' } },
    { type: 'increment', payload: { field: 'n', by: 2 } },
    { type: 'append_unique', payload: { field: 'files', value: 'b.mjs' } },
  ]);

  assert.equal(typeof seq, 'number');
  assert.deepEqual(eventSeqs(p), [seq], 'one batch file, not one file per event');
  const raw = JSON.parse(readFileSync(join(p.eventsDir, `${String(seq).padStart(10, '0')}.json`), 'utf8'));
  assert.ok(Array.isArray(raw), 'batch file holds an array of records');
  assert.equal(raw.length, 5);
  assert.ok(raw.every((ev) => ev.seq === seq), 'batch records share the claimed seq');

  const events = readEvents(p);
  assert.equal(events.length, 5);
  assert.deepEqual(
    events.map((e) => e.type),
    ['init', 'increment', 'append_unique', 'increment', 'append_unique'],
    'array order is preserved on read back',
  );
  const state = reducer(events);
  assert.equal(state.session_id, 'batch-order');
  assert.equal(state.n, 3);
  assert.deepEqual(state.files, ['a.mjs', 'b.mjs']);
  assert.equal(state._last_seq, seq);
});

test('queueEvent defers writes until flushEvents, which flushes once', () => {
  const p = statePaths(root, 'batch-queue');
  queueEvent(p, 'increment', { field: 'n', by: 1 });
  queueEvent(p, 'increment', { field: 'n', by: 1 });
  assert.ok(!existsSync(p.eventsDir) || readdirSync(p.eventsDir).length === 0, 'nothing written before flush');

  flushEvents(p);
  assert.equal(readEvents(p).length, 2);
  assert.deepEqual(eventSeqs(p), [1], 'both events landed in one batch file');
  assert.equal(flushEvents(p), null, 'flushing an empty queue is a no-op');
});

test('appendEvent still persists immediately with unique contiguous seqs', () => {
  const p = statePaths(root, 'batch-single');
  const seqs = [1, 2, 3].map(() => appendEvent(p, 'increment', { field: 'n', by: 1 }));
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.deepEqual(eventSeqs(p), [1, 2, 3], 'one event per file when appending singly');
});

test('snapshot replay treats a batch atomically', () => {
  const p = statePaths(root, 'batch-replay');
  appendEvents(p, [
    { type: 'increment', payload: { field: 'n', by: 1 } },
    { type: 'increment', payload: { field: 'n', by: 2 } },
  ]);
  writeSnapshot(p, reducer(readEvents(p))); // snapshot covers batch seq 1
  appendEvents(p, [
    { type: 'increment', payload: { field: 'n', by: 3 } },
    { type: 'increment', payload: { field: 'n', by: 4 } },
  ]);
  assert.equal(loadState(p).n, 10, 'all four increments applied exactly once');
});

// --- concurrency -----------------------------------------------------------

test('concurrent batch writers lose no event and claim distinct seqs', async () => {
  const N = 3;
  const M = 40;
  const p = statePaths(root, 'batch-concurrent');

  const results = await Promise.all(
    Array.from({ length: N }, () => runBatchWorker(root, 'batch-concurrent', M)),
  );
  const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
  assert.equal(new Set(seqs).size, N, 'each writer claimed a distinct batch seq');
  assert.deepEqual(eventSeqs(p), seqs, 'one file per writer batch');

  const events = readEvents(p);
  assert.equal(events.length, N * M, 'no event was lost');
  assert.equal(new Set(events.map((e) => e.seq)).size, N);
  assert.equal(reducer(events).counter, N * M, 'every increment applied exactly once');
});

// --- snapshot refresh ------------------------------------------------------

test('snapshot refreshes once replayed events exceed the default threshold', () => {
  delete process.env.AGNTHIVE_STATE_SNAPSHOT_THRESHOLD;
  assert.equal(snapshotThreshold(), 50);

  const p = statePaths(root, 'snap-threshold');
  appendEvent(p, 'increment', { field: 'n', by: 1 }); // seq 1
  writeSnapshot(p, reducer(readEvents(p)));
  assert.equal(readSnapshot(p).state._last_seq, 1);

  for (let i = 0; i < 50; i++) appendEvent(p, 'increment', { field: 'n', by: 1 }); // seq 2..51
  assert.equal(loadState(p).n, 51);
  assert.equal(readSnapshot(p).state._last_seq, 1, 'exactly threshold replays does not refresh');

  appendEvent(p, 'increment', { field: 'n', by: 1 }); // seq 52
  assert.equal(loadState(p).n, 52);
  assert.equal(readSnapshot(p).state._last_seq, 52, 'threshold exceeded -> snapshot refreshed');
});

test('AGNTHIVE_STATE_SNAPSHOT_THRESHOLD overrides the refresh threshold', () => {
  const prev = process.env.AGNTHIVE_STATE_SNAPSHOT_THRESHOLD;
  process.env.AGNTHIVE_STATE_SNAPSHOT_THRESHOLD = '2';
  try {
    assert.equal(snapshotThreshold(), 2);
    const p = statePaths(root, 'snap-threshold-env');
    appendEvent(p, 'increment', { field: 'n', by: 1 });
    writeSnapshot(p, reducer(readEvents(p)));
    appendEvent(p, 'increment', { field: 'n', by: 1 });
    appendEvent(p, 'increment', { field: 'n', by: 1 });
    loadState(p); // 2 replays: not > 2
    assert.equal(readSnapshot(p).state._last_seq, 1);
    appendEvent(p, 'increment', { field: 'n', by: 1 });
    loadState(p); // 3 replays > 2
    assert.equal(readSnapshot(p).state._last_seq, 4);
  } finally {
    if (prev === undefined) delete process.env.AGNTHIVE_STATE_SNAPSHOT_THRESHOLD;
    else process.env.AGNTHIVE_STATE_SNAPSHOT_THRESHOLD = prev;
  }
});

test('writeSnapshot refuses to regress a newer on-disk snapshot', () => {
  const p = statePaths(root, 'snap-monotonic');
  appendEvent(p, 'increment', { field: 'n', by: 1 });
  appendEvent(p, 'increment', { field: 'n', by: 1 });
  const newer = reducer(readEvents(p)); // _last_seq 2
  assert.equal(writeSnapshot(p, newer), true);
  const older = { ...newer, n: 1, _last_seq: 1 };
  assert.equal(writeSnapshot(p, older), false, 'stale snapshot must not overwrite');
  assert.equal(readSnapshot(p).state.n, 2);
});

// --- retention -------------------------------------------------------------

test('trim after snapshot keeps the newest events and never exceeds the snapshot', () => {
  const prev = process.env.AGNTHIVE_STATE_MAX_EVENTS;
  process.env.AGNTHIVE_STATE_MAX_EVENTS = '5';
  try {
    assert.equal(eventRetentionLimit(), 5);
    const p = statePaths(root, 'trim-bound');
    for (let i = 0; i < 20; i++) appendEvent(p, 'increment', { field: 'n', by: 1 });
    const before = eventSeqs(p);
    assert.equal(before.length, 20);

    const state = loadState(p); // no snapshot: write one covering all, then trim
    const snapSeq = readSnapshot(p).state._last_seq;
    assert.equal(state.n, 20);
    assert.equal(snapSeq, 20);

    const kept = eventSeqs(p);
    assert.deepEqual(kept, [16, 17, 18, 19, 20], 'only the newest retention window survives');
    const deleted = before.filter((s) => !kept.includes(s));
    assert.ok(deleted.every((s) => s <= snapSeq), 'nothing newer than the snapshot was deleted');
    assert.equal(loadState(p).n, 20, 'covered-but-trimmed events are not replayed twice');
  } finally {
    if (prev === undefined) delete process.env.AGNTHIVE_STATE_MAX_EVENTS;
    else process.env.AGNTHIVE_STATE_MAX_EVENTS = prev;
  }
});

test('threshold refresh trims only below the fresh snapshot seq', () => {
  const prevT = process.env.AGNTHIVE_STATE_SNAPSHOT_THRESHOLD;
  const prevM = process.env.AGNTHIVE_STATE_MAX_EVENTS;
  process.env.AGNTHIVE_STATE_SNAPSHOT_THRESHOLD = '3';
  process.env.AGNTHIVE_STATE_MAX_EVENTS = '5';
  try {
    const p = statePaths(root, 'trim-refresh');
    appendEvent(p, 'increment', { field: 'n', by: 1 }); // seq 1
    writeSnapshot(p, reducer(readEvents(p)));
    for (let i = 0; i < 10; i++) appendEvent(p, 'increment', { field: 'n', by: 1 }); // seq 2..11

    assert.equal(loadState(p).n, 11);
    const snapSeq = readSnapshot(p).state._last_seq;
    assert.equal(snapSeq, 11, 'refresh snapshot covers every appended event');
    assert.deepEqual(eventSeqs(p), [7, 8, 9, 10, 11], 'newest five seqs kept');
    assert.ok(eventSeqs(p).every((s) => s <= snapSeq));
  } finally {
    if (prevT === undefined) delete process.env.AGNTHIVE_STATE_SNAPSHOT_THRESHOLD;
    else process.env.AGNTHIVE_STATE_SNAPSHOT_THRESHOLD = prevT;
    if (prevM === undefined) delete process.env.AGNTHIVE_STATE_MAX_EVENTS;
    else process.env.AGNTHIVE_STATE_MAX_EVENTS = prevM;
  }
});

test('default retention window is 500 event records', () => {
  delete process.env.AGNTHIVE_STATE_MAX_EVENTS;
  assert.equal(eventRetentionLimit(), 500);
  assert.equal(eventRetentionLimit({ AGNTHIVE_STATE_MAX_EVENTS: 'not-a-number' }), 500);
});

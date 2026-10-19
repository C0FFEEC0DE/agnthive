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
} from '../../plugins/agnthive/modules/state.mjs';

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

test('DEFAULT_STATE seeds an empty per-agent subagent_stop_blocks map (ADR-0002)', () => {
  assert.deepEqual(DEFAULT_STATE.subagent_stop_blocks, {});
  // Legacy scalar subagent_stop_block_* fields were removed; confirm they are
  // absent from the default shape (old event logs replay them harmlessly).
  assert.equal(DEFAULT_STATE.subagent_stop_block_count, undefined);
  assert.equal(DEFAULT_STATE.subagent_stop_block_reason, undefined);
  assert.equal(DEFAULT_STATE.subagent_stop_block_message, undefined);
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

// --- map_set / map_delete (ADR-0002 race fix) ------------------------------
// Per-key map mutation events. Unlike set_many (shallow Object.assign that
// last-writer-wins the whole map and loses a concurrently-written sibling key),
// map_set/map_delete touch one key, so concurrent writers for different keys
// survive each other.

test('map_set + reducer: per-key entries coexist in the map', () => {
  const p = statePaths(root, 'mapset-1');
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-a', value: { count: 2, reason: 'r', message: 'm' } });
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-b', value: { count: 1, reason: 'r2', message: 'm2' } });
  const state = reducer(readEvents(p));
  assert.deepEqual(state.subagent_stop_blocks, {
    'agent-a': { count: 2, reason: 'r', message: 'm' },
    'agent-b': { count: 1, reason: 'r2', message: 'm2' },
  });
});

test('map_set later value overwrites only the targeted key', () => {
  const p = statePaths(root, 'mapset-2');
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-a', value: { count: 1 } });
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-b', value: { count: 1 } });
  // agent-a's count increments to 3; agent-b must be untouched.
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-a', value: { count: 3 } });
  const state = reducer(readEvents(p));
  assert.equal(state.subagent_stop_blocks['agent-a'].count, 3);
  assert.equal(state.subagent_stop_blocks['agent-b'].count, 1);
});

test('map_delete removes the targeted key and leaves siblings intact', () => {
  const p = statePaths(root, 'mapdel-1');
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-a', value: { count: 1 } });
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-b', value: { count: 2 } });
  appendEvent(p, 'map_delete', { mapField: 'subagent_stop_blocks', key: 'agent-a' });
  const state = reducer(readEvents(p));
  assert.equal(state.subagent_stop_blocks['agent-a'], undefined);
  assert.equal(state.subagent_stop_blocks['agent-b'].count, 2);
  // deleting a missing key is a no-op (no throw, siblings survive)
  appendEvent(p, 'map_delete', { mapField: 'subagent_stop_blocks', key: 'never-there' });
  assert.equal(reducer(readEvents(p)).subagent_stop_blocks['agent-b'].count, 2);
});

test('map_set on a non-object field coerces to a fresh map', () => {
  const p = statePaths(root, 'mapset-3');
  // DEFAULT_STATE.files is []; writing a map_set into it must not corrupt.
  appendEvent(p, 'map_set', { mapField: 'files', key: 'k', value: 1 });
  const state = reducer(readEvents(p));
  assert.deepEqual(state.files, { k: 1 });
});

test('map_clear empties the targeted map (ADR-0002 amendment)', () => {
  const p = statePaths(root, 'mapclear-1');
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-a', value: { count: 2 } });
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-b', value: { count: 1 } });
  appendEvent(p, 'map_clear', { mapField: 'subagent_stop_blocks' });
  const state = reducer(readEvents(p));
  assert.deepEqual(state.subagent_stop_blocks, {});
  // a non-string or empty-string mapField is a no-op (siblings / other fields untouched)
  appendEvent(p, 'map_clear', { mapField: 42 });
  appendEvent(p, 'map_clear', { mapField: '' });
  assert.deepEqual(reducer(readEvents(p)).subagent_stop_blocks, {});
  // an empty-string mapField never creates a state[''] key
  assert.equal(reducer(readEvents(p))[''], undefined);
});

test('map_set/map_delete ignore a malformed (non-string/empty) key', () => {
  const p = statePaths(root, 'mapset-malformed');
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-a', value: { count: 1 } });
  // A missing/non-string key must not write a spurious 'undefined' entry.
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: undefined, value: { count: 9 } });
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: '', value: { count: 9 } });
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 42, value: { count: 9 } });
  appendEvent(p, 'map_delete', { mapField: 'subagent_stop_blocks', key: null });
  const state = reducer(readEvents(p));
  assert.deepEqual(Object.keys(state.subagent_stop_blocks), ['agent-a'], 'no spurious keys from malformed key events');
  assert.equal(state.subagent_stop_blocks['agent-a'].count, 1);
});

// The regression this fixes: two concurrent writers each compute a full-map
// set_many snapshot from a state that does not yet include the other writer's
// new key. Applied in seq order, the later set_many clobbers the earlier
// writer's key (last-writer-wins over the whole map). map_set per-key survives.
test('race fix: interleaved map_set for different keys survives; set_many would not', () => {
  const p = statePaths(root, 'race-1');
  // seed agent-a
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-a', value: { count: 2 } });
  // Two writers that read the seeded state concurrently each write only their
  // own new key via per-key map_set (the fix).
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-b', value: { count: 1 } });
  appendEvent(p, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-c', value: { count: 1 } });
  const state = reducer(readEvents(p));
  assert.deepEqual(Object.keys(state.subagent_stop_blocks).sort(), ['agent-a', 'agent-b', 'agent-c']);
  // Contrast: the old set_many full-map snapshots (each computed before the
  // other key existed) would lose one when applied in order. Demonstrate the
  // old behavior in a separate session so the test documents the bug.
  const q = statePaths(root, 'race-old');
  appendEvent(q, 'map_set', { mapField: 'subagent_stop_blocks', key: 'agent-a', value: { count: 2 } });
  appendEvent(q, 'set_many', { fields: { subagent_stop_blocks: { 'agent-a': { count: 2 }, 'agent-b': { count: 1 } } } });
  appendEvent(q, 'set_many', { fields: { subagent_stop_blocks: { 'agent-a': { count: 2 }, 'agent-c': { count: 1 } } } });
  const oldState = reducer(readEvents(q));
  assert.deepEqual(Object.keys(oldState.subagent_stop_blocks).sort(), ['agent-a', 'agent-c'], 'old set_many path loses agent-b');
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

// --- ADR-0009/0010 evidence + lifecycle contract ----------------------------

test('DEFAULT_STATE seeds the ADR-0009/0010 evidence and lifecycle contract', () => {
  assert.equal(DEFAULT_STATE.revision, 0);
  assert.equal(DEFAULT_STATE.fs_revision_hint, 0);
  assert.deepEqual(DEFAULT_STATE.verification, []);
  assert.deepEqual(DEFAULT_STATE.review_results, []);
  assert.equal(DEFAULT_STATE.docs_status, '');
  assert.equal(DEFAULT_STATE.task_id, '');
  assert.equal(DEFAULT_STATE.active_task, null);
  assert.equal(DEFAULT_STATE.prompt_seq, 0);
  assert.equal(DEFAULT_STATE.last_prompt_id, '');
  assert.deepEqual(DEFAULT_STATE.agents, {});
  assert.deepEqual(DEFAULT_STATE.background_tasks, {});
  assert.equal(DEFAULT_STATE.restored_task_seq, 0);
  // task 11 wires the selector; legacy is the default until the quality gate.
  assert.equal(DEFAULT_STATE.workflow_profile, 'legacy');
});

test('reducer honors map_set on the agents registry and append on verification', () => {
  const events = [
    { seq: 1, type: 'append', payload: { field: 'verification', value: { id: 'v1', kind: 'test', status: 'passed', startedRevision: 1, completedRevision: 1 } } },
    { seq: 2, type: 'map_set', payload: { mapField: 'agents', key: 'ag-1', value: { role: 'cr', status: 'completed', taskId: 'task-1' } } },
    { seq: 3, type: 'increment', payload: { field: 'revision', by: 1 } },
    { seq: 4, type: 'append', payload: { field: 'verification', value: { id: 'v2', kind: 'test', status: 'pending' } } },
    { seq: 5, type: 'map_delete', payload: { mapField: 'agents', key: 'ag-1' } },
  ];
  const state = reducer(events);
  assert.equal(state.revision, 1);
  assert.equal(state.verification.length, 2);
  assert.equal(state.verification[0].status, 'passed');
  assert.equal(state.verification[1].status, 'pending');
  assert.equal(state.agents['ag-1'], undefined);
  assert.deepEqual(state.review_results, []);
});
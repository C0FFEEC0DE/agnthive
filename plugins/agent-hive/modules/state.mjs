// state.mjs — append-only session state for the hook runtime.
// Node standard library only. No locks, no read-modify-write JSON.
//
// Design (per docs/specs/claude-code-plugin-node-migration.md behavior delta #1):
//   - State lives under ${CLAUDE_PLUGIN_DATA}/<safe-session-id>/.
//   - Every mutation is an append-only event record written as its own file
//     via exclusive creation (flag 'wx'). Parallel writers race on the next
//     sequence number; the winner keeps it, losers retry with seq+1. No event
//     is ever lost and the sequence is monotonic per session.
//   - A pure reducer derives the latest state from the event records, applied
//     in sequence order.
//   - Snapshots are disposable caches: write a temp file, fsync when supported,
//     then atomically rename. A stale or damaged snapshot is rebuilt from
//     event records, and events already captured by a snapshot may be trimmed.
//   - Every event and snapshot carries a migration version (`v`).
import {
  mkdirSync, readdirSync, readFileSync, writeFileSync, openSync, writeSync,
  fsyncSync, closeSync, renameSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const SCHEMA_VERSION = 1;
const MAX_SEQ_ATTEMPTS = 128;

/**
 * Default session state, mirroring lib.sh ensure_state. loadState/reducer use
 * this as a base so downstream modules see the same field defaults the bash
 * profile provided (false / "" / [] / 0), even before any event sets them.
 */
export const DEFAULT_STATE = Object.freeze({
  session_id: '',
  cwd: '',
  transcript_path: '',
  task_type: 'other',
  manager_mode: 'none',
  edited: false,
  code_changed: false,
  docs_changed: false,
  docs_required: false,
  tests_ok: false,
  tests_failed: false,
  lint_ok: false,
  lint_failed: false,
  build_ok: false,
  build_failed: false,
  detected_test_command: '',
  detected_lint_command: '',
  detected_build_command: '',
  last_test_command: '',
  last_lint_command: '',
  last_build_command: '',
  subagent_start_count: 0,
  subagents_started: [],
  subagent_events: [],
  subagent_instance_count_by_role: {},
  required_subagents: [],
  required_subagent_any_of: [],
  // Benchmark dispatch-contract mode stashed at UserPromptSubmit from the
  // BENCHMARK_DISPATCH_CONTRACT marker (observed|enforced|standard). Only
  // 'enforced' activates the PreToolUse EditWrite hard guard that blocks root
  // edits until the required specialist has started; '' / 'standard' /
  // 'observed' leave the guard inert so non-bench sessions are unaffected.
  dispatch_contract_mode: '',
  stop_block_count: 0,
  stop_block_reason: '',
  stop_block_message: '',
  stalled_by_policy: false,
  policy_stall_reason: '',
  subagent_stop_block_count: 0,
  subagent_stop_block_reason: '',
  subagent_stop_block_message: '',
  files: [],
});

/** Validate and sanitize a session id, rejecting path traversal. */
export function safeSessionId(id) {
  if (typeof id !== 'string') throw new Error('session id must be a string');
  if (id.length === 0) throw new Error('session id is required');
  if (id.includes('/') || id.includes('\\') || id.includes('..') || id === '.') {
    throw new Error('unsafe session id: path components rejected');
  }
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128);
  if (sanitized.length === 0 || sanitized === '.' || sanitized.includes('..')) {
    throw new Error('session id sanitizes to an unsafe value');
  }
  return sanitized;
}

/** Compute the on-disk paths for a session under a data root. */
export function statePaths(dataRoot, sessionId) {
  const sid = safeSessionId(sessionId);
  const dir = join(dataRoot, sid);
  return { dir, eventsDir: join(dir, 'events'), snapshot: join(dir, 'state.json') };
}

/** Ensure the session directory and events directory exist. */
export function ensureStateDir(paths) {
  mkdirSync(paths.eventsDir, { recursive: true });
}

/** Apply one event record to a state object (mutates state). */
function applyEvent(state, ev) {
  switch (ev.type) {
    case 'init':
      Object.assign(state, ev.payload || {});
      break;
    case 'set':
      if (ev.payload) state[ev.payload.field] = ev.payload.value;
      break;
    case 'increment':
      if (ev.payload) state[ev.payload.field] = (Number(state[ev.payload.field]) || 0) + (ev.payload.by || 1);
      break;
    case 'append_unique': {
      if (!ev.payload) break;
      const arr = Array.isArray(state[ev.payload.field]) ? state[ev.payload.field] : [];
      if (!arr.includes(ev.payload.value)) arr.push(ev.payload.value);
      state[ev.payload.field] = arr;
      break;
    }
    case 'append': {
      if (!ev.payload) break;
      const arr = Array.isArray(state[ev.payload.field]) ? state[ev.payload.field] : [];
      arr.push(ev.payload.value);
      state[ev.payload.field] = arr;
      break;
    }
    case 'role_increment': {
      if (!ev.payload) break;
      const map = (state[ev.payload.mapField] && typeof state[ev.payload.mapField] === 'object') ? state[ev.payload.mapField] : {};
      map[ev.payload.key] = (Number(map[ev.payload.key]) || 0) + (ev.payload.by || 1);
      state[ev.payload.mapField] = map;
      break;
    }
    case 'set_many':
      if (ev.payload && ev.payload.fields && typeof ev.payload.fields === 'object') {
        Object.assign(state, ev.payload.fields);
      }
      break;
    case 'clear':
      if (ev.payload) state[ev.payload.field] = Array.isArray(state[ev.payload.field]) ? [] : 0;
      break;
    default:
      break;
  }
  if (ev.seq != null) state._last_seq = ev.seq;
}

/** Pure reducer: fold event records (in seq order) into a state object. */
export function reducer(events) {
  const sorted = [...events].sort((a, b) => (a.seq || 0) - (a.seq || 0));
  const state = structuredClone(DEFAULT_STATE);
  for (const ev of sorted) applyEvent(state, ev);
  return state;
}

function nextSeq(paths) {
  let max = 0;
  try {
    for (const f of readdirSync(paths.eventsDir)) {
      const m = f.match(/^(\d+)\.json$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* events dir not yet created */ }
  return max + 1;
}

/**
 * Append an event record. Returns the assigned sequence number. Safe under
 * concurrent writers: an EEXIST collision on the chosen seq triggers a retry
 * with the next seq, so every event is durably recorded exactly once.
 */
export function appendEvent(paths, type, payload = null) {
  ensureStateDir(paths);
  for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt++) {
    const seq = nextSeq(paths);
    // Filename is deterministic from seq so a concurrent writer that picked the
    // same seq hits EEXIST and retries with seq+1 — this is what makes the
    // sequence unique and monotonic under parallel writers. (A random suffix
    // here would let both writes succeed with the same seq — a lost update.)
    const file = join(paths.eventsDir, `${String(seq).padStart(10, '0')}.json`);
    try {
      writeFileSync(file, JSON.stringify({ seq, type, payload, v: SCHEMA_VERSION }), { flag: 'wx' });
      return seq;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`could not allocate event seq after ${MAX_SEQ_ATTEMPTS} attempts`);
}

/** Read all event records in sequence order. Corrupt files are skipped. */
export function readEvents(paths) {
  try {
    const files = readdirSync(paths.eventsDir).filter((f) => f.endsWith('.json')).sort();
    const events = [];
    for (const f of files) {
      try {
        events.push(JSON.parse(readFileSync(join(paths.eventsDir, f), 'utf8')));
      } catch { /* skip damaged event file */ }
    }
    return events.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  } catch { return []; }
}

/** Atomically write a snapshot (temp file + fsync + rename). */
export function writeSnapshot(paths, state) {
  ensureStateDir(paths);
  const tmp = `${paths.snapshot}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = openSync(tmp, 'wx');
    writeSync(fd, JSON.stringify({ state, v: SCHEMA_VERSION }));
    try { fsyncSync(fd); } catch { /* fsync unsupported or no-op */ }
    closeSync(fd);
    fd = null;
    renameSync(tmp, paths.snapshot);
  } finally {
    if (fd != null) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tmp); } catch { /* renamed away or never written */ }
  }
}

/** Read a snapshot, or null if missing/corrupt. */
export function readSnapshot(paths) {
  try {
    const obj = JSON.parse(readFileSync(paths.snapshot, 'utf8'));
    if (obj && obj.state && typeof obj.state === 'object') return obj;
    return null;
  } catch { return null; }
}

/**
 * Load the current state with recovery. If a valid snapshot covers all known
 * events (plus any trimmed ones), use it as the base and replay only newer
 * events. Otherwise rebuild from the full event log and write a fresh
 * snapshot. A damaged or missing snapshot is transparently rebuilt.
 */
export function loadState(paths) {
  const events = readEvents(paths);
  const snap = readSnapshot(paths);
  if (snap && snap.state) {
    const baseSeq = snap.state._last_seq || 0;
    const replay = events.filter((e) => (e.seq || 0) > baseSeq).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    if (replay.length === 0) return snap.state;
    const state = structuredClone(snap.state);
    for (const ev of replay) applyEvent(state, ev);
    return state;
  }
  const state = reducer(events);
  if (events.length) {
    try { writeSnapshot(paths, state); } catch { /* snapshot is a cache; non-fatal */ }
  }
  return state;
}

/**
 * Retention: remove event files whose seq is already captured by a snapshot.
 * Caller must ensure a snapshot covering `keepAfterSeq` exists first.
 */
export function trimEvents(paths, keepAfterSeq) {
  try {
    for (const f of readdirSync(paths.eventsDir)) {
      const m = f.match(/^(\d+)\.json$/);
      if (m && Number(m[1]) <= keepAfterSeq) {
        try { unlinkSync(join(paths.eventsDir, f)); } catch {}
      }
    }
  } catch { /* nothing to trim */ }
}
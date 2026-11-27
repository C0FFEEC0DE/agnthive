// state.mjs — append-only session state for the hook runtime.
// Node standard library only. No locks, no read-modify-write JSON.
//
// Design (per docs/specs/claude-code-plugin-node-migration.md behavior delta #1):
//   - State lives under ${CLAUDE_PLUGIN_DATA}/<safe-session-id>/.
//   - Mutations are append-only event records grouped into batch files via
//     exclusive creation (flag 'wx'). A process queues its events and flushes
//     them with one directory listing and one write; every event in a batch
//     shares the batch seq (array order preserves intra-batch order). Parallel
//     writers race on the next batch seq; the winner keeps it, losers retry
//     with seq+1. No event is ever lost and the sequence is monotonic per
//     session. appendEvent flushes immediately, so it still yields one unique
//     seq per call.
//   - A pure reducer derives the latest state from the event records, applied
//     in sequence order.
//   - Snapshots are written to a temp file, fsync when supported, then
//     atomically renamed. A stale snapshot is superseded; a damaged or missing
//     one is rebuilt from event records while the retention window still holds
//     them. Once events have been trimmed the snapshot is the only copy of
//     older state: the seq allocator therefore floors new seqs at the
//     snapshot's `_last_seq` so replay never silently skips a write. When the
//     events replayed since the snapshot exceed a bounded threshold a fresh
//     snapshot is written; events already captured by a snapshot are then
//     trimmed to a bounded retention window.
//   - Every event and snapshot carries a migration version (`v`).
import {
  mkdirSync, readdirSync, readFileSync, writeFileSync, openSync, writeSync,
  fsyncSync, closeSync, renameSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const SCHEMA_VERSION = 1;
const MAX_SEQ_ATTEMPTS = 128;
// Replay-since-snapshot threshold and retention window for event records.
// Both are overridable per process for tests and operational tuning.
const SNAPSHOT_THRESHOLD_DEFAULT = 50;
const MAX_EVENTS_DEFAULT = 500;

function parsePositiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Events replayed since the last snapshot before a fresh snapshot is written. */
export function snapshotThreshold(env = process.env) {
  return parsePositiveInt(env.AGNTHIVE_STATE_SNAPSHOT_THRESHOLD, SNAPSHOT_THRESHOLD_DEFAULT);
}

/** Bounded event-record retention applied after a snapshot is written. */
export function eventRetentionLimit(env = process.env) {
  return parsePositiveInt(env.AGNTHIVE_STATE_MAX_EVENTS, MAX_EVENTS_DEFAULT);
}

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
  // ADR-0014: signature of the last UserPromptSubmit context message emitted
  // (task id + category + manager mode + profile). An unchanged signature
  // emits nothing, so repeated prompts for the same open task stay quiet.
  last_context_signature: '',
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
  // ADR-0002: the subagent_stop loop-block counter is keyed by agent_id in the
  // per-agent map below. When agent_id is absent a `_session` key preserves the
  // safety backstop for runtimes that omit it. (The legacy scalar
  // subagent_stop_block_count/_reason/_message fields were removed: nothing on
  // the subagent_stop path reads or writes them, and old set_many event logs
  // that still carry them are harmless — the reducer Object.assign's the keys
  // back into existence on replay with no consumer.)
  subagent_stop_blocks: {},
  files: [],
  // --- ADR-0009 evidence model (plan task 04) --------------------------------
  // Additive and inert until the corresponding handlers consume them; legacy
  // profile semantics are unchanged by the fields themselves.
  // revision: bumped on every tracked code/config edit; a verification result
  // is only current when its startedRevision == completedRevision == revision.
  revision: 0,
  // fs_revision_hint: conservative bump for file-mutating Bash commands that
  // the Edit/Write counters cannot see (documented fallback, ADR-0009).
  fs_revision_hint: 0,
  // verification: append-only records — {id, kind, command, toolUseId, status
  // (pending|passed|failed|unknown), startedRevision, completedRevision, cwd,
  // exitStatus, signal, error, startedAt, finishedAt, source}.
  verification: [],
  // review_results: append-only completed-review records — {id, agentId, role,
  // taskId, status (completed|unknown), revision, source, finishedAt}.
  review_results: [],
  // docs_status: 'updated' | 'not_required' | 'pending' | '' (unset).
  docs_status: '',
  // --- ADR-0010 task + agent lifecycle (plan tasks 05-06) ---------------------
  // task_id / active_task: task identity is separate from prompt identity.
  // active_task carries the open contract {id, kind, required_subagents,
  // required_subagent_any_of, dispatch_contract_mode, docs_required, status,
  // revision}; null when no task is open.
  task_id: '',
  active_task: null,
  last_task_id: '',
  // prompt_seq: monotonic local prompt counter (correlation only — never
  // provenance); last_prompt_id: for duplicate-submission dedupe of the same
  // prompt_id, not as origin proof (ADR-0010).
  prompt_seq: 0,
  last_prompt_id: '',
  // agents: registry keyed by stable agent id — {role, scope, taskId, status
  // (running|completed|unknown), starts, parent?, updatedAt}. Mutated only via
  // per-key map_set/map_delete events, like subagent_stop_blocks (ADR-0002/0006).
  agents: {},
  // background_tasks: registry keyed by runtime background task id; an explicit
  // empty registry is authoritative over stale transcript text (ADR-0010).
  background_tasks: {},
  // restored_task_seq: bookkeeping so ledger restoration fires once per
  // restoration cycle (ADR-0013).
  restored_task_seq: 0,
  // workflow_profile: the profile the session runs. 'lean' is the only profile
  // since 0.5.0 (plan task 16 removed 'legacy' when the compatibility window
  // closed); a session that still names 'legacy' runs 'lean' and the caller
  // prints an explicit migration note. A session that already carries a state
  // keeps the profile it was started with, so a profile change never alters a
  // running session's gates.
  workflow_profile: 'lean',
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

/**
 * Resolve a map-typed state field, returning the live map object or a fresh {}
 * when the field is missing or not a plain object. The `!Array.isArray` guard
 * matters: a stray array field would otherwise be index-addressed like a map.
 * Shared by the per-key map mutation events (map_set/map_delete). role_increment
 * keeps its own looser guard intentionally (it predates this helper and its
 * callers never target array fields).
 */
function resolveMapField(state, mapField) {
  const cur = state[mapField];
  return (cur && typeof cur === 'object' && !Array.isArray(cur)) ? cur : {};
}

/**
 * Validate a map_* event's `mapField` is a non-empty string, or return null
 * (tolerating a missing payload). Shared by `mapMutationContext` and the
 * `map_clear` case so every member of the map_* family applies the same
 * mapField guard and cannot drift on it.
 */
function validateMapField(ev) {
  const { mapField } = ev.payload || {};
  if (typeof mapField !== 'string' || mapField === '') return null;
  return mapField;
}

/**
 * Validate a per-key map-mutation payload and resolve its target map, or
 * return null when the payload is missing or the mapField/key are not
 * non-empty strings. Shared by map_set/map_delete so the two cases can't
 * drift on which guards they apply. Returns `{ map, mapField, key }`.
 */
function mapMutationContext(state, ev) {
  if (!ev.payload) return null;
  const mapField = validateMapField(ev);
  if (mapField === null) return null;
  const { key } = ev.payload;
  if (typeof key !== 'string' || key === '') return null;
  return { map: resolveMapField(state, mapField), mapField, key };
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
    // ADR-0002 race fix: per-key map mutation. Unlike set_many (a shallow
    // Object.assign that last-writer-wins the whole map and so loses a
    // concurrently-written sibling agent's entry), map_set/map_delete touch a
    // single key, so concurrent SubagentStop writers for different agents can no
    // longer clobber each other's loop-block counter.
    case 'map_set': {
      const ctx = mapMutationContext(state, ev);
      if (!ctx) break;
      ctx.map[ctx.key] = ev.payload.value;
      state[ctx.mapField] = ctx.map;
      break;
    }
    case 'map_delete': {
      const ctx = mapMutationContext(state, ev);
      if (!ctx) break;
      delete ctx.map[ctx.key];
      state[ctx.mapField] = ctx.map;
      break;
    }
    // ADR-0002 amendment: atomic full-map clear, the last member of the map_*
    // event family. Used by the turn reset (userPromptResetPatch) so the
    // per-agent map is cleared through a typed map_* event instead of overloading
    // a scalar set_many with a map field — this keeps the invariant "all
    // subagent_stop_blocks mutations flow through map_* events" with zero
    // exceptions. NOTE: this is a model-consistency win, NOT a per-key race fix.
    // A clear is intentionally whole-map (a new turn starts fresh), so a
    // concurrent map_set appended BEFORE this clear is wiped, just as a set_many
    // would; the ADR-0002 race fix proper is the per-key map_set/map_delete write
    // path, where two agents incrementing concurrently no longer clobber each
    // other. The reset is a deliberate clear, not a concurrent per-key write.
    case 'map_clear': {
      const mapField = validateMapField(ev);
      if (mapField === null) break;
      state[mapField] = {};
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
  const sorted = [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const state = structuredClone(DEFAULT_STATE);
  for (const ev of sorted) applyEvent(state, ev);
  return state;
}

function nextSeq(paths) {
  // The snapshot is the seq floor, not just the event filenames: a full trim
  // leaves an empty events dir while the snapshot still covers seq 1..N, and
  // replay only accepts seq > N. Deriving from filenames alone would restart
  // at 1 and every new event would be invisible to loadState.
  const snap = readSnapshot(paths);
  let max = snap && snap.state ? (snap.state._last_seq || 0) : 0;
  try {
    for (const f of readdirSync(paths.eventsDir)) {
      const m = f.match(/^(\d+)\.json$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* events dir not yet created */ }
  return max + 1;
}

// Per-directory write queue. A hook process may emit several events in one
// run; queueing them and flushing once turns N list+write rounds into one
// directory listing and one file write.
const pendingByDir = new Map();

function pendingQueue(paths) {
  let queue = pendingByDir.get(paths.eventsDir);
  if (!queue) { queue = []; pendingByDir.set(paths.eventsDir, queue); }
  return queue;
}

/** Queue one event; it becomes durable at the next flushEvents(paths). */
export function queueEvent(paths, type, payload = null) {
  pendingQueue(paths).push({ type, payload });
}

/**
 * Write every queued event for this session in one batch file, listing the
 * events directory once. Returns the batch sequence number, or null when the
 * queue was empty.
 *
 * Every event in a batch shares the batch seq: the batch is claimed by
 * exclusive creation of `<seq>.json`, exactly like the old per-event scheme,
 * so two parallel processes can never claim the same seq. Array order preserves
 * intra-batch order; seq order orders batches. The reducer, snapshot replay
 * (`seq > _last_seq`) and trim (deletes whole seqs) all treat a batch as one
 * unit, so a snapshot never covers a batch only partially.
 */
export function flushEvents(paths) {
  const queue = pendingByDir.get(paths.eventsDir);
  if (!queue || queue.length === 0) return null;
  ensureStateDir(paths);
  for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt++) {
    const seq = nextSeq(paths);
    // Filename is deterministic from seq so a concurrent writer that picked the
    // same seq hits EEXIST and retries with seq+1 — this is what makes the
    // sequence unique and monotonic under parallel writers. (A random suffix
    // here would let both writes succeed with the same seq — a lost update.)
    const file = join(paths.eventsDir, `${String(seq).padStart(10, '0')}.json`);
    const records = queue.map((ev) => ({ seq, type: ev.type, payload: ev.payload, v: SCHEMA_VERSION }));
    try {
      writeFileSync(file, JSON.stringify(records), { flag: 'wx' });
      queue.length = 0;
      return seq;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`could not allocate event seq after ${MAX_SEQ_ATTEMPTS} attempts`);
}

/**
 * Queue several events and flush them as one batch. Returns the batch seq
 * (shared by every event) or null for an empty batch.
 */
export function appendEvents(paths, events) {
  for (const ev of events) queueEvent(paths, ev.type, ev.payload ?? null);
  return flushEvents(paths);
}

/**
 * Append one event record immediately (queue + flush). Returns the assigned
 * sequence number. Safe under concurrent writers: an EEXIST collision on the
 * chosen seq triggers a retry with the next seq, so every event is durably
 * recorded exactly once.
 */
export function appendEvent(paths, type, payload = null) {
  return appendEvents(paths, [{ type, payload }]);
}

/**
 * Read all event records in sequence order. Corrupt files are skipped. A file
 * holds either one event (legacy shape) or an array of events (batch shape);
 * array order is preserved within a batch, and the stable seq sort keeps it.
 */
export function readEvents(paths) {
  try {
    const files = readdirSync(paths.eventsDir).filter((f) => f.endsWith('.json')).sort();
    const events = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(readFileSync(join(paths.eventsDir, f), 'utf8'));
        if (Array.isArray(parsed)) {
          for (const ev of parsed) {
            if (ev && typeof ev === 'object') events.push(ev);
          }
        } else if (parsed && typeof parsed === 'object') {
          events.push(parsed);
        }
      } catch { /* skip damaged event file */ }
    }
    return events.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  } catch { return []; }
}

/**
 * Atomically write a snapshot (temp file + fsync + rename). Returns false and
 * leaves the on-disk snapshot untouched when that snapshot already covers a
 * higher seq: a process that read older events must not regress the cache,
 * which matters now that trimming can delete events a stale snapshot still
 * needs.
 */
export function writeSnapshot(paths, state) {
  const stateSeq = state._last_seq || 0;
  const current = readSnapshot(paths);
  if (current && (current.state._last_seq || 0) > stateSeq) return false;
  ensureStateDir(paths);
  const tmp = `${paths.snapshot}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = openSync(tmp, 'wx');
    writeSync(fd, JSON.stringify({ state, v: SCHEMA_VERSION }));
    try { fsyncSync(fd); } catch { /* fsync unsupported or no-op */ }
    closeSync(fd);
    fd = null;
    // Re-check immediately before the rename to narrow the stale-writer window.
    const latest = readSnapshot(paths);
    if (latest && (latest.state._last_seq || 0) > stateSeq) return false;
    renameSync(tmp, paths.snapshot);
    return true;
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
 * events; once that replay exceeds snapshotThreshold() a fresh snapshot is
 * written and the covered log is trimmed. Otherwise rebuild from the full
 * event log, write a fresh snapshot, and trim to the retention window. A
 * damaged or missing snapshot is transparently rebuilt.
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
    // Refresh the snapshot cache once replaying has grown past the threshold,
    // then trim what the fresh snapshot already covers.
    if (replay.length > snapshotThreshold()) {
      try {
        writeSnapshot(paths, state);
        trimToBound(paths, events, coveredSnapshotSeq(paths, state._last_seq));
      } catch { /* snapshot is a cache; keep replaying from events */ }
    }
    return state;
  }
  const state = reducer(events);
  if (events.length) {
    try {
      writeSnapshot(paths, state);
      trimToBound(paths, events, coveredSnapshotSeq(paths, state._last_seq));
    } catch { /* snapshot is a cache; non-fatal */ }
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

/**
 * The highest seq the snapshot currently on disk covers (bounded by our own
 * state seq). Returns 0 when no readable snapshot is present, so callers skip
 * trimming rather than delete events no cache covers.
 */
function coveredSnapshotSeq(paths, ownSeq) {
  const snap = readSnapshot(paths);
  const onDiskSeq = snap && snap.state ? (snap.state._last_seq || 0) : 0;
  if (onDiskSeq <= 0) return 0;
  return Math.min(ownSeq || 0, onDiskSeq);
}

/**
 * Retention window applied after a snapshot is written: keep at most
 * eventRetentionLimit() event records, measured in whole batches (a batch is
 * never split), and never delete a seq the snapshot does not cover. The latter
 * is what makes trimming safe against a concurrent writer that appended newer
 * events after this process read the log.
 */
function trimToBound(paths, events, snapshotSeq) {
  const limit = eventRetentionLimit();
  if (!Number.isFinite(snapshotSeq) || snapshotSeq <= 0 || events.length <= limit) return;
  const sorted = [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const firstKept = sorted[sorted.length - limit];
  const cutoffSeq = Math.min((firstKept.seq || 0) - 1, snapshotSeq);
  if (cutoffSeq > 0) trimEvents(paths, cutoffSeq);
}
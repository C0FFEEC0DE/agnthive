// ledger.mjs — durable progress-ledger restoration after context compaction.
// Ported from post-compact.sh + lib.sh progress_ledger_path. Node standard
// library only.
//
// The progress ledger is a plain-markdown file the controller appends one line
// per completed task during Subagent-Driven Development, so work survives
// context compaction. The primary recovery mechanism is the agent reading the
// file at skill start.
//
// ADR-0013 (plan task 07): the guaranteed restoration channel is SessionStart
// compact/resume via buildSessionStartRestore — a COMPACT summary (open task
// id/kind + revision + explicit ledger path), never the full ledger text, once
// per restoration cycle (restored_task_seq bookkeeping). PostCompact injection
// is deprecated: the PostCompact hook stays for bounded bookkeeping telemetry
// only, and buildPostCompactContext is retained until the dispatcher (task 07 /
// task 08 wiring) drops its PostCompact additionalContext call.
//
// The 64 KiB cap stays a STORAGE cap for the ledger FILE policy (plan 07.3): an
// oversized ledger is diagnosed, not injected. The byte-cap truncation helper
// (AGNTHIVE_LEDGER_MAX_BYTES, default 64 KiB; legacy CLAUDE_CREW_LEDGER_MAX_BYTES
// alias still honored) is UTF-8 safe: a cap that lands inside a multibyte
// sequence drops the partial sequence rather than emitting invalid UTF-8 to
// JSON serialization.
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isNonEmpty } from './util.mjs';

export const DEFAULT_LEDGER_MAX_BYTES = 64 * 1024; // 64 KiB

/** Resolve a numeric byte cap from env, falling back to the default on invalid.
 *  Precedence (highest first): AGNTHIVE_LEDGER_MAX_BYTES, legacy
 *  CLAUDE_CREW_LEDGER_MAX_BYTES, then CLAUDE_PLUGIN_OPTION_LEDGER_MAX_BYTES (the
 *  plugin userConfig bridge, exported by Claude Code from the ledger_max_bytes
 *  userConfig key). */
export function resolveLedgerMaxBytes(env = process.env, fallback = DEFAULT_LEDGER_MAX_BYTES) {
  const raw = env.AGNTHIVE_LEDGER_MAX_BYTES ?? env.CLAUDE_CREW_LEDGER_MAX_BYTES ?? env.CLAUDE_PLUGIN_OPTION_LEDGER_MAX_BYTES;
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Durable progress-ledger location. Honors AGNTHIVE_PROGRESS_FILE (legacy
 * CLAUDE_CREW_PROGRESS_FILE alias still honored); otherwise resolves to
 * <projectDir>/.agnthive/progress.md (gitignored scratch, never committed).
 * Mirrors lib.sh progress_ledger_path.
 */
export function progressLedgerPath(projectDir, env = process.env) {
  const explicit = env.AGNTHIVE_PROGRESS_FILE ?? env.CLAUDE_CREW_PROGRESS_FILE;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const base = isNonEmpty(projectDir) ? projectDir : '.';
  return join(base, '.agnthive', 'progress.md');
}

/**
 * Truncate a byte buffer to at most `maxBytes`, dropping any trailing partial
 * multibyte UTF-8 sequence so the result decodes to valid UTF-8. Mirrors the
 * bash `head -c | iconv -c` sanitize step (which drops invalid bytes), but in
 * pure Node. Exported for notifications.mjs (verbose compact log cap), which
 * must stay content-bounded too (ADR-0013).
 *
 * Algorithm: find the lead byte of the UTF-8 sequence that contains the byte
 * just before the cut (walking back over continuation bytes 0x80..0xBF). If
 * that whole sequence fits within the cap, keep up to the cap; otherwise drop
 * the incomplete sequence entirely (keep up to its lead byte). This correctly
 * keeps a complete sequence whose final byte lands exactly on the cap, and
 * drops one whose final byte would fall past it.
 */
export function truncateUtf8(buf, maxBytes) {
  if (!(buf instanceof Uint8Array) && !Buffer.isBuffer(buf)) {
    throw new Error('truncateUtf8 expects a Buffer/Uint8Array');
  }
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let p = maxBytes;
  // Walk back over continuation bytes to the lead byte of the boundary sequence.
  while (p > 0 && (buf[p - 1] & 0xC0) === 0x80) p--;
  if (p === 0) return ''; // cut is inside the first sequence, no lead byte in-window
  const leadIndex = p - 1;
  const lead = buf[leadIndex];
  let len = 1;
  if ((lead & 0xE0) === 0xC0) len = 2;
  else if ((lead & 0xF0) === 0xE0) len = 3;
  else if ((lead & 0xF8) === 0xF0) len = 4;
  if (leadIndex + len <= maxBytes) {
    return buf.subarray(0, maxBytes).toString('utf8'); // sequence complete within cap
  }
  return buf.subarray(0, leadIndex).toString('utf8'); // drop the incomplete sequence
}

/**
 * Read the ledger for PostCompact re-injection. Returns null when the ledger
 * is missing, empty, or whitespace-only; otherwise { content, truncationNote,
 * size }. When the ledger exceeds the byte cap, content is UTF-8-safe truncated
 * text and truncationNote explains the cap.
 */
export function readLedgerForInjection(path, maxBytes = DEFAULT_LEDGER_MAX_BYTES) {
  if (!isNonEmpty(path) || !existsSync(path)) return null;
  let size = 0;
  try { size = statSync(path).size; } catch { return null; }
  let buf;
  try { buf = readFileSync(path); } catch { return null; }
  let content;
  let truncationNote = '';
  if (size > maxBytes) {
    content = truncateUtf8(buf, maxBytes);
    truncationNote = `[Ledger truncated: ${size} bytes exceeds ${maxBytes} byte limit. Verify recent tasks manually.]`;
  } else {
    content = buf.toString('utf8');
  }
  if (!isNonEmpty(content.replace(/\s+/g, ''))) return null;
  return { content, truncationNote, size };
}

const LEDGER_PREFIX = 'You are resuming after a context compaction. Your durable progress ledger follows — trust it and git log over your own recollection; tasks it marks complete are DONE, do not re-dispatch them.\n\n';

/**
 * Deprecated PostCompact injection builder. Retained for history/unit tests
 * until the dispatcher (task 07/08 wiring, orchestrator) drops its PostCompact
 * additionalContext call site; the restoration contract is now
 * buildSessionStartRestore (ADR-0013).
 */
export function buildPostCompactContext(ledger) {
  if (!ledger || !isNonEmpty(ledger.content)) return null;
  if (isNonEmpty(ledger.truncationNote)) {
    return `${LEDGER_PREFIX}${ledger.content}\n\n${ledger.truncationNote}`;
  }
  return `${LEDGER_PREFIX}${ledger.content}`;
}

// --- ADR-0013: SessionStart compact/resume restoration ----------------------

/**
 * Bounded ledger-file status for restore decisions. Stat-only (the file
 * content is never read here): missing, empty, oversized (size > maxBytes), or
 * present. `path` is echoed back so callers can report the exact location.
 */
export function ledgerStatus(path, maxBytes = DEFAULT_LEDGER_MAX_BYTES) {
  if (!isNonEmpty(path)) return { path: '', size: 0, status: 'missing' };
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { path, size: 0, status: 'missing' };
  }
  if (size > maxBytes) return { path, size, status: 'oversized' };
  if (size === 0) return { path, size, status: 'empty' };
  return { path, size, status: 'present' };
}

/** Terminal statuses the task lifecycle (ADR-0010) can record on active_task. */
const TERMINAL_TASK_STATUS = new Set(['completed', 'closed', 'cancelled']);

/**
 * Read the open-task identity the restore message needs, or null when there is
 * no open task: active_task missing / not an object, no usable id, or a
 * terminal status. Unknown/absent status counts as open (defensive: the
 * lifecycle owner's writer decides the value). kind falls back to
 * state.task_type then 'other'; revision falls back to the task-open revision
 * when the global counter is unusable.
 */
function activeRestoreTask(state) {
  const t = state?.active_task;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const id = typeof t.id === 'string' && t.id.length > 0 ? t.id : '';
  if (!id) return null;
  const status = typeof t.status === 'string' ? t.status : '';
  if (TERMINAL_TASK_STATUS.has(status)) return null;
  const kind = isNonEmpty(t.kind) ? t.kind
    : (isNonEmpty(state?.task_type) ? state.task_type : 'other');
  const global = Number(state?.revision);
  const taskRev = Number(t.revision);
  const revision = Number.isFinite(global) ? global
    : (Number.isFinite(taskRev) ? taskRev : 0);
  return { id, kind, revision };
}

/** Restore message prefix. Kept deliberately short: it is injected context. */
const RESTORE_PREFIX = '[AgntHive] Context restored after compaction.';

/**
 * Build the SessionStart compact/resume restoration output (ADR-0013, plan
 * tasks 07.1-07.3). PURE given state + projectDir: it reads no state store and
 * mutates nothing — the only I/O is a stat of the ledger file (the content is
 * never read), so the full ledger text is never pulled into the message.
 *
 * The orchestrator (dispatcher, task 07 wiring) owns the gate: call this only
 * for SessionStart inputs whose `source` is `compact` or `resume`. The builder
 * itself re-checks the task gate, so even a mis-wired startup source injects
 * nothing on a fresh session start (no open task → null).
 *
 * @param {object|null} state  reduced session state (active_task, revision,
 *   task_type, restored_task_seq)
 * @param {object} [options]
 *   - projectDir  project directory for the default ledger path
 *   - env         env overrides (AGNTHIVE_PROGRESS_FILE legacy aliases honored)
 *   - ledgerPath  explicit ledger path; wins over projectDir resolution
 *   - maxBytes    ledger storage cap (default resolveLedgerMaxBytes(env))
 *   - cycleSeq    restoration-cycle token for once-per-cycle dedupe. When
 *                 provided (finite number > 0): the restore is suppressed when
 *                 state.restored_task_seq >= cycleSeq (already restored at or
 *                 after this token), and the emitted patch sets
 *                 restored_task_seq to that token (idempotent set). When
 *                 absent: every gate invocation is its own restoration cycle
 *                 and the patch increments restored_task_seq. Suggested token
 *                 for the orchestrator: the count of restoration-source
 *                 SessionStart events observed this session.
 *
 * @returns null when nothing should be injected (no open task or dedupe hit) —
 *   the orchestrator returns passthrough() and appends no state event.
 *
 * @returns {{message: string, patch: {restored_task_seq: number},
 *            ledger: {path: string, size: number,
 *                     status: 'present'|'missing'|'empty'|'oversized'}}}
 *   message — compact summary for additionalContext(message, 'SessionStart')
 *   patch   — restored_task_seq bookkeeping value the orchestrator SETs
 *             (persistPatch) when it acts on this result
 *   ledger  — status facts (for tests / a future telemetry record)
 */
export function buildSessionStartRestore(state, options = {}) {
  const env = options.env ?? process.env;
  const task = activeRestoreTask(state);
  if (!task) return null;
  const capNum = Number(options.maxBytes);
  const maxBytes = Number.isFinite(capNum) && capNum > 0
    ? Math.floor(capNum)
    : resolveLedgerMaxBytes(env);
  const path = isNonEmpty(options.ledgerPath)
    ? options.ledgerPath
    : progressLedgerPath(options.projectDir, env);
  const ledger = ledgerStatus(path, maxBytes);
  const cycleNum = Number(options.cycleSeq);
  if (Number.isFinite(cycleNum) && cycleNum > 0) {
    const cycleSeq = Math.floor(cycleNum);
    if ((Number(state.restored_task_seq) || 0) >= cycleSeq) return null; // dedupe
    return {
      message: restoreMessage(task, ledger, maxBytes),
      patch: { restored_task_seq: cycleSeq },
      ledger,
    };
  }
  return {
    message: restoreMessage(task, ledger, maxBytes),
    patch: { restored_task_seq: (Number(state.restored_task_seq) || 0) + 1 },
    ledger,
  };
}

/** Compact restore message for the ledger's current on-disk status. Bounded. */
function restoreMessage(task, ledger, maxBytes) {
  const head = `${RESTORE_PREFIX} Open task: ${task.id} (kind: ${task.kind}, revision ${task.revision}).`;
  if (ledger.status === 'present') {
    return `${head} Durable progress ledger: ${ledger.path} (${ledger.size} bytes). The ledger is not re-injected in full — read that file for the completed-work list; entries it marks complete are DONE, do not re-dispatch them.`;
  }
  if (ledger.status === 'oversized') {
    return `${head} Progress ledger ${ledger.path} is ${ledger.size} bytes, over the ${maxBytes} byte storage cap, so its content was not read into context. Read the most recent portion of that file directly, then reconcile against git log; do not treat any task as complete without direct evidence.`;
  }
  const why = ledger.status === 'empty' ? 'found empty' : 'missing';
  return `${head} Progress ledger ${ledger.path} has no readable content (${why}). Reconstruct the current place from git status, git log and the session transcript before continuing; do not treat any task as complete without direct evidence.`;
}
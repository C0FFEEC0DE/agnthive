// notifications.mjs — telemetry JSONL append + size-based rotation for the
// hook observability streams. Ported from lib.sh append_jsonl /
// rotate_jsonl_if_needed. Node standard library only.
//
// Every hook JSONL stream (notification, session-index, pre/post-compact,
// config-change, instructions-loaded, stop-failure) is appended here and rotated
// when it crosses AGNTHIVE_LOG_MAX_BYTES (default 1 MiB; legacy
// CLAUDE_CREW_LOG_MAX_BYTES alias still honored): the current file moves to
// <name>.old and a fresh empty file starts, so no stream grows unbounded.
//
// What is recorded: payloads are built from a fixed field whitelist (session
// ids, event type/kind names, trigger names, cwd/path, correlation ids,
// counts/flags/sizes) and serialized with JSON.stringify, which escapes
// quotes/backslashes/control chars. The runtime never logs credentials or full
// environment variables. Default records carry NO prompt/transcript content:
// post-compact.jsonl keeps size/status metadata only, and stop-failure.jsonl
// keeps error metadata (kind/exit code/signal) without API error text.
// AGNTHIVE_VERBOSE_COMPACT_LOG=1 explicitly opts the post-compact record into
// storing the (bounded) compact summary text, which may contain session
// content — retention and redaction caveats are documented in the plugin
// README (docs land with plan task 15). Verbose is not guaranteed secret-safe:
// field selection is not redaction (ADR-0013).
import { Buffer } from 'node:buffer';
import { mkdirSync, statSync, renameSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timestampUtc } from './util.mjs';
import { truncateUtf8 } from './ledger.mjs';

export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024; // 1 MiB

/** Read a numeric env override, falling back to the default on invalid/empty.
 *  Precedence (highest first): AGNTHIVE_LOG_MAX_BYTES, legacy
 *  CLAUDE_CREW_LOG_MAX_BYTES, then CLAUDE_PLUGIN_OPTION_LOG_MAX_BYTES (the plugin
 *  userConfig bridge, exported by Claude Code from the log_max_bytes userConfig key). */
export function resolveLogMaxBytes(env = process.env, fallback = DEFAULT_LOG_MAX_BYTES) {
  const raw = env.AGNTHIVE_LOG_MAX_BYTES ?? env.CLAUDE_CREW_LOG_MAX_BYTES ?? env.CLAUDE_PLUGIN_OPTION_LOG_MAX_BYTES;
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !/^\d+$/.test(raw.trim())) return fallback;
  return Math.floor(n);
}

/** Ensure the log root exists. Returns the path to <logRoot>/<name>. */
function logFile(logRoot, name) {
  return join(logRoot, name);
}

/**
 * Rotate a JSONL stream if its size has reached the threshold. Mirrors
 * rotate_jsonl_if_needed: move the file to <name>.old (overwriting any prior
 * .old) and start a fresh empty file. A missing or sub-threshold file is left
 * untouched.
 */
export function rotateJsonlIfNeeded(logRoot, name, maxBytes = DEFAULT_LOG_MAX_BYTES) {
  const file = logFile(logRoot, name);
  let size = 0;
  try { size = statSync(file).size; } catch { return; } // missing -> nothing to rotate
  if (size >= maxBytes) {
    try { renameSync(file, `${file}.old`); } catch { /* best-effort rotation */ }
    try { writeFileSync(file, ''); } catch { /* will be recreated on append */ }
  }
}

/**
 * Append one JSON payload as a line to <logRoot>/<name>, rotating first if the
 * stream has reached the max-byte threshold. Mirrors append_jsonl. The payload
 * is serialized with JSON.stringify (no trailing newline); a single '\n' is
 * appended so each record is one line.
 */
export function appendJsonl(logRoot, name, payload, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  mkdirSync(logRoot, { recursive: true });
  rotateJsonlIfNeeded(logRoot, name, maxBytes);
  const line = `${JSON.stringify(payload ?? null)}\n`;
  appendFileSync(logFile(logRoot, name), line);
}

// --- payload builders (field whitelists; everything else is dropped) --------

function str(v) { return typeof v === 'string' ? v : ''; }

/**
 * Notification telemetry payload (notification.sh). F10/ADR-0013: record the
 * current `notification_type` field, bridging older runtimes whose hook input
 * still carries only the `subtype` alias. `subtype` itself is no longer
 * written (no reader of this stream consumed it — verified by grep; see the
 * module header for the retention caveat), and ADR-0010 correlation ids come
 * along when the hook input carries them: ids only, never message content.
 */
export function notificationPayload(data, ts = timestampUtc()) {
  return {
    ts,
    session_id: str(data?.session_id),
    notification_type: str(data?.notification_type ?? data?.subtype),
    title: str(data?.title),
    message: str(data?.message),
    context: str(data?.context),
    agent_id: str(data?.agent_id),
    prompt_id: str(data?.prompt_id),
  };
}

/** Instructions-loaded audit payload (instructions-loaded.sh). */
export function instructionsLoadedPayload(data, ts = timestampUtc()) {
  return {
    ts,
    session_id: str(data?.session_id),
    file_path: str(data?.file_path),
    memory_type: str(data?.memory_type),
    load_reason: str(data?.load_reason),
  };
}

/** Pre-compaction marker payload (pre-compact.sh), with a state snapshot. */
export function preCompactPayload(data, state, ts = timestampUtc()) {
  return { ts, session_id: str(data?.session_id), trigger: str(data?.trigger), state: state ?? null };
}

/**
 * AGNTHIVE_VERBOSE_COMPACT_LOG: the explicit opt-in for storing the compact
 * summary text in post-compact.jsonl (ADR-0013: explicit, bounded, documented
 * — not secret-safe). Truthy values: 1, true, yes, on (case-insensitive).
 */
export function verboseCompactLog(env = process.env) {
  const raw = env?.AGNTHIVE_VERBOSE_COMPACT_LOG;
  return typeof raw === 'string' && /^(1|true|yes|on)$/i.test(raw);
}

/** Compact the verbose post-compact summary text to a bounded record. */
function boundedCompactSummary(summary, env) {
  const cap = resolveLogMaxBytes(env);
  const buf = Buffer.from(summary, 'utf8');
  if (buf.length <= cap) return { text: summary, truncated: false };
  return { text: truncateUtf8(buf, cap), truncated: true };
}

/**
 * Post-compaction bookkeeping marker (post-compact.sh). DEFAULT: metadata and
 * size/status only — the compact_summary text is NOT stored, so the record
 * cannot leak summary (potentially sensitive) content into telemetry unless
 * the explicit AGNTHIVE_VERBOSE_COMPACT_LOG=1 opt-in is set. When verbose is
 * on, the summary text is stored capped (to the stream's rotation threshold,
 * AGNTHIVE_LOG_MAX_BYTES) and UTF-8-safe, alongside a truncation flag.
 * The handler + hooks.json registration stay with the orchestrator (task 07).
 */
export function postCompactPayload(data, ts = timestampUtc(), env = process.env) {
  const summary = str(data?.compact_summary);
  const record = {
    ts,
    session_id: str(data?.session_id),
    trigger: str(data?.trigger),
    compact_summary_present: summary.length > 0,
    compact_summary_bytes: Buffer.byteLength(summary, 'utf8'),
  };
  if (verboseCompactLog(env)) {
    const bounded = boundedCompactSummary(summary, env);
    record.compact_summary = bounded.text;
    record.compact_summary_truncated = bounded.truncated;
    record.compact_summary_present = bounded.truncated || summary.length > 0;
  }
  return record;
}

/**
 * Stop-failure telemetry payload (ADR-0013, plan task 07.6): one record per
 * observed Stop/turn failure. Bounded metadata only — identifiers plus the
 * failure kind, exit code and signal. API error text is deliberately NOT
 * stored: it is a diagnostic, not a completion summary (never "task done"
 * evidence), and content retention in telemetry is not warranted. Accepts a
 * flat or nested `error` object; unknown shapes degrade to empty strings and
 * a null exit code. The handler (handleStopFailure) and the hooks.json
 * registration are the orchestrator's / policy owner's (task 07/08).
 */
export function stopFailurePayload(data, ts = timestampUtc()) {
  const e = (data?.error && typeof data.error === 'object' && !Array.isArray(data.error)) ? data.error : {};
  return {
    ts,
    session_id: str(data?.session_id),
    error_name: boundedStr(e.name ?? e.kind ?? data?.error_name ?? data?.error_kind),
    exit_code: boundedInt(e.exit_code ?? e.exitCode ?? data?.exit_code),
    signal: boundedStr(e.signal ?? data?.signal),
    agent_id: str(data?.agent_id),
  };
}

/** String bounded to a small fixed cap (stop-failure fields; ADR-0013). */
function boundedStr(v, cap = 200) {
  const s = str(v);
  return s.length > cap ? s.slice(0, cap) : s;
}

/** Integer exit code (bounded scalar), or null when absent/not an integer. */
function boundedInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** Config-change audit payload (config-change.sh). */
export function configChangePayload(data, ts = timestampUtc()) {
  return { ts, session_id: str(data?.session_id), source: str(data?.source), file_path: str(data?.file_path) };
}

/** Session-end index payload (session-end.sh), with a state snapshot. */
export function sessionEndPayload(data, state, ts = timestampUtc()) {
  return {
    ts,
    session_id: str(data?.session_id),
    cwd: str(data?.cwd),
    transcript_path: str(data?.transcript_path),
    reason: str(data?.reason),
    state: state ?? null,
  };
}

/** Read the lines of a JSONL log file (best-effort; missing file -> []). */
export function readJsonlLines(logRoot, name) {
  const file = logFile(logRoot, name);
  if (!existsSync(file)) return [];
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter((l) => l.length > 0).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
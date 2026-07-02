// notifications.mjs — telemetry JSONL append + size-based rotation for the
// hook observability streams. Ported from lib.sh append_jsonl /
// rotate_jsonl_if_needed. Node standard library only.
//
// Every hook JSONL stream (notification, session-index, pre/post-compact,
// config-change, instructions-loaded) is appended here and rotated when it
// crosses CLAUDE_CREW_LOG_MAX_BYTES (default 1 MiB): the current file moves to
// <name>.old and a fresh empty file starts, so no stream grows unbounded.
//
// Redaction policy: payloads are built from a fixed field whitelist
// (session_id, title/message/subtype/context, cwd, trigger, file_path, …) and
// serialized with JSON.stringify, which escapes quotes/backslashes/control
// chars. The runtime never logs credentials, full environment variables, or
// prompt/transcript contents — only the explicitly-listed hook fields.
import { mkdirSync, statSync, renameSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timestampUtc } from './util.mjs';

export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024; // 1 MiB

/** Read a numeric env override, falling back to the default on invalid/empty. */
export function resolveLogMaxBytes(env = process.env, fallback = DEFAULT_LOG_MAX_BYTES) {
  const raw = env.CLAUDE_CREW_LOG_MAX_BYTES;
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

/** Notification telemetry payload (notification.sh). */
export function notificationPayload(data, ts = timestampUtc()) {
  return {
    ts,
    session_id: str(data?.session_id),
    title: str(data?.title),
    message: str(data?.message),
    subtype: str(data?.subtype),
    context: str(data?.context),
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

/** Post-compaction marker payload (post-compact.sh). */
export function postCompactPayload(data, ts = timestampUtc()) {
  return { ts, session_id: str(data?.session_id), trigger: str(data?.trigger), compact_summary: str(data?.compact_summary) };
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
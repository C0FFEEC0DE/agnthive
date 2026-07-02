// ledger.mjs — durable progress-ledger re-injection after context compaction.
// Ported from post-compact.sh + lib.sh progress_ledger_path. Node standard
// library only.
//
// The progress ledger is a plain-markdown file the controller appends one line
// per completed task during Subagent-Driven Development, so work survives
// context compaction. The primary recovery mechanism is the agent reading the
// file at skill start; PostCompact best-effort re-surfaces it in the freshly
// compacted context. When no ledger exists, the hook emits nothing.
//
// Truncation is byte-capped (CLAUDE_CREW_LEDGER_MAX_BYTES, default 64 KiB) and
// UTF-8 safe: a cap that lands inside a multibyte sequence drops the partial
// sequence rather than emitting invalid UTF-8 to JSON serialization.
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isNonEmpty } from './util.mjs';

export const DEFAULT_LEDGER_MAX_BYTES = 64 * 1024; // 64 KiB

/** Resolve a numeric byte cap from env, falling back to the default on invalid. */
export function resolveLedgerMaxBytes(env = process.env, fallback = DEFAULT_LEDGER_MAX_BYTES) {
  const raw = env.CLAUDE_CREW_LEDGER_MAX_BYTES;
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Durable progress-ledger location. Honors CLAUDE_CREW_PROGRESS_FILE;
 * otherwise resolves to <projectDir>/.claude-crew/progress.md (gitignored
 * scratch, never committed). Mirrors lib.sh progress_ledger_path.
 */
export function progressLedgerPath(projectDir, env = process.env) {
  const explicit = env.CLAUDE_CREW_PROGRESS_FILE;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const base = isNonEmpty(projectDir) ? projectDir : '.';
  return join(base, '.claude-crew', 'progress.md');
}

/**
 * Truncate a byte buffer to at most `maxBytes`, dropping any trailing partial
 * multibyte UTF-8 sequence so the result decodes to valid UTF-8. Mirrors the
 * bash `head -c | iconv -c` sanitize step (which drops invalid bytes), but in
 * pure Node.
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
 * Build the PostCompact additionalContext message that re-surfaces the ledger.
 * Returns null when there is no ledger to inject. Mirrors post-compact.sh.
 */
export function buildPostCompactContext(ledger) {
  if (!ledger || !isNonEmpty(ledger.content)) return null;
  if (isNonEmpty(ledger.truncationNote)) {
    return `${LEDGER_PREFIX}${ledger.content}\n\n${ledger.truncationNote}`;
  }
  return `${LEDGER_PREFIX}${ledger.content}`;
}
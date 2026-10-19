// transcripts.mjs — transcript JSONL parsing and last-assistant-message
// extraction. Ported from lib.sh: tail_jsonl_lines,
// extract_last_assistant_message_from_jsonl_stream,
// extract_last_assistant_message_from_transcript, resolved_last_assistant_message,
// transcript_indicates_backgrounded_agent. Node standard library only.
import { readFileSync, statSync } from 'node:fs';

function fileExists(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/**
 * Return the last `lines` lines of a transcript file as a string. Missing or
 * unreadable files yield ''. Mirrors `tail -n N file || cat file`.
 */
export function tailJsonlLines(transcriptPath, lines = 200) {
  if (!transcriptPath || !fileExists(transcriptPath)) return '';
  let content;
  try { content = readFileSync(transcriptPath, 'utf8'); } catch { return ''; }
  if (!content) return '';
  const all = content.split('\n');
  // trailing newline produces a final empty element; drop it like `tail` does
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const start = Math.max(0, all.length - lines);
  return all.slice(start).join('\n');
}

/** True if a string is non-empty after collapsing all whitespace. */
function hasNonWsText(s) {
  return typeof s === 'string' && s.replace(/\s+/g, '').length > 0;
}

/**
 * flattened_text (jq): for an array, join the .text/.result/.content strings
 * of its object elements with non-whitespace content. Non-arrays yield ''.
 */
function flattenedText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const el of content) {
    if (el && typeof el === 'object') {
      const v = el.text ?? el.result ?? el.content;
      if (typeof v === 'string' && hasNonWsText(v)) parts.push(v);
    }
  }
  return parts.join('\n');
}

/**
 * assistant_text (jq): the first non-empty string among last_assistant_message,
 * assistant_message, result, flattened(message.content), flattened(content),
 * message.text, text.
 */
function assistantText(entry) {
  const candidates = [
    entry?.last_assistant_message,
    entry?.assistant_message,
    entry?.result,
    flattenedText(entry?.message?.content),
    flattenedText(entry?.content),
    entry?.message?.text,
    entry?.text,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && hasNonWsText(c)) return c;
  }
  return '';
}

function isAssistantEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'assistant') return true;
  if (entry.type === 'result' && !('tool_use_id' in entry)) return true;
  if (entry.role === 'assistant') return true;
  if (entry?.message?.role === 'assistant') return true;
  return false;
}

/**
 * Extract the last assistant message from a JSONL stream (string). Parses each
 * non-empty line as JSON (skipping invalid lines), reverses, and returns the
 * first assistant entry's text. Mirrors the jq pipeline in lib.sh.
 */
export function extractLastAssistantMessageFromJsonlStream(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed)); } catch { /* skip invalid line */ }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isAssistantEntry(entries[i])) {
      const msg = assistantText(entries[i]);
      if (msg) return msg;
    }
  }
  return '';
}

/** Extract the last assistant message from a transcript file (tail-first). */
export function extractLastAssistantMessageFromTranscript(transcriptPath) {
  if (!transcriptPath || !fileExists(transcriptPath)) return '';
  const tail = tailJsonlLines(transcriptPath, 200);
  const msg = extractLastAssistantMessageFromJsonlStream(tail);
  if (msg) return msg;
  // fall back to the full file
  let full;
  try { full = readFileSync(transcriptPath, 'utf8'); } catch { return ''; }
  return extractLastAssistantMessageFromJsonlStream(full);
}

/**
 * resolved_last_assistant_message: prefer explicit fields on the hook input,
 * then read the transcript. `hookInput` is the parsed stdin object.
 */
export function resolvedLastAssistantMessage(hookInput, transcriptPath) {
  const d = hookInput || {};
  const direct = d.last_assistant_message ?? d.assistant_message ?? d.result ?? d?.message?.text ?? d.text;
  if (typeof direct === 'string' && hasNonWsText(direct)) return direct;
  return extractLastAssistantMessageFromTranscript(transcriptPath);
}

/** True if the transcript mentions a backgrounded agent (case-insensitive). */
export function transcriptIndicatesBackgroundedAgent(transcriptPath) {
  if (!transcriptPath || !fileExists(transcriptPath)) return false;
  let content;
  try { content = readFileSync(transcriptPath, 'utf8'); } catch { return false; }
  if (!content) return false;
  // tail-first like the bash (tail 400 then full file); for a single read the
  // full-file check covers both, but keep the tail-scan for parity on huge files
  const tail = tailJsonlLines(transcriptPath, 400);
  return /backgrounded agent/i.test(tail) || /backgrounded agent/i.test(content);
}
// --- ADR-0010 subagent report ownership (plan 06.3) -------------------------

/** First non-empty string among the given values (null when none). */
function firstString(values) {
  for (const v of values) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}
/**
 * Delivered report probes, most-specific first (ADR-0010 report ownership).
 * Only fields the payload actually carries are probed — no invented fields.
 */
function deliveredReportText(data) {
  const probes = [];
  for (const f of ['report', 'last_assistant_message', 'assistant_message', 'result']) {    probes.push(data[f]);
  }  const m = data.message;
  if (typeof m === 'string') { probes.splice(1, 0, m); }
  else if (m && typeof m === 'object') {    probes.push(m.text);
    probes.push(flattenedText(m.content));
  }
  probes.push(data.text);  for (const v of probes) {
    if (typeof v === 'string' && hasNonWsText(v)) return v;
  }
  return '';
}

/**
 * resolveSubagentReport (plan 06.3, ADR-0010): resolve the subagent's report
 * text with explicit ownership. Source labels:
 *   'handback'           — delivered report data (the payload's own fields)
 *   'subagent_transcript' — last assistant message of the subagent's OWN
 *                          transcript (agent_transcript_path)
 *   'parent_transcript'  — last assistant message of the PARENT transcript;
 *                          explicitly labeled so it can never pass as the
 *                          child's result (ADR-0010: parent transcript is
 *                          never the child's report). Returned ONLY when
 *                          opts.allowParentTranscript === true — the default
 *                          resolution NEVER reads the parent transcript.
 *   'unknown'            — nothing else produced text ({ text: '' }).
 * `parsed` may be the parseHookInput shape (parsed.data) or the raw payload;
 * agentId comes from parsed.agentId (or data.agent_id / data.agentId).
 */
export function resolveSubagentReport(parsed, state = null, opts = {}) {  let data = {};
  if (parsed?.data && typeof parsed.data === 'object') data = parsed.data;
  else if (parsed && typeof parsed === 'object') data = parsed;
  const agentId = firstString([parsed?.agentId, data.agent_id, data.agentId]);  const delivered = deliveredReportText(data);
  if (delivered) return { source: 'handback', text: delivered, agentId };
  const agentPath = firstString([parsed?.agentTranscriptPath, data.agent_transcript_path, data.agentTranscriptPath]);
  if (agentPath && fileExists(agentPath)) {
    const text = extractLastAssistantMessageFromTranscript(agentPath);
    if (text) return { source: 'subagent_transcript', text, agentId };
  }
  if (opts?.allowParentTranscript === true) {
    const parentPath = firstString([parsed?.transcriptPath, state?.transcript_path]);
    const text = parentPath ? extractLastAssistantMessageFromTranscript(parentPath) : '';    if (text) return { source: 'parent_transcript', text, agentId };
  }
  return { source: 'unknown', text: '', agentId };
}

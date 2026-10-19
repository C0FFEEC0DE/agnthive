// Shared helpers for the Node benchmark CLIs.
// Node standard library only — no Python, Bash, jq, or external deps.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** True when this module is the entry point (node scripts/foo.mjs). */
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(process.argv[1]).href === importMetaUrl;
  } catch {
    return false;
  }
}

/** Read and parse a JSON file (UTF-8). Throws on missing/invalid JSON. */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * A JSON number that retains its original literal text so renderers can match
 * jq's number-to-string (jq preserves `20.0` as "20.0"; JSON.parse collapses it
 * to 20). Arithmetic and comparisons work via valueOf; template-literal
 * interpolation uses the original literal via toString.
 */
export class JSONNum {
  constructor(literal, value) {
    this.literal = literal;
    this.value = value;
  }
  valueOf() { return this.value; }
  toString() { return this.literal; }
  toJSON() { return this.value; }
}

/**
 * Parse JSON preserving number literals as JSONNum so renderers can reproduce
 * jq's exact number formatting. Strings, booleans, and null are primitives;
 * objects/arrays are plain JS containers.
 */
export function parseJsonPreservingNumbers(text) {
  let i = 0;
  const n = text.length;
  function skipWs() {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else break;
    }
  }
  function parseValue() {
    skipWs();
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    throw new SyntaxError(`Unexpected token at ${i}: ${JSON.stringify(text.slice(i, i + 20))}`);
  }
  function parseObject() {
    const obj = {};
    i++; // {
    skipWs();
    if (text[i] === '}') { i++; return obj; }
    while (true) {
      skipWs();
      const key = parseString();
      skipWs();
      if (text[i] !== ':') throw new SyntaxError(`Expected ':' at ${i}`);
      i++;
      obj[key] = parseValue();
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; break; }
      throw new SyntaxError(`Expected ',' or '}' at ${i}`);
    }
    return obj;
  }
  function parseArray() {
    const arr = [];
    i++; // [
    skipWs();
    if (text[i] === ']') { i++; return arr; }
    while (true) {
      arr.push(parseValue());
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; break; }
      throw new SyntaxError(`Expected ',' or ']' at ${i}`);
    }
    return arr;
  }
  function parseString() {
    if (text[i] !== '"') throw new SyntaxError(`Expected string at ${i}`);
    i++;
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === '"') { i++; return out; }
      if (c === '\\') {
        const e = text[i + 1];
        i += 2;
        if (e === '"') out += '"';
        else if (e === '\\') out += '\\';
        else if (e === '/') out += '/';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === 'n') out += '\n';
        else if (e === 'r') out += '\r';
        else if (e === 't') out += '\t';
        else if (e === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
          i += 4;
        } else throw new SyntaxError(`Bad escape \\${e}`);
      } else {
        out += c;
        i++;
      }
    }
    throw new SyntaxError('Unterminated string');
  }
  function parseNumber() {
    const start = i;
    if (text[i] === '-') i++;
    while (i < n && text[i] >= '0' && text[i] <= '9') i++;
    let isFloat = false;
    if (text[i] === '.') { isFloat = true; i++; while (i < n && text[i] >= '0' && text[i] <= '9') i++; }
    if (text[i] === 'e' || text[i] === 'E') {
      isFloat = true; i++;
      if (text[i] === '+' || text[i] === '-') i++;
      while (i < n && text[i] >= '0' && text[i] <= '9') i++;
    }
    const literal = text.slice(start, i);
    const value = Number(literal);
    return new JSONNum(literal, value);
  }
  const result = parseValue();
  skipWs();
  if (i !== n) throw new SyntaxError('Trailing characters in JSON');
  return result;
}

/** Read a JSON file preserving number literals (see parseJsonPreservingNumbers). */
export function readJsonPreserving(path) {
  return parseJsonPreservingNumbers(readFileSync(path, 'utf-8'));
}

/**
 * Serialize a value to JSON preserving JSONNum literals (so "20.0" stays
 * "20.0" rather than collapsing to "20"). Plain numbers use Number.toString,
 * matching jq's canonical rendering for computed values (drops trailing .0).
 * This mirrors jq's behavior: pass-through literals are preserved, computed
 * numbers use canonical form.
 */
export function stringifyJsonPreserving(value, indent = 2) {
  const space = ' '.repeat(indent);
  function rep(v, depth) {
    if (v === null) return 'null';
    if (v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v instanceof JSONNum) return v.toString();
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return 'null';
      return v.toString();
    }
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      const inner = v.map((x) => space.repeat(depth + 1) + rep(x, depth + 1));
      return '[\n' + inner.join(',\n') + '\n' + space.repeat(depth) + ']';
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 0) return '{}';
      const inner = keys.map((k) => space.repeat(depth + 1) + JSON.stringify(k) + ': ' + rep(v[k], depth + 1));
      return '{\n' + inner.join(',\n') + '\n' + space.repeat(depth) + '}';
    }
    return JSON.stringify(v);
  }
  return rep(value, 0);
}

/** Read and parse a JSON file, returning null if it does not exist. */
export function readJsonOptional(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Write JSON with a trailing newline, creating parent dirs. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

/** Median of an array of numbers; 0 for empty input. */
export function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Safe rate: num/den, or 0 when den is 0. */
export function rate(num, den) {
  return den === 0 ? 0 : num / den;
}

/** Percentage string matching jq's `pct`: round(value*1000)/10 + "%". */
export function pct(value) {
  const v = Math.round((value || 0) * 1000) / 10;
  return Number(v).toString() + '%';
}

/** Sanitize a cell value: backslashes -> "\\", newlines -> " / ", pipes -> "\|", null -> "".
 *  Backslashes are escaped first so a trailing "\" cannot escape the injected "\|". */
export function sanitize(value) {
  const s = (value == null ? '' : String(value));
  return s.replace(/\\/g, '\\\\').replace(/\r?\n/g, ' / ').replace(/\|/g, '\\|');
}

/** Truncate a sanitized cell to `limit`, appending "..." when truncated. */
export function truncateCell(value, limit) {
  const clean = sanitize(value);
  if (clean.length > limit) return clean.slice(0, limit - 3) + '...';
  return clean;
}

/** Render an array as a joined, truncated cell, or "—" for empty/non-arrays. */
export function listOrDash(items, limit) {
  if (Array.isArray(items) && items.length > 0) return truncateCell(items.join(', '), limit);
  return '—';
}

/** Normalize a value into a list of trimmed non-empty strings. */
export function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const cleaned = item.trim();
      if (cleaned) out.push(cleaned);
    }
  }
  return out;
}

/** Standard GitHub API request headers. */
export function githubHeaders(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agnthive-benchmark-slot-gate',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Parse a Retry-After header (integer seconds or HTTP-date). null on failure. */
export function parseRetryAfter(value) {
  if (!value) return null;
  const candidate = String(value).trim();
  if (!candidate) return null;
  const asInt = Number.parseInt(candidate, 10);
  if (Number.isInteger(asInt) && /^-?\d+$/.test(candidate)) return Math.max(0, asInt);
  const when = new Date(candidate);
  if (Number.isNaN(when.getTime())) return null;
  const delta = (when.getTime() - Date.now()) / 1000;
  return Math.max(0, Math.floor(delta));
}

/** Read a YAML-ish frontmatter field from a markdown file. null if absent.
 *  Uses line-by-line scanning instead of new RegExp(userInput) to avoid
 *  regex-injection / incomplete-escaping concerns. */
export function frontmatterField(path, field) {
  const text = readFileSync(path, 'utf-8');
  if (!text.startsWith('---\n')) return null;
  const lines = text.slice(4).split('\n');
  for (const line of lines) {
    if (line === '---') break;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key === field) return line.slice(colonIdx + 1).trim();
  }
  return null;
}

/** Spawn a process with an explicit argv (never a shell string). */
export function runSync(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { encoding: 'utf-8', ...opts });
}

// ---------- ADR-0009/0010 structured plugin-state evidence helpers ----------
// Bench runners must evaluate evidence from the plugin's structured session
// state (event store) rather than reconstructing success from transcript prose
// (ADR 0009) or debug-log phrases (ADR 0012: "Debug phrases, aliases, and
// result prose remain claims, never authoritative dispatch evidence"). These
// helpers are PURE — the importing runner supplies canonicalize callbacks and
// reads the state store itself, so this shared module stays dependency-free.

/**
 * rolesFromPluginState: observed specialist roles carried by plugin state.
 * Sources inside the state record:
 *   - state.agents (ADR-0010 agent registry, keyed by stable agent id, roles
 *     already canonicalized by the runtime's alias map) — entries with a null
 *     role (foreign/fork/unrecognized) are skipped by canonicalize returning
 *     null;
 *   - state.subagents_started (the canonical roles recorded on SubagentStart
 *     hooks; also real hook data, used when the runtime version predates the
 *     registry).
 * Canonicalization happens through the caller's callback so this module stays
 * pure and the alias contract stays single-sourced. Output is deduped and
 * sorted so the list is deterministic regardless of registry insert order.
 * Returns [] for missing/malformed state (callers treat empty as
 * "no structured role evidence", falling back to the legacy path).
 */
export function rolesFromPluginState(state, canonicalize) {
  if (!state || typeof state !== 'object') return [];
  const roles = new Set();
  const add = (raw) => {
    const alias = canonicalize ? canonicalize(raw) : raw;
    if (typeof alias === 'string' && alias !== '') roles.add(alias);
  };
  const registry = (state.agents && typeof state.agents === 'object' && !Array.isArray(state.agents))
    ? state.agents : {};
  // Sorted key iteration keeps the traversal deterministic; the same role from
  // different agent ids dedupes below.
  for (const agentId of Object.keys(registry).sort()) {
    const record = registry[agentId];
    if (record && typeof record === 'object') add(record.role);
  }
  const started = Array.isArray(state.subagents_started) ? state.subagents_started : [];
  for (const role of started) add(role);
  return [...roles].sort();
}

/**
 * verificationEvidenceFromStateRecords: evaluate ADR-0009 verification[] records
 * against the CURRENT change revision. A record counts as verification evidence
 * only when it is a completed check whose started and completed revision both
 * equal the current revision (a result started before a parallel edit cannot
 * certify the later state) and — when the record carries a cwd — that cwd is
 * the evaluated working directory (results from another worktree do not
 * certify this diff). A record with no recorded cwd (older writer) is accepted
 * on revision scope alone and reported in `unrecorded_cwd_record_ids`.
 * Returns a bounded object (record ids, counts) — never record payloads.
 */
export function verificationEvidenceFromStateRecords(records, { currentRevision = 0, workdir = '' } = {}) {
  const list = Array.isArray(records) ? records : [];
  const target = typeof workdir === 'string' ? workdir : '';
  const cwdChecked = target !== '';
  const sameFile = (a, b) => resolve(String(a)) === resolve(String(b));
  const diagnostics = [];
  const passedRecordIds = [];
  let parsedCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let staleCount = 0;
  let foreignCwdCount = 0;
  let unrecordedCwdCount = 0;
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    parsedCount++;
    const id = (typeof rec.id === 'string' && rec.id !== '') ? rec.id : `index-${parsedCount - 1}`;
    if (rec.status === 'pending') {
      pendingCount++;
      diagnostics.push(`record ${id}: pending`);
      continue;
    }
    if (rec.status === 'failed') {
      failedCount++;
      diagnostics.push(`record ${id}: failed`);
      continue;
    }
    if (rec.status !== 'passed') {
      diagnostics.push(`record ${id}: unknown status ${JSON.stringify(String(rec.status).slice(0, 32))}`);
      continue;
    }
    // ADR-0009: a completed check certifies only the revision it observed end
    // to end — started and completed must both equal the current revision.
    const started = Number(rec.startedRevision);
    const completed = Number(rec.completedRevision);
    const cur = Number(currentRevision);
    const revisionScoped = Number.isFinite(started) && Number.isFinite(completed)
      && Number.isFinite(cur) && started === cur && completed === cur;
    if (!revisionScoped) {
      staleCount++;
      diagnostics.push(`record ${id}: not current-revision (started=${describeRevision(rec.startedRevision)}, completed=${describeRevision(rec.completedRevision)}, current=${describeRevision(currentRevision)})`);
      continue;
    }
    const cwd = typeof rec.cwd === 'string' ? rec.cwd : '';
    if (cwdChecked && cwd !== '') {
      if (!sameFile(cwd, target)) {
        // The result ran in a different working tree — it does not certify
        // this diff even though its revision matches.
        foreignCwdCount++;
        diagnostics.push(`record ${id}: foreign cwd (${truncateCell(cwd, 80)})`);
        continue;
      }
    } else if (cwd === '') {
      // Older runtime writer predating cwd capture: accept on revision scope
      // alone, but surface the gap instead of silently crediting it.
      unrecordedCwdCount++;
      diagnostics.push(`record ${id}: passed with no recorded cwd (legacy writer)`);
    }
    passedRecordIds.push(id);
  }
  if (!cwdChecked) diagnostics.push('cwd not checked: no workdir supplied');
  return {
    has_records: parsedCount > 0,
    record_count: parsedCount,
    passed_record_ids: passedRecordIds.slice(0, 50),
    passed_record_count: passedRecordIds.length,
    pending_count: pendingCount,
    failed_count: failedCount,
    stale_count: staleCount,
    foreign_cwd_count: foreignCwdCount,
    unrecorded_cwd_count: unrecordedCwdCount,
    current: passedRecordIds.length > 0,
    cwd_checked: cwdChecked,
    source: 'plugin_state',
    diagnostics: diagnostics.slice(0, 40),
  };
}

/**
 * reviewEvidenceFromStateRecords: evaluate ADR-0009 review_results[] records
 * against the current revision. A review record counts only when the reviewing
 * role is one of `reviewerRoles` (canonical aliases, e.g. ['cr']) and the
 * record's revision equals the current revision — a review of an earlier diff
 * does not certify the final state. Returns a bounded object.
 */
export function reviewEvidenceFromStateRecords(records, { currentRevision = 0, reviewerRoles = ['cr'] } = {}) {
  const list = Array.isArray(records) ? records : [];
  const roles = Array.isArray(reviewerRoles) ? reviewerRoles.filter((r) => typeof r === 'string' && r !== '') : [];
  const diagnostics = [];
  const completedRecordIds = [];
  let parsedCount = 0;
  let wrongRoleCount = 0;
  let staleCount = 0;
  let unknownStatusCount = 0;
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    parsedCount++;
    const id = (typeof rec.id === 'string' && rec.id !== '') ? rec.id : `index-${parsedCount - 1}`;
    const role = (typeof rec.role === 'string' && rec.role !== '') ? rec.role : null;
    if (role === null || !roles.includes(role)) {
      wrongRoleCount++;
      diagnostics.push(`record ${id}: role ${role ? `@${truncateCell(role, 24)}` : '(none)'} not a reviewer role`);
      continue;
    }
    const revision = Number(rec.revision);
    const cur = Number(currentRevision);
    if (!Number.isFinite(revision) || !Number.isFinite(cur) || revision !== cur) {
      staleCount++;
      diagnostics.push(`record ${id}: reviewed revision ${describeRevision(rec.revision)} != current ${describeRevision(currentRevision)}`);
      continue;
    }
    if (rec.status !== 'completed' && rec.status !== 'passed') {
      unknownStatusCount++;
      diagnostics.push(`record ${id}: status ${JSON.stringify(String(rec.status).slice(0, 32))}`);
      continue;
    }
    completedRecordIds.push(id);
  }
  return {
    has_records: parsedCount > 0,
    record_count: parsedCount,
    completed_record_ids: completedRecordIds.slice(0, 50),
    completed_record_count: completedRecordIds.length,
    wrong_role_count: wrongRoleCount,
    stale_count: staleCount,
    unknown_status_count: unknownStatusCount,
    current: completedRecordIds.length > 0,
    reviewer_roles: roles,
    source: 'plugin_state',
    diagnostics: diagnostics.slice(0, 40),
  };
}

/** Short description for a revision value in diagnostics. */
function describeRevision(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : JSON.stringify(value == null ? null : String(value).slice(0, 24));
}

// ---------- benchmark gate-line split ----------

/**
 * registryRunningRoles (ADR-0010): roles with at least one agent-registry
 * entry whose status is 'running' — a reviewer recorded as still running is a
 * diagnostic signal for the review evidence gate. Pure; sorted output.
 */
export function registryRunningRoles(state) {
  const registry = (state && state.agents && typeof state.agents === 'object' && !Array.isArray(state.agents))
    ? state.agents : {};
  const running = new Set();
  for (const record of Object.values(registry)) {
    if (record && record.status === 'running' && typeof record.role === 'string' && record.role !== '') {
      running.add(record.role);
    }
  }
  return [...running].sort();
}
// ---------- benchmark gate-line split ----------

// Stage 6 of the subagent-dispatch stabilization plan splits the CI result
// into three explicitly named lines:
//   - functional         : fix + verification + review/docs/structure correct
//                           (merge-blocking)
//   - dispatch-observed  : the model itself called the Agent tool
//                           (visible, non-blocking capability signal)
//   - dispatch-enforced  : the model called the Agent tool after a hard guard
//                           (separate line; Stage 5, not yet wired)
//
// A task's `failures` list mixes functional failures with dispatch failures.
// `required_used_agents_missing` / `required_used_agent_groups_missing` are the
// dispatch failure codes. Whether they belong to a dispatch line (excluded from
// functional) or to the functional line (kept) depends on the task's
// `dispatch_mode`:
//   - observed : dispatch is hook-only strict; a dispatch failure is the
//                honest "model did not call the Agent tool" capability signal
//                -> excluded from functional, counted on dispatch-observed.
//   - enforced : dispatch is forced by the harness; a dispatch failure belongs
//                on the separate dispatch-enforced line -> excluded from
//                functional.
//   - standard : dispatch is union-credited (a prose claim satisfies it), so a
//                dispatch failure means the model did not even claim the role
//                -> a real functional gap, kept in functional.

export const DISPATCH_LINE_FAILURES = new Set([
  'required_used_agents_missing',
  'required_used_agent_groups_missing',
]);

/** Failures that count toward the functional line for a task. */
export function taskFunctionalFailures(task) {
  const failures = Array.isArray(task && task.failures) ? task.failures : [];
  const mode = task && task.dispatch_mode;
  if (mode === 'observed' || mode === 'enforced') {
    return failures.filter((f) => !DISPATCH_LINE_FAILURES.has(f));
  }
  return failures.slice();
}

/** Failures that count toward the named dispatch line (`observed`|`enforced`).
 *  Empty for tasks not in that mode. */
export function taskDispatchLineFailures(task, mode) {
  if (!task || task.dispatch_mode !== mode) return [];
  const failures = Array.isArray(task.failures) ? task.failures : [];
  return failures.filter((f) => DISPATCH_LINE_FAILURES.has(f));
}

/** Report for a named dispatch line.
 *  status: 'passed' | 'failed' | `no-${mode}-tasks` (when no task uses it). */
export function dispatchLineReport(summary, mode) {
  const tasks = (Array.isArray(summary && summary.tasks) ? summary.tasks : [])
    .filter((t) => t && t.dispatch_mode === mode);
  if (tasks.length === 0) {
    return { mode, status: `no-${mode}-tasks`, total: 0, passed: 0, failed: 0, failedTaskIds: [] };
  }
  const failedTasks = tasks.filter((t) => taskDispatchLineFailures(t, mode).length > 0);
  return {
    mode,
    status: failedTasks.length === 0 ? 'passed' : 'failed',
    total: tasks.length,
    passed: tasks.length - failedTasks.length,
    failed: failedTasks.length,
    failedTaskIds: failedTasks.map((t) => t.task_id).filter(Boolean),
  };
}
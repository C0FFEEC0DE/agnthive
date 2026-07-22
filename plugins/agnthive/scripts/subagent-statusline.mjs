#!/usr/bin/env node
// subagent-statusline.mjs — agnthive subagent panel renderer.
// Node standard library only: no subprocess spawning, no shell, no fs reads.
//
// Claude Code pipes one JSON object to stdin on every subagent-panel refresh:
//   { ...baseHookFields, "columns": <rowWidth>, "tasks": [
//       { "id","name","type","status","description","label","startTime",
//         "model","effort","contextWindowSize","tokenCount","tokenSamples","cwd" } ] }
// For each task we want to override, we write one JSON line to stdout:
//   {"id":"<task id>","content":"<row body>"}
// Omitting a task's id keeps Claude Code's default row rendering for it.
// Missing fields degrade gracefully; a task with no id is skipped.
//
// Plugins may ship a default subagentStatusLine in their settings.json; this
// script is wired there. See the plugin README.

/**
 * Humanize a token count: 1234 -> "1.2k", 1500000 -> "1.5M".
 * @param {number} n
 * @returns {string}
 */
function humanizeTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Map an agnthive agent type/name to its short alias for compact display.
 * Returns the alias without the leading @, or '' if no match.
 * @param {string} s
 * @returns {string}
 */
function aliasFor(s) {
  const v = String(s || '').toLowerCase();
  if (!v) return '';
  const map = {
    'code reviewer': 'cr', 'code-reviewer': 'cr', 'reviewer': 'cr',
    'explorer': 'e', 'explore': 'e',
    'architect': 'a', 'the architect': 'a',
    'bugbuster': 'bug', 'bug buster': 'bug',
    'debugger': 'dbg', 'debug': 'dbg',
    'tester': 't',
    'docwriter': 'doc', 'doc writer': 'doc',
    'manager': 'm',
  };
  if (map[v]) return map[v];
  // plugin-scoped form like "agnthive:code-reviewer"
  const scoped = v.split(':').pop().trim();
  return map[scoped] || '';
}

/**
 * Build the row body for one task. Pure: no I/O.
 * @param {object} task
 * @returns {string}
 */
export function formatSubagentRow(task) {
  const t = task && typeof task === 'object' ? task : {};
  const alias = aliasFor(t.type) || aliasFor(t.name);
  const label = String(t.label || t.name || t.type || 'agent');
  const who = alias ? `@${alias} ${label}` : label;

  const segs = [who];
  const status = String(t.status || '').trim();
  if (status) segs.push(status);
  const effort = String(t.effort || '').trim();
  if (effort) segs.push(effort);

  const tokens = humanizeTokens(t.tokenCount);
  const ctx = typeof t.contextWindowSize === 'number' && t.contextWindowSize > 0
    ? Math.min(100, Math.round((Number(t.tokenCount) || 0) / t.contextWindowSize * 100))
    : null;
  if (tokens && ctx !== null) segs.push(`${tokens} · ${ctx}%`);
  else if (tokens) segs.push(tokens);

  return segs.join(' · ');
}

/**
 * Render subagent status rows from a parsed stdin payload.
 * Pure: no I/O. Returns an array of {id, content} objects (only for tasks
 * with an id and a non-empty body).
 * @param {object|null|undefined} payload
 * @returns {{id:string, content:string}[]}
 */
export function renderSubagentRows(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const tasks = Array.isArray(p.tasks) ? p.tasks : (Array.isArray(p) ? p : []);
  const out = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const id = String(task.id || '').trim();
    if (!id) continue; // no id -> keep default rendering
    const content = formatSubagentRow(task);
    if (content) out.push({ id, content });
  }
  return out;
}

// --- CLI entry: read all of stdin, parse one JSON object, print one JSON line per row ---
if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let payload = null;
    if (raw.trim().length > 0) {
      try { payload = JSON.parse(raw); } catch { payload = null; }
    }
    const rows = renderSubagentRows(payload);
    for (const row of rows) {
      process.stdout.write(JSON.stringify(row) + '\n');
    }
  });
  process.stdin.on('error', () => { /* degrade: emit nothing, keep defaults */ });
}
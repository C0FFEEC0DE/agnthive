#!/usr/bin/env node
// statusline.mjs — token-aware Claude Code status line, Node port of
// claudecfg/statusline.sh. Node standard library only: no subprocess spawning,
// no shell, no fs reads of user files.
//
// Claude Code pipes one JSON session object to stdin on every status refresh:
//   { "model": { "display_name": "..." },
//     "workspace": { "current_dir": "..." },
//     "session_id": "...", "version": "...",
//     "output_style": { "name": "..." } }
// We print one line: `<cwd basename> | <model display name> | <output style>`.
// Empty fields are dropped, and the "Default" output style is omitted so the
// status line stays short and never competes with the prompt for attention.
// If nothing parsed, we fall back to `claude`. Output has no trailing newline.
//
// Usage (opt in via the plugin's statusLine setting; see the plugin README):
//   claude pipes the JSON payload to stdin; this script writes the line to stdout.

import { basename } from 'node:path';

/**
 * Format the status-line string from a parsed Claude Code payload object.
 * Pure: no I/O, no env reads. Missing fields degrade gracefully.
 *
 * @param {object|null|undefined} payload - the parsed stdin JSON object.
 * @param {object} [options]
 * @param {string} [options.fallbackCwd] - cwd to use when the payload omits it
 *   (the CLI passes process.cwd(); tests leave it empty).
 * @returns {string} the status-line text, with no trailing newline.
 */
export function formatStatusLine(payload, options = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const model = str(p?.model?.display_name) || str(p?.model?.id);
  const cwd = str(p?.workspace?.current_dir) || str(p?.cwd) || str(options.fallbackCwd);
  const style = str(p?.output_style?.name);

  const parts = [];
  const dirName = cwd ? basename(cwd) : '';
  if (dirName) parts.push(dirName);
  if (model) parts.push(model);
  if (style && style !== 'Default') parts.push(style);

  return parts.length > 0 ? parts.join(' | ') : 'claude';
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

// --- CLI entry: read all of stdin, parse one JSON object, print one line ----
if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let payload = null;
    if (raw.trim().length > 0) {
      try { payload = JSON.parse(raw); } catch { payload = null; }
    }
    process.stdout.write(formatStatusLine(payload, { fallbackCwd: process.cwd() }));
  });
  process.stdin.on('error', () => {
    process.stdout.write(formatStatusLine(null, { fallbackCwd: process.cwd() }));
  });
}
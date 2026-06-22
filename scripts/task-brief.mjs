#!/usr/bin/env node
// task-brief — extract task N's full text from a plan file to a brief file
// and print the path. Subagents read the brief path instead of receiving the
// whole plan pasted into their dispatch prompt, which keeps the controller's
// context clean and gives the implementer a single source of requirements.
//
// Usage: task-brief PLAN_FILE N
//
// Plan format: each task starts with a "## Task N: <title>" markdown header.
// The brief runs from that header up to (not including) the next "## " or
// "# " header, so "### " subsections inside a task are preserved. Fenced code
// blocks (``` ... ```) are tracked so header-like lines inside them do not
// falsely end the task.
//
// Output dir: $CLAUDE_CREW_BRIEF_DIR, else .claude-crew/briefs/ under the git
// toplevel (or cwd). That path is gitignored (see .gitignore).
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(msg, code) {
  process.stderr.write(`task-brief: ${msg}\n`);
  process.exit(code);
}

/**
 * Extract task N's brief text from plan content. Mirrors the awk script in the
 * original task-brief.sh: fence-aware, stops at the next ## or # header outside
 * a fence. Exported for unit testing.
 */
export function extractTaskBrief(content, n) {
  const lines = content.split('\n');
  let found = false;
  let inFence = false;
  const out = [];
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (found) out.push(line);
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (found) out.push(line);
      continue;
    }
    // Match "## Task <number>:" — capture the number portion.
    const m = line.match(/^## +Task +([0-9]+)/);
    if (m) {
      if (m[1] === String(n)) { found = true; out.push(line); continue; }
      if (found) break;
      continue;
    }
    if (/^## /.test(line) || /^# /.test(line)) {
      if (found) break;
      continue;
    }
    if (found) out.push(line);
  }
  return out.join('\n');
}

function gitToplevel() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { stdio: 'pipe' });
  if (r.status === 0) return r.stdout.toString().trim();
  return '';
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write('Usage: task-brief PLAN_FILE N\n');
    process.exit(2);
  }
  const [planFile, nStr] = args;
  if (!/^[0-9]+$/.test(nStr)) fail(`N must be a positive integer, got '${nStr}'`, 2);
  if (!existsSync(planFile)) fail(`plan file not found: ${planFile}`, 2);

  let briefDir = process.env.CLAUDE_CREW_BRIEF_DIR || '';
  if (!briefDir) {
    const toplevel = gitToplevel();
    briefDir = toplevel ? join(toplevel, '.claude-crew', 'briefs') : join(process.cwd(), '.claude-crew', 'briefs');
  }
  mkdirSync(briefDir, { recursive: true });
  const briefFile = join(briefDir, `task-${nStr}-brief.md`);

  const content = readFileSync(planFile, 'utf-8');
  const body = extractTaskBrief(content, nStr);
  if (!body || body.trim() === '') {
    fail(`task ${nStr} not found in ${planFile} (expected a '## Task ${nStr}:' header)`, 1);
  }
  writeFileSync(briefFile, body);
  // Mirror bash's `[ ! -s "$brief_file" ]` post-write check: a non-empty body
  // guarantees a non-empty file, but guard anyway in case of write failure.
  try {
    if (statSync(briefFile).size === 0) {
      rmSync(briefFile, { force: true });
      fail(`task ${nStr} not found in ${planFile} (expected a '## Task ${nStr}:' header)`, 1);
    }
  } catch {
    rmSync(briefFile, { force: true });
    fail(`task ${nStr} not found in ${planFile} (expected a '## Task ${nStr}:' header)`, 1);
  }
  process.stdout.write(`${briefFile}\n`);
}

// Cross-platform main-module detection. `file://${process.argv[1]}` does not
// match import.meta.url on Windows (drive letter + backslashes vs file:///C:/),
// so main() would never run there. Normalize argv[1] to a file:// URL first.
const isMain = (() => { try { return pathToFileURL(process.argv[1]).href === import.meta.url; } catch { return false; } })();
if (isMain) main();
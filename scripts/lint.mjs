#!/usr/bin/env node
// Lint: syntax-check every ESM source file with `node --check`.
// No Bash, no Python, no external dependencies — Node standard library only.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';

/** Recursively collect .mjs/.js files, skipping node_modules and .git. */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory may not exist yet
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && (ent.name.endsWith('.mjs') || ent.name.endsWith('.js'))) out.push(p);
  }
  return out;
}

const roots = ['scripts', 'plugins/agent-hive', 'test'];
const files = [];
for (const r of roots) walk(r, files);

let bad = 0;
for (const f of files) {
  const res = spawnSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  if (res.status !== 0) {
    bad++;
    process.stderr.write(`lint: syntax error in ${relative(process.cwd(), f)}\n`);
    process.stderr.write(res.stderr?.toString() ?? '');
  }
}

if (bad) {
  process.stderr.write(`lint: ${bad} file(s) failed\n`);
  process.exit(1);
}
console.log(`lint: ${files.length} file(s) OK`);
#!/usr/bin/env node
// Build: validate the plugin's Node runtime tree is intact and syntactically
// valid. The runtime ships as committed ES modules under modules/ — the
// marketplace copies the source dir to its cache with no install-time build,
// so the runtime must live in committed source. "build" is therefore
// validation, not transpilation. dist/ is reserved for Phase 5 release
// artifacts. No Bash, no Python — Node standard library only.
//   node scripts/build.mjs            -> validate runtime
//   node scripts/build.mjs --package  -> validate + report artifact readiness
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const pluginDir = 'plugins/agent-hive';
const modulesDir = join(pluginDir, 'modules');
const dispatcher = join(modulesDir, 'hook-dispatcher.mjs');
const hooksJson = join(pluginDir, 'hooks', 'hooks.json');

const problems = [];

if (!existsSync(dispatcher)) problems.push(`missing dispatcher: ${dispatcher}`);
if (!existsSync(hooksJson)) problems.push(`missing hooks.json: ${hooksJson}`);

let checked = 0;
if (existsSync(modulesDir)) {
  for (const f of readdirSync(modulesDir).sort()) {
    if (!f.endsWith('.mjs')) continue;
    const res = spawnSync(process.execPath, ['--check', join(modulesDir, f)], { stdio: 'pipe' });
    checked++;
    if (res.status !== 0) {
      problems.push(`syntax error in modules/${f}: ${(res.stderr?.toString() ?? '').trim()}`);
    }
  }
}

if (problems.length) {
  for (const p of problems) process.stderr.write(`build: FAIL ${p}\n`);
  process.exit(1);
}
console.log(`build: OK — dispatcher present, ${checked} module(s) syntax-checked`);
if (process.argv.includes('--package')) {
  console.log('package: runtime validated (release packaging lands in Phase 5)');
}
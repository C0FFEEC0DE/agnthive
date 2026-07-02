#!/usr/bin/env node
// check-no-legacy-runtime — gate that fails when executable legacy .py/.sh
// scripts would ship in or run as the plugin runtime.
//
// The plugin runtime (plugins/agent-hive/**) must be Node-only: any
// .py or .sh found there is a hard failure (no allowlist). scripts/** may keep
// only an explicit, documented allowlist of CI-only agent runners that are not
// part of the shipped plugin runtime.
//
// Exports checkNoLegacyRuntime(repoRoot) for unit testing; CLI main() uses it.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// Scripts allowed to remain as Python because they are CI-only agent runners,
// invoked by the benchmark workflow — not part of the shipped plugin runtime.
// `file` is the path relative to the repo root so a same-named file nested in a
// subdirectory (e.g. scripts/sub/foo.py) is NOT allowlisted. The bench runners
// were ported to Node ESM, so the allowlist is now empty: scripts/** must be
// Node-only. Keep the escape hatch here so a future CI-only runner that cannot
// be ported can be re-added with rationale rather than weakening the gate.
export const SCRIPTS_ALLOWLIST = [];

/** Recursively collect files under dir matching exts (.py and/or .sh). */
function walkLegacy(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkLegacy(p, out);
    } else if (ent.isFile() && (ent.name.endsWith('.py') || ent.name.endsWith('.sh'))) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Scan the repo for legacy runtime scripts that must not ship/run as the plugin
 * runtime. Returns { ok: boolean, offenses: string[], allowlisted: string[] }.
 * `ok` is true when there are no offenses.
 */
export function checkNoLegacyRuntime(repoRoot) {
  const offenses = [];
  const allowlisted = [];

  // 1. plugins/agent-hive/** — no .py/.sh allowed at all.
  const pluginDir = join(repoRoot, 'plugins', 'agent-hive');
  const pluginLegacy = walkLegacy(pluginDir);
  for (const p of pluginLegacy) {
    offenses.push(
      `${relative(repoRoot, p)}: .py/.sh in plugin runtime is forbidden (plugin runtime must be Node-only)`,
    );
  }

  // 2. scripts/** — .py/.sh allowed only when in the explicit allowlist.
  const scriptsDir = join(repoRoot, 'scripts');
  const scriptsLegacy = walkLegacy(scriptsDir);
  const allowedPaths = new Set(SCRIPTS_ALLOWLIST.map((a) => a.file));
  for (const p of scriptsLegacy) {
    const rel = relative(repoRoot, p).replace(/\\/g, '/');
    if (allowedPaths.has(rel)) {
      allowlisted.push(rel);
    } else {
      offenses.push(
        `${rel}: non-allowlisted .py/.sh under scripts/ — port to Node ESM or add to SCRIPTS_ALLOWLIST with rationale`,
      );
    }
  }

  return { ok: offenses.length === 0, offenses, allowlisted };
}

function main() {
  const repoRoot = process.cwd();
  const { ok, offenses, allowlisted } = checkNoLegacyRuntime(repoRoot);
  if (!ok) {
    process.stderr.write('check-no-legacy-runtime: legacy runtime scripts found:\n');
    for (const o of offenses) process.stderr.write(`  - ${o}\n`);
    process.stderr.write(
      `\n${offenses.length} offense(s). Port to Node ESM or add to the allowlist with rationale.\n`,
    );
    process.exit(1);
  }
  process.stdout.write('check-no-legacy-runtime: no legacy runtime scripts in plugin runtime.\n');
  if (allowlisted.length) {
    process.stdout.write('Allowlisted scripts/ entries (CI-only, not shipped plugin runtime):\n');
    for (const name of allowlisted) {
      const entry = SCRIPTS_ALLOWLIST.find((a) => a.file === name);
      process.stdout.write(`  - ${name}: ${entry?.reason ?? 'CI-only agent runner; not part of the shipped plugin runtime'}\n`);
    }
  }
}

// Cross-platform main-module detection (see scripts/bench/lib.mjs isMain).
const isMain = (() => { try { return pathToFileURL(process.argv[1]).href === import.meta.url; } catch { return false; } })();
if (isMain) main();
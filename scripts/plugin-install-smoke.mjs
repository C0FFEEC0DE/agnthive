#!/usr/bin/env node
// plugin-install-smoke.mjs — installation + package smoke validator for the
// agent-hive Claude Code plugin.
//
// The validator PACKAGES the plugin source into a clean temp "cache/artifact"
// layout (a verbatim recursive copy of plugins/agent-hive/ into a
// temp dir) and then validates the PACKAGED layout — not the source tree — so
// the check mirrors what a user actually installs from a published artifact.
//
// Validation checks (all run against the packaged plugin dir):
//   1. .claude-plugin/plugin.json parses and has required manifest fields
//      (name, version, displayName, description, author, license); userConfig,
//      if present, is well-formed (object whose entries each declare type,
//      title, description, and a default).
//   2. Every path declared in the manifest resolves inside the packaged dir:
//      the `hooks` manifest field, every `${CLAUDE_PLUGIN_ROOT}/...` target
//      referenced in hooks.json, and the conventional agents/, skills/, and
//      references/ directories (each must exist and be non-empty).
//   3. No .py/.sh in the packaged plugin runtime — reuses the same rule as
//      scripts/check-no-legacy-runtime.mjs (scan for .py/.sh under the packaged
//      plugin root -> fail; no allowlist for the plugin runtime).
//   4. Hook entries use exec form: command === "node" with a non-empty args
//      array; no shell string and no shell:true flag.
//   5. The statusline helper (scripts/statusline.mjs) parses (node --check).
//
// Exports packagePlugin(srcDir, destDir) and validatePackagedPlugin(pluginDir)
// for unit testing; CLI main() packages to a mkdtempSync temp dir, validates,
// prints PASS/FAIL, and exits 0/1.
//
// Node standard library only. The only subprocess is `node --check` on the
// packaged statusline.mjs, invoked via spawnSync with an explicit argv — no
// shell, no exec, no eval.
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  rmSync,
  mkdtempSync,
} from 'node:fs';
import { join, basename, relative, sep, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_PLUGIN_SRC = join(REPO_ROOT, 'plugins', 'agent-hive');

const REQUIRED_MANIFEST_FIELDS = [
  'name',
  'version',
  'displayName',
  'description',
  'author',
  'license',
];

/**
 * Recursively walk dir collecting files (skip node_modules/.git), optionally
 * filtering by extension. Mirrors the walker in validate.mjs.
 */
function walk(dir, ext, out = []) {
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
      walk(p, ext, out);
    } else if (ent.isFile() && (!ext || p.endsWith(ext))) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Package the plugin source into a clean "cache/artifact" layout: a verbatim
 * recursive copy of srcDir into destDir/<basename(srcDir)>/. Returns the
 * absolute path to the packaged plugin root. Throws if srcDir is missing or
 * destDir does not exist.
 */
export function packagePlugin(srcDir, destDir) {
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new Error(`packagePlugin: source plugin dir not found: ${srcDir}`);
  }
  if (!existsSync(destDir) || !statSync(destDir).isDirectory()) {
    throw new Error(`packagePlugin: destination dir not found: ${destDir}`);
  }
  const pluginRoot = join(destDir, basename(srcDir));
  // Fresh copy: remove any stale plugin root inside destDir first.
  if (existsSync(pluginRoot)) rmSync(pluginRoot, { recursive: true, force: true });
  cpSync(srcDir, pluginRoot, { recursive: true });
  return pluginRoot;
}

/**
 * Resolve a path declared in the manifest or hooks.json against the packaged
 * plugin dir. Supports ${CLAUDE_PLUGIN_ROOT} expansion and relative paths.
 * Returns the resolved absolute path (existence is checked by the caller).
 */
function resolvePluginPath(declared, pluginDir) {
  let p = declared;
  if (p.includes('${CLAUDE_PLUGIN_ROOT}')) {
    p = p.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginDir);
  }
  // Relative paths are resolved against the plugin root (manifest convention).
  // Use isAbsolute (not startsWith('/')) so Windows drive-absolute paths
  // (C:\...) are not mistakenly re-joined under pluginDir, which would produce
  // an invalid concatenated path like <pluginDir>\C:\...\modules\hook-dispatcher.mjs.
  if (!isAbsolute(p)) p = join(pluginDir, p);
  return p;
}

/**
 * Validate a packaged plugin dir. Returns { ok, errors, checks } where checks
 * is a list of human-readable check labels that passed and errors is a list of
 * failure messages. ok is true iff errors is empty.
 */
export function validatePackagedPlugin(pluginDir) {
  const errors = [];
  const checks = [];

  // ---- Check 1: manifest parses + required fields + userConfig well-formed.
  const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    checks.push('manifest .claude-plugin/plugin.json parses as JSON');
  } catch (e) {
    errors.push(`manifest .claude-plugin/plugin.json failed to parse: ${e.message}`);
    // Without a manifest, the remaining checks cannot proceed meaningfully.
    return { ok: false, errors, checks };
  }

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!(field in manifest) || manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
      errors.push(`manifest missing required field: ${field}`);
    }
  }
  if (errors.length === 0) checks.push(`manifest has required fields: ${REQUIRED_MANIFEST_FIELDS.join(', ')}`);

  if ('userConfig' in manifest && manifest.userConfig != null) {
    const uc = manifest.userConfig;
    if (typeof uc !== 'object' || Array.isArray(uc)) {
      errors.push('manifest userConfig must be an object mapping config keys to definitions');
    } else {
      let ucOk = true;
      for (const [key, def] of Object.entries(uc)) {
        if (typeof def !== 'object' || Array.isArray(def)) {
          errors.push(`manifest userConfig.${key} must be an object`);
          ucOk = false;
          continue;
        }
        for (const req of ['type', 'title', 'description', 'default']) {
          if (!(req in def)) {
            errors.push(`manifest userConfig.${key} missing required field: ${req}`);
            ucOk = false;
          }
        }
      }
      if (ucOk) checks.push(`manifest userConfig is well-formed (keys: ${Object.keys(uc).join(', ') || 'none'})`);
    }
  } else {
    checks.push('manifest userConfig absent (ok)');
  }

  // ---- Check 2: declared paths resolve inside the packaged dir.
  const hooksField = manifest.hooks;
  let hooksJson = null;
  if (typeof hooksField === 'string' && hooksField.length > 0) {
    const hooksPath = resolvePluginPath(hooksField, pluginDir);
    if (!existsSync(hooksPath)) {
      errors.push(`manifest hooks path does not resolve inside packaged dir: ${hooksField} -> ${hooksPath}`);
    } else {
      checks.push(`manifest hooks path resolves: ${hooksField}`);
      try {
        hooksJson = JSON.parse(readFileSync(hooksPath, 'utf-8'));
      } catch (e) {
        errors.push(`hooks.json failed to parse: ${e.message}`);
      }
    }
  } else {
    errors.push('manifest missing hooks field (string path to hooks.json)');
  }

  // Conventional agent/skill/reference directories must exist and be non-empty.
  for (const [dir, label] of [
    ['agents', 'agents'],
    ['skills', 'skills'],
    ['references', 'references'],
  ]) {
    const d = join(pluginDir, dir);
    if (!existsSync(d) || !statSync(d).isDirectory()) {
      errors.push(`conventional ${label}/ directory missing from packaged plugin`);
    } else {
      const files = walk(d);
      if (files.length === 0) {
        errors.push(`conventional ${label}/ directory is empty in packaged plugin`);
      } else {
        checks.push(`${label}/ directory present with ${files.length} file(s)`);
      }
    }
  }

  // Every ${CLAUDE_PLUGIN_ROOT}/... target referenced in hooks.json must resolve.
  if (hooksJson && typeof hooksJson === 'object' && hooksJson.hooks) {
    const referenced = new Set();
    for (const entries of Object.values(hooksJson.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || !Array.isArray(entry.hooks)) continue;
        for (const h of entry.hooks) {
          if (h && Array.isArray(h.args)) {
            for (const a of h.args) {
              if (typeof a === 'string' && a.includes('${CLAUDE_PLUGIN_ROOT}')) {
                referenced.add(a);
              }
            }
          }
        }
      }
    }
    let refOk = true;
    for (const ref of referenced) {
      const resolved = resolvePluginPath(ref, pluginDir);
      if (!existsSync(resolved)) {
        errors.push(`hooks.json referenced path does not resolve: ${ref} -> ${resolved}`);
        refOk = false;
      }
    }
    if (refOk && referenced.size > 0) {
      checks.push(`all ${referenced.size} hooks.json \${CLAUDE_PLUGIN_ROOT} targets resolve`);
    }
  }

  // ---- Check 3: no .py/.sh in the packaged plugin runtime (no allowlist).
  const legacy = walk(pluginDir, '.py').concat(walk(pluginDir, '.sh'));
  if (legacy.length > 0) {
    for (const f of legacy) {
      errors.push(`${relative(pluginDir, f)}: .py/.sh in packaged plugin runtime is forbidden (plugin runtime must be Node-only)`);
    }
  } else {
    checks.push('no .py/.sh in packaged plugin runtime (Node-only)');
  }

  // ---- Check 4: hook entries use exec form (command: "node" + args array).
  if (hooksJson && typeof hooksJson === 'object' && hooksJson.hooks) {
    let hookCount = 0;
    let execFormOk = true;
    for (const [event, entries] of Object.entries(hooksJson.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || !Array.isArray(entry.hooks)) continue;
        for (const h of entry.hooks) {
          hookCount++;
          if (!h || typeof h !== 'object') {
            errors.push(`hooks.json ${event}: hook entry is not an object`);
            execFormOk = false;
            continue;
          }
          if (h.type !== 'command') {
            errors.push(`hooks.json ${event}: hook type must be "command", got ${JSON.stringify(h.type)}`);
            execFormOk = false;
          }
          if (h.command !== 'node') {
            errors.push(`hooks.json ${event}: hook command must be "node" (exec form), got ${JSON.stringify(h.command)}`);
            execFormOk = false;
          }
          if (!Array.isArray(h.args) || h.args.length === 0) {
            errors.push(`hooks.json ${event}: hook must declare a non-empty args array (exec form)`);
            execFormOk = false;
          }
          if (h.shell === true) {
            errors.push(`hooks.json ${event}: hook must not set shell:true (exec form only)`);
            execFormOk = false;
          }
          // A shell-string command (spaces, shell metachars) is forbidden even
          // if command were not "node" — guard against regressions.
          if (typeof h.command === 'string' && /[;&|<>`$\n]/.test(h.command)) {
            errors.push(`hooks.json ${event}: hook command looks like a shell string (forbidden): ${h.command}`);
            execFormOk = false;
          }
        }
      }
    }
    if (execFormOk && hookCount > 0) {
      checks.push(`all ${hookCount} hook entries use exec form (command: "node" + args array)`);
    }
  }

  // ---- Check 5: statusline helper parses (node --check, explicit argv).
  const statuslinePath = join(pluginDir, 'scripts', 'statusline.mjs');
  if (!existsSync(statuslinePath)) {
    errors.push('statusline helper scripts/statusline.mjs missing from packaged plugin');
  } else {
    const r = spawnSync(process.execPath, ['--check', statuslinePath], { stdio: 'pipe' });
    if (r.status !== 0) {
      const detail = (r.stderr ? r.stderr.toString().trim() : '').split('\n').slice(0, 3).join(' | ');
      errors.push(`statusline.mjs failed to parse (node --check): ${detail || `exit ${r.status}`}`);
    } else {
      checks.push('statusline helper scripts/statusline.mjs parses (node --check)');
    }
  }

  return { ok: errors.length === 0, errors, checks };
}

function main() {
  // Optional positional arg: an already-packaged plugin directory to validate
  // (e.g. an unpacked release artifact) instead of packaging a fresh copy from
  // the source tree. Used by the release workflow's "test the exact artifact"
  // gate so it validates the shipped artifact, not a re-packaged source copy.
  const argDir = process.argv[2];
  let pluginDir;
  let tmpRoot = null;
  if (argDir) {
    if (!existsSync(argDir) || !statSync(argDir).isDirectory()) {
      process.stderr.write(`plugin-install-smoke: provided plugin dir is not a directory: ${argDir}\n`);
      process.exit(2);
    }
    pluginDir = argDir;
  } else {
    const srcDir = DEFAULT_PLUGIN_SRC;
    if (!existsSync(srcDir)) {
      process.stderr.write(`plugin-install-smoke: source plugin dir not found: ${srcDir}\n`);
      process.exit(2);
    }
    tmpRoot = mkdtempSync(join(tmpdir(), 'plugin-install-smoke-'));
    pluginDir = packagePlugin(srcDir, tmpRoot);
  }
  let exitCode = 0;
  try {
    const { ok, errors, checks } = validatePackagedPlugin(pluginDir);
    process.stdout.write(`Validating plugin -> ${pluginDir}\n`);
    for (const c of checks) process.stdout.write(`  OK: ${c}\n`);
    if (ok) {
      process.stdout.write(`plugin-install-smoke: PASS (${checks.length} checks)\n`);
    } else {
      process.stdout.write(`plugin-install-smoke: FAIL (${errors.length} error(s))\n`);
      for (const e of errors) process.stderr.write(`  - ${e}\n`);
      exitCode = 1;
    }
  } finally {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

// Cross-platform main-module detection. `file://${process.argv[1]}` would not
// match import.meta.url on Windows (drive paths + backslashes vs file:// URL),
// silently no-op'ing the validator. pathToFileURL normalizes argv[1] to a
// file:// URL comparable to import.meta.url on every OS.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
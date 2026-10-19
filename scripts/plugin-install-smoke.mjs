#!/usr/bin/env node
// plugin-install-smoke.mjs — installation + package smoke validator for the
// agnthive Claude Code plugin.
//
// The validator PACKAGES the plugin source into a clean temp "cache/artifact"
// layout (a verbatim recursive copy of plugins/agnthive/ into a
// temp dir) and then validates the PACKAGED layout — not the source tree — so
// the check mirrors what a user actually installs from a published artifact.
//
// Validation checks (all run against the packaged plugin dir):
//   1. .claude-plugin/plugin.json parses and has required manifest fields
//      (name, version, displayName, description, author, license); userConfig,
//      if present, is well-formed (object whose entries each declare type,
//      title, description, and a default). Strict tier-1 schema checks also
//      enforce that each userConfig `type` is one of the allowed kinds and that
//      `default` matches the declared type (e.g. a number key has a numeric
//      default).
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
//   6. The subagent statusline helper (scripts/subagent-statusline.mjs), if
//      shipped, parses (node --check, explicit argv).
//   7. The plugin settings.json (settings.json), if shipped, uses only keys a
//      plugin is allowed to declare (agent, subagentStatusLine) — it must not
//      carry main-session keys like statusLine, outputStyle, permissions, or env.
//   8. Manifest shape contract (docs/compatibility.md): `defaultEnabled` is
//      exactly false (plugin ships disabled by default); no invented
//      version-policy key (`requirements` was promised by the old migration
//      spec, is unsupported, and must stay absent — ADR 0012); userConfig
//      declares the contract keys enforcement_mode, log_max_bytes,
//      ledger_max_bytes (extra keys allowed, missing required keys fail).
//
// The OFFICIAL CLI tier is opt-in via `--cli` (or `--require-cli`): after the
// structural checks pass/fail, main() resolves the `claude` executable
// (AGNTHIVE_CLAUDE_BIN env override, else `claude` on PATH) and runs
// `claude plugin validate --strict` against the PACKAGED plugin root, agents/,
// and skills/. In CI (CI=true/GITHUB_ACTIONS=true, or explicit --require-cli)
// a missing/malformed CLI is a FAILURE (infrastructure message), never a
// silent skip; a LOCAL run without `--require-cli` degrades to a skip note.
// A real strict-validation failure always fails the run.
// scripts/validate.mjs (tier-1, all OS matrix shards) only uses the structural
// tier, so it stays CLI-free.
//
// Exports packagePlugin(srcDir, destDir), validatePackagedPlugin(pluginDir),
// probeClaudeVersion(argvPrefix), resolveClaudeCli(options),
// runOfficialStrictValidation(argvPrefix, target), runCliTier(prefix, root)
// for unit testing; CLI main() packages to a mkdtempSync temp dir, validates,
// prints PASS/FAIL, and exits 0/1 (2 for usage errors).
//
// Node standard library only. The only subprocesses are `node --check` on the
// packaged statusline.mjs and the opt-in `claude` CLI probes/validation,
// invoked via spawnSync with an explicit argv — no shell, no exec, no eval.
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
const DEFAULT_PLUGIN_SRC = join(REPO_ROOT, 'plugins', 'agnthive');

const REQUIRED_MANIFEST_FIELDS = [
  'name',
  'version',
  'displayName',
  'description',
  'author',
  'license',
];

// Manifest shape contract (docs/compatibility.md, plan task 01 / ADR 0012):
// these describe the plugin's shipped shape, asserted statically so OS shards
// that never install the CLI still fail on drift from what the pinned CLI
// validated.
// - defaultEnabled: the plugin ships disabled by default; the field must be
//   present and exactly false.
// - userConfig contract keys: the configuration surface documented in the
//   compatibility matrix; extra userConfig keys are allowed, missing required
//   keys fail.
// - FORBIDDEN_MANIFEST_KEYS: ADR 0012 — the minimum-version policy is
//   documented (docs/compatibility.md), never expressed as an invented
//   manifest field. The 2026-06 node-migration spec once promised a
//   `requirements` key; it never shipped. Remove this guard only in a
//   reviewed change once the official manifest schema actually supports a
//   version-policy field.
const EXPECTED_DEFAULT_ENABLED = false;
const REQUIRED_USERCONFIG_KEYS = ['enforcement_mode', 'log_max_bytes', 'ledger_max_bytes'];
const FORBIDDEN_MANIFEST_KEYS = ['requirements'];

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
        // Strict tier-1 schema: `type` must be a supported kind, and `default`
        // must match the declared type (string->string, number->finite number,
        // boolean->boolean). directory/file defaults are left unconstrained.
        const ALLOWED_UC_TYPES = new Set(['string', 'number', 'boolean', 'directory', 'file']);
        if (typeof def.type === 'string' && def.type.length > 0 && !ALLOWED_UC_TYPES.has(def.type)) {
          errors.push(
            `manifest userConfig.${key} has unsupported type: ${def.type} (allowed: ${[...ALLOWED_UC_TYPES].join(', ')})`,
          );
          ucOk = false;
        }
        if ('default' in def && typeof def.type === 'string') {
          const t = def.type;
          const dft = def.default;
          const mismatch =
            (t === 'number' && (typeof dft !== 'number' || !Number.isFinite(dft))) ||
            (t === 'string' && typeof dft !== 'string') ||
            (t === 'boolean' && typeof dft !== 'boolean');
          if (mismatch) {
            errors.push(
              `manifest userConfig.${key} default does not match its type ${t}: ${JSON.stringify(dft)}`,
            );
            ucOk = false;
          }
        }
      }
      if (ucOk) checks.push(`manifest userConfig is well-formed (keys: ${Object.keys(uc).join(', ') || 'none'})`);
    }
  } else {
    errors.push(
      'manifest userConfig missing (contract keys enforcement_mode, log_max_bytes, ledger_max_bytes are the documented plugin configuration)',
    );
  }

  // ---- Check 1b: manifest shape contract (docs/compatibility.md).
  if (manifest.defaultEnabled !== EXPECTED_DEFAULT_ENABLED) {
    errors.push(
      `manifest defaultEnabled must be present and exactly ${JSON.stringify(EXPECTED_DEFAULT_ENABLED)} (plugin ships disabled by default), got ${JSON.stringify(manifest.defaultEnabled)}`,
    );
  } else {
    checks.push('manifest defaultEnabled is false (plugin ships disabled by default)');
  }
  if (typeof manifest.userConfig === 'object' && manifest.userConfig !== null && !Array.isArray(manifest.userConfig)) {
    const missingUc = REQUIRED_USERCONFIG_KEYS.filter((k) => !(k in manifest.userConfig));
    if (missingUc.length > 0) {
      errors.push(
        `manifest userConfig missing contract key(s): ${missingUc.join(', ')} (contract: ${REQUIRED_USERCONFIG_KEYS.join(', ')})`,
      );
    } else {
      checks.push(`manifest userConfig declares contract keys: ${REQUIRED_USERCONFIG_KEYS.join(', ')}`);
    }
  }
  const inventedKeys = FORBIDDEN_MANIFEST_KEYS.filter((k) => k in manifest);
  if (inventedKeys.length > 0) {
    errors.push(
      `manifest declares invented version-policy key(s): ${inventedKeys.join(', ')} (minimum-version policy lives in docs/compatibility.md, not the manifest — ADR 0012)`,
    );
  } else {
    checks.push('manifest declares no invented version-policy key (no requirements key)');
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

  // ---- Check 6: subagent statusline helper parses (if shipped).
  const subStatuslinePath = join(pluginDir, 'scripts', 'subagent-statusline.mjs');
  if (existsSync(subStatuslinePath)) {
    const r2 = spawnSync(process.execPath, ['--check', subStatuslinePath], { stdio: 'pipe' });
    if (r2.status !== 0) {
      const detail = (r2.stderr ? r2.stderr.toString().trim() : '').split('\n').slice(0, 3).join(' | ');
      errors.push(`subagent-statusline.mjs failed to parse (node --check): ${detail || `exit ${r2.status}`}`);
    } else {
      checks.push('subagent statusline helper scripts/subagent-statusline.mjs parses (node --check)');
    }
  }

  // ---- Check 7: plugin settings.json uses only supported keys (if shipped).
  // A plugin settings.json supports `agent` and `subagentStatusLine` only; it
  // must NOT carry main-session keys (statusLine, outputStyle, permissions, env)
  // that a plugin cannot meaningfully set and that would mislead users.
  const settingsPath = join(pluginDir, 'settings.json');
  if (existsSync(settingsPath)) {
    const ALLOWED_SETTINGS_KEYS = new Set(['agent', 'subagentStatusLine']);
    let settings = null;
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch (e) {
      errors.push(`plugin settings.json failed to parse as JSON: ${e.message}`);
    }
    if (settings !== null) {
      if (typeof settings !== 'object' || Array.isArray(settings) || settings === null) {
        errors.push('plugin settings.json must be a JSON object');
      } else {
        const bad = Object.keys(settings).filter((k) => !ALLOWED_SETTINGS_KEYS.has(k));
        if (bad.length > 0) {
          errors.push(
            `plugin settings.json declares unsupported key(s): ${bad.join(', ')} (a plugin settings.json supports only: ${[...ALLOWED_SETTINGS_KEYS].join(', ')})`,
          );
        } else {
          checks.push(`plugin settings.json uses only supported keys: ${Object.keys(settings).join(', ') || 'none'}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, checks };
}

// ---------- Official CLI tier (plan task 01 / ADR 0012) ----------
// The structural checks above prove the packaged shape statically. Only the
// official CLI proves the manifest/agents/skills are ACCEPTED by the Claude
// Code runtime (`claude plugin validate --strict`). All CLI invocations take
// an argv prefix (default `['claude']`) so unit tests can substitute a fake
// binary cross-platform (node + script) without shell wrappers.
//
// Version evidence: `claude --version` prints `<semver> (Claude Code)`; the
// first leading semver is the version. Malformed output is an error, not a
// version.

const STRICT_VALIDATION_TARGETS = [
  { label: 'manifest (plugin root)', rel: '.' },
  { label: 'agents', rel: 'agents' },
  { label: 'skills', rel: 'skills' },
];

/**
 * Probe `<prefix> --version` and parse the leading semver. Returns
 * { ok, version, reason }. `ok` is false for any of: spawn error
 * (ENOENT/EPERM), signal termination, non-zero exit, or output without a
 * leading semver — every non-ok case is a distinct, printed reason.
 */
export function probeClaudeVersion(argvPrefix, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const r = spawnSync(argvPrefix[0], [...argvPrefix.slice(1), '--version'], {
    stdio: 'pipe',
    timeout: timeoutMs,
    encoding: 'utf-8',
  });
  if (r.error) {
    return { ok: false, version: null, reason: `spawn failed: ${r.error.code ?? r.error.message}` };
  }
  if (r.signal) {
    return { ok: false, version: null, reason: `terminated by signal ${r.signal} (possible timeout after ${timeoutMs}ms)` };
  }
  if (r.status !== 0) {
    return { ok: false, version: null, reason: `exit ${r.status} — not a claude CLI: ${truncateCliOutput(r.stderr ?? r.stdout ?? '')}` };
  }
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const m = /(\d+\.\d+\.\d+)/.exec(raw.split('\n')[0] ?? '');
  if (!m) {
    return { ok: false, version: null, reason: `unparsable --version output: ${truncateCliOutput(raw)}` };
  }
  return { ok: true, version: m[1], reason: null, exitCode: 0 };
}

/** Environment-aware CLI resolution: AGNTHIVE_CLAUDE_BIN overrides PATH lookup. */
export function resolveClaudeCli(opts = {}) {
  const bin = opts.bin ?? process.env.AGNTHIVE_CLAUDE_BIN ?? 'claude';
  const probe = probeClaudeVersion([bin], opts);
  return { bin, ...probe };
}

/**
 * Run `claude plugin validate --strict <target>`. Returns
 * { ok, exitCode, signal, error, stdout, stderr, target }.
 */
export function runOfficialStrictValidation(argvPrefix, target, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const argv = [...argvPrefix.slice(1), 'plugin', 'validate', '--strict', target];
  const r = spawnSync(argvPrefix[0], argv, { stdio: 'pipe', timeout: timeoutMs, encoding: 'utf-8' });
  const base = { target, exitCode: r.status, signal: r.signal, error: r.error ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  if (r.error) return { ...base, ok: false, reason: `spawn failed: ${r.error.code ?? r.error.message}` };
  if (r.signal) return { ...base, ok: false, reason: `terminated by signal ${r.signal} (possible timeout after ${timeoutMs}ms)` };
  if (r.status !== 0) {
    return { ...base, ok: false, reason: `strict validation failed (exit ${r.status}) — output:\n${truncateCliOutput(r.stdout ?? '', r.stderr ?? '')}` };
  }
  return { ...base, ok: true, reason: null };
}

/**
 * Run the three strict validation targets (manifest/agents/skills) against
 * pluginRoot. When opts.expectedVersion is set, the CLI version must match it
 * exactly (evidence for the required CI pin); any other version fails.
 * Returns { ok, version, versionReason, mismatch, results[] }.
 */
export function runCliTier(argvPrefix, pluginRoot, opts = {}) {
  const version = probeClaudeVersion(argvPrefix, opts);
  let versionOk = version.ok;
  let mismatch = null;
  if (version.ok && opts.expectedVersion && version.version !== opts.expectedVersion) {
    versionOk = false;
    mismatch = `claude CLI version mismatch: pinned/explicit expectation is ${opts.expectedVersion}, found ${version.version} (the pin must be re-captured in docs/compatibility.md)`;
  }
  const results = [];
  for (const { label, rel } of STRICT_VALIDATION_TARGETS) {
    const target = join(pluginRoot, rel);
    results.push({ label, ...runOfficialStrictValidation(argvPrefix, target, opts) });
  }
  // Version is reported as the plain semver string (null when unavailable);
  // `versionReason` carries the probe failure, if any. A version probe
  // failure already forces ok=false via versionOk above.
  return {
    ok: versionOk && !mismatch && results.every((x) => x.ok),
    version: version.ok ? version.version : null,
    versionReason: version.reason,
    mismatch,
    results,
  };
}

function truncateCliOutput(...chunks) {
  const text = chunks.filter(Boolean).join('\n').trim();
  return text.length > 300 ? `${text.slice(0, 300)}...[truncated]` : text;
}

function main() {
  // Flags: --cli (run the official-CLI strict tier against the packaged
  // plugin), --require-cli (make a missing/malformed CLI a hard failure even
  // outside CI), --cli-version <v> (require an exact CLI version — evidence
  // for the required CI pin). Positional arg (unchanged): an already-packaged
  // plugin directory to validate (e.g. an unpacked release artifact) instead
  // of packaging a fresh copy from the source tree. Used by the release
  // workflow's "test the exact artifact" gate so it validates the shipped
  // artifact, not a re-packaged source copy.
  const rawArgs = process.argv.slice(2);
  let wantCli = false;
  let requireCli = false;
  let expectVersion = null;
  let argDir = null;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--cli') wantCli = true;
    else if (a === '--require-cli') requireCli = true;
    else if (a === '--cli-version') {
      expectVersion = rawArgs[++i];
      if (expectVersion === undefined || expectVersion === '') {
        process.stdout.write(`plugin-install-smoke: --cli-version requires a value (e.g. --cli-version 2.1.303)\n`);
        process.exit(2);
      }
    } else if (a.startsWith('--')) {
      process.stdout.write(`plugin-install-smoke: unknown flag: ${a}\n`);
      process.exit(2);
    } else if (argDir === null) {
      argDir = a;
    } else {
      process.stdout.write('plugin-install-smoke: at most one positional plugin dir\n');
      process.exit(2);
    }
  }
  if (requireCli) wantCli = true; // --require-cli implies --cli
  // In CI the CLI tier must hard-fail on an unusable CLI — a skip must never
  // produce a green required check (plan task 01 acceptance).
  const inCi = process.env.CI === 'true' || process.env.CI === '1' || process.env.GITHUB_ACTIONS === 'true';
  const hardFailOnMissingCli = requireCli || inCi;

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
    // Collected after the structural tier so a structural failure is reported
    // before any CLI-tier noise; the CLI tier helps only once the shape holds.
    let cliOkLines = 0;
    const cliFatal = [];
    if (wantCli && ok) {
      const cli = resolveClaudeCli();
      const cliPrefix = [cli.bin];
      const probe = probeClaudeVersion(cliPrefix);
      if (!probe.ok) {
        if (hardFailOnMissingCli) {
          cliFatal.push(
            `claude CLI not usable (${probe.reason}) — infrastructure failure, not a skip: the required official validation must run (plan task 01; AGNTHIVE_CLAUDE_BIN overrides the executable)`,
          );
        } else {
          process.stdout.write(
            `  NOTE: CLI tier skipped — claude CLI not usable (${probe.reason}); structural smoke is the enforced gate\n`,
          );
        }
      } else {
        process.stdout.write(`  OK: official CLI present, version ${probe.version}${expectVersion ? '' : ' (no --cli-version pinned — reporting only)'}\n`);
        cliOkLines++;
        const tier = runCliTier(cliPrefix, pluginDir, { expectedVersion: expectVersion });
        if (tier.mismatch) cliFatal.push(tier.mismatch);
        for (const res of tier.results) {
          if (res.ok) {
            process.stdout.write(`  OK: official strict validation (${res.label}) — claude plugin validate --strict exit ${res.exitCode}\n`);
            cliOkLines++;
          } else {
            cliFatal.push(`official strict validation failed for ${res.label} (${res.target}): ${res.reason}`);
          }
        }
      }
    }
    const fatal = [...errors, ...cliFatal];
    process.stdout.write(`Validated ${checks.length + cliOkLines} checks\n`);
    if (fatal.length === 0) {
      process.stdout.write(`plugin-install-smoke: PASS (${checks.length + cliOkLines} checks)\n`);
    } else {
      process.stdout.write(`plugin-install-smoke: FAIL (${fatal.length} error(s))\n`);
      for (const e of fatal) process.stderr.write(`  - ${e}\n`);
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
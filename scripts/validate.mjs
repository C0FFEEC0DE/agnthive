#!/usr/bin/env node
// validate.mjs — Node ESM port of scripts/validate.sh.
// Checks: JSON validity, workflow syntax, agent/skill
// frontmatter (plugin two-shape skill model), slash-command inventory, the
// plugin hook-manifest + userConfig contract (exec form, single dispatcher,
// event vocabulary with StopFailure, timeout/onFailure policy, PowerShell
// parity), workflow policy invariants, GitHub Actions Node.js 24 readiness,
// notification docs, hook test manifests, benchmark task structure, internal
// markdown links, and the no-legacy-runtime gate.
//
// External linters (actionlint) are invoked via spawnSync with an
// explicit argv — no shell, no exec, no eval. The plugin runtime is Node-only and
// platform-independent, so shell-syntax/shellcheck checks (which targeted the
// removed legacy bash profile) are no longer relevant. The packaged-plugin
// install smoke (scripts/plugin-install-smoke.mjs) IS run here as a tier-1
// strict gate: it packages plugins/agnthive/ into a clean temp layout and
// validates the manifest schema, declared paths, exec-form hooks, statusline
// helpers, and plugin settings.json shape against what a user installs.
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, dirname, basename, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkNoLegacyRuntime } from './check-no-legacy-runtime.mjs';
import { SCRIPT_TO_EVENT } from './test-hooks.mjs';
import { packagePlugin, validatePackagedPlugin } from './plugin-install-smoke.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

let ERRORS = 0;
function reportError(msg) {
  console.error(`ERROR: ${msg}`);
  ERRORS++;
}

/** Recursively walk dir, collecting files (skip node_modules/.git). */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

function walkGlob(dir, ext, out = []) {
  for (const f of walk(dir)) if (extname(f) === ext) out.push(f);
  return out;
}

/** Glob a single directory (non-recursive), following symlinks to files.
 *  Mirrors the bash `DIR/*.md` glob used for agents/skills/commands. */
function globDir(dir, ext) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const p = join(dir, ent.name);
    // statSync follows symlinks; isFile true for symlink-to-file (matches bash glob).
    try { if (statSync(p).isFile() && extname(ent.name) === ext) out.push(p); } catch {}
  }
  return out;
}

// Availability check: spawn `command -v` via bash (explicit argv, no shell:true,
// command name passed as $1 so it is never interpolated into the script string).
function hasCmd(cmd) {
  const r = spawnSync('bash', ['-c', 'command -v "$1"', 'bash', cmd], { stdio: 'pipe' });
  return r.status === 0 && (r.stdout?.toString().trim().length > 0);
}

// ---------- frontmatter helpers ----------
function readLines(p) {
  return readFileSync(p, 'utf-8').split('\n');
}

function extractFrontmatterLines(lines, filename) {
  if (!lines.length || lines[0].trim() !== '---') {
    reportError(`Missing frontmatter start in ${filename}`);
    return null;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) {
    reportError(`Missing frontmatter end in ${filename}`);
    return null;
  }
  if (end + 1 < lines.length && lines[end + 1].trim() === '---') {
    reportError(`Duplicate frontmatter block in ${filename}`);
    return null;
  }
  return lines.slice(1, end);
}

function extractScalar(fm, field) {
  const prefix = `${field}:`;
  for (const line of fm) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return '';
}

function extractListItems(fm, field) {
  const items = [];
  let capture = false;
  for (const line of fm) {
    const stripped = line.trim();
    if (stripped.startsWith(`${field}:`)) {
      const inline = stripped.slice(field.length + 1).trim();
      if (inline) items.push(inline);
      capture = true;
      continue;
    }
    if (capture && stripped.startsWith('- ')) {
      items.push(stripped.slice(2).trim());
      continue;
    }
    if (capture && stripped && !stripped.startsWith('#')) break;
  }
  return items;
}

// ---------- JSON validity ----------
function checkJson() {
  console.log('--- Checking JSON files ---');
  const files = walkGlob(REPO_ROOT, '.json').sort();
  for (const f of files) {
    try {
      JSON.parse(readFileSync(f, 'utf-8'));
      console.log(`OK: ${f}`);
    } catch {
      reportError(`Invalid JSON: ${f}`);
    }
  }
  console.log('');
}

// ---------- workflow syntax ----------
function checkWorkflowSyntax() {
  console.log('--- Checking workflow syntax ---');
  if (hasCmd('actionlint')) {
    const wfs = walkGlob(join(REPO_ROOT, '.github', 'workflows'), '.yml').sort();
    const r = spawnSync('actionlint', wfs, { stdio: 'pipe' });
    if (r.status !== 0) reportError('actionlint reported workflow syntax issues');
    else console.log('OK: actionlint');
  } else {
    console.log('SKIP: actionlint not installed');
  }
  console.log('');
}

// ---------- agent frontmatter ----------
function checkAgentFrontmatter() {
  console.log('--- Checking agent frontmatter ---');
  const agentDir = join(REPO_ROOT, 'plugins', 'agnthive', 'agents');
  if (!existsSync(agentDir)) { reportError(`Agent directory not found: ${agentDir}`); console.log(''); return; }
  const files = globDir(agentDir, '.md').sort();
  for (const af of files) {
    const filename = basename(af);
    const lines = readLines(af);
    if (!lines.length || lines[0].trim() !== '---') {
      reportError(`Missing frontmatter start in ${filename}`);
      continue;
    }
    const fm = extractFrontmatterLines(lines, filename);
    if (fm === null) continue;
    let failed = false;
    for (const field of ['name', 'alias', 'description', 'type']) {
      if (!fm.some((l) => l.startsWith(`${field}:`))) {
        reportError(`Missing '${field}' in ${filename} frontmatter`);
        failed = true;
      }
    }
    if (!failed) console.log(`OK: ${filename}`);
  }
  console.log('');
}

// ---------- skill frontmatter (plugin two-shape model) ----------
// The plugin ships skills as nested dirs: skills/<name>/SKILL.md. There are two
// shapes, enforced here so they cannot silently drift:
//   - Agent-backed (forked-specialist) skills — exactly one ships: review, the
//     read-only Code Reviewer. Full dispatch contract: name, description,
//     agent, context: fork, disable-model-invocation: true, non-empty
//     allowed-tools, non-empty paths. The `agent` value must match a known
//     plugin agent name or alias.
//   - Root-procedure/command skills (bug, debug, design, docs, explore,
//     manager, refactor, test) are name + description (+ argument-hint) only.
//     They run in the root session; delegation stays body guidance. They must
//     NOT carry agent/context/allowed-tools/paths (that would
//     make them a third, ambiguous shape).
function checkSkillFrontmatter() {
  console.log('--- Checking skill frontmatter ---');
  const skillsDir = join(REPO_ROOT, 'plugins', 'agnthive', 'skills');
  const agentDir = join(REPO_ROOT, 'plugins', 'agnthive', 'agents');
  if (!existsSync(skillsDir)) { reportError(`Skill directory not found: ${skillsDir}`); console.log(''); return; }

  // Known plugin agent names + aliases (for agent-backed skill `agent:` matching).
  const knownAgents = new Set();
  for (const af of globDir(agentDir, '.md')) {
    const afm = extractFrontmatterLines(readLines(af), basename(af));
    if (afm) { knownAgents.add(extractScalar(afm, 'name')); knownAgents.add(extractScalar(afm, 'alias')); }
  }

  const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const skillName of skillDirs) {
    const sf = join(skillsDir, skillName, 'SKILL.md');
    const filename = relative(REPO_ROOT, sf).split(sep).join('/');
    if (!existsSync(sf)) { reportError(`Skill dir missing SKILL.md: ${filename}`); continue; }
    const lines = readLines(sf);
    const fm = extractFrontmatterLines(lines, filename);
    if (fm === null) continue;
    const fmText = fm.join('\n');
    let failed = false;
    for (const field of ['name', 'description']) {
      if (!fm.some((l) => l.startsWith(`${field}:`))) {
        reportError(`Missing '${field}' in ${filename} frontmatter`);
        failed = true;
      }
    }
    const skillSelfName = extractScalar(fm, 'name');
    if (skillSelfName && skillSelfName !== skillName) {
      reportError(`Skill name '${skillSelfName}' must match its directory name '${skillName}' in ${filename}`);
      failed = true;
    }
    const skillAgent = extractScalar(fm, 'agent');
    const hasAgent = fm.some((l) => l.startsWith('agent:'));
    if (hasAgent) {
      // Agent-backed skill: full dispatch contract.
      for (const field of ['agent', 'context', 'disable-model-invocation', 'allowed-tools', 'paths']) {
        if (!fm.some((l) => l.startsWith(`${field}:`))) {
          reportError(`Agent-backed skill missing '${field}' in ${filename} frontmatter`);
          failed = true;
        }
      }
      if (!/^disable-model-invocation:\s*true$/m.test(fmText)) {
        reportError(`Agent-backed skill must pin disable-model-invocation: true in ${filename}`);
        failed = true;
      }
      if (!/^context:\s*fork$/m.test(fmText)) {
        reportError(`Agent-backed skill must pin context: fork in ${filename}`);
        failed = true;
      }
      if (extractListItems(fm, 'allowed-tools').length === 0) {
        reportError(`Agent-backed skill must declare non-empty allowed-tools in ${filename}`);
        failed = true;
      }
      if (extractListItems(fm, 'paths').length === 0) {
        reportError(`Agent-backed skill must declare non-empty paths in ${filename}`);
        failed = true;
      }
      if (skillAgent && !knownAgents.has(skillAgent)) {
        reportError(`Skill frontmatter agent does not match a known plugin agent name or alias in ${filename}`);
        failed = true;
      }
    } else {
      // Command skill: must stay minimal — no dispatch-contract fields.
      for (const field of ['agent', 'context', 'disable-model-invocation', 'allowed-tools', 'paths']) {
        if (fm.some((l) => l.startsWith(`${field}:`))) {
          reportError(`Command skill must not declare '${field}' (only name+description) in ${filename}`);
          failed = true;
        }
      }
    }
    if (!failed) console.log(`OK: ${filename}`);
  }
  console.log('');
}


// ---------- slash command inventory ----------
// In the plugin model the slash commands ARE the bundled skills: each
// skills/<name>/SKILL.md is invocable as /<name> (there is no separate
// commands/ directory).
export const SLASH_COMMAND_NAMES = [
  'manager', 'explore', 'bug', 'debug', 'design', 'test', 'refactor', 'review', 'docs',
];
export const SLASH_COMMAND_ALIASES = ['m', 'e', 'bug', 'dbg', 'a', 't', 'a', 'cr', 'doc'];
// The agent-backed (forked-specialist) skill inventory after ADR 0008 / plan
// task 12: the canonical dispatch contract rides only /review; the other
// agent-shaped commands are root procedures and must NOT declare
// agent/context/allowed-tools/paths.
export const AGENT_BACKED_SKILLS = ['review'];

export function collectSlashCommandInventoryErrors() {
  const checks = [];
  const errors = [];
  errors.push(...slashInventoryDirScanErrors(checks));
  errors.push(...slashInventoryReadmeErrors(checks));
  return { checks, errors };
}

function checkSlashCommandInventory() {
  console.log('--- Checking slash command inventory ---');
  const { checks, errors } = collectSlashCommandInventoryErrors();
  for (const c of checks) console.log(`OK: ${c}`);
  for (const e of errors) reportError(e);
  console.log('');
}
function slashInventoryDirScanErrors(checks) {
  const errors = [];
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const aliasFor = (name) => {
    const i = SLASH_COMMAND_NAMES.indexOf(name);
    return i >= 0 ? SLASH_COMMAND_ALIASES[i] : '';
  };
  const skillsDir = join(REPO_ROOT, 'plugins', 'agnthive', 'skills');
  const agentDir = join(REPO_ROOT, 'plugins', 'agnthive', 'agents');
  const skillDirs = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  // The 9 skill dirs must equal the bundled command set.
  {
    const actual = skillDirs.slice().sort(cmp);
    const expected = SLASH_COMMAND_NAMES.slice().sort(cmp);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      errors.push('Plugin skills/ directory inventory does not match the bundled slash-command inventory');
    else checks.push('plugin skills/ command inventory');
  }
  // Agent-backed (forked specialist) inventory: dirs whose SKILL.md declares
  // `agent:` must be exactly the one dispatch-bearing skill.
  {
    const agentBacked = skillDirs.filter((n) => {
      const sf = join(skillsDir, n, 'SKILL.md');
      const fm = extractFrontmatterLines(readLines(sf), `skills/${n}/SKILL.md`);
      return fm ? fm.some((l) => l.startsWith('agent:')) : false;
    }).sort(cmp);
    const expected = AGENT_BACKED_SKILLS.slice().sort(cmp);
    if (JSON.stringify(agentBacked) !== JSON.stringify(expected))
      errors.push('Plugin agent-backed skill inventory does not match the bundled skill inventory');
    else checks.push('plugin agent-backed skill inventory');
  }
  // Each command's SKILL.md exists, name matches, and the agent carrying its
  // alias exists on some plugin agent file.
  for (const command of SLASH_COMMAND_NAMES) {
    const skillFile = join(skillsDir, command, 'SKILL.md');
    const expectedAlias = aliasFor(command);
    if (!existsSync(skillFile)) { errors.push(`Missing skill for slash command /${command}: ${skillFile}`); continue; }
    const sfm = extractFrontmatterLines(readLines(skillFile), `skills/${command}/SKILL.md`);
    const skillName = sfm ? extractScalar(sfm, 'name') : '';
    if (skillName !== command)
      errors.push(`Skill name mismatch for /${command}: expected '${command}', found '${skillName}'`);
    const aliasPresent = globDir(agentDir, '.md').some((af) => {
      const afm = extractFrontmatterLines(readLines(af), basename(af));
      return afm ? extractScalar(afm, 'alias') === expectedAlias : false;
    });
    if (!aliasPresent)
      errors.push(`No plugin agent carries alias '${expectedAlias}' for slash command /${command}`);
  }
  return errors;
}
// README markdown slash-command list must mirror the bundled command set.
function slashInventoryReadmeErrors(checks) {
  const errors = [];
  const file = join(REPO_ROOT, 'README.md');
  const label = 'README slash-command list';
  const sectionStart = '### Slash commands';
  const sectionEnd = '### Required handoffs';
  if (!existsSync(file)) { errors.push(`${label} not found: ${file}`); return errors; }
  const lines = readLines(file);
  let inSection = false;
  const actual = new Set();
  for (const line of lines) {
    if (line.trim() === sectionStart) { inSection = true; continue; }
    if (inSection && line.trim() === sectionEnd) break;
    if (inSection) {
      const m = line.match(/^- `\/([^`]+)`/);
      if (m) actual.add(m[1]);
      }
  }
  const expected = new Set(SLASH_COMMAND_NAMES);
  if (actual.size !== expected.size || [...actual].some((x) => !expected.has(x)))
    errors.push(`${label} does not match the bundled slash-command inventory: ${file}`);
  else checks.push(label);
  return errors;
}

// ---------- plugin hook manifest + userConfig contract (task 13) ----------
// The landed plugin manifests are the truth this gate encodes:
//   - hooks.json: description + hooks map only; every event name stays in the
//     host/dispatcher vocabulary (including the StopFailure registration);
//     records stay nested {matcher, hooks:[...]}; every command hook keeps
//     exec form (type "command", command "node", non-empty args array) routing
//     to the ONE Node dispatcher with a consistent --event; every registration
//     declares a bounded timeout (10s sync, 30s async); onFailure uses the
//     hooks-reference vocabulary block|warn|disable, and "block" is reserved
//     for the shared PreToolUse shell-policy registrations (Bash and PowerShell
//     parity) per ADR 0011 - a handler that cannot run cannot decide advisory
//     vs enforce.
//   - plugin.json userConfig: the contract keys enforcement_mode (advisory or
//     enforce), log_max_bytes, ledger_max_bytes, and workflow_profile
//     (legacy|lean, default legacy — landed by task 11). An UNKNOWN userConfig
//     key fails here: this repo gate is stricter than the packaged smoke
//     (plugin-install-smoke.mjs keeps the documented compat-window stance of
//     allowing extra keys).
export const KNOWN_HOOK_EVENTS = new Set([
  'SessionStart', 'InstructionsLoaded', 'UserPromptSubmit', 'PreToolUse',
  'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Stop', 'TeammateIdle', 'TaskCompleted',
  'Notification', 'ConfigChange', 'PreCompact', 'PostCompact', 'SessionEnd',
  'StopFailure',
]);
export const MATCHER_EVENTS = new Set([
  'InstructionsLoaded', 'PreToolUse', 'PermissionRequest', 'PermissionDenied',
  'PostToolUse', 'PostToolUseFailure',
]);
export const VALID_HOOK_RECORD_KEYS = new Set(['matcher', 'hooks']);
export const VALID_COMMAND_HOOK_KEYS = new Set(['type', 'command', 'args', 'async', 'timeout', 'onFailure']);
export const ON_FAILURE_VALUES = new Set(['block', 'warn', 'disable']);
export const SHELL_POLICY_MATCHERS = ['Bash', 'PowerShell'];
export const SYNC_TIMEOUT_SECONDS = 10;
export const ASYNC_TIMEOUT_SECONDS = 30;
export const DISPATCHER_TARGET = '${CLAUDE_PLUGIN_ROOT}/modules/hook-dispatcher.mjs';
export const USER_CONFIG_CONTRACT_KEYS = [
  'enforcement_mode', 'log_max_bytes', 'ledger_max_bytes', 'workflow_profile',
];
// Value domain of the workflow_profile userConfig key (task 11 / ADR 0012):
// legacy is the default; lean is experimental.
export const WORKFLOW_PROFILE_VALUES = new Set(['legacy', 'lean']);
export const DEFAULT_WORKFLOW_PROFILE = 'legacy';
export const ENFORCEMENT_MODE_VALUES = new Set(['advisory', 'enforce']);
// Allowlist for hooks.json's own top-level keys.
const VALID_MANIFEST_KEYS = new Set(['description', 'hooks']);

/** Short, stable JSON-ish rendering of a value for error messages. */
function describeJsValue(v) {
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Pure structural validator for the plugin hooks.json manifest.
 * Takes the parsed manifest and returns a list of error strings
 * (empty = valid): no filesystem access, no shared state, so
 * test/validators can drive negative fixtures against it directly.
 */
export function validateHookManifestStructure(manifest) {
  const errors = [];
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [`hook manifest must be a JSON object, got ${describeJsValue(manifest)}`];
  }
  for (const key of Object.keys(manifest)) {
    if (!VALID_MANIFEST_KEYS.has(key)) {
      errors.push(`unsupported top-level key(s) in hooks.json: ${key} (allowed: description, hooks)`);
    }
  }
  const hooks = manifest.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    errors.push('hook manifest must map event names to hook-record arrays');
    return errors;
  }
  for (const [event, entries] of Object.entries(hooks)) {
    if (!KNOWN_HOOK_EVENTS.has(event)) {
      errors.push(`unknown hook event '${event}' (allowed events: ${[...KNOWN_HOOK_EVENTS].join(', ')})`);
      continue;
    }
    if (!Array.isArray(entries)) {
      errors.push(`hook event '${event}' must be an array of hook records`);
      continue;
    }
    if (entries.length === 0) {
      errors.push(`hook event '${event}' must declare at least one hook record`);
      continue;
    }
    entries.forEach((rec, i) => {
      errors.push(...hookRecordErrors(event, i, rec));
    });
  }
  errors.push(...shellPolicyErrors(hooks));
  return errors;
}

/** Validate one nested hook record under one event. Internal. */
function hookRecordErrors(event, index, rec) {
  const label = `${event}[${index}]`;
  const errors = [];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    errors.push(`${label}: hook record must be an object`);
    return errors;
  }
  const badKeys = Object.keys(rec).filter((k) => !VALID_HOOK_RECORD_KEYS.has(k));
  if (badKeys.length) {
    errors.push(`${label}: unknown hook record field(s): ${badKeys.join(', ')} (allowed: matcher, hooks)`);
  }
  if (!('matcher' in rec)) {
    errors.push(`${label}: hook record must declare a matcher`);
  } else if (typeof rec.matcher !== 'string' || rec.matcher.length === 0) {
    errors.push(`${label}: hook record matcher must be a non-empty string, got ${describeJsValue(rec.matcher)}`);
  } else if (MATCHER_EVENTS.has(event) && rec.matcher === '*') {
    errors.push(`${label}: matcher-based event '${event}' must use a real tool matcher, not '*'`);
  }
  if (!('hooks' in rec)) {
    errors.push(`${label}: hook record must use the nested {matcher, hooks: [...]} format (missing 'hooks')`);
    return errors;
  }
  if (!Array.isArray(rec.hooks)) {
    errors.push(`${label}: 'hooks' must be an array of command hook definitions`);
    return errors;
  }
  if (rec.hooks.length === 0) {
    errors.push(`${label}: 'hooks' array must not be empty`);
    return errors;
  }
  rec.hooks.forEach((hd, j) => {
    errors.push(...commandHookErrors(event, index, j, hd));
  });
  return errors;
}

/** Validate one command hook definition. Internal. */
function commandHookErrors(event, recordIndex, hookIndex, hd) {
  const label = `${event}[${recordIndex}].hooks[${hookIndex}]`;
  const errors = [];
  if (!hd || typeof hd !== 'object' || Array.isArray(hd)) {
    errors.push(`${label}: command hook must be an object`);
    return errors;
  }
  const badKeys = Object.keys(hd).filter((k) => !VALID_COMMAND_HOOK_KEYS.has(k));
  if (badKeys.length) {
    errors.push(`${label}: unknown command hook field(s): ${badKeys.join(', ')}
(allowed: ${[...VALID_COMMAND_HOOK_KEYS].join(', ')})`);
  }
  if (hd.type !== 'command') {
    errors.push(`${label}: hook type must be "command", got ${describeJsValue(hd.type)} (exec form)`);
  }
  if (typeof hd.command !== 'string' || hd.command.length === 0) {
    errors.push(`${label}: command hook must declare command: "node" (exec form)`);
  } else if (hd.command !== 'node') {
    errors.push(`${label}: hook command must be "node" (exec form, single dispatcher), got ${describeJsValue(hd.command)}`);
  }
  if (!Array.isArray(hd.args) || hd.args.length === 0) {
    errors.push(`${label}: command hook must declare a non-empty args array (exec form)`);
  } else {
    if (!hd.args.includes(DISPATCHER_TARGET)) {
      errors.push(`${label}: hook must route to the single Node dispatcher (${DISPATCHER_TARGET})`);
    }
    const evIdx = hd.args.indexOf('--event');
    if (evIdx >= 0 && hd.args[evIdx + 1] !== event) {
      errors.push(`${label}: --event ${describeJsValue(hd.args[evIdx + 1])} does not match the registered event '${event}'`);
    }
  }
  if (!('timeout' in hd)) {
    errors.push(`${label}: missing required 'timeout' (synchronous registrations use ${SYNC_TIMEOUT_SECONDS}s, asynchronous ${ASYNC_TIMEOUT_SECONDS}s)`);
  } else if (typeof hd.timeout !== 'number' || !Number.isFinite(hd.timeout) || hd.timeout <= 0) {
    errors.push(`${label}: 'timeout' must be a positive finite number of seconds, got ${describeJsValue(hd.timeout)}`);
  } else if (hd.async === true) {
    if (hd.timeout !== ASYNC_TIMEOUT_SECONDS) {
      errors.push(`${label}: asynchronous registration (async: true) must declare timeout: ${ASYNC_TIMEOUT_SECONDS}, got ${describeJsValue(hd.timeout)}`);
    }
  } else if ('async' in hd && typeof hd.async !== 'boolean') {
    errors.push(`${label}: 'async' must be a boolean, got ${describeJsValue(hd.async)}`);
  } else if (hd.timeout !== SYNC_TIMEOUT_SECONDS) {
    errors.push(`${label}: synchronous registration must declare timeout: ${SYNC_TIMEOUT_SECONDS} (async: ${ASYNC_TIMEOUT_SECONDS}), got ${describeJsValue(hd.timeout)}`);
  }
  if ('onFailure' in hd) {
    if (!ON_FAILURE_VALUES.has(hd.onFailure)) {
      errors.push(`${label}: 'onFailure' must be one of block|warn|disable (hooks reference vocabulary), got ${describeJsValue(hd.onFailure)}`);
    } else if (hd.onFailure === 'block' && event !== 'PreToolUse') {
      errors.push(`${label}: onFailure:"block" is allowed only on the shared PreToolUse shell-policy registrations (ADR 0011), found on '${event}'`);
    }
  }
  return errors;
}

/**
 * PreToolUse shell-policy parity (task 03 / F09 / ADR 0011): both shell tool
 * matchers must get the shared blocker registration, each carrying
 * onFailure:"block" and routing the shell policy with --matcher Bash.
 */
function shellPolicyErrors(hooks) {
  const errors = [];
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const byMatcher = new Map();
  for (const rec of pre) {
    if (rec && typeof rec.matcher === 'string') byMatcher.set(rec.matcher, rec);
  }
  for (const shellMatcher of SHELL_POLICY_MATCHERS) {
    const rec = byMatcher.get(shellMatcher);
    if (!rec) {
      errors.push(`PreToolUse must register the shared shell-policy blocker for the ${shellMatcher} matcher (Bash/PowerShell parity, ADR 0011)`);
      continue;
    }
    const hookDefs = Array.isArray(rec.hooks) ? rec.hooks : [];
    if (!hookDefs.some((hd) => hd && hd.onFailure === 'block')) {
      errors.push(`PreToolUse '${shellMatcher}' shell-policy registration must carry onFailure:"block" (an unrunnable handler cannot decide advisory vs enforce — ADR 0011)`);
    }
    if (shellMatcher === 'PowerShell') {
      const routesBashPolicy = hookDefs.some((hd) => {
      if (!hd || !Array.isArray(hd.args)) return false;
      const i = hd.args.indexOf('--matcher');
      return i >= 0 && hd.args[i + 1] === 'Bash';
    });
      if (!routesBashPolicy) {
        errors.push(`PreToolUse 'PowerShell' registration must route the shared shell policy with --matcher Bash`);
      }
    }
  }
  return errors;
}

/**
 * Pure validator for the plugin manifest userConfig shape. Contract keys are
 * required with typed, in-domain defaults; UNKNOWN keys fail the repo gate
 * (the packaged smoke stays looser for the compatibility window).
 */
export function validateUserConfigShape(userConfig) {
  if (userConfig === undefined) {
    return [`plugin userConfig missing: expected ${USER_CONFIG_CONTRACT_KEYS.join(', ')}`];
  }
  if (userConfig === null || typeof userConfig !== 'object' || Array.isArray(userConfig)) {
    return [`plugin userConfig must be an object mapping config keys to definitions, got ${describeJsValue(userConfig)}`];
  }
  const errors = [];
  const keys = Object.keys(userConfig);
  const allowed = [...USER_CONFIG_CONTRACT_KEYS];
  const unknown = keys.filter((k) => !allowed.includes(k));
  if (unknown.length) {
    errors.push(`unknown userConfig key(s): ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
  }
  const missing = USER_CONFIG_CONTRACT_KEYS.filter((k) => !keys.includes(k));
  if (missing.length) {
    errors.push(`plugin userConfig missing contract key(s): ${missing.join(', ')} (contract: ${USER_CONFIG_CONTRACT_KEYS.join(', ')})`);
  }
  USER_CONFIG_CONTRACT_KEYS.forEach((key) => {
    const def = keys.includes(key) ? userConfig[key] : null;
    if (!def || typeof def !== 'object' || Array.isArray(def)) return;
    if (key === 'enforcement_mode') {
      if (def.type !== undefined && def.type !== 'string') {
        errors.push(`userConfig.enforcement_mode type must be "string", got ${describeJsValue(def.type)}`);
      }
      if ('default' in def && !ENFORCEMENT_MODE_VALUES.has(def.default)) {
        errors.push(`userConfig.enforcement_mode default must be one of advisory|enforce, got ${describeJsValue(def.default)}`);
      }
    }
    if (key === 'log_max_bytes' || key === 'ledger_max_bytes') {
      if (def.type !== undefined && def.type !== 'number') {
        errors.push(`userConfig.${key} type must be "number", got ${describeJsValue(def.type)}`);
      }
      if ('default' in def && (typeof def.default !== 'number' || !Number.isFinite(def.default) || def.default <= 0)) {
        errors.push(`userConfig.${key} default must be a positive finite byte threshold, got ${describeJsValue(def.default)}`);
      }
    }
    if (key === 'workflow_profile') {
      if (def.type !== undefined && def.type !== 'string') {
        errors.push(`userConfig.workflow_profile type must be "string", got ${describeJsValue(def.type)}`);
      }
      if ('default' in def && (typeof def.default !== 'string' || !WORKFLOW_PROFILE_VALUES.has(def.default))) {
        errors.push(`userConfig.workflow_profile default must be one of legacy|lean, got ${describeJsValue(def.default)}`);
      }
    }
  });
  return errors;
}

// ---------- plugin manifest contract (repo gate) ----------
/**
 * Repo-facing check: validate the SOURCE plugin manifest pair
 * (hooks/hooks.json + .claude-plugin/plugin.json) with the same pure
 * validators test/validators drives; the packaged tier (install smoke) keeps
 * its own compat-window stance.
 */
function checkPluginManifestContract() {
  console.log('--- Checking plugin hook manifest + userConfig contract ---');
  const hooksPath = join(REPO_ROOT, 'plugins', 'agnthive', 'hooks', 'hooks.json');
  const pluginManifestPath = join(REPO_ROOT, 'plugins', 'agnthive', '.claude-plugin', 'plugin.json');
  let hookErrors = [];
  try {
    hookErrors = validateHookManifestStructure(JSON.parse(readFileSync(hooksPath, 'utf-8')));
  } catch (e) {
    hookErrors = [`hooks manifest ${relative(REPO_ROOT, hooksPath)} is missing or not parseable JSON: ${e.message}`];
  }
  if (hookErrors.length === 0) {
    console.log('OK: hooks.json event vocabulary, nested records, exec form, single dispatcher, timeout/onFailure policy, PowerShell parity');
  } else {
    for (const e of hookErrors) reportError(e);
  }
  let ucErrors = [];
  try {
    const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf-8'));
    ucErrors = validateUserConfigShape(pluginManifest.userConfig);
  } catch (e) {
    ucErrors = [`plugin manifest ${relative(REPO_ROOT, pluginManifestPath)} is missing or not parseable JSON: ${e.message}`];
  }
  if (ucErrors.length === 0) {
    console.log('OK: plugin.json userConfig contract keys + value domains');
  } else {
    for (const e of ucErrors) reportError(e);
  }
  console.log('');
}

// ---------- workflow policy invariants ----------
function readWorkflow(name) {
  return readFileSync(join(REPO_ROOT, '.github', 'workflows', name), 'utf-8');
}

function checkWorkflowPolicy() {
  console.log('--- Checking workflow policy invariants ---');
  const checks = [
    // hooks-test.yml is a pure Node hook-fixture run (scripts/test-hooks.mjs)
    // with no Python tooling. validate.yml and lint.yml (name: Lint) are
    // likewise Node-only now: the benchmark fixtures are JS (`node --test`), so
    // neither installs Python, runs `compileall`, or runs `ruff`. validate.yml
    // still sets up Go on Linux to build actionlint; pin that toolchain.
    ['validate.yml', 'uses: actions/setup-go@v6', 'Repository Checks uses setup-go@v6', 'Repository Checks must use setup-go@v6'],
    ['validate.yml', 'uses: actions/setup-node@v', 'Repository Checks uses setup-node@v5+', 'Repository Checks must use setup-node@v5 or later'],
    ['lint.yml', 'uses: actions/setup-node@v', 'Lint uses setup-node@v5+', 'Lint must use setup-node@v5 or later'],
  ];
  for (const [file, needle, ok, err] of checks) {
    const txt = readWorkflow(file);
    if (txt.includes(needle)) console.log(`OK: ${ok}`);
    else reportError(err);
  }

  // Benchmark task JSON sample validity.
  const benchTasks = walkGlob(join(REPO_ROOT, 'bench', 'tasks'), '.json');
  if (benchTasks.length === 0) reportError('No benchmark task JSON files found under bench/tasks');
  let sampleBad = false;
  for (const f of benchTasks.slice(0, 5)) {
    try { JSON.parse(readFileSync(f, 'utf-8')); } catch { sampleBad = true; break; }
  }
  if (!sampleBad) console.log('OK: Benchmark task JSON files are valid (sample check)');
  else reportError('Benchmark task JSON files under bench/tasks failed jq validation');

  // Behavior benchmark subagents smoke PR selector.
  const bb = readWorkflow('behavior-benchmark-subagents-smoke.yml');
  const bbOk =
    bb.includes('--suite subagents_smoke') &&
    bb.includes('pull_request:') &&
    bb.includes('scripts/download-benchmark-summary.mjs') &&
    bb.includes('render-benchmark-summary.mjs bench-output/summary.json') &&
    bb.includes('bench-output/benchmark-report.md') &&
    bb.includes("'plugins/agnthive/**'") &&
    bb.includes('--ref-name "${REF_NAME:-}"') &&
    !bb.includes("if: github.event_name != 'workflow_dispatch'");
  if (bbOk) console.log('OK: Behavior Benchmark Subagents Smoke PR selector');
  else reportError('Behavior Benchmark Subagents Smoke workflow must keep plugin-trigger coverage, support manual changed-file collection, and publish markdown benchmark tables');
  console.log('');
}

// ---------- Node.js 24 readiness ----------
function checkNode24Readiness() {
  console.log('--- Checking GitHub Actions Node.js 24 readiness ---');
  const wfs = walkGlob(join(REPO_ROOT, '.github', 'workflows'), '.yml');
  const all = wfs.map((f) => readFileSync(f, 'utf-8')).join('\n');
  if (all.includes('actions/cache@v4')) reportError('actions/cache@v4 targets deprecated Node.js 20 — use v5 or v6');
  else console.log('OK: No actions/cache@v4 (uses v5 or v6)');
  if (all.includes('FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true')) console.log('OK: FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 set');
  else reportError('Benchmark workflows must set env: FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true');
  console.log('');
}

// ---------- notification docs ----------
function checkNotificationDocs() {
  console.log('--- Checking docs consistency for notification hook ---');
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf-8');
  if (readme.includes('`Notification`')) console.log('OK: Notification hook documented in README.md');
  else reportError('Notification hook must be documented in README.md');
  console.log('');
}

// ---------- hook test manifests ----------
function checkHookManifests() {
  console.log('--- Checking hook test manifests ---');
  const casesFile = join(REPO_ROOT, 'test', 'hooks', 'cases.json');
  const scenariosFile = join(REPO_ROOT, 'test', 'hooks', 'scenarios.json');
  if (existsSync(casesFile)) {
    let cases;
    try { cases = JSON.parse(readFileSync(casesFile, 'utf-8')); } catch { reportError('Hook cases manifest is invalid JSON'); cases = null; }
    if (cases !== null) {
      if (!Array.isArray(cases)) reportError('Hook cases manifest must be a JSON array');
      else {
        for (const c of cases) {
          const name = c.name;
          const script = c.script;
          const stdin = c.stdin;
          // `script` is an event label (basename of the legacy hook), not a file
          // the harness runs — the Node dispatcher is spawned instead. Validate
          // it is a recognized event label; only the fixture (stdin) is a file.
          if (!script || !SCRIPT_TO_EVENT[basename(script)]) reportError(`Hook case '${name}' has missing or unmapped event-script label: ${script || '<empty>'}`);
          if (!stdin || !existsSync(join(REPO_ROOT, stdin))) reportError(`Hook case '${name}' has missing or non-existent fixture: ${stdin || '<empty>'}`);
        }
        console.log(`OK: ${relative(REPO_ROOT, casesFile)}`);
      }
    }
  } else console.log('No hook case manifest found');
  if (existsSync(scenariosFile)) {
    let scens;
    try { scens = JSON.parse(readFileSync(scenariosFile, 'utf-8')); } catch { reportError('Hook scenarios manifest is invalid JSON'); scens = null; }
    if (scens !== null) {
      if (!Array.isArray(scens)) reportError('Hook scenarios manifest must be a JSON array');
      else {
        for (const s of scens) {
          const sname = s.name;
          if (s.seed_state && !existsSync(join(REPO_ROOT, s.seed_state)))
            reportError(`Hook scenario '${sname}' references missing seed_state: ${s.seed_state}`);
          for (const step of (s.steps || [])) {
            const stepName = step.name;
            if (!step.script || !SCRIPT_TO_EVENT[basename(step.script)])
              reportError(`Hook scenario '${sname}::${stepName}' has missing or unmapped event-script label: ${step.script || '<empty>'}`);
            if (!step.stdin || !existsSync(join(REPO_ROOT, step.stdin)))
              reportError(`Hook scenario '${sname}::${stepName}' has missing or non-existent fixture: ${step.stdin || '<empty>'}`);
            if (step.cwd) {
              const cwdPath = join(REPO_ROOT, step.cwd);
              if (!existsSync(cwdPath) || !statSync(cwdPath).isDirectory())
                reportError(`Hook scenario '${sname}::${stepName}' references missing or non-directory cwd: ${step.cwd}`);
            }
            if (step.seed_state && !existsSync(join(REPO_ROOT, step.seed_state)))
              reportError(`Hook scenario '${sname}::${stepName}' references missing seed_state: ${step.seed_state}`);
          }
        }
        console.log(`OK: ${relative(REPO_ROOT, scenariosFile)}`);
      }
    }
  } else console.log('No hook scenario manifest found');
  console.log('');
}

// ---------- benchmark tasks ----------
function isArrayOfArrays(v) {
  return Array.isArray(v) && v.every((x) => Array.isArray(x));
}

function checkBenchmarkTasks() {
  console.log('--- Checking benchmark tasks ---');
  const EXPECTED_SUBAGENT_ALIASES = ['m', 'e', 'a', 'bug', 'dbg', 't', 'cr', 'doc'];
  const SUBAGENT_REQUIRED_FOOTER_REGEXES = ['Outcome:', 'Changed files:|No files changed:', 'Verification status:', 'Remaining risks:|Next step:'];
  const taskFiles = walkGlob(join(REPO_ROOT, 'bench', 'tasks'), '.json').sort();
  const taskIds = [];
  const smokeAliasesSeen = [];
  for (const tf of taskFiles) {
    // Normalize path separators to '/' so the subagent/smoke path checks below
    // work on Windows (where join()/walk() produce backslash paths) as well as
    // POSIX. POSIX paths have no backslashes, so this is a no-op there.
    const pathStr = tf.split(sep).join('/');
    let task;
    try { task = JSON.parse(readFileSync(tf, 'utf-8')); } catch { reportError(`Benchmark task is invalid JSON: ${tf}`); continue; }
    const taskId = task.id || '';
    const fixture = task.fixture || '';
    const agentAlias = task.agent_alias || '';

    const requiredFieldsOk =
      task.id && task.suite && task.category && task.fixture && task.prompt &&
      Array.isArray(task.related_agents) && task.related_agents.length > 0 &&
      Object.prototype.hasOwnProperty.call(task, 'review_required') &&
      Object.prototype.hasOwnProperty.call(task, 'docs_required') &&
      Object.prototype.hasOwnProperty.call(task, 'verification_required') &&
      Array.isArray(task.success_criteria) &&
      Array.isArray(task.must_not) &&
      Array.isArray(task.forbidden_doc_patterns || []) &&
      Array.isArray(task.forbidden_transcript_patterns || []) &&
      Array.isArray(task.required_transcript_patterns || []) &&
      Array.isArray(task.required_used_agents || []) &&
      Array.isArray(task.required_used_agent_groups || []) &&
      isArrayOfArrays(task.required_used_agent_groups || []);
    if (!requiredFieldsOk) { reportError(`Benchmark task has missing required fields: ${tf}`); continue; }

    if (fixture) {
      const fixturePath = join(REPO_ROOT, 'bench', 'fixtures', fixture);
      if (!existsSync(fixturePath) || !statSync(fixturePath).isDirectory())
        reportError(`Benchmark task '${taskId}' references missing or non-directory fixture: ${fixture}`);
    }

    for (const a of (task.required_used_agents || [])) {
      if (!EXPECTED_SUBAGENT_ALIASES.includes(a))
        reportError(`Benchmark task references unknown required_used_agents alias '${a}': ${tf}`);
    }
    for (const a of (task.required_used_agent_groups || []).flat()) {
      if (!EXPECTED_SUBAGENT_ALIASES.includes(a))
        reportError(`Benchmark task references unknown required_used_agent_groups alias '${a}': ${tf}`);
    }

    // Optional dispatch_contract: when present it must be well-formed and its
    // required_agents must be known aliases, so runner and hook contracts
    // cannot silently drift (Stage 3 of the dispatch-stabilization plan).
    if (Object.prototype.hasOwnProperty.call(task, 'dispatch_contract')) {
      const dc = task.dispatch_contract || {};
      const dcMode = dc.mode;
      if (dcMode !== 'observed' && dcMode !== 'enforced' && dcMode !== 'standard') {
        reportError(`Benchmark task '${taskId}' has invalid dispatch_contract.mode '${dcMode}' (expected observed|enforced|standard): ${tf}`);
      }
      if (dc.root_only !== undefined && typeof dc.root_only !== 'boolean') {
        reportError(`Benchmark task '${taskId}' dispatch_contract.root_only must be boolean: ${tf}`);
      }
      const dcRoles = dc.required_agents;
      if (!Array.isArray(dcRoles) || !dcRoles.length) {
        reportError(`Benchmark task '${taskId}' dispatch_contract.required_agents must be a non-empty array: ${tf}`);
      } else {
        for (const a of dcRoles) {
          if (!EXPECTED_SUBAGENT_ALIASES.includes(a))
            reportError(`Benchmark task '${taskId}' dispatch_contract references unknown alias '${a}': ${tf}`);
        }
        const rua = task.required_used_agents || [];
        const sameSet = rua.length === dcRoles.length && dcRoles.every((a) => rua.includes(a));
        if (!sameSet)
          reportError(`Benchmark task '${taskId}' dispatch_contract.required_agents must match required_used_agents: ${tf}`);
      }
    }

    if (pathStr.includes('/bench/tasks/subagents/')) {
      const ftp = task.forbidden_transcript_patterns || [];
      const rtp = task.required_transcript_patterns || [];
      const rua = task.required_used_agents || [];
      const rug = task.required_used_agent_groups || [];
      const subagentOk =
        agentAlias &&
        Array.isArray(ftp) && ftp.length > 0 &&
        ((Array.isArray(rtp) && rtp.length > 0) ||
         (Array.isArray(rua) && rua.length > 0) ||
         (Array.isArray(rug) && rug.some((g) => Array.isArray(g) && g.length > 0)));
      if (!subagentOk) {
        reportError(`Subagent benchmark task must declare agent_alias, non-empty forbidden transcript patterns, and at least one required transcript or used-agent assertion: ${tf}`);
      } else if (pathStr.includes('/bench/tasks/subagents/smoke/')) {
        smokeAliasesSeen.push(agentAlias);
      }
      if (Array.isArray(rtp) && rtp.length > 0) {
        for (const pat of SUBAGENT_REQUIRED_FOOTER_REGEXES) {
          if (!rtp.some((p) => { try { return new RegExp(p).test(pat); } catch { return p === pat; } }))
            reportError(`Subagent benchmark task is missing required footer transcript pattern '${pat}': ${tf}`);
        }
      }
      if (agentAlias === 'cr') {
        if (!(rtp || []).some((p) => p === 'Review outcome:'))
          reportError(`Code reviewer benchmark task must require 'Review outcome:' in transcript patterns: ${tf}`);
      }
    }

    if (taskId) {
      if (taskIds.includes(taskId)) reportError(`Duplicate benchmark task id: ${taskId}`);
      else taskIds.push(taskId);
    }
    console.log(`OK: ${tf}`);
  }
  for (const alias of EXPECTED_SUBAGENT_ALIASES) {
    if (!smokeAliasesSeen.includes(alias))
      reportError(`Missing subagent smoke benchmark coverage for agent alias: ${alias}`);
  }
  console.log('');
}

// ---------- internal links ----------
function checkInternalLinks() {
  console.log('--- Checking internal links ---');
  const mdFiles = walkGlob(REPO_ROOT, '.md').sort();
  for (const md of mdFiles) {
    const mdDir = dirname(md);
    const lines = readLines(md);
    for (const line of lines) {
      // Extract all ](...) links on this line.
      const re = /\]\(([^)]*)\)/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        let link = m[1];
        if (!link) continue;
        if (/^https?:\/\//.test(link) || /^#/.test(link) || /^mailto:/.test(link)) continue;
        let target;
        if (link.startsWith('/')) target = join(REPO_ROOT, link);
        else target = join(mdDir, link);
        target = target.split('#')[0];
        target = target.replace(/\/$/, '');
        if (!existsSync(target) && !existsSync(`${target}.md`))
          reportError(`Broken link in ${md}: ${link} (resolved to: ${target})`);
      }
    }
  }
  console.log('');
}

// ---------- legacy runtime gate ----------
function checkLegacyRuntime() {
  console.log('--- Checking no legacy runtime scripts ---');
  const { ok, offenses, allowlisted } = checkNoLegacyRuntime(REPO_ROOT);
  if (!ok) {
    for (const o of offenses) reportError(o);
  } else {
    console.log('OK: no legacy .py/.sh in plugin runtime');
    if (allowlisted.length) {
      for (const name of allowlisted) console.log(`OK: allowlisted ${name} (CI-only agent runner; not part of the shipped plugin runtime)`);
    }
  }
  console.log('');
}

function checkPluginInstallSmoke() {
  console.log('--- Checking packaged-plugin install smoke (tier-1 strict) ---');
  const srcDir = join(REPO_ROOT, 'plugins', 'agnthive');
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    reportError(`plugin source dir not found: ${srcDir}`);
    console.log('');
    return;
  }
  const tmpRoot = mkdtempSync(join(tmpdir(), 'validate-plugin-smoke-'));
  try {
    const pluginDir = packagePlugin(srcDir, tmpRoot);
    const { ok, errors, checks } = validatePackagedPlugin(pluginDir);
    for (const c of checks) console.log(`OK: ${c}`);
    if (!ok) {
      for (const e of errors) reportError(e);
    } else {
      console.log(`OK: plugin-install-smoke passed (${checks.length} checks)`);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log('');
}

// ---------- main ----------
function main() {
  // Anchor the process at the repo root for anything that resolves relative
  // paths (imported test harnesses and fixture readers); pure validators take
  // parsed data, so nothing in this file requires the anchor — except main().
  process.chdir(REPO_ROOT);

  console.log('=== Validation Script ===');
  console.log(`Repository: ${REPO_ROOT}`);
  console.log('');
  checkJson();
  checkWorkflowSyntax();
  checkAgentFrontmatter();
  checkSkillFrontmatter();
   checkSlashCommandInventory();
  checkPluginManifestContract();
  checkWorkflowPolicy();
  checkNode24Readiness();
  checkNotificationDocs();
  checkHookManifests();
  checkBenchmarkTasks();
  checkInternalLinks();
  checkLegacyRuntime();
  checkPluginInstallSmoke();

  console.log('=== Summary ===');
  if (ERRORS === 0) { console.log('All checks passed!'); process.exit(0); }
  console.log(`Found ${ERRORS} error(s)`);
  process.exit(1);
}

// Cross-platform main-module detection (same pattern as
// scripts/plugin-install-smoke.mjs): test/validators tests import this module
// for its exported contract validators and constants, so main() must only run
// when validate.mjs is the entry script. pathToFileURL normalizes argv[1] to a
// file:// URL comparable to import.meta.url on all platforms (Windows drive
// paths included).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
// agents.mjs — role inference, alias normalization, subagent labeling.
// Ported from lib.sh: extract_subagent_label, extract_subagent_scope,
// canonicalize_subagent_label, infer_started_roles_from_transcript,
// effective_started_roles, format_subagent_list, format_subagent_group.
// Backed by assets/aliases.json for transcript compatibility. Node stdlib only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Generic Task tool dispatch types, filtered from role enforcement. */
export const GENERIC_TYPES = ['general-purpose', 'workflow-subagent'];

/** True if `x` is a generic Task tool dispatch type (not an agent role). */
export function isGenericType(x) {
  return typeof x === 'string' && GENERIC_TYPES.includes(x);
}

/**
 * True if the alias map is loaded (a non-empty plain object). Single source of
 * truth for the "is the alias map loaded?" predicate: the dispatcher precomputes
 * it once at module init (the map is immutable for the process lifetime) and
 * `shouldEnforceSubagentFooter` derives it from `aliases` when the caller omits
 * the precomputed boolean. Sharing the predicate keeps the safe-floor
 * degradation logic from drifting between the two modules.
 */
export function isAliasesLoaded(aliases) {
  return !!(aliases && typeof aliases === 'object' && Object.keys(aliases).length > 0);
}

/** Load the alias map from assets/aliases.json (returns {} if missing). */
export function loadAliases(pluginRoot) {
  if (!pluginRoot) return {};
  try { return JSON.parse(readFileSync(join(pluginRoot, 'assets', 'aliases.json'), 'utf8')); } catch { return {}; }
}

function getPath(obj, dotted) {
  let cur = obj;
  for (const k of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

// Field paths probed in order by extract_subagent_label (jq `//` chain).
const LABEL_PATHS = [
  'agent_alias', 'agentAlias', 'alias', 'subagent_alias', 'subagentAlias',
  'subagent_type', 'subagentType',
  'tool_input.agent_alias', 'tool_input.agentAlias', 'tool_input.alias',
  'tool_input.subagent_alias', 'tool_input.subagentAlias',
  'tool_input.subagent_type', 'tool_input.subagentType',
  'agent_name', 'agentName', 'subagent_name', 'subagentName', 'name',
  'tool_input.agent', 'tool_input.agent_name', 'tool_input.agentName',
  'tool_input.subagent_name', 'tool_input.subagentName', 'tool_input.name',
  'tool_input.type', 'tool_input.agent_type', 'tool_input.agentType',
  'agent_type', 'agentType', 'type',
];

const SCOPE_PATHS = [
  'tool_input.description', 'tool_input.prompt', 'tool_input.task',
  'description', 'prompt', 'task',
];

/**
 * canonicalize_subagent_label: lowercase, strip leading @, turn whitespace and
 * underscores into dashes, drop non-[a-z0-9.-], trim/collapse dashes, then map
 * to a canonical role via the alias map (key whose value list contains it).
 */
export function canonicalizeSubagentLabel(raw, aliases = {}) {
  if (raw == null) return '';
  let n = String(raw).toLowerCase().replace(/^@/, '');
  // Strip only this plugin's own namespace prefix (e.g. agnthive:Explorer ->
  // explorer) so plugin-namespaced agent types canonicalize to the bare role.
  // Narrowing to the 'agnthive' prefix avoids over-matching foreign namespaces:
  // mcp:tester -> tester -> t or workflow:docs -> docs -> doc would otherwise be
  // misrecognized as AgntHive specialists and footer-blocked (the ADR-0001 bug
  // reintroduced for any colon-suffixed type). No alias value or canonical role
  // contains a colon, and the plugin namespace is the only one we own.
  if (n.startsWith('agnthive:')) n = n.slice('agnthive:'.length);
  // Guard against ReDoS on unbounded input — labels are short identifiers.
  if (n.length > 128) n = n.slice(0, 128);
  n = n.replace(/[\s_]/g, '-');
  n = n.replace(/[^a-z0-9.-]/g, '-');
  // Collapse consecutive dashes and trim leading/trailing dashes
  // (split/filter/join avoids /-+/g regex flagged by CodeQL js/polynomial-redos).
  n = n.split('-').filter(Boolean).join('-');
  if (!n) return '';
  for (const [canonical, list] of Object.entries(aliases)) {
    if (Array.isArray(list) && list.includes(n)) return canonical;
  }
  return n;
}

/** extract_subagent_label: first non-null label field, canonicalized. */
export function extractSubagentLabel(hookInput, aliases = {}) {
  for (const p of LABEL_PATHS) {
    const v = getPath(hookInput, p);
    if (v !== undefined && v !== null) return canonicalizeSubagentLabel(v, aliases);
  }
  return '';
}

/** extract_subagent_scope: first non-null scope field, whitespace-normalized. */
export function extractSubagentScope(hookInput) {
  for (const p of SCOPE_PATHS) {
    const v = getPath(hookInput, p);
    if (v !== undefined && v !== null) {
      return String(v).replace(/\s+/g, ' ').replace(/^ /, '').replace(/ $/, '');
    }
  }
  return '';
}

// skill(...) / Name(...) launch-line patterns -> role. Order matters: longer
// alternatives first so "code reviewer(" is matched before "reviewer(".
const LAUNCH_RE = /skill\(\/(manager|review|test|explore|design|bug|debug|docs|refactor)\)|manager\(|code reviewer\(|tester\(|explorer\(|architect\(|bugbuster\(|debugger\(|docwriter\(/gi;

const ALIAS_RE = /@(m|e|a|t|cr|bug|dbg|doc|manager|explorer|architect|tester|code-reviewer|code-review|reviewer|bugbuster|debugger|docwriter|big-boss|nerd|toxic-senior|paranoid|the-architect|wiki-wiki)($|[^a-z0-9-])/gi;

function roleFromLaunch(match) {
  const m = match.toLowerCase();
  if (m === 'skill(/manager)' || m === 'manager(') return 'm';
  if (m === 'skill(/review)' || m === 'code reviewer(') return 'cr';
  if (m === 'skill(/test)' || m === 'tester(') return 't';
  if (m === 'skill(/explore)' || m === 'explorer(') return 'e';
  if (m === 'skill(/design)' || m === 'skill(/refactor)' || m === 'architect(') return 'a';
  if (m === 'skill(/bug)' || m === 'bugbuster(') return 'bug';
  if (m === 'skill(/debug)' || m === 'debugger(') return 'dbg';
  if (m === 'skill(/docs)' || m === 'docwriter(') return 'doc';
  return null;
}

/**
 * infer_started_roles_from_transcript: scan transcript text for skill()/Name()
 * launch lines and @alias mentions, map each to a canonical role, and return
 * the unique sorted set.
 */
export function inferStartedRolesFromTranscript(transcriptText, aliases = {}) {
  if (!transcriptText) return [];
  const roles = new Set();
  for (const m of transcriptText.matchAll(LAUNCH_RE)) {
    const r = roleFromLaunch(m[0]);
    if (r) roles.add(r);
  }
  for (const m of transcriptText.matchAll(ALIAS_RE)) {
    if (m[1]) {
      const c = canonicalizeSubagentLabel(m[1], aliases);
      if (c) roles.add(c);
    }
  }
  return [...roles].filter(Boolean).sort();
}

/**
 * effective_started_roles: explicit roles from state.subagents_started (generic
 * dispatch types filtered out) plus roles inferred from the transcript, unique
 * and sorted.
 */
export function effectiveStartedRoles(state, transcriptText, aliases = {}) {
  const explicit = Array.isArray(state?.subagents_started) ? state.subagents_started : [];
  const roles = new Set();
  for (const r of explicit) {
    if (typeof r === 'string' && r && !isGenericType(r)) roles.add(r);
  }
  for (const r of inferStartedRolesFromTranscript(transcriptText, aliases)) roles.add(r);
  return [...roles].sort();
}

/**
 * isAgntHiveSpecialistRole: true iff `label` is a non-empty string that is a
 * key of `aliases` — i.e. one of the recognized canonical roles
 * (a | e | bug | dbg | t | cr | doc | m). Generic dispatch types and
 * unrecognized labels return false so footer enforcement can pass them through.
 */
export function isAgntHiveSpecialistRole(label, aliases = {}) {
  return typeof label === 'string' && label !== '' && Object.prototype.hasOwnProperty.call(aliases, label);
}

/**
 * shouldEnforceSubagentFooter: the ADR-0001 scope decision, hardened against the
 * two regressions the adversarial review caught.
 *
 *  1. Generic dispatch types (general-purpose, workflow-subagent) are ALWAYS
 *     exempt — they are hardcoded Task tool types, not agent roles, and must
 *     never be footer-blocked regardless of the alias map. This exemption is
 *     checked against the hardcoded GENERIC_TYPES list (and the raw agent_type
 *     when available), so it holds even if the alias map failed to load.
 *  2. Safe floor: when the alias map is available, enforce only for recognized
 *     AgntHive specialists (the ADR-0001 scope). When loadAliases swallowed an
 *     error and returned {} — aliases.json missing or corrupt — isAgntHiveSpecialistRole
 *     would always be false and EVERY subagent (including specialists) would pass
 *     through, silently disabling the footer contract. As a floor, a missing
 *     map enforces on all non-generic subagents so the safety contract degrades
 *     loud, not silent.
 *
 * `aliasesLoaded` is an optional boolean the caller may precompute once at
 * module init (the alias map is immutable for the process lifetime) to avoid
 * the per-call `Object.keys(aliases).length` allocation on the SubagentStop
 * hot path. When omitted it is derived from `aliases`.
 */
export function shouldEnforceSubagentFooter(label, rawType = null, aliases = {}, aliasesLoaded) {
  if (isGenericType(label)) return false;
  if (isGenericType(rawType)) return false;
  // ADR-0010 (plan 06.5): forks and foreign-namespace agent types carry no
  // AgntHive role contract — they are never footer-blocked, even at the
  // missing-aliases safe floor (which would otherwise enforce on any
  // non-empty label). This exemption runs BEFORE the floor on purpose.
  if (isForeignOrForkType(rawType, label)) return false;
  const loaded = typeof aliasesLoaded === 'boolean'
    ? aliasesLoaded
    : isAliasesLoaded(aliases);
  if (loaded) return isAgntHiveSpecialistRole(label, aliases);
  // No alias map (missing/corrupt): enforce on every non-generic subagent as a
  // safe floor. An empty/blank label is treated as unidentified and not enforced.
  return typeof label === 'string' && label !== '';
}

// --- ADR-0010 agent lifecycle registry (plan tasks 06.1-06.4) ---------------

/**
 * isForeignOrForkType (plan 06.5, ADR-0010): true for runtime agent types that
 * carry no AgntHive role contract — forks and other plugins' namespaced types
 * (e.g. mcp:tester, otherplugin:runner). Also true for a canonicalized label
 * of exactly 'fork'. An absent/unshaped rawType falls back to the label check
 * only. Pure; no I/O; no alias-map dependency.
 */
export function isForeignOrForkType(rawType, label = null) {
  if (typeof rawType === 'string' && rawType !== '') {
    // Raw runtime types compare case-insensitively. The 'agnthive:' namespace
    // is our own; any other namespaced type is foreign. A canonicalized label
    // cannot carry a namespace (canonicalizeSubagentLabel strips only the
    // 'agnthive:' prefix and maps other colons to dashes), so the label check
    // matches the bare 'fork' spelling only.
    const t = rawType.toLowerCase();
    if (t === 'fork') return true;
    const colon = t.indexOf(':');
    if (colon >= 1 && t.slice(0, colon) !== 'agnthive') return true;
  }
  return label === 'fork';
}
/**
 * upsertAgent (plan 06.1-06.2): pure registry upsert — a registry flows in, a
 * NEW registry flows out; input never mutated, no I/O.
 *
 * spec keys: { agentId, role, scope, taskId, status, seq, parent?, provenance? }
 *   - agentId missing/null/'' upserts into the shared '_session' fallback key:
 *     provenance 'missing-id', status 'unknown' (ADR-0010: the _session
 *     fallback cannot certify independent identities when IDs are missing).
 *   - role arrives ALREADY canonical (caller normalizes labels through the
 *     alias map); null records foreign/fork/unknown agents: role:null,
 *     provenance 'unrecognized', status 'unknown'. Omitted preserves the previous
 *     record's role.
 *   - status 'running'/'completed' accepted; anything else → 'unknown'. Null
 *     roles and missing ids FORCE status 'unknown' regardless of spec.status.
 *   - `starts` increments only on a 'running' status, so an id-less runtime's
 *     '_session' record NEVER reaches starts=1 and never counts role starts
 *     (deliberate, @cr 0.4.0 MED-LOW 9: counting per-labeled-start would
 *     certify independent identities that missing ids cannot distinguish;
 *     id-less runtimes fall back to the transcript path instead).
 */
export function upsertAgent(registry, spec = {}) {
  const base = (registry && typeof registry === 'object' && !Array.isArray(registry)) ? registry : {};
  const s = (spec && typeof spec === 'object') ? spec : {};
  const hasId = typeof s.agentId === 'string' && s.agentId !== '';
  const agentId = hasId ? s.agentId : '_session';
  const prev = (base[agentId] && typeof base[agentId] === 'object') ? base[agentId] : null;
  const roleStr = typeof s.role === 'string' && s.role !== '' ? s.role : null;
  const role = s.role === undefined
    ? (prev && prev.role != null ? prev.role : null)
    : roleStr;
  const scope = s.scope !== undefined
    ? (typeof s.scope === 'string' ? s.scope : '')
    : (prev && typeof prev.scope === 'string' ? prev.scope : '');
  const taskId = (typeof s.taskId === 'string' && s.taskId !== '')
    ? s.taskId
    : (prev && typeof prev.taskId === 'string' ? prev.taskId : '');
  const parent = (typeof s.parent === 'string' && s.parent !== '')
    ? s.parent
    : (prev && typeof prev.parent === 'string' ? prev.parent : null);
  const provenance = typeof s.provenance === 'string' && s.provenance !== ''
    ? s.provenance
    : (hasId ? (role === null ? 'unrecognized' : 'normal') : 'missing-id');
  const status = (!hasId || role === null)
    ? 'unknown'
    : (s.status === 'running' || s.status === 'completed' ? s.status : 'unknown');
  const starts = (prev ? Number(prev.starts) || 0 : 0) + (status === 'running' ? 1 : 0);
  const updatedAt = Number.isFinite(s.seq) ? s.seq : (s.updatedAt ?? (prev ? prev.updatedAt : null));
  return {
    ...base,
    [agentId]: {
      ...prev,
      role, scope, taskId, status, starts, provenance, updatedAt,
      ...(parent ? { parent } : {}),
    },
  };
}

/**
 * startedRolesFromRegistry (plan 06.4): roles recorded in the ADR-0010 agents
 * registry (state.agents), unique and sorted. Filtering: a role counts only
 * when recognized - a key of `aliases` when a non-empty map is supplied (the
 * recommended dispatcher call passes ALIASES); without aliases, roles that
 * upsertAgent recorded pass through and generic dispatch types and null roles
 * are still filtered.
 *
 * CR MED-LOW 8: records are task-scoped - a record counts only when its
 * taskId equals state.task_id (a missing taskId counts as unscoped; both
 * empty strings match, so sessions with no open task still aggregate every
 * unscoped record). Records started under an
 * earlier task id cannot pre-satisfy the next task fresh contract quotas;
 * running siblings kept by loopBlockResetKeys remain the concurrency guard.
 */
export function startedRolesFromRegistry(state, aliases = null) {
  const registry = (state?.agents && typeof state.agents === 'object' && !Array.isArray(state.agents))
    ? state.agents : {};
  const strict = isAliasesLoaded(aliases);
  const taskScope = state?.task_id ?? '';
  const roles = new Set();
  for (const record of Object.values(registry)) {
    const role = (record && typeof record === 'object' ? record.role : null);
    if (typeof role !== 'string' || role === '') continue;
    if ((record?.taskId ?? '') !== taskScope) continue;
    if (isGenericType(role)) continue;
    if (strict && !isAgntHiveSpecialistRole(role, aliases)) continue;
    roles.add(role);
  }
  return [...roles].sort();
}

/** format_subagent_list: "@a, @b" or "none" for an empty list. */
export function formatSubagentList(items) {
  if (!Array.isArray(items) || items.length === 0) return 'none';
  return items.map((i) => `@${i}`).join(', ');
}

/** format_subagent_group: "@a/@b" for any-of groups. */
export function formatSubagentGroup(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items.map((i) => `@${i}`).join('/');
}
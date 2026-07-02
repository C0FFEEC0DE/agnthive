// util.mjs — generic helpers shared across hook modules. Node standard
// library only. Pure where possible; the env/path helpers read process.env
// and os.homedir() but perform no I/O.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** UTC timestamp in the same `date -u +%Y-%m-%dT%H:%M:%SZ` form as lib.sh. */
export function timestampUtc(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/**
 * Resolve the per-plugin data root. The runtime sets CLAUDE_PLUGIN_DATA; if it
 * is absent (e.g. running the dispatcher directly outside Claude Code), fall
 * back to ~/.claude/plugins/data/<plugin-id> so state is still isolated.
 */
export function resolveDataRoot(env = process.env, home = homedir()) {
  const explicit = env.CLAUDE_PLUGIN_DATA;
  if (explicit && typeof explicit === 'string') return explicit;
  return join(home, '.claude', 'plugins', 'data', 'agent-hive');
}

/**
 * Resolve the plugin root (for reading bundled assets like aliases.json). The
 * runtime sets CLAUDE_PLUGIN_ROOT; fall back to this module's directory so the
 * dispatcher works when invoked directly.
 */
export function resolvePluginRoot(env = process.env) {
  const explicit = env.CLAUDE_PLUGIN_ROOT;
  if (explicit && typeof explicit === 'string') return explicit;
  return join(homedir(), '.claude', 'plugins', 'agent-hive');
}

/**
 * Resolve a session id for state addressing. Empty/missing ids fall back to
 * "no-session" (mirroring lib.sh safe_session_id), so a hook never crashes on
 * an absent session_id. safeSessionId in state.mjs sanitizes the result.
 */
export function resolveSessionId(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId.trim() : '';
  return raw || 'no-session';
}

/** True if a value is a non-empty string. */
export function isNonEmpty(s) {
  return typeof s === 'string' && s.length > 0;
}

/**
 * Resolve the per-plugin log directory for telemetry JSONL streams
 * (notification, session-index, compact markers, config-change, instructions-
 * loaded). Lives under the plugin data root so the runtime never writes outside
 * ${CLAUDE_PLUGIN_DATA} / project-provided paths.
 */
export function resolveLogRoot(env = process.env, home = homedir()) {
  return join(resolveDataRoot(env, home), 'logs');
}

/**
 * Resolve the project directory the hook is running in. The runtime sets
 * CLAUDE_PROJECT_DIR; fall back to the cwd the hook was invoked with. Used for
 * project-relative paths like the progress ledger.
 */
export function resolveProjectDir(env = process.env, cwd = '') {
  const explicit = env.CLAUDE_PROJECT_DIR;
  if (explicit && typeof explicit === 'string') return explicit;
  return cwd || process.cwd();
}
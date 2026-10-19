// plugin-config.mjs — plugin configuration resolution (the userConfig bridge).
//
// The config-read helper pattern used by command-policy.mjs resolveMode: a
// pure env reader with a documented precedence and a validated enum. No
// filesystem, no child_process, no side effects — the caller prints any
// diagnostic via reportWorkflowProfileNote.
//
// workflow_profile (plan task 11) is the SDLC workflow selector: 'legacy'
// keeps the full specialist-handoff / Manager-idle / footer gate shape, 'lean'
// is the experimental root-orchestration profile (ADR 0008/0009/0012). It is a
// separate knob from the advisory/enforce command policy (plan 11.1) and gates
// workflow shape only — it never decides a permission output or changes a
// failure class (ADR 0011).
//
// Precedence (highest first):
//   1. AGNTHIVE_WORKFLOW_PROFILE             (env override)
//   2. CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE (bridge env var exported by
//      Claude Code from the workflow_profile userConfig key, same pattern as
//      CLAUDE_PLUGIN_OPTION_ENFORCEMENT_MODE)
//   3. default 'legacy'
//
// Validation: a value is trimmed and lowercased and must be exactly 'legacy'
// or 'lean'. An UNSET or EMPTY value falls through to the next source; a
// non-empty invalid value resolves to 'legacy' with a stderr diagnostic in
// `note` (it does not silently fall through to the userConfig value underneath
// — the caller set an explicit override that is not one of the enum values).

/** Valid workflow profile values (plan task 11.1). The default is 'legacy'
 *  until the ADR 0012 rollout gate passes (task 16); lean is experimental. */
export const WORKFLOW_PROFILES = Object.freeze(['legacy', 'lean']);

export const DEFAULT_WORKFLOW_PROFILE = 'legacy';

/**
 * Resolve the workflow profile. Returns
 * { profile, source, raw, valid, note }:
 *   profile — 'legacy' | 'lean' (a non-empty invalid value resolves to legacy)
 *   source  — 'env' | 'userConfig:workflow_profile' | 'default'
 *   raw     — the raw env string that produced the decision ('' when defaulted)
 *   valid   — false only when an override value was present but invalid
 *   note    — '' or the stderr diagnostic the wiring site prints
 * Pure; no I/O.
 */
export function resolveWorkflowProfile(env = process.env) {
  const sources = [
    ['AGNTHIVE_WORKFLOW_PROFILE', 'env'],
    ['CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE', 'userConfig:workflow_profile'],
  ];
  for (const [key, source] of sources) {
    const raw = env?.[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const shown = raw.trim();
    const value = shown.toLowerCase();
    if (value === 'legacy' || value === 'lean') {
      return { profile: value, source, raw: shown, valid: true, note: '' };
    }
    return {
      profile: 'legacy',
      source,
      raw: shown,
      valid: false,
      note: `plugin-config: invalid ${key}="${shown}" — expected ${WORKFLOW_PROFILES.join('|')}; falling back to 'legacy'\n`,
    };
  }
  return { profile: 'legacy', source: 'default', raw: '', valid: true, note: '' };
}

/**
 * Print an invalid-workflow-profile diagnostic to stderr (ADR 0011: advisory
 * degradation is reported, never silent). Nonblocking: a write failure is
 * swallowed. Returns true when a note was written. `write` is injectable for
 * tests; the wiring sites call this with the default writer once after
 * resolveWorkflowProfile.
 */
export function reportWorkflowProfileNote(result, write = (line) => process.stderr.write(line)) {
  if (!result || typeof result.note !== 'string' || result.note === '') return false;
  try {
    write(result.note);
    return true;
  } catch {
    return false;
  }
}
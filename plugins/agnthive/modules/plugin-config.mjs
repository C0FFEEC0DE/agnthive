// plugin-config.mjs — plugin configuration resolution (the userConfig bridge).
//
// The config-read helper pattern used by command-policy.mjs resolveMode: a
// pure env reader with a documented precedence and a validated enum. No
// filesystem, no child_process, no side effects — the caller prints any
// diagnostic via reportWorkflowProfileNote.
//
// workflow_profile (plan task 11) was the SDLC workflow selector: 'legacy'
// kept the full specialist-handoff / Manager-idle / footer gate shape, 'lean'
// was the root-orchestration profile (ADR 0008/0009/0012). Plan task 16
// removed the 'legacy' profile after the compatibility window: the
// root-orchestration shape is the only shape, so the selector now resolves to
// one value and the key survives only so an old userConfig does not break.
//
// Precedence (highest first):
//   1. AGNTHIVE_WORKFLOW_PROFILE             (env override)
//   2. CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE (bridge env var exported by
//      Claude Code from the workflow_profile userConfig key, same pattern as
//      CLAUDE_PLUGIN_OPTION_ENFORCEMENT_MODE)
//   3. default 'lean'
//
// Validation: a value is trimmed and lowercased. 'lean' is the only profile.
// 'legacy' is an EXPLICIT MIGRATION: the profile was removed in 0.5.0, the
// session runs the root-orchestration profile, and the caller prints the
// migration note (never a silent switch). Any other value is invalid and
// resolves to the only profile with a stderr note.

/** Valid workflow profile values. Plan task 16 removed 'legacy'. */
export const WORKFLOW_PROFILES = Object.freeze(['lean']);

export const DEFAULT_WORKFLOW_PROFILE = 'lean';

/** The profile that plan task 16 removed, kept as a named constant so the
 *  migration note can name it exactly. */
export const REMOVED_WORKFLOW_PROFILE = 'legacy';

/**
 * Resolve the workflow profile. Returns
 * { profile, source, raw, valid, note }:
 *   profile — 'lean' (the only profile)
 *   source  — 'env' | 'userConfig:workflow_profile' | 'default'
 *   raw     — the raw env string that produced the decision ('' when defaulted)
 *   valid   — false when an override named a profile that does not exist
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
    if (value === DEFAULT_WORKFLOW_PROFILE) {
      return { profile: DEFAULT_WORKFLOW_PROFILE, source, raw: shown, valid: true, note: '' };
    }
    if (value === REMOVED_WORKFLOW_PROFILE) {
      // Explicit migration, not a silent switch: the removed profile is named
      // in the note the caller prints.
      return {
        profile: DEFAULT_WORKFLOW_PROFILE,
        source,
        raw: shown,
        valid: false,
        note: `plugin-config: ${key}="${shown}" — the '${REMOVED_WORKFLOW_PROFILE}' workflow profile was REMOVED in 0.5.0 (plan task 16); this session runs the '${DEFAULT_WORKFLOW_PROFILE}' root-orchestration profile\n`,
      };
    }
    return {
      profile: DEFAULT_WORKFLOW_PROFILE,
      source,
      raw: shown,
      valid: false,
      note: `plugin-config: invalid ${key}="${shown}" — expected ${WORKFLOW_PROFILES.join('|')}; running the '${DEFAULT_WORKFLOW_PROFILE}' root-orchestration profile\n`,
    };
  }
  return { profile: DEFAULT_WORKFLOW_PROFILE, source: 'default', raw: '', valid: true, note: '' };
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
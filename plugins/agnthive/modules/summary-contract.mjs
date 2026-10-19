// summary-contract.mjs — footer parsing, completion gates, block checklists,
// and the stop/subagent-stop/task-completed/teammate-idle decision reasons.
// Ported from lib.sh: stop_safe_no_change_footer_hint, checklist_status_line,
// message_has_line_prefix, message_has_any_line_prefix, message_mentions_*,
// message_reports_no_changes, block_checklist_*, build_block_checklist,
// session_block_reason, session_agent_enforcement_reason,
// session_manager_idle_reason, is_docs_path. Pure module: operates on a state
// object and message string; the dispatcher supplies transcript-derived inputs.
import { taskTypeRequiresImplementationSummary } from './workflow.mjs';
import { recordLoopBlock, loopBlockFields } from './workflow.mjs';
import { formatSubagentList, formatSubagentGroup } from './agents.mjs';
import { currentRevision } from './verification.mjs';

// --- footer hint ----------------------------------------------------------

export function stopSafeNoChangeFooterHint(docsRequired) {
  return docsRequired
    ? ' If this reply did not introduce additional changes, still report the actual verification, review, changed files, docs status, and remaining risks instead of using a no-change shortcut after code or config changes.'
    : ' If this reply did not introduce additional changes, still report the actual verification, review, changed files, and remaining risks instead of using a no-change shortcut after code or config changes.';
}

// --- checklist line -------------------------------------------------------

export function checklistStatusLine(status, label, detail) {
  let s = `- [${status}] ${label}`;
  if (detail) s += ` ${detail}`;
  return `${s}\n`;
}

// --- line-prefix matching -------------------------------------------------

/** True if any line of `message` starts with `prefix` (case-insensitive, leading whitespace trimmed). */
export function messageHasLinePrefix(message, prefix) {
  if (typeof message !== 'string' || typeof prefix !== 'string') return false;
  const lp = prefix.toLowerCase();
  for (const raw of message.split('\n')) {
    const line = raw.replace(/^\s+/, '').toLowerCase();
    if (line.startsWith(lp)) return true;
  }
  return false;
}

/** True if any line starts with any of the given prefixes (first match wins). */
export function messageHasAnyLinePrefix(message, ...prefixes) {
  for (const p of prefixes) {
    if (messageHasLinePrefix(message, p)) return true;
  }
  return false;
}

export function messageMentionsVerificationStatus(m) {
  return messageHasAnyLinePrefix(m, 'Verification status:', 'Verification:', 'Verification result:', 'Test status:', 'Tests:');
}
export function messageMentionsReviewOutcome(m) {
  return messageHasAnyLinePrefix(m, 'Review outcome:', 'Review status:', 'Review:');
}
export function messageMentionsDocsStatus(m) {
  return messageHasAnyLinePrefix(m, 'Docs status:', 'Documentation:', 'Docs:', 'Документация:');
}
export function messageMentionsChangedFiles(m) {
  return messageHasAnyLinePrefix(m, 'Changed files:', 'Key files changed:', 'Files changed:', 'Updated files:', 'Modified files:', 'No files changed:');
}
export function messageMentionsRemainingRisks(m) {
  return messageHasAnyLinePrefix(m, 'Remaining risks:', 'Residual risks:', 'Risks:');
}
export function messageMentionsNextStep(m) {
  return messageHasAnyLinePrefix(m, 'Next step:', 'Next steps:', 'Follow-up:', 'Follow up:', 'Pending next:', 'Следующий шаг:', 'Следующие шаги:', 'Дальше:', 'Следующее:');
}

const OUTCOME_PREFIXES = ['Outcome:', 'Result:', 'Fix:', 'Implemented:', 'Updated:', 'Completed:', 'Done:', 'No files changed:', 'No changes:', 'Status:'];
const OUTCOME_KEYWORDS = /(outcome|result|implemented|updated|fixed|investigated|reviewed|documented|added|removed|refactored|changed|created|no changes|completed|done|исправил|обновил|добавил|удалил|проверил|нашел|сделал|без изменений)/iu;

export function messageMentionsConcreteOutcome(m) {
  if (messageHasAnyLinePrefix(m, ...OUTCOME_PREFIXES)) return true;
  return OUTCOME_KEYWORDS.test(m);
}

export function messageReportsNoChanges(m) {
  return messageHasLinePrefix(m, 'No changes were made.')
    || messageHasLinePrefix(m, 'No files changed.')
    || messageHasLinePrefix(m, 'Nothing changed.');
}

// --- docs path classification --------------------------------------------

export function isDocsPath(filePath) {
  if (typeof filePath !== 'string') return false;
  if (/\.(md|mdx|txt|rst|adoc|markdown)$/i.test(filePath)) return true;
  if (/\/docs\//i.test(filePath)) return true;
  if (/(^|\/)(README|CHANGELOG|CLAUDE\.md)/i.test(filePath)) return true;
  return false;
}

// --- block checklists -----------------------------------------------------

export function blockChecklistSummaryRequirements(prefix, message, state) {
  const codeChanged = state?.code_changed === true;
  const taskType = state?.task_type ?? 'other';
  const docsRequired = state?.docs_required === true;
  let out = '### Requirement Checklist\n\n';

  if (prefix === 'stop') {
    if (!codeChanged || !taskTypeRequiresImplementationSummary(taskType)) {
      out += checklistStatusLine('SKIP', 'Implementation summary lines', 'Not required for this stop event.');
      return out;
    }
    const verificationOk = messageMentionsVerificationStatus(message) ? 'PASS' : 'FAIL';
    const reviewOk = messageMentionsReviewOutcome(message) ? 'PASS' : 'FAIL';
    const filesOk = messageMentionsChangedFiles(message) ? 'PASS' : 'FAIL';
    const risksOk = messageMentionsRemainingRisks(message) ? 'PASS' : 'FAIL';
    out += checklistStatusLine(verificationOk, 'Verification status line', 'Accepted prefixes: `Verification status:`, `Verification:`, `Verification result:`, `Test status:`, `Tests:`.');
    out += checklistStatusLine(reviewOk, 'Review outcome line', 'Accepted prefixes: `Review outcome:`, `Review status:`, `Review:`.');
    out += checklistStatusLine(filesOk, 'Changed files line', 'Accepted prefixes: `Changed files:`, `Key files changed:`, `Files changed:`, `Updated files:`, `Modified files:`, `No files changed:`.');
    out += checklistStatusLine(risksOk, 'Remaining risks line', 'Accepted prefixes: `Remaining risks:`, `Residual risks:`, `Risks:`.');
    if (docsRequired) {
      const docsOk = messageMentionsDocsStatus(message) ? 'PASS' : 'FAIL';
      out += checklistStatusLine(docsOk, 'Docs status line', 'Accepted prefixes: `Docs status:`, `Documentation:`, `Docs:`, `Документация:`.');
    }
    if (messageReportsNoChanges(message)) {
      out += checklistStatusLine('FAIL', 'No-change shortcut', 'Do not use `No changes were made.` after code/config changes.');
    } else {
      out += checklistStatusLine('PASS', 'No-change shortcut', 'No forbidden no-change shortcut detected.');
    }
    return out;
  }

  // subagent_stop
  const outcomeOk = messageMentionsConcreteOutcome(message) ? 'PASS' : 'FAIL';
  const filesOk = messageMentionsChangedFiles(message) ? 'PASS' : 'FAIL';
  const verificationOk = messageMentionsVerificationStatus(message) ? 'PASS' : 'FAIL';
  const risksOk = messageMentionsRemainingRisks(message) ? 'PASS' : 'FAIL';
  const nextOk = messageMentionsNextStep(message) ? 'PASS' : 'FAIL';
  out += checklistStatusLine(outcomeOk, 'Concrete outcome', 'Example prefixes/content: `Outcome:`, `Result:`, or a concrete action like `fixed`, `updated`, `implemented`.');
  out += checklistStatusLine(filesOk, 'Changed files line', 'Accepted prefixes: `Changed files:`, `Files changed:`, `Updated files:`, `Modified files:`, `No files changed:`.');
  out += checklistStatusLine(verificationOk, 'Verification status line', 'Accepted prefixes: `Verification status:`, `Verification:`, `Verification result:`, `Test status:`, `Tests:`.');
  out += checklistStatusLine((risksOk === 'PASS' || nextOk === 'PASS') ? 'PASS' : 'FAIL', 'Closure line', 'Need either `Remaining risks:` or `Next step:`.');
  return out;
}

export function blockChecklistGateRequirements(prefix, state) {
  if (prefix !== 'stop') return '';
  const codeChanged = state?.code_changed === true;
  const taskType = state?.task_type ?? 'other';
  let out = '\n### Workflow Gates\n\n';
  if (codeChanged) {
    const vReason = sessionBlockReason(state);
    if (vReason) out += checklistStatusLine('FAIL', 'Verification gate', vReason);
    else out += checklistStatusLine('PASS', 'Verification gate', 'No failing or missing required verification commands detected.');
  } else {
    out += checklistStatusLine('SKIP', 'Verification gate', 'No code/config changes recorded.');
  }
  if (taskTypeRequiresImplementationSummary(taskType)) {
    const hReason = sessionAgentEnforcementReason(state); // startedRoles absent -> uses state.subagents_started
    if (hReason) out += checklistStatusLine('FAIL', 'Required specialist handoffs', hReason);
    else out += checklistStatusLine('PASS', 'Required specialist handoffs', 'All required roles for this workflow are satisfied.');
  } else {
    out += checklistStatusLine('SKIP', 'Required specialist handoffs', 'No workflow-specific handoff requirement for this task type.');
  }
  return out;
}

export function blockChecklistFixTemplate(prefix) {
  if (prefix === 'stop') {
    return '\n### Minimal Valid Template\n\n```text\nVerification status: passed|failed|not run - <what you ran or why not>\nReview outcome: done|pending - <what review happened or why pending>\nChanged files: <path1>, <path2> | No files changed: <reason>\nRemaining risks: none | <specific risk>\nDocs status: updated|not needed - <what docs changed or why not>\n```\n';
  }
  return '\n### Minimal Valid Template\n\n```text\nOutcome: <concrete result>\nChanged files: <path1>, <path2> | No files changed: <reason>\nVerification status: passed|failed|not run - <command or reason>\nRemaining risks: none | <specific risk>\n```\nIf risks are not known yet, replace the last line with:\n```text\nNext step: <single concrete next action>\n```\n';
}

export function buildBlockChecklist(prefix, finalReason, message, state) {
  let out = '### Block Reason\n\n';
  out += `- **Reason:** ${finalReason}\n\n`;
  out += blockChecklistSummaryRequirements(prefix, message, state);
  out += blockChecklistGateRequirements(prefix, state);
  out += blockChecklistFixTemplate(prefix);
  out += '\n### Your Current Response\n\n```text\n' + message + '\n```\n';
  out += '\n---\n';
  out += `**Decision:** block\n`;
  out += `**Reason:** ${finalReason}\n`;
  return out;
}

// --- session reasons ------------------------------------------------------

// ADR-0009 (plan task 04): revision-aware verification evidence. A recorded
// 'passed' result certifies the current tree only when it completed at the
// then-current revision, no tracked edit lands between its start and its
// completion (startedRevision === completedRevision), the record is still
// current at gate time, and, when both sides carry a cwd, it ran in the
// tracked cwd/worktree (results from another worktree do not certify the
// integrated diff). Records are the authoritative evidence whenever
// state.verification is non-empty: honoring the legacy *_ok flags of a
// record-bearing session would let a flag set by a pre-bump run outlive the
// revision it verified (ADR-0009 — new code never passes on old tests_ok;
// edit-during-test does not close the gate).
export function successfulVerification(state) {
  const records = Array.isArray(state?.verification) ? state.verification : [];
  if (records.length > 0) return recordBasedVerification(state, records);
  // Legacy fallback (state without records — old sessions and the record-less
  // legacy fixtures): exact pre-ADR-0009 flag contract, unchanged.
  return legacySuccessfulVerification(state);
}

function legacySuccessfulVerification(state) {
  if (state?.tests_ok === true) return true;
  if (!state?.detected_test_command && (state?.lint_ok === true || state?.build_ok === true)) return true;
  return false;
}

function recordBasedVerification(state, records) {
  const current = currentRevision(state);
  // cwd binding only when the state carries a cwd: a synthetic gate state
  // without one keeps deciding on revisions alone. A record with a different
  // cwd never certifies this session's tree (plan 04: worktrees are not mixed).
  const cwdBound = typeof state?.cwd === 'string' && state.cwd !== ''
    ? (r) => r.cwd === state.cwd
    : () => true;
  const currentPass = (kind) => records.some((r) => {
    if (!r || typeof r !== 'object') return false;
    return r.kind === kind
      && r.status === 'passed'
      && Number.isFinite(r.startedRevision)
      && Number.isFinite(r.completedRevision)
      && r.startedRevision === r.completedRevision
      && r.completedRevision === current
      && cwdBound(r);
  });
  if (currentPass('test')) return true;
  if (!state?.detected_test_command && (currentPass('lint') || currentPass('build'))) return true;
  return false;
}

export function sessionBlockReason(state) {
  const codeChanged = state?.code_changed === true;
  const testsFailed = state?.tests_failed === true;
  const lintFailed = state?.lint_failed === true;
  const buildFailed = state?.build_failed === true;
  const detectedTest = state?.detected_test_command ?? '';
  const detectedLint = state?.detected_lint_command ?? '';
  const detectedBuild = state?.detected_build_command ?? '';
  const lastTest = state?.last_test_command ?? '';
  const lastLint = state?.last_lint_command ?? '';
  const lastBuild = state?.last_build_command ?? '';

  const hasDetectedVerification = Boolean(detectedTest || detectedLint || detectedBuild);
  // ADR-0009 (plan task 04): the gate reads the revision-aware evidence model
  // whenever state.verification carries records — a background launch (F01),
  // a failed/unknown run, or a pass from an earlier revision or a different
  // worktree never satisfies it. Pending records NEVER satisfy the gate: only
  // completion, not launch, is evidence. Without records the gate falls back
  // to the unchanged legacy `*_ok` flags (old sessions, record-less fixtures).
  // "No detected command and no records" keeps today's shape: the chain returns
  // null (no manufactured pass, no manufactured block); the lean explicit-gap
  // note is deferred to plan task 11, not added here.
  const hasBehaviorVerification = successfulVerification(state);

  if (codeChanged && testsFailed) {
    return `Code or config changed, but the latest test command failed in this session (${lastTest || 'test command'}). Fix the failure and rerun verification before stopping.`;
  }
  if (codeChanged && lintFailed) {
    return `Code or config changed, but the latest lint/static-check command failed in this session (${lastLint || 'lint command'}). Fix the failure and rerun it successfully before stopping.`;
  }
  if (codeChanged && buildFailed) {
    return `Code or config changed, but the latest build command failed in this session (${lastBuild || 'build command'}). Fix the failure and rerun it successfully before stopping.`;
  }
  if (codeChanged && hasDetectedVerification && !hasBehaviorVerification) {
    if (detectedTest) {
      return `Code or config changed, and this repo has a detected test command (${detectedTest}), but no successful test command was recorded in this session. Run the detected tests before stopping.`;
    }
    return `Code or config changed, but no successful verification command was recorded in this session. Run a detected lint or build command before stopping.`;
  }
  return null;
}

/**
 * session_agent_enforcement_reason. `startedRoles` is the effective started
 * roles list (explicit + transcript-inferred, generic types filtered). If
 * omitted, falls back to state.subagents_started (used by the checklist view).
 */
export function sessionAgentEnforcementReason(state, startedRoles = null) {
  const taskType = state?.task_type ?? 'other';
  const managerMode = state?.manager_mode ?? 'none';
  const started = Array.isArray(startedRoles) ? startedRoles
    : (Array.isArray(state?.subagents_started) ? state.subagents_started : []);
  const required = Array.isArray(state?.required_subagents) ? state.required_subagents : [];
  const anyOfGroups = Array.isArray(state?.required_subagent_any_of) ? state.required_subagent_any_of : [];

  const missingGroups = [];
  for (const group of anyOfGroups) {
    if (!Array.isArray(group) || group.length === 0) continue;
    const satisfied = group.some((alias) => started.includes(alias));
    if (!satisfied) missingGroups.push(formatSubagentGroup(group));
  }

  if (required.length === 0 && missingGroups.length === 0) return null;

  const succVer = successfulVerification(state);
  const missing = [];
  for (const alias of required) {
    if (alias === 't' && succVer) continue;
    if (!started.includes(alias)) missing.push(alias);
  }

  if (missing.length === 0 && missingGroups.length === 0) return null;

  let msg = `Agent-enforced workflow requires specific subagent handoffs before completion for ${taskType} work.`;
  if (managerMode === 'orchestrate') msg += ' Manager-led orchestration is active.';
  if (missing.length > 0) msg += ` Missing required roles: ${formatSubagentList(missing)}.`;
  if (missingGroups.length > 0) msg += ` Missing one-of groups: ${missingGroups.join(', ')}.`;
  msg += ` Used so far: ${formatSubagentList(started)}.`;
  return msg;
}

export function sessionManagerIdleReason(state, startedRoles = null) {
  const taskType = state?.task_type ?? 'other';
  const managerMode = state?.manager_mode ?? 'none';
  if (!taskTypeRequiresImplementationSummary(taskType)) return null;
  if (managerMode !== 'orchestrate') return null;
  const started = Array.isArray(startedRoles) ? startedRoles
    : (Array.isArray(state?.subagents_started) ? state.subagents_started : []);
  const specialistCount = started.filter((r) => r && r !== 'm').length;
  if (specialistCount === 0) {
    return 'Manager-led orchestration has not handed off to any specialist yet. Start the first required specialist handoff before going idle.';
  }
  return null;
}

// --- loop-aware block (output + state patch) ------------------------------

/**
 * emit_loop_aware_block: record the loop block, build the checklist, and
 * return the hook output plus the state patch to persist. On the 3rd repeated
 * block with the same reason+message (per agent for the `subagent_stop` prefix,
 * session-global for the `stop` prefix), switch to a terminal continue:false
 * (hardStop) and mark stalled_by_policy for the stop prefix only.
 */
export function emitLoopAwareBlock(state, prefix, reason, message, agentId = null) {
  const fields = loopBlockFields(prefix);
  const result = recordLoopBlock(state, prefix, reason, message, agentId);
  let count = 0;
  // ADR 0005: recordLoopBlock returns the per-key entry explicitly for a
  // per-agent prefix — `{ mapKey, key, entry }` — which we thread straight into
  // `perKey` for the dispatcher to emit as a single-key map_set. No full-map
  // patch is produced on this path, so `patch` is null. For a session-global
  // prefix, `result` is the scalar patch and `perKey` stays null.
  let perKey = null;
  let fullPatch = null;
  if (fields?.perAgent) {
    perKey = result;
    count = Number(perKey?.entry?.count) || 0;
  } else if (fields) {
    count = result[fields.countKey];
    // recordLoopBlock's scalar branch returns a fresh object literal with no
    // shared reference, so we can hold it directly and mutate the two
    // policy-stall fields below in place — no defensive copy needed.
    fullPatch = result;
  }
  const hardStop = count >= 3;
  let finalReason = reason;
  if (hardStop) {
    finalReason = `Repeated stop-block loop detected (${count}x): ${reason} Do not retry the same final response again; change the summary or perform the required action first.`;
  }
  if (prefix === 'stop') {
    fullPatch.stalled_by_policy = hardStop;
    fullPatch.policy_stall_reason = hardStop ? finalReason : '';
  }
  const checklist = buildBlockChecklist(prefix, finalReason, message, state);
  const output = hardStop
    ? { continue: false, stopReason: finalReason, errorDetails: checklist, hardStop: true }
    : { decision: 'block', reason: finalReason, errorDetails: checklist, hardStop: false };
  return { patch: fullPatch, output, hardStop, finalReason, perKey };
}

/** Sentinel: exit with a non-zero code and a stderr message (TaskCompleted / TeammateIdle). */
export function exitBlock(stderr) {
  return { __exit: 2, stderr };
}
#!/usr/bin/env node
// hook-dispatcher.mjs — single entry point for every hook event.
//
// Reads stdin as a Buffer, parses one JSON object, routes to a pure event
// handler, writes exactly one JSON object to stdout, and sends diagnostics
// only to stderr. Node standard library only: no child_process.exec, no
// shell:true, no interpolated command strings.
//
// Phase 1 ships the I/O contract and routing only. Event handlers return a
// neutral passthrough until Phase 2 ports the real workflow/policy/summary
// behavior, so the installed plugin is inert but safe.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseHookInput, readStdin } from './hook-input.mjs';
import { additionalContext, passthrough, serialize, terminalCancel, pretoolPermission, permissionRequestDeny, permissionDeniedResult } from './hook-output.mjs';
import { resolveDataRoot, resolveSessionId, resolveLogRoot, resolveProjectDir } from './util.mjs';
import { statePaths, appendEvent, loadState } from './state.mjs';
import {
  classifyPrompt, userPromptResetPatch, sessionBackgroundManagerPending,
  clearLoopBlockPatch, taskTypeRequiresImplementationSummary,
} from './workflow.mjs';
import { commandClass, verificationOutcome, detectTestCmd, detectLintCmd, detectBuildCmd } from './verification.mjs';
import {
  extractSubagentLabel, extractSubagentScope, loadAliases, effectiveStartedRoles,
} from './agents.mjs';
import {
  resolvedLastAssistantMessage, transcriptIndicatesBackgroundedAgent,
} from './transcripts.mjs';
import {
  sessionBlockReason, sessionAgentEnforcementReason, sessionManagerIdleReason,
  emitLoopAwareBlock, isDocsPath, messageReportsNoChanges,
  messageMentionsVerificationStatus, messageMentionsReviewOutcome,
  messageMentionsChangedFiles, messageMentionsRemainingRisks,
  messageMentionsDocsStatus, messageMentionsConcreteOutcome, messageMentionsNextStep,
  stopSafeNoChangeFooterHint, exitBlock,
} from './summary-contract.mjs';
import {
  appendJsonl, resolveLogMaxBytes, notificationPayload, instructionsLoadedPayload,
  preCompactPayload, postCompactPayload, configChangePayload, sessionEndPayload,
} from './notifications.mjs';
import {
  progressLedgerPath, readLedgerForInjection, buildPostCompactContext,
  resolveLedgerMaxBytes,
} from './ledger.mjs';
import {
  classifyCommand, resolveMode as resolvePolicyMode, permissionDeniedOutcome,
  pretoolErrorDetails, permRequestErrorDetails, permRequestMessage,
} from './command-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(here, '..');
const ALIASES = loadAliases(pluginRoot);

// UserPromptSubmit: classify the prompt, persist the task type / manager mode /
// required roles / docs flag plus the stop-loop reset to session state, and
// emit the workflow context message (if any) as additionalContext. Mirrors
// claudecfg/hooks/user-prompt-submit.sh.
function handleUserPromptSubmit(parsed) {
  const prompt = parsed.data?.prompt ?? '';
  const cls = classifyPrompt(prompt);
  const fields = {
    session_id: parsed.sessionId ?? '',
    cwd: parsed.cwd ?? '',
    transcript_path: parsed.transcriptPath ?? '',
    task_type: cls.taskType,
    manager_mode: cls.managerMode,
    docs_required: cls.docsRequired,
    required_subagents: cls.requiredSubagents,
    required_subagent_any_of: cls.requiredSubagentAnyOf,
    dispatch_contract_mode: cls.dispatchContractMode,
    ...userPromptResetPatch(),
  };
  persistPatch(parsed, fields);
  if (cls.contextMessage) return additionalContext(cls.contextMessage, 'UserPromptSubmit');
  return passthrough();
}

// PreToolUse: classify the Bash command against the portable command policy
// and emit an allow/deny permission decision. Mirrors pre-tool-use.sh, extended
// to PowerShell/CMD and the advisory/enforce mode split. For the EditWrite
// matcher, enforce the benchmark dispatch contract: when a task is in
// 'enforced' dispatch mode (stashed at UserPromptSubmit from the
// BENCHMARK_DISPATCH_CONTRACT marker), block root edits until at least one
// required specialist has started (recorded in subagents_started by
// SubagentStart). Non-bench sessions never set the mode, so the guard is inert;
// observed/standard modes pass through. Other (non-Bash, non-EditWrite) tools
// pass through.
const RE_EDIT_WRITE_TOOL = /^(Edit|MultiEdit|Write|NotebookEdit)$/;

function handlePreToolUse(parsed) {
  const matcher = parsed.matcher;
  const isBash = matcher === 'Bash' || (!matcher && parsed.toolName === 'Bash');
  const isEditWrite = matcher === 'EditWrite'
    || (!matcher && RE_EDIT_WRITE_TOOL.test(parsed.toolName || ''));
  if (isEditWrite) return enforceDispatchContract(parsed);
  if (!isBash) return passthrough();
  const command = parsed.toolInput?.command ?? '';
  const cls = classifyCommand(command, resolvePolicyMode());
  if (cls.decision === 'deny') {
    return pretoolPermission('deny', cls.reason, pretoolErrorDetails('deny', cls.reason));
  }
  return pretoolPermission('allow', cls.reason, pretoolErrorDetails('allow', cls.reason));
}

// Dispatch-contract hard guard for Edit/Write/MultiEdit/NotebookEdit. In
// 'enforced' mode, deny the edit until a required specialist role has started,
// forcing the root agent to dispatch via the Agent tool before touching code.
// Once a required role is in subagents_started (set by SubagentStart), edits
// flow — including the specialist subagent's own edits. Inert for every other
// mode so normal sessions and observed/standard canaries are unaffected.
function enforceDispatchContract(parsed) {
  const state = loadStateFor(parsed);
  if (!state) return passthrough();
  if (state.dispatch_contract_mode !== 'enforced') return passthrough();
  const required = Array.isArray(state.required_subagents) ? state.required_subagents : [];
  if (!required.length) return passthrough();
  const started = new Set(Array.isArray(state.subagents_started) ? state.subagents_started : []);
  const satisfied = required.some((role) => started.has(role));
  if (satisfied) return passthrough();
  const roles = required.map((r) => `@${r}`).join(', ');
  const reason =
    `Dispatch contract enforced: this task requires a real specialist handoff before any code edit. ` +
    `Launch the required specialist (${roles}) via the Agent tool first. ` +
    `Do not Edit, Write, or MultiEdit any file yourself until ${roles} has started (SubagentStart). ` +
    `After the specialist starts, edits are allowed.`;
  return pretoolPermission('deny', reason, pretoolErrorDetails('deny', reason));
}

// PermissionRequest: deny known-dangerous commands with a decision object; allow
// everything else via passthrough so the normal permission flow proceeds.
// Mirrors permission-request.sh.
function handlePermissionRequest(parsed) {
  const command = parsed.toolInput?.command ?? '';
  const cls = classifyCommand(command, resolvePolicyMode());
  if (cls.decision !== 'deny') return passthrough();
  const message = permRequestMessage(cls);
  return permissionRequestDeny(message, permRequestErrorDetails(message));
}

// PermissionDenied: decide whether the agent may retry. Hard-denied commands
// and benchmark CI context never retry; otherwise retry. Mirrors
// permission-denied.sh.
function handlePermissionDenied(parsed) {
  const command = parsed.toolInput?.command ?? '';
  return permissionDeniedResult(permissionDeniedOutcome(command).retry);
}

// PostToolUse: the active matcher is passed via --matcher (the runtime fires
// one registration per matcher; tool_name in stdin is a fallback). The Bash
// matcher records a successful test/lint/build outcome; the EditWrite matcher
// records file changes (post-edit-write.sh).
function handlePostToolUse(parsed) {
  const matcher = parsed.matcher;
  const isBash = matcher === 'Bash' || (!matcher && parsed.toolName === 'Bash');
  const isEditWrite = matcher === 'EditWrite'
    || (!matcher && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(parsed.toolName || ''));
  if (isBash) return handlePostToolUseBash(parsed);
  if (isEditWrite) return handlePostToolUseEditWrite(parsed);
  return passthrough();
}

// PostToolUse (Bash matcher): classify the command and record a successful
// test/lint/build outcome. Mirrors post-tool-use.sh.
function handlePostToolUseBash(parsed) {
  const command = parsed.toolInput?.command ?? '';
  const outcome = verificationOutcome(commandClass(command), command, { failed: false });
  if (!outcome) return passthrough();
  persistPatch(parsed, outcome.patch);
  return additionalContext(outcome.message, 'PostToolUse');
}

// PostToolUse (EditWrite matcher): record the file change. Docs paths set
// docs_changed (not code_changed); everything else sets code_changed. The
// code_changed / docs_changed flags are OR-ed with the existing value so a
// session that already recorded a code change keeps it. Mirrors
// post-edit-write.sh.
function handlePostToolUseEditWrite(parsed) {
  const ti = parsed.toolInput ?? {};
  const data = parsed.data ?? {};
  const filePath = ti.file_path ?? ti.path ?? ti.notebook_path ?? data.file_path ?? data.path ?? data.notebook_path ?? '';
  const docs = isDocsPath(filePath);
  const codeChanged = !docs;
  const docsChanged = docs;
  let state = null;
  try { state = loadState(statePathsFor(parsed)); } catch {}
  const files = Array.isArray(state?.files) ? state.files.slice() : [];
  if (filePath && !files.includes(filePath)) files.push(filePath);
  const patch = {
    edited: true,
    code_changed: (state?.code_changed === true) || codeChanged,
    docs_changed: (state?.docs_changed === true) || docsChanged,
    files,
  };
  persistPatch(parsed, patch);
  if (codeChanged) {
    return additionalContext('Recorded a code/config change in session state. This session now requires verification before completion.', 'PostToolUse');
  }
  return passthrough();
}

// PostToolUseFailure: record a failed test/lint/build outcome.
function handlePostToolUseFailure(parsed) {
  const isBash = parsed.matcher === 'Bash' || parsed.toolName === 'Bash';
  if (!isBash) return passthrough();
  const command = parsed.toolInput?.command ?? '';
  const error = parsed.data?.error ?? '';
  const outcome = verificationOutcome(commandClass(command), command, { failed: true, error });
  if (!outcome) return passthrough();
  persistPatch(parsed, outcome.patch);
  return additionalContext(outcome.message, 'PostToolUseFailure');
}

function persistPatch(parsed, patch) {
  const sid = resolveSessionId(parsed.sessionId);
  const paths = statePaths(resolveDataRoot(), sid);
  try { appendEvent(paths, 'set_many', { fields: patch }); } catch (e) {
    process.stderr.write(`hook-dispatcher: state write failed: ${e?.message ?? e}\n`);
  }
}

function statePathsFor(parsed) {
  return statePaths(resolveDataRoot(), resolveSessionId(parsed.sessionId));
}

// SubagentStart: record the handoff — increment the start counter, add the role
// to subagents_started, bump the per-role instance count, append the event log
// entry — and emit the handoff contract. Mirrors subagent-start.sh.
function handleSubagentStart(parsed) {
  const label = extractSubagentLabel(parsed.data, ALIASES);
  const scope = extractSubagentScope(parsed.data);
  const paths = statePathsFor(parsed);
  let index = 1;
  try { index = (loadState(paths).subagent_start_count || 0) + 1; } catch {}
  const events = [
    { type: 'increment', payload: { field: 'subagent_start_count', by: 1 } },
    { type: 'append', payload: { field: 'subagent_events', value: { index, role: label || '', ...(scope ? { purpose: scope } : {}) } } },
  ];
  if (label) {
    events.push({ type: 'append_unique', payload: { field: 'subagents_started', value: label } });
    events.push({ type: 'role_increment', payload: { mapField: 'subagent_instance_count_by_role', key: label, by: 1 } });
  }
  for (const ev of events) {
    try { appendEvent(paths, ev.type, ev.payload); } catch (e) {
      process.stderr.write(`hook-dispatcher: state write failed: ${e?.message ?? e}\n`);
    }
  }
  const message = label
    ? `Recorded subagent handoff: @${label}. Parallel same-role handoffs are allowed when they have distinct scopes. Return outcome, changed files or 'no changes', verification status, and remaining risks or next step. If you edit code, run or request verification before stopping.`
    : `Subagent handoff contract: return outcome, changed files or 'no changes', verification status, and remaining risks or next step. If you edit code, run or request verification before stopping.`;
  return additionalContext(message, 'SubagentStart');
}

// Read the full transcript text for role inference (Stop fires once at session
// end, so reading the whole file matches the bash grep-over-transcript model).
function readTranscriptText(path) {
  if (!path) return '';
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

// Load the session state for a parsed input, or null on error / no session.
function loadStateFor(parsed) {
  try { return loadState(statePathsFor(parsed)); } catch { return null; }
}

// Persist a loop-aware block: record the block + policy-stall patch, then emit
// the block/terminal output. Mirrors emit_loop_aware_block + the stop-guard
// call sites.
function emitBlock(parsed, state, prefix, reason, message) {
  const { patch, output } = emitLoopAwareBlock(state, prefix, reason, message);
  persistPatch(parsed, patch);
  return output;
}

// Stop: enforce the footer contract and completion gates. Mirrors
// stop-guard.sh. A previous terminal policy-stall is repeated verbatim so a
// runtime that re-enters Stop while processing the terminal response does not
// re-enter the normal blocking path.
function handleStop(parsed) {
  const state = loadStateFor(parsed);
  if (!state) return passthrough();
  if (state.stalled_by_policy === true) {
    const reason = state.policy_stall_reason || 'Stop hook policy stalled the session.';
    return terminalCancel(reason, { hardStop: true });
  }
  const transcriptPath = parsed.transcriptPath ?? state.transcript_path ?? '';
  const transcriptText = readTranscriptText(transcriptPath);
  const startedRoles = effectiveStartedRoles(state, transcriptText, ALIASES);
  const lastMessage = resolvedLastAssistantMessage(parsed.data ?? {}, transcriptPath);
  const docsRequired = state.docs_required === true;
  const hint = stopSafeNoChangeFooterHint(docsRequired);

  let reason = sessionBlockReason(state);
  if (reason) return emitBlock(parsed, state, 'stop', reason, lastMessage);

  if (sessionBackgroundManagerPending({
    taskType: state.task_type, managerMode: state.manager_mode,
    codeChanged: state.code_changed, backgroundedAgent: transcriptIndicatesBackgroundedAgent(transcriptPath),
    startedRoles,
  })) {
    persistPatch(parsed, clearLoopBlockPatch('stop'));
    return passthrough();
  }

  reason = sessionAgentEnforcementReason(state, startedRoles);
  if (reason) return emitBlock(parsed, state, 'stop', reason, lastMessage);

  if (state.code_changed === true) {
    if (!lastMessage) {
      return emitBlock(parsed, state, 'stop', `Code or config changed (${state.task_type || 'other'}), but no assistant summary message was found for this stop event.`, lastMessage);
    }
    if (messageReportsNoChanges(lastMessage)) {
      return emitBlock(parsed, state, 'stop', `Final response after code or config changes must describe the actual changes instead of saying no changes were made.${hint}`, lastMessage);
    }
  }

  if (state.code_changed === true && taskTypeRequiresImplementationSummary(state.task_type || 'other')) {
    if (!messageMentionsVerificationStatus(lastMessage)) {
      return emitBlock(parsed, state, 'stop', `Final response must include a Verification status: line after code or config changes.${hint}`, lastMessage);
    }
    if (!messageMentionsReviewOutcome(lastMessage)) {
      return emitBlock(parsed, state, 'stop', `Final response must include a Review outcome: line after code or config changes.${hint}`, lastMessage);
    }
    if (!messageMentionsChangedFiles(lastMessage)) {
      return emitBlock(parsed, state, 'stop', `Final response must include a Changed files: or No files changed: line after code or config changes.${hint}`, lastMessage);
    }
    if (!messageMentionsRemainingRisks(lastMessage)) {
      return emitBlock(parsed, state, 'stop', `Final response must include a Remaining risks: line after code or config changes.${hint}`, lastMessage);
    }
    if (docsRequired && !messageMentionsDocsStatus(lastMessage)) {
      return emitBlock(parsed, state, 'stop', `Final response must include a Docs status: line when behavior changes require documentation updates.${hint}`, lastMessage);
    }
  }

  persistPatch(parsed, clearLoopBlockPatch('stop'));
  return passthrough();
}

// SubagentStop: enforce the subagent handoff contract. Mirrors
// subagent-stop-guard.sh.
function handleSubagentStop(parsed) {
  const state = loadStateFor(parsed);
  if (!state) return passthrough();
  const transcriptPath = parsed.transcriptPath ?? state.transcript_path ?? '';
  const lastMessage = resolvedLastAssistantMessage(parsed.data ?? {}, transcriptPath);
  if (!lastMessage) {
    return emitBlock(parsed, state, 'subagent_stop', 'No assistant summary message was found for this subagent stop event.', lastMessage);
  }
  if (!messageMentionsConcreteOutcome(lastMessage)) {
    return emitBlock(parsed, state, 'subagent_stop', 'Subagent output must include a concrete outcome line (e.g. Outcome: <result>).', lastMessage);
  }
  if (!messageMentionsChangedFiles(lastMessage)) {
    return emitBlock(parsed, state, 'subagent_stop', 'Subagent output must include a Changed files: or No files changed: line.', lastMessage);
  }
  if (!messageMentionsVerificationStatus(lastMessage)) {
    return emitBlock(parsed, state, 'subagent_stop', 'Subagent output must include a Verification status: line.', lastMessage);
  }
  if (!messageMentionsRemainingRisks(lastMessage) && !messageMentionsNextStep(lastMessage)) {
    return emitBlock(parsed, state, 'subagent_stop', 'Subagent output must include a Remaining risks: or Next step: line.', lastMessage);
  }
  persistPatch(parsed, clearLoopBlockPatch('subagent_stop'));
  return passthrough();
}

// TaskCompleted: block task completion with a stderr message + exit 2 when a
// verification or agent-enforcement gate is unsatisfied. Mirrors
// task-completed.sh. Returns an exitBlock sentinel the runtime translates to
// exit 2 (no stdout JSON).
function handleTaskCompleted(parsed) {
  const state = loadStateFor(parsed);
  if (!state) return null;
  const transcriptText = readTranscriptText(parsed.transcriptPath ?? state.transcript_path ?? '');
  const startedRoles = effectiveStartedRoles(state, transcriptText, ALIASES);
  let reason = sessionBlockReason(state);
  if (reason) return exitBlock(`Task cannot be completed yet: ${reason}`);
  reason = sessionAgentEnforcementReason(state, startedRoles);
  if (reason) return exitBlock(`Task cannot be completed yet: ${reason}`);
  return null;
}

// TeammateIdle: block going idle with a stderr message + exit 2 when a
// verification, manager-idle, or agent-enforcement gate is unsatisfied.
// Mirrors teammate-idle.sh.
function handleTeammateIdle(parsed) {
  const state = loadStateFor(parsed);
  if (!state) return null;
  const transcriptText = readTranscriptText(parsed.transcriptPath ?? state.transcript_path ?? '');
  const startedRoles = effectiveStartedRoles(state, transcriptText, ALIASES);
  let reason = sessionBlockReason(state);
  if (reason) return exitBlock(`Do not go idle yet: ${reason}`);
  reason = sessionManagerIdleReason(state, startedRoles);
  if (reason) return exitBlock(`Do not go idle yet: ${reason}`);
  reason = sessionAgentEnforcementReason(state, startedRoles);
  if (reason) return exitBlock(`Do not go idle yet: ${reason}`);
  return null;
}

// SessionStart: detect the project's test/lint/build commands, persist them to
// session state (so stop-guard's verification gate knows what was detected),
// and emit the profile-active context message. Mirrors session-start.sh. The
// bash profile also writes a CLAUDE_ENV_FILE of exports; the Node runtime uses
// session state as the source of truth, so that env-file step is intentionally
// not ported.
function handleSessionStart(parsed) {
  const projectDir = resolveProjectDir(process.env, parsed.cwd ?? '');
  const opts = { cwd: projectDir };
  const testCmd = detectTestCmd(opts) ?? '';
  const lintCmd = detectLintCmd(opts) ?? '';
  const buildCmd = detectBuildCmd(opts) ?? '';
  persistPatch(parsed, {
    session_id: parsed.sessionId ?? '',
    cwd: parsed.cwd ?? '',
    transcript_path: parsed.transcriptPath ?? '',
    detected_test_command: testCmd,
    detected_lint_command: lintCmd,
    detected_build_command: buildCmd,
  });
  let message = 'Hook-gated SDLC is active. Required flow: discover -> design -> implement -> verify -> review -> docs when behavior changes -> cleanup. release/deploy automation is intentionally disabled in this profile.';
  if (testCmd || lintCmd || buildCmd) {
    message += ' Detected commands:';
    if (testCmd) message += ` test=${testCmd};`;
    if (lintCmd) message += ` lint=${lintCmd};`;
    if (buildCmd) message += ` build=${buildCmd};`;
  }
  return additionalContext(message, 'SessionStart');
}

// --- observability / lifecycle (Task 11) ----------------------------------

// Append one telemetry record to a JSONL stream. Telemetry is best-effort: a
// write failure is logged to stderr but never blocks the hook runtime.
function logEvent(parsed, name, payload) {
  try {
    appendJsonl(resolveLogRoot(), name, payload, { maxBytes: resolveLogMaxBytes() });
  } catch (e) {
    process.stderr.write(`hook-dispatcher: telemetry write failed for ${name}: ${e?.message ?? e}\n`);
  }
}

// Notification: record the notification payload to notification.jsonl. The
// runtime already surfaces notifications to the user natively, so (unlike the
// bash notification.sh) the Node port does not also spawn notify-send /
// osascript / powershell — that OS-specific desktop-notify path is intentionally
// dropped for portability and to avoid child_process spawning in the runtime.
function handleNotification(parsed) {
  logEvent(parsed, 'notification.jsonl', notificationPayload(parsed.data ?? {}));
  return passthrough();
}

// InstructionsLoaded: audit which memory file was loaded and why.
function handleInstructionsLoaded(parsed) {
  logEvent(parsed, 'instructions-loaded.jsonl', instructionsLoadedPayload(parsed.data ?? {}));
  return passthrough();
}

// PreCompact: record a compaction marker with a state snapshot.
function handlePreCompact(parsed) {
  logEvent(parsed, 'pre-compact.jsonl', preCompactPayload(parsed.data ?? {}, loadStateFor(parsed)));
  return passthrough();
}

// PostCompact: record a compaction marker, then best-effort re-inject the
// durable progress ledger so the agent keeps its place after compaction.
function handlePostCompact(parsed) {
  logEvent(parsed, 'post-compact.jsonl', postCompactPayload(parsed.data ?? {}));
  const projectDir = resolveProjectDir(process.env, parsed.cwd ?? '');
  const ledger = readLedgerForInjection(progressLedgerPath(projectDir), resolveLedgerMaxBytes());
  const ctx = buildPostCompactContext(ledger);
  return ctx ? additionalContext(ctx, 'PostCompact') : passthrough();
}

// SessionEnd: record the session index entry with a final state snapshot.
function handleSessionEnd(parsed) {
  logEvent(parsed, 'session-index.jsonl', sessionEndPayload(parsed.data ?? {}, loadStateFor(parsed)));
  return passthrough();
}

// ConfigChange: audit user-settings / config modifications.
function handleConfigChange(parsed) {
  logEvent(parsed, 'config-change.jsonl', configChangePayload(parsed.data ?? {}));
  return passthrough();
}

// Event handlers. Each takes the parsed input and returns a JSON-serializable
// output object (or null/undefined for passthrough). Handlers not yet ported
// return a neutral passthrough so the installed plugin stays inert but safe.
const handlers = {
  SessionStart: handleSessionStart,
  InstructionsLoaded: handleInstructionsLoaded,
  UserPromptSubmit: handleUserPromptSubmit,
  PreToolUse: handlePreToolUse,
  PermissionRequest: handlePermissionRequest,
  PermissionDenied: handlePermissionDenied,
  PostToolUse: handlePostToolUse,
  PostToolUseFailure: handlePostToolUseFailure,
  SubagentStart: handleSubagentStart,
  SubagentStop: handleSubagentStop,
  Stop: handleStop,
  TeammateIdle: handleTeammateIdle,
  TaskCompleted: handleTaskCompleted,
  Notification: handleNotification,
  ConfigChange: handleConfigChange,
  PreCompact: handlePreCompact,
  PostCompact: handlePostCompact,
  SessionEnd: handleSessionEnd,
};

/**
 * Pure, side-effect-free dispatch core. Given an event name and a parsed
 * input, return the output object. A handler crash or an unknown event never
 * blocks the runtime — it degrades to passthrough.
 */
export function dispatch(event, parsed, matcher = null) {
  const fn = handlers[event];
  if (typeof fn !== 'function') return passthrough();
  try {
    parsed.matcher = matcher;
    return fn(parsed) ?? passthrough();
  } catch {
    // Never block or stop the runtime on a handler bug; degrade to passthrough.
    return passthrough();
  }
}

/** Extract the --event argument from argv. */
export function eventFromArgs(argv) {
  const i = argv.indexOf('--event');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

/** Extract the --matcher argument from argv (used to disambiguate PostToolUse). */
export function matcherFromArgs(argv) {
  const i = argv.indexOf('--matcher');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

async function main() {
  const argEvent = eventFromArgs(process.argv.slice(2));
  const argMatcher = matcherFromArgs(process.argv.slice(2));
  const buf = await readStdin();
  const parsed = parseHookInput(buf);

  if (parsed.error) {
    process.stderr.write(`hook-dispatcher: input warning: ${parsed.error}\n`);
  }

  // --event takes precedence; fall back to hook_event_name in stdin.
  const event = argEvent || parsed.event;
  if (!event) {
    process.stderr.write('hook-dispatcher: no event (missing --event and hook_event_name)\n');
  }

  const out = dispatch(event, parsed, argMatcher);
  // TaskCompleted / TeammateIdle block with a stderr message + exit 2 (no
  // stdout JSON), matching the bash task-completed.sh / teammate-idle.sh.
  if (out && out.__exit) {
    process.stderr.write(`${out.stderr ?? ''}\n`);
    process.exit(out.__exit);
  }
  process.stdout.write(serialize(out));
}

// Run only when invoked directly (not when imported by tests).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    // A fatal crash must never fail the hook runtime. Emit a terminal
    // diagnostic to stderr and exit 0 so Claude Code is not blocked.
    process.stderr.write(`hook-dispatcher fatal: ${err?.message ?? err}\n`);
    process.stdout.write(serialize(terminalCancel(`hook dispatcher fatal error`)));
    process.exit(0);
  });
}
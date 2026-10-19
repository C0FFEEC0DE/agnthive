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
import { additionalContext, passthrough, serialize, terminalCancel, pretoolPermission, permissionRequestDeny, permissionDeniedResult, blockReason, eventClass } from './hook-output.mjs';
import { resolveDataRoot, resolveSessionId, resolveLogRoot, resolveProjectDir } from './util.mjs';
import { statePaths, appendEvent, loadState } from './state.mjs';
import {
  classifyPrompt, userPromptResetPatch, sessionBackgroundManagerPending,
  clearLoopBlockPatch, agentLoopKey, hasPriorStopBlock, taskTypeRequiresImplementationSummary,
} from './workflow.mjs';
import {
  commandClass, resultFromBashPayload, verificationAppendEvent,
  currentRevision, nextRevisionValue, isMutatingShellCommand,
  detectTestCmd, detectLintCmd, detectBuildCmd,
} from './verification.mjs';
import {
  extractSubagentLabel, extractSubagentScope, loadAliases, effectiveStartedRoles,
  shouldEnforceSubagentFooter, isGenericType, isAliasesLoaded,
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
  stopFailurePayload,
} from './notifications.mjs';
import { buildSessionStartRestore } from './ledger.mjs';
import {
  classifyCommand, resolveMode as resolvePolicyMode, permissionDeniedOutcome,
  pretoolErrorDetails, permRequestErrorDetails, permRequestMessage,
} from './command-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(here, '..');
const ALIASES = loadAliases(pluginRoot);
// The alias map is immutable for the process lifetime; precompute its
// loaded-ness once so shouldEnforceSubagentFooter avoids a per-SubagentStop
// Object.keys allocation on the hot path.
const ALIASES_LOADED = isAliasesLoaded(ALIASES);

// Failure-policy classes (ADR 0011, task 08) are normative data in
// hook-output.mjs — HOOK_EVENT_CLASSES / eventClass(): enforce = classifier and
// permission events, guidance = workflow gates, telemetry = observability
// writes. dispatch() consults eventClass() below; the classes are identical
// to the map this file used to carry locally, with SessionEnd + StopFailure
// both telemetry and SessionStart guidance.

// UserPromptSubmit: classify the prompt, persist the task type / manager mode /
// required roles / docs flag plus the stop-loop reset to session state, and
// emit the workflow context message (if any) as additionalContext. Mirrors
// claudecfg/hooks/user-prompt-submit.sh.
function handleUserPromptSubmit(parsed) {
  const prompt = parsed.data?.prompt ?? '';
  const cls = classifyPrompt(prompt);
  // ADR-0002 amendment: the turn reset is split — scalar stop-loop fields go
  // through one set_many, while per-agent maps are cleared via map_clear events
  // so no scalar set_many overloads a map field (model consistency: all
  // subagent_stop_blocks mutations flow through map_* events). The clear is a
  // deliberate whole-map reset for a new turn, not a per-key race fix.
  const reset = userPromptResetPatch();
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
    ...reset.scalar,
  };
  // Resolve the session paths once and reuse for the scalar set_many and the
  // per-map map_clear events (persistPatch would resolve them again internally).
  const paths = statePathsFor(parsed);
  safeAppend(paths, 'set_many', { fields });
  for (const mapField of reset.mapClears) {
    safeAppend(paths, 'map_clear', { mapField });
  }
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
  if (resolvePolicyMode() === 'enforce') {
    // Enforce mode: the classifier IS the permission decision, so a non-deny
    // verdict stays an explicit allow with its errorDetails context.
    return pretoolPermission('allow', cls.reason, pretoolErrorDetails('allow', cls.reason));
  }
  // Advisory neutrality (ADR 0011): the advisory guard only adds a deny when
  // the policy confidently classifies a dangerous command; otherwise it stays
  // neutral — no permissionDecision, no errorDetails — so the native
  // permission flow runs untouched.
  return passthrough();
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

// PostToolUse (Bash matcher): classify the command and record the outcome as a
// revision-scoped verification record (ADR 0009, task 04). The payload adapter
// owns the status precedence: a background launch marker is 'pending' (launch
// never equals completion), an interrupted/absent exit signal is 'unknown', and
// only a real exit 0 is 'passed'. A mutating class-'other' command bumps
// fs_revision_hint BEFORE anything else could be recorded, so earlier records
// stop counting. Mirrors post-tool-use.sh.
function handlePostToolUseBash(parsed) {
  const command = parsed.toolInput?.command ?? '';
  const toolUseId = parsed.data?.tool_use_id ?? parsed.toolUseId ?? '';
  const toolResponse = parsed.data?.tool_response ?? parsed.toolResponse ?? '';
  let state = null;
  try { state = loadStateFor(parsed); } catch {}
  const result = resultFromBashPayload(commandClass(command), command, toolResponse, toolUseId, {
    revision: state ? currentRevision(state) : null,
    cwd: parsed.cwd ?? state?.cwd ?? '',
    startedRevision: startedRevisionForPending(state, toolUseId),
  });
  if (!result) {
    if (isMutatingShellCommand(command) && state) {
      safeAppend(statePathsFor(parsed), 'set_many', { fields: { fs_revision_hint: nextRevisionValue(state) } });
    }
    return passthrough();
  }
  const recordEvent = verificationAppendEvent(result);
  if (recordEvent) safeAppend(statePathsFor(parsed), 'append', recordEvent);
  if (result.fields) persistPatch(parsed, result.fields);
  return result.message ? additionalContext(result.message, 'PostToolUse') : passthrough();
}

// ADR-0009 background completion: a pending record keyed by the same toolUseId
// supplies the revision the run STARTED at, so the completion record is valid
// only if nothing moved the hint between launch and completion (append-only
// supersession; the gate reads only records that are still valid).
function startedRevisionForPending(state, toolUseId) {
  if (!state || !toolUseId || !Array.isArray(state.verification)) return undefined;
  for (let i = state.verification.length - 1; i >= 0; i--) {
    const rec = state.verification[i];
    if (rec && rec.toolUseId === toolUseId && rec.status === 'pending' && Number.isFinite(Number(rec.startedRevision))) {
      return Number(rec.startedRevision);
    }
  }
  return undefined;
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
  if (codeChanged && state) {
    // ADR-0009 revision invalidation: a code/config write bumps fs_revision_hint
    // to max(revision, hint) + 1 (nextRevisionValue) so revision-scoped
    // verification records stop counting toward the current gate. Set (not
    // increment), so the hint overtakes an already-higher revision counter.
    safeAppend(statePathsFor(parsed), 'set_many', { fields: { fs_revision_hint: nextRevisionValue(state) } });
    return additionalContext('Recorded a code/config change in session state. This session now requires verification before completion.', 'PostToolUse');
  }
  return passthrough();
}

// PostToolUseFailure: record a failed test/lint/build outcome as a
// revision-scoped verification record (ADR 0009, task 04). The failure-path
// sync call sets assumeFailure so an unusable response is treated as failed,
// while a real exit 0 still wins (never fabricate a failure when the payload
// shows the command passed). Mirrors post-tool-use.sh failure path.
function handlePostToolUseFailure(parsed) {
  const isBash = parsed.matcher === 'Bash' || parsed.toolName === 'Bash';
  if (!isBash) return passthrough();
  const command = parsed.toolInput?.command ?? '';
  const toolUseId = parsed.data?.tool_use_id ?? parsed.toolUseId ?? '';
  const toolResponse = parsed.data?.tool_response ?? parsed.toolResponse ?? '';
  let state = null;
  try { state = loadStateFor(parsed); } catch {}
  const result = resultFromBashPayload(commandClass(command), command, toolResponse, toolUseId, {
    revision: state ? currentRevision(state) : null,
    cwd: parsed.cwd ?? state?.cwd ?? '',
    assumeFailure: true,
    error: parsed.data?.error ?? '',
  });
  if (!result) {
    if (isMutatingShellCommand(command) && state) {
      safeAppend(statePathsFor(parsed), 'set_many', { fields: { fs_revision_hint: nextRevisionValue(state) } });
    }
    return passthrough();
  }
  const recordEvent = verificationAppendEvent(result);
  if (recordEvent) safeAppend(statePathsFor(parsed), 'append', recordEvent);
  if (result.fields) persistPatch(parsed, result.fields);
  return result.message ? additionalContext(result.message, 'PostToolUseFailure') : passthrough();
}

// Append an event record, swallowing write failures to stderr so a state-write
// fault never blocks the hook runtime. Shared by every state-mutation call site
// (set_many patches, per-key map_set/map_delete events, the SubagentStart batch).
function safeAppend(paths, type, payload) {
  try { appendEvent(paths, type, payload); } catch (e) {
    process.stderr.write(`hook-dispatcher: state write failed: ${e?.message ?? e}\n`);
  }
}

// Persist a state patch as a set_many event for the parsed input's session.
function persistPatch(parsed, patch) {
  safeAppend(statePathsFor(parsed), 'set_many', { fields: patch });
}

function statePathsFor(parsed) {
  return statePaths(resolveDataRoot(), resolveSessionId(parsed.sessionId));
}

// ADR-0002 race fix: append a per-key map mutation (map_set/map_delete) instead
// of a full-map set_many. A full-map snapshot written via set_many is a shallow
// Object.assign, so the reducer applies it last-writer-wins and a concurrently
// written sibling agent's entry is clobbered. Per-key events touch one key, so
// concurrent SubagentStop writers for different agents survive each other.
function appendMapSet(parsed, mapField, key, value) {
  safeAppend(statePathsFor(parsed), 'map_set', { mapField, key, value });
}
function appendMapDelete(parsed, mapField, key) {
  safeAppend(statePathsFor(parsed), 'map_delete', { mapField, key });
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
    safeAppend(paths, ev.type, ev.payload);
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
// call sites. `agentId` keys the per-agent loop-block counter (ADR 0002); the
// session-global `stop` prefix keeps it null.
//
// The write path is routed by the loop-block model, not a prefix string-literal:
// a per-agent prefix (loopBlockFields(prefix).perAgent) writes only its changed
// map key via map_set, so concurrent writers for different agents survive each
// other (ADR-0002 race fix); a session-global prefix writes the scalar patch via
// set_many. Adding or renaming a per-agent prefix only needs loopBlockFields to
// change — the dispatcher follows the model and cannot silently diverge.
//
// ADR 0005: emitLoopAwareBlock carries the changed entry explicitly in `perKey`
// ({ mapKey, key, entry } for a per-agent prefix, null for a session-global
// prefix), so the dispatcher emits map_set straight from it instead of
// re-reading the full-map patch. The entry is guaranteed by recordLoopBlock for
// a per-agent prefix, so there is no defensive missing-entry branch here.
function emitBlock(parsed, state, prefix, reason, message, agentId = null) {
  const { patch, output, perKey } = emitLoopAwareBlock(state, prefix, reason, message, agentId);
  if (perKey) {
    appendMapSet(parsed, perKey.mapKey, perKey.key, perKey.entry);
  } else {
    persistPatch(parsed, patch);
  }
  return output;
}

// Stop: enforce the footer contract and completion gates. Mirrors
// stop-guard.sh. A previous terminal policy-stall is repeated verbatim so a
// runtime that re-enters Stop while processing the terminal response does not
// re-enter the normal blocking path.
function handleStop(parsed) {
  const state = loadStateFor(parsed);
  if (!state) return passthrough();
  // ADR 0003: when the runtime signals stop_hook_active, it is re-invoking the
  // Stop hook after our own previous block — yield (clear loop state and pass
  // through) instead of re-blocking, honoring the standard loop-prevention
  // contract. Checked before the policy-stall repeat so even a stalled session
  // yields when the runtime asks it to.
  //
  // Hardening: only yield when there is evidence of a prior block this session
  // (a non-zero stop_block_count or a terminal policy stall). A conformant
  // runtime sets stop_hook_active only on a re-invocation, so a prior block is
  // always present then; gating on it means a runtime that erroneously sets
  // stop_hook_active on a FIRST Stop invocation cannot silently disable all
  // enforcement (verification gate, agent handoffs, footer checks) for the
  // session — normal blocking proceeds instead.
  if (parsed.stopHookActive === true && hasPriorStopBlock(state)) {
    persistPatch(parsed, clearLoopBlockPatch('stop'));
    return passthrough();
  }
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
// subagent-stop-guard.sh. ADR 0001: the footer contract applies only to
// recognized AgntHive specialist roles; generic dispatch types
// (general-purpose, workflow-subagent) and unidentified subagents pass through
// without footer enforcement, so structured output is not corrupted. ADR 0002:
// the loop-block counter is keyed per agent_id via the agentId thread.
function handleSubagentStop(parsed) {
  const state = loadStateFor(parsed);
  if (!state) return passthrough();
  // ADR-0001: scope footer enforcement to AgntHive specialists. Generic dispatch
  // types are always exempt — shouldEnforceSubagentFooter below returns false for
  // them — and a missing/corrupt alias map degrades to enforcing on all
  // non-generic subagents rather than silently disabling the contract. The
  // isGenericType short-circuit is a behavior-neutral optimization: it only
  // skips the extractSubagentLabel LABEL_PATHS walk for generic types, which
  // passthrough regardless; removing it does not change behavior.
  if (isGenericType(parsed.agentType)) return passthrough();
  const label = extractSubagentLabel(parsed.data, ALIASES);
  if (!shouldEnforceSubagentFooter(label, parsed.agentType, ALIASES, ALIASES_LOADED)) return passthrough();
  const transcriptPath = parsed.transcriptPath ?? state.transcript_path ?? '';
  const lastMessage = resolvedLastAssistantMessage(parsed.data ?? {}, transcriptPath);
  if (!lastMessage) {
    return emitBlock(parsed, state, 'subagent_stop', 'No assistant summary message was found for this subagent stop event.', lastMessage, parsed.agentId);
  }
  if (!messageMentionsConcreteOutcome(lastMessage)) {
    return emitBlock(parsed, state, 'subagent_stop', 'Subagent output must include a concrete outcome line (e.g. Outcome: <result>).', lastMessage, parsed.agentId);
  }
  if (!messageMentionsChangedFiles(lastMessage)) {
    return emitBlock(parsed, state, 'subagent_stop', 'Subagent output must include a Changed files: or No files changed: line.', lastMessage, parsed.agentId);
  }
  if (!messageMentionsVerificationStatus(lastMessage)) {
    return emitBlock(parsed, state, 'subagent_stop', 'Subagent output must include a Verification status: line.', lastMessage, parsed.agentId);
  }
  if (!messageMentionsRemainingRisks(lastMessage) && !messageMentionsNextStep(lastMessage)) {
    return emitBlock(parsed, state, 'subagent_stop', 'Subagent output must include a Remaining risks: or Next step: line.', lastMessage, parsed.agentId);
  }
  // ADR-0002 race fix: clear only this agent's map key via a per-key delete
  // event, not a full-map set_many snapshot that could clobber a concurrently
  // written sibling agent's entry. ADR 0006: the per-agent key (with the
  // `_session` fallback when agent_id is absent) comes from the shared helper.
  appendMapDelete(parsed, 'subagent_stop_blocks', agentLoopKey(parsed.agentId));
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

// SessionStart: restoration sources (compact/resume, per ADR 0013 / task 07)
// rebuild session context from durable state via handleSessionStartRestore.
// Fresh starts detect the project's test/lint/build commands, persist them to
// session state (so stop-guard's verification gate knows what was detected),
// and emit the profile-active context message. Mirrors session-start.sh. The
// bash profile also writes a CLAUDE_ENV_FILE of exports; the Node runtime uses
// session state as the source of truth, so that env-file step is intentionally
// not ported.
function handleSessionStart(parsed) {
  const source = parsed.source ?? parsed.data?.source ?? '';
  if (source === 'compact' || source === 'resume') {
    return handleSessionStartRestore(parsed);
  }
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

// SessionStart restoration source (ADR 0013, task 07): compact/resume starts
// rebuild session context from durable state instead of re-detecting commands.
// The ledger builder is stat-only (it never re-injects ledger text) and returns
// a compact active-task summary plus the restored_task_seq patch to persist.
// Each SessionStart event runs in its own hook process, so the builder's
// default increment bookkeeping applies exactly once per restoration event —
// no cycleSeq counter needed for exec-form wiring.
function handleSessionStartRestore(parsed) {
  const state = loadStateFor(parsed);
  if (!state) return passthrough();
  const projectDir = resolveProjectDir(process.env, parsed.cwd ?? '');
  const restored = buildSessionStartRestore(state, { projectDir });
  if (!restored) return passthrough();
  safeAppend(statePathsFor(parsed), 'set_many', { fields: restored.patch });
  return additionalContext(restored.message, 'SessionStart');
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

// PostCompact: record the compaction marker. The record is metadata-only
// (notifications.mjs postCompactPayload, F10 hygiene), and ledger restoration
// moved to SessionStart compact/resume (ADR 0013): async PostCompact output is
// not consumed by the host, so the guaranteed-restore path rides the
// SessionStart restoration source instead — handleSessionStartRestore.
function handlePostCompact(parsed) {
  logEvent(parsed, 'post-compact.jsonl', postCompactPayload(parsed.data ?? {}));
  return passthrough();
}

// SessionEnd: record the session index entry with a final state snapshot.
function handleSessionEnd(parsed) {
  logEvent(parsed, 'session-index.jsonl', sessionEndPayload(parsed.data ?? {}, loadStateFor(parsed)));
  return passthrough();
}

// ConfigChange: audit user-settings / config modifications.

// StopFailure: bounded observability of API/turn failures (ADR 0013, task 07).
// API error text is never treated as a completion summary; write the stream and
// return passthrough — telemetry failures never block (ADR 0011).
function handleStopFailure(parsed) {
  logEvent(parsed, 'stop-failure.jsonl', stopFailurePayload(parsed.data ?? {}));
  return passthrough();
}
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
  StopFailure: handleStopFailure,
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
  } catch (e) {
    // ADR 0011 (task 08): handler crashes must not silently passthrough in
    // enforce mode. Enforce-class handler failure: in enforce mode deny the
    // protected action with a diagnostic (the classifier is unavailable, so a
    // dangerous command must not appear pre-approved. In advisory mode keep
    // the native permission flow with a degradation note; guidance/telemetry
    // classes keep unknown status preserved. Never fabricate success.
    const cls = eventClass(event) ?? 'guidance';
    try { process.stderr.write(`hook-dispatcher: ${event} handler failed: ${e?.message ?? e}\n`); } catch {}
    if (cls === 'enforce') {
      if (resolvePolicyMode() === 'enforce') return denyOnHandlerFailure(event, e);
    }
    return passthrough();
  }
}

// Event-appropriate deny output for an enforce-class handler failure (ADR 0011,
// task 08.2). Only the permission events have actionable deny constructors; the
// permission events ARE the enforce class, so nothing else routes here.
function denyOnHandlerFailure(event, e) {
  const reason = `Safety hook could not evaluate this action (handler error: ${e?.message ?? e}). Denied by policy: the classifier could not determine whether this command is dangerous. Treat the hook as unavailable, not as a pre-passed action.`;
  if (event === 'PreToolUse') return pretoolPermission('deny', reason, pretoolErrorDetails('deny', reason));
  if (event === 'PermissionRequest') return permissionRequestDeny(reason, reason);
  if (event === 'PermissionDenied') return permissionDeniedResult(false);
  return passthrough();
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
  // TaskCompleted / TeammateIdle block with a stderr message + exit 2, matching
  // the bash task-completed.sh / teammate-idle.sh. Structured block JSON
  // (item 1 safe subset): OPTIONALLY also write a { decision: "block", reason }
  // JSON object to stdout using the same message, so hosts that prefer stdout
  // JSON over the exit code can receive the block intent + reason. This is
  // gated behind AGNTHIVE_BLOCK_STDOUT_JSON (opt-in) because decision:"block"
  // is the "continue with feedback" contract and it is unverified whether a
  // host honors stdout JSON over the exit code for these events — emitting it
  // unconditionally could weaken a hard stop. With the flag unset (default),
  // stdout stays empty and behavior is byte-identical to the legacy exit-2 +
  // stderr block. Full exit-2 removal stays gated on verifying that contract.
  if (out && out.__exit) {
    const errMsg = out.stderr ?? '';
    process.stderr.write(`${errMsg}\n`);
    if (/^(1|true|yes|on)$/i.test(process.env.AGNTHIVE_BLOCK_STDOUT_JSON ?? '')) {
      process.stdout.write(serialize(blockReason(errMsg)));
    }
    // Use exitCode + return (not process.exit) so the stdout write flushes
    // naturally before the process ends — process.exit can truncate an
    // unflushed pipe write for large payloads.
    process.exitCode = out.__exit;
    return;
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
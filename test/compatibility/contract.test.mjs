// contract.test.mjs — runtime contract fixtures for the agnthive hook dispatcher.
//
// Baseline for plan task 02 (docs/plans/2026-10-19-harness-modernization-and-
// simplification.md, items 02.1-02.4; design F01-F10; ADR 0010-0013). This is
// the DIRECT dispatcher layer: it spawns the single Node dispatcher with a
// manifest payload and asserts the event-specific output class exactly. Host
// integration (what Claude Code DOES with the emitted JSON) is a separate
// manual canary, recorded in test/compatibility/manifest.json
// capture_instructions, and is intentionally not asserted here.
//
// Sources of truth, deliberately not derived from the runtime:
//   - input shapes: the hooks reference + ADR 0010/0013 documented fields
//     (presence checks only, so a captured payload may carry more).
//   - output classes: the documented output reference + ADR 0011 (event-specific
//     envelopes; a universal {decision: block} is NOT a universal replacement,
//     plan 02.3).
// When the runtime changes an emitted shape, this test fails and the manifest
// or the class table must be updated explicitly.
//
// Fixtures live in payloads/ (one file per payload; entries may share a
// payload_path when only the expected class differs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pluginRoot = join(repoRoot, 'plugins', 'agnthive');
// The plugin's own state module (Node stdlib only), resolved to a file URL so
// the dynamic import works on Windows too.
const STATE_MODULE_URL = new URL('../../plugins/agnthive/modules/state.mjs', import.meta.url).href;

import { spawnFailureReason, __runnerInternals } from '../../scripts/test-hooks.mjs';
// parseHookInput is the dispatcher's own stdin normalization: running a payload
// through it validates "the stdin shape the dispatcher accepts" with the exact
// normalization the runtime uses. It VALIDATES fixtures; it never derives them.
import { parseHookInput } from '../../plugins/agnthive/modules/hook-input.mjs';

const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const entries = manifest.entries;
const entryById = new Map(entries.map((e) => [e.id, e]));

// ===========================================================================
// output class vocabulary (plan 02.3: event-specific, exact allowed fields)
// ===========================================================================
// Each class is one hook-output contract: allowed top-level fields, allowed
// hookSpecificOutput fields, exit code, and stderr. Authored from the
// documented hook output reference + ADR 0011 — NOT derived from
// hook-output.mjs constructors, so a runtime change cannot silently agree with
// the table (a change fails here and the table/manifest must move together).
const OUTPUT_CLASSES = {
  passthrough: {
    exit: 0,
    allowed_top_level: [],
    stdout_exact: '{}',
    stderr: 'empty',
  },
  input_warning_passthrough: {
    exit: 0,
    stdout_exact: '{}',
    stderr_regex: '^hook-dispatcher: input warning: ',
  },
  user_prompt_context: {
    exit: 0,
    allowed_top_level: ['hookSpecificOutput'],
    allowed_hook_specific: ['additionalContext', 'hookEventName'],
    hook_event_name: 'UserPromptSubmit',
  },
  user_prompt_context_pending: {
    // Pending sibling of user_prompt_context: same envelope, but the
    // background-return semantics stay unpinned until a real capture.
    exit: 0,
    allowed_top_level: ['hookSpecificOutput'],
    allowed_hook_specific: ['additionalContext', 'hookEventName'],
    hook_event_name: 'UserPromptSubmit',
    pending: true,
  },
  post_tool_use_context: {
    exit: 0,
    allowed_top_level: ['hookSpecificOutput'],
    allowed_hook_specific: ['additionalContext', 'hookEventName'],
    hook_event_name: 'PostToolUse',
  },
  post_tool_use_context_pending: {
    // Envelope only: completion semantics (pending/failed/unknown vs passed)
    // are NOT pinned here; captured payloads + task 04 own them (F01).
    exit: 0,
    allowed_top_level: ['hookSpecificOutput'],
    allowed_hook_specific: ['additionalContext', 'hookEventName'],
    hook_event_name: 'PostToolUse',
    pending: true,
  },
  subagent_start_context: {
    exit: 0,
    allowed_top_level: ['hookSpecificOutput'],
    allowed_hook_specific: ['additionalContext', 'hookEventName'],
    hook_event_name: 'SubagentStart',
  },
  subagent_start_context_pending: {
    // Pending sibling of subagent_start_context: the handoff contract envelope
    // is stable, but resume/idempotency semantics stay unpinned until capture.
    exit: 0,
    allowed_top_level: ['hookSpecificOutput'],
    allowed_hook_specific: ['additionalContext', 'hookEventName'],
    hook_event_name: 'SubagentStart',
    pending: true,
  },
  subagent_stop_passthrough: {
    exit: 0,
    allowed_top_level: [],
    stdout_exact: '{}',
    stderr: 'empty',
  },
  subagent_stop_passthrough_pending: {
    // Pending sibling of subagent_stop_passthrough: the passthrough result for
    // a valid handback is stable, but delivered-report vs closing-text
    // attribution (ADR 0010) stays unpinned until a real capture.
    exit: 0,
    allowed_top_level: [],
    stdout_exact: '{}',
    stderr: 'empty',
    pending: true,
  },
  stop_block_decision: {
    // Stop's workflow-gate block: decision:block + the checklist, exit 0.
    exit: 0,
    allowed_top_level: ['decision', 'reason', 'errorDetails', 'hardStop'],
    decision: 'block',
    hardStop: false,
  },
  stop_block_decision_pending: {
    // Pending sibling of stop_block_decision: the block envelope is stable, but
    // the exact checklist payload in `reason` stays a capture target, so only
    // the envelope is pinned here.
    exit: 0,
    allowed_top_level: ['decision', 'reason', 'errorDetails', 'hardStop'],
    decision: 'block',
    hardStop: false,
    pending: true,
  },
  stop_passthrough: {
    // Already-finished work re-entering Stop: no block. The prior-block state
    // seed (ADR 0003) is part of the captured fixture, not of this table.
    exit: 0,
    allowed_top_level: [],
    stdout_exact: '{}',
    stderr: 'empty',
  },
  stop_passthrough_pending: {
    // Pending sibling of stop_passthrough: the passthrough shape is stable, but
    // the prior-block state seed it depends on (ADR 0003) is a capture target,
    // so the class stays unconfirmed until capture.
    exit: 0,
    allowed_top_level: [],
    stdout_exact: '{}',
    stderr: 'empty',
    pending: true,
  },
  session_start_context: {
    exit: 0,
    allowed_top_level: ['hookSpecificOutput'],
    allowed_hook_specific: ['additionalContext', 'hookEventName'],
    hook_event_name: 'SessionStart',
  },
  session_start_context_pending: {
    // Pending sibling: the compact/resume restoration channel (ADR 0013) is the
    // unverified part, not the envelope.
    exit: 0,
    allowed_top_level: ['hookSpecificOutput'],
    allowed_hook_specific: ['additionalContext', 'hookEventName'],
    hook_event_name: 'SessionStart',
    pending: true,
  },
  post_compact_context_pending: {
    // ADR 0013: PostCompact is bounded bookkeeping; async stdout JSON is not
    // proven delivery, so only the envelope shape is pinned, per capture.
    exit: 0,
    allowed_top_level: ['hookSpecificOutput'],
    allowed_hook_specific: ['additionalContext', 'hookEventName'],
    hook_event_name: 'PostCompact',
    pending: true,
  },
  permission_denied_legacy_retry_shorthand: {
    // F05 at the review baseline: the LEGACY top-level shorthand. Deliberately
    // asserted so the legacy form stays detected (plan 02 acceptance); task 03
    // must flip the manifest entry to the envelope class below.
    exit: 0,
    allowed_top_level: ['retry'],
    shorthand: true,
  },
  permission_denied_hook_specific_retry_envelope: {
    exit: 0,
    allowed_top_level: ['hookSpecificOutput'],
    allowed_hook_specific: ['hookEventName', 'retry'],
    hook_event_name: 'PermissionDenied',
  },
};

// Documented stdin shapes: presence checks per event the manifest exercises.
// Extra fields are allowed (the runtime tolerates them); the contract pins what
// the runtime READS, authored from the hooks reference + ADR 0010.
const STDIN_SHAPE = {
  UserPromptSubmit: ['session_id', 'prompt'],
  PostToolUse: ['session_id', 'tool_name', 'tool_input', 'tool_response'],
  SubagentStart: ['session_id', 'agent_identity'],
  SubagentStop: ['session_id', 'agent_identity', 'last_assistant_message'],
  Stop: ['session_id', 'stop_hook_active', 'last_assistant_message'],
  SessionStart: ['session_id', 'source'],
  PermissionDenied: ['tool_name', 'tool_input'],
  Notification: [],
  PreCompact: ['session_id', 'trigger'],
  PostCompact: ['session_id', 'trigger'],
};

const AGENT_IDENTITY_FIELDS = ['agent_id', 'agent_name', 'agent_alias', 'subagent_type'];
const DEGENERATE_EVENTS = new Set(['Notification']);

function requiredFieldsPresent(payload, fields) {
  return fields.filter((f) => payload[f] === undefined);
}

function agentIdentityPresent(payload) {
  return AGENT_IDENTITY_FIELDS.some((f) => typeof payload[f] === 'string' && payload[f] !== '');
}

// ===========================================================================
// manifest validation (plan 02.1)
// ===========================================================================

// Allowed values per manifest field. `captured` is reserved: no payload in this
// tree has been observed on a target CLI yet, so using it would be a lie.
const STATUSES = ['active', 'pending_capture'];
const SOURCES = ['synthetic', 'captured'];

function payloadAbsPath(entry) {
  return join(here, entry.payload_path);
}

test('compat manifest: entries are well-formed and ids are unique', () => {
  assert.ok(Array.isArray(entries) && entries.length > 0);
  const seen = new Set();
  for (const e of entries) {
    for (const field of ['id', 'event', 'cli_version_target', 'source', 'status', 'description', 'payload_path', 'expected_class']) {
      assert.equal(typeof e[field], 'string', `${e.id ?? '<no id>'}: ${field} must be a non-empty string`);
      assert.ok(e[field] !== '', `${e.id ?? '<no id>'}: ${field} must be non-empty`);
    }
    assert.ok(!seen.has(e.id), `duplicate manifest id ${e.id}`);
    seen.add(e.id);
    assert.equal(e.cli_version_target, '2.1.303', `${e.id}: cli_version_target must stay the pinned target (task 01/14 update it explicitly)`);
  }
  // The plan's capture list is fully covered by manifest entries.
  for (const required of [
    'compat_post_tool_use_foreground_bash',
    'compat_post_tool_use_background_bash',
    'compat_subagent_stop_return',
    'compat_user_prompt_submit_namespace_slash',
    'compat_stop_active_work',
    'compat_stop_already_finished',
    'compat_session_start_compact',
    'compat_session_start_resume',
    'compat_post_compact',
    'compat_subagent_start_resume',
    'compat_permission_denied_capture',
  ]) {
    assert.ok(entryById.has(required), `manifest must contain plan-02 entry ${required}`);
  }
});

test('compat manifest: capture hygiene — nothing synthetic is labeled captured', () => {
  for (const e of entries) {
    assert.ok(STATUSES.includes(e.status), `${e.id}: status ${e.status} not in ${STATUSES.join('|')}`);
    assert.ok(SOURCES.includes(e.source), `${e.id}: source ${e.source} not in ${SOURCES.join('|')}`);
    if (e.source === 'captured') {
      // A captured entry must be activatable, and must not keep a pending-only
      // marker around.
      assert.equal(e.status, 'active', `${e.id}: a captured payload must be active`);
      assert.ok(!e.known_gap, `${e.id}: a captured entry must not keep the pending known_gap marker`);
    }
    if (e.status === 'active' && e.source === 'synthetic') {
      // Synthetic-but-active entries carry their rationale explicitly.
      assert.equal(typeof e.active_reason, 'string', `${e.id}: a synthetic active entry needs an active_reason`);
      assert.ok(e.active_reason.length > 10, `${e.id}: active_reason must be a rationale, not a flag`);
    }
  }
  // Baseline snapshot: no capture has happened yet (this is the honest state of
  // task 02 — every scenario the plan lists for capture is still pending).
  const captured = entries.filter((e) => e.source === 'captured');
  assert.deepEqual(captured.map((e) => e.id), [], 'no real captures exist yet; flip source/status only with an actual target-CLI canary');
});

test('compat manifest: pending_capture entries carry a one-line capture instruction', () => {
  for (const e of entries) {
    if (e.status !== 'pending_capture') continue;
    assert.equal(typeof e.capture_instructions, 'string', `${e.id}: pending_capture needs capture_instructions`);
    assert.ok(e.capture_instructions.length > 10, `${e.id}: capture_instructions must be a one-line instruction`);
  }
});

test('compat manifest: payload files exist with the declared payload_format', () => {
  const formats = new Set();
  for (const e of entries) {
    const format = e.payload_format ?? 'json';
    formats.add(format);
    assert.ok(['json', 'raw-text'].includes(format), `${e.id}: unknown payload_format ${format}`);
    assert.ok(existsOrThrow(e), `${e.id}: payload missing`);
  }
  assert.ok(formats.has('json') && formats.has('raw-text'), 'manifest must keep both payload formats exercised');
});

// existsOrThrow is defined next; keep the test above readable.
function existsOrThrow(entry) {
  const p = payloadAbsPath(entry);
  if (!existsSync(p)) throw new Error(`payload file missing: ${entry.payload_path}`);
  return true;
}

test('compat manifest: expected_class is known for every entry', () => {
  const known = new Set(Object.keys(OUTPUT_CLASSES));
  for (const e of entries) {
    assert.ok(known.has(e.expected_class), `${e.id}: unknown expected_class ${e.expected_class}`);
  }
  // Every *_pending class name pairs with a non-pending base class (kept in the
  // table); a pending entry that references a concrete (non-pending) class must
  // share the payload with an active sibling asserting exactly that class (the
  // PermissionDenied input-capture entry, whose output is already pinned).
  for (const e of entries) {
    if (e.status !== 'pending_capture') continue;
    const cls = OUTPUT_CLASSES[e.expected_class];
    const activeSibling = entries.some((o) =>
      o !== e && o.status === 'active'
      && o.payload_path === e.payload_path
      && o.expected_class === e.expected_class);
    assert.ok(cls.pending === true || activeSibling,
      `${e.id}: pending entries reference a *_pending class, or share an active sibling's payload + class`);
  }
});

// ===========================================================================
// payload stdin-shape validation (plan 02, "parses as the hook stdin shape
// the dispatcher accepts" — the same normalization expectations the runner and
// dispatcher apply)
// ===========================================================================

function readPayloadText(entry) {
  return readFileSync(payloadAbsPath(entry), 'utf8');
}

test('compat payloads: every JSON payload parses and matches its documented stdin shape', () => {
  for (const e of entries) {
    if ((e.payload_format ?? 'json') !== 'json') continue;
    const text = readPayloadText(e);
    assert.ok(text.trim().length > 0, `${e.id}: JSON payload must not be empty`);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      assert.fail(`${e.id}: payload is not valid JSON: ${err.message}`);
    }
    assert.equal(typeof payload, 'object', `${e.id}: stdin must be a JSON object`);
    assert.equal(payload.hook_event_name, e.event, `${e.id}: payload hook_event_name must match the manifest event`);
    assert.equal(parseHookInput(text).ok, true, `${e.id}: dispatcher normalization must accept the payload (parseHookInput.ok)`);

    // `agent_identity` is a pseudo-requirement: any one of the agent id/name/
    // alias/type fields must be present (checked separately below).
    const required = (STDIN_SHAPE[e.event] ?? []).filter((f) => f !== 'agent_identity');
    const missing = requiredFieldsPresent(payload, required);
    assert.deepEqual(missing, [], `${e.id}: payload missing documented stdin fields ${missing.join(', ')}`);

    if (STDIN_SHAPE[e.event]?.includes('agent_identity')) {
      assert.ok(agentIdentityPresent(payload), `${e.id}: payload needs at least one agent identity field (${AGENT_IDENTITY_FIELDS.join('|')})`);
    }
    if (e.event === 'Stop') {
      assert.equal(typeof payload.stop_hook_active, 'boolean', `${e.id}: stop_hook_active must be a boolean when present`);
    }
    if (e.event === 'PostToolUse') {
      // tool_response presence is pinned; its SHAPE is not (capture target for
      // foreground/background behavior, F01 + plan task 04).
      assert.notEqual(payload.tool_response, undefined, `${e.id}: PostToolUse payloads carry tool_response`);
    }
  }
});

test('compat payloads: raw-text degenerate payloads hold the documented stdin bytes', () => {
  for (const e of entries) {
    if ((e.payload_format ?? 'json') !== 'raw-text') continue;
    const text = readPayloadText(e);
    if (e.id === 'compat_stdin_empty') {
      assert.equal(text, '', 'empty-stdin payload must be a zero-byte file');
    } else if (e.id === 'compat_stdin_malformed_json') {
      // Truncated JSON: the exact failure the dispatcher reports to stderr.
      assert.throws(() => JSON.parse(text), undefined, 'malformed payload must not be parseable');
    }
  }
});

test('compat payloads: session ids, paths, and ids are synthetic placeholders (no private data)', () => {
  for (const e of entries) {
    const text = readPayloadText(e);
    // Placeholder roots only; no absolute user paths, usernames, or real
    // transcript/session data may leak into the fixture tree.
    assert.ok(!/\/home\/(chaos|user|runner)/.test(text), `${e.id}: payload must not embed user home paths`);
    assert.ok(!text.includes(process.env.HOME ?? '<<unset>>'), `${e.id}: payload must not embed the real HOME`);
    for (const suspicious of ['C0FFEEC0DE', 'github.com', 'api_key', 'Bearer ']) {
      assert.ok(!text.includes(suspicious), `${e.id}: payload must not embed ${suspicious}`);
    }
  }
});

// ===========================================================================
// active entries: run the dispatcher and assert the documented output class
// (plan 02.3/02.4: direct dispatcher layer; host application is a manual canary)
// ===========================================================================

const { runDispatcher } = __runnerInternals;
const ACTIVE = entries.filter((e) => e.status === 'active');

function probeEnv(tmpDir) {
  const home = join(tmpDir, 'home');
  return {
    env: {
      // Hermetic, like the fixture runner: inherit only PATH, point the plugin
      // at a throwaway data root so the probe never writes outside it.
      PATH: process.env.PATH ?? '',
      HOME: home,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_DATA: join(home, '.claude'),
    },
    dir: tmpDir,
  };
}

function runProbe(entry, stdinText) {
  const tmp = mkdtempSync(join(tmpdir(), 'compat-probe-'));
  const { env, dir } = probeEnv(tmp);
  const res = runDispatcher({
    event: entry.event,
    matcher: entry.spawn_matcher ?? null,
    stdinJson: stdinText,
    env,
    cwd: dir,
  });
  // Cleanup is the caller's job: tests that read session state back from the
  // probe's data root need it to survive until the read-back is done.
  return { res, env, dataRoot: env.CLAUDE_PLUGIN_DATA, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

// Assert one output class against a probe result. Each case enumerates the
// allowed fields exactly: a runtime that adds, drops, or renames a field fails
// here, not silently.
function assertOutputClass(className, res) {
  const expected = OUTPUT_CLASSES[className];
  assert.ok(expected, `unknown output class ${className}`);
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';

  assert.equal(res.status, expected.exit, `${className}: exit code mismatch (stderr: ${stderr.trim().slice(0, 200)})`);
  if (expected.stderr === 'empty') {
    assert.equal(stderr, '', `${className}: stderr must stay empty`);
  }
  if (expected.stderr_regex) {
    assert.match(stderr, new RegExp(expected.stderr_regex), `${className}: stderr must carry the input-parse warning`);
  }
  if (expected.stdout_exact !== undefined) {
    assert.equal(stdout, expected.stdout_exact, `${className}: stdout must be exactly ${expected.stdout_exact}`);
    return;
  }

  const parsed = JSON.parse(stdout);
  if (expected.allowed_top_level) {
    assert.deepEqual(Object.keys(parsed).sort(), [...expected.allowed_top_level].sort(), `${className}: unexpected top-level fields`);
  }
  const hso = parsed.hookSpecificOutput;
  if (expected.allowed_hook_specific) {
    assert.ok(hso && typeof hso === 'object', `${className}: hookSpecificOutput object required`);
    assert.deepEqual(Object.keys(hso).sort(), [...expected.allowed_hook_specific].sort(), `${className}: unexpected hookSpecificOutput fields`);
  }
  if (expected.hook_event_name) {
    assert.equal(hso.hookEventName, expected.hook_event_name, `${className}: hookEventName must bind the event`);
  }
  if (expected.allowed_hook_specific?.includes('additionalContext')) {
    assert.equal(typeof hso.additionalContext, 'string', `${className}: additionalContext must be a string`);
    assert.ok(hso.additionalContext.length > 0, `${className}: additionalContext must be non-empty`);
  }
  if (expected.decision) assert.equal(parsed.decision, expected.decision, `${className}: decision value`);
  if (expected.hardStop !== undefined) assert.equal(parsed.hardStop, expected.hardStop, `${className}: hardStop value`);
}

// Pending entries are NOT executed: the well-formedness tests above cover them
// (plan 02.2 — capture unavailable is an explicit pending integration check,
// not a synthetic pass).
for (const entry of ACTIVE) {
  test(`compat[active] ${entry.id} -> ${entry.expected_class}`, () => {
    const stdinText = readPayloadText(entry);
    const { res, cleanup } = runProbe(entry, stdinText);
    try {
      // Same rule as the fixture runner (plan 02.5): a failed spawn is an
      // independent failure with its own diagnostic, never an output mismatch.
      const spawnFailure = spawnFailureReason(res);
      if (spawnFailure) assert.fail(`dispatcher spawn failed, hook never ran: ${spawnFailure}`);
      assertOutputClass(entry.expected_class, res);
      assertEntryExtras(entry, res);
    } finally {
      cleanup();
    }
  });
}

// Entry-specific extras: values the class alone does not pin (state side
// effects read back through the plugin's own state module, per-event warning
// text, and the concrete legacy retry verdict). Additive: a new active entry
// either finds its extras here or none.
function assertEntryExtras(entry, res) {
  const parsed = JSON.parse(res.stdout ?? '{}');
  switch (entry.id) {
    case 'compat_user_prompt_submit_normal': {
      assert.match(parsed.hookSpecificOutput.additionalContext, /feature workflow/, 'the normal prompt classifies as a feature workflow');
      break;
    }
    case 'compat_stdin_empty': {
      assert.match(res.stderr ?? '', /empty stdin/, 'the warning must name empty stdin');
      break;
    }
    case 'compat_stdin_malformed_json': {
      assert.match(res.stderr ?? '', /invalid JSON:/, 'the warning must name invalid JSON');
      break;
    }
    case 'compat_permission_denied_current_envelope': {
      // Task-03 envelope (post-migration): retry moves under hookSpecificOutput
      // and the legacy top-level F05 shorthand must stay gone.
      assert.equal(parsed.hookSpecificOutput.retry, true, 'a non-hard-denied command stays retryable (command-policy)');
      assert.equal(parsed.retry, undefined, 'no legacy top-level retry shorthand (F05)');
      break;
    }
    default:
      break;
  }
}

// State application for the active UserPromptSubmit entry: the class envelope is
// only half the contract; the classification must reach session state. Read
// back through the plugin's own state module so the interpretation matches the
// dispatcher exactly.
test('compat[active] compat_user_prompt_submit_normal applies the classification in session state', async () => {
  const entry = entries.find((e) => e.id === 'compat_user_prompt_submit_normal');
  assert.ok(entry, 'manifest must keep the normal user-prompt entry');
  const probe = runProbe(entry, readPayloadText(entry));
  try {
    // Same read-back model as the fixture runner: the plugin's own state module
    // loads the session state the dispatcher just wrote, so the assertion
    // interprets the event store exactly as the runtime does.
    const { statePaths, loadState } = await import(STATE_MODULE_URL);
    const payload = JSON.parse(readPayloadText(entry));
    const state = loadState(statePaths(probe.dataRoot, payload.session_id));
    assert.equal(state.task_type, 'feature', 'classification applied in state');
    assert.equal(state.manager_mode, 'none', 'normal prompt keeps manager mode none');
    assert.deepEqual(state.required_subagents, ['t', 'cr'], 'feature role set persisted');
  } finally {
    probe.cleanup();
  }
});

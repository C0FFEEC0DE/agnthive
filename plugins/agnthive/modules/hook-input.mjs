// hook-input.mjs — robust parsing of Claude Code hook stdin.
// Node standard library only. No shell, no child_process.
//
// Every hook receives one JSON object on stdin. This module parses it
// defensively: empty input is a neutral no-op (not an error), malformed JSON
// is reported but never throws, and arbitrary UTF-8 is preserved. Callers
// branch on `ok`; `error` is for stderr diagnostics, never for blocking.

/** Parse a hook stdin payload (string | Buffer | null) into a normalized input. */
export function parseHookInput(input) {
  let text;
  if (input == null) text = '';
  else if (typeof input === 'string') text = input;
  else if (Buffer.isBuffer(input)) text = input.toString('utf8');
  else text = String(input);

  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, empty: true, error: 'empty stdin', data: {} };

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, empty: false, error: `invalid JSON: ${e.message}`, data: {} };
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, empty: false, error: 'stdin is not a JSON object', data: {} };
  }

  return {
    ok: true,
    empty: false,
    error: null,
    data,
    event: typeof data.hook_event_name === 'string' ? data.hook_event_name : null,
    toolName: typeof data.tool_name === 'string' ? data.tool_name : null,
    toolInput: data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input) ? data.tool_input : {},
    sessionId: typeof data.session_id === 'string' ? data.session_id : null,
    cwd: typeof data.cwd === 'string' ? data.cwd : null,
    transcriptPath: typeof data.transcript_path === 'string' ? data.transcript_path : null,
    // ADR 0003: stop_hook_active signals the runtime is re-invoking the Stop
    // hook after its own block — yield instead of re-blocking.
    stopHookActive: data.stop_hook_active === true,
    // Subagent identity fields consumed by other agents' files; surfaced here
    // so callers can thread them without re-parsing `data`.
    agentId: typeof data.agent_id === 'string' ? data.agent_id : null,
    agentType: typeof data.agent_type === 'string' ? data.agent_type : null,
    // ADR 0010 lifecycle identity: the runtime prompt correlation id. Submit
    // and expansion of the SAME invocation share it — correlation only, never
    // provenance (a duplicate prompt_id is not evidence of message origin).
    promptId: typeof data.prompt_id === 'string' ? data.prompt_id : null,
    // ADR 0010 subagent result ownership: the subagent's own transcript path,
    // documented separately from the parent transcript_path above. Surfaced so
    // report-resolution can prefer the subagent-scoped fallback without
    // re-parsing `data`.
    agentTranscriptPath: typeof data.agent_transcript_path === 'string' ? data.agent_transcript_path : null,
  };
}

/** Read all of process.stdin into a Buffer (resolves to empty buffer on error). */
export function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', () => resolve(Buffer.alloc(0)));
  });
}
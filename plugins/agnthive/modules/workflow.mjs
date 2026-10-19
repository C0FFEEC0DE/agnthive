// workflow.mjs — UserPromptSubmit classification, manager modes, docs/role
// requirements, and stop/subagent loop-block accounting. Pure module: no
// filesystem, no side effects. The dispatcher wires this to state.mjs events
// and hook-output.mjs.
//
// The workflow_profile selector (plan task 11) is resolved by
// plugin-config.mjs (env > plugin.json userConfig > default 'legacy'); this
// module applies its deltas to the classification and exposes the lean /
// legacy gate flags a dispatcher consults at the summary-contract/verify gate
// call sites. ADR 0012: lean is experimental this release — the default stays
// 'legacy' and nothing here performs the default flip. Ported from claudecfg/hooks/user-prompt-submit.sh and
// the lib.sh functions task_type_requires_implementation_summary,
// task_type_requires_specialist_handoffs, record_loop_block, clear_loop_block,
// loop_block_count, session_background_manager_pending.
//
// Regexes use the 'iu' flags so [[:alpha:]] -> \p{L}, [[:space:]] -> \s,
// [[:punct:]] -> \p{P} behave like grep -Ei in a UTF-8 locale (case-insensitive
// for Latin and Cyrillic). Node 22+ supports these Unicode classes.

const STOP_SAFE_HINT = ' If a later reply in the same session makes no additional changes, still report the actual verification, review, changed files, docs status when relevant, and remaining risks instead of using a no-change shortcut after code or config changes.';

const RE_MANAGER_ORCHESTRATE = /(^|\s)(@m|@manager|\/manager)($|[\s\p{P}])/iu;
const RE_PLAN_ONLY = /(plan only|only plan|plan-only|только план|только спланиру|только составь план|сделай план,? но не выполняй|без выполнения|без реализации)/iu;
const RE_OVERRIDE = /workflow override: treat this as a (feature|bugfix|refactor|review|docs|support|other) workflow/i;
const RE_WORKFLOW_CATEGORY = /workflow_category:\s*(feature|bugfix|refactor|review|docs|support|other)/i;

// Machine-readable dispatch contract injected by the benchmark runner into the
// ROOT prompt only (see bench_runner_claude_code.mjs dispatchContractMarker).
// When present, the plugin requires exactly the listed specialist(s) instead of
// the category-default role set, so a tiny task is not forced to also dispatch
// @t/@cr/one-of groups that the runner does not ask for.
// Fixed single-space form: dispatchContractMarker() always emits
// "BENCHMARK_DISPATCH_CONTRACT: [root_only; ]mode=…; roles=…". Literal spaces
// (not \s*) avoid the polynomial backtracking CodeQL flags on long \t runs.
const RE_DISPATCH_CONTRACT = /BENCHMARK_DISPATCH_CONTRACT: (root_only; )?mode=(observed|enforced|standard); roles=([A-Za-z0-9_,-]{1,64})/i;

// === workflow profile (plan task 11; ADR 0008/0009/0012) ====================

// Precedence (highest first), resolved by plugin-config.mjs
// resolveWorkflowProfile and re-exported here so gate code has one surface:
// AGNTHIVE_WORKFLOW_PROFILE (env override) >
// CLAUDE_PLUGIN_OPTION_WORKFLOW_PROFILE (the plugin.json userConfig bridge) >
// default 'legacy'. Validation in the resolver (enum + stderr note); the
// profile is a workflow-shape knob only — it never changes a permission
// decision or a failure class (ADR 0011). ADR 0012: lean is experimental in
// this release — the default stays 'legacy' in the manifest, in the state
// schema, and in the resolver; the default flip is task 16 and is gated on the
// ADR 0012 outcome-benchmark evidence (plan task 10). Nothing here performs
// that switch.
export { WORKFLOW_PROFILES, DEFAULT_WORKFLOW_PROFILE } from './plugin-config.mjs';

/**
 * Validate an already-resolved profile value (defensive: the env/userConfig
 * enum check is resolveWorkflowProfile's job, while session state and explicit
 * wiring-side values are validated here). Trimmed, lowercased; anything that
 * is not exactly 'legacy' or 'lean' falls back to 'legacy' — a documented
 * fallback, not an error.
 */
function validProfileValue(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'legacy' || s === 'lean' ? s : 'legacy';
}

/**
 * Lean-vs-legacy gate flags (plan task 11.2/11.4; ADR 0008/0009). Pure
 * projection the orchestrator consults at the summary-contract/verify gate
 * call sites — the Stop / TaskCompleted / TeammateIdle handlers in
 * hook-dispatcher.mjs (plus the SubagentStop footer contract, which is the
 * footer part of the same relaxations). The legacy branch pins today's
 * behavior exactly so the same wiring can serve both profiles without a second
 * code path; the lean branch marks the deltas. The flags never decide a
 * permission output and never change a failure class (ADR 0011: profile
 * handlers keep the failure classes of the events they serve; no new
 * enforce-class registrations).
 *
 * `profile` is the optional resolved profile ('legacy'|'lean'). When omitted,
 * the flags read session state's workflow_profile (the orchestrator persists
 * resolveWorkflowProfile().profile there — the wiring contract in the task
 * report), so an old/uninitialized state (schema default 'legacy') keeps the
 * legacy gates. An invalid value falls back to 'legacy' (a fallback, not an
 * error — the same rule the resolver applies to a non-empty invalid override).
 *
 *   legacy: lean=false, benchContractOnly=false, every gate flag on.
 *   lean:   benchContractOnly=true, enforceRoleQuotas=false,
 *           enforceManagerIdleGate=false, enforceFooterGates=false;
 *           review + verification gates stay on (ADR 0009).
 */
export function leanProfileGates(state = null, profile = null) {
  const resolved = validProfileValue(profile ?? state?.workflow_profile ?? null);
  const lean = resolved === 'lean';
  return {
    profile: resolved,
    lean,
    // F03 / plan 05.9: in lean the BENCHMARK_DISPATCH_CONTRACT marker defines
    // roles only in a benchmark test context; outside one it is a claim only.
    benchContractOnly: lean,
    // ADR 0009 (plan 11.2): mandatory role quotas and tester-as-proof stop
    // gating (the t/doc/one-of quotas are dropped); @cr survives through the
    // classification filter and enforceReviewGate.
    enforceRoleQuotas: !lean,
    // ADR 0008 (plan 11.2/12.1): specialists coordinate without a required
    // root (Manager) role — the mandatory-Manager idle gate relaxes.
    enforceManagerIdleGate: !lean,
    // Kept in lean: substantial/security changes still require an independent
    // review of the current diff (ADR 0008), and known failed checks must stay
    // visible (ADR 0009).
    enforceReviewGate: true,
    enforceVerificationGate: true,
    // ADR 0009 / plan 11.4: footer lines are reporting guidance in lean, not
    // blocking syntax contracts; missing punctuation alone never continues a
    // turn.
    enforceFooterGates: !lean,
  };
}

/**
 * The lean-enforced role requirement projected from state's recorded contract
 * (plan task 11.2): role quotas and tester-as-proof stop gating — the
 * t/doc/one-of requirements are dropped — while the @cr requirement survives
 * when the recorded category carries it. The orchestrator feeds this into
 * sessionAgentEnforcementReason under a lean profile, so a task classified (or
 * session state persisted) under legacy does not keep blocking lean completion
 * on @t/@doc/one-of roles after a mid-session profile change.
 */
export function leanRequiredRoles(state = null) {
  const required = Array.isArray(state?.required_subagents) ? state.required_subagents : [];
  const cr = required.includes('cr');
  return {
    required: cr ? ['cr'] : [],
    anyOf: [],
    // docs_required is a decision flag, not a role quota (plan 11.6): the
    // Docs status: line stays required-advisory when behavior changes and a
    // not_required decision explains the skip.
    docsRequired: state?.docs_required === true,
  };
}

/**
 * The lean context message (plan task 11): root-led orchestration without
 * mandatory Manager/role quotas; verification evidence and @cr-when-substantial
 * stay; footers are reporting guidance. `base` is the per-category lead-in the
 * switch already produced ("Treat this as a <k> workflow."). Compact on
 * purpose — the per-category quota sentences remain in the legacy branch,
 * byte-identical.
 */
function buildLeanContextMessage(taskType, base, managerMode) {
  const reviewClause = taskType === 'review'
    ? 'Completion still requires the independent @cr handoff'
    : 'Completion still requires current verification evidence for the changes and the independent @cr review when the change is substantial or security-sensitive';
  const parts = [
    `${base} Lean profile (experimental; ADR 0008/0009/0012) is active: the root session orchestrates, no Manager dispatch and no role quotas are required.`,
    `${reviewClause}; account for known failures and report an honest unresolved status for them.`,
    `Summary/footer lines are reporting guidance, not blocking gates.${STOP_SAFE_HINT}`,
  ];
  if (managerMode === 'orchestrate') {
    parts.push('The /manager entry stays a compatible root skill; it does not spawn a mandatory Manager agent.');
  }
  return parts.join(' ');
}

const RE_MODEL_TERMS = /(model|models|llm|ollama|openrouter|qwen|llama|deepseek|mistral|claude|gpt|gemini|command r|модел|модели|модель)/iu;
const RE_QUESTION_TERMS = /(which|what|recommend|recommendation|compare|best|better|vs|versus|open source|opensource|closed model|api|creative|creativity|style|storytelling|какую|какой|посовет|совет|рекоменд|сравн|лучш|выбрат|подскажи|подбери|нужн|креатив|стиль|сторител|иде[йи])/iu;
const RE_EXCLUSION_TERMS = /(feature|implement|add support|integrat|new capability|фич|добав|интеграц|подключ|fix|bug|defect|баг|ошиб|исправ|refactor|rename|cleanup|tech debt|рефактор|почист|переимен|review|audit|ревью|аудит|проверь|docs|readme|document|док|ридми)/iu;

const RE_BUGFIX = /(^|[^\p{L}])(bugfix|bug|defect|regression|fix|fixes|fixed|fixing|баг|ошиб|исправ)([^\p{L}]|$)/iu;
const RE_REFACTOR = /(refactor|rename|cleanup|tech debt|рефактор|почист|переимен)/iu;
const RE_REVIEW = /(review|audit|ревью|аудит|проверь)/iu;
const RE_DOCS = /(docs|readme|document|док|ридми)/iu;
const RE_FEATURE = /(feature|implement|add support|integrat|new capability|фич|добав|интеграц|подключ|модел|pyrit|openrouter)/iu;

const RE_CODE_SIGNALS = /(\.py\b|\.js\b|\.ts\b|\.tsx\b|\.jsx\b|\.rs\b|\.go\b|\.java\b|\.kt\b|\.c\b|\.cc\b|\.cpp\b|\.h\b|\.hpp\b|package\.json\b|pyproject\.toml\b|cargo\.toml\b|go\.mod\b|pom\.xml\b|build\.gradle\b|cmakelists\.txt\b|makefile\b|dockerfile\b|src\/|tests?\/|pytest\b|jest\b|vitest\b|npm\b|yarn\b|pnpm\b|pip\b|venv\b|ci\b|github actions\b|pull request\b|commit\b|branch\b|diff\b|patch\b|код\b|файл\b|репозитор|проект\b)/iu;
const RE_TECH_SUPPORT_SIGNALS = /(fedora|ubuntu|debian|arch linux|kernel|ядро|dmesg|lsusb|udev|systemctl|modemmanager|ttyusb|ttys|\/dev\/tty|dialout|uucp|com[- ]?port|rs[- ]?232|serial|usb[- ]?to[- ]?serial|driver|драйвер|pilot[- ]?link|hotsync|palm\b|palmos|кредл|док[- ]?станц)/iu;

const TASK_TYPES = ['feature', 'bugfix', 'refactor', 'review', 'docs', 'support', 'other'];

function uniq(arr) {
  return [...new Set(arr)];
}

// ADR-0007: the 'agnthive' namespace literal is plugin identity. Only an
// empty namespace (plain slash command) or this exact (case-insensitive) one
// routes into this plugin's procedures (plan task 05.1, design F06).
const OWN_PLUGIN_NAMESPACE = 'agnthive';

/**
 * Normalize a typed (namespaced) slash command: { namespace, command, args }.
 * Plan task 05.1 / design F06. Returns null when the prompt does not begin
 * with a slash-command token; the leading `/` token is the first
 * non-whitespace token. The FIRST colon splits `ns:cmd` — later colons belong
 * to the command ('/agnthive:manager:extra' -> command 'manager:extra', which
 * routes to nothing). The plugin-owned namespaces are the EXACT
 * (case-insensitive) 'agnthive' and the EMPTY namespace (plain '/manager'); a
 * foreign namespace ('/other:manager') is still returned (normalized, never
 * erased — ADR-0010) but never activates local roles.
 *
 * Examples:
 *   '/agnthive:manager implement new feature' -> { namespace: 'agnthive', command: 'manager', args: 'implement new feature' }
 *   '/manager'                                -> { namespace: '',        command: 'manager', args: '' }
 *   '/other:manager x'                        -> { namespace: 'other',   command: 'manager', args: 'x' }  (foreign)
 *   '/:manager x'                             -> null (degenerate — empty namespace text, not our shape)
 *   'implement new feature'                   -> null
 *
 * Pure; no I/O, no state.
 */
export function parseSlashedCommand(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(/^\s*\/(\S+)/);
  if (!m) return null;
  const token = m[1];
  const colon = token.indexOf(':');
  if (colon === 0) return null; // '/:cmd' — empty namespace text is degenerate, not our shape
  const namespace = colon >= 1 ? token.slice(0, colon) : '';
  const command = colon >= 1 ? token.slice(colon + 1) : token;
  if (!command) return null;
  const args = prompt.slice(m[0].length).replace(/^\s+/, '');
  return { namespace, command, args };
}

/**
 * Parse a BENCHMARK_DISPATCH_CONTRACT marker from a prompt. Returns
 * { rootOnly, mode, roles } (roles lowercased canonical aliases) or null when
 * no marker is present. Pure; no I/O.
 */
export function parseDispatchContractMarker(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(RE_DISPATCH_CONTRACT);
  if (!m) return null;
  const roles = String(m[3]).split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
  if (!roles.length) return null;
  return { rootOnly: Boolean(m[1]), mode: String(m[2]).toLowerCase(), roles };
}

/**
 * Classify a user prompt. Returns the task type, manager mode, required
 * subagents, any-of groups, docs-required flag, the context message to emit
 * (or '' to emit nothing), and the workflow profile the classification
 * applied (plan task 11). Pure; no I/O.
 *
 * opts (optional; absent for every existing caller, which keeps the unchanged
 * legacy behavior):
 *   profile      — the resolved workflow profile ('legacy' when absent or
 *                  invalid: the documented fallback, so a misconfigured value
 *                  degrades rather than errors).
 *   benchContext — true when this prompt arrived in a benchmark test context
 *                  (the orchestrator derives it from
 *                  command-policy.isBenchmarkCi(env)). Legacy ignores it; lean
 *                  uses it to scope the BENCHMARK_DISPATCH_CONTRACT (F03).
 */
export function classifyPrompt(prompt, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  // Defensive enum validation: an absent/invalid value keeps the documented
  // default 'legacy', so existing single-argument callers are byte-identical.
  const lean = validProfileValue(options.profile) === 'lean';
  const benchContext = options.benchContext === true;
  const text = typeof prompt === 'string' ? prompt : '';
  let taskType = 'other';
  let managerMode = 'none';
  let requiredSubagents = [];
  let requiredSubagentAnyOf = [];
  let contextMessage = '';

  if (RE_MANAGER_ORCHESTRATE.test(text)) managerMode = 'orchestrate';
  // F06 / ADR-0010: a leading namespaced slash command routes into the same
  // manager orchestrate procedure as the legacy mid-text /manager regex match
  // when the namespace is plugin-owned ('' plain /manager, or 'agnthive',
  // case-insensitive — ADR-0007: the plugin namespace is the owned prefix).
  // Foreign namespaces (/other:manager) NEVER activate local roles (they stay
  // managerMode 'none'); their arg text still flows through the unchanged
  // category classification below — a documented legacy behavior: only slash
  // routing changed here, per plan task 05.1.
  const slash = parseSlashedCommand(text);
  if (slash
    && slash.command.toLowerCase() === 'manager'
    && (slash.namespace === '' || slash.namespace.toLowerCase() === OWN_PLUGIN_NAMESPACE)) {
    managerMode = 'orchestrate';
  }
  if (RE_PLAN_ONLY.test(text)) managerMode = 'plan_only';

  let overrideTaskType = '';
  const ov = text.match(RE_OVERRIDE);
  if (ov) overrideTaskType = ov[1];
  if (!overrideTaskType) {
    const cat = text.match(RE_WORKFLOW_CATEGORY);
    if (cat) overrideTaskType = cat[1];
  }

  const informationalModelQuery =
    RE_MODEL_TERMS.test(text)
    && RE_QUESTION_TERMS.test(text)
    && !RE_EXCLUSION_TERMS.test(text);

  if (overrideTaskType) {
    taskType = overrideTaskType;
  } else if (informationalModelQuery) {
    taskType = 'other';
  } else if (RE_BUGFIX.test(text)) {
    taskType = 'bugfix';
  } else if (RE_REFACTOR.test(text)) {
    taskType = 'refactor';
  } else if (RE_REVIEW.test(text)) {
    taskType = 'review';
  } else if (RE_DOCS.test(text)) {
    taskType = 'docs';
  } else if (RE_FEATURE.test(text)) {
    taskType = 'feature';
  }

  // Tech-support reclassification: a device/OS support prompt with no code
  // signals becomes "support" even if it contains the word "bug".
  if (!overrideTaskType && !informationalModelQuery && taskType !== 'other') {
    const hasCodeSignals = RE_CODE_SIGNALS.test(text);
    const hasTechSupportSignals = RE_TECH_SUPPORT_SIGNALS.test(text);
    if (hasTechSupportSignals && !hasCodeSignals) taskType = 'support';
  }

  if (managerMode === 'plan_only') {
    requiredSubagents = [];
    requiredSubagentAnyOf = [];
  }

  let docsRequired = false;
  switch (taskType) {
    case 'feature':
      if (managerMode !== 'plan_only') {
        requiredSubagents = uniq([...requiredSubagents, 't', 'cr']);
        requiredSubagentAnyOf = [['e', 'a']];
      }
      contextMessage = 'Treat this as a feature workflow.';
      docsRequired = true;
      break;
    case 'bugfix':
      if (managerMode !== 'plan_only') {
        requiredSubagents = uniq([...requiredSubagents, 't', 'cr']);
        requiredSubagentAnyOf = [['bug', 'e', 'dbg']];
      }
      contextMessage = 'Treat this as a bugfix workflow.';
      docsRequired = true;
      break;
    case 'refactor':
      if (managerMode !== 'plan_only') {
        requiredSubagents = uniq([...requiredSubagents, 't', 'cr']);
        requiredSubagentAnyOf = [['a', 'e']];
      }
      contextMessage = 'Treat this as a refactor workflow.';
      docsRequired = true;
      break;
    case 'review':
      if (managerMode !== 'plan_only') {
        requiredSubagents = uniq([...requiredSubagents, 'cr']);
      }
      contextMessage = 'Treat this as a review workflow.';
      break;
    case 'docs':
      if (managerMode !== 'plan_only') {
        requiredSubagents = uniq([...requiredSubagents, 'doc']);
      }
      contextMessage = 'Treat this as a docs workflow.';
      docsRequired = true;
      break;
    case 'support':
      contextMessage = 'Treat this as a support workflow.';
      break;
    default:
      break;
  }

  // Lean profile (plan task 11.2, ADR 0009): role quotas are advisory-first —
  // drop the tester-as-proof and docs-persona quotas and the one-of groups,
  // keep @cr only. Applied BEFORE the dispatch-contract override, so a
  // benchmark contract honored in its test mode still defines the roles.
  if (lean) {
    requiredSubagents = requiredSubagents.filter((r) => r === 'cr');
    requiredSubagentAnyOf = [];
  }

  if (contextMessage) {
    // plan task 11: the lean classification re-words the completion contract
    // (root-led, no mandatory Manager/role quotas, @cr + verification evidence
    // kept); plan-only and the non-gated support/other tasks keep the legacy
    // wording.
    contextMessage = lean && managerMode !== 'plan_only'
      ? buildLeanContextMessage(taskType, contextMessage, managerMode)
      : buildContextMessage(taskType, managerMode, contextMessage);
  }

  // A benchmark dispatch contract (root-only marker) overrides the
  // category-default required roles: require exactly the listed specialist(s)
  // and clear any-of groups, so runner and hook agree on a single contract.
  //
  // F03 / plan 05.9 (lean delta): the marker is scoped to benchmark tests — it
  // only drives the roles/mode when the caller signals a benchmark test
  // context; outside one it is a claim only. Legacy applies the marker
  // unconditionally (unchanged behavior).
  const dispatchContract = parseDispatchContractMarker(text);
  const dispatchContractActive = Boolean(dispatchContract && (!lean || benchContext));
  if (dispatchContractActive) {
    requiredSubagents = dispatchContract.roles;
    requiredSubagentAnyOf = [];
    const roles = dispatchContract.roles.map((r) => '@' + r).join(', ');
    contextMessage =
      `Benchmark dispatch contract active (mode=${dispatchContract.mode}, root_only). ` +
      `Required specialist handoff before completion: ${roles}. ` +
      `Only the listed role(s) satisfy the contract; do not add category-default specialist handoffs. ` +
      `Run verification after changes and report changed files and remaining risks before stopping.${STOP_SAFE_HINT}`;
  }

  // F03 (lean only): a marker outside a benchmark test context is a claim —
  // report the scoping instead of silently swallowing the marker's text.
  const dispatchContractClaimOnly = Boolean(dispatchContract && !dispatchContractActive);
  if (dispatchContractClaimOnly) {
    const note = ' A benchmark dispatch contract marker was present but ignored: lean scopes dispatch contracts to a benchmark test context.';
    contextMessage = contextMessage ? contextMessage + note : note.trim();
  }

  return {
    taskType,
    managerMode,
    requiredSubagents,
    requiredSubagentAnyOf,
    docsRequired,
    contextMessage,
    informationalModelQuery,
    overrideTaskType,
    // Workflow profile applied by this classification (plan task 11): the
    // validated value the caller passed; 'legacy' also covers an absent or
    // invalid value (the documented fallback rule). The dispatcher persists it
    // to session state so leanProfileGates(state) has a single state read.
    profile: lean ? 'lean' : 'legacy',
    // Benchmark dispatch-contract mode from the BENCHMARK_DISPATCH_CONTRACT
    // marker ('' when absent, or scoped out in lean outside a benchmark test
    // context). Persisted to session state so the PreToolUse EditWrite guard
    // can enforce 'enforced' without re-reading the prompt.
    dispatchContractMode: dispatchContractActive ? dispatchContract.mode : '',
    // F03: true only in lean when a marker was present but NOT applied
    // (outside a benchmark test context) — a diagnostic claim, never
    // workflow-defining.
    dispatchContractClaimOnly,
  };
}

function buildContextMessage(taskType, managerMode, base) {
  const orchestrate = managerMode === 'orchestrate';
  const planOnly = managerMode === 'plan_only';
  switch (taskType) {
    case 'feature':
      if (orchestrate) return `${base} Manager-led orchestration is active. Required before completion: successful verification or @t, plus @cr and one of @e/@a. Start the first required specialist handoff early instead of spending multiple turns in manager-only exploration. Keep the workflow moving through implementation, verification, review, and docs when behavior changes.${STOP_SAFE_HINT}`;
      if (planOnly) return `${base} Plan-only manager mode is active. Return a concrete execution plan without continuing implementation or specialist handoffs in this session.`;
      return `${base} Required before completion: successful verification or @t, plus @cr and one of @e/@a. Finish implementation, run verification successfully, address review findings, and update docs when behavior changes. release/deploy remains out of scope.${STOP_SAFE_HINT}`;
    case 'bugfix':
      if (orchestrate) return `${base} Manager-led orchestration is active. Required before completion: successful verification or @t, plus @cr and one of @bug/@e/@dbg. Start the first required specialist handoff early instead of spending multiple turns in manager-only exploration. Reproduce or describe the failure mode, implement the fix, execute regression verification, and update docs if behavior changed.${STOP_SAFE_HINT}`;
      if (planOnly) return `${base} Plan-only manager mode is active. Return a concrete bugfix plan without continuing implementation or specialist handoffs in this session.`;
      return `${base} Required before completion: successful verification or @t, plus @cr and one of @bug/@e/@dbg. Reproduce or describe the failure mode, implement the fix, execute regression verification, and update docs if behavior changed.${STOP_SAFE_HINT}`;
    case 'refactor':
      if (orchestrate) return `${base} Manager-led orchestration is active. Required before completion: successful verification or @t, plus @cr and one of @a/@e. Start the first required specialist handoff early instead of spending multiple turns in manager-only exploration. Keep scope to structure and maintainability, preserve behavior, run verification after changes, and decide whether docs need updates.${STOP_SAFE_HINT}`;
      if (planOnly) return `${base} Plan-only manager mode is active. Return a concrete refactor plan without continuing implementation or specialist handoffs in this session.`;
      return `${base} Required before completion: successful verification or @t, plus @cr and one of @a/@e. Keep scope to structure and maintainability, preserve behavior, run verification after changes, and summarize risks plus changed files before stopping.${STOP_SAFE_HINT}`;
    case 'review':
      if (orchestrate) return `${base} Manager-led orchestration is active. Required specialist handoff before completion: @cr. Start the code-reviewer handoff early instead of extending manager-only analysis. Focus on findings first, call out residual risks or testing gaps, and keep implementation out of scope unless the user explicitly asks for fixes.${STOP_SAFE_HINT}`;
      if (planOnly) return `${base} Plan-only manager mode is active. Return the review plan without continuing specialist handoffs in this session.`;
      return `${base} Required subagent handoff before completion: @cr. Focus on findings first, call out residual risks or testing gaps, and keep implementation out of scope unless the user explicitly asks for fixes.${STOP_SAFE_HINT}`;
    case 'docs':
      if (orchestrate) return `${base} Manager-led orchestration is active. Required specialist handoff before completion: @doc. Start the docwriter handoff early instead of extending manager-only analysis. Keep documentation accurate to current behavior, include examples when they materially help, and note any remaining drift or missing verification.${STOP_SAFE_HINT}`;
      if (planOnly) return `${base} Plan-only manager mode is active. Return the docs plan without continuing specialist handoffs in this session.`;
      return `${base} Required subagent handoff before completion: @doc. Keep documentation accurate to current behavior, include examples when they materially help, and note any remaining drift or missing verification.${STOP_SAFE_HINT}`;
    case 'support':
      if (planOnly) return `${base} Plan-only manager mode is active. Return the diagnostic plan without implementation or specialist handoffs in this session.`;
      return `${base} Keep this in advisory or troubleshooting mode unless the user explicitly requests repository changes. No workflow-specific specialist handoffs are required before completion.`;
    default:
      return base;
  }
}

/** task_type_requires_implementation_summary: feature|bugfix|refactor|review|docs. */
export function taskTypeRequiresImplementationSummary(taskType) {
  return taskType === 'feature' || taskType === 'bugfix' || taskType === 'refactor'
    || taskType === 'review' || taskType === 'docs';
}

/** task_type_requires_specialist_handoffs: feature|bugfix|refactor|review|docs|support. */
export function taskTypeRequiresSpecialistHandoffs(taskType) {
  return taskTypeRequiresImplementationSummary(taskType) || taskType === 'support';
}

/**
 * Map a loop-block prefix to its state field layout, or null if unknown.
 *
 * The `stop` prefix is a session-global scalar (the main agent has no
 * agent_id); the `subagent_stop` prefix is a per-agent map keyed by agent_id
 * so cross-agent accumulation can no longer terminate processing (ADR-0002).
 * When agent_id is absent, a shared `_session` key keeps the safety backstop
 * working for runtimes that omit agent_id.
 *
 * The two layouts are frozen module-level constants so every caller
 * (`loopBlockCount`, `recordLoopBlock`, `clearLoopBlockPatch`,
 * `emitLoopAwareBlock`) shares one reference instead of allocating a fresh
 * object per call — `loopBlockFields` is on the block hot path and may be
 * called more than once per block.
 */
const STOP_FIELDS = Object.freeze({
  countKey: 'stop_block_count',
  reasonKey: 'stop_block_reason',
  messageKey: 'stop_block_message',
  perAgent: false,
});
const SUBAGENT_STOP_FIELDS = Object.freeze({
  mapKey: 'subagent_stop_blocks',
  perAgent: true,
});

export function loopBlockFields(prefix) {
  switch (prefix) {
    case 'stop': return STOP_FIELDS;
    case 'subagent_stop': return SUBAGENT_STOP_FIELDS;
    default: return null;
  }
}

/**
 * The per-agent loop-block key: the agent's id when present, else the shared
 * `_session` backstop for runtimes that omit `agent_id`. Single source of truth
 * for the fallback (ADR 0006) — every per-agent loop-block site calls this.
 */
export function agentLoopKey(agentId) {
  return agentId || '_session';
}

/**
 * Read the current loop-block count for a prefix from a state object. The
 * scalar `stop` branch is the production read path — `hasPriorStopBlock` (the
 * ADR-0003 amendment gate) reads through it, so the count-read rule lives in one
 * place. The per-agent `subagent_stop` branch is model-completeness + a
 * test-pinned read contract: production carries the per-agent count forward via
 * `recordLoopBlock`'s returned `entry.count` (ADR-0005), not by re-reading state
 * here. It is kept for API symmetry and as a diagnostic/debug surface.
 */
export function loopBlockCount(state, prefix, agentId = null) {
  const f = loopBlockFields(prefix);
  if (!f) return 0;
  if (f.perAgent) {
    return Number(state?.[f.mapKey]?.[agentLoopKey(agentId)]?.count) || 0;
  }
  return Number(state?.[f.countKey]) || 0;
}

/**
 * Compute the next loop-block entry. If reason+message match the previous
 * values, the count increments; otherwise it resets to 1. Pure.
 *
 * For the per-agent `subagent_stop` prefix, returns `{ mapKey, key, entry }`
 * — the single changed key plus its new `{ count, reason, message }` entry,
 * with no full-map snapshot. The dispatcher persists `entry` via a single-key
 * `map_set` (ADR-0002 race fix), and `emitLoopAwareBlock` threads it straight
 * into `perKey`, so the merged map is never needed (ADR-0005: carry the entry
 * explicitly). For the session-global `stop` prefix, returns the scalar patch
 * (`{ [countKey], [reasonKey], [messageKey] }`) persisted as-is via `set_many`.
 */
export function recordLoopBlock(state, prefix, reason, message, agentId = null) {
  const f = loopBlockFields(prefix);
  if (!f) return null;
  if (f.perAgent) {
    const map = state?.[f.mapKey] || {};
    const key = agentLoopKey(agentId);
    const prev = map[key];
    const nextCount = (prev?.reason === reason && prev?.message === message)
      ? (Number(prev.count) || 0) + 1 : 1;
    return { mapKey: f.mapKey, key, entry: { count: nextCount, reason, message } };
  }
  const prevReason = state?.[f.reasonKey] ?? '';
  const prevMessage = state?.[f.messageKey] ?? '';
  const prevCount = Number(state?.[f.countKey]) || 0;
  const nextCount = (prevReason === reason && prevMessage === message) ? prevCount + 1 : 1;
  return {
    [f.countKey]: nextCount,
    [f.reasonKey]: reason,
    [f.messageKey]: message,
  };
}

/**
 * Patch that clears the session-global `stop` loop block (and policy-stall
 * state). Scalar-only: the per-agent `subagent_stop` clear is no longer routed
 * through this function — the dispatcher clears one agent key via a `map_delete`
 * event (see hook-dispatcher.mjs `handleSubagentStop`), which avoids the
 * last-writer-wins full-map clobber a `set_many`-based clear would reintroduce.
 */
export function clearLoopBlockPatch(prefix) {
  const f = loopBlockFields(prefix);
  if (!f || f.perAgent) return null;
  return {
    [f.countKey]: 0,
    [f.reasonKey]: '',
    [f.messageKey]: '',
    stalled_by_policy: false,
    policy_stall_reason: '',
  };
}

/**
 * True when there is evidence of a prior `stop` block this session: a non-zero
 * session-global stop-block count, or a terminal policy stall. ADR-0003
 * amendment: the `stop_hook_active` yield is gated on this so a runtime that
 * erroneously sets the flag on a first Stop invocation cannot silently disable
 * enforcement. Encapsulates the two-field policy check so the dispatcher states
 * policy rather than field names, and routes the read through `loopBlockCount`
 * (the declared single read path) instead of restating the scalar field inline.
 */
export function hasPriorStopBlock(state) {
  return loopBlockCount(state, 'stop') > 0 || state?.stalled_by_policy === true;
}

/**
 * A real user prompt starts a new attempt after a terminal stop-hook failure,
 * so the stop loop resets. Returns a structured reset applied on
 * UserPromptSubmit (after classification):
 *   - `scalar`: the session-global stop-loop + policy-stall fields, persisted
 *     as one `set_many`.
 *   - `mapClears`: per-agent maps to clear via `map_clear` events (ADR-0002
 *     amendment) — NOT folded into the scalar set_many. This keeps the invariant
 *     "all subagent_stop_blocks mutations flow through map_* events" with zero
 *     exceptions (model consistency). It is NOT a per-key race fix: a clear is
 *     intentionally whole-map (a new turn starts fresh), so a concurrent map_set
 *     appended before the clear is wiped just as a set_many would. The ADR-0002
 *     race fix proper is the per-key map_set/map_delete write path.
 *
 * The dispatcher emits the scalar patch and one `map_clear` per listed map.
 */
export function userPromptResetPatch() {
  return {
    scalar: {
      stop_block_count: 0,
      stop_block_reason: '',
      stop_block_message: '',
      stalled_by_policy: false,
      policy_stall_reason: '',
    },
    mapClears: ['subagent_stop_blocks'],
  };
}

/**
 * session_background_manager_pending: true only when a gated task is in
 * orchestrate mode with no code change yet, a backgrounded agent is in flight,
 * and the manager role has started. Pure; the dispatcher supplies the
 * transcript-derived `backgroundedAgent` flag and `startedRoles` list.
 */
export function sessionBackgroundManagerPending({ taskType, managerMode, codeChanged, backgroundedAgent, startedRoles }) {
  if (!taskTypeRequiresImplementationSummary(taskType)) return false;
  if (managerMode !== 'orchestrate') return false;
  if (codeChanged === true) return false;
  if (!backgroundedAgent) return false;
  if (!Array.isArray(startedRoles) || !startedRoles.includes('m')) return false;
  return true;
}

export { STOP_SAFE_HINT, TASK_TYPES };

// === ADR-0010 (plan tasks 05.2-05.6, 05.9): task identity, prompt
// correlation and reset discipline ===========================================

const USER_PROMPT_SCALAR_RESET = Object.freeze({
  stop_block_count: 0,
  stop_block_reason: '',
  stop_block_message: '',
  stalled_by_policy: false,
  policy_stall_reason: '',
});

function safeString(v) {
  return typeof v === 'string' ? v : '';
}

function sameStringArray(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameStringArrayList(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  return x.length === y.length && x.every((g, i) => sameStringArray(g, y[i]));
}

// --- prompt correlation (plan 05.2) -----------------------------------------

/**
 * ADR-0010 prompt correlation (plan task 05.2): UserPromptSubmit and
 * UserPromptExpansion of the same invocation must not reset state twice.
 *
 * Returns { dedupe, fields } — `fields` is the correlation patch for this
 * submission: { prompt_seq, last_prompt_id }.
 *
 *   - dedupe is TRUE only when BOTH a runtime prompt_id was supplied AND it
 *     equals the previously classified prompt_id AND the classification this
 *     submission derives matches the persisted classification (the
 *     "text unchanged since last classification" check — state.mjs belongs to
 *     the orchestrator and carries no last-prompt-text field, so unchanged
 *     text is expressed as classification-equality; see
 *     classificationUnchanged below). prompt_id equality alone is
 *     correlation, never provenance (ADR-0010/D.3 of the harness review):
 *     it never turns a submission into a background result or a new task by
 *     itself, and it never proves the message came from a human.
 *
 *   - prompt_seq increments per NEW classified prompt (a deduped delivery
 *     does not count again) and is the identity number task ids derive from.
 *
 * `parsed` is the parseHookInput shape (hook-input.mjs surfaces
 * parsed.promptId from data.prompt_id). `state` is the current session state
 * (read-only input; treated as {} when absent). Pure; no I/O — the dispatcher
 * decides whether to persist fields and whether to skip the double reset.
 */
export function promptCorrelationPatch(parsed, state = null, cls = null) {
  const promptId = typeof parsed?.promptId === 'string' ? parsed.promptId : '';
  const s = state && typeof state === 'object' ? state : {};
  const prevSeq = Number(s.prompt_seq) || 0;
  const prevId = typeof s.last_prompt_id === 'string' ? s.last_prompt_id : '';
  const dedupe = promptId !== '' && promptId === prevId && classificationUnchanged(cls, s);
  return {
    dedupe,
    fields: {
      prompt_seq: dedupe ? prevSeq : prevSeq + 1,
      last_prompt_id: promptId,
    },
  };
}

/**
 * "Classification unchanged since last classification" comparator (ADR-0010,
 * plan 05.2): state.mjs belongs to the orchestrator and carries no
 * last-prompt-text field, so the "text unchanged since last classification"
 * check is expressed as equality of the classification derived from this
 * submission against the persisted classification. Not exported: it is an
 * implementation detail of promptCorrelationPatch's dedupe predicate.
 */
function classificationUnchanged(cls, state) {
  if (!cls || typeof cls !== 'object') return false;
  return (cls.taskType || 'other') === (state.task_type || 'other')
    && (cls.managerMode || 'none') === (state.manager_mode || 'none')
    && (cls.docsRequired === true) === (state.docs_required === true)
    && (cls.dispatchContractMode || '') === (state.dispatch_contract_mode || '')
    && sameStringArray(cls.requiredSubagents, state.required_subagents)
    && sameStringArrayList(cls.requiredSubagentAnyOf, state.required_subagent_any_of);
}


// --- task identity (plan 05.3-05.5) -----------------------------------------

const MAX_REFINEMENTS = 10;
const MAX_REFINEMENT_TEXT = 240;

/**
 * ADR-0010 task lifecycle (plan tasks 05.3-05.5): explicit
 * start/continue/complete/new-task transitions separate TASK identity from
 * PROMPT identity. Pure; no I/O.
 *
 * prev   — prior session state (or any object carrying {task_id,
 *          active_task, last_task_id, prompt_seq, revision}); null-safe.
 * cls    — classification from classifyPrompt(prompt).
 * input  — dispatcher-supplied VERIFIED signal combination (never derived
 *          from prompt text alone beyond classification):
 *   promptId              — runtime prompt_id for this submission ('' absent)
 *   prompt                — prompt text (only used to record the refinement)
 *   dedupe                — from promptCorrelationPatch: a duplicate delivery
 *                           is never a boundary and never re-appends
 *   backgroundCorrelation — the submission correlates to known pending
 *                           background work (a non-empty background_tasks
 *                           registry per ADR-0010); the dispatcher derives it
 *                           from the registry, never from prompt_id presence
 *   completed             — a VERIFIED completion signal for the open task
 *                           (benchmark marker path, or registry-evidenced
 *                           completion). NEVER raw text matching: the F02
 *                           reproduction shows an assistant/background
 *                           "Outcome: DONE..." report must not complete the
 *                           contract.
 *   seq                   — the prompt_seq assigned to this prompt by
 *                           promptCorrelationPatch (task ids derive from it)
 *   profile               — the resolved workflow profile ('legacy' | 'lean');
 *                           in legacy the continue path re-persists the user
 *                           classification through the strengthen-only guard
 *                           (CR BLOCK 1), in lean the continue fields stay
 *                           the narrow { active_task } delta
 *
 * Boundary heuristic (documented; conservative default: CONTINUE):
 *   1. no open contract + non-correlation input -> start
 *   2. an explicit benchmark dispatch-contract marker in the classification →
 *      new_task (test-mode boundary; the marker's own semantics are
 *      byte-stable and it never determines the lean workflow — plan 05.9)
 *   3. a verified completion signal -> complete
 *   4. everything else — ambiguous origin, refinement, assistant handoff
 *      text, background deliverable → continue with the open contract and
 *      sibling state preserved, refinement appended (task 05.5).
 * Text-shape "fresh objective" matching is deliberately NOT implemented: no
 * reliable text-only boundary exists without the F02 false-completion hazard.
 *
 * Returns { isNewTask, transition, task_id, active_task, fields, mapClears }:
 *   transition — 'start' | 'continue' | 'plan_only' | 'complete' | 'new_task'
 *   fields     — set_many payload for the fields THIS transition changes
 *   mapClears  — whole-map fields cleared via map_clear ON A NEW TASK (the
 *                role-instance counts): the per-task satisfaction boundary.
 *   isNewTask  — true only for 'start' | 'new_task'
 */
export function taskTransition(prev, cls, input = {}) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const c = cls && typeof cls === 'object' ? cls : {};
  const i = input && typeof input === 'object' ? input : {};

  const open = (p.active_task && typeof p.active_task === 'object'
    && typeof p.active_task.id === 'string' && p.active_task.id !== '') ? p.active_task : null;
  const priorTaskId = safeString(p.task_id) || safeString(open?.id);
  const seq = Number.isFinite(i.seq) ? i.seq : (Number(p.prompt_seq) || 0) + 1;
  const dedupe = i.dedupe === true;
  const backgroundCorrelation = i.backgroundCorrelation === true;
  const completionSignal = i.completed === true;
  // Benchmark dispatch-contract marker presence: a reliable new-task boundary
  // (its prompts are distinct bench objectives; the marker's own semantics
  // are byte-stable and it never determines the lean workflow — plan 05.9).
  const benchmarkMarker = safeString(c.dispatchContractMode) !== '';

  // Duplicate delivery of an already-classified prompt: never a boundary and
  // never a re-append. (The dispatcher should skip the reset AND the
  // transition for a deduped delivery; if it calls anyway, this is a no-op.)
  if (dedupe) {
    return { isNewTask: false, transition: 'continue', task_id: priorTaskId, active_task: open, fields: {}, mapClears: [] };
  }

  // Completion / benchmark-marker boundary (needs an open contract).
  if (open && (completionSignal || benchmarkMarker)) {
    if (benchmarkMarker) {
      // One transition: complete the open contract and open the marker's new
      // task (a bench marker prompt IS the fresh objective). Satisfaction
      // resets per plan 05.4 — no role/evidence carry-over.
      const active_task = newActiveTask(p, c, seq);
      return {
        isNewTask: true,
        transition: 'new_task',
        task_id: active_task.id,
        active_task,
        fields: {
          ...classificationPatch(c),
          task_id: active_task.id,
          active_task,
          last_task_id: priorTaskId,
          // role/evidence satisfaction reset (plan 05.4)
          subagents_started: [],
          tests_ok: false, tests_failed: false,
          lint_ok: false, lint_failed: false,
          build_ok: false, build_failed: false,
        },
        mapClears: ['subagent_instance_count_by_role'],
      };
    }
    // Verified completion: record history and release the role/dispatch gates
    // (the workflow ended). docs_required is preserved. The completed task's
    // id survives via last_task_id; task_id/active_task revert to the no-task
    // defaults so downstream gates (Stop/TaskCompleted) do not re-demand the
    // ended contract's roles.
    return {
      isNewTask: false,
      transition: 'complete',
      task_id: '',
      active_task: null,
      fields: {
        task_id: '',
        active_task: null,
        last_task_id: priorTaskId,
        required_subagents: [],
        required_subagent_any_of: [],
        dispatch_contract_mode: '',
      },
      mapClears: [],
    };
  }

  if (!open) {
    if (backgroundCorrelation) {
      // Registry-aware continuation of pending background work: never open a
      // task from a background deliverable (ADR-0010).
      return { isNewTask: false, transition: 'continue', task_id: priorTaskId, active_task: null, fields: {}, mapClears: [] };
    }
    // Start (plan 05.4: a new user task must not be satisfied by the previous
    // task's roles or verification flags).
    const active_task = newActiveTask(p, c, seq);
    return {
      isNewTask: true,
      transition: 'start',
      task_id: active_task.id,
      active_task,
      fields: {
        ...classificationPatch(c),
        task_id: active_task.id,
        active_task,
        subagents_started: [],
        tests_ok: false, tests_failed: false,
        lint_ok: false, lint_failed: false,
        build_ok: false, build_failed: false,
      },
      mapClears: ['subagent_instance_count_by_role'],
    };
  }

  // Open contract, no completion signal: conservative default — continue.
  if (c.managerMode === 'plan_only') {
    // task 05.6: planning without implementation. The open contract switches
    // to plan_only: no implementation enforcement and no forced dispatch; the
    // classification of a plan-only request already carries no required
    // roles. The open contract's dispatch_contract_mode is preserved.
    const active_task = {
      ...open,
      status: 'plan_only',
      refinements: appendRefinement(open.refinements, i.prompt, seq),
    };
    return {
      isNewTask: false,
      transition: 'plan_only',
      task_id: priorTaskId,
      active_task,
      fields: {
        task_type: safeString(c.taskType) || 'other',
        manager_mode: 'plan_only',
        docs_required: c.docsRequired === true,
        required_subagents: [],
        required_subagent_any_of: [],
        dispatch_contract_mode: safeString(open.dispatch_contract_mode) || '',
        active_task,
      },
      mapClears: [],
    };
  }

  // CR BLOCK 1: in the legacy profile the USER prompt channel re-persists
  // the classification (base 448c33f did so on every prompt) through the
  // strengthen-only guard, so a follow-up prompt can grow the open contract
  // but never weaken it below what is recorded (F02); lean keeps the narrow
  // { active_task } delta the profile gates drive.
  const patch = i.profile === 'legacy' ? persistedContinuePatch(c, open, p) : null;
  const active_task = {
    ...open,
    refinements: appendRefinement(open.refinements, i.prompt, seq),
    ...(patch ? {
      task_type: patch.task_type,
      manager_mode: patch.manager_mode,
      docs_required: patch.docs_required,
      required_subagents: patch.required_subagents,
      required_subagent_any_of: patch.required_subagent_any_of,
      dispatch_contract_mode: patch.dispatch_contract_mode,
    } : {}),
  };
  return {
    isNewTask: false,
    transition: 'continue',
    task_id: priorTaskId,
    active_task,
    // The open contract keeps driving the gates: a background deliverable or
    // assistant handoff (F02) can never overwrite or weaken the recorded
    // contract; legacy continues also re-persist the user classification.
    fields: patch ? { active_task, ...patch } : { active_task },
    mapClears: [],
  };
}

function classificationPatch(c) {
  return {
    task_type: safeString(c.taskType) || 'other',
    manager_mode: safeString(c.managerMode) || 'none',
    docs_required: c.docsRequired === true,
    required_subagents: Array.isArray(c.requiredSubagents) ? c.requiredSubagents : [],
    required_subagent_any_of: Array.isArray(c.requiredSubagentAnyOf) ? c.requiredSubagentAnyOf : [],
    dispatch_contract_mode: safeString(c.dispatchContractMode),
  };
}

/**
 * CR BLOCK 1 (contract stickiness): the strengthen-only classification patch
 * for the legacy continue path. Base 448c33f re-persisted the
 * classification on every prompt (a follow-up user prompt can grow the open
 * contract); the guard keeps F02 holding - required roles and one-of groups
 * merge additively, an enforced dispatch_contract_mode never downgrades,
 * docs_required never lowers from true, and an open implementation-summary
 * category or an orchestrate manager mode is not weakened. The
 * plan_only / complete transitions release by their own semantics and
 * never route through here.
 */
function persistedContinuePatch(c, open, prev) {
  const patch = classificationPatch(c);
  const recordedRequired = Array.isArray(open?.required_subagents) ? open.required_subagents : [];
  const required_subagents = [...new Set([...recordedRequired, ...patch.required_subagents])];
  const seen = new Map();
  for (const group of [...(Array.isArray(open?.required_subagent_any_of) ? open.required_subagent_any_of : []), ...patch.required_subagent_any_of]) {
    const g = Array.isArray(group) ? group : [];
    const key = JSON.stringify(g);
    if (!seen.has(key)) seen.set(key, g);
  }
  const recordedMode = safeString(open?.dispatch_contract_mode);
  const recordedType = safeString(prev?.task_type) || safeString(open?.kind);
  return {
    task_type: taskTypeRequiresImplementationSummary(recordedType) && !taskTypeRequiresImplementationSummary(patch.task_type)
      ? recordedType
      : patch.task_type,
    manager_mode: prev?.manager_mode === 'orchestrate' ? 'orchestrate' : patch.manager_mode,
    docs_required: open?.docs_required === true || patch.docs_required === true,
    required_subagents,
    required_subagent_any_of: [...seen.values()],
    dispatch_contract_mode: recordedMode === 'enforced' || patch.dispatch_contract_mode === 'enforced'
      ? 'enforced'
      : (patch.dispatch_contract_mode || recordedMode),
  };
}

function newActiveTask(prev, cls, seq) {
  return {
    id: `task-${seq}`,
    kind: safeString(cls.taskType) || 'other',
    required_subagents: Array.isArray(cls.requiredSubagents) ? cls.requiredSubagents : [],
    required_subagent_any_of: Array.isArray(cls.requiredSubagentAnyOf) ? cls.requiredSubagentAnyOf : [],
    dispatch_contract_mode: safeString(cls.dispatchContractMode),
    docs_required: cls.docsRequired === true,
    status: cls.managerMode === 'plan_only' ? 'plan_only' : 'open',
    revision: Number(prev?.revision) || 0,
    refinements: [],
  };
}

/**
 * Refinement recording (plan task 05.5: the refinement is appended while the
 * contract stays open): each refinement is { seq, text } — the prompt_seq it
 * arrived on plus the normalized text, truncated (240 chars) and capped
 * (10 entries, oldest dropped) to bound state growth on long contracts.
 */
function appendRefinement(existing, prompt, seq) {
  const text = safeString(prompt).replace(/\s+/g, ' ').trim().slice(0, MAX_REFINEMENT_TEXT);
  if (!text) return Array.isArray(existing) ? existing : [];
  const list = (Array.isArray(existing) ? existing : []).slice(-(MAX_REFINEMENTS - 1));
  list.push({ seq, text });
  return list;
}
// --- ADR-0010 reset discipline (plan 05.7) ----------------------------------

/**
 * ADR-0010 reset discipline (plan task 05.7): on a NEW task the loop-block
 * state resets per agent key instead of via a whole-map clear.
 *
 * Returns { mapField, mapDeletes, scalarResets }:
 *   mapField     — 'subagent_stop_blocks'. Surfaced so the dispatcher's reset
 *                  stays inside the typed map_* event family (per-key
 *                  map_delete events) and never falls back to a scalar
 *                  set_many clobber of a map field.
 *   mapDeletes   — sorted loop-block keys to delete: every key whose registry
 *                  agent is NOT currently status 'running'. Keys with unknown
 *                  provenance (present in the map but absent from the
 *                  registry) are deleted — the conservative legacy freshness
 *                  rule. Running siblings are preserved: their per-agent
 *                  counters keep guarding the live subagent contract while
 *                  the task boundary passes (ADR-0010).
 *   scalarResets — the scalar stop-block resets, byte-identical to
 *                  userPromptResetPatch's existing set_many payload.
 *
 * Multiple missing-id agents share the single '_session' registry key
 * (upsertAgent's fallback), so as soon as any of them is running the
 * '_session' loop key is preserved — the "_session fallback cannot certify
 * independent identities" rule applied conservatively.
 *
 * LEGACY DELTA (ADR-0010 amendment, documented): the dispatcher replaces
 * userPromptResetPatch's map_clear of subagent_stop_blocks with these per-key
 * map_delete events on a NEW task; userPromptResetPatch itself stays
 * byte-stable for every non-boundary reset path.
 */
export function loopBlockResetKeys(agentsRegistry, currentLoopMap = null) {
  const registry = (agentsRegistry && typeof agentsRegistry === 'object' && !Array.isArray(agentsRegistry))
    ? agentsRegistry : {};
  const loopMap = (currentLoopMap && typeof currentLoopMap === 'object' && !Array.isArray(currentLoopMap))
    ? currentLoopMap : {};
  const preserved = new Set();
  for (const [agentId, record] of Object.entries(registry)) {
    if (record && typeof record === 'object' && record.status === 'running') {
      preserved.add(agentLoopKey(agentId));
    }
  }
  const mapDeletes = [];
  for (const key of Object.keys(loopMap)) {
    if (!preserved.has(key)) mapDeletes.push(key);
  }
  mapDeletes.sort();
  return {
    mapField: 'subagent_stop_blocks',
    mapDeletes,
    scalarResets: { ...USER_PROMPT_SCALAR_RESET },
  };
}

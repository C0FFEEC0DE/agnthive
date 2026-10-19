// verification.mjs — test/lint/build command discovery and outcome tracking.
// Ported from lib.sh: detect_node_script, detect_make_target, detect_test_cmd,
// detect_lint_cmd, detect_build_cmd, command_class, is_release_or_deploy_command.
// Node standard library only. Discovery reads the project directory
// (CLAUDE_PROJECT_DIR || cwd); command_class and is_release_or_deploy_command
// are pure string functions.
//
// ADR-0009 evidence model (plan task 04): `resultFromBashPayload` derives an
// honest verification result from the PostToolUse Bash tool_response (launch
// is not completion — F01), `isMutatingShellCommand` is the conservative
// fallback for file-mutating shell edits the Edit/Write counters cannot see
// (04.05), and `currentRevision` / `nextRevisionValue` / `verificationAppendEvent`
// are the small pure seams the dispatcher wires 1:1 when recording evidence.
// `verificationOutcome` and the discovery exports stay byte-stable for legacy.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function projectDir(explicit) {
  if (explicit) return explicit;
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  return process.cwd();
}

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** detect_node_script: `npm run <name>` if package.json defines scripts[name]. */
export function detectNodeScript(scriptName, opts = {}) {
  const dir = projectDir(opts.cwd);
  const pkg = readJsonSafe(join(dir, 'package.json'));
  if (pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object' && pkg.scripts[scriptName] != null) {
    return `npm run ${scriptName}`;
  }
  return null;
}

/** detect_make_target: `make <target>` if a Makefile/makefile defines the target. */
export function detectMakeTarget(target, opts = {}) {
  const dir = projectDir(opts.cwd);
  let makefile = null;
  if (existsSync(join(dir, 'Makefile'))) makefile = join(dir, 'Makefile');
  else if (existsSync(join(dir, 'makefile'))) makefile = join(dir, 'makefile');
  if (!makefile) return null;
  let content;
  try { content = readFileSync(makefile, 'utf8'); } catch { return null; }
  const re = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm');
  return re.test(content) ? `make ${target}` : null;
}

function exists(opts, ...names) {
  const dir = projectDir(opts.cwd);
  return names.some((n) => existsSync(join(dir, n)));
}

/** detect_test_cmd: language-neutral test command discovery. */
export function detectTestCmd(opts = {}) {
  let cmd;
  if ((cmd = detectNodeScript('test', opts))) return cmd;
  if ((cmd = detectMakeTarget('test', opts))) return cmd;
  if (exists(opts, 'Cargo.toml')) return 'cargo test';
  if (exists(opts, 'go.mod')) return 'go test ./...';
  if (exists(opts, 'pytest.ini', 'pyproject.toml') || existsDir(opts, 'tests')) return 'pytest';
  return null;
}

/** detect_lint_cmd: language-neutral lint/static-check discovery. */
export function detectLintCmd(opts = {}) {
  let cmd;
  if ((cmd = detectNodeScript('lint', opts))) return cmd;
  if ((cmd = detectMakeTarget('lint', opts))) return cmd;
  if (exists(opts, 'Cargo.toml')) return 'cargo clippy --all-targets --all-features -- -D warnings';
  if (exists(opts, 'pyproject.toml') || existsDir(opts, 'tests')) return 'python -m compileall .';
  return null;
}

/** detect_build_cmd: language-neutral build command discovery. */
export function detectBuildCmd(opts = {}) {
  let cmd;
  if ((cmd = detectNodeScript('build', opts))) return cmd;
  if (exists(opts, 'Cargo.toml')) return 'cargo build';
  if (exists(opts, 'go.mod')) return 'go build ./...';
  if (exists(opts, 'Makefile', 'makefile')) return 'make';
  return null;
}

function existsDir(opts, name) {
  const dir = projectDir(opts.cwd);
  try {
    return statSync(join(dir, name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * command_class: classify a command string as test/lint/build/other. Pure.
 * Order matters: test and lint are checked before build; "make clean" is
 * "other"; a bare "make" or "make <anything-else>" is "build".
 */
export function commandClass(command) {
  const c = typeof command === 'string' ? command : '';
  if (/pytest|npm test|npm run test|pnpm test|yarn test|cargo test|go test|ctest|make test/.test(c)) return 'test';
  if (/npm run lint|pnpm lint|yarn lint|ruff|flake8|cargo clippy|golangci-lint|eslint|shellcheck|python -m compileall |make lint/.test(c)) return 'lint';
  if (/cmake --build|make all/.test(c)) return 'build';
  if (/make clean/.test(c)) return 'other';
  if (c === 'make' || c.startsWith('make ')) return 'build';
  return 'other';
}

/** is_release_or_deploy_command: profile-disabled release/deploy automation. Pure. */
export function isReleaseOrDeployCommand(command) {
  const c = typeof command === 'string' ? command : '';
  return /npm publish|cargo publish|docker push|gh release|kubectl apply|helm upgrade/.test(c);
}

/**
 * Given a command class and success/failure, return the state patch + context
 * message mirroring post-bash.sh / post-tool-failure.sh.
 */
export function verificationOutcome(commandClassResult, command, { failed = false, error = '' } = {}) {
  if (commandClassResult === 'test') {
    if (failed) return { patch: { tests_failed: true, tests_ok: false, last_test_command: command }, message: `Verification command failed: ${command}. Fix the failure before marking the task done. Error: ${error}`, event: 'PostToolUseFailure' };
    return { patch: { tests_ok: true, tests_failed: false, last_test_command: command }, message: `Successful verification command recorded: ${command}`, event: 'PostToolUse' };
  }
  if (commandClassResult === 'lint') {
    if (failed) return { patch: { lint_failed: true, lint_ok: false, last_lint_command: command }, message: `Lint/static-check command failed: ${command}. Resolve the issue before stopping. Error: ${error}`, event: 'PostToolUseFailure' };
    return { patch: { lint_ok: true, lint_failed: false, last_lint_command: command }, message: `Successful lint/static-check command recorded: ${command}`, event: 'PostToolUse' };
  }
  if (commandClassResult === 'build') {
    if (failed) return { patch: { build_failed: true, build_ok: false, last_build_command: command }, message: `Build command failed: ${command}. Fix the build or explicitly explain why it is not required. Error: ${error}`, event: 'PostToolUseFailure' };
    return { patch: { build_ok: true, build_failed: false, last_build_command: command }, message: `Successful build command recorded: ${command}`, event: 'PostToolUse' };
  }
  return null;
}

// --- ADR-0009 payload-aware verification results (plan task 04.1–04.2) ------

// Error excerpts kept on a record are short and trimmed: bounded enough to sit
// inside one event log line, still enough to point at the failing check.
const ERROR_EXCERPT_MAX = 200;

// last_* state fields by kind, shared with the legacy legacy-flag fallback so a
// pending/unknown launch at least records which command was last seen without
// flipping any ok/failed flag.
const LAST_FIELD_BY_KIND = Object.freeze({
  test: 'last_test_command',
  lint: 'last_lint_command',
  build: 'last_build_command',
});

/** Short, single-line, bounded error excerpt for a record. */
function trimError(text) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= ERROR_EXCERPT_MAX) return flat;
  return `${flat.slice(0, ERROR_EXCERPT_MAX - 1)}…`;
}

/** ISO stamp from ctx.now (epoch ms) or the wall clock. */
function isoStamp(now) {
  const ms = Number(now);
  const value = Number.isFinite(ms) ? ms : Date.now();
  try { return new Date(value).toISOString(); } catch { return new Date().toISOString(); }
}

/**
 * Read a definite foreground exit code from a tool_response object. The Bash
 * PostToolUse payload's spelling varies by CLI release (exitCode / exit_code /
 * exitStatus / exit_status), so — per the F01 lesson — the value is read on
 * whichever field actually carries it rather than one synthetic name. Returns
 * the finite number, or null when no definite exit code exists (string
 * responses, missing payloads, objects without one of the known keys).
 */
const EXIT_KEYS = new Set(['exitcode', 'exit_code', 'exitstatus', 'exit_status']);
function readExitCode(response) {
  if (response == null || typeof response !== 'object') return null;
  for (const [key, value] of Object.entries(response)) {
    if (EXIT_KEYS.has(String(key).toLowerCase()) && typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Launch-notice shapes accepted as "this command went to the background". A
 * marker on any accepted shape means launch only — never completion (F01), so
 * the derived status is 'pending' and the record can never satisfy the gate.
 * The marker is read on whichever field actually carries it (F01 reproduced the
 * bug with a synthetic `backgroundTaskId`; the real runtime may deliver the id
 * on a differently named field, or only as notice text). Accepted shapes:
 *   - object response: any own key whose NAME contains "background" with a
 *     non-empty string/number value (backgroundTaskId, background_task_id,
 *     backgroundShellId, backgroundShell, ...);
 *   - object response: run_in_background / runInBackground / isBackground
 *     === true;
 *   - object response: a status / taskStatus key whose value is one of
 *     running | pending | started | background (a closed value set, so a
 *     checker printing `status: ok` is not mistaken for a background run);
 *   - the string response itself, or the object's `stdout` field: text
 *     containing a launch notice ("running in background", "(shell id:",
 *     "background task id", "launched in background") — the wording shapes the
 *     Bash tool prints for run_in_background launches.
 */
const BG_STATUS_VALUES = new Set(['running', 'pending', 'started', 'background']);
const BG_NOTICE_TEXT = /running in background|\(shell id[:\s]|background task id|launched in background/i;

function readBackgroundMarker(response) {
  if (typeof response === 'string') return BG_NOTICE_TEXT.test(response);
  if (response == null || typeof response !== 'object') return false;
  for (const [key, value] of Object.entries(response)) {
    const name = String(key).toLowerCase();
    if (/background/.test(name) && (typeof value === 'string' || typeof value === 'number') && value !== '') return true;
    if ((name === 'run_in_background' || name === 'runinbackground' || name === 'isbackground') && value === true) return true;
    if ((name === 'status' || name === 'taskstatus') && BG_STATUS_VALUES.has(String(value).toLowerCase())) return true;
  }
  return BG_NOTICE_TEXT.test(typeof response.stdout === 'string' ? response.stdout : '');
}

/**
 * Derive an honest ADR-0009 verification result from the PostToolUse Bash
 * tool_response. Mirrors the legacy `verificationOutcome` shape so the
 * dispatcher can keep emitting the same context events, while the record
 * carries the completion evidence the gate (successfulVerification) needs:
 *
 *   - commandClassResult: the commandClass() result; only test|lint|build
 *     produce a result (anything else returns null, the same passthrough
 *     contract as verificationOutcome).
 *   - toolResponse: object `{stdout, stderr, exitCode|exit_code, interrupted?}`
 *     OR a plain string, OR null/missing. Definite zero exit code → 'passed';
 *     definite non-zero → 'failed'; `interrupted: true` → 'unknown' (an abort
 *     is not a failed run; the record carries signal 'interrupted'); a
 *     background marker (see readBackgroundMarker) → 'pending'; missing or
 *     unrecognized response → 'unknown'. Unknown is NEVER folded into 'passed':
 *     ADR-0009 — "Failed, interrupted, missing, or unknown result | No".
 *   - ctx: { revision, cwd, toolUseId, now, seq, startedRevision, startedAt,
 *     error, assumeFailure }. The dispatcher passes `revision` as the state's
 *     currentRevision(state) at the moment the result lands (so a record made
 *     after a bump compares against the bumped max), `startedRevision` when it
 *     re-observes a launch from an earlier revision (edit-during-test), and
 *     `seq` for the record id (`v<seq>`). `assumeFailure` marks the event
 *     itself (PostToolUseFailure) as failure evidence when the runtime sent no
 *     usable response, so the legacy failure-flag sync contract is preserved;
 *     `error` carries the failure event's error text for the excerpt.
 *
 * `fields` keeps the legacy flags in sync exactly like verificationOutcome for
 * passed/failed (flags-sync contract) and writes only the `last_*_command`
 * field for pending/unknown — a launch never flips an ok flag (F01), and an
 * unknown run never manufactures one (ADR-0009: honest gap, no manufactured
 * pass). `eventClass` is the legacy hook event name ('PostToolUse', or
 * 'PostToolUseFailure' for failed).
 */
export function resultFromBashPayload(commandClassResult, command, toolResponse, toolUseId, ctx = {}) {
  if (commandClassResult !== 'test' && commandClassResult !== 'lint' && commandClassResult !== 'build') return null;
  const kind = commandClassResult;
  const cmd = typeof command === 'string' ? command : '';
  const toolUse = (typeof toolUseId === 'string' && toolUseId !== '')
    ? toolUseId
    : (typeof ctx.toolUseId === 'string' ? ctx.toolUseId : '');
  const revision = (Number.isFinite(Number(ctx.revision)) && ctx.revision !== null) ? Number(ctx.revision) : null;
  const started = (ctx.startedRevision !== undefined && Number.isFinite(Number(ctx.startedRevision)) && ctx.startedRevision !== null)
    ? Number(ctx.startedRevision)
    : revision;

  const failedByEvent = ctx.assumeFailure === true;
  let status;
  let signal = null;
  let unknownCause = 'unrecognized';
  if (readBackgroundMarker(toolResponse)) {
    // Launch is not completion (F01). Checked first: even a launch the runtime
    // marks as failed is still only a pending launch evidence-wise, and a
    // pending launch never flips the failed legacy flags either — the launch
    // produced no outcome to record.
    status = 'pending';
  } else if (toolResponse != null && typeof toolResponse === 'object' && toolResponse.interrupted === true) {
    status = 'unknown';
    unknownCause = 'interrupted';
    signal = typeof toolResponse.signal === 'string' && toolResponse.signal !== '' ? toolResponse.signal : 'interrupted';
  } else {
    const exit = readExitCode(toolResponse);
    if (exit !== null) {
      status = exit === 0 ? 'passed' : 'failed';
      signal = null;
    } else if (failedByEvent) {
      // PostToolUseFailure IS failure evidence even when the runtime sent no
      // parsable response; without this, a response-less failure event would
      // silently drop the legacy *_failed flag sync.
      status = 'failed';
    } else {
      status = 'unknown';
    }
  }

  const definite = status === 'passed' || status === 'failed';
  const readField = (name) => ((toolResponse && typeof toolResponse === 'object' && typeof toolResponse[name] === 'string') ? toolResponse[name] : '');
  // A failed/interrupted run carries a short trimmed excerpt of what the
  // command printed; a pending launch carries no error (the notice text on its
  // stdout is a launch marker, not an outcome), and a pass has nothing to carry.
  const error = status === 'failed'
    ? (trimError(readField('stderr')) || trimError(readField('stdout')) || trimError(ctx.error))
    : (status === 'unknown' ? (trimError(readField('stderr')) || trimError(ctx.error)) : '');

  // Legacy flags ride along only for definitive outcomes; pending/unknown keep
  // the last-command trail so the agent still sees which command ran.
  const legacy = definite ? verificationOutcome(kind, cmd, { failed: status === 'failed', error }) : null;
  const fields = definite && legacy
    ? legacy.patch
    : { [LAST_FIELD_BY_KIND[kind]]: cmd };

  const completedRevision = definite ? revision : null;
  const id = `v${Number.isFinite(Number(ctx.seq)) && ctx.seq !== null
    ? Math.floor(Number(ctx.seq))
    : Math.abs(Math.floor(Number(ctx.now))) || Date.now()}`;
  const record = {
    id,
    kind,
    command: cmd,
    toolUseId: toolUse,
    status,
    startedRevision: started,
    completedRevision,
    cwd: typeof ctx.cwd === 'string' ? ctx.cwd : '',
    exitStatus: definite ? readExitCode(toolResponse) : null,
    signal,
    error,
    startedAt: isoStamp(ctx.startedAt ?? ctx.now),
    finishedAt: status === 'pending' ? null : isoStamp(ctx.now),
    source: 'post_tool_use',
  };
  const message = definite && legacy
    ? legacy.message
    : status === 'pending'
      ? `Background verification command launched but not completed yet: ${cmd}. A launch is not a completion (ADR-0009); wait for the completion event or rerun the command in the foreground before relying on it.`
      : unknownCause === 'interrupted'
        ? `Verification command did not complete (interrupted): ${cmd}. Rerun the command in the foreground to record a definitive result.`
        : `Verification outcome could not be determined from the tool response: ${cmd}. Rerun the command in the foreground to record a definitive result before claiming verification.`;

  return { kind, status, record, fields, message, eventClass: definite && legacy ? legacy.event : 'PostToolUse' };
}

/**
 * Append-only state event payload for the record model. The dispatcher appends
 * this with the 'append' event writer (safeAppend(paths, 'append', ...)):
 * per-element append events cannot clobber a sibling agent's concurrently
 * written record, while a set_many snapshot of the whole array would be
 * last-writer-wins. Returns { field, value } for the state.mjs 'append' event
 * shape, or null when the result carries no record.
 */
export function verificationAppendEvent(result) {
  const record = result && typeof result === 'object' ? result.record : null;
  if (!record || typeof record !== 'object') return null;
  return { field: 'verification', value: record };
}

/**
 * currentRevision: the change revision a record must match to still certify
 * the current tree. `fs_revision_hint` participates so the conservative
 * fallback for file-mutating shell commands (ADR-0009, plan task 04.05)
 * invalidates earlier evidence — a record completed before an fs bump cannot
 * close the gate. The dispatcher passes this value as `ctx.revision` when
 * recording a result, and bumps one of the two fields to nextRevisionValue.
 */
export function currentRevision(state) {
  const rev = Number(state?.revision);
  const hint = Number(state?.fs_revision_hint);
  return Math.max(Number.isFinite(rev) ? rev : 0, Number.isFinite(hint) ? hint : 0);
}

/**
 * Next revision value for a tracked edit; the dispatcher bumps exactly one of
 * `revision` (EditWrite edits, task 04.4) or `fs_revision_hint` (file-mutating
 * Bash commands, 04.05) to this value, so both raise currentRevision.
 */
export function nextRevisionValue(state) {
  return currentRevision(state) + 1;
}

/**
 * isMutatingShellCommand — conservative Bash-family heuristic for commands that
 * mutate tracked files without touching the Edit/Write counters (ADR-0009:
 * "account for shell/external edits through a ... conservative fallback, not
 * only Edit/Write counters"; plan task 04.05). The dispatcher consults it ONLY
 * on PostToolUse Bash commands whose commandClass is 'other': a
 * verification-class command (test/lint/build) never bumps the revision, so a
 * run writing its own artifacts (coverage, build cache) cannot invalidate the
 * very record it produced.
 *
 * Heuristic, not an oracle, biased in the safe direction: over-triggering costs
 * an extra verified rerun (the correct direction per the brief — extra required
 * verification, never a stale pass); the under-triggers are holes worth taking
 * only when statically unresolvable. Matching rules, per `&&`/`||`/`;`/`|`/`&`/
 * newline/paren-separated segment (quotes are NOT parsed; a `>` or a mutating
 * word quoted in an argument is a documented over-trigger):
 *   1.  redirection into a file: after stripping fd-dup shapes (2>&1, >&2) and
 *       /dev/null writes, any remaining '>' counts (`> out.txt`, `2>err`,
 *       `&>>log`);
 *   2.  unconditional file-manipulating head command (first command word after
 *       `name=value` assignments and no-effect wrappers such as sudo/env/...):
 *       mv cp rm rmdir dd ln mkdir touch truncate shred split csplit tee patch
 *       rsync scp sftp wget tar unzip zip gzip gunzip bzip2 xz 7z ar compress
 *       chmod chown chgrp chattr setfacl chcon mkfs install (1) gofmt black
 *       isort goimports;
 *   3.  conditional heads:
 *       - sed/awk with an in-place flag (-i/-ie/-e -i `-i inplace`/--
 *         --in-place); ed and ex unconditionally (editing files is their use);
 *         perl only with -i / --in-place;
 *       - find with -delete/-exec/-execdir;
 *       - curl with an output flag (-o/-O/--output/--remote-name/
 *         --remote-header-name/-J);
 *       - interpreter/script-runner heads (node, python, ruby, php, shell
 *         family, deno, bun) with a script-file argument (any token ending in
 *         a script-style extension after the last `/`): `node index.js`,
 *         `bash setup.sh`; bare flag-only invocations are not flagged;
 *       - npx/uvx only with an explicit write-ish flag (--write/--fix/
 *         --in-place/--update): `npx tsc --noEmit` stays unflagged, while
 *         `npx prettier --write .` is flagged;
 *       - npm/yarn/pnpm/bun with dependency-mutating subcommands (install i ci
 *         add remove uninstall update upgrade dedupe prune rebuild link unlink
 *         import init) or `run <name>` where the script name matches a mutator
 *         smell (fix, format, codemod, generate, codegen, install,
 *         postinstall, preinstall, prepare, bump) — note the name set
 *         deliberately excludes build/compile/test: those are checks, and a
 *         legacy quirk (commandClass has no 'npm run build' pattern) routes
 *         them here, where flagging them would churn the gate, not protect it;
 *       - package managers (pip pip3 poetry uv cargo gem conda mamba apt
 *         apt-get dnf yum zypper apk pacman brew snap) with mutating
 *         subcommands (install uninstall remove erase sync add purge update
 *         upgrade autoremove lock new init fmt), plus `python -m pip install`;
 *       - git with a content-mutating subcommand (checkout restore apply merge
 *         rebase stash clean reset cherry-pick revert rm mv am pull worktree
 *         submodule): index/history-only operations (add, commit, branch, tag,
 *         push, fetch) are intentionally NOT flagged — they do not change
 *         tracked file content, and remote writes are the release/deploy
 *         command policy's concern, not this counter's;
 *   4.  direct execution of a script-style filename (`./setup.sh`, `deploy.py`).
 * Known under-triggers (documented, next-mitigation = diff
 * fingerprint/checkpoint per plan 04.05): inline interpreter code (`node -e`,
 * `bash -c`), heredocs, package runners without a write flag (`npx codemod`),
 * wrappers that take flags in between (`sudo -u root rm x` resolves to head
 * 'root'), and non-Bash shell families (PowerShell is not covered here).
 */
const BYPASS_HEADS = new Set([
  'sudo', 'doas', 'nohup', 'xargs', 'env', 'nice', 'ionice', 'stdbuf', 'time',
  'timeout', 'taskset', 'command', 'exec',
]);
const MUTATING_HEADS = new Set([
  'mv', 'cp', 'rm', 'rmdir', 'dd', 'ln', 'mkdir', 'touch', 'truncate', 'shred',
  'split', 'csplit', 'tee', 'patch', 'rsync', 'scp', 'sftp', 'wget', 'tar',
  'unzip', 'zip', 'gzip', 'gunzip', 'bzip2', 'xz', '7z', 'ar', 'compress',
  'chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'chcon', 'mkfs', 'install',
  'gofmt', 'black', 'isort', 'goimports',
]);
const NPM_HEADS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const NPM_MUTATING_SUBS = new Set([
  'install', 'i', 'ci', 'add', 'remove', 'uninstall', 'update', 'upgrade',
  'dedupe', 'prune', 'rebuild', 'link', 'unlink', 'import', 'init',
]);
const NPM_RUN_MUTATOR = /fix|format|codemod|generate|codegen|install|postinstall|preinstall|prepare|bump/;
const PKG_HEADS = new Set([
  'pip', 'pip3', 'poetry', 'uv', 'cargo', 'gem', 'conda', 'mamba', 'apt',
  'apt-get', 'aptitude', 'dnf', 'yum', 'zypper', 'apk', 'pacman', 'brew',
  'snap', 'flatpak', 'scoop', 'winget', 'nuget',
]);
const PKG_MUTATING_SUBS = new Set([
  'install', 'uninstall', 'remove', 'erase', 'sync', 'add', 'purge', 'update',
  'upgrade', 'autoremove', 'lock', 'new', 'init', 'fmt',
]);
const GIT_MUTATING_SUBS = new Set([
  'checkout', 'restore', 'apply', 'merge', 'rebase', 'stash', 'clean', 'reset',
  'cherry-pick', 'revert', 'rm', 'mv', 'am', 'pull', 'worktree', 'submodule',
]);
const INTERPRETER_HEADS = new Set([
  'node', 'nodejs', 'deno', 'bun', 'python', 'python3', 'pypy', 'ruby', 'php',
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'ash', 'fish', 'csh', 'tcsh',
]);
const SCRIPT_HEADS = new Set(['npx', 'uvx']);
const SCRIPT_EXT = /\.(mjs|cjs|js|jsx|ts|mts|cts|tsx|py|pyw|sh|bash|zsh|ksh|rb|pl|php|lua|tcl|exe|bat|cmd|ps1)$/i;
const NAME_VALUE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Resolve the (path-stripped, lowercased) command head of one segment. */
function commandHead(segment) {
  const words = segment.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^[(&]+/, ''));
  for (let i = 0; i < words.length; i += 1) {
    const stripped = words[i].replace(/.*\//, '').toLowerCase();
    if (!stripped) continue;
    if (NAME_VALUE.test(stripped)) continue; // env-assignment prefix
    if (BYPASS_HEADS.has(stripped)) continue; // no-effect wrapper
    return { head: stripped, argsLine: words.slice(i + 1).join(' ') };
  }
  return { head: '', argsLine: '' };
}

/**
 * First subcommand-ish token of an args line: skips tokens starting with '-'
 * and value-ish tokens containing '=' (`git -c k=v checkout` → 'checkout').
 * Flag-value arguments (e.g. `npm --prefix ./a install` → './a') are a
 * documented under-trigger.
 */
function nextHead(argsLine) {
  for (const token of argsLine.trim().split(/\s+/)) {
    if (!token) continue;
    const bare = token.replace(/.*\//, '').toLowerCase();
    if (bare.startsWith('-') || bare.includes('=')) continue;
    return bare;
  }
  return '';
}

/** True when a '>' survives fd-dup and /dev/null stripping (a file write). */
function redirectsToFile(cmd) {
  const stripped = cmd
    .replace(/(?:\d\s*)?&?\s*>\s*&\s*\d+/g, ' ') // fd dups: 2>&1, >&2, 1>& -
    .replace(/(?:\d+)?\s*&?\s*>+\s*\/dev\/null\b/g, ' '); // >, >>, &>, 2>>, >/dev/null
  return stripped.includes('>');
}

export function isMutatingShellCommand(command) {
  const raw = typeof command === 'string' ? command : '';
  if (!raw.trim()) return false;
  if (redirectsToFile(raw)) return true;
  for (const segment of raw.split(/&&|\|\||[;|\n&()]/)) {
    if (!segment.trim()) continue;
    const { head, argsLine } = commandHead(segment);
    if (!head) continue;
    if (SCRIPT_EXT.test(head)) return true;
    if (MUTATING_HEADS.has(head)) return true;
    if (head === 'git' && GIT_MUTATING_SUBS.has(nextHead(argsLine))) return true;
    if (NPM_HEADS.has(head)) {
      const sub = nextHead(argsLine);
      if (NPM_MUTATING_SUBS.has(sub)) return true;
      if (sub === 'run' && NPM_RUN_MUTATOR.test(argsLine)) return true;
    }
    if (PKG_HEADS.has(head) && PKG_MUTATING_SUBS.has(nextHead(argsLine))) return true;
    if ((head === 'python' || head === 'python3') && /(?:^|\s)-m\s+pip/.test(argsLine) && /(?:^|\s)(?:install|uninstall)\b/.test(argsLine)) return true;
    if (head === 'sed' && /(?:^|\s)-i[a-z]*\b|(?:^|\s)--in-place\b/.test(argsLine)) return true;
    if (head === 'awk' && /(?:^|\s)-?i\s+inplace\b|(?:^|\s)--in-place\b/.test(argsLine)) return true;
    if (head === 'ed' || head === 'ex') return true;
    if (head === 'perl' && /(?:^|\s)-i|(?:^|\s)--in-place\b/.test(argsLine)) return true;
    if (head === 'find' && /(?:^|\s)-delete\b|(?:^|\s)-exec(?:dir)?\b/.test(argsLine)) return true;
    if (head === 'go' && /^(get|mod|generate)\b/.test(argsLine)) return true;
    if (SCRIPT_HEADS.has(head) && /(?:^|\s)(?:--write|--fix|--in-place|--update)\b/.test(argsLine)) return true;
    if (INTERPRETER_HEADS.has(head)) {
      if (argsLine.split(/\s+/).some((w) => SCRIPT_EXT.test(w.replace(/.*\//, '')))) return true;
      if (head === 'sh' || head === 'bash' || head === 'zsh' || head === 'ksh' || head === 'dash') {
        if (/(?:^|\s)(?:-x|-e)\b/.test(argsLine)) return true; // inline code / trace runs write via their script content
      }
    }
  }
  return false;
}
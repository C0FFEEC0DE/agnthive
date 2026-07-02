// command-policy.mjs — portable command-string security policy.
//
// Normative for references/command-policy.md. Node standard library only: pure
// string transforms + regexes, no child_process, no shell, no eval. The policy
// inspects the `tool_input.command` of a Bash tool call BEFORE it runs and
// decides whether the hook-gated SDLC profile allows it.
//
// Coverage:
//   - POSIX shells (sh/bash/zsh/dash/ksh): a faithful port of the legacy
//     lib.sh policy (sudo, mkfs/dd, narrow rm -rf of catastrophic tokens, git
//     push --force, git reset --hard, release/deploy verbs, curl|sh bootstrap).
//   - PowerShell: Remove-Item -Recurse -Force, Format-Volume, irm|iex /
//     iwr|iex / curl|iex bootstrap, Start-Process -Verb Runas escalation.
//   - CMD: rd/rmdir /s /q, del/erase /f /s, format <drive>, runas escalation.
//
// Modes (CLAUDE_CREW_POLICY):
//   - advisory (default): deny known-dangerous; allow unparseable indirection.
//   - enforce: deny known-dangerous AND deny unparseable indirection with an
//     explanation (fail-closed), per the spec's hard rule.
//
// The classifier is pure and returns a stable { decision, code, reason }. The
// dispatcher handlers format the reason into PreToolUse / PermissionRequest /
// PermissionDenied output. `code` is the short canonical reason key used to
// pick the per-event message and the PermissionDenied retry verdict.

// --- mode resolution ------------------------------------------------------

/** Resolve the policy mode from env. 'enforce' is opt-in; anything else is advisory. */
export function resolveMode(env = process.env) {
  const raw = typeof env.CLAUDE_CREW_POLICY === 'string' ? env.CLAUDE_CREW_POLICY.trim().toLowerCase() : '';
  return raw === 'enforce' ? 'enforce' : 'advisory';
}

/** True when running inside the benchmark CI context (no-retry signals). */
export function isBenchmarkCi(env = process.env) {
  return Boolean(env.BENCH_TASK_ID) || Boolean(env.BENCH_TASK_FILE) || Boolean(env.BENCH_WORKDIR);
}

// --- normalization (faithful to lib.sh normalize_command_for_policy) --------

/**
 * Lowercase, collapse whitespace to single spaces, strip `"`, `'`, and `\`.
 * This flattens quoting so `rm -rf "~"` and `rm -rf ~` are treated alike. It is
 * a deliberate simplification, NOT shell-grammar parsing (see spec §4/§5). Pure
 * string transform, no external process.
 */
export function normalizeCommand(command) {
  if (typeof command !== 'string') return '';
  return command.toLowerCase().replace(/\s+/g, ' ').replace(/["'\\]/g, '').trim();
}

// --- canonical reason codes -------------------------------------------------

export const CODE = Object.freeze({
  SUDO: 'sudo',
  DISK: 'disk',
  HOME_OR_CURRENT: 'home_or_current',
  DESTRUCTIVE: 'destructive',
  RELEASE_DEPLOY: 'release_deploy',
  REMOTE_BOOTSTRAP: 'remote_bootstrap',
  UNPARSEABLE: 'unparseable',
  ALLOW: 'allow',
});

// Full PreToolUse reason messages (permissionDecisionReason). Each contains the
// spec §6 reason substring so the corpus and the legacy fixture runner agree.
const PRETOOL_REASON = {
  [CODE.SUDO]: 'sudo is blocked by the SDLC safety profile.',
  [CODE.DISK]: 'Dangerous disk commands are blocked.',
  [CODE.HOME_OR_CURRENT]: 'Recursive deletion of home or current directory is blocked.',
  [CODE.DESTRUCTIVE]: 'Destructive commands are blocked by policy.',
  [CODE.RELEASE_DEPLOY]: 'release/deploy actions are intentionally out of scope for this workflow profile.',
  [CODE.REMOTE_BOOTSTRAP]: 'Remote shell bootstrap is blocked: piping remote scripts into the shell is not permitted by this profile.',
  [CODE.UNPARSEABLE]: 'The command could not be statically resolved; indirection hides the real target.',
  [CODE.ALLOW]: 'Command is allowed by the SDLC safety profile.',
};

// Escalation (runas / Start-Process -Verb Runas) reuses the sudo code but a
// message that still contains the substring "sudo".
const ESCALATION_REASON = 'Privilege escalation (sudo-equivalent) is blocked by the SDLC safety profile.';

// PermissionRequest decision.message per code (matches the legacy
// permission-request.sh messages so the fixture runner's substring checks pass).
const PERMREQUEST_MESSAGE = {
  [CODE.SUDO]: 'sudo / privilege escalation is blocked by this profile',
  [CODE.DISK]: 'dangerous disk commands are blocked by this profile',
  [CODE.HOME_OR_CURRENT]: 'destructive commands are blocked by this profile',
  [CODE.DESTRUCTIVE]: 'destructive commands are blocked by this profile',
  [CODE.RELEASE_DEPLOY]: 'release/deploy requests are outside this profile',
  [CODE.REMOTE_BOOTSTRAP]: 'remote shell bootstrap commands require manual review outside the hook flow',
  [CODE.UNPARSEABLE]: 'the command could not be statically resolved and is blocked by this profile',
};

// --- detection regexes -----------------------------------------------------

// Token boundaries include shell indirection chars `(`, `)`, and backtick so a
// literal dangerous verb inside `$(...)`, `(...)`, or `` `...` `` is still
// detected (spec §5: the literal pattern survives normalization). Bash missed
// these (its boundaries were whitespace-only); the Node port catches them.
const LB = '[\\s;|&()`]'; // left boundary (start, or one of these chars)
const RB = '[\\s;|&()`]'; // right boundary lookahead class

// Privilege escalation.
const RE_SUDO = new RegExp(`(^|${LB})sudo(?=${RB}|$)`);
const RE_RUNAS = new RegExp(`(^|${LB})runas(?=${RB}|$)`);
const RE_START_PROCESS_RUNAS = new RegExp(`(^|${LB})start-process\\s+.*-verb\\s+runas`);

// Disk formatting.
const RE_MKFS = new RegExp(`(^|${LB})mkfs(\\.[a-z0-9]+)?(?=${RB}|$)`);
const RE_DD = new RegExp(`(^|${LB})dd(?=${RB}|$)`);
const RE_FORMAT_VOLUME = new RegExp(`(^|${LB})format-volume(?=${RB}|$)`);
// CMD `format <drive>`. Narrowed to `format` followed by a bare drive letter
// (`c:` then a boundary or end-of-string) so it does not false-positive on
// `git format-patch` (where `format` is glued to `-patch`), a trailing `format`
// token like `python -m format`, or a subcommand that takes a drive-path
// argument such as `dotnet format C:\MySolution.sln` (after normalization the
// drive letter is followed by the path body, not a boundary).
const RE_FORMAT = new RegExp(`(^|${LB})format\\s+[a-z]:(?=${RB}|$)`);

// POSIX rm + compact recursive/force flags (faithful to lib.sh).
const RE_RM = new RegExp(`(^|${LB})rm\\s`);

// Token-based flag detection — avoids polynomial regex backtracking
// (CodeQL: js/polynomial-redos). Extracts dash-prefixed tokens from the
// normalized command and checks character membership with .includes().
/** Extract flag chars from a single dash-prefixed token (e.g. "-rf" → "rf").
 *  Uses char-by-char scanning instead of regex to avoid ReDoS alerts. */
function flagChars(token) {
  let i = 0;
  while (i < token.length && token[i] === '-') i++;
  let out = '';
  for (; i < token.length; i++) {
    const c = token[i];
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) out += c;
  }
  return out;
}
/** Split a normalized command into whitespace-separated tokens. */
function tokensOf(norm) {
  return norm.split(/\s+/).filter(Boolean);
}
/** True when any flag token contains both 'r' and 'f' (e.g. -rf, -fr, -rvf). */
function hasFlagRf(norm) {
  return tokensOf(norm).some(
    (t) => t.startsWith('-') && (() => { const c = flagChars(t); return c.includes('r') && c.includes('f'); })()
  );
}
/** True when any flag token contains char 'ch' (e.g. -r, -v, -f). */
function hasFlag(norm, ch) {
  return tokensOf(norm).some(
    (t) => t.startsWith('-') && flagChars(t).includes(ch)
  );
}

// PowerShell delete verbs + long -Recurse/-Force flags.
const RE_PS_DELETE_VERB = new RegExp(`(^|${LB})(remove-item|rm|del|erase|rd|rmdir|ri)\\s`);
const RE_PS_RECURSE = /(^|\s)-recurse(?=\s|$)/;
const RE_PS_FORCE = /(^|\s)-force(?=\s|$)/;

// CMD delete verbs + /s recursive + (/q quiet | /f force) flags.
const RE_CMD_DELETE_VERB = new RegExp(`(^|${LB})(rd|rmdir|del|erase)\\s`);
const RE_CMD_S = /(^|\s)\/s(?=\s|$)/;
const RE_CMD_Q = /(^|\s)\/q(?=\s|$)/;
const RE_CMD_F = /(^|\s)\/f(?=\s|$)/;

// Catastrophic standalone targets. `..` is tried before `.` so a dotdot is not
// split into two dots. The trailing lookahead requires a terminator (space,
// ;|&()`` ` ``, or end) so `/etc`, `~/foo`, `./build`, `c:program` are NOT
// matched — only a bare catastrophic token is. An optional `-- ` end-of-options
// prefix is allowed, matching lib.sh. The right lookahead includes `)` and
// backtick so `$(rm -rf /)` and `` `rm -rf /` `` are caught.
const RE_HOME_OR_CURRENT = /(^|\s)(?:--\s+)?(~|\$home|\$\{home\}|\.\.|\.(?=[\s;|&()`]|$))(?=[\s;|&()`]|$)/;
const RE_ROOT = /(^|\s)(?:--\s+)?(\/|[a-z]:)(?=[\s;|&()`]|$)/;

// Force push and hard reset.
const RE_GIT_PUSH = /git\s+push/;
const RE_FORCE_FLAG = /(^|\s)(-f|--force|--force-with-lease)(?=\s|$)/;
const RE_GIT_RESET_HARD = /git reset --hard/;

// Release / deploy verbs (substring, OS-agnostic CLIs).
const RELEASE_DEPLOY_SUBSTRINGS = ['npm publish', 'cargo publish', 'docker push', 'gh release', 'kubectl apply', 'helm upgrade'];

// Remote shell bootstrap.
const RE_CURL_WGET = new RegExp(`(^|${LB})(curl|wget)(?=${RB}|$)`);
const RE_IRM_IWR = new RegExp(`(^|${LB})(irm|iwr)(?=${RB}|$)`);
// Pipe into a shell. The shell must be either the first token after `|` or
// preceded only by a known arg-passer (env/sudo/command/nohup/xargs/exec/nice),
// so `curl … | grep sh` (where `sh` is an argument to `grep`) is NOT treated as
// a remote bootstrap. Bash used a looser `(?:[a-z_./-]+\s+)*` prefix that
// false-positived on `| grep sh`; this port tightens it while preserving every
// legacy bootstrap spelling (`| bash`, `| env bash`, `| sh`, `| sudo sh`).
const RE_PIPE_SHELL = new RegExp(`\\|\\s*(?:(?:env|sudo|command|nohup|xargs|exec|nice)\\s+)*(sh|bash|zsh|dash|ksh)(?=${RB}|$)`);
const RE_PIPE_IEX = new RegExp(`\\|\\s*iex(?=${RB}|$)`);

// Unparseable indirection.
const RE_EVAL_IEX = new RegExp(`(^|${LB})(eval|iex)\\s`);
// A $-reference follows eval/iex: a named var ($cmd) OR a shell special
// parameter ($@, $*, $#, $?, $!, $0-$9, $_, $-). Broadened from `[a-z_]` so
// `eval "$@"` / `eval "$1"` / `eval "$?"` are caught (spec §5).
const RE_VAR_REF = /\$[a-z_@0-9?#!*\-]/;
// Command substitution (backtick or $(...)) that wraps a $-reference: the real
// target is hidden behind the reference, e.g. `$(rm -rf $target)` or
// ``rm -rf $target``. A substitution with no $-reference inside (e.g. `$(date)`)
// is statically resolvable and is NOT flagged.
// Implemented with indexOf + single-char regex test to avoid polynomial regex
// backtracking (CodeQL: js/polynomial-redos on `[^`]*$` and `[^)]*$`).
const RE_VAR_START = /[a-z_@0-9?#!*\-]/;
/** True when a backtick or $(…) segment contains a $-reference to a variable. */
function hasSubstitutionVar(norm) {
  // Backtick-delimited segment containing $-reference.
  for (let i = 0; i < norm.length - 1; i++) {
    if (norm[i] !== '`') continue;
    const close = norm.indexOf('`', i + 1);
    const end = close < 0 ? norm.length : close;
    const seg = norm.slice(i + 1, end);
    const di = seg.indexOf('$');
    if (di >= 0 && di + 1 < seg.length && RE_VAR_START.test(seg[di + 1])) return true;
    if (close < 0) break;
    i = close;
  }
  // $(…) command substitution containing $-reference.
  let pi = 0;
  while ((pi = norm.indexOf('$(', pi)) >= 0) {
    const close = norm.indexOf(')', pi + 2);
    const end = close < 0 ? norm.length : close;
    const seg = norm.slice(pi + 2, end);
    const di = seg.indexOf('$');
    if (di >= 0 && di + 1 < seg.length && RE_VAR_START.test(seg[di + 1])) return true;
    if (close < 0) break;
    pi = close + 1;
  }
  return false;
}
// PowerShell call operator on a variable: `& $exe $args` (spec §5 case 4).
const RE_PS_CALL_VAR = /&\s+\$[a-z_@0-9?#!*\-]/;
const RE_BASE64_DECODE = /(^|\s)base64\s+(?:-d|--decode)(?=\s|$)/;
const RE_SINGLE_VAR = /^\$[a-z_]\w*$/;

// --- detection helpers -----------------------------------------------------

function isReleaseOrDeploy(norm) {
  return RELEASE_DEPLOY_SUBSTRINGS.some((s) => norm.includes(s));
}

function isRemoteBootstrap(norm) {
  const curlWget = RE_CURL_WGET.test(norm);
  const irmIwr = RE_IRM_IWR.test(norm);
  if (!curlWget && !irmIwr) return false;
  if (curlWget && RE_PIPE_SHELL.test(norm)) return true;
  if ((curlWget || irmIwr) && RE_PIPE_IEX.test(norm)) return true;
  return false;
}

/**
 * Detect a recursive force-delete (POSIX rm, PowerShell Remove-Item, or CMD
 * rd/del) of a catastrophic standalone target. Returns { homeOrCurrent } when
 * the command is a destructive delete of a catastrophic token, else null.
 */
function detectDestructiveDelete(norm) {
  let verb = false;
  if (RE_RM.test(norm)) {
    const rf = hasFlagRf(norm) || (hasFlag(norm, 'r') && hasFlag(norm, 'f'));
    if (rf) verb = true;
  }
  if (!verb && RE_PS_DELETE_VERB.test(norm) && RE_PS_RECURSE.test(norm) && RE_PS_FORCE.test(norm)) {
    verb = true;
  }
  if (!verb && RE_CMD_DELETE_VERB.test(norm) && RE_CMD_S.test(norm) && (RE_CMD_Q.test(norm) || RE_CMD_F.test(norm))) {
    verb = true;
  }
  if (!verb) return null;
  const homeOrCurrent = RE_HOME_OR_CURRENT.test(norm);
  const root = RE_ROOT.test(norm);
  if (!homeOrCurrent && !root) return null; // no catastrophic target -> allow
  return { homeOrCurrent };
}

/** Detect indirection that hides the real target (spec §5). */
function isUnparseableIndirection(norm) {
  // eval / iex of a variable, special parameter, or computed string.
  if (RE_EVAL_IEX.test(norm) && RE_VAR_REF.test(norm)) return true;
  // entire command is a single variable invocation, e.g. `$cmd`
  if (RE_SINGLE_VAR.test(norm)) return true;
  // command substitution (backtick or $(...)) wrapping a $-reference — the
  // destructive verb may be literal but its target is hidden, e.g.
  // `$(rm -rf $target)` or `` `rm -rf $target` ``.
  if (hasSubstitutionVar(norm)) return true;
  // PowerShell call operator on a variable: `& $exe $args`.
  if (RE_PS_CALL_VAR.test(norm)) return true;
  // base64-decoded payload piped into a shell.
  if (RE_BASE64_DECODE.test(norm) && RE_PIPE_SHELL.test(norm)) return true;
  return false;
}

// --- classifier ------------------------------------------------------------

/**
 * Classify a command string under a policy mode. Pure.
 * @returns {{decision:'deny'|'allow', code:string, reason:string}}
 */
export function classifyCommand(command, mode = 'advisory') {
  const norm = normalizeCommand(command);
  if (norm.length === 0) return { decision: 'allow', code: CODE.ALLOW, reason: PRETOOL_REASON[CODE.ALLOW] };

  // 1. Privilege escalation.
  if (RE_SUDO.test(norm)) return deny(CODE.SUDO, PRETOOL_REASON[CODE.SUDO]);
  if (RE_RUNAS.test(norm) || RE_START_PROCESS_RUNAS.test(norm)) return deny(CODE.SUDO, ESCALATION_REASON);

  // 2. Disk formatting.
  if (RE_MKFS.test(norm) || RE_DD.test(norm) || RE_FORMAT_VOLUME.test(norm) || RE_FORMAT.test(norm)) {
    return deny(CODE.DISK, PRETOOL_REASON[CODE.DISK]);
  }

  // 3. Recursive force-delete of a catastrophic target.
  const del = detectDestructiveDelete(norm);
  if (del) {
    const code = del.homeOrCurrent ? CODE.HOME_OR_CURRENT : CODE.DESTRUCTIVE;
    return deny(code, PRETOOL_REASON[code]);
  }

  // 4. Force push.
  if (RE_GIT_PUSH.test(norm) && RE_FORCE_FLAG.test(norm)) {
    return deny(CODE.DESTRUCTIVE, PRETOOL_REASON[CODE.DESTRUCTIVE]);
  }

  // 5. git reset --hard.
  if (RE_GIT_RESET_HARD.test(norm)) return deny(CODE.DESTRUCTIVE, PRETOOL_REASON[CODE.DESTRUCTIVE]);

  // 6. Release / deploy.
  if (isReleaseOrDeploy(norm)) return deny(CODE.RELEASE_DEPLOY, PRETOOL_REASON[CODE.RELEASE_DEPLOY]);

  // 7. Remote shell bootstrap.
  if (isRemoteBootstrap(norm)) return deny(CODE.REMOTE_BOOTSTRAP, PRETOOL_REASON[CODE.REMOTE_BOOTSTRAP]);

  // 8. Unparseable indirection — denied only in enforce mode (fail-closed).
  if (mode === 'enforce' && isUnparseableIndirection(norm)) {
    return deny(CODE.UNPARSEABLE, PRETOOL_REASON[CODE.UNPARSEABLE]);
  }

  // 9. Allow.
  return { decision: 'allow', code: CODE.ALLOW, reason: PRETOOL_REASON[CODE.ALLOW] };
}

function deny(code, reason) {
  return { decision: 'deny', code, reason };
}

/** True if the command is hard-denied by the profile in the given mode. */
export function isHardDenied(command, mode = 'advisory') {
  return classifyCommand(command, mode).decision === 'deny';
}

// --- PermissionDenied retry verdict ----------------------------------------

/**
 * Decide whether a PermissionDenied event should retry. A hard-denied command
 * (in the active mode) never retries; benchmark CI context never retries
 * (mirrors lib.sh permission_denied_should_retry); otherwise retry so the agent
 * can try a different command.
 * @returns {{retry:boolean}}
 */
export function permissionDeniedOutcome(command, env = process.env) {
  const mode = resolveMode(env);
  if (classifyCommand(command, mode).decision === 'deny') return { retry: false };
  if (isBenchmarkCi(env)) return { retry: false };
  return { retry: true };
}

// --- per-event message helpers (used by the dispatcher handlers) -----------

/** PreToolUse errorDetails markdown (matches legacy emit_pretool_decision). */
export function pretoolErrorDetails(decision, reason) {
  return [
    '### PreToolUse Decision\n\n',
    `- **Decision:** ${decision}\n`,
    `- **Reason:** ${reason}\n`,
    '\n### What to Do Instead\n\n',
    '- Use safe alternatives to blocked commands\n',
    "- For build/test/deploy, use the repo's CI/CD workflow\n",
    '\n---\n',
    `**Decision:** ${decision}\n`,
    `**Reason:** ${reason}\n`,
  ].join('');
}

/** PermissionRequest errorDetails markdown (matches legacy emit_permission_request_deny). */
export function permRequestErrorDetails(message) {
  return [
    '### Permission Request Denied\n\n',
    '- **Decision:** deny\n',
    `- **Reason:** ${message}\n`,
    '\n### What to Do Instead\n\n',
    '- Use allowed commands per the profile\n',
    '- For manual review, use the CLI directly with explicit approval\n',
    '\n---\n',
    '**Decision:** deny\n',
    `**Reason:** ${message}\n`,
  ].join('');
}

/** The PermissionRequest deny message for a classifier result. */
export function permRequestMessage(cls) {
  return PERMREQUEST_MESSAGE[cls.code] ?? 'the command is blocked by this profile';
}

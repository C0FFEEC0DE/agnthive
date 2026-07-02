// verification.mjs — test/lint/build command discovery and outcome tracking.
// Ported from lib.sh: detect_node_script, detect_make_target, detect_test_cmd,
// detect_lint_cmd, detect_build_cmd, command_class, is_release_or_deploy_command.
// Node standard library only. Discovery reads the project directory
// (CLAUDE_PROJECT_DIR || cwd); command_class and is_release_or_deploy_command
// are pure string functions.
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
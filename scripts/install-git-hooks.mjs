#!/usr/bin/env node
// Installs the optional local git hooks (a pre-push secret scan) into the
// current repository's .git/hooks. Opt-in and repo-local — it does NOT touch
// your global git config or ~/.claude.
//
// Usage:  node scripts/install-git-hooks.mjs
// Remove: rm .git/hooks/pre-push
//
// The bundled hook is a Node ESM script (scripts/git-hooks/pre-push.mjs). Git
// invokes .git/hooks/pre-push as an executable with no extension, so this
// installer writes a tiny Node-shebang wrapper that execs the real .mjs —
// keeping the hook source under version control as Node ESM while leaving a
// working executable in .git/hooks.
import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = join(SCRIPT_DIR, 'git-hooks', 'pre-push.mjs');

function fail(msg, code) {
  process.stderr.write(`install-git-hooks: ${msg}\n`);
  process.exit(code);
}

function gitHooksDir() {
  const r = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], { stdio: 'pipe', encoding: 'utf-8' });
  if (r.status !== 0) fail('could not resolve .git/hooks directory', 1);
  return r.stdout.trim();
}

function main() {
  if (!existsSync(SRC)) fail(`source hook not found at ${SRC}`, 1);
  const destDir = gitHooksDir();
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, 'pre-push');

  // Write a minimal Node-shebang wrapper that runs the real ESM hook source.
  // The wrapper uses process.execPath (the current node binary) so it works
  // regardless of where node is installed on the contributor's machine.
  const absSrc = resolve(SRC);
  const wrapper =
    '#!/usr/bin/env node\n' +
    '// Auto-installed pre-push wrapper — runs scripts/git-hooks/pre-push.mjs.\n' +
    `import { spawnSync } from 'node:child_process';\n` +
    `import { fileURLToPath } from 'node:url';\n` +
    `const r = spawnSync(process.execPath, [${JSON.stringify(absSrc)}], { stdio: 'inherit' });\n` +
    `process.exit(r.status ?? 1);\n`;
  writeFileSync(dest, wrapper);
  chmodSync(dest, 0o755);
  process.stdout.write(`Installed pre-push secret-scan hook -> ${dest}\n`);
  process.stdout.write(`To remove: rm ${dest}\n`);
}

main();
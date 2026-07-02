#!/usr/bin/env node
// Optional local pre-push hook: fast secret scan of the commits being pushed.
// Opt-in — install with `scripts/install-git-hooks.mjs`.
//
// This is a fast first line of defense; the authoritative scan is TruffleHog in
// CI (.github/workflows/security-scan.yml). A match blocks the push so you can
// review before anything leaves your machine.
//
// Git invokes pre-push on stdin with lines of:
//   <local ref> <local sha> <remote ref> <remote sha>
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Patterns that almost always indicate a real secret. Kept short and
// high-signal to avoid noisy false positives on a pre-push gate.
const SECRET_PATTERN = new RegExp(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----|' +
  'sk-[a-zA-Z0-9]{20,}|' +
  'ghp_[0-9A-Za-z]{36,}|' +
  'gho_[0-9A-Za-z]{36,}|' +
  'glpat-[0-9a-zA-Z_-]{20,}|' +
  'xox[baprs]-[0-9a-zA-Z-]+|' +
  'AKIA[0-9A-Z]{16}|' +
  'AIza[0-9A-Za-z_-]{35}',
);

// Secret-bearing path segments/names. Anchored to path boundaries so a normal
// source path like src/credentials.go is not matched; we only flag files whose
// name or a path segment is exactly credentials/secrets, or a secret extension.
const SECRET_PATH_REGEX = /(^|\/)(credentials|secrets)(\/|$)|\.(env|pem|key|p12|pfx|keystore|jks)(\.|$)/;

function gitText(args) {
  const r = spawnSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  return r.status === 0 ? r.stdout : '';
}

function readStdin() {
  // Synchronous read of all of stdin (fd 0). Node exposes fs.readFileSync(0).
  try { return readFileSync(0, 'utf-8'); } catch { return ''; }
}

/**
 * Scan the pushed commits for secrets. Exported for unit testing — accepts the
 * stdin lines and returns { status, messages } where status is 0 (clean) or 1
 * (blocked) and messages is the list of stderr-bound warning lines.
 */
export function scanPushedCommits(stdinLines) {
  const messages = [];
  let status = 0;
  for (const line of stdinLines.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(' ');
    const localSha = parts[1] || '';
    if (!localSha) continue;
    // Commits being pushed = reachable from localSha but not from any remote.
    const newCommitsArgs = ['log', '--name-only', '--pretty=format:', localSha, '--not', '--remotes'];
    const filesText = gitText(newCommitsArgs);
    const files = [...new Set(filesText.split('\n').filter(Boolean))];

    // 1) Filename heuristic: block secret-bearing file names/extensions.
    const badFiles = files.filter((f) => SECRET_PATH_REGEX.test(f));
    if (badFiles.length) {
      messages.push('pre-push: refusing to push possible secret-bearing file(s):');
      for (const f of badFiles) messages.push(f);
      status = 1;
    }

    // 2) Content scan: grep only ADDED lines of the pushed commits for the
    //    secret pattern. We filter to `+` lines (excluding `+++` file headers)
    //    so the gate fires only on lines a commit introduces, never on context
    //    or deletion lines. (Deleting a secret keeps it as a `-` line and would
    //    block the very push that removes it.)
    const patch = gitText(['log', '-p', localSha, '--not', '--remotes']);
    const addedLines = patch.split('\n').filter((l) => /^\+([^+]|$)/.test(l));
    const secretHit = addedLines.some((l) => SECRET_PATTERN.test(l));
    if (secretHit) {
      messages.push('pre-push: possible secret detected in pushed commits — review before pushing:');
      for (const f of files.slice(0, 20)) messages.push(f);
      status = 1;
    }
  }
  if (status !== 0) messages.push('pre-push: blocked. Remove the secret, or push with --no-verify only after review.');
  return { status, messages };
}

function main() {
  const stdin = readStdin();
  const { status, messages } = scanPushedCommits(stdin);
  for (const m of messages) process.stderr.write(`${m}\n`);
  process.exit(status);
}

// Cross-platform main-module detection (see scripts/bench/lib.mjs isMain).
const isMain = (() => { try { return pathToFileURL(process.argv[1]).href === import.meta.url; } catch { return false; } })();
if (isMain) main();
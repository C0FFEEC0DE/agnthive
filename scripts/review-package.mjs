#!/usr/bin/env node
// review-package — write a review package (commit list + diffstat + full diff)
// for BASE..HEAD to a uniquely named file and print the path. The reviewer
// reads one file instead of re-deriving the branch diff with git commands, so
// the diff never enters the controller's context.
//
// Usage: review-package BASE HEAD
//   BASE, HEAD are commit-ish. BASE may be the literal token MERGE_BASE, which
//   resolves to git merge-base of the default branch and HEAD (use for the
//   final whole-branch review).
//
// Output dir: $CLAUDE_CREW_REVIEW_DIR, else .claude-crew/reviews/ under the git
// toplevel (or cwd). That path is gitignored (see .gitignore).
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function git(args, opts = {}) {
  const r = spawnSync('git', args, { stdio: 'pipe', encoding: 'utf-8', ...opts });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function fail(msg, code) {
  process.stderr.write(`review-package: ${msg}\n`);
  process.exit(code);
}

function gitToplevel() {
  const r = git(['rev-parse', '--show-toplevel']);
  return r.status === 0 ? r.stdout.trim() : '';
}

function resolveBase(baseArg, headArg) {
  if (baseArg === 'MERGE_BASE') {
    let defaultBranch = '';
    const sym = git(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    if (sym.status === 0) {
      const name = sym.stdout.trim().replace('refs/remotes/origin/', '');
      if (name) defaultBranch = `origin/${name}`;
    }
    if (!defaultBranch) {
      for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
        const v = git(['rev-parse', '--verify', candidate]);
        if (v.status === 0) { defaultBranch = candidate; break; }
      }
      if (!defaultBranch) fail('cannot determine default branch for MERGE_BASE', 2);
    }
    const mb = git(['merge-base', defaultBranch, headArg]);
    if (mb.status !== 0) fail(`merge-base failed for ${defaultBranch}..${headArg}`, 2);
    return mb.stdout.trim();
  }
  const v = git(['rev-parse', '--verify', `${baseArg}^{commit}`]);
  if (v.status !== 0) fail(`invalid base commit-ish: ${baseArg}`, 2);
  return v.stdout.trim();
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write('Usage: review-package BASE HEAD\n');
    process.stderr.write('  BASE may be MERGE_BASE to resolve git merge-base of the default branch and HEAD\n');
    process.exit(2);
  }
  const [baseArg, headArg] = args;

  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true')
    fail('not inside a git work tree', 2);

  const baseSha = resolveBase(baseArg, headArg);
  const headRev = git(['rev-parse', '--verify', `${headArg}^{commit}`]);
  if (headRev.status !== 0) fail(`invalid head commit-ish: ${headArg}`, 2);
  const headSha = headRev.stdout.trim();
  const base7 = baseSha.slice(0, 7);
  const head7 = headSha.slice(0, 7);

  let reviewDir = process.env.CLAUDE_CREW_REVIEW_DIR || '';
  if (!reviewDir) {
    const toplevel = gitToplevel();
    reviewDir = toplevel ? join(toplevel, '.claude-crew', 'reviews') : join(process.cwd(), '.claude-crew', 'reviews');
  }
  mkdirSync(reviewDir, { recursive: true });
  const reviewFile = join(reviewDir, `${base7}..${head7}-review.md`);

  const log = git(['log', '--oneline', `${baseSha}..${headSha}`]).stdout;
  const diffstat = git(['diff', '--stat', `${baseSha}..${headSha}`]).stdout;
  const diff = git(['diff', '-U10', `${baseSha}..${headSha}`]).stdout;

  const body =
    `# Review package: ${base7}..${head7}\n\n` +
    `## Commits\n\n\`\`\`\n${log}` +
    `\n\`\`\`\n\n## Diffstat\n\n\`\`\`\n${diffstat}` +
    `\n\`\`\`\n\n## Full diff (-U10)\n\n\`\`\`diff\n${diff}\n\`\`\`\n`;
  writeFileSync(reviewFile, body);
  process.stdout.write(`${reviewFile}\n`);
}

// Cross-platform main-module detection (see scripts/bench/lib.mjs isMain).
const isMain = (() => { try { return pathToFileURL(process.argv[1]).href === import.meta.url; } catch { return false; } })();
if (isMain) main();
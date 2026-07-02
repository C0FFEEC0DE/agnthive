// Validate benchmark workflow configuration.
// Faithful Node port of the former pytest suite (test/validators/test_workflow_config.py).
// Dependency-free: targeted text/indentation parsing, no js-yaml.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// test/validators/workflow-config.test.mjs -> parents[2] == repo root
const REPO_ROOT = join(__dirname, '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

/**
 * Extract a single job block from a GitHub Actions workflow YAML by name,
 * capturing from the `  <name>:` line under `jobs:` until the next top-level
 * job key at the same indent (two leading spaces) or EOF. Pure text parsing —
 * no YAML dependency. Returns the block text or null if the job is absent.
 */
function extractJobBlock(content, jobName) {
  const lines = content.split('\n');
  let started = false;
  const block = [];
  // Job keys live at two-space indent under `jobs:`.
  const jobKeyRe = new RegExp(`^  ${jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[ ]*$`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!started) {
      if (jobKeyRe.test(line)) started = true;
      continue;
    }
    // Started: collect until the next top-level job at the same indent.
    // A next job key looks like `  something:` (exactly two leading spaces).
    if (/^  [A-Za-z0-9_-]+:[ ]*$/.test(line)) break;
    block.push(line);
  }
  return started ? block.join('\n') : null;
}

test('subagent smoke max_turns default is at least eight', () => {
  // Smoke suite must allow enough turns for multi-step subagent conversations.
  const path = join(WORKFLOWS_DIR, 'behavior-benchmark-subagents-smoke.yml');
  assert.ok(existsSync(path), `${path} should exist`);
  const content = readFileSync(path, 'utf-8');
  // Find the default value in the shell script: max_turns="${INPUT_MAX_TURNS:-N}"
  const match = content.match(/max_turns="\$\{INPUT_MAX_TURNS:-(\d+)\}"/);
  assert.ok(match, 'max_turns default not found');
  const defaultVal = parseInt(match[1], 10);
  assert.ok(defaultVal >= 8, `default max_turns is ${defaultVal}, expected >= 8`);
});

test('security-scan checkout fetches full history', () => {
  // TruffleHog needs full history to diff BASE and HEAD commits.
  const path = join(WORKFLOWS_DIR, 'security-scan.yml');
  assert.ok(existsSync(path), `${path} should exist`);
  const content = readFileSync(path, 'utf-8');

  // Dependency-free structured check: extract the security-scan job block by
  // indentation rather than parsing YAML with js-yaml.
  const block = extractJobBlock(content, 'security-scan');
  assert.ok(block !== null, 'security-scan job block not found');
  assert.ok(
    block.includes('actions/checkout@v5'),
    "security-scan job must use actions/checkout@v5",
  );
  assert.ok(
    block.includes('fetch-depth: 0'),
    'fetch-depth must be 0 so TruffleHog can diff commits',
  );
  // Confirm fetch-depth value is exactly 0 (not e.g. 10).
  const fd = block.match(/fetch-depth:\s*(\d+)/);
  assert.ok(fd, 'fetch-depth directive not found in security-scan job');
  assert.equal(parseInt(fd[1], 10), 0, 'fetch-depth must be 0');
});

test('security-scan trufflehog base is not literal main', () => {
  // TruffleHog base should point to PR base sha, not literal 'main' ref.
  const path = join(WORKFLOWS_DIR, 'security-scan.yml');
  assert.ok(existsSync(path), `${path} should exist`);
  const content = readFileSync(path, 'utf-8');
  assert.ok(
    !content.includes('base: main'),
    "literal 'base: main' breaks on PRs where HEAD == BASE",
  );
  assert.ok(
    content.includes('github.event.pull_request.base.sha'),
    'should use PR base sha for TruffleHog base',
  );
});
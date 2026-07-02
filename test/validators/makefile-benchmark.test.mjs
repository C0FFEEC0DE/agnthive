// Node port of the former pytest suite (test/validators/test_makefile_benchmark.py) — verifies the
// bench-smoke Makefile target defaults to a local, auth-free Ollama profile
// and that hosted overrides flow through via make variable assignments.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

// Run `make -n <args>` against the repo with a sanitized environment so that
// any pre-set hosted-Ollama credentials cannot leak into the local default.
function runMakeDryRun(...args) {
  const env = { ...process.env };
  env.OLLAMA_API_KEY = 'must-not-be-used-by-local-default';
  delete env.OLLAMA_MODEL;
  delete env.BENCH_ANTHROPIC_BASE_URL;
  delete env.BENCH_ANTHROPIC_AUTH_TOKEN;
  delete env.BENCH_ANTHROPIC_API_KEY;

  const result = spawnSync('make', ['-n', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env,
  });
  assert.equal(
    result.status,
    0,
    `make -n ${args.join(' ')} exited ${result.status}\n${result.stderr}`,
  );
  return result.stdout;
}

test('bench-smoke defaults to local ollama without auth', () => {
  const output = runMakeDryRun('bench-smoke');

  assert.ok(output.includes("ANTHROPIC_BASE_URL='http://127.0.0.1:11434'"), output);
  assert.ok(output.includes("ANTHROPIC_AUTH_TOKEN=''"), output);
  assert.ok(output.includes("ANTHROPIC_API_KEY=''"), output);
  // No model is pinned by default; the profile is model-agnostic.
  assert.ok(output.includes("OLLAMA_MODEL=''"), output);
  assert.ok(!output.includes('must-not-be-used-by-local-default'), output);
});

test('bench-smoke allows hosted ollama override', () => {
  const output = runMakeDryRun(
    'bench-smoke',
    'BENCH_ANTHROPIC_BASE_URL=https://ollama.com',
    'BENCH_ANTHROPIC_AUTH_TOKEN=test-token',
    'OLLAMA_MODEL=example-model',
  );

  assert.ok(output.includes("ANTHROPIC_BASE_URL='https://ollama.com'"), output);
  assert.ok(output.includes("ANTHROPIC_AUTH_TOKEN='test-token'"), output);
  assert.ok(output.includes("OLLAMA_MODEL='example-model'"), output);
});
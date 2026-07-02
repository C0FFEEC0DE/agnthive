#!/usr/bin/env node
// wait-for-benchmark-slot: polls the GitHub Actions API and waits until the
// current run is among the `max-active` oldest active benchmark runs.
// Node port of scripts/wait-for-benchmark-slot.py — no Python. Uses global
// fetch (Node 22+); testable via the exported `clock` and `deps` objects.
import { isMain, githubHeaders, parseRetryAfter } from './bench/lib.mjs';

export { parseRetryAfter };

const BEHAVIOR_WORKFLOW_NAMES = new Set([
  'Behavior Benchmark Smoke',
  'Behavior Benchmark Full',
  'Behavior Benchmark Subagents Smoke',
]);
const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
const RATE_LIMIT_BODY_MARKERS = ['rate_limit_exceeded', 'rate limit exceeded', 'rate limit'];

export class GithubHttpError extends Error {
  constructor(code, headers, body = '') {
    super(`HTTP ${code}`);
    this.code = code;
    this.headers = headers;
    this.body = body;
  }
}

export function orderActiveRuns(runs) {
  return [...runs].sort((a, b) => {
    const ca = a.created_at || '';
    const cb = b.created_at || '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return Number(a.id || 0) - Number(b.id || 0);
  });
}

export function currentRunHasSlot({ currentRunId, runs, maxActive }) {
  const ordered = orderActiveRuns(runs);
  const allowed = ordered.slice(0, maxActive).map((r) => Number(r.id));
  return [allowed.includes(Number(currentRunId)), allowed];
}

export function isGithubRateLimit(err) {
  if (err.code !== 403) return false;
  const remaining = err.headers && err.headers.get ? err.headers.get('X-RateLimit-Remaining') : '';
  if (remaining === '0') return true;
  const body = (err.body || '').toLowerCase();
  return RATE_LIMIT_BODY_MARKERS.some((m) => body.includes(m));
}

export function buildRequest(url, token) {
  return { url, headers: githubHeaders(token) };
}

export async function fetchActiveBehaviorRuns({ apiUrl, repo, token, headSha }) {
  const url = `${apiUrl}/repos/${repo}/actions/runs?per_page=100`;
  const r = await fetch(url, { headers: githubHeaders(token) });
  if (!r.ok) {
    let body = '';
    try { body = await r.text(); } catch {}
    throw new GithubHttpError(r.status, r.headers, body);
  }
  const payload = await r.json();
  const runs = payload.workflow_runs || [];
  return runs.filter((run) =>
    BEHAVIOR_WORKFLOW_NAMES.has(run.name) &&
    run.head_sha === headSha &&
    ACTIVE_STATUSES.has(run.status));
}

const realClock = {
  sleep: (seconds) => {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, Math.max(0, seconds) * 1000);
  },
  monotonic: () => performance.now() / 1000,
};

export const clock = { sleep: realClock.sleep, monotonic: realClock.monotonic };

export function handleRateLimit(err) {
  const parsed = parseRetryAfter(err.headers && err.headers.get ? err.headers.get('Retry-After') : null);
  const waitSeconds = parsed !== null ? parsed : 60;
  process.stderr.write(`GitHub API rate limit hit (HTTP 403). Retrying after ${waitSeconds}s (Retry-After header, default 60).\n`);
  clock.sleep(waitSeconds);
  return null;
}

export function handleTransientError(err, attempt) {
  const maxRetries = 5;
  if (attempt >= maxRetries) return false;
  const delay = Math.min(2 ** attempt, 60);
  process.stderr.write(`Transient error: ${err && err.message ? err.message : err}. Retry ${attempt + 1}/${maxRetries} after ${delay}s.\n`);
  clock.sleep(delay);
  return true;
}

export const deps = { fetchActiveBehaviorRuns, handleRateLimit };

function parseArgs(argv) {
  const out = {
    currentRunId: null, headSha: null, maxActive: 2, pollSeconds: 15, timeoutSeconds: 3600,
    repo: process.env.GITHUB_REPOSITORY || '', apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--current-run-id') out.currentRunId = Number.parseInt(argv[++i], 10);
    else if (a === '--head-sha') out.headSha = argv[++i];
    else if (a === '--max-active') out.maxActive = Number.parseInt(argv[++i], 10);
    else if (a === '--poll-seconds') out.pollSeconds = Number.parseInt(argv[++i], 10);
    else if (a === '--timeout-seconds') out.timeoutSeconds = Number.parseInt(argv[++i], 10);
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--api-url') out.apiUrl = argv[++i];
    else { process.stderr.write(`unknown argument: ${a}\n`); process.exit(2); }
  }
  if (out.currentRunId === null || !out.headSha) { process.stderr.write('Usage: wait-for-benchmark-slot.mjs --current-run-id N --head-sha SHA [...]\n'); process.exit(2); }
  return out;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN || '';
  if (!args.repo) { process.stderr.write('GITHUB_REPOSITORY or --repo is required\n'); return 2; }
  if (!token) { process.stderr.write('GITHUB_TOKEN is required\n'); return 2; }

  const deadline = clock.monotonic() + args.timeoutSeconds;
  let transientAttempt = 0;
  while (true) {
    let activeRuns;
    try {
      activeRuns = await deps.fetchActiveBehaviorRuns({
        apiUrl: args.apiUrl, repo: args.repo, token, headSha: args.headSha,
      });
      transientAttempt = 0;
    } catch (err) {
      if (err instanceof GithubHttpError) {
        if (isGithubRateLimit(err)) {
          const result = deps.handleRateLimit(err);
          if (result !== null) return result;
          continue;
        }
        if ([500, 502, 503, 504].includes(err.code)) {
          if (handleTransientError(err, transientAttempt)) { transientAttempt++; continue; }
        }
        const snippet = (err.body || '').slice(0, 500);
        if (snippet) process.stderr.write(`GitHub API request failed with HTTP ${err.code}: ${snippet}\n`);
        else process.stderr.write(`GitHub API request failed with HTTP ${err.code}\n`);
        return 1;
      }
      if (handleTransientError(err, transientAttempt)) { transientAttempt++; continue; }
      process.stderr.write(`GitHub API request failed: ${err && err.message ? err.message : err}\n`);
      return 1;
    }

    const [hasSlot, allowedIds] = currentRunHasSlot({
      currentRunId: args.currentRunId, runs: activeRuns, maxActive: args.maxActive,
    });
    const activeIds = orderActiveRuns(activeRuns).map((r) => Number(r.id));
    process.stdout.write(`Active benchmark workflow runs for ${args.headSha.slice(0, 12)}: ${JSON.stringify(activeIds)}. Allowed now: ${JSON.stringify(allowedIds)}.\n`);
    if (hasSlot) {
      process.stdout.write(`Run ${args.currentRunId} has a benchmark slot.\n`);
      return 0;
    }
    if (clock.monotonic() >= deadline) {
      process.stderr.write(`Timed out waiting for benchmark slot after ${args.timeoutSeconds}s. Current run ${args.currentRunId} never entered the first ${args.maxActive}.\n`);
      return 1;
    }
    clock.sleep(args.pollSeconds);
  }
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code ?? 0));
}
#!/usr/bin/env node
// download-benchmark-summary: download a summary.json artifact from a GitHub
// Actions run. Node port of scripts/download-benchmark-summary.py — no Python.
// Uses global fetch (Node 22+) and a minimal ZIP reader built on node:zlib
// (Node stdlib has no unzip; the central directory is parsed directly).
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { isMain, githubHeaders } from './bench/lib.mjs';

/** Find a non-expired artifact by name in a GitHub artifacts listing. */
export function findArtifact(artifacts, artifactName) {
  for (const a of artifacts) {
    if (a.name === artifactName && !a.expired) return a;
  }
  throw new Error(`Artifact not found or expired: ${artifactName}`);
}

/**
 * Extract the summary.json bytes from a ZIP archive (Buffer). Matches the
 * Python behavior: any entry whose basename is "summary.json" is returned.
 */
export function extractSummaryBytes(zipBytes) {
  const buf = Buffer.isBuffer(zipBytes) ? zipBytes : Buffer.from(zipBytes);
  // Locate End Of Central Directory record (PK\x05\x06).
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65557; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('summary.json was not found inside the downloaded artifact');
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const fnLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const fn = buf.slice(p + 46, p + 46 + fnLen).toString('utf-8');
    if (basename(fn) === 'summary.json') {
      // Local file header: skip to compressed data.
      const lfnLen = buf.readUInt16LE(localOffset + 26);
      const lextraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lfnLen + lextraLen;
      if (method === 0) return buf.slice(dataStart, dataStart + compSize);
      if (method === 8) return inflateRawSync(buf.slice(dataStart, dataStart + compSize));
      throw new Error(`summary.json was not found inside the downloaded artifact`);
    }
    p += 46 + fnLen + extraLen + commentLen;
  }
  throw new Error('summary.json was not found inside the downloaded artifact');
}

// HTTP helpers (async; use global fetch). Tests may stub these via `http`.
export async function githubGetJson(url, token) {
  const r = await fetch(url, { headers: githubHeaders(token) });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new HttpError(r.status, detail);
  }
  return r.json();
}

export async function githubGetRedirectUrl(url, token) {
  const r = await fetch(url, { headers: githubHeaders(token), redirect: 'manual' });
  // Node returns the 30x response with status; read Location.
  const loc = (r.headers.get('Location') || '').trim();
  if (!loc) throw new Error('Artifact download did not return a redirect location');
  return loc;
}

export async function publicGetBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new HttpError(r.status, await r.text().catch(() => ''));
  return Buffer.from(await r.arrayBuffer());
}

class HttpError extends Error {
  constructor(code, detail) { super(`HTTP ${code}: ${detail}`); this.code = code; this.detail = detail; }
}
export { HttpError };

export const http = { githubGetJson, githubGetRedirectUrl, publicGetBytes };

export async function downloadSummary(repo, runId, artifactName, token) {
  const artifactsUrl = `https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts`;
  const payload = await http.githubGetJson(artifactsUrl, token);
  const artifact = findArtifact(payload.artifacts || [], artifactName);
  const zipUrl = `https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`;
  const redirectUrl = await http.githubGetRedirectUrl(zipUrl, token);
  return extractSummaryBytes(await http.publicGetBytes(redirectUrl));
}

function parseArgs(argv) {
  const out = { repo: null, runId: null, artifactName: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--run-id') out.runId = Number.parseInt(argv[++i], 10);
    else if (a === '--artifact-name') out.artifactName = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else { process.stderr.write(`unknown argument: ${a}\n`); process.exit(2); }
  }
  if (!out.repo) { process.stderr.write('--repo is required\n'); process.exit(2); }
  if (!out.runId) { process.stderr.write('--run-id is required\n'); process.exit(2); }
  if (!out.artifactName) { process.stderr.write('--artifact-name is required\n'); process.exit(2); }
  if (!out.output) { process.stderr.write('--output is required\n'); process.exit(2); }
  return out;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = (process.env.GITHUB_TOKEN || '').trim();
  if (!token) { process.stderr.write('GITHUB_TOKEN is required\n'); process.exit(1); }
  try {
    const summaryBytes = await downloadSummary(args.repo, args.runId, args.artifactName, token);
    writeFileSync(args.output, summaryBytes);
  } catch (err) {
    if (err instanceof HttpError) {
      process.stderr.write(`GitHub API request failed with HTTP ${err.code}: ${err.detail}\n`);
    } else {
      process.stderr.write(`GitHub API request failed: ${err.message}\n`);
    }
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  main();
}
// evidence.mjs — ADR-0009 amendment (2026-11-27): file fingerprints that keep a
// completed verification record bound to the tree it actually certified.
// Revision scoping catches edits the hooks observe; a fingerprint catches a
// write from outside the session (editor, git checkout, formatter, build step)
// that lands between the passing check and the Stop gate.
// Node standard library only.
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

// One fingerprint entry. A path that cannot be stat'ed is recorded as missing
// rather than dropped, so a file that appears later still registers as a change.
export function fileFingerprint(filePath, cwd = '') {
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd || process.cwd(), filePath);
  try {
    const st = statSync(abs);
    return { path: abs, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { path: abs, missing: true };
  }
}

// Snapshot of the session's tracked change files, taken when evidence completes.
export function snapshotFiles(paths, cwd = '') {
  const out = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || p === '') continue;
    out.push(fileFingerprint(p, cwd));
  }
  return out;
}

// Paths whose fingerprint no longer matches the snapshot. A malformed entry
// counts as a mismatch so a corrupt record never certifies silently.
export function fingerprintMismatches(snapshot) {
  const changed = [];
  if (!Array.isArray(snapshot)) return changed;
  for (const entry of snapshot) {
    if (!entry || typeof entry.path !== 'string' || entry.path === '') {
      changed.push('(malformed entry)');
      continue;
    }
    const now = fileFingerprint(entry.path);
    if (entry.missing === true) {
      if (now.missing !== true) changed.push(entry.path);
      continue;
    }
    if (now.missing === true || now.size !== entry.size || now.mtimeMs !== entry.mtimeMs) {
      changed.push(entry.path);
    }
  }
  return changed;
}

// True when the current tree still matches the snapshot. A record with no
// snapshot (pre-amendment sessions, record-less fixtures) is left alone.
export function fingerprintsMatch(snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return true;
  return fingerprintMismatches(snapshot).length === 0;
}

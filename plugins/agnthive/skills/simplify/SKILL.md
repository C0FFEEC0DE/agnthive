---
name: simplify
description: Use when a change works but carries duplication, dead code, or needless abstraction — applies behavior-preserving reductions in the root, then re-verifies.
argument-hint: "<path or change scope to simplify>"
---

# /simplify

Stage 1 of `/review`, runnable on its own. Reduce the change without changing
what it does.

## Find

- Duplicated blocks and re-implemented helpers that already exist in the repo
- Dead code: unreachable branches, unused exports, params, options, config keys
- One-use abstractions: a wrapper, interface, or indirection with a single caller
- Comments that restate the code; stale names after a rename

## Apply

- Preserve behavior. Keep tests, public APIs, error messages, and permission
  logic as they are unless the task is explicitly to change them.
- Prefer deleting over abstracting; prefer one clear call site over a new helper.
- Do not reformat untouched code, rename unrelated symbols, or widen the diff.
- Do not weaken a test to make a reduction pass — revert the reduction instead.

## Verify

Re-run the detected tests, lint, and build for the change. Report what was
reduced, what was deliberately left alone, and the verification result. If the
scope is large, hand the resulting diff to `/review` stage 2 for an independent
read.

# Condition-based waiting

For flaky and timing-dependent failures, replace fixed `sleep` waits with
waiting on the actual condition. This is both a debugging technique and a fix
pattern.

## Principle

A flaky test that "sometimes fails" almost always has an unmet ordering or
readiness assumption. Masking it with `sleep(N)` makes the flake rarer, not
gone — and `sleep` is the largest source of slow, flaky suites.

## Debugging technique

When a failure is intermittent:

1. **Capture the ordering** — log timestamps around the suspected events. The
   gap between "expected first" and "actually first" is usually the bug.
2. **Find the condition the code assumed** — what did it wait for that did not
   happen, or happen in time? (a file to appear, a process to bind a port, a
   row to commit, a flag to flip).
3. **Reproduce by forcing the bad order** — invert or delay the condition and
   confirm the symptom fires deterministically. Now you have a reproducible
   flake.

## Fix pattern

Replace `sleep` with a bounded poll on the real condition:

```bash
# instead of: sleep 2
timeout 10 sh -c 'until grep -q "Ready" server.log; do sleep 0.1; done' \
    || { echo "server never became ready within 10s" >&2; exit 1; }
```

```python
# instead of: time.sleep(2)
import time
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    if server.is_ready():
        break
    time.sleep(0.1)
else:
    raise AssertionError("server never became ready")
```

Always bound the wait and fail loudly on timeout — a silent unbounded wait is
a hang, not a fix.

## See also

- [Root-cause tracing](debugging-root-cause-tracing.md)
- [Defense in depth](debugging-defense-in-depth.md)
- [Debugger agent](../agents/debugger.md)

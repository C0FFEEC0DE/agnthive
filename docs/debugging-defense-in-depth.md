# Defense in depth (debugging)

How to guard a fixed path so the same class of failure does not recur.

## Principle

A fix that removes one trigger is shallow. Defense in depth adds independent
layers so the next trigger — a different input, a race, a caller that bypasses
the guard — is caught before it reaches production.

## Layers

1. **The fix itself** — correct the root cause, not just the reported input.
2. **A regression test** — a test that fails without the fix and passes with it.
   This is the minimum bar; a fix without one is unverified.
3. **An assertion/guard at the boundary** — validate the input or invariant at
   the entry point so an invalid call fails loudly instead of silently
   corrupting state downstream.
4. **A broader invariant check** — where cheap, assert the property the bug
   violated (e.g. "total debits == total credits") so a future break in the
   same family surfaces immediately.

## When to stop

Defense in depth is not "add every possible check." Add a layer when the bug
class is real and the layer is cheap. Do not gold-plate a one-off; do add the
regression test and the boundary guard for a class of input the code will see
again.

## See also

- [Root-cause tracing](debugging-root-cause-tracing.md)
- [Condition-based waiting](debugging-condition-based-waiting.md)
- [Debugger agent](../claudecfg/agents/dbg.md)
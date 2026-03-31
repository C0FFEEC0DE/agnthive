# /debug

**This command invokes @debugger agent.**

Run debugging session with specialized debugging agent.

## When to use
- Bug not reproducible
- Need to investigate code behavior
- Crashes/errors without clear cause

## Usage
```
/debug [description of the bug/issue]
```

## Agent Actions
The @debugger agent will:
1. Reproduce the bug
2. Isolate minimal repro
3. Add logs/breakpoints
4. Hypothesis → test → conclusion
5. Propose fix and verify

## Important
- Don't change code until you understand the cause
- Document what you've tried
- Stop if stuck > 30 min
- The resulting handoff should end with exact footer prefixes recognized by the hooks: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`

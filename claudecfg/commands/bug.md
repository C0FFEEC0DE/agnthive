# /bug

**This command invokes @bugbuster agent.**

Run a focused bug-hunting session with the Bugbuster agent.

## When to use
- A failure exists but the root cause is not obvious
- Need to narrow down a regression
- Several code paths could explain the bug
- Want a targeted fix plan before editing

## Usage
```text
/bug [description of the bug]
```

## Agent Actions
The @bugbuster agent will:
1. Inspect the failing behavior
2. Narrow the likely root-cause area
3. Compare hypotheses against the code
4. Suggest the smallest credible fix path
5. Call out verification needed after the fix

## Important
- Prefer root cause over symptom-level patching
- Keep the investigation scoped to the described failure
- This is the documented entry point for the bug-investigation handoff used by `bugfix` workflows
- The resulting handoff should end with exact footer prefixes recognized by the hooks: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`

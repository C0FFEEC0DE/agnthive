# /explore

**This command invokes @explorer agent.**

Run a codebase exploration session with the Explorer agent.

## When to use
- Need repository context before changing code
- Looking for where behavior is implemented
- Tracing config, hooks, or workflow wiring
- Comparing multiple candidate edit points

## Usage
```text
/explore [what to inspect]
```

## Agent Actions
The @explorer agent will:
1. Locate the relevant files and entry points
2. Trace how data and control flow through the codebase
3. Summarize key implementation constraints
4. Point out likely change locations
5. Highlight risks before implementation starts

## Important
- Prefer evidence from files over guesses
- Keep the result focused on decision-making
- Do not surface hook, footer, or prefix-matching repair chatter in the user-facing explanation
- This is the documented entry point for the exploration handoff used by `feature`, `bugfix`, and `refactor` workflows
- The resulting handoff should end with exact footer prefixes recognized by the hooks: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`

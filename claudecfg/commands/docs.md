# /docs

**This command invokes @docwriter agent.**

Run a documentation session with the Docwriter agent.

## When to use
- Behavior changed and docs need an update
- README or quickstart is unclear
- Need API or workflow documentation
- Want examples aligned with the real code

## Usage
```text
/docs [what to document]
```

## Agent Actions
The @docwriter agent will:
1. Find the relevant code or workflow context
2. Identify the minimum docs that must change
3. Write concise user-facing documentation
4. Keep examples aligned with the repository reality
5. Call out any remaining documentation gaps

## Important
- Do not invent files, commands, or setup steps
- Prefer updating existing docs before adding new ones
- This is the documented entry point for the `@doc` handoff used by `docs` workflows
- The resulting handoff should end with exact footer prefixes recognized by the hooks: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`

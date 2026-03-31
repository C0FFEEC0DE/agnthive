# /design

**This command is now a skill that invokes @architect agent.**

Run design session with the Architect agent.

## When to use
- New feature
- Architectural decision
- Don't know where to start

## Usage
```
/design [what to design]
```

## Agent Actions
The @architect agent will:
1. Understand what needs to be achieved
2. Identify constraints
3. Propose solution options
4. Compare pros/cons
5. Choose and explain why
6. Ensure SOLID principles

## Important
- Document decisions
- Don't over-engineer
- YAGNI — don't do for "later"
- Start simple, improve as needed
- This handoff satisfies the design/exploration branch of the agent gate for `feature` and `refactor` workflows
- The resulting handoff should end with exact footer prefixes recognized by the hooks: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`

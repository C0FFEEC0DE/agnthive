# /manager

**This command invokes @manager agent.**

Run a manager-led orchestration session.

## When to use
- Multi-step task
- Need to break work into roles
- Unsure about execution order
- Want the workflow coordinated through verification and review

## Usage
```text
/manager [goal or task]
```

## Agent Actions
The @manager agent will:
1. Clarify the goal and constraints
2. Break the work into concrete steps
3. Choose and invoke the minimum specialist agents needed
4. Track verification and review checkpoints
5. Continue orchestration until completion or a concrete blocker

## Important
- Use this for end-to-end orchestration by default
- Use plan-only mode only when the user explicitly asks for planning without execution
- Prefer concrete agent handoffs and workflow progress over vague strategy
- Start the first required specialist handoff early instead of staying in manager-only analysis for multiple turns
- For broad review scopes, normally hand off to `@e` before `@cr` so the reviewer gets a mapped target area instead of doing all discovery inline
- Do not expose hook mechanics, footer formatting repair, or prefix-matching chatter in user-facing updates
- Call out blockers and assumptions explicitly
- Manager and specialist handoffs should end with exact footer prefixes recognized by the hooks: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`
- When the manager is producing the final implementation summary after code/config changes, include `Review outcome:` as well

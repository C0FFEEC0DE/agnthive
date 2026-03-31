# /refactor

**This command is now a skill that invokes @housekeeper agent, Veles.**

Run refactoring session with the Veles agent.

## When to use
- Code duplication
- Functions too long (>50 lines)
- Bad variable names
- Tests became fragile
- Technical debt cleanup

## Usage
```
/refactor [what to refactor]
```

## Agent Actions
The @housekeeper agent, Veles, will:
1. Find the problem
2. Describe the refactoring approach
3. Prepare a cleanup and safety checklist for the main implementation thread
4. Run or request verification after changes
5. Leave code cleaner than it was

## Important
- Separate commits for refactor
- Don't add features with refactor
- Leave code cleaner than it was
- This handoff satisfies the refactor design/cleanup branch of the gate together with required `@cr` and either successful verification or `@t`
- The resulting handoff should end with exact footer prefixes recognized by the hooks: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`

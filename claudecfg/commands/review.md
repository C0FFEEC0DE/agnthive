# /review

**This command is now a skill that invokes @code-reviewer agent.**

Run code review with the Code Reviewer agent.

## When to use
- Before committing
- PR review
- Security check
- Architecture review

## Usage
```
/review [what to review]
```

## Agent Actions
The @code-reviewer agent will:
1. Check for bugs and security issues
2. Review architecture and readability
3. Verify tests exist and pass
4. Suggest specific solutions, not just problems
5. Use `@explorer` first when the review scope is broad enough that code mapping would materially improve findings quality

## Checklist
- [ ] No obvious bugs
- [ ] Names are clear
- [ ] Functions short (<50 lines)
- [ ] Error handling exists
- [ ] Tests exist and pass
- [ ] No sensitive data in logs
- This is the documented entry point for the required `@cr` handoff used by `feature`, `bugfix`, `refactor`, and `review` workflows
- Review handoffs should also include `Review outcome:` plus exact footer prefixes recognized by the hooks: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`

## Review Scope Policy
- Small localized reviews can stay `@cr`-only
- Broad workflow, subsystem, or multi-file reviews should normally start with `@e` so `@cr` reviews against an explicit code map

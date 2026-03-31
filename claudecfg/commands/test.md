# /test

**This command is now a skill that invokes @tester agent.**

Run testing session with the Tester agent.

## When to use
- Need to write tests
- Check existing ones
- Coverage dropped
- Regression

## Usage
```
/test [what to test]
```

## Agent Actions
The @tester agent will:
1. Find what to test
2. Write or run Unit → Integration → E2E tests
3. Use AAA pattern (Arrange, Act, Assert)
4. Cover edge cases
5. Report pass/fail, coverage, and gaps

## Important
- Tests should be isolated
- Don't test internals — only API
- Mock external dependencies
- 100% coverage is not the goal
- This is the documented entry point for the fallback `@t` handoff used by `feature`, `bugfix`, and `refactor` workflows when successful verification has not already been recorded
- The resulting handoff should end with exact footer prefixes recognized by the hooks: `Outcome:`, `Changed files:` or `No files changed:`, `Verification status:`, and either `Remaining risks:` or `Next step:`

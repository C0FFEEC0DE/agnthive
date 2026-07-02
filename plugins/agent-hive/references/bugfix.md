# Bug Fix Workflow

## When
Found a bug → need to fix it.

## Steps

### 1. Explore
```
@explorer understand the bug area
```

### 2. Find
```
@bugbuster find the root cause
```

### 3. Design Fix
```
@architect design the fix for [root cause]
```

### 4. Implement
Implement the fix in code.

### 5. Verify
If successful verification has not already been recorded in the session:

```
@tester run regression tests for the fix and report pass/fail
```

### 6. Document
```
@docwriter document the bug fix if behavior, interface, or operator workflow changed
```

### 7. Review
```
@code-reviewer review the fix
```

## Commands

**Manager-led orchestration:**
```
@manager fix bug in [area]
```

Manager should keep the bugfix workflow moving through investigation, implementation, verification, review, and docs when behavior changed. Hooks enforce successful verification before task completion. That successful verification also satisfies the tester side of the bugfix gate; otherwise use `@tester`.
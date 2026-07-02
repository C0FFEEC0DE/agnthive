# New Feature Workflow

## When
Need to implement new feature.

## Steps

### 1. Explore
```
@explorer understand the codebase
```

### 2. Design
```
@architect design the feature
```

### 3. Design Tests
```
@tester design test strategy for the feature
```

### 4. Implement
Implement the feature in code.

### 5. Verify
If successful verification has not already been recorded in the session:

```
@tester run the planned tests and report pass/fail plus coverage gaps
```

### 6. Document
```
@docwriter document the feature and any user-facing behavior change
```

### 7. Review Code
```
@code-reviewer review the implementation
```

## Commands

**Manager-led orchestration:**
```
@manager implement new feature: [description]
```

Manager should keep the feature workflow moving through exploration, design, implementation, verification, review, and docs. Hooks enforce successful verification before completion. That successful verification also satisfies the tester side of the feature gate; otherwise use `@tester`.
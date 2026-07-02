# Security Scan Workflow

## When
Check repository for private/sensitive data before publishing publicly.

## Steps

### 1. Create Plan
```
@m create a plan to scan for private data (API keys, passwords, tokens, secrets)
```

### 2. Scan Files
```
@explorer scan the repository for sensitive files:
- **/.env* — environment files
- **/credentials* — credential files
- **/secrets* — secret files
- **/*.pem, **/*.key — key files
- **/.ssh/* — SSH keys
- **/secrets.yaml, **/secrets.yml — K8s secrets
- **/credentials.json — JSON credentials
```

### 3. Search Patterns
```
@bugbuster search for sensitive patterns in code:
- API keys: sk-[a-zA-Z0-9]{20,}, AKIA[0-9A-Z]{16}
- Passwords: (?i)password\s*=\s*
- Private keys: -----BEGIN.*PRIVATE KEY-----
- GitHub tokens: ghp_[a-zA-Z0-9]{36}
- GitLab tokens: glpat-[a-zA-Z0-9\-]{20,}
- JWT tokens: eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*
- URLs with auth: https?://[^:]+:[^@]+@
- Email: [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}
- Slack tokens: xox[baprs]-[0-9]{10,13}-[0-9]{10,13}
```

### 4. Analyze Results
```
@m analyze results and give verdict:
- Is the repository safe to publish?
- What needs to be fixed?
```

## Commands

**Get plan:**
```
@m check repo for private data
```

Manager creates the plan; Claude runs the scan steps directly.

## Categories to Check

| # | Category | Patterns |
|---|----------|----------|
| 1 | API keys | sk-, akia-, api_key |
| 2 | Passwords | password=, passwd, pwd |
| 3 | Tokens | token=, bearer, api_token |
| 4 | Private keys | -----BEGIN PRIVATE KEY----- |
| 5 | SSH keys | ssh-rsa, ssh-ed25519 |
| 6 | AWS credentials | AKIA..., aws_secret |
| 7 | GitHub tokens | ghp_, gho_, ghu_ |
| 8 | GitLab tokens | glpat- |
| 9 | JWT tokens | eyJ... |
| 10 | Email addresses | user@domain.com |
| 11 | Phone numbers | +7..., 8... |
| 12 | URLs with auth | http://user:pass@ |
| 13 | .env files | .env, .env.local |
| 14 | DB connection strings | mongodb://, postgres:// |
| 15 | OAuth tokens | ya29., EAACEdEose0c |
| 16 | Slack tokens | xox[baprs]- |
| 17 | Personal data | passport, ssn, name |
| 18 | Credit cards | 16 digit numbers |
| 19 | Hidden config files | .npmrc, .pypirc |
| 20 | Secrets in configs | secret=, private_key= |
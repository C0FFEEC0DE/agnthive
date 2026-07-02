# Contributing to Claude Code Configuration

Thank you for your interest in contributing!

## Getting Started

1. Fork the repository
2. Create a new branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run validation: `node scripts/validate.mjs` (if available)
5. Commit your changes: `git commit -am 'Add new feature'`
6. Push to the branch: `git push origin feature/my-feature`
7. Submit a pull request

## Project Structure

```
plugins/agent-hive/   # The distributable Claude Code plugin
├── agents/         # Agent definitions (*.md, flat)
├── skills/         # Skills (nested <name>/SKILL.md): agent-backed + command skills
├── references/     # Workflow + reference docs
├── modules/        # Node ESM hook runtime (hook-dispatcher, state, policy, ...)
├── hooks/hooks.json  # Hook event → command manifest
├── assets/         # Bundled alias map + static assets
└── .claude-plugin/plugin.json  # Plugin manifest
```

## Adding a New Agent

1. Create `plugins/agent-hive/agents/[alias].md`
2. Use the template:

```yaml
---
name: AgentName
alias: short
description: Brief, professional, role-focused description
type: AgentType
---

**You are the <Role>.** Description...

## Role
...

## Standard Output
...
```

3. Update `plugins/agent-hive/agents/manager.md` to include new agent
4. Update README.md agent table

## Adding a New Command

1. Create `plugins/agent-hive/skills/[command]/SKILL.md`. For an
   agent-backed command (one that dispatches a specialist), use the full
   agent-dispatch frontmatter:

```yaml
---
name: command
description: What this skill does
agent: target-agent-name
context: fork
disable-model-invocation: true
allowed-tools: Read Glob Grep
paths:
  - "**/*"
---
```

   For a minimal command skill (no agent dispatch), use only `name` + `description`.
2. Update CLAUDE.md commands list

## Code Style

- Keep agent files under 150 lines
- Use consistent formatting in output templates
- Keep descriptions and openers professional and role-focused
- Always fill all fields in Standard Output template

## Testing

Before submitting:
- [ ] `make lint` passes (Node ESM syntax check via `node --check` over `scripts/`, `plugins/`, and `test/` — Node standard library only, no Python, no ruff)
- [ ] `make test` (Node `--test` over `test/**/*.test.mjs`) passes — the validator
      suite (`test/validators/*.test.mjs`) is included in that glob
- [ ] `make hooks` (or `node scripts/test-hooks.mjs`) passes
- [ ] `node scripts/validate.mjs` passes
- [ ] JSON files are valid
- [ ] Agent markdown has proper frontmatter
- [ ] Skill markdown has proper frontmatter
- [ ] Settings invariants still hold (`outputStyle: Default`, Notification hook configured)
- [ ] All links in documentation work

## GitHub Actions Requirements

**Node.js 20 is deprecated on GitHub Actions runners** (removed September 2026). All workflows must target Node.js 24:

- Set `env: FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` at the workflow level
- Use `actions/cache@v5` (not v4) — v4 targets Node.js 20
- When adding new actions, verify they support Node.js 24 or add the env var
- Check the [deprecation guide](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/) before adding new JavaScript-based actions

## Questions?

Open an issue or ask in discussions.

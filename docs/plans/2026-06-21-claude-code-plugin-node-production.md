# Production plan: Claude Code plugin and Node.js migration

## Status and outcome

This plan converts `agent-hive` from a copied `~/.claude` profile
into a distributable Claude Code plugin, removes execution-critical Bash and
Python from the repository, and prepares a submission to the Anthropic
community marketplace.

The target plugin identifier is **`agent-hive`**. Confirm that the
name is available before publishing; all source and release work should use it
consistently as the plugin namespace.

The end state supports native Windows, macOS, and Linux. Hook execution is
Node.js ESM with **Node.js 22 or newer** on `PATH`; Node is an explicit plugin
prerequisite, not an implicit dependency on a particular Claude Code installer.

## Research inputs

- [Claude Code: Create plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code: Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code: Hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code: Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Anthropic community marketplace](https://github.com/anthropics/claude-plugins-community)

Key platform constraints established by this research:

- A plugin uses `.claude-plugin/plugin.json`; hooks live in
  `hooks/hooks.json`; agents and skills live at the plugin root.
- Marketplace-installed plugins are copied into a versioned cache. The plugin
  must not write mutable state into its installation directory or refer to
  files outside its own root.
- Every hook must use exec form: `command: "node"` with an `args` array. This
  avoids shell parsing, handles spaces in paths, and works with `node.exe` on
  Windows.
- Plugin `settings.json` only supports the `agent` and
  `subagentStatusLine` keys. It cannot automatically install this profile's
  global permissions, sandbox, auto-execution, output style, or main status
  line settings.
- The community marketplace is review-gated. Submit through the Claude.ai or
  Console submission form; do not open a pull request against the read-only
  `anthropics/claude-plugins-community` mirror.

## Baseline inventory

The migration must preserve behavior before changing behavior deliberately.

| Current surface | Inventory | Migration target |
|---|---:|---|
| Runtime hooks | 18 events, 19 registrations, 20 shell files | one Node dispatcher with event modules |
| Shared runtime core | `claudecfg/hooks/lib.sh`, 1,564 lines | `state`, `workflow`, `policy`, `verification`, `summary`, and I/O modules |
| Specialist content | 8 agents, 9 commands, 5 skills, 6 workflow docs | canonical plugin agents, namespaced skills, on-demand references |
| Hook regression data | 142 isolated cases, 2 stateful scenarios, 14 transcript fixtures | Node fixture runner plus differential tests |
| Tooling | Shell installers/test runners and Python benchmark/test scripts | Node CLI commands, `node --test`, npm scripts and JavaScript CI |

The existing JSON fixtures are the compatibility contract. Copy them into the
new test tree first; only then make intentional behavior changes visible as
new fixtures with a documented reason.

## Target repository structure

```text
.claude-plugin/
  marketplace.json
plugins/
  agent-hive/
    .claude-plugin/
      plugin.json
    hooks/
      hooks.json
    dist/
      hook-dispatcher.mjs
      modules/
        command-policy.mjs
        hook-input.mjs
        hook-output.mjs
        ledger.mjs
        notifications.mjs
        state.mjs
        summary-contract.mjs
        transcripts.mjs
        verification.mjs
        workflow.mjs
    agents/
      architect.md
      bugbuster.md
      code-reviewer.md
      debugger.md
      docwriter.md
      explorer.md
      manager.md
      tester.md
    skills/
      bug/SKILL.md
      debug/SKILL.md
      design/SKILL.md
      docs/SKILL.md
      explore/SKILL.md
      manager/SKILL.md
      refactor/SKILL.md
      review/SKILL.md
      test/SKILL.md
    references/
      workflows/
      contracts.md
    assets/
      aliases.json
    package.json
    README.md
    LICENSE
    CHANGELOG.md
package.json
package-lock.json
test/
  fixtures/
  unit/
  integration/
  security/
scripts/
  build.mjs
  check-no-legacy-runtime.mjs
  plugin-smoke.mjs
  release-check.mjs
```

The root marketplace entry will use
`"source": "./plugins/agent-hive"`. A self-hosted marketplace is
useful for local and beta validation; community distribution uses the reviewed
submission flow instead.

## Architecture decisions

### Hook execution

All hook registrations use the same portable runner shape:

```json
{
  "type": "command",
  "command": "node",
  "args": [
    "${CLAUDE_PLUGIN_ROOT}/dist/hook-dispatcher.mjs",
    "--event",
    "Stop"
  ]
}
```

`hook-dispatcher.mjs` reads stdin as a Buffer, parses one JSON object, routes
to a pure event function, writes one JSON object to stdout, and sends
diagnostics only to stderr. No hook shells out through `exec`, `spawn(...,
{ shell: true })`, or an interpolated command string.

### State and telemetry

- Mutable installation roots are forbidden. Store all state in
  `${CLAUDE_PLUGIN_DATA}` under a validated session identifier.
- Replace lock-protected read-modify-write JSON with append-only event records
  created using exclusive creation (`wx`) and a pure reducer that derives the
  latest state.
- Snapshots are disposable caches: write a same-directory temporary file,
  fsync when supported, then atomically rename. A stale or damaged snapshot is
  rebuilt from event records.
- Bound event/log size and rotate JSONL telemetry. Never log credentials,
  full environment variables, or unnecessary prompt/transcript contents.
- Add a migration version to every stored event and snapshot.

This removes the current non-atomic initial write, shared state update race,
and stale-lock TOCTOU class instead of attempting a mechanical port of the
directory lock.

### Cross-platform policy

The current security policy only recognizes Unix spellings. The replacement
must represent a platform-neutral dangerous-intent policy and test distinct
POSIX, PowerShell, and CMD syntax. It must cover, at minimum:

- destructive recursive deletion;
- disk formatting and raw disk writes;
- privilege escalation;
- force pushes and destructive Git reset;
- remote-script bootstrap pipes;
- release and deploy automation;
- Windows `Remove-Item`, `del`, `rmdir`, `Format-Volume`, `Clear-Disk`,
  `diskpart`, and `Invoke-WebRequest | Invoke-Expression` equivalents.

The policy is an additional enforcement layer, not a claim that arbitrary shell
syntax can be perfectly parsed. `enforcement_mode` defaults to `advisory`;
users opt into `enforce` through plugin user configuration. An unparseable
command in enforce mode must be denied with an explanation rather than guessed
safe.

### Stop and subagent contracts

Preserve the footer contract and checklists, but follow the current Claude Code
semantics:

- normal Stop feedback uses `decision: "block"` with a reason or
  `hookSpecificOutput.additionalContext`;
- terminal cancellation uses only `continue: false` and `stopReason`;
- normal guards never combine `decision: "block"` with `continue: false`;
- read `stop_hook_active` to prevent feedback loops; test the runtime's
  consecutive-block cap as an integration constraint;
- reset a terminal policy-stall only on a genuine `UserPromptSubmit` event.

### Content and settings migration

- Convert the eight agents to kebab-case canonical names. Do not package
  symlink aliases; keep alias recognition in `assets/aliases.json` only where
  transcript compatibility needs it.
- Convert all flat command Markdown and legacy skill Markdown to
  `skills/<name>/SKILL.md`. Update references to their namespaced invocation,
  for example `/agent-hive:review`.
- Turn `workflows/` into skill references so workflows load on demand instead
  of adding permanent session context.
- Provide an optional Node status-line helper and a copy-paste user settings
  snippet. Never overwrite a user's Claude Code settings file.
- Document optional permissions/sandbox configuration separately. The plugin
  cannot and must not silently change global user policy.

## Execution plan

Tasks are deliberately small. Every coding task runs in an isolated worktree
or branch and owns only the paths named below.

### Phase 0 — contract freeze

1. **Create the traceability matrix.**
   - Owner: specification agent.
   - Add `docs/specs/claude-code-plugin-node-migration.md`.
   - Map every old event, input field, output decision, state field, fixture,
     and intentional behavior difference to a Node module.
   - Verify: reviewer confirms all 18 events and 19 registrations are covered;
     no Node implementation starts without this matrix.

2. **Declare the public compatibility policy.**
   - Owner: specification agent.
   - Add the Node 22+ prerequisite, supported Claude Code versions, advisory
     default, privacy statement, and the plugin/settings boundary to the spec.
   - Verify: product owner accepts documented non-migratable settings behavior.

### Phase 1 — scaffold and runtime foundation

3. **Create the marketplace and plugin manifests.**
   - Owner: plugin/core agent.
   - Add `.claude-plugin/marketplace.json` and
     `plugins/agent-hive/.claude-plugin/plugin.json` with SPDX
     license, repository, homepage, description, keywords, author metadata,
     SemVer version, and user configuration.
   - Verify: `claude plugin validate . --strict` and
     `claude plugin validate plugins/agent-hive --strict` pass.

4. **Create the Node workspace.**
   - Owner: plugin/core agent.
   - Add root and plugin `package.json`, pinned lockfile, Node engines, ESM
     configuration, `node --test`, lint, typecheck, build, package, and
     release-check scripts.
   - Verify: `npm ci`, `npm run lint`, `npm test`, and `npm run build` work
     without Bash/Python.

5. **Implement hook input/output contracts.**
   - Owner: plugin/core agent.
   - Add `hook-input.mjs`, `hook-output.mjs`, and dispatcher unit tests.
   - Preserve event-specific decision forms for PreToolUse, PermissionRequest,
     PermissionDenied, Stop, SubagentStop, TaskCompleted, and TeammateIdle.
   - Verify: malformed input, empty input, arbitrary Unicode, and output-only
     JSON tests pass.

6. **Implement append-only session state.**
   - Owner: plugin/core agent.
   - Add `state.mjs` with safe session IDs, event schemas, snapshots, reducer,
     retention, and recovery.
   - Verify: parallel writer stress test, interrupted snapshot recovery,
     path traversal rejection, and no-lost-update test pass on all OSes.

### Phase 2 — migrate hook behavior

7. **Port classifier and workflow requirements.**
   - Owner: lifecycle agent.
   - Add `workflow.mjs` and migrate `UserPromptSubmit` classification,
     manager modes, docs requirements, specialist role requirements, and the
     stop-loop reset.
   - Verify: migrated prompt fixtures preserve expected task type and role
     state.

8. **Port command detection and verification tracking.**
   - Owner: lifecycle agent.
   - Add `verification.mjs` for test/lint/build discovery and successful/failed
     command state events.
   - Verify: Node, Make, CMake, language-neutral and no-command fixtures pass.

9. **Port role, aliases, and transcript handling.**
   - Owner: lifecycle agent.
   - Add `agents.mjs`, `transcripts.mjs`, and `assets/aliases.json`.
   - Verify: generic agent type filtering, alias normalization, transcript
     fallback, manager backgrounding, and duplicate-role fixtures pass.

10. **Port footer parsing and completion gates.**
    - Owner: lifecycle agent.
    - Add `summary-contract.mjs` and all Stop, SubagentStop, TaskCompleted, and
      TeammateIdle handlers.
    - Verify: every current valid/missing footer fixture passes; repeated Stop
      blocks, `stop_hook_active`, and terminal cancellation have explicit
      regression tests.

11. **Port observability and ledger handling.**
    - Owner: lifecycle agent.
    - Add `notifications.mjs`, `ledger.mjs`, rotation and session lifecycle
      handlers.
    - Verify: telemetry redaction/rotation and a multibyte UTF-8 split-boundary
      ledger test pass.

### Phase 3 — security policy redesign

12. **Write the command-policy specification and corpus.**
    - Owner: security agent.
    - Add `docs/specs/command-policy.md` and tests under `test/security/`.
    - Define POSIX, PowerShell and CMD support, advisory/enforce behavior, and
      the limitations of command-string inspection.
    - Verify: the corpus has positive, negative, quote/escape, subshell,
      chained-command, environment-assignment, and Unicode cases.

13. **Implement portable command policy.**
    - Owner: security agent.
    - Add `command-policy.mjs`; migrate PreToolUse, PermissionRequest, and
      PermissionDenied behavior using fixed decision constructors only.
    - Verify: POSIX and Windows corpus passes; no `child_process.exec`, shell
      interpolation, or unsafe user-command execution appears in the codebase.

14. **Run an independent policy review.**
    - Owner: reviewer agent in a separate worktree.
    - Review parser bypasses, `continue: false` behavior, state paths, logs,
      user configuration, and denial semantics.
    - Verify: all findings are fixed or accepted in `SECURITY.md` with a
      rationale before beta publication.

### Phase 4 — package content and migrate all repository tooling

15. **Convert agents and skills.**
    - Owner: content agent.
    - Populate the canonical eight agent definitions and nine skills; move
      workflow documents into `references/` and update all namespaced links.
    - Verify: `claude plugin validate --strict` reports every agent/skill;
      manual `claude --plugin-dir` smoke confirms discovery.

16. **Create user migration and optional settings adapter.**
    - Owner: content agent.
    - Add plugin README installation, configuration, uninstallation, privacy,
      troubleshooting, support, security reporting, and legacy migration
      instructions; rewrite status-line helper in Node as opt-in.
    - Verify: a clean profile can install and remove the plugin without any
      overwrite of `~/.claude/settings.json`.

17. **Port hook fixture runner and direct tests.**
    - Owner: tooling agent.
    - Replace `scripts/test-hooks.sh`, `test/hooks/test-lib.sh`, and
      hook-related Python tests with Node test suites while preserving JSON
      fixtures.
    - Verify: all 142 isolated cases and both shared-state scenarios pass in
      the Node runner; differential comparison documents every intentional
      delta.

18. **Port benchmark and release tooling.**
    - Owner: tooling agent.
    - Replace all execution-critical `scripts/*.py`, `scripts/*.sh`, Makefile
      targets, Python tests, and Python executable fixtures with Node CLIs and
      `npm run` commands.
    - Verify: `check-no-legacy-runtime.mjs` fails on executable legacy
      `.py`/`.sh` files; benchmark mock, report, selection, assertion, and
      rerun flows all pass from npm scripts.

### Phase 5 — cross-platform CI and release readiness

19. **Build the OS CI matrix.**
    - Owner: QA/release agent.
    - Replace Python/Shell workflows with Node jobs on `ubuntu-latest`,
      `macos-latest`, and `windows-latest`; run Node 22 and current LTS.
    - Verify: paths with spaces, CRLF inputs, UTF-8 input chunks, plugin cache
      paths, and hook exec form pass on each OS.

20. **Add plugin installation and package smoke tests.**
    - Owner: QA/release agent.
    - Add a clean-home test that validates the marketplace, adds the local
      marketplace, installs the plugin, reloads it, lists it, updates it, and
      uninstalls it.
    - Verify: the smoke test uses the packaged artifact/cache layout rather
      than the source tree alone.

21. **Add supply-chain and release controls.**
    - Owner: QA/release agent.
    - Enable dependency review, CodeQL JavaScript/TypeScript, secret scanning,
      SBOM generation, Dependabot, minimal GitHub token permissions, protected
      tags, and provenance for any npm publication.
    - Verify: release workflow is tag-only, validates a clean checkout, creates
      one build artifact, tests that exact artifact, then releases it.

22. **Run beta and submit to community.**
    - Owner: release owner.
    - Publish an explicit SemVer beta through the repository marketplace,
      collect Windows/macOS/Linux tester results, then submit the public source
      repository through the Anthropic form.
    - Verify: `claude plugin validate --strict`, CI artifacts, threat model,
      README, changelog, license, privacy/network statement and security policy
      are attached to the submission packet.

## Subagent orchestration

Use at most three implementation agents concurrently. Every agent receives a
task-specific worktree and may edit only its owned paths.

| Wave | Agents in parallel | Prerequisite | Integration owner |
|---|---|---|---|
| 0 | specification | none | product owner |
| 1 | plugin/core, lifecycle, content | approved traceability matrix | plugin/core |
| 2 | security, tooling, QA fixtures | dispatcher and state API stable | tooling |
| 3 | release, independent reviewer | all Node functionality merged | release owner |

Handoff format for every agent:

```text
Outcome: <implemented behavior or research result>
Changed files: <exact paths> | No files changed: <reason>
Verification status: passed|failed|not run - <exact command/evidence>
Remaining risks: <specific risk> | Next step: <single action>
```

The integration owner rejects handoffs that do not state fixture coverage,
cross-platform impact, and intentional behavior deltas.

## Release checklist

- [ ] Manifest and marketplace use kebab-case, non-reserved names and valid
      relative sources.
- [ ] Plugin runtime contains no Bash, Python, `jq`, GNU-only, or macOS-only
      dependency.
- [ ] Plugin runtime has no runtime `npm install`; production code uses Node
      standard library only.
- [ ] Plugin does not write into `${CLAUDE_PLUGIN_ROOT}` or outside
      `${CLAUDE_PLUGIN_DATA}` / the project paths explicitly provided by hooks.
- [ ] `claude plugin validate . --strict` and plugin-level strict validation
      pass in CI.
- [ ] Node fixture, concurrency, policy and UTF-8 tests pass on all three OSes.
- [ ] Local `--plugin-dir` and installed-marketplace smoke tests pass.
- [ ] No executable legacy `.sh` or `.py` remains; migration check enforces it.
- [ ] README documents Node requirement, installation, update, disable,
      uninstall, privacy, support, security reporting and settings limitations.
- [ ] Community submission packet is complete; publication is submitted through
      the approved form, not a catalog pull request.

## Explicit risks and decisions to revisit

1. **Node availability:** native Claude Code installations may not place Node
   on `PATH`. The plugin must preflight this condition and report an actionable
   install command/documentation path rather than failing silently.
2. **Security parser scope:** it is impossible to perfectly interpret every
   arbitrary shell dialect from a command string. The supported syntax and
   fail-closed enforce behavior must be explicit.
3. **Plugin API boundary:** a plugin cannot silently take over global Claude
   Code settings or statusline. Preserve user autonomy with documented opt-in
   snippets.
4. **Behavior compatibility:** moving from live mutable state to event-sourced
   state may expose old race-dependent behavior. Differential fixture tests and
   approved deltas are mandatory.
5. **Marketplace review:** approval and catalog sync are external steps; beta
   distribution through the repository marketplace remains available while the
   community review is pending.

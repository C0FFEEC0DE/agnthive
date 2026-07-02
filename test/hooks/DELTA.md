# Hook fixture runner — intentional bash → Node behavior deltas

This file documents cases where the Node hook dispatcher
(`plugins/agent-hive/modules/hook-dispatcher.mjs`) intentionally
differs from the legacy bash hooks (`claudecfg/hooks/*.sh`) that the
`test/hooks/cases.json` + `test/hooks/scenarios.json` corpus was originally
authored against. The Node runner (`scripts/test-hooks.mjs`) carries these as
expected deltas (declared in `test/hooks/deltas.json`) so the suite stays
green while making every delta explicit and auditable.

Each delta keeps the assertions that still verify the Node behavior (stdout_jq,
state_jq) and only skips the assertion(s) that assert the dropped bash
behavior.

## `session_start_detects_node_scripts`

- **Bash expectation:** writes a `CLAUDE_ENV_FILE` (resolved from the case
  `env.CLAUDE_ENV_FILE`) containing `CLAUDE_SDLC_PROFILE=hook-gated`,
  `PROJECT_TEST_CMD="npm run test"`, `PROJECT_LINT_CMD="npm run lint"`,
  `PROJECT_BUILD_CMD="npm run build"`. The case's `file_assertions` grep that
  env file.
- **Node actual:** the dispatcher does not write any env file. Per
  `hook-dispatcher.mjs` `handleSessionStart`, "the bash profile also writes a
  CLAUDE_ENV_FILE of exports; the Node runtime uses session state as the source
  of truth, so that env-file step is intentionally not ported."
- **Why the delta is correct:** the Node runtime persists detected commands to
  session state (`detected_test_command`, `detected_lint_command`,
  `detected_build_command`) and surfaces them in the `additionalContext`
  message. The env-file export file is a bash-specific side channel with no
  Node equivalent; state is the single source of truth.
- **Still verified:** `stdout_jq` (the `additionalContext` message lists
  `test=npm run test; lint=npm run lint; build=npm run build;`) and `state_jq`
  (the three `detected_*_command` fields). Only `file_assertions` are skipped.

## `session_start_prefers_make_targets_for_any_language_project`

- Same delta and rationale as above, for the make-target project. The Node
  dispatcher detects `make test` / `make lint` / `make` and records them in
  state + `additionalContext`; only the `CLAUDE_ENV_FILE` `file_assertions`
  are skipped.

## `feature_shared_state_progression::session_start_detects_node_scripts`

- Scenario step sharing the same intentional `CLAUDE_ENV_FILE` delta described
  above. The remaining scenario steps (verification gate, subagent handoffs,
  stop-guard) all pass unchanged.
# Community Submission Packet

This index assembles the artifacts for submitting `agent-hive` to
the Claude Code community plugin marketplace. The plugin is distributed as a
**source repository marketplace**: users add this repository as a marketplace
and install the plugin from `plugins/agent-hive/`. The actual
submission is filed through the Anthropic community-plugin form by a human
maintainer — this document is the packet they attach, not an automated
publish step.

## Version

`0.1.0-beta.1` — declared in plugin.json as the single source of truth
(marketplace.json omits version to avoid drift):

- `plugins/agent-hive/.claude-plugin/plugin.json` — authoritative
- `plugins/agent-hive/package.json` — matches for consistency
- `package.json` (root) — matches for monorepo consistency
- `.claude-plugin/marketplace.json` — no version field (plugin.json wins)

Cut the beta tag with `git tag -a v0.1.0-beta.1 -m "Beta v0.1.0-beta.1"`; see
[`docs/release.md`](release.md#cutting-a-beta-prerelease) for the tag-only
release flow.

## Packet contents

| Required item | Location | Notes |
|---|---|---|
| README (Node requirement, install, update, disable, uninstall, privacy, support, security reporting, settings limitations) | `plugins/agent-hive/README.md` | User-facing; ships inside the plugin dir |
| Changelog | `plugins/agent-hive/CHANGELOG.md` | Keep a Changelog format; `0.1.0-beta.1` migration entry |
| License | `plugins/agent-hive/LICENSE` | MIT, identical to repo-root `LICENSE` |
| Security policy | `plugins/agent-hive/SECURITY.md` | Private disclosure, 72h initial response, plugin-specific scope |
| Threat model | `plugins/agent-hive/references/threat-model.md` | Trust boundary, command policy (defense-in-depth, not a sandbox), exec-form integrity, path resolution, telemetry privacy, supply chain |
| Privacy / network statement | `plugins/agent-hive/README.md` § Privacy & telemetry | "No network calls; nothing leaves the local machine" — grounded by a module scan (no `http`/`https`/`fetch`/`net` imports in `modules/`) |
| Release runbook | `docs/release.md` | Tag-only, clean-checkout, one-artifact, test-the-exact-artifact, SBOM attachment |

## Verification evidence (attach or cite)

- `claude plugin validate plugins/agent-hive --strict` → **passed**
  (exit 0), run with `claude` CLI 2.1.185.
- `node scripts/plugin-install-smoke.mjs` → **PASS (11 checks)** — manifest
  fields, path resolution, no `.py`/`.sh` in runtime, hook exec form
  (command `node` + args array, no `shell:true`), statusline parse.
- CI matrix: `validate.yml` runs the suite on `ubuntu/macos/windows` ×
  `node 22/24`; `test/cross-platform/input-handling.test.mjs` covers spaced
  paths, CRLF, UTF-8 multi-byte splits, partial UTF-8, cache paths.
- Supply chain: CodeQL (js-ts), dependency-review, SBOM (syft), Dependabot,
  minimal token scopes — see `.github/workflows/`.
- Local gates: `make lint` (Node ESM syntax check, 86 files), `make test`
  (Node --test, node-only — no pytest), `make cov` (alias of `make test`,
  node-only), `make hooks` (157 cases / 2 scenarios),
  `node scripts/validate.mjs` (All checks passed).

## Release checklist (from the production plan)

- [x] Manifest and marketplace use kebab-case, non-reserved names, valid
      relative sources.
- [x] Plugin runtime contains no Bash, Python, `jq`, GNU-only, or macOS-only
      dependency (`scripts/check-no-legacy-runtime.mjs` + the smoke gate).
- [x] Plugin runtime has no runtime `npm install`; production code uses Node
      standard library only.
- [x] Plugin does not write into `${CLAUDE_PLUGIN_ROOT}` or outside
      `${CLAUDE_PLUGIN_DATA}` / project-provided paths.
- [x] `claude plugin validate ... --strict` and plugin-level strict validation
      pass.
- [x] Node fixture, concurrency, policy and UTF-8 tests pass on all three OSes
      — *confirmed green on `validate.yml` across ubuntu/macos/windows × Node
      22/24 on PR #4 commit `ed2386f` (Repository Checks all 6 legs pass).*
- [x] Local `--plugin-dir` and installed-marketplace smoke tests pass
      (`plugin-install-smoke.mjs`; the claude-CLI lifecycle step in
      `plugin-install-smoke.yml` is opportunistic and untested against a real
      `claude` binary in CI).
- [x] No executable legacy `.sh` or `.py` remains; the migration check enforces
      it.
- [x] README documents Node requirement, installation, update, disable,
      uninstall, privacy, support, security reporting and settings
      limitations.
- [ ] Community submission packet is complete; publication is submitted
      through the approved form, not a catalog pull request — *this document
      is the packet; the form submission is a human action.*

## Remaining human actions

1. Push `feat/plugin-node-migration` and open/merge the PR to `main` (or
   squash) so the tagged tree is what the marketplace clones.
2. Cut `v0.1.0-beta.1` and push the tag; confirm the Release workflow is green
   and the artifact + SBOM are attached.
3. Collect Windows/macOS/Linux beta-tester results against the tagged artifact.
4. File the community-plugin submission through the Anthropic form, attaching
   this packet (or linking to these repository paths).

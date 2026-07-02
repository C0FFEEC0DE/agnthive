# Release Runbook

This document describes how the `agent-hive` Claude Code plugin is
released. The release flow is **tag-only**, builds **one artifact** from a
**clean checkout**, **tests the exact artifact**, attaches an **SBOM**, and
creates a **GitHub Release** — with no npm publication involved.

The workflow lives at [`.github/workflows/release.yml`](../.github/workflows/release.yml).

## Distribution model

The plugin is a **source repository marketplace** distribution. Claude Code
copies the plugin directory (`plugins/agent-hive/`) into its
marketplace cache with **no install-time build and no npm install**. The
runtime ships as committed ES modules under `plugins/agent-hive/modules/`.
`dist/` is gitignored and reserved for future release artifacts.

Consequence: **there is no npm publication**, so **npm provenance (sigstore)
is N/A**. Provenance for the GitHub Release artifact is provided by the
release flow itself: tag-only trigger, clean checkout, locked-down workflow
permissions, and an attached SBOM. See [Provenance & signing](#provenance--signing).

## Tag-only trigger

The workflow fires **only** on pushing a SemVer tag matching `v*`:

```yaml
on:
  push:
    tags:
      - 'v*'
```

No `push` to branches, no PR, no `workflow_dispatch` by default. Cutting a
release == pushing a tag.

## Clean-checkout guarantee

The workflow checks out the tagged commit with `fetch-depth: 1` and builds the
artifact directly from that tree. `git archive` packages **only tracked
files**, so gitignored build output (`dist/`, `node_modules/`, coverage, etc.)
cannot leak into the release artifact. There is no dependency on local working
state.

## One-artifact build

The single artifact is a zip of the plugin directory:

```bash
git archive --format=zip --prefix=agent-hive/ \
  -o "agent-hive-plugin-${TAG}.zip" HEAD:plugins/agent-hive
```

`git archive` is chosen over an inline Node zip writer because it is
deterministic, git-native, and excludes gitignored files by construction. The
`HEAD:<subpath>` tree form yields plugin-dir-relative paths; `--prefix` nests
them under `agent-hive/`, so unzipping produces a named directory
that can be dropped straight into a marketplace `plugins/` directory.

## Test-the-exact-artifact

Before any release is created, the workflow **unpacks the zip it just built**
(not the checkout) and runs:

1. **Structural check** — required files are present:
   `.claude-plugin/plugin.json`, `package.json`, `modules/hook-dispatcher.mjs`,
   `hooks/hooks.json`.
2. **Syntax check** — `node --check` runs over every `modules/*.mjs` in the
   unpacked artifact.
3. **Committed-runtime validation** — `node scripts/build.mjs --package` runs
   earlier in the job as a hard gate.
4. **Enforced install smoke** — `scripts/plugin-install-smoke.mjs` is invoked
   against the unpacked plugin dir (its positional arg). It is an enforced
   gate (not `continue-on-error`): it covers the structural properties the
   checks above do not — hook exec form (command `node` + args array, no
   `shell:true`), no `.py`/`.sh` in the runtime, every `${CLAUDE_PLUGIN_ROOT}`
   target resolves, `userConfig` well-formedness, and statusline parse. The
   `hashFiles('scripts/plugin-install-smoke.mjs')` guard is always true now
   that the script is committed, so this step always runs and must pass.

This is **test-then-release**: every hard-gate step must pass before
the GitHub Release is created. A failure in steps 1–4 (or in the
committed-runtime validation) fails the job and no release is created.

## SBOM attachment

An SPDX JSON SBOM is generated with [`anchore/sbom-action@v0`](https://github.com/anchore/sbom-action)
(Syft) scanning the **unpacked artifact directory**, so the SBOM reflects the
exact released tree. The file `sbom.spdx.json` is attached to the GitHub
Release alongside the zip.

Chosen over the GitHub-native `gh api /repos/{owner}/{repo}/dependency-graph/sbom`
endpoint because Syft is self-contained and works regardless of dependency-graph
enablement or GitHub Advanced Security licensing (relevant for private forks).
For this source-only plugin the SBOM is intentionally thin — the runtime has
no npm dependencies — but the attachment establishes the provenance baseline
and will scale as deps are adopted.

## Release creation

```bash
gh release create "$TAG" "$ARTIFACT" sbom.spdx.json \
  --title "$TAG" --notes-file notes.md --verify-tag
```

`--verify-tag` fails the workflow if the tag does not point at the checked-out
commit, catching accidental tag movement.

## Minimal token permissions

The workflow locks down permissions explicitly:

```yaml
permissions:
  contents: write   # create the release + upload assets
```

Top-level `permissions: contents: read` scopes the default; the job widens
only what the release step needs. No `packages:`, no `deployments:`, and no
`id-token: write` — nothing is published to npm and the SBOM is not signed, so
OIDC is not required. Re-add `id-token: write` only if/when a cosign/sigstore
signing step lands.

## Provenance & signing

- **npm provenance (sigstore): N/A.** Nothing is published to npm; the plugin
  is distributed as source. No `npm publish --provenance` step exists or is
  planned.
- **GitHub Release artifact provenance:** the release is tag-only from a clean
  checkout, the workflow runs with the minimal permissions above, the artifact
  is built via `git archive` of the tagged tree (deterministic, tracked-files
  only), and an SBOM is attached. No `id-token: write` is granted because no
  signing step runs; the provenance baseline is the clean-checkout +
  deterministic archive + SBOM attachment.

## How to cut a release

1. Ensure `main` is green (`make lint`, `make test`, `make hooks`,
   `node scripts/validate.mjs`).
2. Update the plugin version in `plugins/agent-hive/.claude-plugin/plugin.json`
   and `plugins/agent-hive/package.json` (and the root
   `package.json` if appropriate) to the target SemVer.
3. Commit and push to `main`.
4. Tag and push the tag:
   ```bash
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push origin v0.1.0
   ```
5. The **Release** workflow runs automatically. Watch it under
   *Actions → Release*. On success, the GitHub Release appears under
   *Releases* with the zip + `sbom.spdx.json` attached.
6. If the workflow fails, delete the tag (if appropriate) or cut a patch tag
   — do **not** move an already-published tag.

### Cutting a beta (prerelease)

Use a SemVer prerelease tag, e.g. `v0.1.0-beta.1`:

```bash
git tag -a v0.1.0-beta.1 -m "Beta v0.1.0-beta.1"
git push origin v0.1.0-beta.1
```

The `v*` trigger matches prerelease tags, so the same flow produces a
prerelease artifact. To mark it as a non-default (pre)release on GitHub,
pass `--prerelease` — currently the workflow does not set this automatically;
amend the release via the GitHub UI or `gh release edit "$TAG" --prerelease`
after creation if you want it flagged as a prerelease.

## Out of scope for this workflow

- **npm publish:** intentionally absent (source distribution; see above).
- **Automated changelog generation:** the repo maintains `CHANGELOG.md` by
  hand; the release notes above are generated inline by the workflow.

`permissions:` hardening on the existing workflows (`validate.yml`,
`hooks-test.yml`, `lint.yml`, `behavior-benchmark-subagents-smoke.yml`,
`security-scan.yml`, `plugin-install-smoke.yml`) landed in Phase 5 alongside
this runbook — every workflow now declares minimal token scopes
(`contents: read`, plus `actions: read` only where the two-slot gate or shard
download needs it, and `contents: write` only on the release job).
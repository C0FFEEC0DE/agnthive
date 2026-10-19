# ADR 0012: Versioned harness contracts and outcome benchmarks

- **Status:** Accepted; implemented in 0.4.0 (working tree): compatibility matrix, contract fixtures, plugin-state bench evidence, outcome suite; the lean default flip still awaits the ADR 0012 outcome-benchmark rollout gate (plan task 14); legacy removal deferred (plan task 16).
- **Date:** 2026-10-19.
- **Decides:** Pin the tested harness contract and measure task outcomes separately from role-dispatch compliance.
- **Basis:** [Review](../specs/2026-10-19-harness-review-and-simplification-design.md), F03/F10 and agent-role assessment.
- **Implementation:** [Plan](../plans/2026-10-19-harness-modernization-and-simplification.md), tasks 01–02, 09–10, 13–16.

## Context

Static fixtures currently validate the plugin's own assumptions. Best-effort CLI installation can skip the official check. The runner reads a legacy state path and accepts debug text as hook evidence. Per-role canaries require the very agent topology whose usefulness needs evaluation.

## Decision

Maintain a compatibility matrix of CLI version, used events/fields, captured fixtures, fallback, and host test result. At this review the locally tested CLI was 2.1.292; 2.1.303 was the candidate from the observed changelog, not a certified target. Pin a version actually verified by implementation. Declare a minimum only after testing; do not invent manifest fields to express it.

Required CI must fail visibly if the pinned CLI cannot install. Validate manifest, skills, and agents explicitly. Floating latest is an additional canary, not a substitute for reproducibility. Keep offline tests separate from authenticated/paid host runs; missing live verification is unverified, not passed.

Use the plugin's actual data root and shared state reader or an explicit per-run evidence index. Isolate benchmark runs and correlate structured records by run/session/task/agent. Confirm the effective data directory inside the plugin host rather than assuming an external env override is honored. Debug phrases, aliases, and result prose remain claims, never authoritative dispatch evidence.

Measure three comparable arms: native without plugin, corrected legacy, and lean. Add a Manager-vs-root ablation with other settings fixed. Outcome tasks assess real changes, tests, known defects/findings, and forbidden actions without requiring an alias or footer. Keep per-role standard/observed/enforced tests as a separate compatibility suite.

Record model/provider/effort, token caps, CLI and fixture revisions, correctness, false completion, finding quality, turns, latency, token/cache usage, and dispatch count. Label estimated cost. Aim for at least three paired repetitions per task/arm; smaller runs are exploratory. Keep model runs out of offline precommit.

## Rollout gate

Make lean default only after deterministic checks and live outcome comparison show no new false completion/permission regressions or lost material findings. Show quality and overhead separately. If the gate fails, fix the regression and keep lean experimental; do not weaken grading to remove Manager.

Legacy compatibility lasts one transition release after the default switch. Removal is a separate change, with historical report readability preserved where needed. Changing ADR status does not perform that switch or authorize a release/deploy.

## Alternatives and consequences

Latest-only CI is convenient but irreproducible. Forced-dispatch tests alone are circular evidence for architecture quality. Regex recovery of missing events hides integration failures. These approaches are rejected even if they yield more green runs.

Versioned fixtures and paired evaluation add maintenance and live-run cost; they make claims about compatibility and simplification reviewable. Evidence files remain within the local-user trust boundary, as stated in ADR 0009.

## Acceptance evidence

Wrong-session, fake handoff, duplicate resume, truncated/missing event, and legacy-path fixtures cannot produce false pass. Reports distinguish captured from synthetic inputs, offline from live checks, dispatch compliance from outcomes, and measured from estimated savings.

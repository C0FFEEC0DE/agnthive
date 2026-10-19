# ADR 0011: Explicit hook failure and permission policy

- **Status:** Accepted; implemented in 0.4.0 (working tree); host canaries pending (plan task 14); legacy removal deferred to the compatibility window (plan task 16).
- **Date:** 2026-10-19.
- **Decides:** Enforcement, workflow guidance, and telemetry have separate failure behavior; advisory mode does not blanket-approve commands.
- **Basis:** [Review](../specs/2026-10-19-harness-review-and-simplification-design.md), F05/F09.
- **Implementation:** [Plan](../plans/2026-10-19-harness-modernization-and-simplification.md), tasks 01–03, 08, 14–15.

## Context

Handler exceptions and state-write failures can currently disappear into passthrough. Conversely, advisory classification returns explicit allow for non-deny commands, which is not neutral observation. A classifier's fail-closed branch cannot guarantee enforcement when its process never runs. PowerShell patterns alone do not provide coverage when registered hooks match only Bash.

## Decision

| Condition | Contract |
|---|---|
| Enforcement cannot classify/read required policy state | Block the protected action with a diagnostic; never report successful enforcement |
| Advisory cannot evaluate | Preserve native permission flow and report degradation; no blanket allow |
| Guidance/evidence cannot be stored | Preserve unknown/incomplete status; do not fabricate success |
| Telemetry write/rotation fails | Nonblocking diagnostic; telemetry is not an execution prerequisite |
| Stop continuation budget is exhausted | Yield/end with unresolved status retained; no conversion to passed |

Use event-specific output constructors and documented exit-code semantics. PermissionDenied uses its event-specific retry envelope; retry is not permission approval. Bash and native PowerShell routes must have explicit policy parity and separately verified result adapters.

On a verified supporting CLI, declare bounded timeouts and host failure behavior for safety hooks. For the shared safety registration, failure to launch or timeout should block because the Node handler cannot determine the requested mode when it never starts; document this host-level behavior even for advisory. Once the advisory handler runs, it remains neutral to native permissions. Do not apply that blocking failure policy to telemetry hooks. Verify host behavior in the compatibility matrix before claiming support.

Do not swallow an enforcement exception and return exit 0 with `{}`. Do not claim a Node script can print prerequisite guidance if Node itself cannot launch. Installation diagnostics and host errors cover that case. Plugin hooks are workflow controls, not an OS isolation boundary or a replacement for native deny rules.

The existing one-feedback-cycle yield policy in ADR 0003 is a local bounded-retry choice. Preserve it during migration unless a separately reviewed change is needed; it never certifies correctness.

## Alternatives and consequences

Always fail-open would weaken enforce mode. Always fail-closed for every event would make logging failure stop useful work. Blanket allow to improve benchmark pass rates would change the permission contract. All three are rejected.

The host-level safety choice can interrupt an advisory session when the executable is unavailable. This tradeoff must be explicit in install/runtime documentation and covered by canaries; it must not be hidden behind a claim that advisory can never block.

## Acceptance evidence

Exercise missing executable, timeout, malformed input, handler throw, unreadable state, read-only data directory, telemetry-only failure, Bash/PowerShell parity, and native permission prompts. Check stdout, stderr, exit code, and host behavior, not just constructor objects.

# Command policy specification

Status: **Normative** for the Node plugin runtime. Pairs with
`../modules/command-policy.mjs`. The repository test corpus is the regression
suite for this contract.

This is the normative contract for the security hooks, not a brainstorm design.

## 1. Purpose and scope

The command policy inspects the `tool_input.command` string of a Bash tool call
*before* it runs and decides whether the profile allows it. It gates three hook
events:

- **PreToolUse** — emit `permissionDecision: "deny"` with a reason, or `"allow"`.
- **PermissionRequest** — emit `decision.behavior: "deny"` with a message, or
  pass through (no decision object) so the normal permission flow proceeds.
- **PermissionDenied** — decide `{ retry: true }` (let the agent try a different
  command) or `{ retry: false }` (a hard-denied command must not be retried).

The profile intentionally disables release/deploy automation and guards against
destructive, privileged, and remote-execution commands. The policy is a
**safety net**, not a sandbox: it cannot see the runtime environment, working
directory, file contents, or the resolution of shell variables. Its guarantees
are bounded by what a static command-string inspection can establish.

## 2. Shells covered

Agent-generated Bash tool commands run on the host shell. On Linux/macOS that is
a POSIX shell (`sh`, `bash`, `zsh`, `dash`, `ksh`). On Windows the runtime may
shell out through `cmd.exe`, PowerShell (`powershell`/`pwsh`), or a POSIX shell
bundled with Git for Windows. The policy must detect dangerous intent in **all
three** families, because the same destructive action has different spellings:

| Intent | POSIX | PowerShell | CMD |
|---|---|---|---|
| Recursive force-delete root/home/current | `rm -rf /` `rm -rf ~` `rm -rf .` | `Remove-Item -Recurse -Force /` `rm -rf /` (alias) `del -force -recurse` | `rd /s /q C:\` `del /f /s /q` `rmdir /s` |
| Format a disk | `mkfs` `dd` | `Format-Volume` `format` | `format` |
| Privilege escalation | `sudo` | `sudo` (where aliased) `Start-Process -Verb RunAs` | `runas` |
| Force-push history rewrite | `git push -f` `git push --force` | (same `git` verbs) | (same `git` verbs) |
| Discard local commits | `git reset --hard` | (same) | (same) |
| Release/deploy out of scope | `npm publish` `cargo publish` `docker push` `gh release` `kubectl apply` `helm upgrade` | (same — these are OS-agnostic CLIs) | (same) |
| Pipe a remote script into a shell | `curl … \| sh` `wget … \| bash` | `irm … \| iex` `iwr … \| iex` `curl … \| iex` | (rare; matched where present) |

Detection is **case-insensitive** and operates on a **normalized** string (see
§4). `git`, `npm`, `cargo`, `docker`, `gh`, `kubectl`, and `helm` verbs are
OS-agnostic, so their patterns are shared across all three families.

## 3. Advisory and enforce modes

The policy runs in one of two modes, selected by `CLAUDE_CREW_POLICY`:

- **`advisory` (default, fail-open on the unknown).** A command the policy can
  identify as dangerous is denied. A command the policy can identify as safe, or
  one whose real target it **cannot** determine (indirection — see §5), is
  allowed. This is the right default for an interactive development profile:
  command-string inspection is inherently limited, and failing closed on every
  ambiguous command would block legitimate work.
- **`enforce` (fail-closed on the unparseable).** Identical to advisory for
  known-dangerous and clearly-safe commands. A command whose real target cannot
  be statically determined is **denied with an explanation** rather than guessed
  safe. Use this in hardened environments where an ambiguous command must not
  execute until a human resolves it.

The one hard rule that holds in **both** modes: a command the policy identifies
as dangerous is always denied. Mode only changes what happens to commands it
*cannot* classify.

## 4. Normalization

Before matching, the raw command string is normalized the same way the legacy
bash policy normalized it (`normalize_command_for_policy` in `lib.sh`), so the
Node port is behaviorally identical on the POSIX corpus:

1. Lowercase.
2. Collapse runs of whitespace to single spaces.
3. Strip the quote characters `"`, `'`, and the backslash `\`.

Normalization is a deliberate simplification: it flattens quoting so that
`rm -rf "~"` and `rm -rf ~` are treated alike. It does **not** unescape shell
expansions, resolve variables, or decode obfuscation — those are the
limitations in §5. After normalization, pattern matching is a set of anchored
regular expressions over whitespace-delimited tokens.

Normalization never runs `eval`, `sh -c`, or any external process. It is a
pure string transform in the Node standard library.

## 5. Limitations of command-string inspection (unparseable cases)

The policy cannot see inside indirection. The following constructs hide the real
target and are classified **unparseable** (denied in enforce mode, allowed in
advisory mode):

- **Command substitution and backticks** that wrap a dangerous verb, e.g.
  `$(sudo "$cmd")` or `` `rm -rf $target` ``, where the operand is a variable.
- **`eval` / `iex` of a variable or computed string**, e.g. `eval "$cmd"` or
  `iex $payload`.
- **Decoded payloads**, e.g. `base64 -d | sh`, `echo … | base64 -d | bash`, or
  PowerShell `[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64…)` fed
  to `iex`.
- **Variable-only commands** where the entire command is a single expansion,
  e.g. `$cmd` or `& $exe $args` — the verb is not literally present.

When a dangerous verb **is** literally present inside indirection (e.g.
`$(sudo ls)`), the verb is still detected and the command is denied in both
modes — the literal pattern survives normalization. Indirection only produces
an unparseable verdict when the dangerous verb is **not** literally in the
string and the policy therefore cannot tell what will run.

Other limitations that hold in both modes and are documented as accepted risk in
`SECURITY.md`:

- **No environment or working-directory awareness.** `rm -rf build` is allowed
  even if `build` is a symlink to `/`; the policy cannot resolve it.
- **No homoglyph normalization.** A Latin `sudo` and a Cyrillic-looking
  substitute are different bytes; only the literal ASCII verb is matched. This is
  documented, not silently "fixed," because aggressive Unicode normalization can
  itself mask real commands.
- **No shell-grammar parsing.** Quoting, escaping, and tokenization are
  approximated by the §4 normalization, not modeled. The corpus pins the exact
  behavior for quote/escape, subshell, chained-command, and environment-
  assignment cases so regressions are caught.

## 6. Denial verdicts and reasons

Each dangerous pattern carries a short, stable reason string used in the hook
output. These strings are part of the contract (the corpus asserts substrings):

| Pattern | Reason substring |
|---|---|
| `sudo` / privilege escalation | `sudo` |
| `mkfs` / `dd` / `Format-Volume` / `format` | `Dangerous disk commands` |
| Recursive force-delete of `~`, `$home`, `${home}`, `.`, `..` | `home or current directory` |
| Recursive force-delete of `/` / Windows drive root / `git push --force` / `git reset --hard` | `Destructive commands are blocked` |
| Release/deploy verbs | `release/deploy` |
| Remote shell bootstrap (`curl|sh`, `irm|iex`, …) | `remote shell bootstrap` |
| Unparseable indirection (enforce mode only) | `could not be statically resolved` |

PreToolUse uses `hookSpecificOutput.permissionDecision` with an `errorDetails`
markdown block (matching the legacy `emit_pretool_decision`). PermissionRequest
uses `hookSpecificOutput.decision.{behavior,message,errorDetails}`. PermissionDenied
emits `{ retry: false }` for any hard-denied command and for benchmark CI context
(`BENCH_TASK_ID` / `BENCH_TASK_FILE` / `BENCH_WORKDIR` set), otherwise
`{ retry: true }`.

## 7. Corpus requirements

The test corpus at `test/security/command-policy.corpus.mjs` must contain, at
minimum, cases in every one of these categories, across POSIX, PowerShell, and
CMD where the spelling differs:

- **positive** — known-dangerous commands that must be denied in both modes.
- **negative** — clearly-safe commands that must be allowed in both modes.
- **quote/escape** — dangerous commands wrapped in quotes/backslashes that
  normalization flattens (still denied) and safe commands whose quoting must not
  trip a false positive (still allowed).
- **subshell** — command substitution / backticks; both the literal-verb-present
  (denied in both modes) and the variable-hidden (unparseable: denied in
  enforce, allowed in advisory) forms.
- **chained-command** — `;`, `&&`, `||`, `|` joins where one side is dangerous
  (denied in both modes).
- **environment-assignment** — `VAR=value <cmd>` prefix; must not mask detection
  of the following verb, and a safe verb with an assignment must be allowed.
- **Unicode** — multibyte operands (e.g. `rm -rf /täst`) that must still be
  denied when the path root is `/`, plus safe Unicode commands that must pass;
  the homoglyph limitation is asserted explicitly (a non-ASCII lookalike of
  `sudo` is **not** denied, with the limitation documented).

Every case carries `command`, `mode` (`advisory`|`enforce`|`both`), and the
expected `decision` (`deny`|`allow`) plus an optional `reasonSubstring` to
assert. The corpus is the verification gate for §2–§6.

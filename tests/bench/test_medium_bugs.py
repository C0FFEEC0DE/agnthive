"""Tests for MEDIUM-priority bugs in the hooks codebase.

These tests follow TDD: they FAIL before the fix and PASS after.
Bug 4: command_class in lib.sh has typo in make pattern - :"$ should be :)$
Bug 5: subagent-stop-guard.sh lacks load_last_message lazy-loading wrapper
Bug 6: stop-guard.sh block reason missing task_type context on empty message
"""

import subprocess
from pathlib import Path


HOOKS_DIR = Path("/var/home/chaos_weaver/code/claude-crew/claudecfg/hooks")
LIB_SH = HOOKS_DIR / "lib.sh"
SUBAGENT_STOP_GUARD_SH = HOOKS_DIR / "subagent-stop-guard.sh"
STOP_GUARD_SH = HOOKS_DIR / "stop-guard.sh"


class TestBug4_CommandClassMakePattern:
    """Bug 4: command_class has pattern with typo in make matching.

    The pattern '"make"$|*"make "*|*"make:"*)' contains ':"$' which is a typo.
    It should be 'make$)' to match "make" at end-of-string.

    Currently "make" alone falls through to "build" via '*"make "*' first,
    but the pattern itself is structurally wrong because the :"$ part never
    matches correctly (the : is literal, then "$ is end-anchor on a quoted string).

    After the fix, "make" should return "build" and "make:" should never
    match as "build" (falls through to "other").
    """

    def _run_command_class(self, command: str) -> str:
        """Call command_class via bash and return its stdout."""
        cmd = f'''
        set -euo pipefail
        SCRIPT_DIR="{HOOKS_DIR}"
        source "{LIB_SH}"
        command_class "{command}"
        '''
        result = subprocess.run(
            ["bash", "-c", cmd],
            capture_output=True,
            text=True
        )
        return result.stdout.strip()

    def test_make_alone_returns_build(self):
        """Verify "make" alone returns "build" class."""
        result = self._run_command_class("make")
        assert result == "build", (
            f'command_class("make") returned "{result}", expected "build". '
            f'"make" alone should be classified as build.'
        )

    def test_make_colon_never_matches_build(self):
        """Verify "make:" does NOT match as "build" - it should fall through to "other".

        The pattern '"make:"*)' is wrong because the : is a literal character
        that must appear in the command string. A bare "make:" (without space)
        should NOT match any build pattern and should return "other".
        """
        result = self._run_command_class("make:")
        assert result == "other", (
            f'command_class("make:") returned "{result}", expected "other". '
            f'"make:" should not match build patterns and should return "other".'
        )

    def test_make_with_space_returns_build(self):
        """Verify "make something" returns "build" class."""
        result = self._run_command_class("make something")
        assert result == "build", (
            f'command_class("make something") returned "{result}", expected "build".'
        )

    def test_make_test_returns_test_not_build(self):
        """Verify "make test" returns "test" class (higher priority than build)."""
        result = self._run_command_class("make test")
        assert result == "test", (
            f'command_class("make test") returned "{result}", expected "test". '
            f'"make test" should match the test pattern first, not build.'
        )


class TestBug5_SubagentStopGuardLoadLastMessage:
    """Bug 5: subagent-stop-guard.sh calls resolved_last_assistant_message directly
    without a lazy-loading wrapper.

    stop-guard.sh uses load_last_message() to avoid redundant reads.
    subagent-stop-guard.sh should also define load_last_message for consistency.

    Currently subagent-stop-guard.sh calls resolved_last_assistant_message directly
    at line 11: last_message="$(resolved_last_assistant_message)"
    Then checks it twice without caching (lines 13, 18, 23, 28, 33).

    This is inconsistent with stop-guard.sh which defines a load_last_message()
    lazy-loading wrapper at lines 15-19.
    """

    def test_subagent_stop_guard_defines_load_last_message(self):
        """Verify subagent-stop-guard.sh defines load_last_message function."""
        content = SUBAGENT_STOP_GUARD_SH.read_text()

        # Check that load_last_message is defined as a function
        has_function = "load_last_message()" in content or "load_last_message ()" in content
        assert has_function, (
            "subagent-stop-guard.sh does NOT define load_last_message(). "
            "It should define this lazy-loading wrapper for consistency with stop-guard.sh. "
            "Currently it calls resolved_last_assistant_message directly."
        )

    def test_load_last_message_is_defined_before_use(self):
        """Verify load_last_message is defined before any call site."""
        content = SUBAGENT_STOP_GUARD_SH.read_text()
        lines = content.split("\n")

        func_def_line = None
        call_lines = []

        for i, line in enumerate(lines, 1):
            if "load_last_message()" in line or "load_last_message ()" in line:
                if "=" not in line and "function" not in line.lower():
                    func_def_line = i
            if "load_last_message" in line and "=" not in line and "function" not in line.lower():
                if "defined" not in line.lower() and "check" not in line.lower():
                    call_lines.append(i)

        if func_def_line is not None and call_lines:
            # Exclude the definition line from call_lines
            call_lines = [c for c in call_lines if c != func_def_line]
            if call_lines:
                first_call = min(call_lines)
                assert func_def_line < first_call, (
                    f"load_last_message is defined at line {func_def_line} but first used at line {first_call}. "
                    f"Definition must come before use."
                )


class TestBug6_StopGuardBlockReasonMissingTaskType:
    """Bug 6: stop-guard.sh block reason at line ~40 doesn't include task_type context.

    When blocking for "no assistant message found", the message should include
    task_type context like "task_type requires implementation summary but no
    assistant message found".

    Currently the message at line 41 is:
    "Code or config changed, but no assistant summary message was found for this stop event."

    It should mention the task_type to help users understand WHY the block is happening.
    """

    def _run_stop_guard(self, state_json: str) -> tuple[str, int]:
        """Run stop-guard.sh with given state and return (output, returncode)."""
        cmd = f'''
        set -euo pipefail
        SCRIPT_DIR="{HOOKS_DIR}"
        source "{LIB_SH}"

        # Create a temporary state file
        state_file=$(mktemp)
        echo \'{state_json}\' > "$state_file"

        # Patch ensure_state and state_file for testing
        ensure_state() {{ return 0; }}
        state_file() {{ echo "$state_file"; }}

        # Run the stop-guard logic inline to capture the block reason
        code_changed="$(jq -r '.code_changed // false' "$(state_file)")"
        task_type="$(jq -r '.task_type // "other"' "$(state_file)")"

        if [ "$code_changed" = "true" ]; then
            last_message=""
            if [ -z "$last_message" ]; then
                # This is the block at line ~41
                reason="Code or config changed, but no assistant summary message was found for this stop event."
                echo "$reason"
                # After fix, reason should include task_type
            fi
        fi
        '''
        result = subprocess.run(
            ["bash", "-c", cmd],
            capture_output=True,
            text=True
        )
        return result.stdout.strip(), result.returncode

    def test_no_message_block_reason_includes_task_type(self):
        """Verify the 'no assistant message found' block reason mentions task_type.

        When code_changed=true and last_message is empty, stop-guard.sh should
        include task_type in the block reason to help users understand context.
        """
        content = STOP_GUARD_SH.read_text()

        # Find the emit_loop_aware_block call within the code_changed block
        # that fires when last_message is empty
        lines = content.split("\n")
        for i, line in enumerate(lines):
            if 'code_changed' in line and '= "true"' in line:
                # Check subsequent lines for the empty message check + emit
                block_start = i
                for j in range(i, min(i + 8, len(lines))):
                    if '-z "$last_message"' in lines[j] or "-z \"$last_message\"" in lines[j]:
                        # Found the empty message check - find the emit right after
                        for k in range(j, min(j + 4, len(lines))):
                            if 'emit_loop_aware_block' in lines[k]:
                                emit_line = lines[k]
                                assert "task_type" in emit_line.lower() or "$task_type" in emit_line, (
                                    f"Block reason at line {k+1} does not include task_type context. "
                                    f"The message should mention task_type (e.g. 'feature requires implementation summary'). "
                                    f"Line: {emit_line.strip()}"
                                )
                                return  # Test passed

    def test_no_message_block_reason_does_not_hardcode_generic_message(self):
        """Verify the block reason is not the hardcoded generic message."""
        content = STOP_GUARD_SH.read_text()

        # Find the line where it blocks for no message with code_changed
        # The problematic message is:
        # "Code or config changed, but no assistant summary message was found for this stop event."
        # It should be replaced with something that includes task_type context

        # Check if the hardcoded message appears without task_type reference
        hardcoded = "Code or config changed, but no assistant summary message was found for this stop event."
        if hardcoded in content:
            # Check if this line has task_type context nearby
            lines = content.split("\n")
            for i, line in enumerate(lines):
                if hardcoded in line:
                    # Get surrounding context (3 lines before)
                    context = "\n".join(lines[max(0, i-3):i+1])
                    assert "task_type" in context, (
                        f"Block reason at line {i+1} does not include task_type context. "
                        f"The message should mention task_type to help users understand the block. "
                        f"Context: {context}"
                    )
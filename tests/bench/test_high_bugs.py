"""Tests for HIGH-priority bugs in the hooks codebase.

These tests follow TDD: they FAIL before the fix and PASS after.
Bug 1: stop_safe_no_change_footer_hint should be called by stop-guard.sh
Bug 2: session_manager_idle_reason should be called by some hook
Bug 3: task_type_requires_specialist_handoffs must differ from task_type_requires_implementation_summary
"""

import subprocess
from pathlib import Path


HOOKS_DIR = Path("/var/home/chaos_weaver/code/claude-crew/claudecfg/hooks")
LIB_SH = HOOKS_DIR / "lib.sh"
STOP_GUARD_SH = HOOKS_DIR / "stop-guard.sh"
ALL_HOOK_SCRIPTS = list(HOOKS_DIR.glob("*.sh"))


class TestBug1_StopSafeNoChangeFooterHint:
    """Bug 1: stop_safe_no_change_footer_hint is dead code.

    The function is defined in lib.sh but allegedly never called.
    Actually, it IS called in stop-guard.sh (verified by grep).
    This test verifies the function IS used (would FAIL if it were truly dead code).
    """

    def test_function_is_called_in_stop_guard_sh(self):
        """Verify stop_safe_no_change_footer_hint is actually CALLED by stop-guard.sh."""
        content = STOP_GUARD_SH.read_text()
        # The function is used via: $(stop_safe_no_change_footer_hint)
        # We grep for the function name being invoked
        assert "stop_safe_no_change_footer_hint" in content, (
            f"stop_safe_no_change_footer_hint is NOT called in stop-guard.sh. "
            f"It may be dead code (defined but never used)."
        )

    def test_function_is_not_duplicated_inline(self):
        """Verify the hint text is NOT duplicated inline - function should be used."""
        content = STOP_GUARD_SH.read_text()
        # Check for the hint text appearing inline (not via function call)
        inline_count = content.count("If this reply did not introduce additional changes")
        assert inline_count == 0, (
            f"Hint text is duplicated inline {inline_count} time(s) in stop-guard.sh. "
            f"Should use stop_safe_no_change_footer_hint() instead."
        )


class TestBug2_SessionManagerIdleReason:
    """Bug 2: session_manager_idle_reason is defined but never called.

    Verify this function is called by some hook script.
    """

    def test_function_is_called_by_some_hook(self):
        """Check all .sh files in claudecfg/hooks/ for calls to session_manager_idle_reason."""
        calls_found = []
        for script in ALL_HOOK_SCRIPTS:
            content = script.read_text()
            if "session_manager_idle_reason" in content:
                calls_found.append(str(script.name))

        assert len(calls_found) > 0, (
            f"session_manager_idle_reason is NOT called by any hook script. "
            f"Defined in lib.sh but never used - dead code."
        )


class TestBug3_TaskTypeRequiresSpecialistHandoffs:
    """Bug 3: task_type_requires_specialist_handoffs is byte-for-byte identical to
    task_type_requires_implementation_summary. They must be DIFFERENT functions.

    We source lib.sh and call both functions with each task_type to verify
    they return DIFFERENT results for at least one type.
    """

    TASK_TYPES = ["feature", "bugfix", "refactor", "review", "docs", "support", "other"]

    def _run_function_via_bash(self, function_name: str, task_type: str) -> int:
        """Call a lib.sh function via bash and return its exit code."""
        cmd = f'''
        set -euo pipefail
        SCRIPT_DIR="{HOOKS_DIR}"
        source "{LIB_SH}"
        {function_name} "{task_type}"
        '''
        result = subprocess.run(
            ["bash", "-c", cmd],
            capture_output=True,
            text=True
        )
        return result.returncode

    def test_functions_return_different_results(self):
        """Verify the two functions return DIFFERENT results for at least one task_type."""
        differences = []

        for task_type in self.TASK_TYPES:
            result_impl = self._run_function_via_bash("task_type_requires_implementation_summary", task_type)
            result_specialist = self._run_function_via_bash("task_type_requires_specialist_handoffs", task_type)

            if result_impl != result_specialist:
                differences.append(f"{task_type}: implementation={result_impl}, specialist={result_specialist}")

        assert len(differences) > 0, (
            f"task_type_requires_specialist_handoffs and task_type_requires_implementation_summary "
            f"return IDENTICAL results for all task_types: {self.TASK_TYPES}. "
            f"These functions must be DIFFERENT - one is likely wrong or copy-pasted."
        )

    def test_functions_are_not_byte_identical(self):
        """Verify the function bodies in lib.sh are NOT byte-for-byte identical.

        The functions have different names, so we extract just the body (lines after the {)
        to compare whether the actual logic is identical.
        """
        content = LIB_SH.read_text()

        # Extract function bodies only (lines after function signature, up to closing })
        # This avoids the function name difference from masking identical bodies
        impl_body = self._extract_function_body(content, "task_type_requires_implementation_summary")
        specialist_body = self._extract_function_body(content, "task_type_requires_specialist_handoffs")

        assert impl_body != specialist_body, (
            f"The function BODIES (excluding function name) are byte-for-byte IDENTICAL. "
            f"task_type_requires_specialist_handoffs must have DIFFERENT logic from "
            f"task_type_requires_implementation_summary."
        )

    def _extract_function_body(self, content: str, func_name: str) -> str:
        """Extract just the body of a shell function (lines after the function signature line)."""
        import re
        # Find the function definition starting at the function name line
        pattern = rf'{re.escape(func_name)}\(\) \{{\s*\n((?:.*\n)*?)\}}'
        match = re.search(pattern, content)
        if match:
            return match.group(1)
        return ""
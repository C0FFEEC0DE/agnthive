"""Direct unit tests for lib.sh footer-contract recognition functions.

Sources lib.sh and calls the message_mentions_* family + the
message_has_any_line_prefix helper directly, mirroring the pattern in
test_hook_effective_roles.py. These lock the dedup refactor (the family now
delegates to message_has_any_line_prefix) and add behavioral coverage of the
stop-safe footer enforcement that the stop-guard relies on.

Each function returns 0 (recognized) / non-zero (not recognized); tests assert
that via the helper.
"""

import os
import subprocess
import tempfile
from pathlib import Path

HOOKS_DIR = Path(__file__).resolve().parents[2] / "claudecfg" / "hooks"
LIB_SH = HOOKS_DIR / "lib.sh"


def _calls(function: str, message: str, extra_args: str = "") -> bool:
    """Return True if the named lib.sh function accepts the message (exit 0).

    extra_args is appended verbatim after the message arg (used to pass the
    prefix list to message_has_any_line_prefix).
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        home_dir = Path(tmpdir) / "home"
        (home_dir / ".claude" / "state").mkdir(parents=True)
        cmd = f"""
set -euo pipefail
export HOME="{home_dir}"
SCRIPT_DIR="{HOOKS_DIR}"
source "{LIB_SH}"
if {function} "$MSG" {extra_args}; then
    echo yes
fi
"""
        env = dict(os.environ)
        env["MSG"] = message
        result = subprocess.run(
            ["bash", "-c", cmd],
            capture_output=True, text=True, timeout=30, env=env,
        )
        return result.returncode == 0 and "yes" in result.stdout


# ---- message_has_any_line_prefix (helper) ----

# A representative prefix list used by the helper tests.
_PREFIXES = '"Outcome:" "Result:" "Status:"'


class TestAnyLinePrefix:
    def test_matches_first_prefix(self):
        assert _calls("message_has_any_line_prefix", "Outcome: done", _PREFIXES)

    def test_matches_a_later_prefix(self):
        # "Result:" is the 2nd prefix in the list
        assert _calls("message_has_any_line_prefix", "Result: ok", _PREFIXES)

    def test_no_prefix_matches(self):
        assert not _calls("message_has_any_line_prefix", "nothing here", _PREFIXES)

    def test_case_insensitive(self):
        assert _calls("message_has_any_line_prefix", "outcome: done", _PREFIXES)

    def test_leading_whitespace_trimmed(self):
        assert _calls("message_has_any_line_prefix", "   Outcome: done", _PREFIXES)

    def test_match_on_non_first_line(self):
        assert _calls(
            "message_has_any_line_prefix",
            "intro line\nOutcome: done\ntrailer",
            _PREFIXES,
        )

    def test_empty_message_no_match(self):
        assert not _calls("message_has_any_line_prefix", "", _PREFIXES)


# ---- message_mentions_verification_status ----

class TestVerificationStatus:
    def test_canonical(self):
        assert _calls("message_mentions_verification_status", "Verification status: passed")

    def test_short(self):
        assert _calls("message_mentions_verification_status", "Verification: ok")

    def test_tests_variant(self):
        assert _calls("message_mentions_verification_status", "Tests: 5 passed")

    def test_no_match(self):
        assert not _calls("message_mentions_verification_status", "all good here")


# ---- message_mentions_review_outcome ----

class TestReviewOutcome:
    def test_canonical(self):
        assert _calls("message_mentions_review_outcome", "Review outcome: approved")

    def test_short(self):
        assert _calls("message_mentions_review_outcome", "Review: clean")

    def test_no_match(self):
        assert not _calls("message_mentions_review_outcome", "looked at the code")


# ---- message_mentions_docs_status ----

class TestDocsStatus:
    def test_canonical(self):
        assert _calls("message_mentions_docs_status", "Docs status: updated")

    def test_ru(self):
        assert _calls("message_mentions_docs_status", "Документация: обновлена")

    def test_no_match(self):
        assert not _calls("message_mentions_docs_status", "wrote some notes")


# ---- message_mentions_changed_files ----

class TestChangedFiles:
    def test_canonical(self):
        assert _calls("message_mentions_changed_files", "Changed files: a.py, b.py")

    def test_no_files_changed(self):
        assert _calls("message_mentions_changed_files", "No files changed: noop")

    def test_no_match(self):
        assert not _calls("message_mentions_changed_files", "touched nothing")


# ---- message_mentions_remaining_risks ----

class TestRemainingRisks:
    def test_canonical(self):
        assert _calls("message_mentions_remaining_risks", "Remaining risks: none")

    def test_risks_short(self):
        assert _calls("message_mentions_remaining_risks", "Risks: low")

    def test_no_match(self):
        assert not _calls("message_mentions_remaining_risks", "all safe")


# ---- message_mentions_next_step ----

class TestNextStep:
    def test_canonical(self):
        assert _calls("message_mentions_next_step", "Next step: run tests")

    def test_plural(self):
        assert _calls("message_mentions_next_step", "Next steps: a, b")

    def test_ru(self):
        assert _calls("message_mentions_next_step", "Следующий шаг: тесты")

    def test_no_match(self):
        assert not _calls("message_mentions_next_step", "nothing pending")


# ---- message_mentions_concrete_outcome ----

class TestConcreteOutcome:
    def test_outcome_prefix(self):
        assert _calls("message_mentions_concrete_outcome", "Outcome: implemented")

    def test_status_prefix_isolated(self):
        # 'ready' is not a loose keyword -> only the Status: prefix path matches
        assert _calls("message_mentions_concrete_outcome", "Status: ready")

    def test_no_prefix_no_keyword(self):
        assert not _calls("message_mentions_concrete_outcome", "hello world")

    def test_loose_keyword_fallback(self):
        assert _calls("message_mentions_concrete_outcome", "I investigated the failure")

    def test_loose_ru_keyword_fallback(self):
        assert _calls("message_mentions_concrete_outcome", "я исправил баг")


# ---- message_reports_no_changes ----

class TestReportsNoChanges:
    def test_no_files_changed(self):
        assert _calls("message_reports_no_changes", "No files changed.")

    def test_no_changes_were_made(self):
        assert _calls("message_reports_no_changes", "No changes were made.")

    def test_nothing_changed(self):
        assert _calls("message_reports_no_changes", "Nothing changed.")

    def test_no_match_when_changes(self):
        assert not _calls("message_reports_no_changes", "Changed files: a.py")
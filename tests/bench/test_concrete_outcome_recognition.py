"""Unit tests for lib.sh message_mentions_concrete_outcome().

Covers the exact-prefix recognition path, including the ``Status:`` line
prefix (additive — a progress/status line reported as the concrete outcome),
and isolates it from the loose-keyword fallback by using words that are not
loose keywords.
"""

import subprocess
import tempfile
from pathlib import Path


HOOKS_DIR = Path(__file__).resolve().parents[2] / "claudecfg" / "hooks"
LIB_SH = HOOKS_DIR / "lib.sh"


def _recognizes(message: str) -> bool:
    """Return True if message_mentions_concrete_outcome accepts the message."""
    with tempfile.TemporaryDirectory() as tmpdir:
        home_dir = Path(tmpdir) / "home"
        (home_dir / ".claude" / "state").mkdir(parents=True)
        cmd = f"""
set -euo pipefail
export HOME="{home_dir}"
SCRIPT_DIR="{HOOKS_DIR}"
source "{LIB_SH}"
if message_mentions_concrete_outcome "$MSG"; then
    echo recognized
fi
"""
        import os

        env = dict(os.environ)
        env["MSG"] = message
        result = subprocess.run(
            ["bash", "-c", cmd],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
        return result.returncode == 0 and "recognized" in result.stdout


class TestConcreteOutcomePrefixRecognition:
    """Exact line-prefix path of message_mentions_concrete_outcome()."""

    def test_outcome_prefix_recognized(self):
        """The canonical Outcome: footer line is recognized."""
        assert _recognizes("Outcome: implemented the parser.")

    def test_status_prefix_recognized_as_outcome(self):
        """A Status: line is recognized as a concrete outcome (additive path).

        'ready' is intentionally NOT a loose keyword, so this can only pass
        via the Status: exact-prefix branch — isolating it from the fallback.
        """
        assert _recognizes("Status: ready")

    def test_status_without_colon_not_recognized(self):
        """Without the colon, 'Status ready' is not a prefix and not a keyword.

        Proves the recognition above is the line-prefix 'Status:', not the bare
        word 'Status'.
        """
        assert not _recognizes("Status ready")

    def test_no_outcome_line_not_recognized(self):
        """A message with no outcome line and no keywords is not recognized."""
        assert not _recognizes("hello world, nothing concrete here")

    def test_loose_keyword_fallback_still_works(self):
        """Natural-language outcome keywords still match via the fallback."""
        assert _recognizes("I investigated the failure and reported it.")
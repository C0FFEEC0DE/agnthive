"""Tests for the durable progress ledger re-injection on PostCompact.

The ledger is plain markdown the controller appends to during Subagent-Driven
Development so work survives context compaction. post-compact.sh re-injects it
as additionalContext when a non-empty ledger is present, and emits nothing
otherwise (preserving prior behavior).

Tests use CLAUDE_CREW_PROGRESS_FILE pointed at a tmp_path file so they never
touch the real repo's .claude-crew/ scratch directory.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
HOOK = REPO_ROOT / "claudecfg" / "hooks" / "post-compact.sh"


def _run_hook(payload: dict, env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        cwd=str(REPO_ROOT),
    )


def _base_env(tmp_path: Path, ledger_file: Path | None) -> dict:
    import os

    env = dict(os.environ)
    env["HOME"] = str(tmp_path / "home")
    # Isolate from any parent environment override of the ledger size cap.
    env.pop("CLAUDE_CREW_LEDGER_MAX_BYTES", None)
    if ledger_file is not None:
        env["CLAUDE_CREW_PROGRESS_FILE"] = str(ledger_file)
    else:
        # Force the env path to a non-existent file so no ledger is found and
        # progress_ledger_path never falls through to the real git toplevel.
        env["CLAUDE_CREW_PROGRESS_FILE"] = str(tmp_path / "absent.md")
    return env


def test_post_compact_injects_ledger_when_present(tmp_path):
    ledger = tmp_path / "progress.md"
    ledger.write_text(
        "Task 1: complete (commits abc1234..def5678, review clean)\n"
        "Task 2: complete (commits def5678..9abcdef0, review clean)\n",
        encoding="utf-8",
    )
    payload = {"session_id": "s-ledger", "trigger": "manual", "compact_summary": ""}
    result = _run_hook(payload, _base_env(tmp_path, ledger))
    assert result.returncode == 0, result.stderr

    out = json.loads(result.stdout)
    hso = out["hookSpecificOutput"]
    assert hso["hookEventName"] == "PostCompact"
    ctx = hso["additionalContext"]
    assert "Task 1: complete" in ctx
    assert "abc1234..def5678" in ctx
    assert "do not re-dispatch" in ctx


def test_post_compact_no_ledger_emits_nothing(tmp_path):
    payload = {"session_id": "s-none", "trigger": "manual", "compact_summary": ""}
    result = _run_hook(payload, _base_env(tmp_path, None))
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == ""


def test_post_compact_whitespace_only_ledger_emits_nothing(tmp_path):
    ledger = tmp_path / "progress.md"
    ledger.write_text("   \n\n  \t \n", encoding="utf-8")
    payload = {"session_id": "s-empty", "trigger": "manual", "compact_summary": ""}
    result = _run_hook(payload, _base_env(tmp_path, ledger))
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == ""


def test_post_compact_still_logs_compact_event(tmp_path):
    ledger = tmp_path / "progress.md"
    ledger.write_text("Task 1: complete\n", encoding="utf-8")
    payload = {"session_id": "s-log", "trigger": "manual", "compact_summary": "sum"}
    env = _base_env(tmp_path, ledger)
    result = _run_hook(payload, env)
    assert result.returncode == 0, result.stderr

    log_file = Path(env["HOME"]) / ".claude" / "logs" / "post-compact.jsonl"
    assert log_file.exists(), "post-compact.jsonl audit log must be written"
    # post-compact.sh writes one pretty-printed JSON object per append (the
    # repo's jq -n convention); parse the whole file, not a single line.
    last = json.loads(log_file.read_text(encoding="utf-8"))
    assert last["session_id"] == "s-log"
    assert last["trigger"] == "manual"


def test_post_compact_truncates_oversized_ledger(tmp_path):
    ledger = tmp_path / "progress.md"
    # Build a ledger larger than the 64 KiB default cap. Each line is 12 bytes,
    # so 6000 lines yields ~72 KiB. Use an ASCII prefix so the first 64 KiB
    # boundary is predictable and the truncation note is easy to detect.
    marker = "TASK_START "
    filler = (marker + "x\n") * 6000
    oversized = "HEADER LINE\n" + filler
    ledger.write_text(oversized, encoding="utf-8")

    payload = {"session_id": "s-trunc", "trigger": "manual", "compact_summary": ""}
    env = _base_env(tmp_path, ledger)
    result = _run_hook(payload, env)
    assert result.returncode == 0, result.stderr

    out = json.loads(result.stdout)
    hso = out["hookSpecificOutput"]
    ctx = hso["additionalContext"]
    assert "HEADER LINE" in ctx
    assert "Ledger truncated" in ctx
    assert "exceeds 65536 byte limit" in ctx
    # The full oversized content must NOT be present in its entirety.
    assert len(ctx.encode("utf-8")) < len(oversized.encode("utf-8"))
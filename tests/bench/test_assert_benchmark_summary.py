"""Tests for scripts/assert-benchmark-summary.sh.

assert-benchmark-summary is the CI gate that decides whether a benchmark run
passed. These tests exercise every branch of its jq gate expression: the
happy path, a missing file, wrong argument count, and each individual gate
predicate that can fail (executed != configured, passed != tasks,
tool_failures, policy_violations, unresolved_tasks, plus the optional
BENCH_MAX_RECOVERED_TASKS / BENCH_MAX_SUMMARY_REPAIRED_TASKS ceilings).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "assert-benchmark-summary.sh"


def _passing_totals() -> dict:
    return {
        "configured_tasks": 2,
        "selected_tasks": 2,
        "executed_tasks": 2,
        "unexecuted_tasks": 0,
        "unresolved_tasks": 0,
        "tasks": 2,
        "passed": 2,
        "clean_passed": 2,
        "completed": 2,
        "verification_required": 2,
        "tests_run": 2,
        "review_required": 2,
        "review_present": 2,
        "docs_required": 0,
        "docs_updated": 0,
        "recovered_tasks": 0,
        "timeout_recovered": 0,
        "max_turns_recovered": 0,
        "summary_repaired": 0,
        "policy_violations": 0,
        "tool_failures": 0,
    }


def _summary(**overrides) -> dict:
    totals = _passing_totals()
    totals.update(overrides.pop("totals", {}))
    doc = {
        "schema_version": "1.0",
        "mode": "cmd",
        "runner": "r",
        "generated_at": "2026-01-01T00:00:00Z",
        "source_ref": "ref",
        "source_sha": "sha",
        "task_glob": "g",
        "totals": totals,
        "rates": {
            "task_pass_rate": 1.0,
            "clean_pass_rate": 1.0,
            "completion_rate": 1.0,
            "verification_pass_rate": 1.0,
            "review_compliance_rate": 1.0,
            "docs_compliance_rate": 1.0,
            "execution_coverage_rate": 1.0,
            "recovered_task_rate": 0.0,
            "summary_repair_rate": 0.0,
        },
        "median_runtime_seconds": 1.0,
        "tasks": [],
    }
    doc.update(overrides)
    return doc


def _write(tmp_path: Path, doc: dict) -> Path:
    p = tmp_path / "summary.json"
    p.write_text(json.dumps(doc))
    return p


def _run(summary_path: Path, *extra_args, env_override: dict | None = None) -> subprocess.CompletedProcess:
    import os
    env = dict(os.environ)
    if env_override:
        env.update(env_override)
    return subprocess.run(
        ["bash", str(SCRIPT), str(summary_path), *extra_args],
        capture_output=True, text=True, env=env,
    )


def test_passing_summary_exits_zero(tmp_path):
    s = _write(tmp_path, _summary())
    r = _run(s)
    assert r.returncode == 0
    assert "Checking summary file" in r.stdout


def test_missing_file_exits_one(tmp_path):
    r = _run(tmp_path / "nope.json")
    assert r.returncode == 1
    assert "not found" in r.stderr


def test_wrong_arg_count_exits_one(tmp_path):
    s = _write(tmp_path, _summary())
    # No path argument at all.
    import os
    r = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env=os.environ)
    assert r.returncode == 1
    assert "Usage" in r.stderr
    # Two arguments (too many).
    r = subprocess.run(["bash", str(SCRIPT), str(s), "extra"], capture_output=True, text=True, env=os.environ)
    assert r.returncode == 1


def test_executed_not_equal_configured_fails(tmp_path):
    s = _write(tmp_path, _summary(totals={"configured_tasks": 2, "executed_tasks": 1, "tasks": 1, "passed": 1}))
    assert _run(s).returncode == 1


def test_passed_not_equal_tasks_fails(tmp_path):
    s = _write(tmp_path, _summary(totals={"passed": 1}))  # tasks=2, passed=1
    assert _run(s).returncode == 1


def test_tool_failures_fails(tmp_path):
    s = _write(tmp_path, _summary(totals={"tool_failures": 1}))
    assert _run(s).returncode == 1


def test_policy_violations_fails(tmp_path):
    s = _write(tmp_path, _summary(totals={"policy_violations": 1}))
    assert _run(s).returncode == 1


def test_unresolved_tasks_fails(tmp_path):
    s = _write(tmp_path, _summary(totals={"unresolved_tasks": 1}))
    assert _run(s).returncode == 1


def test_zero_configured_tasks_fails(tmp_path):
    s = _write(tmp_path, _summary(totals={
        "configured_tasks": 0, "executed_tasks": 0, "tasks": 0, "passed": 0,
    }))
    assert _run(s).returncode == 1


def test_missing_unresolved_field_treated_as_zero_passes(tmp_path):
    # totals has no unresolved_tasks key; `// 0` must keep the gate green.
    doc = _summary()
    del doc["totals"]["unresolved_tasks"]
    s = _write(tmp_path, doc)
    assert _run(s).returncode == 0


def test_recovered_tasks_ceiling_passes_when_under(tmp_path):
    s = _write(tmp_path, _summary(totals={"recovered_tasks": 2}))
    r = _run(s, env_override={"BENCH_MAX_RECOVERED_TASKS": "2"})
    assert r.returncode == 0


def test_recovered_tasks_ceiling_fails_when_over(tmp_path):
    s = _write(tmp_path, _summary(totals={"recovered_tasks": 3}))
    r = _run(s, env_override={"BENCH_MAX_RECOVERED_TASKS": "2"})
    assert r.returncode == 1


def test_summary_repaired_ceiling_passes_when_under(tmp_path):
    s = _write(tmp_path, _summary(totals={"summary_repaired": 1}))
    r = _run(s, env_override={"BENCH_MAX_SUMMARY_REPAIRED_TASKS": "1"})
    assert r.returncode == 0


def test_summary_repaired_ceiling_fails_when_over(tmp_path):
    s = _write(tmp_path, _summary(totals={"summary_repaired": 5}))
    r = _run(s, env_override={"BENCH_MAX_SUMMARY_REPAIRED_TASKS": "2"})
    assert r.returncode == 1


def test_both_ceilings_set_pass(tmp_path):
    s = _write(tmp_path, _summary(totals={"recovered_tasks": 1, "summary_repaired": 1}))
    r = _run(s, env_override={
        "BENCH_MAX_RECOVERED_TASKS": "2",
        "BENCH_MAX_SUMMARY_REPAIRED_TASKS": "2",
    })
    assert r.returncode == 0
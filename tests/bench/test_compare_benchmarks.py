"""Tests for scripts/compare-benchmarks.sh.

compare-benchmarks emits a comparison document with baseline/candidate
snapshots, computed deltas, a verdict (regressed | improved |
no_significant_change), and human-readable reasons. These tests pin the
verdict logic across all three outcomes, the delta arithmetic, the
schema_version, and argument validation.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "compare-benchmarks.sh"


def _summary(*, task_pass_rate=1.0, verification_pass_rate=1.0,
             review_compliance_rate=1.0, docs_compliance_rate=1.0,
             execution_coverage_rate=1.0, completion_rate=1.0,
             clean_pass_rate=1.0, recovered_task_rate=0.0,
             summary_repair_rate=0.0, policy_violations=0, tool_failures=0,
             recovered_tasks=0, summary_repaired=0, median_runtime_seconds=10.0,
             configured_tasks=2, executed_tasks=2, source_ref="ref",
             source_sha="sha", mode="cmd") -> dict:
    return {
        "schema_version": "1.0",
        "mode": mode,
        "runner": "r",
        "generated_at": "2026-01-01T00:00:00Z",
        "source_ref": source_ref,
        "source_sha": source_sha,
        "task_glob": "g",
        "totals": {
            "configured_tasks": configured_tasks,
            "selected_tasks": configured_tasks,
            "executed_tasks": executed_tasks,
            "unexecuted_tasks": 0,
            "unresolved_tasks": 0,
            "tasks": executed_tasks,
            "passed": executed_tasks,
            "clean_passed": executed_tasks,
            "completed": executed_tasks,
            "verification_required": 0,
            "tests_run": 0,
            "review_required": 0,
            "review_present": 0,
            "docs_required": 0,
            "docs_updated": 0,
            "recovered_tasks": recovered_tasks,
            "timeout_recovered": 0,
            "max_turns_recovered": 0,
            "summary_repaired": summary_repaired,
            "policy_violations": policy_violations,
            "tool_failures": tool_failures,
        },
        "rates": {
            "task_pass_rate": task_pass_rate,
            "clean_pass_rate": clean_pass_rate,
            "completion_rate": completion_rate,
            "verification_pass_rate": verification_pass_rate,
            "review_compliance_rate": review_compliance_rate,
            "docs_compliance_rate": docs_compliance_rate,
            "execution_coverage_rate": execution_coverage_rate,
            "recovered_task_rate": recovered_task_rate,
            "summary_repair_rate": summary_repair_rate,
        },
        "median_runtime_seconds": median_runtime_seconds,
        "tasks": [],
    }


def _run(tmp_path: Path, baseline: dict, candidate: dict) -> tuple[int, dict]:
    b = tmp_path / "baseline.json"
    c = tmp_path / "candidate.json"
    b.write_text(json.dumps(baseline))
    c.write_text(json.dumps(candidate))
    r = subprocess.run(["bash", str(SCRIPT), str(b), str(c)],
                       capture_output=True, text=True)
    doc = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else {}
    return r.returncode, doc


def test_no_significant_change(tmp_path):
    rc, doc = _run(tmp_path, _summary(), _summary())
    assert rc == 0
    assert doc["verdict"] == "no_significant_change"
    assert doc["reasons"] == []
    assert doc["schema_version"] == "1.0"
    # All deltas zero against an identical baseline.
    for k, v in doc["deltas"].items():
        assert v == 0


def test_regressed_on_task_pass_rate(tmp_path):
    rc, doc = _run(tmp_path, _summary(task_pass_rate=0.9), _summary(task_pass_rate=0.8))
    assert rc == 0
    assert doc["verdict"] == "regressed"
    assert "task_pass_rate decreased" in doc["reasons"]
    assert doc["deltas"]["task_pass_rate"] == pytest.approx(-0.1)


def test_regressed_on_policy_violations(tmp_path):
    rc, doc = _run(tmp_path, _summary(policy_violations=0), _summary(policy_violations=2))
    assert rc == 0
    assert doc["verdict"] == "regressed"
    assert "policy_violations increased" in doc["reasons"]
    assert doc["deltas"]["policy_violations"] == 2


def test_regressed_on_tool_failures(tmp_path):
    rc, doc = _run(tmp_path, _summary(tool_failures=0), _summary(tool_failures=1))
    assert rc == 0
    assert doc["verdict"] == "regressed"
    assert "tool_failures increased" in doc["reasons"]


def test_regressed_on_docs_compliance(tmp_path):
    rc, doc = _run(tmp_path, _summary(docs_compliance_rate=1.0),
                   _summary(docs_compliance_rate=0.5))
    assert rc == 0
    assert doc["verdict"] == "regressed"
    assert "docs_compliance_rate decreased" in doc["reasons"]


def test_improved_on_task_pass_rate(tmp_path):
    rc, doc = _run(tmp_path, _summary(task_pass_rate=0.7), _summary(task_pass_rate=0.9))
    assert rc == 0
    assert doc["verdict"] == "improved"
    assert doc["deltas"]["task_pass_rate"] == pytest.approx(0.2)


def test_improved_on_fewer_policy_violations(tmp_path):
    rc, doc = _run(tmp_path, _summary(policy_violations=3), _summary(policy_violations=0))
    assert rc == 0
    assert doc["verdict"] == "improved"
    assert doc["deltas"]["policy_violations"] == -3


def test_improved_on_faster_runtime_with_equal_rates(tmp_path):
    rc, doc = _run(tmp_path, _summary(median_runtime_seconds=20.0),
                   _summary(median_runtime_seconds=10.0))
    assert rc == 0
    assert doc["verdict"] == "improved"
    assert "median_runtime_seconds improved" in doc["reasons"]
    assert doc["deltas"]["median_runtime_seconds"] == -10.0


def test_faster_runtime_alone_with_rate_drop_is_regression(tmp_path):
    # median runtime improved but task_pass_rate dropped -> regressed wins.
    rc, doc = _run(tmp_path, _summary(task_pass_rate=0.9, median_runtime_seconds=20.0),
                   _summary(task_pass_rate=0.8, median_runtime_seconds=10.0))
    assert rc == 0
    assert doc["verdict"] == "regressed"
    assert "median_runtime_seconds improved" not in doc["reasons"]


def test_baseline_candidate_snapshots_copied(tmp_path):
    base = _summary(source_ref="main", source_sha="aaa", mode="mock")
    cand = _summary(source_ref="feat", source_sha="bbb", mode="cmd")
    rc, doc = _run(tmp_path, base, cand)
    assert rc == 0
    assert doc["baseline"]["ref"] == "main"
    assert doc["baseline"]["sha"] == "aaa"
    assert doc["baseline"]["mode"] == "mock"
    assert doc["candidate"]["ref"] == "feat"
    assert doc["candidate"]["sha"] == "bbb"
    assert doc["candidate"]["mode"] == "cmd"


def test_wrong_arg_count_exits_one(tmp_path):
    r = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True)
    assert r.returncode == 1
    assert "Usage" in r.stderr
    r = subprocess.run(["bash", str(SCRIPT), "only-one"], capture_output=True, text=True)
    assert r.returncode == 1
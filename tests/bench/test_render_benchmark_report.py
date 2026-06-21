"""Tests for scripts/render-benchmark-report.sh.

render-benchmark-report turns a comparison JSON (the output of
compare-benchmarks.sh) into a markdown table with a verdict line, an optional
mock-mode note, and a reasons list. These tests pin the table shape, the
verdict rendering, the mock-mode note, and the reasons section.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "render-benchmark-report.sh"


def _comparison(*, verdict="improved", reasons=None, baseline_mode="cmd",
                candidate_mode="cmd") -> dict:
    return {
        "schema_version": "1.0",
        "baseline": {
            "ref": "main", "sha": "aaa", "mode": baseline_mode,
            "totals": {"configured_tasks": 2, "executed_tasks": 2,
                       "policy_violations": 1, "tool_failures": 0,
                       "recovered_tasks": 0, "summary_repaired": 0},
            "rates": {
                "execution_coverage_rate": 1.0, "task_pass_rate": 0.8,
                "clean_pass_rate": 0.8, "completion_rate": 1.0,
                "verification_pass_rate": 0.9, "review_compliance_rate": 1.0,
                "docs_compliance_rate": 1.0, "recovered_task_rate": 0.0,
                "summary_repair_rate": 0.0,
            },
            "median_runtime_seconds": 20.0,
        },
        "candidate": {
            "ref": "feat", "sha": "bbb", "mode": candidate_mode,
            "totals": {"configured_tasks": 2, "executed_tasks": 2,
                       "policy_violations": 0, "tool_failures": 0,
                       "recovered_tasks": 0, "summary_repaired": 0},
            "rates": {
                "execution_coverage_rate": 1.0, "task_pass_rate": 0.9,
                "clean_pass_rate": 0.9, "completion_rate": 1.0,
                "verification_pass_rate": 0.9, "review_compliance_rate": 1.0,
                "docs_compliance_rate": 1.0, "recovered_task_rate": 0.0,
                "summary_repair_rate": 0.0,
            },
            "median_runtime_seconds": 10.0,
        },
        "deltas": {
            "task_pass_rate": 0.1, "clean_pass_rate": 0.1,
            "completion_rate": 0.0, "verification_pass_rate": 0.0,
            "review_compliance_rate": 0.0, "docs_compliance_rate": 0.0,
            "execution_coverage_rate": 0.0, "recovered_task_rate": 0.0,
            "summary_repair_rate": 0.0, "policy_violations": -1,
            "tool_failures": 0, "median_runtime_seconds": -10.0,
        },
        "verdict": verdict,
        "reasons": reasons or [],
    }


def _run(tmp_path: Path, doc: dict) -> tuple[int, str]:
    p = tmp_path / "cmp.json"
    p.write_text(json.dumps(doc))
    r = subprocess.run(["bash", str(SCRIPT), str(p)], capture_output=True, text=True)
    return r.returncode, r.stdout


def test_renders_table_and_verdict(tmp_path):
    rc, out = _run(tmp_path, _comparison())
    assert rc == 0
    assert "## Benchmark Report" in out
    assert "| Metric | Baseline | Candidate | Delta |" in out
    assert "| Task pass rate | 80% | 90% | 10% |" in out
    assert "**Verdict:** `improved`" in out


def test_negative_delta_percentage_rendered(tmp_path):
    rc, out = _run(tmp_path, _comparison())
    assert rc == 0
    assert "| Policy violations | 1 | 0 | -1 |" in out
    assert "| Median runtime (s) | 20.0 | 10.0 | -10.0 |" in out


def test_mock_mode_note_when_either_side_mock(tmp_path):
    rc, out = _run(tmp_path, _comparison(baseline_mode="mock"))
    assert rc == 0
    assert "at least one side ran in mock mode" in out
    assert "BENCH_RUNNER_CMD" in out


def test_no_mock_note_when_both_cmd(tmp_path):
    rc, out = _run(tmp_path, _comparison(baseline_mode="cmd", candidate_mode="cmd"))
    assert rc == 0
    assert "ran in mock mode" not in out


def test_reasons_rendered_when_present(tmp_path):
    rc, out = _run(tmp_path, _comparison(reasons=["task_pass_rate increased", "policy_violations decreased"]))
    assert rc == 0
    assert "**Reasons:**" in out
    assert "- task_pass_rate increased" in out
    assert "- policy_violations decreased" in out


def test_no_reasons_section_when_empty(tmp_path):
    rc, out = _run(tmp_path, _comparison(reasons=[]))
    assert rc == 0
    assert "**Reasons:**" not in out


def test_wrong_arg_count_exits_one(tmp_path):
    r = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True)
    assert r.returncode == 1
    assert "Usage" in r.stderr


def test_end_to_end_compare_then_render(tmp_path):
    """compare-benchmarks output must feed render-benchmark-report without
    crashing — guards the delta-key contract between the two scripts."""
    compare = REPO_ROOT / "scripts" / "compare-benchmarks.sh"

    def _smry(task_pass_rate, policy_violations, median):
        return {
            "schema_version": "1.0", "mode": "cmd", "runner": "r",
            "generated_at": "x", "source_ref": "r", "source_sha": "s",
            "task_glob": "g",
            "totals": {"configured_tasks": 2, "executed_tasks": 2,
                       "policy_violations": policy_violations, "tool_failures": 0,
                       "recovered_tasks": 0, "summary_repaired": 0},
            "rates": {"task_pass_rate": task_pass_rate, "clean_pass_rate": task_pass_rate,
                      "completion_rate": 1.0, "verification_pass_rate": 1.0,
                      "review_compliance_rate": 1.0, "docs_compliance_rate": 1.0,
                      "execution_coverage_rate": 1.0, "recovered_task_rate": 0.0,
                      "summary_repair_rate": 0.0},
            "median_runtime_seconds": median, "tasks": [],
        }

    b = tmp_path / "b.json"
    c = tmp_path / "c.json"
    b.write_text(json.dumps(_smry(0.8, 1, 20.0)))
    c.write_text(json.dumps(_smry(0.9, 0, 10.0)))
    cmp_path = tmp_path / "cmp.json"
    cmp = subprocess.run(["bash", str(compare), str(b), str(c)],
                         capture_output=True, text=True)
    assert cmp.returncode == 0, cmp.stderr
    cmp_path.write_text(cmp.stdout)
    r = subprocess.run(["bash", str(SCRIPT), str(cmp_path)],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert "**Verdict:** `improved`" in r.stdout
    assert "| Clean pass rate |" in r.stdout
    assert "| Recovered task rate |" in r.stdout
    assert "| Summary repair rate |" in r.stdout
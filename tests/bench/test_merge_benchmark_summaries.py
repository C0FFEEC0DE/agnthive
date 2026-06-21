import importlib.util
import json
from pathlib import Path

import pytest


def load_merge_module():
    repo_root = Path(__file__).resolve().parents[2]
    module_path = repo_root / "scripts" / "merge-benchmark-summaries.py"
    spec = importlib.util.spec_from_file_location("merge_benchmark_summaries", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def make_task(
    task_id,
    status="passed",
    completed=True,
    recovered=False,
    summary_repaired_by="none",
    task_path=None,
    verification_required=False,
    tests_run=False,
    tests_passed=False,
    review_required=False,
    review_present=True,
    docs_required=False,
    docs_updated=True,
    policy_violations=0,
    tool_failures=0,
    runtime_seconds=10,
):
    return {
        "task_id": task_id,
        "status": status,
        "completed": completed,
        "task_path": task_path,
        "verification_required": verification_required,
        "tests_run": tests_run,
        "tests_passed": tests_passed,
        "review_required": review_required,
        "review_present": review_present,
        "docs_required": docs_required,
        "docs_updated": docs_updated,
        "policy_violations": policy_violations,
        "tool_failures": tool_failures,
        "runtime_seconds": runtime_seconds,
        "recovered_nonzero_exit": recovered,
        "timeout_recovered": False,
        "max_turns_recovered": False,
        "summary_repaired_by": summary_repaired_by,
    }


def make_summary(tasks, configured=1, executed=1):
    summary = {
        "schema_version": "1.0",
        "mode": "cmd",
        "runner": "r",
        "generated_at": "2026-01-01T00:00:00Z",
        "source_ref": "ref",
        "source_sha": "sha",
        "task_glob": "g",
        "totals": {"configured_tasks": configured, "executed_tasks": executed},
        "tasks": tasks,
    }
    return summary


def test_median_odd_count():
    module = load_merge_module()
    assert module.median([1, 3, 2]) == 2


def test_median_even_count():
    module = load_merge_module()
    assert module.median([1, 4, 2, 3]) == 2.5


def test_median_empty():
    module = load_merge_module()
    assert module.median([]) == 0


def test_median_single_value():
    module = load_merge_module()
    assert module.median([42]) == 42


def test_merge_summaries_passes_and_failures():
    module = load_merge_module()
    payloads = [
        make_summary(
            [
                make_task("task-a", status="passed"),
                make_task("task-b", status="failed"),
            ],
            configured=2,
            executed=2,
        )
    ]
    merged = module.merge_summaries(payloads)
    assert merged["totals"]["passed"] == 1
    assert merged["totals"]["executed_tasks"] == 2


def test_merge_summaries_clean_passed_excludes_recovered():
    module = load_merge_module()
    payloads = [
        make_summary(
            [
                make_task("clean-pass", recovered=False, summary_repaired_by="none"),
                make_task(
                    "recovered-task",
                    recovered=True,
                    summary_repaired_by="synthetic-footer",
                ),
            ],
            configured=2,
            executed=2,
        )
    ]
    merged = module.merge_summaries(payloads)
    assert merged["totals"]["passed"] == 2
    assert merged["totals"]["clean_passed"] == 1  # recovered task excluded
    assert merged["totals"]["recovered_tasks"] == 1
    assert merged["totals"]["summary_repaired"] == 1


def test_merge_summaries_multiple_shards_accumulate():
    module = load_merge_module()
    payloads = [
        make_summary([make_task("s1-a"), make_task("s1-b")], configured=2, executed=2),
        make_summary([make_task("s2-c")], configured=1, executed=1),
    ]
    merged = module.merge_summaries(payloads)
    assert merged["totals"]["configured_tasks"] == 3
    assert merged["totals"]["executed_tasks"] == 3
    assert len(merged["tasks"]) == 3


def test_merge_summaries_median_runtime():
    module = load_merge_module()
    payloads = [
        make_summary(
            [make_task("fast", runtime_seconds=5), make_task("slow", runtime_seconds=15)],
            configured=2,
            executed=2,
        )
    ]
    merged = module.merge_summaries(payloads)
    assert merged["median_runtime_seconds"] == 10.0


def test_merge_summaries_tool_failures_summed():
    module = load_merge_module()
    payloads = [
        make_summary(
            [make_task("a", tool_failures=2), make_task("b", tool_failures=3)],
            configured=2,
            executed=2,
        )
    ]
    merged = module.merge_summaries(payloads)
    assert merged["totals"]["tool_failures"] == 5


def test_merge_summaries_merges_resume_lists_and_totals():
    module = load_merge_module()
    payloads = [
        {
            **make_summary(
                [make_task("task-a", task_path="bench/tasks/smoke/task-a.json")],
                configured=2,
                executed=1,
            ),
            "selected_task_ids": ["task-a", "task-b"],
            "selected_task_paths": ["bench/tasks/smoke/task-a.json", "bench/tasks/smoke/task-b.json"],
            "executed_task_ids": ["task-a"],
            "executed_task_paths": ["bench/tasks/smoke/task-a.json"],
            "unexecuted_task_ids": ["task-b"],
            "unexecuted_task_paths": ["bench/tasks/smoke/task-b.json"],
            "unresolved_task_ids": ["task-b"],
            "unresolved_task_paths": ["bench/tasks/smoke/task-b.json"],
        },
        {
            **make_summary(
                [make_task("task-c", status="failed", task_path="bench/tasks/smoke/task-c.json")],
                configured=1,
                executed=1,
            ),
            "selected_task_ids": ["task-c"],
            "selected_task_paths": ["bench/tasks/smoke/task-c.json"],
            "executed_task_ids": ["task-c"],
            "executed_task_paths": ["bench/tasks/smoke/task-c.json"],
            "unexecuted_task_ids": [],
            "unexecuted_task_paths": [],
            "unresolved_task_ids": ["task-c"],
            "unresolved_task_paths": ["bench/tasks/smoke/task-c.json"],
        },
    ]

    merged = module.merge_summaries(payloads)

    assert merged["selected_task_ids"] == ["task-a", "task-b", "task-c"]
    assert merged["selected_task_paths"] == [
        "bench/tasks/smoke/task-a.json",
        "bench/tasks/smoke/task-b.json",
        "bench/tasks/smoke/task-c.json",
    ]
    assert merged["executed_task_ids"] == ["task-a", "task-c"]
    assert merged["unexecuted_task_ids"] == ["task-b"]
    assert merged["unresolved_task_ids"] == ["task-b", "task-c"]
    assert merged["totals"]["selected_tasks"] == 3
    assert merged["totals"]["executed_tasks"] == 2
    assert merged["totals"]["unexecuted_tasks"] == 1
    assert merged["totals"]["unresolved_tasks"] == 2


def test_merge_summaries_derives_resume_totals_without_explicit_lists():
    module = load_merge_module()
    payloads = [
        make_summary(
            [
                make_task("task-a", status="passed"),
                make_task("task-b", status="failed"),
            ],
            configured=3,
            executed=2,
        )
    ]

    merged = module.merge_summaries(payloads)

    assert merged["totals"]["selected_tasks"] == 3
    assert merged["totals"]["executed_tasks"] == 2
    assert merged["totals"]["unexecuted_tasks"] == 1
    assert merged["totals"]["unresolved_tasks"] == 2
    assert merged["unresolved_task_ids"] == ["task-b"]


def test_rate_function():
    module = load_merge_module()
    assert module.rate(1, 2) == 0.5
    assert module.rate(0, 0) == 0  # avoid divide-by-zero
    assert module.rate(3, 3) == 1.0


def test_count_preferred_uses_primary():
    module = load_merge_module()
    assert module.count_preferred(["a", "b"], ["c"]) == 2


def test_count_preferred_falls_back_to_secondary():
    module = load_merge_module()
    assert module.count_preferred([], ["c", "d"]) == 2


def test_count_preferred_falls_back_to_default():
    module = load_merge_module()
    assert module.count_preferred([], [], fallback=7) == 7


def test_normalize_string_list_rejects_non_list_and_non_strings():
    module = load_merge_module()
    assert module.normalize_string_list("nope") == []
    assert module.normalize_string_list(["ok", 3, "  ", "good"]) == ["ok", "good"]


def test_merge_string_lists_dedups_across_payloads():
    module = load_merge_module()
    payloads = [
        {"ids": ["a", "b"]},
        {"ids": ["b", "c"]},
        {"ids": "not-a-list"},
    ]
    assert module.merge_string_lists(payloads, "ids") == ["a", "b", "c"]


def test_task_ids_filters_non_string_ids():
    module = load_merge_module()
    tasks = [{"task_id": "x"}, {"task_id": 5}, {"other": 1}]
    assert module.task_ids(tasks) == ["x"]


def test_task_paths_collects_path_aliases_and_strips():
    module = load_merge_module()
    tasks = [
        {"task_path": "  a.json  "},
        {"task_file": "b.json"},
        {"path": "c.json"},
        {"path": "   "},
        {"nope": 1},
    ]
    assert module.task_paths(tasks) == ["a.json", "b.json", "c.json"]


def test_merge_unique_dedups():
    module = load_merge_module()
    assert module.merge_unique(["a", "b"], ["b", "c"]) == ["a", "b", "c"]


def test_merge_summaries_empty_raises():
    module = load_merge_module()
    with pytest.raises(ValueError, match="at least one summary is required"):
        module.merge_summaries([])


def test_merge_summaries_derives_executed_paths_from_tasks_when_missing():
    module = load_merge_module()
    payloads = [
        make_summary(
            [make_task("task-a", status="failed", task_path="bench/tasks/smoke/task-a.json")],
            configured=1,
            executed=1,
        )
    ]
    merged = module.merge_summaries(payloads)
    # No explicit executed/unresolved path lists -> derived from tasks.
    assert merged["executed_task_paths"] == ["bench/tasks/smoke/task-a.json"]
    assert merged["unresolved_task_paths"] == ["bench/tasks/smoke/task-a.json"]
    assert merged["unresolved_task_ids"] == ["task-a"]


def test_parse_args(monkeypatch, tmp_path):
    module = load_merge_module()
    monkeypatch.setattr(
        "sys.argv",
        ["merge-benchmark-summaries.py", "--output", str(tmp_path / "out.json"), "a.json", "b.json"],
    )
    args = module.parse_args()
    assert args.output == str(tmp_path / "out.json")
    assert args.summary_files == ["a.json", "b.json"]


def test_main_writes_merged_summary(monkeypatch, tmp_path):
    module = load_merge_module()
    a = tmp_path / "a.json"
    b = tmp_path / "b.json"
    out = tmp_path / "merged.json"
    a.write_text(json.dumps(make_summary([make_task("task-a")], configured=1, executed=1)), encoding="utf-8")
    b.write_text(json.dumps(make_summary([make_task("task-b")], configured=1, executed=1)), encoding="utf-8")
    monkeypatch.setattr(
        "sys.argv",
        ["merge-benchmark-summaries.py", "--output", str(out), str(a), str(b)],
    )
    module.main()
    merged = json.loads(out.read_text(encoding="utf-8"))
    assert merged["totals"]["configured_tasks"] == 2
    assert {t["task_id"] for t in merged["tasks"]} == {"task-a", "task-b"}

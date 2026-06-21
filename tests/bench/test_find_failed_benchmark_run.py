"""Tests for scripts/find-failed-benchmark-run.py.

The script is a CLI that shells out to `gh` and `git`. The testable core is
find_failed_run (run filtering by age/status/conclusion) and run_gh (JSON
parsing + failure handling). We load the module via importlib (hyphenated
filename) and monkeypatch run_gh / subprocess.run / sys.argv so no real gh or
git invocation happens.
"""

import importlib.util
import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


def load_module():
    repo_root = Path(__file__).resolve().parents[2]
    module_path = repo_root / "scripts" / "find-failed-benchmark-run.py"
    spec = importlib.util.spec_from_file_location("find_failed_benchmark_run", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- run_gh ----

class TestRunGh:
    def test_parses_json_stdout(self, monkeypatch):
        module = load_module()
        monkeypatch.setattr(
            module.subprocess, "run",
            lambda cmd, **k: subprocess.CompletedProcess(cmd, 0, '{"ok": 1}', ""),
        )
        assert module.run_gh(["run", "list"]) == {"ok": 1}

    def test_returns_none_on_failure_when_not_checking(self, monkeypatch):
        module = load_module()
        monkeypatch.setattr(
            module.subprocess, "run",
            lambda cmd, **k: subprocess.CompletedProcess(cmd, 1, "", "boom"),
        )
        assert module.run_gh(["x"], check=False) is None

    def test_exits_on_failure_when_checking(self, monkeypatch):
        module = load_module()
        monkeypatch.setattr(
            module.subprocess, "run",
            lambda cmd, **k: subprocess.CompletedProcess(cmd, 1, "", "boom"),
        )
        with pytest.raises(SystemExit):
            module.run_gh(["x"])


# ---- find_failed_run ----

class TestFindFailedRun:
    def test_returns_recent_failed_run(self, monkeypatch):
        module = load_module()
        recent = _iso(datetime.now(timezone.utc) - timedelta(hours=1))
        runs = [
            {"databaseId": 7, "status": "completed", "conclusion": "failure",
             "createdAt": recent, "headBranch": "main", "displayTitle": "t"},
        ]
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: runs)
        got = module.find_failed_run("wf", None, 72, "failed", None)
        assert got is not None
        assert got["databaseId"] == 7

    def test_returns_none_when_no_runs(self, monkeypatch):
        module = load_module()
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: None)
        assert module.find_failed_run("wf", None, 72, "failed", None) is None

    def test_returns_none_when_runs_empty(self, monkeypatch):
        module = load_module()
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: [])
        assert module.find_failed_run("wf", None, 72, "failed", None) is None

    def test_skips_runs_older_than_cutoff(self, monkeypatch):
        module = load_module()
        old = _iso(datetime.now(timezone.utc) - timedelta(hours=100))
        runs = [
            {"databaseId": 1, "status": "completed", "conclusion": "failure",
             "createdAt": old, "headBranch": "main", "displayTitle": "t"},
        ]
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: runs)
        # max_age_hours=72 -> the 100h-old run is filtered out
        assert module.find_failed_run("wf", None, 72, "failed", None) is None

    def test_skips_non_completed_runs(self, monkeypatch):
        module = load_module()
        recent = _iso(datetime.now(timezone.utc) - timedelta(hours=1))
        runs = [
            {"databaseId": 2, "status": "in_progress", "conclusion": None,
             "createdAt": recent, "headBranch": "main", "displayTitle": "t"},
        ]
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: runs)
        assert module.find_failed_run("wf", None, 72, "failed", None) is None

    def test_skips_run_with_no_created_at(self, monkeypatch):
        module = load_module()
        runs = [
            {"databaseId": 3, "status": "completed", "conclusion": "failure",
             "createdAt": "", "headBranch": "main", "displayTitle": "t"},
        ]
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: runs)
        assert module.find_failed_run("wf", None, 72, "failed", None) is None

    def test_skips_run_with_unparseable_created_at(self, monkeypatch):
        module = load_module()
        runs = [
            {"databaseId": 4, "status": "completed", "conclusion": "failure",
             "createdAt": "not-a-date", "headBranch": "main", "displayTitle": "t"},
        ]
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: runs)
        assert module.find_failed_run("wf", None, 72, "failed", None) is None

    def test_unresolved_status_matches_failure(self, monkeypatch):
        module = load_module()
        recent = _iso(datetime.now(timezone.utc) - timedelta(hours=1))
        runs = [
            {"databaseId": 5, "status": "completed", "conclusion": "failure",
             "createdAt": recent, "headBranch": "main", "displayTitle": "t"},
        ]
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: runs)
        got = module.find_failed_run("wf", None, 72, "unresolved", None)
        assert got is not None and got["databaseId"] == 5

    def test_skips_successful_run(self, monkeypatch):
        module = load_module()
        recent = _iso(datetime.now(timezone.utc) - timedelta(hours=1))
        runs = [
            {"databaseId": 6, "status": "completed", "conclusion": "success",
             "createdAt": recent, "headBranch": "main", "displayTitle": "t"},
        ]
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: runs)
        assert module.find_failed_run("wf", None, 72, "failed", None) is None

    def test_unresolved_status_skips_non_failure_conclusion(self, monkeypatch):
        module = load_module()
        recent = _iso(datetime.now(timezone.utc) - timedelta(hours=1))
        runs = [
            {"databaseId": 7, "status": "completed", "conclusion": "success",
             "createdAt": recent, "headBranch": "main", "displayTitle": "t"},
        ]
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: runs)
        # status="unresolved" but the only run concluded "success" -> no match.
        assert module.find_failed_run("wf", None, 72, "unresolved", None) is None

    def test_unknown_status_never_matches(self, monkeypatch):
        module = load_module()
        recent = _iso(datetime.now(timezone.utc) - timedelta(hours=1))
        runs = [
            {"databaseId": 8, "status": "completed", "conclusion": "failure",
             "createdAt": recent, "headBranch": "main", "displayTitle": "t"},
        ]
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: runs)
        # status is neither "failed" nor "unresolved" -> both branches False -> no match.
        assert module.find_failed_run("wf", None, 72, "other", None) is None

    def test_passes_branch_and_repo_to_gh(self, monkeypatch):
        module = load_module()
        captured = {}
        recent = _iso(datetime.now(timezone.utc) - timedelta(hours=1))

        def fake_run_gh(args, check=True):
            captured["args"] = list(args)
            return [{"databaseId": 8, "status": "completed", "conclusion": "failure",
                     "createdAt": recent, "headBranch": "feat", "displayTitle": "t"}]

        monkeypatch.setattr(module, "run_gh", fake_run_gh)
        module.find_failed_run("wf", "feat", 72, "failed", "owner/repo")
        assert "--branch" in captured["args"] and "feat" in captured["args"]
        assert "--repo" in captured["args"] and "owner/repo" in captured["args"]


# ---- main ----

class TestMain:
    def _patch_argv(self, monkeypatch, *extra):
        monkeypatch.setattr("sys.argv", ["find-failed-benchmark-run.py", *extra])

    def test_main_prints_found_json(self, monkeypatch, capsys):
        module = load_module()
        self._patch_argv(monkeypatch, "--workflow", "wf")
        recent = _iso(datetime.now(timezone.utc) - timedelta(hours=1))
        monkeypatch.setattr(
            module.subprocess, "run",
            lambda cmd, **k: subprocess.CompletedProcess(
                cmd, 0, "trunk\n", "" if "rev-parse" not in " ".join(cmd) else "",
            ),
        )
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: [
            {"databaseId": 42, "status": "completed", "conclusion": "failure",
             "createdAt": recent, "headBranch": "trunk", "displayTitle": "t"},
        ])
        module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["found"] is True
        assert out["run_id"] == "42"

    def test_main_rev_parse_fallbacks_to_none_branch(self, monkeypatch, capsys):
        module = load_module()
        self._patch_argv(monkeypatch, "--workflow", "wf")  # no --branch
        # git rev-parse fails -> branch stays None -> find_failed_run called anyway.
        captured = {"branch": "sentinel"}

        def fake_find_failed_run(*a, **k):
            captured["branch"] = k.get("branch")
            return None

        monkeypatch.setattr(
            module.subprocess, "run",
            lambda cmd, **k: subprocess.CompletedProcess(cmd, 1, "", "err"),
        )
        monkeypatch.setattr(module, "find_failed_run", fake_find_failed_run)
        module.main()
        assert captured["branch"] is None
        out = json.loads(capsys.readouterr().out)
        assert out["found"] is False

    def test_main_prints_not_found_json(self, monkeypatch, capsys):
        module = load_module()
        self._patch_argv(monkeypatch, "--workflow", "wf", "--branch", "main")
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: [])
        module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["found"] is False
        assert out["run_id"] == ""

    def test_main_writes_github_output_file(self, monkeypatch, tmp_path):
        module = load_module()
        out_file = tmp_path / "out.txt"
        self._patch_argv(monkeypatch, "--workflow", "wf", "--branch", "main",
                         "--output-file", str(out_file))
        recent = _iso(datetime.now(timezone.utc) - timedelta(hours=1))
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: [
            {"databaseId": 99, "status": "completed", "conclusion": "failure",
             "createdAt": recent, "headBranch": "main", "displayTitle": "title"},
        ])
        module.main()
        text = out_file.read_text(encoding="utf-8")
        assert "found=true" in text and "run_id=99" in text and "display_title=title" in text

    def test_main_writes_found_false_to_output_file(self, monkeypatch, tmp_path):
        module = load_module()
        out_file = tmp_path / "out.txt"
        self._patch_argv(monkeypatch, "--workflow", "wf", "--branch", "main",
                         "--output-file", str(out_file))
        monkeypatch.setattr(module, "run_gh", lambda args, check=True: [])
        module.main()
        assert "found=false" in out_file.read_text(encoding="utf-8")
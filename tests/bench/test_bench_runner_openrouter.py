"""Tests for scripts/bench_runner_openrouter.py.

The module reads benchmark env vars at import time, so the fixture sets them
before loading. Network and subprocess boundaries are monkeypatched. The
highest-value targets are the apply_files path-escape guards (security),
is_docs_path, extract_json, call_openrouter (mocked urllib), and main's
status logic across the four failure conditions.
"""

import importlib.util
import json
import pathlib
import subprocess
import urllib.error
from io import BytesIO
from pathlib import Path

import pytest


def _load_module(monkeypatch, tmp_path):
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    output_dir = tmp_path / "output"
    task_file = tmp_path / "task.json"

    monkeypatch.setenv("BENCH_REPO_ROOT", str(repo_root))
    monkeypatch.setenv("BENCH_TASK_FILE", str(task_file))
    monkeypatch.setenv("BENCH_WORKDIR", str(workdir))
    monkeypatch.setenv("BENCH_OUTPUT_DIR", str(output_dir))
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

    module_path = Path(__file__).resolve().parents[2] / "scripts" / "bench_runner_openrouter.py"
    spec = importlib.util.spec_from_file_location("bench_runner_openrouter", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module, repo_root, workdir, output_dir, task_file


# ---- env_or_default ----

def test_env_or_default_uses_env(monkeypatch, tmp_path):
    module, *_ = _load_module(monkeypatch, tmp_path)
    monkeypatch.setenv("X_CUSTOM", "hello")
    assert module.env_or_default("X_CUSTOM", "def") == "hello"


def test_env_or_default_uses_default_when_empty(monkeypatch, tmp_path):
    module, *_ = _load_module(monkeypatch, tmp_path)
    monkeypatch.setenv("X_CUSTOM", "   ")
    assert module.env_or_default("X_CUSTOM", "def") == "def"


# ---- is_docs_path ----

class TestIsDocsPath:
    def test_md_extension(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        assert module.is_docs_path("guide.md") is True
        assert module.is_docs_path("README.mdx") is True

    def test_docs_dir(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        assert module.is_docs_path("src/docs/intro.md") is True

    def test_readme_and_changelog_names(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        assert module.is_docs_path("readme.txt") is True
        assert module.is_docs_path("CHANGELOG") is True

    def test_claude_md(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        assert module.is_docs_path("claude.md") is True

    def test_non_docs(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        assert module.is_docs_path("src/app.py") is False


# ---- extract_json ----

class TestExtractJson:
    def test_plain_json(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        assert module.extract_json('{"a": 1}') == {"a": 1}

    def test_json_embedded_in_text(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        text = 'Here is the result:\n{"summary": "ok", "x": 2}\nThanks.'
        assert module.extract_json(text) == {"summary": "ok", "x": 2}

    def test_no_json_raises(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        with pytest.raises(json.JSONDecodeError):
            module.extract_json("no json here at all")


# ---- build_prompt ----

def test_build_prompt_structure(monkeypatch, tmp_path):
    module, *_ = _load_module(monkeypatch, tmp_path)
    task = {"id": "t1", "verification_required": True}
    msgs = module.build_prompt(task, [{"path": "a.py", "content": "x"}], "claude", "guide")
    assert msgs[0]["role"] == "system"
    assert "JSON only" in msgs[0]["content"]
    assert msgs[1]["role"] == "user"
    assert "Benchmark task:" in msgs[1]["content"]
    assert '"id": "t1"' in msgs[1]["content"]


# ---- apply_files (path-escape guards) ----

class TestApplyFiles:
    def test_writes_file(self, monkeypatch, tmp_path):
        module, _, workdir, *_ = _load_module(monkeypatch, tmp_path)
        module.apply_files([{"path": "sub/a.py", "content": "print(1)"}])
        assert (workdir / "sub" / "a.py").read_text(encoding="utf-8") == "print(1)"

    def test_rejects_absolute_path(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        with pytest.raises(RuntimeError, match="Unsafe output path"):
            module.apply_files([{"path": "/etc/passwd", "content": "x"}])

    def test_rejects_parent_traversal(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        with pytest.raises(RuntimeError, match="Unsafe output path"):
            module.apply_files([{"path": "../escape.py", "content": "x"}])

    def test_rejects_resolved_path_outside_workdir_via_symlink(self, monkeypatch, tmp_path):
        # The module resolves WORKDIR at import time, so to exercise the
        # post-resolve escape guard we point the module's WORKDIR at an
        # unresolved symlink. The resolved target then lands in the real
        # directory whose string does not start with the symlink path.
        module, *_ = _load_module(monkeypatch, tmp_path)
        real = tmp_path / "real_workdir"
        real.mkdir()
        link = tmp_path / "link_workdir"
        link.symlink_to(real, target_is_directory=True)
        module.WORKDIR = link  # unresolved symlink path
        with pytest.raises(RuntimeError, match="Path escaped workdir"):
            module.apply_files([{"path": "a.py", "content": "x"}])


# ---- snapshot_file ----

class TestSnapshotFile:
    def test_text(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        p = tmp_path / "f.txt"
        p.write_text("hello", encoding="utf-8")
        snap = module.snapshot_file(p)
        assert snap["kind"] == "text"
        assert snap["text"] == "hello"
        assert len(snap["sha256"]) == 64

    def test_binary(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        p = tmp_path / "f.bin"
        p.write_bytes(b"\xff\xfe\x00")
        snap = module.snapshot_file(p)
        assert snap["kind"] == "binary"
        assert "text" not in snap
        assert snap["size"] == 3


def test_snapshot_files_skips_directories(monkeypatch, tmp_path):
    module, _, workdir, *_ = _load_module(monkeypatch, tmp_path)
    (workdir / "a.py").write_text("a", encoding="utf-8")
    (workdir / "sub").mkdir()  # directory entry -> is_file() False -> skipped
    (workdir / "sub" / "b.py").write_text("b", encoding="utf-8")
    snap = module.snapshot_files(workdir)
    assert set(snap.keys()) == {"a.py", "sub/b.py"}


# ---- collect_fixture_files / read_text_if_exists ----

def test_collect_fixture_files(monkeypatch, tmp_path):
    module, _, workdir, *_ = _load_module(monkeypatch, tmp_path)
    (workdir / "a.py").write_text("a", encoding="utf-8")
    (workdir / "d").mkdir()
    (workdir / "d" / "b.py").write_text("b", encoding="utf-8")
    files = module.collect_fixture_files(workdir)
    paths = [f["path"] for f in files]
    assert paths == ["a.py", "d/b.py"]
    assert all("content" in f for f in files)


def test_read_text_if_exists_missing(monkeypatch, tmp_path):
    module, *_ = _load_module(monkeypatch, tmp_path)
    assert module.read_text_if_exists(pathlib.Path("/no/such/path")) == ""


# ---- call_openrouter (mocked urllib) ----

class TestCallOpenRouter:
    def _fake_urlopen(self, body_obj):
        body = json.dumps(body_obj).encode("utf-8")

        class _Resp:
            def __init__(self, b):
                self._b = b

            def read(self):
                return self._b

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        return lambda req, timeout=180: _Resp(body)

    def test_string_content(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        monkeypatch.setattr(
            module.urllib.request, "urlopen",
            self._fake_urlopen({"choices": [{"message": {"content": "raw"}}]}),
        )
        assert module.call_openrouter([]) == "raw"

    def test_list_content(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)
        body = {"choices": [{"message": {"content": [
            {"type": "text", "text": "alpha "},
            {"type": "image", "text": "ignore"},
            {"type": "text", "text": "beta"},
        ]}}]}
        monkeypatch.setattr(module.urllib.request, "urlopen", self._fake_urlopen(body))
        assert module.call_openrouter([]) == "alpha beta"

    def test_http_error_raises_runtime(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)

        def _raise(req, timeout=180):
            raise urllib.error.HTTPError("url", 429, "rate", {}, BytesIO(b"rate-limited"))

        monkeypatch.setattr(module.urllib.request, "urlopen", _raise)
        with pytest.raises(RuntimeError, match="HTTP error 429"):
            module.call_openrouter([])

    def test_url_error_raises_runtime(self, monkeypatch, tmp_path):
        module, *_ = _load_module(monkeypatch, tmp_path)

        def _raise(req, timeout=180):
            raise urllib.error.URLError("conn refused")

        monkeypatch.setattr(module.urllib.request, "urlopen", _raise)
        with pytest.raises(RuntimeError, match="request failed"):
            module.call_openrouter([])


# ---- main (status logic) ----

class TestMain:
    def _write_task(self, task_file, **overrides):
        task = {"id": "t1", "verification_required": False,
                "review_required": False, "docs_required": False}
        task.update(overrides)
        task_file.write_text(json.dumps(task), encoding="utf-8")

    def _mock_openrouter(self, module, monkeypatch, files, review_status="approved",
                         verification_notes=""):
        def _fake(messages):
            return json.dumps({
                "summary": "s", "review_status": review_status,
                "verification_notes": verification_notes,
                "files": files, "notes": "n",
            })
        monkeypatch.setattr(module, "call_openrouter", _fake)

    def test_passed_no_requirements(self, monkeypatch, tmp_path):
        module, repo_root, workdir, output_dir, task_file = _load_module(monkeypatch, tmp_path)
        (repo_root / "CLAUDE.md").write_text("c", encoding="utf-8")
        (workdir / "test_x.py").write_text("def test_x(): assert True", encoding="utf-8")
        self._write_task(task_file)
        self._mock_openrouter(module, monkeypatch, [{"path": "a.py", "content": "x"}])
        assert module.main() == 0
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "passed"
        assert result["completed"] is True

    def test_failed_when_no_files_changed(self, monkeypatch, tmp_path):
        module, repo_root, workdir, output_dir, task_file = _load_module(monkeypatch, tmp_path)
        (repo_root / "CLAUDE.md").write_text("c", encoding="utf-8")
        self._write_task(task_file)
        self._mock_openrouter(module, monkeypatch, [])
        module.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "failed"
        assert result["completed"] is False

    def test_failed_when_verification_required_and_tests_fail(self, monkeypatch, tmp_path):
        module, repo_root, workdir, output_dir, task_file = _load_module(monkeypatch, tmp_path)
        (repo_root / "CLAUDE.md").write_text("c", encoding="utf-8")
        (workdir / "test_x.py").write_text("def test_x(): assert True", encoding="utf-8")
        self._write_task(task_file, verification_required=True)
        self._mock_openrouter(module, monkeypatch, [{"path": "a.py", "content": "x"}])
        monkeypatch.setattr(module, "run_verification", lambda: (False, "1 failed"))
        module.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "failed"
        assert result["tests_run"] is True
        assert result["tests_passed"] is False

    def test_failed_when_review_required_and_missing(self, monkeypatch, tmp_path):
        module, repo_root, workdir, output_dir, task_file = _load_module(monkeypatch, tmp_path)
        (repo_root / "CLAUDE.md").write_text("c", encoding="utf-8")
        self._write_task(task_file, review_required=True)
        self._mock_openrouter(module, monkeypatch,
                              [{"path": "a.py", "content": "x"}], review_status="")
        module.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "failed"
        assert result["review_present"] is False

    def test_failed_when_docs_required_and_not_updated(self, monkeypatch, tmp_path):
        module, repo_root, workdir, output_dir, task_file = _load_module(monkeypatch, tmp_path)
        (repo_root / "CLAUDE.md").write_text("c", encoding="utf-8")
        self._write_task(task_file, docs_required=True)
        # changed file is a .py, not docs -> docs_updated False
        self._mock_openrouter(module, monkeypatch, [{"path": "a.py", "content": "x"}])
        module.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "failed"
        assert result["docs_updated"] is False

    def test_passed_when_docs_required_and_docs_updated(self, monkeypatch, tmp_path):
        module, repo_root, workdir, output_dir, task_file = _load_module(monkeypatch, tmp_path)
        (repo_root / "CLAUDE.md").write_text("c", encoding="utf-8")
        self._write_task(task_file, docs_required=True)
        self._mock_openrouter(module, monkeypatch, [{"path": "guide.md", "content": "x"}])
        module.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "passed"
        assert result["docs_updated"] is True


# ---- run_verification ----

class TestRunVerification:
    def test_no_tests_returns_false(self, monkeypatch, tmp_path):
        module, _, workdir, *_ = _load_module(monkeypatch, tmp_path)
        ok, msg = module.run_verification()
        assert ok is False
        assert "No Python test files" in msg

    def test_runs_pytest(self, monkeypatch, tmp_path):
        module, _, workdir, *_ = _load_module(monkeypatch, tmp_path)
        (workdir / "test_x.py").write_text("def test_x(): assert True", encoding="utf-8")
        monkeypatch.setattr(
            module.subprocess, "run",
            lambda cmd, **k: subprocess.CompletedProcess(cmd, 0, "1 passed", ""),
        )
        ok, msg = module.run_verification()
        assert ok is True
        assert "1 passed" in msg
"""Comprehensive tests for scripts/bench_runner_claude_code.py.

The module reads benchmark env vars at import time (BENCH_REPO_ROOT,
BENCH_TASK_FILE, BENCH_WORKDIR, BENCH_OUTPUT_DIR, OLLAMA_MODEL) and builds
agent-label maps from claudecfg/agents/*.md. The fixture sets a dummy repo root
seeded with two agent markdown files (one with an alias, one without) so
build_agent_label_map and frontmatter_field are exercised, then loads the module
via importlib. Network/subprocess boundaries (run_claude, run_verification,
time.sleep) are monkeypatched.
"""

import importlib.util
import json
import os
import pathlib
import subprocess

import pytest


def _seed_repo(repo_root: pathlib.Path) -> None:
    agents = repo_root / "claudecfg" / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    (agents / "tester.md").write_text(
        "---\nname: Tester\nalias: t\ntype: tester\n---\nbody\n", encoding="utf-8"
    )
    # No alias -> exercises the `if not alias: continue` branch.
    (agents / "noalias.md").write_text(
        "---\nname: NoAlias\n---\nbody\n", encoding="utf-8"
    )
    # Alias present but name/type absent -> frontmatter_field returns None,
    # exercising the `if not candidate: continue` branch in build_agent_label_map.
    (agents / "partial.md").write_text(
        "---\nalias: p\n---\nbody\n", encoding="utf-8"
    )


@pytest.fixture(scope="module")
def module(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("bench_runner")
    repo_root = tmp / "repo"
    repo_root.mkdir()
    _seed_repo(repo_root)
    workdir = tmp / "workdir"
    workdir.mkdir()
    output_dir = tmp / "output"
    output_dir.mkdir()
    task_file = tmp / "task.json"

    env = {
        "BENCH_REPO_ROOT": str(repo_root),
        "BENCH_TASK_FILE": str(task_file),
        "BENCH_WORKDIR": str(workdir),
        "BENCH_OUTPUT_DIR": str(output_dir),
        "OLLAMA_MODEL": "test-model",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "768",
        "HOME": str(tmp / "home"),
    }
    # Preserve PATH so subprocess in run_verification can find executables.
    if "PATH" in os.environ:
        env["PATH"] = os.environ["PATH"]
    old_env = {}
    for k, v in env.items():
        old_env[k] = os.environ.get(k)
        os.environ[k] = v
    (tmp / "home").mkdir()

    module_path = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "bench_runner_claude_code.py"
    spec = importlib.util.spec_from_file_location("bench_runner_claude_code", module_path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)

    yield mod, repo_root, workdir, output_dir, task_file

    for k, v in old_env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


# ---- normalize_subagent_key / canonicalize / normalize_required_used_agent ----

class TestNormalize:
    def test_normalize_subagent_key(self, module):
        m, *_ = module
        assert m.normalize_subagent_key("@Code Reviewer") == "code-reviewer"
        assert m.normalize_subagent_key("  Big_Boss  ") == "big-boss"
        # Only hyphens are collapsed, not dots.
        assert m.normalize_subagent_key("a..b--c") == "a..b-c"

    def test_canonicalize_known_and_unknown(self, module):
        m, *_ = module
        assert m.canonicalize_subagent_label("Code Reviewer") == "cr"
        assert m.canonicalize_subagent_label("tester") == "t"
        assert m.canonicalize_subagent_label("totally-unknown-agent") is None
        assert m.canonicalize_subagent_label("") is None

    def test_normalize_required_used_agent(self, module):
        m, *_ = module
        assert m.normalize_required_used_agent("Code Reviewer") == "cr"
        assert m.normalize_required_used_agent("") is None
        assert m.normalize_required_used_agent(5) is None
        # Unknown label falls back to the normalized key.
        assert m.normalize_required_used_agent("some-new-role") == "some-new-role"


# ---- frontmatter_field / build_agent_label_map ----

def test_frontmatter_field(module, tmp_path):
    m, *_ = module
    p = tmp_path / "x.md"
    p.write_text("---\nname: Foo\nalias: f\n---\nbody", encoding="utf-8")
    assert m.frontmatter_field(p, "alias") == "f"
    p2 = tmp_path / "y.md"
    p2.write_text("no frontmatter", encoding="utf-8")
    assert m.frontmatter_field(p2, "alias") is None
    p3 = tmp_path / "z.md"
    p3.write_text("---\nname: Foo\n---\n", encoding="utf-8")
    assert m.frontmatter_field(p3, "alias") is None


def test_build_agent_label_map(module):
    m, repo_root, *_ = module
    mapping = m.build_agent_label_map()
    # The seeded tester.md maps several candidate labels to alias "t".
    assert mapping.get("t") == "t"
    assert mapping.get("tester") == "t"


def test_build_agent_label_map_skips_empty_normalized_candidate(module, monkeypatch, tmp_path):
    m, *_ = module
    agents = tmp_path / "claudecfg" / "agents"
    agents.mkdir(parents=True)
    # alias present; name is all hyphens -> normalize_subagent_key returns "" ->
    # the `if normalized` guard is False and that candidate is skipped (147->143).
    (agents / "odd.md").write_text(
        "---\nalias: o\nname: ---\ntype: ---\n---\nbody\n", encoding="utf-8")
    monkeypatch.setattr(m, "REPO_ROOT", tmp_path)
    mapping = m.build_agent_label_map()
    assert mapping.get("o") == "o"          # alias candidate still maps
    assert mapping.get("---") is None       # empty-normalized candidate dropped
    assert mapping.get("odd") == "o"        # stem candidate maps


# ---- is_docs_path / is_ignored_runtime_path ----

class TestPathPredicates:
    def test_is_docs_path(self, module):
        m, *_ = module
        assert m.is_docs_path("guide.md") is True
        assert m.is_docs_path("src/docs/intro.txt") is True
        assert m.is_docs_path("README") is True
        assert m.is_docs_path("CHANGELOG.md") is True
        assert m.is_docs_path("claude.md") is True
        assert m.is_docs_path("src/app.py") is False

    def test_is_ignored_runtime_path(self, module):
        m, *_ = module
        assert m.is_ignored_runtime_path(pathlib.Path("a/__pycache__/x.pyc")) is True
        assert m.is_ignored_runtime_path(pathlib.Path("a/.coverage")) is True
        assert m.is_ignored_runtime_path(pathlib.Path("a/b.py")) is False


# ---- snapshot_file / snapshot_files / build_patch ----

class TestSnapshot:
    def test_snapshot_text_and_binary(self, module, tmp_path):
        m, *_ = module
        t = tmp_path / "f.txt"
        t.write_text("hello", encoding="utf-8")
        snap = m.snapshot_file(t)
        assert snap["kind"] == "text" and snap["text"] == "hello" and len(snap["sha256"]) == 64
        b = tmp_path / "f.bin"
        b.write_bytes(b"\xff\xfe")
        snap2 = m.snapshot_file(b)
        assert snap2["kind"] == "binary" and "text" not in snap2

    def test_snapshot_files_ignores_caches(self, module, tmp_path):
        m, *_ = module
        (tmp_path / "a.py").write_text("a", encoding="utf-8")
        (tmp_path / "__pycache__").mkdir()
        (tmp_path / "__pycache__" / "x.pyc").write_text("x", encoding="utf-8")
        snap = m.snapshot_files(tmp_path)
        assert "a.py" in snap and "__pycache__/x.pyc" not in snap

    def test_build_patch_text_and_binary(self, module):
        m, *_ = module
        before = {"a.py": {"kind": "text", "text": "x\n", "sha256": "h", "size": 2}}
        after = {"a.py": {"kind": "text", "text": "x\ny\n", "sha256": "h2", "size": 4}}
        patch = m.build_patch(before, after)
        assert "--- a/a.py" in patch and "+y" in patch
        # binary diff
        before_b = {"b.bin": {"kind": "binary", "sha256": "h", "size": 1}}
        after_b = {"b.bin": {"kind": "binary", "sha256": "h2", "size": 2}}
        assert "Binary files differ: b.bin" in m.build_patch(before_b, after_b)
        # added file
        assert "--- a/new.py" in m.build_patch({}, {"new.py": {"kind": "text", "text": "n\n", "sha256": "h", "size": 2}})
        # unchanged -> empty patch
        same = {"a.py": {"kind": "text", "text": "x\n", "sha256": "h", "size": 2}}
        assert m.build_patch(same, same) == ""


# ---- build_prompt ----

def test_build_prompt(module):
    m, *_ = module
    task = {"id": "t1", "category": "feature", "review_required": True,
            "docs_required": False, "verification_required": True,
            "prompt": "do thing", "success_criteria": ["it works"],
            "must_not": ["no deploy"], "required_used_agents": ["m", "cr"]}
    prompt = m.build_prompt(task, "pytest -q")
    assert "Verification status:" in prompt
    assert "Required specialist handoff:" in prompt
    assert "@m" in prompt and "@cr" in prompt
    assert "in this order: @m -> @cr" in prompt
    # manager-led sequence note
    assert "launch @m first" in prompt


def test_build_prompt_single_required_agent(module):
    m, *_ = module
    task = {"id": "t2", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False,
            "prompt": "p", "success_criteria": [], "must_not": [],
            "required_used_agents": ["doc"]}
    prompt = m.build_prompt(task, "verification")
    assert "single required specialist" in prompt
    assert "@doc first" in prompt


def test_build_prompt_multi_agent_non_manager_first(module):
    m, *_ = module
    task = {"id": "t4", "category": "feature", "review_required": True,
            "docs_required": False, "verification_required": False,
            "prompt": "p", "success_criteria": [], "must_not": [],
            "required_used_agents": ["doc", "cr"]}
    prompt = m.build_prompt(task, "verification")
    assert "in this order: @doc -> @cr" in prompt
    # First required agent is not @m -> no manager-led sequence note.
    assert "launch @m first" not in prompt
    # @cr is the final required role -> completion-discipline note present.
    assert "reserve time for it" in prompt


def test_build_prompt_no_required_agents(module):
    m, *_ = module
    task = {"id": "t3", "category": "review", "review_required": True,
            "docs_required": False, "verification_required": False,
            "prompt": "p", "success_criteria": [], "must_not": []}
    prompt = m.build_prompt(task, "verification")
    assert "Required specialist handoff:" not in prompt


# ---- _is_ollama_429 ----

class TestOllama429:
    def test_empty(self, module):
        m, *_ = module
        assert m._is_ollama_429("") is False

    def test_429(self, module):
        m, *_ = module
        assert m._is_ollama_429("error 429 too many") is True

    def test_rate_limit(self, module):
        m, *_ = module
        assert m._is_ollama_429("rate limit exceeded") is True

    def test_unrelated(self, module):
        m, *_ = module
        assert m._is_ollama_429("some other error") is False


# ---- run_claude (mocked subprocess + sleep) ----

def test_run_claude_success(module, monkeypatch, tmp_path):
    m, *_, output_dir = module
    monkeypatch.setattr(m.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(
        ["claude"], 0, '{"result":"ok"}', ""))
    rc, out, err = m.run_claude("prompt", tmp_path / "dbg.log", tmp_path / "err.log")
    assert rc == 0 and out == '{"result":"ok"}'


def test_run_claude_429_retry_then_success(module, monkeypatch, tmp_path):
    m, *_, output_dir = module
    slept = []
    monkeypatch.setattr(m.time, "sleep", lambda s: slept.append(s))
    calls = {"n": 0}

    def fake_run(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            return subprocess.CompletedProcess(["claude"], 1, "", "error 429 rate limit")
        return subprocess.CompletedProcess(["claude"], 0, '{"result":"ok"}', "")

    monkeypatch.setattr(m.subprocess, "run", fake_run)
    rc, out, err = m.run_claude("p", tmp_path / "dbg.log", tmp_path / "err.log")
    assert rc == 0 and calls["n"] == 2 and len(slept) == 1


def test_run_claude_429_exhausts_retries(module, monkeypatch, tmp_path):
    m, *_ = module
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    monkeypatch.setattr(m.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(
        ["claude"], 1, "", "429 rate limit"))
    rc, out, err = m.run_claude("p", tmp_path / "dbg.log", tmp_path / "err.log")
    assert rc == 1 and "429" in err


def test_run_claude_zero_retry_config_returns_failure(module, monkeypatch, tmp_path):
    # If the retry ceiling is configured to 0, the loop body never runs; the
    # pre-initialized default result keeps the function well-defined (no
    # NameError) and returns a failure without invoking claude.
    m, *_ = module
    monkeypatch.setattr(m, "OLLAMA_429_MAX_RETRIES", 0)
    called = {"n": 0}
    monkeypatch.setattr(m.subprocess, "run",
                        lambda *a, **k: called.__setitem__("n", called["n"] + 1) or
                        subprocess.CompletedProcess(["claude"], 0, '{"result":"ok"}', ""))
    rc, out, err = m.run_claude("p", tmp_path / "dbg.log", tmp_path / "err.log")
    assert rc == 1 and out == "" and err == ""
    assert called["n"] == 0  # subprocess.run never invoked


def test_run_claude_sets_token_env(module, monkeypatch, tmp_path):
    m, *_ = module
    captured = {}

    def fake_run(cmd, **k):
        captured["env"] = k.get("env", {})
        return subprocess.CompletedProcess(cmd, 0, "{}", "")

    monkeypatch.setattr(m.subprocess, "run", fake_run)
    m.run_claude("p", tmp_path / "dbg.log", tmp_path / "err.log", max_output_tokens="512")
    assert captured["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == "512"


# ---- extract_result_payload / extract_result_text ----

class TestExtractResult:
    def test_payload(self, module):
        m, *_ = module
        assert m.extract_result_payload('{"a":1}') == {"a": 1}
        assert m.extract_result_payload("") is None
        assert m.extract_result_payload("not json") is None
        assert m.extract_result_payload("[1,2]") is None  # not a dict

    def test_text(self, module):
        m, *_ = module
        assert m.extract_result_text({"result": "hi"}) == "hi"
        assert m.extract_result_text(None) == ""
        assert m.extract_result_text({"result": ""}) == ""


# ---- token budget helpers ----

class TestTokenBudget:
    def test_parse_affordable(self, module):
        m, *_ = module
        assert m.parse_affordable_max_tokens("requested up to 1000 tokens, but can only afford 400") == (1000, 400)
        assert m.parse_affordable_max_tokens("nothing here") is None

    def test_adjusted_budget(self, module):
        m, *_ = module
        assert m.adjusted_output_token_budget(0) is None
        assert m.adjusted_output_token_budget(-5) is None
        # 400 - min(128, 40) = 360; >= 256
        assert m.adjusted_output_token_budget(400) == 360
        # small budget floors at 256
        assert m.adjusted_output_token_budget(100) == 256


class TestRetryableProviderError:
    def test_403_daily_limit_not_retryable(self, module):
        m, *_ = module
        assert m.is_retryable_provider_error("API error: 403 daily limit exceeded") is False

    def test_429_retryable(self, module):
        m, *_ = module
        assert m.is_retryable_provider_error("429 too many") is True

    def test_marker_retryable(self, module):
        m, *_ = module
        assert m.is_retryable_provider_error("provider returned error") is True
        assert m.is_retryable_provider_error("tool_call_ids did not have response messages") is True

    def test_clean_not_retryable(self, module):
        m, *_ = module
        assert m.is_retryable_provider_error("all good") is False


# ---- safe_session_id / state_file_for_session / resolve_transcript_path ----

class TestSession:
    def test_safe_session_id(self, module):
        m, *_ = module
        assert m.safe_session_id("") == "no-session"
        assert m.safe_session_id("abc 123/xyz") == "abc_123_xyz"

    def test_state_file_for_session(self, module):
        m, *_ = module
        p = m.state_file_for_session("sess")
        assert p.name == "sess.json" and p.parent.name == "state"

    def test_resolve_transcript_path_direct(self, module):
        m, *_ = module
        assert m.resolve_transcript_path({"transcript_path": "/tmp/x.jsonl"}) == pathlib.Path("/tmp/x.jsonl")

    def test_resolve_transcript_path_via_state(self, module, tmp_path, monkeypatch):
        m, *_ = module
        state_dir = tmp_path / ".claude" / "state"
        state_dir.mkdir(parents=True)
        (state_dir / "sess.json").write_text(json.dumps({"transcript_path": str(tmp_path / "t.jsonl")}), encoding="utf-8")
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        resolved = m.resolve_transcript_path({"session_id": "sess"})
        assert resolved == tmp_path / "t.jsonl"

    def test_resolve_transcript_path_state_corrupt(self, module, tmp_path, monkeypatch):
        m, *_ = module
        state_dir = tmp_path / ".claude" / "state"
        state_dir.mkdir(parents=True)
        (state_dir / "sess.json").write_text("not json", encoding="utf-8")
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        assert m.resolve_transcript_path({"session_id": "sess"}) is None

    def test_resolve_transcript_path_none(self, module):
        m, *_ = module
        assert m.resolve_transcript_path(None) is None
        assert m.resolve_transcript_path({}) is None


# ---- flatten_message_text / transcript_candidate_text / transcript_candidate_score ----

class TestTranscriptCandidates:
    def test_flatten_message_text(self, module):
        m, *_ = module
        assert m.flatten_message_text("plain") == "plain"
        assert m.flatten_message_text(5) == ""
        assert m.flatten_message_text([{"text": "a"}, {"content": "b"}, "x", {"text": ""}]) == "a\nb"

    def test_candidate_text(self, module):
        m, *_ = module
        assert m.transcript_candidate_text({"result": "done"}) == "done"
        assert m.transcript_candidate_text({"message": {"content": [{"text": "hi"}]}}) == "hi"
        assert m.transcript_candidate_text({}) == ""

    def test_candidate_score(self, module):
        m, *_ = module
        full = "Verification status: passed\nReview outcome: done\nRemaining risks: none"
        assert m.transcript_candidate_score(full) >= 12
        assert m.transcript_candidate_score("random text") == 0


# ---- extract_result_text_from_transcript ----

def test_extract_result_text_from_transcript(module, tmp_path, monkeypatch):
    m, *_ = module
    transcript = tmp_path / "t.jsonl"
    events = [
        json.dumps({"type": "user", "message": {"content": "ignored"}}),
        json.dumps({"type": "assistant", "message": {"content": [{"text": "Verification status: passed - ok"}]}}),
        "not json",
        json.dumps({"type": "assistant", "message": {"content": [{"text": "weak text"}]}}),
    ]
    transcript.write_text("\n".join(events), encoding="utf-8")
    monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
    payload = {"transcript_path": str(transcript)}
    text = m.extract_result_text_from_transcript(payload)
    assert "Verification status: passed" in text


def test_extract_result_text_from_transcript_missing(module):
    m, *_ = module
    assert m.extract_result_text_from_transcript({"transcript_path": "/no/such.jsonl"}) == ""
    assert m.extract_result_text_from_transcript(None) == ""


def test_extract_result_text_from_transcript_skips_blank_nondict_empty(module, tmp_path, monkeypatch):
    m, *_ = module
    transcript = tmp_path / "t.jsonl"
    events = [
        "",  # blank line -> continue
        json.dumps([1, 2, 3]),  # valid JSON but non-dict -> continue
        json.dumps({"type": "user"}),  # no extractable text -> continue
        json.dumps({"type": "assistant", "message": {"text": "Verification status: passed"}}),
    ]
    transcript.write_text("\n".join(events), encoding="utf-8")
    monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
    payload = {"transcript_path": str(transcript)}
    text = m.extract_result_text_from_transcript(payload)
    assert "Verification status: passed" in text


def test_extract_result_text_from_transcript_oserror(module, tmp_path, monkeypatch):
    m, *_ = module
    # Path exists (it is a directory) but open() raises IsADirectoryError
    # (an OSError subclass) -> caught, returns "".
    monkeypatch.setattr(m, "resolve_transcript_path", lambda payload: tmp_path)
    assert m.extract_result_text_from_transcript({"transcript_path": str(tmp_path)}) == ""


# ---- detect_verification_target / run_verification ----

class TestVerification:
    def test_detect_npm(self, module, tmp_path):
        m, *_ = module
        (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test": "jest"}}), encoding="utf-8")
        cmd, label = m.detect_verification_target(tmp_path)
        assert cmd == ["npm", "run", "test", "--silent"] and label == "npm run test"

    def test_detect_npm_no_test_script(self, module, tmp_path):
        m, *_ = module
        (tmp_path / "package.json").write_text(json.dumps({"scripts": {}}), encoding="utf-8")
        (tmp_path / "test_x.py").write_text("def test_x(): assert True", encoding="utf-8")
        cmd, label = m.detect_verification_target(tmp_path)
        assert label == "pytest -q"

    def test_detect_npm_corrupt(self, module, tmp_path):
        m, *_ = module
        (tmp_path / "package.json").write_text("not json", encoding="utf-8")
        assert m.detect_verification_target(tmp_path) == (None, None)

    def test_detect_cargo(self, module, tmp_path):
        m, *_ = module
        (tmp_path / "Cargo.toml").write_text("[package]\n", encoding="utf-8")
        cmd, label = m.detect_verification_target(tmp_path)
        assert cmd == ["cargo", "test", "--quiet"] and label == "cargo test"

    def test_detect_go(self, module, tmp_path):
        m, *_ = module
        (tmp_path / "go.mod").write_text("module x\n", encoding="utf-8")
        assert m.detect_verification_target(tmp_path) == (["go", "test", "./..."], "go test ./...")

    def test_detect_python_tests_dir(self, module, tmp_path):
        m, *_ = module
        (tmp_path / "tests").mkdir()
        (tmp_path / "tests" / "test_a.py").write_text("x", encoding="utf-8")
        cmd, label = m.detect_verification_target(tmp_path)
        assert label == "pytest -q"

    def test_detect_none(self, module, tmp_path):
        m, *_ = module
        assert m.detect_verification_target(tmp_path) == (None, None)

    def test_run_verification_no_target(self, module, monkeypatch, tmp_path):
        m, *_, workdir = module
        monkeypatch.setattr(m, "WORKDIR", tmp_path)
        ran, passed, out, label = m.run_verification()
        assert ran is False and "No supported" in out

    def test_run_verification_runs(self, module, monkeypatch, tmp_path):
        m, *_, workdir = module
        monkeypatch.setattr(m, "WORKDIR", tmp_path)
        (tmp_path / "test_x.py").write_text("def test_x(): assert True", encoding="utf-8")
        monkeypatch.setattr(m.subprocess, "run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 0, "1 passed", ""))
        ran, passed, out, label = m.run_verification()
        assert ran is True and passed is True and "1 passed" in out


# ---- footer helpers ----

class TestFooterHelpers:
    def test_has_line_prefix(self, module):
        m, *_ = module
        assert m.has_line_prefix("  Verification status: x", "Verification status:") is True
        assert m.has_line_prefix("nothing", "Verification status:") is False

    def test_missing_summary_prefixes(self, module):
        m, *_ = module
        full = "Verification status: passed\nReview outcome: done\nRemaining risks: none"
        assert m.missing_summary_prefixes(full) == []
        # Verification status present at line start; the other two missing.
        assert m.missing_summary_prefixes("Verification status: x\nbody") == [
            "Review outcome:", "Remaining risks:"]
        # Prefix not at line start -> counted as missing.
        assert m.missing_summary_prefixes("only Verification status: x") == [
            "Verification status:", "Review outcome:", "Remaining risks:"]

    def test_extract_prefixed_line(self, module):
        m, *_ = module
        assert m.extract_prefixed_line("Review outcome: done - ok", "Review outcome:") == "Review outcome: done - ok"
        assert m.extract_prefixed_line("nope", "Review outcome:") == ""

    def test_merge_footer(self, module):
        m, *_ = module
        body = "Some work done.\nVerification status: old"
        footer = ["Verification status: passed - ok", "Review outcome: done - ok", "Remaining risks: none"]
        merged = m.merge_footer(body, footer)
        assert "old" not in merged
        assert "Verification status: passed - ok" in merged
        # empty body
        assert m.merge_footer("", footer).startswith("Verification status:")


# ---- status line synthesis ----

class TestStatusLines:
    def test_verification_status_line(self, module):
        m, *_ = module
        assert "not required" in m.verification_status_line(False, False, False, "pytest -q")
        assert "not run" in m.verification_status_line(True, False, False, "pytest -q")
        assert "passed" in m.verification_status_line(True, True, True, "pytest -q")
        assert "failed" in m.verification_status_line(True, True, False, "pytest -q")

    def test_review_outcome_line(self, module):
        m, *_ = module
        assert "not required" in m.review_outcome_line(False, False)
        assert "done" in m.review_outcome_line(True, True)
        assert "pending" in m.review_outcome_line(True, False)

    def test_remaining_risks_line(self, module):
        m, *_ = module
        assert "incomplete" in m.remaining_risks_line(True, True, False, False)
        assert "incomplete" in m.remaining_risks_line(True, False, False, False)
        assert "omitted" in m.remaining_risks_line(False, False, False, True)
        assert m.remaining_risks_line(False, False, False, False) == "Remaining risks: none"

    def test_synthesize_footer(self, module):
        m, *_ = module
        # review_required=False so remaining_risks_line returns "none" (with
        # review_required=True it returns the "omitted" line instead).
        footer = m.synthesize_footer(True, True, True, "pytest -q", False, False)
        assert len(footer) == 3
        assert footer[0].startswith("Verification status: passed")
        assert footer[2] == "Remaining risks: none"


# ---- completed_task_recovery_mode ----

class TestRecoveryMode:
    def _kwargs(self, **over):
        base = dict(exit_code=0, payload_subtype="", fatal_error="", completed=True,
                    verification_required=False, tests_run=False, tests_passed=False,
                    verification_summary_present=True, review_required=False,
                    review_present=True, risks_present=True, docs_required=False,
                    docs_updated=True, category="feature", non_doc_changed_files=[],
                    doc_pattern_hits=[])
        base.update(over)
        return base

    def test_not_completed(self, module):
        m, *_ = module
        assert m.completed_task_recovery_mode(**self._kwargs(completed=False)) == "none"

    def test_verification_incomplete(self, module):
        m, *_ = module
        assert m.completed_task_recovery_mode(**self._kwargs(
            verification_required=True, tests_run=True, tests_passed=False,
            verification_summary_present=True)) == "none"

    def test_review_missing(self, module):
        m, *_ = module
        assert m.completed_task_recovery_mode(**self._kwargs(
            review_required=True, review_present=False)) == "none"

    def test_risks_missing(self, module):
        m, *_ = module
        assert m.completed_task_recovery_mode(**self._kwargs(risks_present=False)) == "none"

    def test_docs_required_not_updated(self, module):
        m, *_ = module
        assert m.completed_task_recovery_mode(**self._kwargs(
            docs_required=True, docs_updated=False)) == "none"

    def test_docs_task_with_non_doc_changes(self, module):
        m, *_ = module
        assert m.completed_task_recovery_mode(**self._kwargs(
            category="docs", non_doc_changed_files=["a.py"])) == "none"

    def test_doc_pattern_hits(self, module):
        m, *_ = module
        assert m.completed_task_recovery_mode(**self._kwargs(doc_pattern_hits=["x"])) == "none"

    def test_timeout_recovery(self, module):
        m, *_ = module
        assert m.completed_task_recovery_mode(**self._kwargs(
            exit_code=124, fatal_error="Claude timed out after 300s.")) == "timeout"

    def test_max_turns_recovery(self, module):
        m, *_ = module
        assert m.completed_task_recovery_mode(**self._kwargs(
            payload_subtype="error_max_turns")) == "max_turns"

    def test_clean_none(self, module):
        m, *_ = module
        assert m.completed_task_recovery_mode(**self._kwargs()) == "none"


# ---- build_summary_repair_prompt / truncate / write_text ----

def test_build_summary_repair_prompt(module):
    m, *_ = module
    task = {"id": "t1"}
    prompt = m.build_summary_repair_prompt(task, "prev response", True, True, False,
                                           "pytest -q", "1 failed", True, ["a.py"])
    assert "Verification status:" in prompt
    assert "task_id: t1" in prompt
    assert "a.py" in prompt


class TestTruncateWrite:
    def test_truncate(self, module):
        m, *_ = module
        assert m.truncate("short") == "short"
        assert m.truncate("x" * 100, limit=10) == "xxxxxxx" + "..."

    def test_write_text(self, module, tmp_path):
        m, *_ = module
        p = tmp_path / "nested" / "f.txt"
        m.write_text(p, "hello")
        assert p.read_text(encoding="utf-8") == "hello"


# ---- payload helpers ----

class TestPayloadHelpers:
    def test_payload_keys(self, module):
        m, *_ = module
        assert m.payload_keys({"b": 1, "a": 2}) == "a, b"
        assert m.payload_keys({}) == "<empty-object>"
        assert m.payload_keys(None) == "<invalid-or-missing>"

    def test_payload_string(self, module):
        m, *_ = module
        assert m.payload_string({"x": "v"}, "x") == "v"
        assert m.payload_string({"x": 5}, "x") == "5"
        assert m.payload_string(None, "x") == ""
        assert m.payload_string({}, "x") == ""

    def test_payload_bool(self, module):
        m, *_ = module
        assert m.payload_bool({"h": True}, "h") is True
        assert m.payload_bool({"h": 1}, "h") is False  # only strict True
        assert m.payload_bool(None, "h") is False

    def test_payload_permission_denials(self, module):
        m, *_ = module
        assert m.payload_permission_denials({"permission_denials": [{"t": 1}]}) == [{"t": 1}]
        assert m.payload_permission_denials({"permission_denials": "x"}) == []
        assert m.payload_permission_denials(None) == []

    def test_first_permission_denial_summary(self, module):
        m, *_ = module
        assert m.first_permission_denial_summary([]) == "none"
        assert m.first_permission_denial_summary([{"tool_name": "Edit", "tool_input": {"file_path": "/a.py"}}]) == "Edit -> /a.py"
        assert m.first_permission_denial_summary([{"tool_name": "Bash", "tool_input": {}}]) == "Bash"
        # tool_input not a dict -> file_path stays "" -> bare tool name.
        assert m.first_permission_denial_summary([{"tool_name": "Web", "tool_input": None}]) == "Web"
        assert m.first_permission_denial_summary([{"tool_name": "Web", "tool_input": "str"}]) == "Web"


# ---- forbidden_doc_pattern_hits ----

def test_forbidden_doc_pattern_hits(module):
    m, *_ = module
    task = {"forbidden_doc_patterns": [r"secret\s+key"]}
    after = {"guide.md": "here is a secret key", "app.py": "secret key"}
    hits = m.forbidden_doc_pattern_hits(task, after, ["guide.md", "app.py"])
    assert "guide.md: /secret\\s+key/" in hits
    assert "app.py" not in "".join(hits)  # app.py is not a docs path
    # non-list patterns
    assert m.forbidden_doc_pattern_hits({"forbidden_doc_patterns": "x"}, after, ["guide.md"]) == []
    # empty pattern skipped
    assert m.forbidden_doc_pattern_hits({"forbidden_doc_patterns": [""]}, after, ["guide.md"]) == []


# ---- transcript event classification ----

class TestTranscriptEvents:
    def test_is_assistant_like(self, module):
        m, *_ = module
        assert m.is_assistant_like_transcript_event({"type": "assistant"}) is True
        assert m.is_assistant_like_transcript_event({"type": "result"}) is True
        assert m.is_assistant_like_transcript_event({"message": {"role": "assistant"}}) is True
        assert m.is_assistant_like_transcript_event({"type": "user"}) is False

    def test_transcript_text_entries(self, module, tmp_path, monkeypatch):
        m, *_ = module
        t = tmp_path / "t.jsonl"
        t.write_text("\n".join([
            json.dumps({"type": "user", "message": {"content": "u"}}),
            json.dumps({"type": "assistant", "message": {"content": [{"text": "a"}]}}),
            "not json",
        ]), encoding="utf-8")
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        scanned, entries = m.transcript_text_entries({"transcript_path": str(t)})
        assert scanned is True and len(entries) == 2
        scanned2, entries2 = m.transcript_text_entries({"transcript_path": str(t)}, assistant_only=True)
        assert scanned2 is True and len(entries2) == 1 and "a" in entries2[0][1]

    def test_transcript_text_entries_missing(self, module):
        m, *_ = module
        assert m.transcript_text_entries({"transcript_path": "/no.jsonl"}) == (False, [])
        assert m.transcript_text_entries(None) == (False, [])

    def test_transcript_text_entries_skips_blank_and_empty(self, module, tmp_path, monkeypatch):
        m, *_ = module
        t = tmp_path / "t.jsonl"
        t.write_text("\n".join([
            "",  # blank line -> continue
            json.dumps({"type": "assistant"}),  # no extractable text -> continue
            json.dumps({"type": "assistant", "message": {"content": [{"text": "ok"}]}}),
        ]), encoding="utf-8")
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        scanned, entries = m.transcript_text_entries({"transcript_path": str(t)})
        assert scanned is True and len(entries) == 1

    def test_transcript_text_entries_oserror(self, module, tmp_path, monkeypatch):
        m, *_ = module
        monkeypatch.setattr(m, "resolve_transcript_path", lambda payload: tmp_path)
        assert m.transcript_text_entries({"transcript_path": str(tmp_path)}) == (False, [])

    def test_assistant_pattern_entries_supplement(self, module, tmp_path, monkeypatch):
        m, *_ = module
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        scanned, entries = m.assistant_pattern_entries(None, result_text="standalone text")
        assert scanned is True
        assert any("standalone text" == t for _, t in entries)


# ---- forbidden / required transcript patterns ----

class TestTranscriptPatterns:
    def _payload(self, tmp_path, monkeypatch, events):
        t = tmp_path / "t.jsonl"
        t.write_text("\n".join(json.dumps(e) for e in events), encoding="utf-8")
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        return {"transcript_path": str(t)}

    def test_forbidden_hits(self, module, tmp_path, monkeypatch):
        m, *_ = module
        payload = self._payload(tmp_path, monkeypatch, [
            {"type": "assistant", "message": {"content": [{"text": "leaked secret"}]}}])
        scanned, hits = m.forbidden_transcript_pattern_hits(
            {"forbidden_transcript_patterns": [r"secret"]}, payload)
        assert scanned is True and hits
        # no patterns
        assert m.forbidden_transcript_pattern_hits({}, payload) == (False, [])
        # no transcript
        assert m.forbidden_transcript_pattern_hits({"forbidden_transcript_patterns": [r"x"]}, None) == (False, [])

    def test_required_misses(self, module, tmp_path, monkeypatch):
        m, *_ = module
        payload = self._payload(tmp_path, monkeypatch, [
            {"type": "assistant", "message": {"content": [{"text": "Findings: present"}]}}])
        scanned, misses = m.required_transcript_pattern_misses(
            {"required_transcript_patterns": [r"Findings:", r"Root cause:"]}, payload)
        assert scanned is True and "Root cause:" in misses and "Findings:" not in misses
        # no patterns
        assert m.required_transcript_pattern_misses({}, payload) == (False, [])
        # no transcript -> unavailable marker
        scanned2, misses2 = m.required_transcript_pattern_misses(
            {"required_transcript_patterns": [r"x"]}, None)
        assert misses2 == ["<assistant transcript unavailable>"]

    def test_effective_required_transcript_misses(self, module):
        m, *_ = module
        assert m.effective_required_transcript_misses(
            ["<assistant transcript unavailable>"], recovered_nonzero_exit=True) == []
        assert m.effective_required_transcript_misses(
            ["<assistant transcript unavailable>"], recovered_nonzero_exit=False) == ["<assistant transcript unavailable>"]
        assert m.effective_required_transcript_misses(["Root cause:"], recovered_nonzero_exit=True) == ["Root cause:"]


# ---- agent inference ----

class TestAgentInference:
    def test_from_transcript(self, module, tmp_path, monkeypatch):
        m, *_ = module
        t = tmp_path / "t.jsonl"
        t.write_text("\n".join([
            json.dumps({"type": "assistant", "message": {"content": [{"text": "launching @cr now"}]}}),
            json.dumps({"type": "assistant", "message": {"content": [{"text": "skill(/test) ran"}]}}),
        ]), encoding="utf-8")
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        aliases = m.infer_used_agent_aliases_from_transcript({"transcript_path": str(t)})
        assert "cr" in aliases and "t" in aliases

    def test_from_transcript_empty(self, module):
        m, *_ = module
        assert m.infer_used_agent_aliases_from_transcript(None) == []

    def test_from_result_text(self, module):
        m, *_ = module
        text = "- @cr reviewed the change\nhandoff to @doc for docs"
        aliases = m.infer_used_agent_aliases_from_result_text(text)
        assert "cr" in aliases and "doc" in aliases
        assert m.infer_used_agent_aliases_from_result_text("") == []

    def test_extract_used_agent_aliases(self, module, tmp_path, monkeypatch):
        m, *_ = module
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        debug = "Hook SubagentStart:Code Reviewer(...)\nRecorded subagent handoff: @doc"
        aliases = m.extract_used_agent_aliases(debug, None, result_text="- @t verified")
        assert "cr" in aliases and "doc" in aliases and "t" in aliases

    def test_extract_used_agent_aliases_dedups_across_sources(self, module, tmp_path, monkeypatch):
        m, *_ = module
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        # debug already yields "cr"; the transcript and result_text also yield
        # "cr" -> both later loops hit the `alias in seen` skip branches.
        t = tmp_path / "t.jsonl"
        t.write_text("\n".join([
            json.dumps({"type": "assistant", "message": {"content": [{"text": "launching @cr"}]}}),
        ]), encoding="utf-8")
        debug = "Hook SubagentStart:Code Reviewer(...)"
        aliases = m.extract_used_agent_aliases(
            debug, {"transcript_path": str(t)}, result_text="- @cr reviewed")
        # "cr" appears once despite three sources.
        assert aliases.count("cr") == 1


# ---- transcript_contract_hints ----

def test_transcript_contract_hints(module):
    m, *_ = module
    # "Findings:|Investigation" matches a plain-string replacement source;
    # "CustomLabel" matches nothing and passes through unchanged.
    task = {"required_transcript_patterns": ["Findings:|Investigation", "Coverage:", "CustomLabel"]}
    hints = m.transcript_contract_hints(task)
    assert "Findings: or Investigation:" in hints
    assert "Coverage:" in hints
    assert "CustomLabel" in hints
    assert m.transcript_contract_hints({}) == []
    assert m.transcript_contract_hints({"required_transcript_patterns": "x"}) == []
    # Non-str and blank entries are skipped; valid ones still pass through.
    hints2 = m.transcript_contract_hints(
        {"required_transcript_patterns": ["Plan:", 5, "   ", "Warnings:"]}
    )
    assert "Plan:" in hints2 and "Warnings:" in hints2
    assert 5 not in hints2 and "   " not in hints2


# ---- changed_files_line / synthesized_outcome_line / closure_line ----

class TestOutcomeLines:
    def test_changed_files_line(self, module):
        m, *_ = module
        assert m.changed_files_line(["a.py", "b.py"]) == "Changed files: a.py, b.py"
        assert m.changed_files_line([]).startswith("No files changed:")

    def test_synthesized_outcome_line(self, module):
        m, *_ = module
        assert "documentation" in m.synthesized_outcome_line({"agent_alias": "doc"}, ["g.md"])
        assert "fixed the scoped bug" in m.synthesized_outcome_line({"agent_alias": "bug"}, [])
        assert "review findings" in m.synthesized_outcome_line({"agent_alias": "cr"}, [])
        assert "isolated the failing" in m.synthesized_outcome_line({"agent_alias": "dbg"}, [])
        assert "mapped the requested" in m.synthesized_outcome_line({"agent_alias": "e"}, [])
        assert "verified the scoped" in m.synthesized_outcome_line({"agent_alias": "t"}, [])
        assert "completed the scoped" in m.synthesized_outcome_line({}, [])

    def test_closure_line_next_step(self, module):
        m, *_ = module
        assert "finish the required verification" in m.closure_line(
            "Next step:", verification_required=True, tests_run=True, tests_passed=False, review_required=False)
        assert "carry the verified handoff" in m.closure_line(
            "Next step:", verification_required=False, tests_run=False, tests_passed=False, review_required=True)
        assert "Next step: none" in m.closure_line(
            "Next step:", verification_required=False, tests_run=False, tests_passed=False, review_required=False)
        # falls back to remaining_risks_line when pattern has Remaining risks
        assert m.closure_line(
            "Remaining risks:|Next step:", verification_required=True, tests_run=True, tests_passed=False,
            review_required=False).startswith("Remaining risks:")


# ---- synthesize_required_transcript_lines / merge_required_transcript_block ----

class TestRequiredTranscriptSynthesis:
    def test_synthesize_lines(self, module):
        m, *_ = module
        task = {"id": "t1", "agent_alias": "bug",
                "required_transcript_patterns": [
                    r"Task:\s*Debug", "Findings:|Investigation", "Outcome:|Fix:",
                    "Changed files:|No files changed:", "Verification status:",
                    "Review outcome:", "Next step:", "Remaining risks:|Next step:",
                    "Plan:", "Reproduction:", "Root cause:", "Warnings:", "Gaps:",
                    "Locations:", "Coverage:"]}
        lines = m.synthesize_required_transcript_lines(
            task, changed_files=["a.py"], verification_required=True, tests_run=True,
            tests_passed=True, verification_label="pytest -q", review_required=True,
            review_present=True)
        joined = "\n".join(lines)
        assert "Task: Debug — benchmark handoff" in joined
        assert "Findings:" in joined
        assert "Outcome:" in joined
        assert "Changed files: a.py" in joined
        assert "Verification status: passed" in joined
        assert "Review outcome: done" in joined

    def test_synthesize_lines_empty(self, module):
        m, *_ = module
        assert m.synthesize_required_transcript_lines(
            {}, changed_files=[], verification_required=False, tests_run=False,
            tests_passed=False, verification_label="verification", review_required=False,
            review_present=False) == []

    def test_synthesize_lines_non_list_patterns(self, module):
        m, *_ = module
        # Non-list patterns -> [].
        assert m.synthesize_required_transcript_lines(
            {"required_transcript_patterns": "nope"}, changed_files=["a.py"],
            verification_required=True, tests_run=True, tests_passed=True,
            verification_label="pytest", review_required=True, review_present=True) == []

    def test_synthesize_lines_task_handoff_variants(self, module):
        m, *_ = module
        task = {"id": "t1", "agent_alias": "cr",
                "required_transcript_patterns": [
                    r"Task:\s*Code Review", r"Task:\s*Testing",
                    r"Task:\s*Refactor", r"Task:\s*Housekeeping",
                    5, "   ",  # non-str + blank -> skipped
                ]}
        lines = m.synthesize_required_transcript_lines(
            task, changed_files=["a.py"], verification_required=True, tests_run=True,
            tests_passed=True, verification_label="pytest -q", review_required=True,
            review_present=True)
        joined = "\n".join(lines)
        assert "Task: Code Review — benchmark handoff" in joined
        assert "Task: Testing — benchmark handoff" in joined
        assert "Task: Refactor — benchmark handoff" in joined
        assert "Task: Housekeeping — bounded cleanup" in joined

    def test_synthesize_lines_exact_changed_files_branch(self, module):
        m, *_ = module
        task = {"id": "t1", "agent_alias": "e",
                "required_transcript_patterns": ["Changed files:"]}
        lines = m.synthesize_required_transcript_lines(
            task, changed_files=["a.py", "b.py"], verification_required=False,
            tests_run=False, tests_passed=False, verification_label="verification",
            review_required=False, review_present=False)
        assert "Changed files: a.py, b.py" in lines

    def test_synthesize_lines_exact_no_files_changed_branch(self, module):
        m, *_ = module
        task = {"id": "t1", "agent_alias": "e",
                "required_transcript_patterns": ["No files changed:"]}
        lines = m.synthesize_required_transcript_lines(
            task, changed_files=[], verification_required=False, tests_run=False,
            tests_passed=False, verification_label="verification", review_required=False,
            review_present=False)
        assert any(ln.startswith("No files changed:") for ln in lines)

    def test_synthesize_lines_dedups_identical_lines(self, module):
        m, *_ = module
        task = {"id": "t1", "agent_alias": "e",
                "required_transcript_patterns": ["Plan:", "Plan:"]}
        lines = m.synthesize_required_transcript_lines(
            task, changed_files=[], verification_required=False, tests_run=False,
            tests_passed=False, verification_label="verification", review_required=False,
            review_present=False)
        # Two identical "Plan:" patterns collapse to a single emitted line.
        plan_lines = [ln for ln in lines if ln.startswith("Plan:")]
        assert len(plan_lines) == 1

    def test_merge_required_transcript_block(self, module):
        m, *_ = module
        text = "Body text.\nVerification status: passed - ok\nReview outcome: done - ok\nRemaining risks: none"
        block_lines = ["Task: Debug — benchmark handoff", "Findings:"]
        merged = m.merge_required_transcript_block(text, block_lines)
        assert "Task: Debug" in merged
        assert "Body text" in merged
        assert "Verification status: passed" in merged
        # no transcript lines -> unchanged
        assert m.merge_required_transcript_block(text, []) == text


# ---- required_used_agent_misses / group_misses / format ----

class TestRequiredUsedAgents:
    def test_misses(self, module):
        m, *_ = module
        task = {"required_used_agents": ["cr", "doc"]}
        assert m.required_used_agent_misses(task, ["cr"]) == ["doc"]
        assert m.required_used_agent_misses(task, ["cr", "doc"]) == []
        assert m.required_used_agent_misses({}, ["cr"]) == []
        assert m.required_used_agent_misses({"required_used_agents": []}, ["cr"]) == []

    def test_group_misses(self, module):
        m, *_ = module
        task = {"required_used_agent_groups": [["cr", "reviewer"], ["doc"]]}
        # used "cr" -> first group satisfied; "doc" not used -> second group missed
        assert m.required_used_agent_group_misses(task, ["cr"]) == [["doc"]]
        assert m.required_used_agent_group_misses(task, ["cr", "doc"]) == []
        assert m.required_used_agent_group_misses({}, ["cr"]) == []
        # non-list group skipped
        assert m.required_used_agent_group_misses({"required_used_agent_groups": ["x"]}, []) == []

    def test_format_agent_group_misses(self, module):
        m, *_ = module
        assert m.format_agent_group_misses([]) == "none"
        assert m.format_agent_group_misses([["a", "b"]]) == "[a | b]"


# ---- build_task_summary ----

def test_build_task_summary(module):
    m, *_ = module
    task = {"id": "t1", "category": "feature", "review_required": True,
            "docs_required": False, "verification_required": True}
    summary = m.build_task_summary(
        task=task, prompt="p", status="passed", exit_code=0, changed_files=["a.py"],
        failures=[], raw_json='{"result":"x"}', payload={"result": "x", "subtype": "done"},
        payload_subtype="done", payload_stop_reason="end", payload_hard_stop=False,
        permission_denials=[], result_text="Verification status: passed",
        verification_output="1 passed", stderr_text="", debug_log_text="dbg",
        patch_text="patch", transcript_scanned=True, transcript_pattern_hits=[],
        required_transcript_scanned=True, required_transcript_misses=[],
        used_agent_aliases=["cr"], required_used_agent_misses=[],
        required_used_agent_group_misses=[])
    assert "Task: t1" in summary
    assert "Status: passed" in summary
    assert "Used agent aliases: cr" in summary
    assert "Patch excerpt:" in summary


# ---- classify_task_failures ----

class TestClassifyTaskFailures:
    def _base(self, **over):
        kw = dict(
            exit_code=0, recovered_nonzero_exit=False, fatal_error="",
            completed=True, verification_required=False, tests_run=False,
            tests_passed=False, verification_summary_present=True,
            review_required=False, review_present=True, risks_present=True,
            docs_required=False, docs_updated=True, category="feature",
            non_doc_changed_files=[], doc_pattern_hits=[],
            transcript_pattern_hits=[], effective_transcript_misses=[],
            missing_required_used_agents=[], missing_required_used_agent_groups=[],
            payload_hard_stop=False,
        )
        kw.update(over)
        return kw

    def test_clean_pass_returns_no_failures(self, module):
        m, *_ = module
        assert m.classify_task_failures(**self._base()) == []

    def test_all_failure_kinds(self, module):
        m, *_ = module
        f = m.classify_task_failures(**self._base(
            exit_code=2, fatal_error="boom", completed=False,
            verification_required=True, tests_run=False, tests_passed=False,
            verification_summary_present=False, review_required=True,
            review_present=False, risks_present=False, docs_required=True,
            docs_updated=False, category="docs", non_doc_changed_files=["a.py"],
            doc_pattern_hits=["g.md: /x/"], transcript_pattern_hits=["t: /y/"],
            effective_transcript_misses=["Root cause:"],
            missing_required_used_agents=["cr"],
            missing_required_used_agent_groups=[["a", "b"]],
            payload_hard_stop=True,
        ))
        assert "claude_exit_code=2" in f
        assert "boom" in f
        assert "workspace_changed=false" in f
        assert "verification_not_run" in f
        assert "verification_failed" in f
        assert "verification_summary_missing" in f
        assert "review_summary_missing" in f
        assert "risk_summary_missing" in f
        assert "docs_not_updated" in f
        assert "docs_task_changed_non_docs" in f
        assert "docs_forbidden_content" in f
        assert "transcript_forbidden_content" in f
        assert "transcript_required_content_missing" in f
        assert "required_used_agents_missing" in f
        assert "required_used_agent_groups_missing" in f
        assert "hard_stop_triggered" in f

    def test_recovered_nonzero_exit_suppresses_exit_and_fatal(self, module):
        m, *_ = module
        f = m.classify_task_failures(**self._base(
            exit_code=1, fatal_error="boom", recovered_nonzero_exit=True))
        assert "claude_exit_code=1" not in f
        assert "boom" not in f

    def test_verification_passed_summary_present_no_failure(self, module):
        m, *_ = module
        f = m.classify_task_failures(**self._base(
            verification_required=True, tests_run=True, tests_passed=True,
            verification_summary_present=True))
        assert "verification_not_run" not in f
        assert "verification_failed" not in f
        assert "verification_summary_missing" not in f


# ---- try_budget_retry / try_provider_retry ----

class TestRetryLoops:
    def _patch_run(self, m, monkeypatch, responses):
        calls = {"i": 0}
        def fake_run(*a, **k):
            resp = responses[min(calls["i"], len(responses) - 1)]
            calls["i"] += 1
            return subprocess.CompletedProcess(["claude"], *resp)
        monkeypatch.setattr(m.subprocess, "run", fake_run)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        return calls

    def test_budget_retry_success(self, module, monkeypatch, tmp_path):
        m, *_, output_dir = module
        # First run already done (exit 0) -> no retry needed.
        self._patch_run(m, monkeypatch, [(0, '{"result":"ok"}', "")])
        rc, out, err, payload, text, fatal, summaries, source, *_ = m.try_budget_retry(
            "p", 0, '{"result":"ok"}', "", {"result": "ok"}, "ok", "",
            tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 0 and source == "none" and summaries == []

    def test_budget_retry_runs_when_affordable(self, module, monkeypatch, tmp_path):
        m, *_, output_dir = module
        # exit!=0, result_text indicates affordable tokens; retry succeeds.
        result_with_afford = ("requested up to 1000 tokens, but can only afford 400")
        self._patch_run(m, monkeypatch, [(0, json.dumps({"result": "ok"}), "")])
        rc, out, err, payload, text, fatal, summaries, source, *_ = m.try_budget_retry(
            "p", 1, "", "", None, result_with_afford, "err",
            tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 0 and source == "output-budget" and len(summaries) == 1

    def test_budget_retry_skips_when_no_affordability(self, module, monkeypatch, tmp_path):
        m, *_ = module
        self._patch_run(m, monkeypatch, [(0, "{}", "")])
        rc, *_rest = m.try_budget_retry(
            "p", 1, "", "", None, "no affordability marker", "err",
            tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 1  # unchanged, no retry

    def test_provider_retry_success(self, module, monkeypatch, tmp_path):
        m, *_, output_dir = module
        # retryable error then success
        self._patch_run(m, monkeypatch, [(0, json.dumps({"result": "ok"}), "")])
        rc, _o, _e, _p, _t, _f, summaries, source, _d, _s = m.try_provider_retry(
            "p", 1, "", "", None, "429 rate limit", "err",
            tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 0 and source == "provider-error" and len(summaries) == 1

    def test_provider_retry_no_retry_when_clean(self, module, monkeypatch, tmp_path):
        m, *_ = module
        self._patch_run(m, monkeypatch, [(0, "{}", "")])
        rc, _o, _e, _p, _t, _f, summaries, source, _d, _s = m.try_provider_retry(
            "p", 0, '{"result":"ok"}', "", {"result": "ok"}, "ok", "",
            tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 0 and source == "none" and summaries == []

    def _patch_run_raises(self, m, monkeypatch, exc):
        monkeypatch.setattr(m.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(exc))
        monkeypatch.setattr(m.time, "sleep", lambda s: None)

    def test_budget_retry_timeout_with_result_text(self, module, monkeypatch, tmp_path):
        m, *_ = module
        # Initial run signaled a budget error; the retry times out but its
        # captured stdout carries a valid payload with result text -> the
        # `if not retry_result_text.strip()` guard is False (551->553).
        payload = json.dumps({"result": "Verification status: passed", "subtype": "done"})
        self._patch_run_raises(m, monkeypatch, subprocess.TimeoutExpired(
            ["claude"], 300, output=payload))
        rc, _o, _e, _p, text, _f, summaries, source, *_ = m.try_budget_retry(
            "p", 1, "", "", None, AFFORD_400, "e",
            tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 124
        assert "Verification status: passed" in text
        assert source == "output-budget" and len(summaries) == 1

    def test_budget_retry_exhaustion(self, module, monkeypatch, tmp_path):
        m, *_ = module
        # Every retry still reports a decreasing affordable budget and a non-zero
        # exit -> the loop runs all OUTPUT_TOKEN_BUDGET_RETRIES (3) iterations and
        # exits via natural exhaustion (505->584) rather than an early break.
        marker = "requested up to 1000 tokens, but can only afford {}"
        responses = [
            (1, json.dumps({"result": marker.format(300)}), ""),
            (1, json.dumps({"result": marker.format(200)}), ""),
            (1, json.dumps({"result": marker.format(100)}), ""),
        ]
        self._patch_run(m, monkeypatch, responses)
        rc, _o, _e, _p, _t, _f, summaries, source, *_ = m.try_budget_retry(
            "p", 1, "", "", None, AFFORD_400, "e",
            tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 1
        assert source == "output-budget"
        assert len(summaries) == 3  # one per exhausted attempt

    def test_provider_retry_timeout_with_result_text(self, module, monkeypatch, tmp_path):
        m, *_ = module
        # Provider retry times out with a valid payload result text ->
        # `if not retry_result_text.strip()` False (663->665).
        payload = json.dumps({"result": "Verification status: passed", "subtype": "done"})
        self._patch_run_raises(m, monkeypatch, subprocess.TimeoutExpired(
            ["claude"], 300, output=payload))
        rc, _o, _e, _p, text, _f, summaries, source, _d, _s = m.try_provider_retry(
            "p", 1, "", "", None, "429 rate limit", "e",
            tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 124
        assert "Verification status: passed" in text
        assert source == "provider-error" and len(summaries) == 1

    def test_provider_retry_exhaustion(self, module, monkeypatch, tmp_path):
        m, *_ = module
        # Both retries still report a retryable 429 error and non-zero exit ->
        # the loop runs all PROVIDER_ERROR_RETRIES (2) iterations and exits via
        # natural exhaustion (625->717).
        responses = [
            (1, json.dumps({"result": "429 rate limit again"}), ""),
            (1, json.dumps({"result": "429 rate limit again"}), ""),
        ]
        self._patch_run(m, monkeypatch, responses)
        rc, _o, _e, _p, _t, _f, summaries, source, _d, _s = m.try_provider_retry(
            "p", 1, "", "", None, "429 rate limit", "e",
            tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 1
        assert source == "provider-error"
        assert len(summaries) == 2


# ---- main (end-to-end with monkeypatched run_claude + run_verification) ----

class TestMain:
    def _write_task(self, task_file, **over):
        task = {"id": "t1", "category": "feature", "review_required": False,
                "docs_required": False, "verification_required": False,
                "prompt": "do the thing", "success_criteria": [], "must_not": [],
                "expect_changes": True}
        task.update(over)
        task_file.write_text(json.dumps(task), encoding="utf-8")
        return task

    def _clean_workdir(self, workdir):
        # The module fixture is scope="module", so workdir persists across tests;
        # clear it so each main() run starts from an empty before-snapshot.
        for child in workdir.iterdir():
            if child.is_dir():
                for sub in sorted(child.rglob("*"), reverse=True):
                    if sub.is_file():
                        sub.unlink()
                child.rmdir()
            else:
                child.unlink()

    def _mock_claude(self, m, monkeypatch, workdir, edits, result_text, exit_code=0, stderr=""):
        # main() snapshots WORKDIR before and after run_claude; to produce a
        # diff the edit must happen during the (mocked) run, like a real agent.
        def fake_run(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            for rel_path, content in edits:
                p = workdir / rel_path
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(content, encoding="utf-8")
            payload = {"result": result_text, "subtype": "done", "stop_reason": "end"}
            return exit_code, json.dumps(payload), stderr
        monkeypatch.setattr(m, "run_claude", fake_run)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)

    def test_main_passed(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean_workdir(workdir)
        self._write_task(task_file)
        footer = ("Verification status: passed - ok\n"
                  "Review outcome: not required - ok\n"
                  "Remaining risks: none")
        self._mock_claude(m, monkeypatch, workdir, [("a.py", "print(1)")], footer)
        assert m.main() == 0
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "passed"
        assert result["completed"] is True
        assert (output_dir / "task-summary.txt").exists()
        assert (output_dir / "workspace.patch").exists()

    def test_main_detectable_verification_target_label(self, module, monkeypatch, tmp_path):
        # Pre-seed a Python test file so detect_verification_target returns a
        # non-None label -> the `if verification_label is None` guard is False
        # (1802->1805) and the detected label flows into the prompt/footer.
        m, repo_root, workdir, output_dir, task_file = module
        self._clean_workdir(workdir)
        (workdir / "test_x.py").write_text("def test_x(): assert True\n", encoding="utf-8")
        self._write_task(task_file, verification_required=False)
        footer = ("Verification status: not required - ok\n"
                  "Review outcome: not required - ok\n"
                  "Remaining risks: none")
        self._mock_claude(m, monkeypatch, workdir, [("a.py", "print(1)")], footer)
        assert m.main() == 0
        prompt = (output_dir / "task-prompt.txt").read_text(encoding="utf-8")
        # The detected python label (pytest) appears in the prompt instead of the
        # generic "verification" fallback.
        assert "pytest" in prompt

    def test_main_failed_no_changes(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean_workdir(workdir)
        self._write_task(task_file, expect_changes=True)
        footer = ("Verification status: not required - ok\n"
                  "Review outcome: not required - ok\n"
                  "Remaining risks: none")
        # No edits -> workspace unchanged -> workspace_changed=false.
        self._mock_claude(m, monkeypatch, workdir, [], footer)
        assert m.main() == 0
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "failed"
        assert "workspace_changed=false" in result["failures"]

    def test_main_failed_verification(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean_workdir(workdir)
        self._write_task(task_file, verification_required=True)
        footer = ("Verification status: failed - bad\n"
                  "Review outcome: not required - ok\n"
                  "Remaining risks: some")
        self._mock_claude(m, monkeypatch, workdir, [("a.py", "print(1)")], footer)
        monkeypatch.setattr(m, "run_verification", lambda: (True, False, "1 failed", "pytest -q"))
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "failed"
        assert result["tests_run"] is True and result["tests_passed"] is False

    def test_main_review_missing_synth_fills(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean_workdir(workdir)
        self._write_task(task_file, review_required=True)
        # footer lacks Review outcome; the repair loop can't add it (mock returns
        # the same text), but the synthetic footer fills "Review outcome:" so the
        # run still passes.
        footer = "Verification status: not required - ok\nRemaining risks: none"
        self._mock_claude(m, monkeypatch, workdir, [("a.py", "print(1)")], footer)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "passed"
        assert result["review_present"] is True
        assert (output_dir / "summary-repair-attempts.json").exists()

    def test_main_exit_code_nonzero_fatal_error(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean_workdir(workdir)
        self._write_task(task_file)
        # Empty stdout -> fatal_error set -> runner-error.txt written.
        self._mock_claude(m, monkeypatch, workdir, [("a.py", "print(1)")],
                         result_text="", exit_code=1, stderr="boom")
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "failed"
        assert "claude_exit_code=1" in result["failures"]
        assert (output_dir / "runner-error.txt").exists()

    def _mock_claude_raw(self, m, monkeypatch, workdir, stdout, exit_code=0, stderr=""):
        def fake_run(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            return exit_code, stdout, stderr
        monkeypatch.setattr(m, "run_claude", fake_run)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)

    def test_main_empty_stdout_fatal(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean_workdir(workdir)
        self._write_task(task_file)
        self._mock_claude_raw(m, monkeypatch, workdir, stdout="")
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "failed"
        assert (output_dir / "runner-error.txt").exists()
        err = (output_dir / "runner-error.txt").read_text(encoding="utf-8")
        assert "missing or empty" in err

    def test_main_invalid_json_fatal(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean_workdir(workdir)
        self._write_task(task_file)
        self._mock_claude_raw(m, monkeypatch, workdir, stdout="not json at all")
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "failed"
        err = (output_dir / "runner-error.txt").read_text(encoding="utf-8")
        assert "invalid" in err

    def test_main_docs_task_passes(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean_workdir(workdir)
        self._write_task(task_file, category="docs", docs_required=True, expect_changes=True)
        footer = ("Verification status: not required - ok\n"
                  "Review outcome: not required - ok\n"
                  "Remaining risks: none")
        self._mock_claude(m, monkeypatch, workdir, [("guide.md", "# Guide\nupdated")], footer)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "passed"
        assert result["docs_updated"] is True


# ---- try_budget_retry edge paths ----

AFFORD_400 = "requested up to 1000 tokens, but can only afford 400"


class TestBudgetRetryEdges:
    def test_affordable_zero_breaks(self, module, monkeypatch, tmp_path):
        m, *_ = module
        monkeypatch.setattr(m, "run_claude", lambda *a, **k: (0, "{}", ""))
        rc, *_ = m.try_budget_retry("p", 1, "", "", None, AFFORD_400.replace("400", "0"), "e",
                                    tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 1  # adjusted_output_token_budget(0) is None -> break

    def test_next_budget_above_current_breaks(self, module, monkeypatch, tmp_path):
        m, *_ = module
        monkeypatch.setattr(m, "run_claude", lambda *a, **k: (0, "{}", ""))
        rc, *_ = m.try_budget_retry("p", 1, "", "", None,
                                    "requested up to 1000 tokens, but can only afford 900", "e",
                                    tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 1  # next_budget 810 >= current 768 -> break

    def test_retry_empty_stdout(self, module, monkeypatch, tmp_path):
        m, *_ = module
        calls = {"n": 0}
        def fake(*a, **k):
            calls["n"] += 1
            return (0, "", "") if calls["n"] == 1 else (0, "{}", "")
        monkeypatch.setattr(m, "run_claude", fake)
        rc, _o, _e, _p, text, fatal, summaries, source, *_ = m.try_budget_retry(
            "p", 1, "", "", None, AFFORD_400, "e", tmp_path / "d.log", tmp_path / "e.log")
        assert "missing or empty" in fatal and len(summaries) == 1

    def test_retry_invalid_json(self, module, monkeypatch, tmp_path):
        m, *_ = module
        monkeypatch.setattr(m, "run_claude", lambda *a, **k: (0, "not json", ""))
        rc, _o, _e, _p, text, fatal, summaries, *_ = m.try_budget_retry(
            "p", 1, "", "", None, AFFORD_400, "e", tmp_path / "d.log", tmp_path / "e.log")
        assert "invalid" in fatal

    def test_retry_empty_result_text(self, module, monkeypatch, tmp_path):
        m, *_ = module
        monkeypatch.setattr(m, "run_claude", lambda *a, **k: (0, json.dumps({"result": ""}), ""))
        rc, _o, _e, _p, text, fatal, summaries, *_ = m.try_budget_retry(
            "p", 1, "", "", None, AFFORD_400, "e", tmp_path / "d.log", tmp_path / "e.log")
        assert "result text is missing" in fatal

    def test_retry_timeout(self, module, monkeypatch, tmp_path):
        m, *_ = module
        def fake(*a, **k):
            raise subprocess.TimeoutExpired(cmd=["claude"], timeout=300)
        monkeypatch.setattr(m, "run_claude", fake)
        rc, _o, _e, _p, text, fatal, summaries, *_ = m.try_budget_retry(
            "p", 1, "", "", None, AFFORD_400, "e", tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 124 and "timed out" in fatal

    def test_retry_generic_exception(self, module, monkeypatch, tmp_path):
        m, *_ = module
        monkeypatch.setattr(m, "run_claude", lambda *a, **k: (_ for _ in ()).throw(ValueError("boom")))
        rc, _o, _e, _p, text, fatal, summaries, *_ = m.try_budget_retry(
            "p", 1, "", "", None, AFFORD_400, "e", tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 1 and "runner exception" in fatal


# ---- try_provider_retry edge paths ----

class TestProviderRetryEdges:
    def test_retry_empty_stdout(self, module, monkeypatch, tmp_path):
        m, *_ = module
        monkeypatch.setattr(m, "run_claude", lambda *a, **k: (0, "", ""))
        rc, _o, _e, _p, text, fatal, summaries, *_ = m.try_provider_retry(
            "p", 1, "", "", None, "429 rate limit", "e", tmp_path / "d.log", tmp_path / "e.log")
        assert "missing or empty" in fatal

    def test_retry_invalid_json(self, module, monkeypatch, tmp_path):
        m, *_ = module
        monkeypatch.setattr(m, "run_claude", lambda *a, **k: (0, "not json", ""))
        rc, _o, _e, _p, text, fatal, *_ = m.try_provider_retry(
            "p", 1, "", "", None, "429 rate limit", "e", tmp_path / "d.log", tmp_path / "e.log")
        assert "invalid" in fatal

    def test_retry_empty_result_text(self, module, monkeypatch, tmp_path):
        m, *_ = module
        monkeypatch.setattr(m, "run_claude", lambda *a, **k: (0, json.dumps({"result": ""}), ""))
        rc, _o, _e, _p, text, fatal, *_ = m.try_provider_retry(
            "p", 1, "", "", None, "429 rate limit", "e", tmp_path / "d.log", tmp_path / "e.log")
        assert "result text is missing" in fatal

    def test_retry_timeout(self, module, monkeypatch, tmp_path):
        m, *_ = module
        monkeypatch.setattr(m, "run_claude", lambda *a, **k: (_ for _ in ()).throw(
            subprocess.TimeoutExpired(cmd=["claude"], timeout=300)))
        rc, _o, _e, _p, text, fatal, *_ = m.try_provider_retry(
            "p", 1, "", "", None, "429 rate limit", "e", tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 124 and "timed out" in fatal

    def test_retry_generic_exception(self, module, monkeypatch, tmp_path):
        m, *_ = module
        monkeypatch.setattr(m, "run_claude", lambda *a, **k: (_ for _ in ()).throw(ValueError("boom")))
        rc, _o, _e, _p, text, fatal, *_ = m.try_provider_retry(
            "p", 1, "", "", None, "429 rate limit", "e", tmp_path / "d.log", tmp_path / "e.log")
        assert rc == 1 and "runner exception" in fatal


# ---- main retry/timeout/exception/failure branches ----

class TestMainBranches:
    def _clean(self, workdir):
        for child in workdir.iterdir():
            if child.is_dir():
                for sub in sorted(child.rglob("*"), reverse=True):
                    if sub.is_file():
                        sub.unlink()
                child.rmdir()
            else:
                child.unlink()

    def _footer(self):
        return ("Verification status: not required - ok\n"
                "Review outcome: not required - ok\n"
                "Remaining risks: none")

    def test_main_timeout_recovered(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        # expect_changes=False so completed=True even though the timeout fires on
        # the first run_claude call (before any edit lands); the run is then
        # recovered as a timeout and passes.
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": False}), encoding="utf-8")
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            raise subprocess.TimeoutExpired(cmd=["claude"], timeout=300, output="{}")
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["timeout_recovered"] is True
        assert result["status"] == "passed"

    def test_main_timeout_with_result_text_in_stdout(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": False}), encoding="utf-8")
        footer = ("Verification status: not required - ok\n"
                  "Review outcome: not required - ok\n"
                  "Remaining risks: none")
        # Timeout but stdout carries a valid payload with result text ->
        # `if not result_text.strip()` is False (1844->1846), no transcript fallback.
        payload = json.dumps({"result": footer, "subtype": "done", "stop_reason": "end"})
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            raise subprocess.TimeoutExpired(cmd=["claude"], timeout=300, output=payload)
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["timeout_recovered"] is True
        assert result["status"] == "passed"

    def test_main_runner_exception(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True}), encoding="utf-8")
        monkeypatch.setattr(m, "run_claude", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "failed"
        assert any("runner exception" in f for f in result["failures"])

    def test_main_provider_retry_writes_attempts(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True}), encoding="utf-8")
        calls = {"n": 0}
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            calls["n"] += 1
            if calls["n"] == 1:
                return 1, json.dumps({"result": "429 rate limit"}), ""
            (workdir / "a.py").write_text("x", encoding="utf-8")
            return 0, json.dumps({"result": self._footer(), "subtype": "done"}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        assert (output_dir / "provider-retry-attempts.json").exists()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "passed"

    def test_main_budget_retry_writes_attempts(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True}), encoding="utf-8")
        calls = {"n": 0}
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            calls["n"] += 1
            if calls["n"] == 1:
                return 1, json.dumps({"result": AFFORD_400}), ""
            (workdir / "a.py").write_text("x", encoding="utf-8")
            return 0, json.dumps({"result": self._footer(), "subtype": "done"}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        assert (output_dir / "output-budget-retry-attempts.json").exists()

    def test_main_summary_repair_success(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True}), encoding="utf-8")
        calls = {"n": 0}
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            calls["n"] += 1
            (workdir / "a.py").write_text("x", encoding="utf-8")
            if calls["n"] == 1:
                return 0, json.dumps({"result": "did the work but no footer"}), ""
            # repair call returns a complete footer
            return 0, json.dumps({"result": self._footer()}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "passed"
        assert result["summary_repaired_by"] == "retry"

    def test_main_summary_repair_timeout(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True}), encoding="utf-8")
        calls = {"n": 0}
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            calls["n"] += 1
            (workdir / "a.py").write_text("x", encoding="utf-8")
            if calls["n"] == 1:
                return 0, json.dumps({"result": "did the work but no footer"}), ""
            raise subprocess.TimeoutExpired(cmd=["claude"], timeout=300)
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        # repair timed out -> synthetic footer fills -> still passes
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "passed"

    def test_main_verification_not_run(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": True, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True}), encoding="utf-8")
        footer = ("Verification status: passed - ok\n"
                  "Review outcome: not required - ok\nRemaining risks: none")
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            (workdir / "a.py").write_text("x", encoding="utf-8")
            return 0, json.dumps({"result": footer, "subtype": "done"}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        monkeypatch.setattr(m, "run_verification", lambda: (False, False, "no target", "verification"))
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == "failed"
        assert "verification_not_run" in result["failures"]
        assert "verification_failed" in result["failures"]

    def test_main_docs_not_updated(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": True, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True}), encoding="utf-8")
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            (workdir / "a.py").write_text("x", encoding="utf-8")
            return 0, json.dumps({"result": self._footer(), "subtype": "done"}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert "docs_not_updated" in result["failures"]

    def test_main_docs_task_changed_non_docs(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "docs", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True}), encoding="utf-8")
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            (workdir / "a.py").write_text("x", encoding="utf-8")
            return 0, json.dumps({"result": self._footer(), "subtype": "done"}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert "docs_task_changed_non_docs" in result["failures"]

    def test_main_docs_forbidden_content(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "docs", "review_required": False,
            "docs_required": True, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True,
            "forbidden_doc_patterns": [r"secret\s+key"]}), encoding="utf-8")
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            (workdir / "guide.md").write_text("has a secret key here", encoding="utf-8")
            return 0, json.dumps({"result": self._footer(), "subtype": "done"}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert "docs_forbidden_content" in result["failures"]

    def test_main_transcript_forbidden_content(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True,
            "forbidden_transcript_patterns": [r"leaked\s+secret"]}), encoding="utf-8")
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            (workdir / "a.py").write_text("x", encoding="utf-8")
            return 0, json.dumps({"result": "I leaked secret data\n" + self._footer(),
                                  "subtype": "done"}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert "transcript_forbidden_content" in result["failures"]

    def test_main_required_transcript_missing(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True,
            "required_transcript_patterns": [r"CustomLabel:"]}), encoding="utf-8")
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            (workdir / "a.py").write_text("x", encoding="utf-8")
            return 0, json.dumps({"result": self._footer(), "subtype": "done"}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert "transcript_required_content_missing" in result["failures"]

    def test_main_required_used_agents_missing(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True,
            "required_used_agents": ["cr"]}), encoding="utf-8")
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            (workdir / "a.py").write_text("x", encoding="utf-8")
            return 0, json.dumps({"result": self._footer(), "subtype": "done"}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert "required_used_agents_missing" in result["failures"]

    def test_main_required_used_agent_groups_missing(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True,
            "required_used_agent_groups": [["cr", "reviewer"]]}), encoding="utf-8")
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            (workdir / "a.py").write_text("x", encoding="utf-8")
            return 0, json.dumps({"result": self._footer(), "subtype": "done"}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert "required_used_agent_groups_missing" in result["failures"]

    def test_main_hard_stop_triggered(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True}), encoding="utf-8")
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            (workdir / "a.py").write_text("x", encoding="utf-8")
            return 0, json.dumps({"result": self._footer(), "subtype": "done",
                                  "hardStop": True}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        assert "hard_stop_triggered" in result["failures"]


# ---- import-time guard + remaining defensive branches ----

def test_module_requires_ollama_model(monkeypatch, tmp_path):
    """Loading the module without OLLAMA_MODEL raises at import time."""
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    monkeypatch.setenv("BENCH_REPO_ROOT", str(repo_root))
    monkeypatch.setenv("BENCH_TASK_FILE", str(tmp_path / "task.json"))
    monkeypatch.setenv("BENCH_WORKDIR", str(tmp_path / "work"))
    monkeypatch.setenv("BENCH_OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.delenv("OLLAMA_MODEL", raising=False)
    module_path = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "bench_runner_claude_code.py"
    spec = importlib.util.spec_from_file_location("brc_no_model", module_path)
    mod = importlib.util.module_from_spec(spec)
    with pytest.raises(RuntimeError, match="OLLAMA_MODEL must be set"):
        assert spec.loader is not None
        spec.loader.exec_module(mod)


class TestDefensiveBranches:
    def test_resolve_transcript_path_state_without_transcript(self, module, tmp_path, monkeypatch):
        m, *_ = module
        state_dir = tmp_path / ".claude" / "state"
        state_dir.mkdir(parents=True)
        (state_dir / "sess.json").write_text(json.dumps({"other": "x"}), encoding="utf-8")
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        assert m.resolve_transcript_path({"session_id": "sess"}) is None

    def test_resolve_transcript_path_missing_state_file(self, module, tmp_path, monkeypatch):
        m, *_ = module
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        # session_id present but no state file on disk -> None
        assert m.resolve_transcript_path({"session_id": "never-created"}) is None

    def test_forbidden_doc_pattern_hits_non_str_content(self, module):
        m, *_ = module
        # Non-dict, non-str entry -> content coerced to "" -> no hit, no crash.
        hits = m.forbidden_doc_pattern_hits(
            {"forbidden_doc_patterns": [r"x"]}, {"guide.md": 123}, ["guide.md"])
        assert hits == []

    def test_transcript_text_entries_non_dict_event(self, module, tmp_path, monkeypatch):
        m, *_ = module
        t = tmp_path / "t.jsonl"
        t.write_text("\n".join([json.dumps([1, 2, 3]), json.dumps({"type": "assistant",
            "message": {"content": [{"text": "ok"}]}})]), encoding="utf-8")
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        scanned, entries = m.transcript_text_entries({"transcript_path": str(t)})
        assert scanned is True and len(entries) == 1

    def test_forbidden_transcript_non_str_pattern(self, module, tmp_path, monkeypatch):
        m, *_ = module
        t = tmp_path / "t.jsonl"
        t.write_text(json.dumps({"type": "assistant", "message": {"content": [{"text": "hi"}]}}), encoding="utf-8")
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        scanned, hits = m.forbidden_transcript_pattern_hits(
            {"forbidden_transcript_patterns": [123, ""]}, {"transcript_path": str(t)})
        assert scanned is True and hits == []

    def test_required_transcript_non_str_pattern(self, module, tmp_path, monkeypatch):
        m, *_ = module
        t = tmp_path / "t.jsonl"
        t.write_text(json.dumps({"type": "assistant", "message": {"content": [{"text": "hi"}]}}), encoding="utf-8")
        monkeypatch.setattr(pathlib.Path, "home", lambda: tmp_path)
        scanned, misses = m.required_transcript_pattern_misses(
            {"required_transcript_patterns": [123, "", r"NotFound:"]}, {"transcript_path": str(t)})
        assert scanned is True and misses == ["NotFound:"]

    def test_transcript_contract_hints_dedup(self, module):
        m, *_ = module
        hints = m.transcript_contract_hints(
            {"required_transcript_patterns": ["Plan:", "Plan:"]})
        assert hints == ["Plan:"]


class TestMainTranscriptSynthesis:
    def _clean(self, workdir):
        for child in workdir.iterdir():
            child.unlink()

    def test_synthesis_block_runs_and_passes(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        footer = ("Verification status: not required - ok\n"
                  "Review outcome: not required - ok\n"
                  "Remaining risks: none")
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True,
            "required_transcript_patterns": [r"Findings:|Investigation"]}), encoding="utf-8")
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            (workdir / "a.py").write_text("x", encoding="utf-8")
            return 0, json.dumps({"result": footer, "subtype": "done"}), ""
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        result = json.loads((output_dir / "result.json").read_text(encoding="utf-8"))
        # Synthesis adds the "Findings:" line -> re-scan finds no miss -> passes.
        assert result["status"] == "passed"
        assert "Findings:" in (output_dir / "claude-result.txt").read_text(encoding="utf-8")


class TestMainSummaryRepairEdges:
    def _clean(self, workdir):
        for child in workdir.iterdir():
            child.unlink()

    def _setup(self, task_file, workdir):
        task_file.write_text(json.dumps({
            "id": "t", "category": "feature", "review_required": False,
            "docs_required": False, "verification_required": False, "prompt": "p",
            "success_criteria": [], "must_not": [], "expect_changes": True}), encoding="utf-8")

    def test_repair_empty_stdout(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        self._setup(task_file, workdir)
        calls = {"n": 0}
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            calls["n"] += 1
            (workdir / "a.py").write_text("x", encoding="utf-8")
            if calls["n"] == 1:
                return 0, json.dumps({"result": "did work, no footer"}), ""
            return 0, "", ""  # repair returns empty stdout
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        attempts = json.loads((output_dir / "summary-repair-attempts.json").read_text(encoding="utf-8"))
        assert any("missing or empty" in a.get("error", "") for a in attempts)

    def test_repair_invalid_json(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        self._setup(task_file, workdir)
        calls = {"n": 0}
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            calls["n"] += 1
            (workdir / "a.py").write_text("x", encoding="utf-8")
            if calls["n"] == 1:
                return 0, json.dumps({"result": "did work, no footer"}), ""
            return 0, "not json", ""  # repair returns invalid JSON
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        attempts = json.loads((output_dir / "summary-repair-attempts.json").read_text(encoding="utf-8"))
        assert any("invalid" in a.get("error", "") for a in attempts)

    def test_repair_empty_result_text(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        self._setup(task_file, workdir)
        calls = {"n": 0}
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            calls["n"] += 1
            (workdir / "a.py").write_text("x", encoding="utf-8")
            if calls["n"] == 1:
                return 0, json.dumps({"result": "did work, no footer"}), ""
            return 0, json.dumps({"result": "", "subtype": "done"}), ""  # valid JSON, empty text
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        attempts = json.loads((output_dir / "summary-repair-attempts.json").read_text(encoding="utf-8"))
        assert any("missing or empty" in a.get("error", "") for a in attempts)

    def test_repair_generic_exception(self, module, monkeypatch, tmp_path):
        m, repo_root, workdir, output_dir, task_file = module
        self._clean(workdir)
        self._setup(task_file, workdir)
        calls = {"n": 0}
        def fake(prompt, dbg, errp, max_turns=None, max_output_tokens=None):
            calls["n"] += 1
            (workdir / "a.py").write_text("x", encoding="utf-8")
            if calls["n"] == 1:
                return 0, json.dumps({"result": "did work, no footer"}), ""
            raise RuntimeError("repair boom")
        monkeypatch.setattr(m, "run_claude", fake)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        m.main()
        attempts = json.loads((output_dir / "summary-repair-attempts.json").read_text(encoding="utf-8"))
        assert any("runner exception" in a.get("error", "") for a in attempts)
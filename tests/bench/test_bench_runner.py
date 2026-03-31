import importlib.util
import json
from pathlib import Path


def load_runner_module(tmp_path, monkeypatch):
    repo_root = Path(__file__).resolve().parents[2]
    task_file = tmp_path / "task.json"
    task_file.write_text("{}", encoding="utf-8")

    monkeypatch.setenv("BENCH_REPO_ROOT", str(repo_root))
    monkeypatch.setenv("BENCH_TASK_FILE", str(task_file))
    monkeypatch.setenv("BENCH_WORKDIR", str(tmp_path / "workdir"))
    monkeypatch.setenv("BENCH_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setenv("OLLAMA_MODEL", "test-model")

    module_path = repo_root / "scripts" / "bench_runner_claude_code.py"
    spec = importlib.util.spec_from_file_location("bench_runner_claude_code", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_transcript(path, events):
    with path.open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(event) + "\n")


def test_required_transcript_patterns_ignore_user_only_mentions(tmp_path, monkeypatch):
    runner = load_runner_module(tmp_path, monkeypatch)
    transcript_path = tmp_path / "session.jsonl"
    write_transcript(
        transcript_path,
        [
            {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "Start with @e"}]}},
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Task: Docs - small note"}]}},
        ],
    )

    scanned, misses = runner.required_transcript_pattern_misses(
        {"required_transcript_patterns": [r"@e"]},
        {"transcript_path": str(transcript_path)},
    )

    assert scanned is True
    assert misses == [r"@e"]


def test_required_transcript_patterns_match_assistant_entries(tmp_path, monkeypatch):
    runner = load_runner_module(tmp_path, monkeypatch)
    transcript_path = tmp_path / "session.jsonl"
    write_transcript(
        transcript_path,
        [
            {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Task: Explore - repo map\nLocations: calculator.py, test_calculator.py"}]}},
            {"type": "result", "result": "Outcome: mapped the fixture.\nChanged files: README.md\nVerification status: not run - docs-only mapping.\nRemaining risks: none"},
        ],
    )

    scanned, misses = runner.required_transcript_pattern_misses(
        {"required_transcript_patterns": [r"Task:\s*Explore", r"Locations:"]},
        {"transcript_path": str(transcript_path)},
    )

    assert scanned is True
    assert misses == []


def test_required_transcript_patterns_report_unavailable_transcript(tmp_path, monkeypatch):
    runner = load_runner_module(tmp_path, monkeypatch)

    scanned, misses = runner.required_transcript_pattern_misses(
        {"required_transcript_patterns": [r"Findings:"]},
        {"transcript_path": str(tmp_path / "missing.jsonl")},
    )

    assert scanned is False
    assert misses == ["<assistant transcript unavailable>"]


def test_forbidden_transcript_patterns_catch_footer_repair_meta_chatter(tmp_path, monkeypatch):
    runner = load_runner_module(tmp_path, monkeypatch)
    transcript_path = tmp_path / "session.jsonl"
    write_transcript(
        transcript_path,
        [
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "text",
                            "text": "I see the issue - my markdown bold syntax is breaking the prefix match.",
                        }
                    ],
                },
            }
        ],
    )

    scanned, hits = runner.forbidden_transcript_pattern_hits(
        {"forbidden_transcript_patterns": [r"I see the issue", r"prefix match"]},
        {"transcript_path": str(transcript_path)},
    )

    assert scanned is True
    assert len(hits) == 2


def test_forbidden_transcript_patterns_ignore_user_only_mentions(tmp_path, monkeypatch):
    runner = load_runner_module(tmp_path, monkeypatch)
    transcript_path = tmp_path / "session.jsonl"
    write_transcript(
        transcript_path,
        [
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "Do not say: I see the issue or prefix match."}],
                },
            },
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Task: Explore - repo map\nLocations: calculator.py"}],
                },
            },
        ],
    )

    scanned, hits = runner.forbidden_transcript_pattern_hits(
        {"forbidden_transcript_patterns": [r"I see the issue", r"prefix match"]},
        {"transcript_path": str(transcript_path)},
    )

    assert scanned is True
    assert hits == []


def test_completed_task_recovery_mode_accepts_max_turns_after_successful_completion(tmp_path, monkeypatch):
    runner = load_runner_module(tmp_path, monkeypatch)

    recovery = runner.completed_task_recovery_mode(
        exit_code=1,
        payload_subtype="error_max_turns",
        fatal_error="",
        completed=True,
        verification_required=True,
        tests_run=True,
        tests_passed=True,
        verification_summary_present=True,
        review_required=True,
        review_present=True,
        risks_present=True,
        docs_required=True,
        docs_updated=True,
        category="bugfix",
        non_doc_changed_files=["calculator.py"],
        doc_pattern_hits=[],
    )

    assert recovery == "max_turns"


def test_completed_task_recovery_mode_rejects_max_turns_without_required_review(tmp_path, monkeypatch):
    runner = load_runner_module(tmp_path, monkeypatch)

    recovery = runner.completed_task_recovery_mode(
        exit_code=1,
        payload_subtype="error_max_turns",
        fatal_error="",
        completed=True,
        verification_required=True,
        tests_run=True,
        tests_passed=True,
        verification_summary_present=True,
        review_required=True,
        review_present=False,
        risks_present=True,
        docs_required=False,
        docs_updated=False,
        category="bugfix",
        non_doc_changed_files=["calculator.py"],
        doc_pattern_hits=[],
    )

    assert recovery == "none"


def test_completed_task_recovery_mode_accepts_max_turns_with_zero_exit_when_contract_is_satisfied(
    tmp_path, monkeypatch
):
    runner = load_runner_module(tmp_path, monkeypatch)

    recovery = runner.completed_task_recovery_mode(
        exit_code=0,
        payload_subtype="error_max_turns",
        fatal_error="Claude result text is missing or empty.",
        completed=True,
        verification_required=True,
        tests_run=True,
        tests_passed=True,
        verification_summary_present=True,
        review_required=True,
        review_present=True,
        risks_present=True,
        docs_required=True,
        docs_updated=True,
        category="bugfix",
        non_doc_changed_files=["calculator.py"],
        doc_pattern_hits=[],
    )

    assert recovery == "max_turns"

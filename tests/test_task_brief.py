"""Tests for scripts/task-brief.sh.

task-brief extracts task N's full text from a plan file (where each task is a
"## Task N: title" markdown header) to a brief file and prints the path. Tests
use CLAUDE_CREW_BRIEF_DIR pointed at tmp_path so they never touch the real
repo's .claude-crew/ scratch directory.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "task-brief.sh"

PLAN = """\
# Plan: widget feature

Some preamble. Use it like:

```
make install
```

## Task 1: Scaffold

Create the module.

### Steps
- add file

## Task 2: Implement core

Write the widget.

### Subsection inside task 2

Details here.

```
## this looks like a header but is inside a code block
keep me
```

## Task 3: Verify

Run tests.
"""


def _run_brief(plan_file: Path, n: str, brief_dir: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["CLAUDE_CREW_BRIEF_DIR"] = str(brief_dir)
    return subprocess.run(
        ["bash", str(SCRIPT), str(plan_file), n],
        capture_output=True, text=True, env=env, cwd=str(REPO_ROOT),
    )


def test_task_brief_extracts_named_task(tmp_path):
    plan = tmp_path / "plan.md"
    plan.write_text(PLAN, encoding="utf-8")
    brief_dir = tmp_path / "briefs"

    result = _run_brief(plan, "2", brief_dir)
    assert result.returncode == 0, result.stderr
    printed = result.stdout.strip()
    assert printed.endswith("task-2-brief.md")
    assert printed == str(brief_dir / "task-2-brief.md")

    body = (brief_dir / "task-2-brief.md").read_text(encoding="utf-8")
    assert "## Task 2: Implement core" in body
    assert "### Subsection inside task 2" in body
    # Fence tracking: the code-block line that looks like a header is kept,
    # and it does NOT terminate the task.
    assert "## this looks like a header but is inside a code block" in body
    assert "keep me" in body
    # Task 3 must not leak into task 2's brief.
    assert "Task 3: Verify" not in body
    assert "Task 1: Scaffold" not in body


def test_task_brief_distinct_tasks(tmp_path):
    plan = tmp_path / "plan.md"
    plan.write_text(PLAN, encoding="utf-8")
    brief_dir = tmp_path / "briefs"

    result = _run_brief(plan, "1", brief_dir)
    assert result.returncode == 0, result.stderr
    body = (brief_dir / "task-1-brief.md").read_text(encoding="utf-8")
    assert "## Task 1: Scaffold" in body
    assert "### Steps" in body
    assert "Task 2" not in body


def test_task_brief_missing_task_exits_nonzero(tmp_path):
    plan = tmp_path / "plan.md"
    plan.write_text(PLAN, encoding="utf-8")
    brief_dir = tmp_path / "briefs"

    result = _run_brief(plan, "99", brief_dir)
    assert result.returncode == 1
    assert "task 99 not found" in result.stderr
    assert not (brief_dir / "task-99-brief.md").exists()


def test_task_brief_bad_number_exits_2(tmp_path):
    plan = tmp_path / "plan.md"
    plan.write_text(PLAN, encoding="utf-8")
    result = _run_brief(plan, "abc", tmp_path / "briefs")
    assert result.returncode == 2


def test_task_brief_missing_plan_exits_2(tmp_path):
    result = _run_brief(tmp_path / "nope.md", "1", tmp_path / "briefs")
    assert result.returncode == 2
    assert "plan file not found" in result.stderr
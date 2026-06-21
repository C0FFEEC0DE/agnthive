"""Tests for scripts/review-package.sh.

review-package writes a review package (commits + diffstat + full diff) for
BASE..HEAD to a uniquely named file and prints the path. Tests build a hermetic
git repo under tmp_path and use CLAUDE_CREW_REVIEW_DIR so they never touch the
real repo's .claude-crew/ scratch directory.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "review-package.sh"


def _git_env(tmp_path: Path) -> dict:
    env = dict(os.environ)
    env["HOME"] = str(tmp_path / "home")
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    # Pin commit timestamps so synthetic commit hashes are deterministic across
    # runs. Without this, hashes derive from the wall clock and a `git log
    # --oneline` short hash can randomly contain a literal like "c1", making
    # subject-based assertions flaky.
    env["GIT_AUTHOR_DATE"] = "2020-01-01T00:00:00"
    env["GIT_COMMITTER_DATE"] = "2020-01-01T00:00:00"
    return env


def _git(repo: Path, env: dict, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, env=env,
    )


def _commit(repo: Path, env: dict, msg: str, content: str) -> str:
    (repo / "a.txt").write_text(content, encoding="utf-8")
    _git(repo, env, "add", "a.txt").check_returncode()
    _git(
        repo, env, "-c", "user.name=t", "-c", "user.email=t@t",
        "commit", "-q", "-m", msg,
    ).check_returncode()
    return _git(repo, env, "rev-parse", "HEAD").stdout.strip()


def _run_pkg(repo: Path, env: dict, base: str, head: str, review_dir: Path) -> subprocess.CompletedProcess:
    e = dict(env)
    e["CLAUDE_CREW_REVIEW_DIR"] = str(review_dir)
    return subprocess.run(
        ["bash", str(SCRIPT), base, head],
        capture_output=True, text=True, env=e, cwd=str(repo),
    )


def test_review_package_base_to_head(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    env = _git_env(tmp_path)
    _git(repo, env, "init", "-q", "-b", "main").check_returncode()
    base = _commit(repo, env, "c1", "a\n")
    head = _commit(repo, env, "c2", "a\nb\n")
    review_dir = tmp_path / "reviews"

    result = _run_pkg(repo, env, base, head, review_dir)
    assert result.returncode == 0, result.stderr
    printed = result.stdout.strip()
    assert printed.endswith("-review.md")
    assert printed.startswith(str(review_dir))

    body = Path(printed).read_text(encoding="utf-8")
    assert "Review package:" in body
    assert "## Commits" in body
    assert "c2" in body
    # base..head must list only the c2 commit, not the base c1. Assert on commit
    # subjects (the `git log --oneline` message), not raw substrings — a short
    # hash can coincidentally contain "c1".
    commits_block = body.split("## Commits")[1].split("## Diffstat")[0]
    subject_lines = [
        ln for ln in commits_block.splitlines()
        if ln.strip() and not ln.strip().startswith("```")
    ]
    subjects = {ln.split(" ", 1)[1] if " " in ln else ln for ln in subject_lines}
    assert "c2" in subjects
    assert "c1" not in subjects
    assert "## Diffstat" in body
    assert "## Full diff (-U10)" in body
    assert "```diff" in body
    assert "+b" in body


def test_review_package_merge_base(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    env = _git_env(tmp_path)
    _git(repo, env, "init", "-q", "-b", "main").check_returncode()
    base = _commit(repo, env, "c1", "a\n")
    _git(repo, env, "checkout", "-q", "-b", "feat").check_returncode()
    _commit(repo, env, "c2", "a\nb\n")
    review_dir = tmp_path / "reviews"

    result = _run_pkg(repo, env, "MERGE_BASE", "HEAD", review_dir)
    assert result.returncode == 0, result.stderr
    printed = result.stdout.strip()
    body = Path(printed).read_text(encoding="utf-8")
    assert "+b" in body
    assert "c2" in body
    # merge-base of main and feat is c1; c1 should not appear as a commit in base..head
    assert base[:7] in printed  # filename carries the base short sha


def test_review_package_merge_base_origin_only(tmp_path):
    """MERGE_BASE must resolve via origin/main when no local main exists.

    Regression guard: an earlier version set default_branch='main' whenever
    origin/main verified, then called `git merge-base main HEAD`, which fails
    in a clone that has origin/main but no local main. This builds exactly that
    shape (origin/main present, local main deleted) and expects success.
    """
    remote = tmp_path / "remote.git"
    remote.mkdir()
    env = _git_env(tmp_path)
    _git(remote, env, "init", "-q", "--bare").check_returncode()
    src = tmp_path / "src"
    src.mkdir()
    _git(src, env, "init", "-q", "-b", "main").check_returncode()
    _commit(src, env, "c1", "a\n")
    _git(src, env, "remote", "add", "origin", str(remote)).check_returncode()
    _git(src, env, "push", "-q", "origin", "main").check_returncode()
    # Point the bare remote's HEAD at main so the clone checks out a local main.
    _git(remote, env, "symbolic-ref", "HEAD", "refs/heads/main").check_returncode()

    repo = tmp_path / "repo"
    subprocess.run(
        ["git", "clone", "-q", str(remote), str(repo)],
        capture_output=True, text=True, env=env, cwd=str(tmp_path),
    ).check_returncode()
    _git(repo, env, "checkout", "-q", "-b", "feat").check_returncode()
    _commit(repo, env, "c2", "a\nb\n")
    # Remove local main so only origin/main remains for the default-branch fallback.
    _git(repo, env, "branch", "-D", "main").check_returncode()
    _git(repo, env, "remote", "set-head", "origin", "main").check_returncode()

    review_dir = tmp_path / "reviews"
    result = _run_pkg(repo, env, "MERGE_BASE", "HEAD", review_dir)
    assert result.returncode == 0, result.stderr
    body = Path(result.stdout.strip()).read_text(encoding="utf-8")
    assert "+b" in body
    assert "c2" in body


def test_review_package_not_in_git_repo_exits_2(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    env = _git_env(tmp_path)
    result = subprocess.run(
        ["bash", str(SCRIPT), "HEAD~1", "HEAD"],
        capture_output=True, text=True, env=env, cwd=str(empty),
    )
    assert result.returncode == 2
    assert "not inside a git work tree" in result.stderr


def test_review_package_bad_usage_exits_2(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    env = _git_env(tmp_path)
    _git(repo, env, "init", "-q", "-b", "main").check_returncode()
    result = subprocess.run(
        ["bash", str(SCRIPT), "HEAD"],
        capture_output=True, text=True, env=env, cwd=str(repo),
    )
    assert result.returncode == 2
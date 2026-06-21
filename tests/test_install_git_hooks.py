"""Tests for scripts/install-git-hooks.sh.

install-git-hooks copies the bundled pre-push secret-scan hook into the
current repo's .git/hooks. These tests build a hermetic git repo, run the
installer, and assert the hook lands in place, is executable, and is
byte-identical to the source — and that the installer refuses when the
source hook is absent.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "install-git-hooks.sh"
SRC_HOOK = REPO_ROOT / "scripts" / "git-hooks" / "pre-push"


def _git_env(tmp_path: Path) -> dict:
    env = dict(os.environ)
    env["HOME"] = str(tmp_path / "home")
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    return env


def _make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    env = _git_env(tmp_path)
    subprocess.run(["git", "init", "-q"], cwd=repo, env=env, check=True)
    subprocess.run(["git", "config", "user.email", "t@t"], cwd=repo, env=env, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, env=env, check=True)
    return repo


def test_installs_pre_push_hook(tmp_path):
    repo = _make_repo(tmp_path)
    env = _git_env(tmp_path)
    r = subprocess.run(["bash", str(SCRIPT)], cwd=repo, capture_output=True, text=True, env=env)
    assert r.returncode == 0
    dest = repo / ".git" / "hooks" / "pre-push"
    assert dest.is_file()
    assert os.access(dest, os.X_OK)
    assert dest.read_bytes() == SRC_HOOK.read_bytes()
    assert "Installed pre-push secret-scan hook" in r.stdout
    assert "To remove:" in r.stdout


def test_is_idempotent(tmp_path):
    repo = _make_repo(tmp_path)
    env = _git_env(tmp_path)
    subprocess.run(["bash", str(SCRIPT)], cwd=repo, env=env, check=True)
    # Second run must not error and must keep the hook identical.
    r = subprocess.run(["bash", str(SCRIPT)], cwd=repo, capture_output=True, text=True, env=env)
    assert r.returncode == 0
    assert (repo / ".git" / "hooks" / "pre-push").read_bytes() == SRC_HOOK.read_bytes()


def test_missing_source_exits_one(tmp_path, monkeypatch):
    # Point SCRIPT_DIR at an empty temp dir by running a copy of the script
    # whose sibling git-hooks/ has no pre-push. We simulate the missing-source
    # branch by running the real script from a directory that lacks the source.
    repo = _make_repo(tmp_path)
    env = _git_env(tmp_path)
    # Temporarily hide the real source by running the script through a wrapper
    # that overrides SCRIPT_DIR to an empty dir.
    fake_dir = tmp_path / "fake-scripts"
    fake_dir.mkdir()
    fake_git_hooks = fake_dir / "git-hooks"
    fake_git_hooks.mkdir()
    # Symlink would still resolve; copy the script but not the hook source.
    fake_script = fake_dir / "install-git-hooks.sh"
    fake_script.write_text(SCRIPT.read_text())
    os.chmod(fake_script, 0o755)
    r = subprocess.run(["bash", str(fake_script)], cwd=repo, capture_output=True, text=True, env=env)
    assert r.returncode == 1
    assert "source hook not found" in r.stderr
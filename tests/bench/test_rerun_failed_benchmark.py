"""Tests for scripts/rerun-failed-benchmark.sh.

rerun-failed-benchmark triggers the smoke benchmark workflow via `gh` with a
selection mode (auto_resume by default; resume when --run-id is given). These
tests stub gh/git/sleep on PATH so the argparse, ref-resolution, auth/view
guards, and dispatch modes are exercised hermetically — no network, no real
gh.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "rerun-failed-benchmark.sh"


def _make_stubs(tmp_path: Path) -> tuple[Path, Path]:
    """Create a fake bin/ with gh, git, sleep stubs. Returns (bindir, calls_file)."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    calls = tmp_path / "calls.log"

    gh = bindir / "gh"
    gh.write_text(
        "#!/bin/bash\n"
        "echo \"gh $*\" >> \"$GH_CALLS_FILE\"\n"
        "case \"$1\" in\n"
        "  auth)\n"
        "    [ \"$GH_AUTH_FAIL\" != \"1\" ] && exit 0; exit 1;;\n"
        "  workflow)\n"
        "    if [ \"$2\" = \"view\" ]; then\n"
        "      [ \"$GH_VIEW_FAIL\" != \"1\" ] && exit 0; exit 1\n"
        "    fi\n"
        "    # `workflow run` and any other subcommand succeed.\n"
        "    exit 0;;\n"
        "  run)\n"
        "    # `run list --json ...` must emit JSON the --jq filter can consume.\n"
        "    printf '[{\"databaseId\":123,\"url\":\"http://x/123\",\"status\":\"in_progress\",\"createdAt\":\"t\"}]\\n'\n"
        "    exit 0;;\n"
        "  *) exit 0;;\n"
        "esac\n"
    )
    os.chmod(gh, 0o755)

    git = bindir / "git"
    git.write_text(
        "#!/bin/bash\n"
        "if [ \"$1\" = \"rev-parse\" ] && [ \"$2\" = \"--abbrev-ref\" ]; then\n"
        "  if [ -z \"$FAKE_GIT_REF\" ]; then exit 1; fi\n"
        "  printf '%s\\n' \"$FAKE_GIT_REF\"\n"
        "  exit 0\n"
        "fi\n"
        "exit 0\n"
    )
    os.chmod(git, 0o755)

    sleep = bindir / "sleep"
    sleep.write_text("#!/bin/bash\nexit 0\n")
    os.chmod(sleep, 0o755)

    return bindir, calls


def _run(tmp_path: Path, *args, env_extra: dict | None = None) -> subprocess.CompletedProcess:
    bindir, calls = _make_stubs(tmp_path)
    env = dict(os.environ)
    env["PATH"] = f"{bindir}:{env['PATH']}"
    env["HOME"] = str(tmp_path / "home")
    env["GH_CALLS_FILE"] = str(calls)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(["bash", str(SCRIPT), *args],
                          capture_output=True, text=True, env=env)


def _calls(tmp_path: Path) -> list[str]:
    calls = tmp_path / "calls.log"
    if not calls.exists():
        return []
    return calls.read_text().splitlines()


def test_help_exits_zero(tmp_path):
    r = _run(tmp_path, "--help")
    assert r.returncode == 0
    assert "Usage:" in r.stdout
    assert "auto_resume" in r.stdout


def test_unknown_arg_exits_two(tmp_path):
    r = _run(tmp_path, "--bogus", env_extra={"FAKE_GIT_REF": "main"})
    assert r.returncode == 2
    assert "unknown argument" in r.stderr


def test_run_id_without_value_exits_two(tmp_path):
    r = _run(tmp_path, "--run-id")
    assert r.returncode == 2
    assert "--run-id needs a value" in r.stderr


def test_ref_without_value_exits_two(tmp_path):
    r = _run(tmp_path, "--ref")
    assert r.returncode == 2
    assert "--ref needs a value" in r.stderr


def test_detached_head_exits_two(tmp_path):
    # git rev-parse prints "HEAD" -> script refuses.
    r = _run(tmp_path, env_extra={"FAKE_GIT_REF": "HEAD"})
    assert r.returncode == 2
    assert "detached HEAD" in r.stderr


def test_no_ref_no_git_exits_two(tmp_path):
    # FAKE_GIT_REF unset -> git rev-parse exits 1 -> empty ref -> refuse.
    r = _run(tmp_path)
    assert r.returncode == 2
    assert "could not determine current branch" in r.stderr


def test_auth_failure_exits_two(tmp_path):
    r = _run(tmp_path, "--ref", "main", env_extra={"GH_AUTH_FAIL": "1"})
    assert r.returncode == 2
    assert "gh is not authenticated" in r.stderr


def test_workflow_missing_on_ref_exits_two(tmp_path):
    r = _run(tmp_path, "--ref", "main", env_extra={"GH_VIEW_FAIL": "1"})
    assert r.returncode == 2
    assert "not found on ref" in r.stderr


def test_auto_resume_dispatch(tmp_path):
    r = _run(tmp_path, "--ref", "main")
    assert r.returncode == 0
    assert "auto_resume mode" in r.stdout
    calls = _calls(tmp_path)
    assert any("workflow run" in c and "selection_mode=auto_resume" in c for c in calls)
    # run list is scoped to the branch.
    assert any("run list" in c and "--branch=main" in c for c in calls)


def test_resume_dispatch_with_run_id(tmp_path):
    r = _run(tmp_path, "--run-id", "27872932481", "--ref", "main")
    assert r.returncode == 0
    assert "resume mode" in r.stdout
    assert "run_id=27872932481" in r.stdout
    calls = _calls(tmp_path)
    assert any("workflow run" in c and "selection_mode=resume" in c
               and "resume_run_id=27872932481" in c for c in calls)


def test_ref_defaults_to_current_branch(tmp_path):
    # No --ref: script resolves via git -> FAKE_GIT_REF.
    r = _run(tmp_path, env_extra={"FAKE_GIT_REF": "develop"})
    assert r.returncode == 0
    calls = _calls(tmp_path)
    assert any("--ref develop" in c for c in calls)
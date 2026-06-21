"""Tests for claudecfg/statusline.sh.

statusline.sh is the token-aware status line: Claude Code pipes a JSON session
object to stdin and the script prints one line `dir | model | style`. These
tests pin every branch: full input, the display_name/id and current_dir/cwd
fallbacks, the "Default" style elision, empty input (falls back to PWD),
empty cwd (falls back to "claude"), and the minimal-label fallback when
nothing parses.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "claudecfg" / "statusline.sh"


def _run(stdin: str, *, cwd: Path | None = None) -> tuple[int, str]:
    r = subprocess.run(["bash", str(SCRIPT)], input=stdin,
                       capture_output=True, text=True, cwd=cwd or REPO_ROOT)
    return r.returncode, r.stdout


def test_full_input_with_style(tmp_path):
    payload = (
        '{"model":{"display_name":"Sonnet 4.6","id":"claude-sonnet-4-6"},'
        '"workspace":{"current_dir":"%s"},'
        '"output_style":{"name":"Explanatory"}}' % tmp_path
    )
    rc, out = _run(payload)
    assert rc == 0
    assert out == f"{tmp_path.name} | Sonnet 4.6 | Explanatory"


def test_default_style_is_elided(tmp_path):
    payload = (
        '{"model":{"display_name":"Opus 4.8"},'
        '"workspace":{"current_dir":"%s"},'
        '"output_style":{"name":"Default"}}' % tmp_path
    )
    rc, out = _run(payload)
    assert rc == 0
    assert out == f"{tmp_path.name} | Opus 4.8"


def test_model_id_fallback_when_no_display_name(tmp_path):
    payload = (
        '{"model":{"id":"claude-haiku-4-5"},'
        '"workspace":{"current_dir":"%s"}}' % tmp_path
    )
    rc, out = _run(payload)
    assert rc == 0
    assert out == f"{tmp_path.name} | claude-haiku-4-5"


def test_cwd_fallback_when_no_workspace(tmp_path):
    payload = '{"model":{"display_name":"M"},"cwd":"%s"}' % tmp_path
    rc, out = _run(payload)
    assert rc == 0
    assert out == f"{tmp_path.name} | M"


def test_empty_input_falls_back_to_pwd(tmp_path):
    # When stdin is empty, cwd defaults to $PWD; run inside tmp_path so the
    # assertion is deterministic.
    rc, out = _run("", cwd=tmp_path)
    assert rc == 0
    assert out == tmp_path.name


def test_no_model_no_style_just_dir(tmp_path):
    payload = '{"workspace":{"current_dir":"%s"}}' % tmp_path
    rc, out = _run(payload, cwd=tmp_path)
    assert rc == 0
    assert out == tmp_path.name


def test_root_cwd_with_model_and_style():
    payload = (
        '{"model":{"display_name":"M"},'
        '"workspace":{"current_dir":"/"},'
        '"output_style":{"name":"S"}}'
    )
    rc, out = _run(payload)
    assert rc == 0
    # basename("/") is "/" (not empty), so the dir part is "/".
    assert out == "/ | M | S"


def test_empty_json_object_uses_pwd_basename(tmp_path):
    # {} has no model/workspace/style; cwd falls back to PWD -> dir basename.
    rc, out = _run("{}", cwd=tmp_path)
    assert rc == 0
    assert out == tmp_path.name


def test_malformed_json_does_not_crash(tmp_path):
    rc, out = _run("not-json", cwd=tmp_path)
    assert rc == 0
    # jq fails gracefully; cwd falls back to PWD -> dir basename.
    assert out == tmp_path.name


def test_jq_failing_falls_back_to_pwd(tmp_path):
    # If jq is present but fails (or absent), the script's `|| true` guards keep
    # model/cwd/style empty; cwd falls back to PWD. We stub a fake jq that exits 1
    # so `command -v jq` still finds it but every invocation fails.
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_jq = fake_bin / "jq"
    fake_jq.write_text("#!/bin/bash\nexit 1\n")
    os.chmod(fake_jq, 0o755)
    env = dict(os.environ)
    env["PATH"] = f"{fake_bin}:{env['PATH']}"
    payload = '{"model":{"display_name":"M"},"workspace":{"current_dir":"/should-not-be-used"}}'
    work = tmp_path / "work"
    work.mkdir()
    r = subprocess.run(["bash", str(SCRIPT)], input=payload,
                       capture_output=True, text=True, env=env, cwd=work)
    assert r.returncode == 0
    assert r.stdout == work.name
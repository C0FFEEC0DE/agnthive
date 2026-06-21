import importlib.util
import io
import json
import urllib.error
import zipfile
from io import BytesIO
from pathlib import Path

import pytest


def load_download_module():
    repo_root = Path(__file__).resolve().parents[2]
    module_path = repo_root / "scripts" / "download-benchmark-summary.py"
    spec = importlib.util.spec_from_file_location("download_benchmark_summary", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def build_zip(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def test_find_artifact_returns_named_nonexpired_artifact():
    module = load_download_module()
    artifact = module.find_artifact(
        [
            {"id": 1, "name": "other", "expired": False},
            {"id": 2, "name": "behavior-benchmark-smoke-123", "expired": False},
        ],
        "behavior-benchmark-smoke-123",
    )

    assert artifact["id"] == 2


def test_find_artifact_rejects_expired_match():
    module = load_download_module()
    with pytest.raises(RuntimeError, match="Artifact not found or expired"):
        module.find_artifact(
            [{"id": 2, "name": "behavior-benchmark-smoke-123", "expired": True}],
            "behavior-benchmark-smoke-123",
        )


def test_extract_summary_bytes_reads_nested_summary_json():
    module = load_download_module()
    summary_bytes = module.extract_summary_bytes(
        build_zip(
            {
                "bench-output/summary.json": '{"status":"ok"}',
                "bench-output/benchmark-report.md": "# report",
            }
        )
    )

    assert json.loads(summary_bytes.decode("utf-8")) == {"status": "ok"}


def test_extract_summary_bytes_requires_summary_file():
    module = load_download_module()
    with pytest.raises(RuntimeError, match="summary.json"):
        module.extract_summary_bytes(build_zip({"report.md": "missing summary"}))


def test_download_summary_fetches_artifact_listing_then_redirected_zip(monkeypatch):
    module = load_download_module()
    calls = []

    def fake_get_json(url, token):
        calls.append(("json", url, token))
        return {
            "artifacts": [
                {"id": 42, "name": "behavior-benchmark-smoke-123", "expired": False},
            ]
        }

    def fake_get_redirect_url(url, token):
        calls.append(("redirect", url, token))
        return "https://example.invalid/artifact.zip"

    def fake_public_get_bytes(url):
        calls.append(("public-bytes", url))
        return build_zip({"summary.json": '{"ok": true}'})

    monkeypatch.setattr(module, "github_get_json", fake_get_json)
    monkeypatch.setattr(module, "github_get_redirect_url", fake_get_redirect_url)
    monkeypatch.setattr(module, "public_get_bytes", fake_public_get_bytes)

    summary = module.download_summary("octo/repo", 123, "behavior-benchmark-smoke-123", "token")

    assert json.loads(summary.decode("utf-8")) == {"ok": True}
    assert calls == [
        ("json", "https://api.github.com/repos/octo/repo/actions/runs/123/artifacts", "token"),
        ("redirect", "https://api.github.com/repos/octo/repo/actions/artifacts/42/zip", "token"),
        ("public-bytes", "https://example.invalid/artifact.zip"),
    ]


# ---- NoRedirectHandler ----

class TestNoRedirectHandler:
    def test_301_returns_fp_unchanged(self):
        module = load_download_module()
        handler = module.NoRedirectHandler()
        fp = object()
        result = handler.http_error_301(req=None, fp=fp, code=301, msg="moved", headers={})
        assert result is fp

    def test_302_returns_fp_unchanged(self):
        module = load_download_module()
        handler = module.NoRedirectHandler()
        fp = object()
        result = handler.http_error_302(req=None, fp=fp, code=302, msg="found", headers={})
        assert result is fp
        # 303/307/308 are aliased to 302 (compare underlying functions, not
        # freshly-created bound-method wrappers)
        assert handler.http_error_303.__func__ is handler.http_error_302.__func__
        assert handler.http_error_307.__func__ is handler.http_error_302.__func__
        assert handler.http_error_308.__func__ is handler.http_error_302.__func__


# ---- HTTP helpers (mocked urllib) ----

class _FakeResp:
    def __init__(self, body=b"", headers=None):
        self._b = body
        self.headers = headers if headers is not None else {}

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeOpener:
    def __init__(self, resp):
        self._resp = resp
        self.opened = []

    def open(self, req, timeout=None):
        self.opened.append(req)
        return self._resp


class TestGithubRequest:
    def test_follow_redirects_uses_urlopen(self, monkeypatch):
        module = load_download_module()
        opened = []
        resp = _FakeResp(b'{"ok":1}')
        monkeypatch.setattr(module.urllib.request, "urlopen", lambda req: opened.append(req) or resp)
        out = module.github_request("https://api/x", "tok")
        assert out is resp
        assert len(opened) == 1

    def test_no_redirect_uses_opener(self, monkeypatch):
        module = load_download_module()
        resp = _FakeResp(b"", headers={"Location": "https://objects/x"})
        opener = _FakeOpener(resp)
        monkeypatch.setattr(module, "NO_REDIRECT_OPENER", opener)
        out = module.github_request("https://api/x", "tok", follow_redirects=False)
        assert out is resp
        assert len(opener.opened) == 1


def test_github_get_json(monkeypatch):
    module = load_download_module()
    monkeypatch.setattr(
        module.urllib.request, "urlopen",
        lambda req: _FakeResp(b'{"a": 1}'),
    )
    assert module.github_get_json("https://api/x", "tok") == {"a": 1}


def test_github_get_bytes(monkeypatch):
    module = load_download_module()
    monkeypatch.setattr(
        module.urllib.request, "urlopen",
        lambda req: _FakeResp(b"\x01\x02"),
    )
    assert module.github_get_bytes("https://api/x", "tok") == b"\x01\x02"


class TestGithubGetRedirectUrl:
    def test_returns_location(self, monkeypatch):
        module = load_download_module()
        resp = _FakeResp(b"", headers={"Location": "https://objects/abc"})
        monkeypatch.setattr(module, "NO_REDIRECT_OPENER", _FakeOpener(resp))
        assert module.github_get_redirect_url("https://api/x", "tok") == "https://objects/abc"

    def test_missing_location_raises(self, monkeypatch):
        module = load_download_module()
        resp = _FakeResp(b"", headers={})
        monkeypatch.setattr(module, "NO_REDIRECT_OPENER", _FakeOpener(resp))
        with pytest.raises(RuntimeError, match="did not return a redirect location"):
            module.github_get_redirect_url("https://api/x", "tok")


def test_public_get_bytes(monkeypatch):
    module = load_download_module()
    monkeypatch.setattr(
        module.urllib.request, "urlopen",
        lambda req: _FakeResp(b"raw-bytes"),
    )
    assert module.public_get_bytes("https://objects/abc") == b"raw-bytes"


# ---- main ----

def _http_error(code, body=b""):
    import http.client
    msg = http.client.HTTPMessage()
    return urllib.error.HTTPError("https://api/x", code, "err", msg, BytesIO(body))


class TestMain:
    def _set_argv(self, monkeypatch, tmp_path, output=None):
        out = str(output or (tmp_path / "summary.json"))
        monkeypatch.setattr("sys.argv", [
            "download-benchmark-summary.py",
            "--repo", "octo/repo", "--run-id", "123",
            "--artifact-name", "behavior-benchmark-smoke-123",
            "--output", out,
        ])
        return out

    def test_missing_token_raises(self, monkeypatch, tmp_path):
        module = load_download_module()
        self._set_argv(monkeypatch, tmp_path)
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        with pytest.raises(RuntimeError, match="GITHUB_TOKEN is required"):
            module.main()

    def test_http_error_wrapped(self, monkeypatch, tmp_path):
        module = load_download_module()
        self._set_argv(monkeypatch, tmp_path)
        monkeypatch.setenv("GITHUB_TOKEN", "tok")
        monkeypatch.setattr(module, "download_summary",
                            lambda *a, **k: (_ for _ in ()).throw(_http_error(404, b"nope")))
        with pytest.raises(RuntimeError, match="HTTP 404"):
            module.main()

    def test_url_error_wrapped(self, monkeypatch, tmp_path):
        module = load_download_module()
        self._set_argv(monkeypatch, tmp_path)
        monkeypatch.setenv("GITHUB_TOKEN", "tok")
        monkeypatch.setattr(module, "download_summary",
                            lambda *a, **k: (_ for _ in ()).throw(urllib.error.URLError("conn")))
        with pytest.raises(RuntimeError, match="GitHub API request failed"):
            module.main()

    def test_success_writes_output(self, monkeypatch, tmp_path):
        module = load_download_module()
        out = self._set_argv(monkeypatch, tmp_path)
        monkeypatch.setenv("GITHUB_TOKEN", "tok")
        monkeypatch.setattr(module, "download_summary",
                            lambda *a, **k: b'{"status":"ok"}')
        module.main()
        assert Path(out).read_bytes() == b'{"status":"ok"}'

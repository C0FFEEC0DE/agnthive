"""Tests for the previously-uncovered functions in wait-for-benchmark-slot.py.

Covers parse_retry_after, handle_rate_limit, build_request,
fetch_active_behavior_runs, handle_transient_error, and main's control flow
(slot granted, rate-limit retry, 5xx retry, URLError exhaustion, missing
repo/token, timeout). Network and sleep boundaries are monkeypatched.
"""

import importlib.util
import json
import urllib.error
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from io import BytesIO
from pathlib import Path


def load_module():
    repo_root = Path(__file__).resolve().parents[2]
    module_path = repo_root / "scripts" / "wait-for-benchmark-slot.py"
    spec = importlib.util.spec_from_file_location("wait_for_benchmark_slot", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _http_error(code, body=b"", headers=None):
    import http.client
    msg = http.client.HTTPMessage()
    for k, v in (headers or {}).items():
        msg.add_header(k, v)
    return urllib.error.HTTPError("https://api.github.com", code, "err", msg, BytesIO(body))


# ---- parse_retry_after ----

class TestParseRetryAfter:
    def test_none(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.parse_retry_after(None) is None

    def test_empty_and_blank(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.parse_retry_after("") is None
        assert m.parse_retry_after("   ") is None

    def test_int_seconds(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.parse_retry_after("5") == 5
        assert m.parse_retry_after("0") == 0

    def test_negative_clamped_to_zero(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.parse_retry_after("-3") == 0

    def test_past_http_date_is_zero(self, monkeypatch, tmp_path):
        m = load_module()
        past = (datetime.now(timezone.utc) - timedelta(hours=2))
        assert m.parse_retry_after(format_datetime(past)) == 0

    def test_future_http_date_is_positive(self, monkeypatch, tmp_path):
        m = load_module()
        future = datetime.now(timezone.utc) + timedelta(seconds=120)
        assert m.parse_retry_after(format_datetime(future)) > 0

    def test_invalid_string_is_none(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.parse_retry_after("not-a-date") is None


# ---- handle_rate_limit ----

class TestHandleRateLimit:
    def test_uses_retry_after_header(self, monkeypatch, tmp_path):
        m = load_module()
        slept = []
        monkeypatch.setattr(m.time, "sleep", lambda s: slept.append(s))
        exc = _http_error(403, headers={"Retry-After": "10"})
        assert m.handle_rate_limit(exc) is None
        assert slept == [10]

    def test_defaults_to_60_without_header(self, monkeypatch, tmp_path):
        m = load_module()
        slept = []
        monkeypatch.setattr(m.time, "sleep", lambda s: slept.append(s))
        exc = _http_error(403)
        assert m.handle_rate_limit(exc) is None
        assert slept == [60]


# ---- build_request ----

def test_build_request_headers(monkeypatch, tmp_path):
    m = load_module()
    req = m.build_request("https://api.github.com/repos/o/r/actions/runs", "tok")
    assert req.full_url == "https://api.github.com/repos/o/r/actions/runs"
    headers = {k.lower(): v for k, v in req.header_items()}
    assert headers["authorization"] == "Bearer tok"
    assert headers["x-github-api-version"] == "2022-11-28"
    assert headers["accept"] == "application/vnd.github+json"
    assert headers["user-agent"] == "multi-agent-sdlc-crew-benchmark-slot-gate"


# ---- fetch_active_behavior_runs ----

class TestFetchActiveRuns:
    def _fake_urlopen(self, payload):
        body = json.dumps(payload).encode("utf-8")

        class _Resp:
            def __init__(self, b):
                self._b = b

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return self._b

        return lambda req, timeout=30: _Resp(body)

    def test_filters_by_workflow_sha_and_status(self, monkeypatch, tmp_path):
        m = load_module()
        sha = "abc123"
        payload = {"workflow_runs": [
            {"id": 1, "name": "Behavior Benchmark Subagents Smoke", "head_sha": sha,
             "status": "in_progress"},
            {"id": 2, "name": "Other Workflow", "head_sha": sha, "status": "in_progress"},
            {"id": 3, "name": "Behavior Benchmark Smoke", "head_sha": "other",
             "status": "in_progress"},
            {"id": 4, "name": "Behavior Benchmark Full", "head_sha": sha, "status": "completed"},
            {"id": 5, "name": "Behavior Benchmark Smoke", "head_sha": sha, "status": "queued"},
        ]}
        monkeypatch.setattr(m.urllib.request, "urlopen", self._fake_urlopen(payload))
        runs = m.fetch_active_behavior_runs(
            api_url="https://api.github.com", repo="o/r", token="t", head_sha=sha)
        ids = sorted(r["id"] for r in runs)
        # 1 (in_progress) and 5 (queued) match; 2 wrong name, 3 wrong sha, 4 completed
        assert ids == [1, 5]


# ---- handle_transient_error ----

class TestHandleTransientError:
    def test_retries_below_ceiling(self, monkeypatch, tmp_path):
        m = load_module()
        slept = []
        monkeypatch.setattr(m.time, "sleep", lambda s: slept.append(s))
        assert m.handle_transient_error(RuntimeError("x"), 0) is True
        assert slept == [1]  # 2**0

    def test_delay_grows_with_attempt(self, monkeypatch, tmp_path):
        m = load_module()
        slept = []
        monkeypatch.setattr(m.time, "sleep", lambda s: slept.append(s))
        # attempt 4 (< ceiling 5) -> 2**4 = 16
        assert m.handle_transient_error(RuntimeError("x"), 4) is True
        assert slept == [16]

    def test_stops_at_ceiling(self, monkeypatch, tmp_path):
        m = load_module()
        slept = []
        monkeypatch.setattr(m.time, "sleep", lambda s: slept.append(s))
        assert m.handle_transient_error(RuntimeError("x"), 5) is False
        assert slept == []


# ---- main ----

class TestMain:
    def _set_argv_env(self, monkeypatch, *, repo="o/r", token="tok"):
        monkeypatch.setattr("sys.argv", [
            "wait-for-benchmark-slot.py",
            "--current-run-id", "100",
            "--head-sha", "abc123def456",
            "--max-active", "2",
            "--poll-seconds", "1",
            "--timeout-seconds", "60",
            "--repo", repo,
        ])
        monkeypatch.setenv("GITHUB_TOKEN", token)

    def test_slot_granted_returns_0(self, monkeypatch, tmp_path, capsys):
        m = load_module()
        self._set_argv_env(monkeypatch)
        runs = [
            {"id": 100, "name": "Behavior Benchmark Smoke", "head_sha": "abc123def456",
             "status": "in_progress", "created_at": "2026-01-01T00:00:00Z"},
        ]
        monkeypatch.setattr(m, "fetch_active_behavior_runs", lambda **k: runs)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        assert m.main() == 0
        assert "has a benchmark slot" in capsys.readouterr().out

    def test_missing_repo_returns_2(self, monkeypatch, tmp_path, capsys):
        m = load_module()
        self._set_argv_env(monkeypatch, repo="")
        monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
        assert m.main() == 2
        assert "GITHUB_REPOSITORY" in capsys.readouterr().err

    def test_missing_token_returns_2(self, monkeypatch, tmp_path, capsys):
        m = load_module()
        self._set_argv_env(monkeypatch)
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        assert m.main() == 2
        assert "GITHUB_TOKEN" in capsys.readouterr().err

    def test_rate_limit_then_success(self, monkeypatch, tmp_path):
        m = load_module()
        self._set_argv_env(monkeypatch)
        runs = [{"id": 100, "name": "Behavior Benchmark Smoke",
                 "head_sha": "abc123def456", "status": "in_progress",
                 "created_at": "2026-01-01T00:00:00Z"}]
        calls = {"n": 0}

        def fake_fetch(**k):
            calls["n"] += 1
            if calls["n"] == 1:
                raise _http_error(403, b'{"message":"rate limit exceeded"}',
                                  headers={"X-RateLimit-Remaining": "0", "Retry-After": "0"})
            return runs

        monkeypatch.setattr(m, "fetch_active_behavior_runs", fake_fetch)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        assert m.main() == 0
        assert calls["n"] == 2

    def test_5xx_transient_then_success(self, monkeypatch, tmp_path):
        m = load_module()
        self._set_argv_env(monkeypatch)
        runs = [{"id": 100, "name": "Behavior Benchmark Smoke",
                 "head_sha": "abc123def456", "status": "in_progress",
                 "created_at": "2026-01-01T00:00:00Z"}]
        calls = {"n": 0}

        def fake_fetch(**k):
            calls["n"] += 1
            if calls["n"] == 1:
                raise _http_error(503, b"temp")
            return runs

        monkeypatch.setattr(m, "fetch_active_behavior_runs", fake_fetch)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        assert m.main() == 0

    def test_5xx_exhaustion_returns_1(self, monkeypatch, tmp_path):
        m = load_module()
        self._set_argv_env(monkeypatch)
        monkeypatch.setattr(m, "fetch_active_behavior_runs",
                            lambda **k: (_ for _ in ()).throw(_http_error(503, b"temp")))
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        assert m.main() == 1

    def test_urlerror_exhaustion_returns_1(self, monkeypatch, tmp_path):
        m = load_module()
        self._set_argv_env(monkeypatch)

        def fake_fetch(**k):
            raise urllib.error.URLError("conn refused")

        monkeypatch.setattr(m, "fetch_active_behavior_runs", fake_fetch)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        assert m.main() == 1

    def test_non_rate_limit_4xx_returns_1(self, monkeypatch, tmp_path):
        m = load_module()
        self._set_argv_env(monkeypatch)
        monkeypatch.setattr(m, "fetch_active_behavior_runs",
                            lambda **k: (_ for _ in ()).throw(_http_error(404, b"not found")))
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        assert m.main() == 1

    def test_timeout_returns_1(self, monkeypatch, tmp_path, capsys):
        m = load_module()
        self._set_argv_env(monkeypatch)
        # current run not in the active set -> never gets a slot
        runs = [{"id": 999, "name": "Behavior Benchmark Smoke",
                 "head_sha": "abc123def456", "status": "in_progress",
                 "created_at": "2026-01-01T00:00:00Z"}]
        monkeypatch.setattr(m, "fetch_active_behavior_runs", lambda **k: runs)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        # First monotonic() call sets the deadline; subsequent calls jump past it.
        ticks = iter([0, 10_000_000, 10_000_000])
        monkeypatch.setattr(m.time, "monotonic", lambda: next(ticks))
        assert m.main() == 1
        assert "Timed out" in capsys.readouterr().err

    def test_poll_sleeps_before_timeout(self, monkeypatch, tmp_path):
        m = load_module()
        self._set_argv_env(monkeypatch)
        runs = [{"id": 999, "name": "Behavior Benchmark Smoke",
                 "head_sha": "abc123def456", "status": "in_progress",
                 "created_at": "2026-01-01T00:00:00Z"}]
        monkeypatch.setattr(m, "fetch_active_behavior_runs", lambda **k: runs)
        slept = []
        monkeypatch.setattr(m.time, "sleep", lambda s: slept.append(s))
        # started=0 (deadline=60); iter1 deadline check=0 <60 -> sleep; iter2=10M -> timeout.
        ticks = iter([0, 0, 10_000_000])
        monkeypatch.setattr(m.time, "monotonic", lambda: next(ticks))
        assert m.main() == 1
        assert slept == [1]  # line 225 time.sleep(poll_seconds) executed once

    def test_rate_limit_handle_returns_nonzero_propagates(self, monkeypatch, tmp_path):
        m = load_module()
        self._set_argv_env(monkeypatch)
        monkeypatch.setattr(m, "fetch_active_behavior_runs",
                            lambda **k: (_ for _ in ()).throw(
                                _http_error(403, b'{"message":"rate limit exceeded"}',
                                            headers={"X-RateLimit-Remaining": "0"})))
        # handle_rate_limit normally returns None (retry); if it returns non-None
        # main propagates that value immediately.
        monkeypatch.setattr(m, "handle_rate_limit", lambda exc: 7)
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        assert m.main() == 7

    def test_4xx_body_read_failure_falls_back_to_bare_message(self, monkeypatch, tmp_path, capsys):
        m = load_module()
        self._set_argv_env(monkeypatch)

        class ReadFailHTTPError(urllib.error.HTTPError):
            def __init__(self, code):
                import http.client
                msg = http.client.HTTPMessage()
                super().__init__("https://api.github.com", code, "err", msg, BytesIO(b""))
                self.headers = msg  # FakeHeaders-like via HTTPMessage

            def read(self):
                raise OSError("body already consumed")

        monkeypatch.setattr(m, "fetch_active_behavior_runs",
                            lambda **k: (_ for _ in ()).throw(ReadFailHTTPError(404)))
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        assert m.main() == 1
        # body_snippet empty -> the bare "HTTP 404" message (no body snippet) is printed.
        assert "HTTP 404" in capsys.readouterr().err

    def test_4xx_empty_body_falls_back_to_bare_message(self, monkeypatch, tmp_path, capsys):
        m = load_module()
        self._set_argv_env(monkeypatch)
        monkeypatch.setattr(m, "fetch_active_behavior_runs",
                            lambda **k: (_ for _ in ()).throw(_http_error(404, b"")))
        monkeypatch.setattr(m.time, "sleep", lambda s: None)
        assert m.main() == 1
        err = capsys.readouterr().err
        assert "HTTP 404" in err
        # empty body -> no body snippet appended
        assert "HTTP 404: " not in err
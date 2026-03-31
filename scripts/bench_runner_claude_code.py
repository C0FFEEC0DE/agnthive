#!/usr/bin/env python3

import difflib
import json
import os
import pathlib
import re
import subprocess
import sys
import time


REPO_ROOT = pathlib.Path(os.environ["BENCH_REPO_ROOT"]).resolve()
TASK_FILE = pathlib.Path(os.environ["BENCH_TASK_FILE"]).resolve()
WORKDIR = pathlib.Path(os.environ["BENCH_WORKDIR"]).resolve()
OUTPUT_DIR = pathlib.Path(os.environ["BENCH_OUTPUT_DIR"]).resolve()


def env_or_default(name: str, default: str) -> str:
    value = os.environ.get(name, "")
    value = value.strip()
    return value or default


CLAUDE_BIN = env_or_default("CLAUDE_BIN", "claude")
MODEL_NAME = env_or_default("OLLAMA_MODEL", "")
if not MODEL_NAME:
    raise RuntimeError("OLLAMA_MODEL must be set")

MAX_TURNS = env_or_default("MAX_TURNS", "16")
CLAUDE_TIMEOUT_SECONDS = int(env_or_default("CLAUDE_TIMEOUT_SECONDS", "180"))
CLAUDE_CODE_MAX_OUTPUT_TOKENS = env_or_default("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "")
OUTPUT_TOKEN_BUDGET_RETRIES = 3
PROVIDER_ERROR_RETRIES = 2
SUMMARY_REPAIR_MAX_RETRIES = 5
SUMMARY_REPAIR_MAX_TURNS = "4"
REQUIRED_SUMMARY_PREFIXES = (
    "Verification status:",
    "Review outcome:",
    "Remaining risks:",
)


def is_docs_path(path_str: str) -> bool:
    path_lower = path_str.lower()
    name = pathlib.Path(path_lower).name
    return (
        path_lower.endswith((".md", ".mdx", ".txt", ".rst", ".adoc", ".markdown"))
        or "/docs/" in path_lower
        or name.startswith("readme")
        or name.startswith("changelog")
        or name == "claude.md"
    )


def is_ignored_runtime_path(path: pathlib.Path) -> bool:
    ignored_parts = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"}
    return any(part in ignored_parts for part in path.parts) or path.name == ".coverage"


def snapshot_files(root: pathlib.Path) -> dict[str, str]:
    snapshot = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or is_ignored_runtime_path(path.relative_to(root)):
            continue
        snapshot[path.relative_to(root).as_posix()] = path.read_text(encoding="utf-8")
    return snapshot


def build_patch(before: dict[str, str], after: dict[str, str]) -> str:
    chunks: list[str] = []
    for rel_path in sorted(set(before) | set(after)):
        old = before.get(rel_path)
        new = after.get(rel_path)
        if old == new:
            continue
        old_lines = [] if old is None else old.splitlines(keepends=True)
        new_lines = [] if new is None else new.splitlines(keepends=True)
        chunks.extend(
            difflib.unified_diff(
                old_lines,
                new_lines,
                fromfile=f"a/{rel_path}",
                tofile=f"b/{rel_path}",
            )
        )
    return "".join(chunks)


def build_prompt(task: dict) -> str:
    success_criteria = "\n".join(f"- {item}" for item in task.get("success_criteria", []))
    must_not = "\n".join(f"- {item}" for item in task.get("must_not", []))
    category = str(task["category"])
    workflow_override = (
        f"Workflow override: treat this as a {category} workflow, not a review-only workflow. "
        "Implementation and file edits are in scope when the task asks for them. "
        "Do not reinterpret this as a review task just because the final summary must include review outcome."
    )
    return f"""You are running in a tiny benchmark repository fixture.

Complete the task in the current working directory using the installed Claude Code profile from ~/.claude.
Use tools normally. Make only the changes needed for this task. Do not do release or deploy work.
If behavior changes, update docs. If verification is required, run the relevant tests locally.
Leave the workspace changes in place for artifact collection.

{workflow_override}

Task metadata:
- id: {task["id"]}
- workflow_category: {category}
- review_required: {json.dumps(bool(task["review_required"]))}
- docs_required: {json.dumps(bool(task["docs_required"]))}
- verification_required: {json.dumps(bool(task["verification_required"]))}

Task:
{task["prompt"]}

Success criteria:
{success_criteria or "- none provided"}

Must not:
{must_not or "- none provided"}

Final response requirements:
- Keep it concise.
- Your final response MUST end with exactly this 3-line footer.
- Do not rename the prefixes.
- Do not omit any footer line.
- Do not add any text after the footer.

Required footer template:
Verification status: <passed|failed|not run|not required> - <one sentence>
Review outcome: <done|pending|not required> - <one sentence>
Remaining risks: <one sentence or "none">

Example footer:
Verification status: passed - pytest -q completed successfully.
Review outcome: done - changes were reviewed before completion.
Remaining risks: none
"""


def run_claude(
    prompt: str,
    debug_log_path: pathlib.Path,
    stderr_log_path: pathlib.Path,
    max_turns: str = MAX_TURNS,
    max_output_tokens: str | None = None,
) -> tuple[int, str, str]:
    command = [
        CLAUDE_BIN,
        "-p",
        prompt,
        "--model",
        MODEL_NAME,
        "--max-turns",
        max_turns,
        "--permission-mode",
        "acceptEdits",
        "--debug-file",
        str(debug_log_path),
        "--output-format",
        "json",
    ]
    env = os.environ.copy()
    effective_max_output_tokens = (max_output_tokens or "").strip()
    if effective_max_output_tokens:
        env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = effective_max_output_tokens
    completed = subprocess.run(
        command,
        cwd=WORKDIR,
        capture_output=True,
        text=True,
        timeout=CLAUDE_TIMEOUT_SECONDS,
        env=env,
    )
    write_text(stderr_log_path, completed.stderr)
    return completed.returncode, completed.stdout, completed.stderr


def extract_result_payload(raw_json: str) -> dict | None:
    if not raw_json.strip():
        return None
    try:
        payload = json.loads(raw_json)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def extract_result_text(payload: dict | None) -> str:
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("result", "") or "")


def parse_affordable_max_tokens(text: str) -> tuple[int, int] | None:
    match = re.search(
        r"requested up to\s+(\d+)\s+tokens,\s+but can only afford\s+(\d+)",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    requested = int(match.group(1))
    affordable = int(match.group(2))
    return requested, affordable


def adjusted_output_token_budget(affordable_tokens: int) -> int | None:
    if affordable_tokens <= 0:
        return None
    # Leave a little headroom under the provider-reported budget.
    return max(256, affordable_tokens - min(128, max(1, affordable_tokens // 10)))


def is_retryable_provider_error(text: str) -> bool:
    lowered = text.lower()
    if "api error: 403" in lowered and "daily limit" in lowered:
        return False
    retryable_markers = (
        "provider returned error",
        "internalerror.algo.invalidparameter",
        "tool_call_ids did not have response messages",
        "invalid_parameter_error",
    )
    return any(marker in lowered for marker in retryable_markers)


def try_budget_retry(
    prompt: str,
    exit_code: int,
    raw_stdout: str,
    raw_stderr: str,
    payload: dict | None,
    result_text: str,
    fatal_error: str,
) -> tuple[int, str, str, dict | None, str, str, list[dict[str, object]], str]:
    current_output_budget = CLAUDE_CODE_MAX_OUTPUT_TOKENS.strip()
    retry_summaries: list[dict[str, object]] = []
    retry_source = "none"

    for attempt in range(1, OUTPUT_TOKEN_BUDGET_RETRIES + 1):
        affordability = parse_affordable_max_tokens(result_text)
        if exit_code == 0 or affordability is None:
            break

        requested_tokens, affordable_tokens = affordability
        next_budget = adjusted_output_token_budget(affordable_tokens)
        if next_budget is None:
            break
        next_budget_str = str(next_budget)
        if current_output_budget and next_budget >= int(current_output_budget):
            break

        retry_debug_log_path = OUTPUT_DIR / f"claude-debug-budget-retry-{attempt}.log"
        retry_stderr_log_path = OUTPUT_DIR / f"claude-stderr-budget-retry-{attempt}.log"
        retry_exit_code = 0
        retry_raw_stdout = ""
        retry_raw_stderr = ""
        retry_payload = None
        retry_result_text = ""
        retry_error = ""

        try:
            retry_exit_code, retry_raw_stdout, retry_raw_stderr = run_claude(
                prompt,
                retry_debug_log_path,
                retry_stderr_log_path,
                max_output_tokens=next_budget_str,
            )
            retry_payload = extract_result_payload(retry_raw_stdout)
            retry_result_text = extract_result_text(retry_payload)
            if not retry_result_text.strip():
                retry_result_text = extract_result_text_from_transcript(retry_payload)
            if not retry_raw_stdout.strip():
                retry_error = "Claude output JSON is missing or empty."
            elif retry_payload is None:
                retry_error = "Claude output JSON is invalid."
            elif not retry_result_text.strip():
                retry_error = "Claude result text is missing or empty."
        except subprocess.TimeoutExpired as exc:
            retry_exit_code = 124
            retry_raw_stdout = exc.stdout or ""
            retry_raw_stderr = exc.stderr or ""
            write_text(retry_stderr_log_path, retry_raw_stderr)
            retry_payload = extract_result_payload(retry_raw_stdout)
            retry_result_text = extract_result_text(retry_payload)
            if not retry_result_text.strip():
                retry_result_text = extract_result_text_from_transcript(retry_payload)
            retry_error = f"Claude timed out after {CLAUDE_TIMEOUT_SECONDS}s during output-token retry."
        except Exception as exc:
            retry_exit_code = 1
            retry_error = f"Claude runner exception during output-token retry: {exc}"

        retry_summaries.append(
            {
                "attempt": attempt,
                "requested_tokens": requested_tokens,
                "affordable_tokens": affordable_tokens,
                "retry_budget": next_budget,
                "exit_code": retry_exit_code,
                "error": retry_error,
                "result_excerpt": truncate(retry_result_text, 700),
            }
        )

        exit_code = retry_exit_code
        raw_stdout = retry_raw_stdout
        raw_stderr = retry_raw_stderr
        payload = retry_payload
        result_text = retry_result_text
        fatal_error = retry_error
        current_output_budget = next_budget_str
        retry_source = "output-budget"

        if exit_code == 0 and result_text.strip():
            break

    return (
        exit_code,
        raw_stdout,
        raw_stderr,
        payload,
        result_text,
        fatal_error,
        retry_summaries,
        retry_source,
    )


def try_provider_retry(
    prompt: str,
    exit_code: int,
    raw_stdout: str,
    raw_stderr: str,
    payload: dict | None,
    result_text: str,
    fatal_error: str,
) -> tuple[int, str, str, dict | None, str, str, list[dict[str, object]], str]:
    retry_summaries: list[dict[str, object]] = []
    retry_source = "none"

    for attempt in range(1, PROVIDER_ERROR_RETRIES + 1):
        if exit_code == 0 or not is_retryable_provider_error(result_text):
            break

        retry_debug_log_path = OUTPUT_DIR / f"claude-debug-provider-retry-{attempt}.log"
        retry_stderr_log_path = OUTPUT_DIR / f"claude-stderr-provider-retry-{attempt}.log"
        retry_exit_code = 0
        retry_raw_stdout = ""
        retry_raw_stderr = ""
        retry_payload = None
        retry_result_text = ""
        retry_error = ""

        try:
            retry_exit_code, retry_raw_stdout, retry_raw_stderr = run_claude(
                prompt,
                retry_debug_log_path,
                retry_stderr_log_path,
            )
            retry_payload = extract_result_payload(retry_raw_stdout)
            retry_result_text = extract_result_text(retry_payload)
            if not retry_result_text.strip():
                retry_result_text = extract_result_text_from_transcript(retry_payload)
            if not retry_raw_stdout.strip():
                retry_error = "Claude output JSON is missing or empty."
            elif retry_payload is None:
                retry_error = "Claude output JSON is invalid."
            elif not retry_result_text.strip():
                retry_error = "Claude result text is missing or empty."
        except subprocess.TimeoutExpired as exc:
            retry_exit_code = 124
            retry_raw_stdout = exc.stdout or ""
            retry_raw_stderr = exc.stderr or ""
            write_text(retry_stderr_log_path, retry_raw_stderr)
            retry_payload = extract_result_payload(retry_raw_stdout)
            retry_result_text = extract_result_text(retry_payload)
            if not retry_result_text.strip():
                retry_result_text = extract_result_text_from_transcript(retry_payload)
            retry_error = f"Claude timed out after {CLAUDE_TIMEOUT_SECONDS}s during provider retry."
        except Exception as exc:
            retry_exit_code = 1
            retry_error = f"Claude runner exception during provider retry: {exc}"

        (
            retry_exit_code,
            retry_raw_stdout,
            retry_raw_stderr,
            retry_payload,
            retry_result_text,
            retry_error,
            budget_retry_summaries,
            budget_retry_source,
        ) = try_budget_retry(
            prompt=prompt,
            exit_code=retry_exit_code,
            raw_stdout=retry_raw_stdout,
            raw_stderr=retry_raw_stderr,
            payload=retry_payload,
            result_text=retry_result_text,
            fatal_error=retry_error,
        )

        retry_summaries.append(
            {
                "attempt": attempt,
                "exit_code": retry_exit_code,
                "error": retry_error,
                "budget_retry_attempts": len(budget_retry_summaries),
                "budget_retry_source": budget_retry_source,
                "result_excerpt": truncate(retry_result_text, 700),
            }
        )

        exit_code = retry_exit_code
        raw_stdout = retry_raw_stdout
        raw_stderr = retry_raw_stderr
        payload = retry_payload
        result_text = retry_result_text
        fatal_error = retry_error
        retry_source = "provider-error"

        if exit_code == 0 and result_text.strip():
            break

    return (
        exit_code,
        raw_stdout,
        raw_stderr,
        payload,
        result_text,
        fatal_error,
        retry_summaries,
        retry_source,
    )


def safe_session_id(raw: str) -> str:
    if not raw:
        return "no-session"
    return re.sub(r"[^A-Za-z0-9._-]", "_", raw)


def state_file_for_session(session_id: str) -> pathlib.Path:
    return pathlib.Path.home() / ".claude" / "state" / f"{safe_session_id(session_id)}.json"


def resolve_transcript_path(payload: dict | None) -> pathlib.Path | None:
    if isinstance(payload, dict):
        direct = str(payload.get("transcript_path", "") or "").strip()
        if direct:
            return pathlib.Path(direct)

        session_id = str(payload.get("session_id", "") or "").strip()
        if session_id:
            state_file = state_file_for_session(session_id)
            if state_file.exists():
                try:
                    state = json.loads(state_file.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    return None
                transcript_path = str(state.get("transcript_path", "") or "").strip()
                if transcript_path:
                    return pathlib.Path(transcript_path)
    return None


def flatten_message_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""

    chunks: list[str] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            chunks.append(text)
            continue
        content = item.get("content")
        if isinstance(content, str) and content.strip():
            chunks.append(content)
    return "\n".join(chunks)


def transcript_candidate_text(event: dict) -> str:
    candidates = [
        event.get("last_assistant_message"),
        event.get("result"),
        event.get("text"),
    ]
    message = event.get("message")
    if isinstance(message, dict):
        candidates.append(flatten_message_text(message.get("content")))
        text = message.get("text")
        if isinstance(text, str):
            candidates.append(text)
    candidates.append(flatten_message_text(event.get("content")))

    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return ""


def transcript_candidate_score(text: str) -> int:
    score = 0
    lowered = text.lower()
    if has_line_prefix(text, "Verification status:"):
        score += 4
    if has_line_prefix(text, "Review outcome:"):
        score += 4
    if has_line_prefix(text, "Remaining risks:"):
        score += 4
    if "verification" in lowered or "pytest" in lowered or "test" in lowered:
        score += 1
    if "review" in lowered:
        score += 1
    if "risk" in lowered:
        score += 1
    return score


def extract_result_text_from_transcript(payload: dict | None) -> str:
    transcript_path = resolve_transcript_path(payload)
    if transcript_path is None or not transcript_path.exists():
        return ""

    best_text = ""
    best_score = -1
    try:
        with transcript_path.open(encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                text = transcript_candidate_text(event)
                if not text:
                    continue
                score = transcript_candidate_score(text)
                if score > best_score or (score == best_score and score > 0):
                    best_text = text
                    best_score = score
    except OSError:
        return ""

    return best_text if best_score > 0 else ""


def run_verification() -> tuple[bool, bool, str]:
    tests_exist = any(WORKDIR.glob("test_*.py")) or any(WORKDIR.glob("tests/*.py"))
    if not tests_exist:
        return False, False, "No Python test files were found in the fixture."

    command = [sys.executable, "-m", "pytest", "-q"]
    completed = subprocess.run(
        command,
        cwd=WORKDIR,
        capture_output=True,
        text=True,
    )
    output = (completed.stdout + "\n" + completed.stderr).strip()
    return True, completed.returncode == 0, output


def has_line_prefix(text: str, prefix: str) -> bool:
    pattern = r"(?im)^\s*" + re.escape(prefix)
    return re.search(pattern, text) is not None


def missing_summary_prefixes(text: str) -> list[str]:
    return [prefix for prefix in REQUIRED_SUMMARY_PREFIXES if not has_line_prefix(text, prefix)]


def extract_prefixed_line(text: str, prefix: str) -> str:
    pattern = r"(?im)^\s*" + re.escape(prefix) + r"[^\n]*"
    match = re.search(pattern, text)
    return match.group(0).strip() if match else ""


def merge_footer(text: str, footer_lines: list[str]) -> str:
    body_lines = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if any(stripped.startswith(prefix) for prefix in REQUIRED_SUMMARY_PREFIXES):
            continue
        body_lines.append(line.rstrip())
    body = "\n".join(body_lines).strip()
    footer = "\n".join(footer_lines).strip()
    if body and footer:
        return f"{body}\n\n{footer}"
    return body or footer


def verification_status_line(verification_required: bool, tests_run: bool, tests_passed: bool) -> str:
    if not verification_required:
        return "Verification status: not required - benchmark task did not require automated verification."
    if not tests_run:
        return "Verification status: not run - required verification did not execute."
    if tests_passed:
        return "Verification status: passed - pytest -q completed successfully."
    return "Verification status: failed - pytest -q reported failures."


def review_outcome_line(review_required: bool, review_present: bool) -> str:
    if not review_required:
        return "Review outcome: not required - benchmark task did not require an explicit review summary."
    if review_present:
        return "Review outcome: done - explicit review summary is present."
    return "Review outcome: pending - the model omitted an explicit review summary."


def remaining_risks_line(
    verification_required: bool,
    tests_run: bool,
    tests_passed: bool,
    review_required: bool,
) -> str:
    if verification_required and (not tests_run or not tests_passed):
        return "Remaining risks: automated verification is incomplete or failing."
    if review_required:
        return "Remaining risks: the model omitted explicit remaining-risk and review summaries."
    return "Remaining risks: none"


def synthesize_footer(
    verification_required: bool,
    tests_run: bool,
    tests_passed: bool,
    review_required: bool,
    review_present: bool,
) -> list[str]:
    return [
        verification_status_line(verification_required, tests_run, tests_passed),
        review_outcome_line(review_required, review_present),
        remaining_risks_line(verification_required, tests_run, tests_passed, review_required),
    ]


def completed_task_recovery_mode(
    *,
    exit_code: int,
    payload_subtype: str,
    fatal_error: str,
    completed: bool,
    verification_required: bool,
    tests_run: bool,
    tests_passed: bool,
    verification_summary_present: bool,
    review_required: bool,
    review_present: bool,
    risks_present: bool,
    docs_required: bool,
    docs_updated: bool,
    category: str,
    non_doc_changed_files: list[str],
    doc_pattern_hits: list[str],
) -> str:
    if not completed:
        return "none"
    if verification_required and not (tests_run and tests_passed and verification_summary_present):
        return "none"
    if review_required and not review_present:
        return "none"
    if not risks_present:
        return "none"
    if docs_required and not docs_updated:
        return "none"
    if category == "docs" and non_doc_changed_files:
        return "none"
    if doc_pattern_hits:
        return "none"

    if exit_code == 124 and fatal_error.startswith("Claude timed out after "):
        return "timeout"

    if payload_subtype == "error_max_turns":
        return "max_turns"

    return "none"


def build_summary_repair_prompt(
    task: dict,
    result_text: str,
    verification_required: bool,
    tests_run: bool,
    tests_passed: bool,
    verification_output: str,
    review_required: bool,
    changed_files: list[str],
) -> str:
    return f"""You already completed the benchmark task. Do not modify any files.

Return only the required 3-line footer and nothing else.
Use these prefixes exactly and keep exactly one line per prefix:
Verification status:
Review outcome:
Remaining risks:

Required footer format:
Verification status: <passed|failed|not run|not required> - <one sentence>
Review outcome: <done|pending|not required> - <one sentence>
Remaining risks: <one sentence or "none">

Known facts:
- task_id: {task["id"]}
- verification_required: {json.dumps(verification_required)}
- tests_run: {json.dumps(tests_run)}
- tests_passed: {json.dumps(tests_passed)}
- review_required: {json.dumps(review_required)}
- changed_files: {", ".join(changed_files) if changed_files else "none"}

Previous response excerpt:
{truncate(result_text, 1200) or "<missing>"}

Verification output excerpt:
{truncate(verification_output, 1200) or "<not run>"}
"""


def truncate(text: str, limit: int = 1200) -> str:
    clean = text.strip()
    if len(clean) <= limit:
        return clean
    return clean[: limit - 3] + "..."


def write_text(path: pathlib.Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def payload_keys(payload: dict | None) -> str:
    if not isinstance(payload, dict):
        return "<invalid-or-missing>"
    return ", ".join(sorted(payload.keys())) or "<empty-object>"


def payload_string(payload: dict | None, key: str) -> str:
    if not isinstance(payload, dict):
        return ""
    value = payload.get(key, "")
    return value if isinstance(value, str) else str(value or "")


def payload_permission_denials(payload: dict | None) -> list[dict]:
    if not isinstance(payload, dict):
        return []
    value = payload.get("permission_denials", [])
    return value if isinstance(value, list) else []


def first_permission_denial_summary(denials: list[dict]) -> str:
    if not denials:
        return "none"
    first = denials[0]
    tool_name = first.get("tool_name", "unknown")
    tool_input = first.get("tool_input", {})
    file_path = ""
    if isinstance(tool_input, dict):
        file_path = str(tool_input.get("file_path", "") or "")
    if file_path:
        return f"{tool_name} -> {file_path}"
    return str(tool_name)


def forbidden_doc_pattern_hits(task: dict, after: dict[str, str], changed_files: list[str]) -> list[str]:
    patterns = task.get("forbidden_doc_patterns", [])
    if not isinstance(patterns, list):
        return []

    hits: list[str] = []
    for path in changed_files:
        if not is_docs_path(path):
            continue
        content = after.get(path, "")
        for pattern in patterns:
            if not isinstance(pattern, str) or not pattern.strip():
                continue
            if re.search(pattern, content, re.IGNORECASE | re.MULTILINE):
                hits.append(f"{path}: /{pattern}/")
    return hits


def is_assistant_like_transcript_event(event: dict) -> bool:
    event_type = str(event.get("type", "") or "").strip().lower()
    if event_type in {"assistant", "result"}:
        return True

    message = event.get("message")
    if isinstance(message, dict):
        role = str(message.get("role", "") or "").strip().lower()
        if role == "assistant":
            return True

    return False


def transcript_text_entries(
    payload: dict | None,
    *,
    assistant_only: bool = False,
) -> tuple[bool, list[tuple[str, str]]]:
    transcript_path = resolve_transcript_path(payload)
    if transcript_path is None or not transcript_path.exists():
        return False, []

    entries: list[tuple[str, str]] = []
    try:
        with transcript_path.open(encoding="utf-8") as handle:
            for index, line in enumerate(handle, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                if assistant_only and not is_assistant_like_transcript_event(event):
                    continue
                text = transcript_candidate_text(event)
                if not text:
                    continue
                entries.append((f"{transcript_path.name}:{index}", text.strip()))
    except OSError:
        return False, []

    return True, entries


def forbidden_transcript_pattern_hits(task: dict, payload: dict | None) -> tuple[bool, list[str]]:
    patterns = task.get("forbidden_transcript_patterns", [])
    if not isinstance(patterns, list) or not patterns:
        return False, []

    scanned, entries = transcript_text_entries(payload, assistant_only=True)
    if not scanned:
        return False, []

    hits: list[str] = []
    for source, text in entries:
        for pattern in patterns:
            if not isinstance(pattern, str) or not pattern.strip():
                continue
            if re.search(pattern, text, re.IGNORECASE | re.MULTILINE):
                hits.append(f"{source}: /{pattern}/ -> {truncate(text, 200)}")
    return True, hits


def required_transcript_pattern_misses(task: dict, payload: dict | None) -> tuple[bool, list[str]]:
    patterns = task.get("required_transcript_patterns", [])
    if not isinstance(patterns, list) or not patterns:
        return False, []

    scanned, entries = transcript_text_entries(payload, assistant_only=True)
    if not scanned:
        return False, ["<assistant transcript unavailable>"]

    misses: list[str] = []
    for pattern in patterns:
        if not isinstance(pattern, str) or not pattern.strip():
            continue
        if not any(re.search(pattern, text, re.IGNORECASE | re.MULTILINE) for _, text in entries):
            misses.append(pattern)
    return True, misses


def build_task_summary(
    task: dict,
    prompt: str,
    status: str,
    exit_code: int,
    changed_files: list[str],
    failures: list[str],
    raw_json: str,
    payload: dict | None,
    payload_subtype: str,
    payload_stop_reason: str,
    permission_denials: list[dict],
    result_text: str,
    verification_output: str,
    stderr_text: str,
    debug_log_text: str,
    patch_text: str,
    transcript_scanned: bool,
    transcript_pattern_hits: list[str],
    required_transcript_scanned: bool,
    required_transcript_misses: list[str],
) -> str:
    lines = [
        f"Task: {task['id']}",
        f"Category: {task['category']}",
        f"Status: {status}",
        f"Claude exit code: {exit_code}",
        f"Review required: {bool(task['review_required'])}",
        f"Docs required: {bool(task['docs_required'])}",
        f"Verification required: {bool(task['verification_required'])}",
        f"Changed files: {', '.join(changed_files) if changed_files else 'none'}",
        f"Failures: {', '.join(failures) if failures else 'none'}",
        f"Claude payload keys: {payload_keys(payload)}",
        f"Claude subtype: {payload_subtype or '<missing>'}",
        f"Claude stop reason: {payload_stop_reason or '<missing>'}",
        f"Permission denials: {len(permission_denials)}",
        f"First permission denial: {first_permission_denial_summary(permission_denials)}",
        f"Transcript scanned: {transcript_scanned}",
        f"Forbidden transcript hits: {'; '.join(transcript_pattern_hits) if transcript_pattern_hits else 'none'}",
        f"Required assistant transcript scanned: {required_transcript_scanned}",
        f"Required assistant transcript misses: {'; '.join(required_transcript_misses) if required_transcript_misses else 'none'}",
        f"stdout bytes: {len(raw_json.encode('utf-8'))}",
        f"stderr bytes: {len(stderr_text.encode('utf-8'))}",
        "",
        "Prompt excerpt:",
        truncate(prompt, 1200) or "<missing>",
        "",
        "Raw Claude JSON excerpt:",
        truncate(raw_json, 1200) or "<missing>",
        "",
        "Result excerpt:",
        truncate(result_text, 1200) or "<missing>",
        "",
        "Verification excerpt:",
        truncate(verification_output, 1200) or "<not run>",
        "",
        "stderr excerpt:",
        truncate(stderr_text, 1200) or "<empty>",
        "",
        "debug log excerpt:",
        truncate(debug_log_text, 1600) or "<empty>",
        "",
        "Patch excerpt:",
        truncate(patch_text, 1200) or "<empty>",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    started_at = time.monotonic()
    task = json.loads(TASK_FILE.read_text(encoding="utf-8"))
    before = snapshot_files(WORKDIR)

    prompt = build_prompt(task)
    exit_code = 0
    raw_stdout = ""
    raw_stderr = ""
    payload = None
    result_text = ""
    fatal_error = ""
    summary_repair_attempts = 0
    summary_repaired_by = "none"
    output_budget_retry_attempts = 0
    output_budget_repaired_by = "none"
    provider_retry_attempts = 0
    provider_repaired_by = "none"
    debug_log_path = OUTPUT_DIR / "claude-debug.log"
    stderr_log_path = OUTPUT_DIR / "claude-stderr.log"

    try:
        exit_code, raw_stdout, raw_stderr = run_claude(prompt, debug_log_path, stderr_log_path)
        payload = extract_result_payload(raw_stdout)
        result_text = extract_result_text(payload)
        if not result_text.strip():
            result_text = extract_result_text_from_transcript(payload)
        if not raw_stdout.strip():
            fatal_error = "Claude output JSON is missing or empty."
        elif payload is None:
            fatal_error = "Claude output JSON is invalid."
        elif not result_text.strip():
            fatal_error = "Claude result text is missing or empty."
    except subprocess.TimeoutExpired as exc:
        exit_code = 124
        raw_stdout = exc.stdout or ""
        raw_stderr = exc.stderr or ""
        write_text(stderr_log_path, raw_stderr)
        payload = extract_result_payload(raw_stdout)
        result_text = extract_result_text(payload)
        if not result_text.strip():
            result_text = extract_result_text_from_transcript(payload)
        fatal_error = f"Claude timed out after {CLAUDE_TIMEOUT_SECONDS}s."
    except Exception as exc:
        fatal_error = f"Claude runner exception: {exc}"

    (
        exit_code,
        raw_stdout,
        raw_stderr,
        payload,
        result_text,
        fatal_error,
        output_budget_retry_summaries,
        output_budget_retry_source,
    ) = try_budget_retry(
        prompt=prompt,
        exit_code=exit_code,
        raw_stdout=raw_stdout,
        raw_stderr=raw_stderr,
        payload=payload,
        result_text=result_text,
        fatal_error=fatal_error,
    )
    if output_budget_retry_summaries:
        output_budget_retry_attempts = len(output_budget_retry_summaries)
        output_budget_repaired_by = output_budget_retry_source
        write_text(
            OUTPUT_DIR / "output-budget-retry-attempts.json",
            json.dumps(output_budget_retry_summaries, ensure_ascii=False, indent=2) + "\n",
        )

    (
        exit_code,
        raw_stdout,
        raw_stderr,
        payload,
        result_text,
        fatal_error,
        provider_retry_summaries,
        provider_retry_source,
    ) = try_provider_retry(
        prompt=prompt,
        exit_code=exit_code,
        raw_stdout=raw_stdout,
        raw_stderr=raw_stderr,
        payload=payload,
        result_text=result_text,
        fatal_error=fatal_error,
    )
    if provider_retry_summaries:
        provider_retry_attempts = len(provider_retry_summaries)
        provider_repaired_by = provider_retry_source
        write_text(
            OUTPUT_DIR / "provider-retry-attempts.json",
            json.dumps(provider_retry_summaries, ensure_ascii=False, indent=2) + "\n",
        )

    write_text(OUTPUT_DIR / "claude-result.json", raw_stdout)
    write_text(OUTPUT_DIR / "claude-result.txt", result_text)
    debug_log_text = debug_log_path.read_text(encoding="utf-8") if debug_log_path.exists() else ""
    payload_subtype = payload_string(payload, "subtype")
    payload_stop_reason = payload_string(payload, "stop_reason")
    permission_denials = payload_permission_denials(payload)
    if raw_stderr.strip():
        write_text(OUTPUT_DIR / "claude-stderr-tail.txt", "\n".join(raw_stderr.splitlines()[-200:]) + "\n")

    verification_required = bool(task["verification_required"])
    tests_run = False
    tests_passed = False
    verification_output = ""
    repair_after = snapshot_files(WORKDIR)
    repair_changed_files = sorted(
        path for path in set(before) | set(repair_after) if before.get(path) != repair_after.get(path)
    )
    if verification_required:
        tests_run, tests_passed, verification_output = run_verification()

    review_required = bool(task["review_required"])
    docs_required = bool(task["docs_required"])
    repair_attempt_summaries: list[dict[str, object]] = []
    if exit_code == 0 and missing_summary_prefixes(result_text):
        for attempt in range(1, SUMMARY_REPAIR_MAX_RETRIES + 1):
            repair_prompt = build_summary_repair_prompt(
                task=task,
                result_text=result_text,
                verification_required=verification_required,
                tests_run=tests_run,
                tests_passed=tests_passed,
                verification_output=verification_output,
                review_required=review_required,
                changed_files=repair_changed_files,
            )
            repair_debug_log_path = OUTPUT_DIR / f"claude-debug-repair-{attempt}.log"
            repair_stderr_log_path = OUTPUT_DIR / f"claude-stderr-repair-{attempt}.log"
            repair_exit_code = 0
            repair_raw_stdout = ""
            repair_raw_stderr = ""
            repair_payload = None
            repair_text = ""
            repair_error = ""
            try:
                repair_exit_code, repair_raw_stdout, repair_raw_stderr = run_claude(
                    repair_prompt,
                    repair_debug_log_path,
                    repair_stderr_log_path,
                    max_turns=SUMMARY_REPAIR_MAX_TURNS,
                )
                repair_payload = extract_result_payload(repair_raw_stdout)
                repair_text = extract_result_text(repair_payload)
                if not repair_text.strip():
                    repair_text = extract_result_text_from_transcript(repair_payload)
                if not repair_raw_stdout.strip():
                    repair_error = "Claude output JSON is missing or empty."
                elif repair_payload is None:
                    repair_error = "Claude output JSON is invalid."
                elif not repair_text.strip():
                    repair_error = "Claude result text is missing or empty."
            except subprocess.TimeoutExpired:
                repair_exit_code = 124
                repair_error = f"Claude timed out after {CLAUDE_TIMEOUT_SECONDS}s during summary repair."
            except Exception as exc:
                repair_exit_code = 1
                repair_error = f"Claude runner exception during summary repair: {exc}"

            repair_attempt_summaries.append(
                {
                    "attempt": attempt,
                    "exit_code": repair_exit_code,
                    "error": repair_error,
                    "result_excerpt": truncate(repair_text, 700),
                    "missing_prefixes": missing_summary_prefixes(repair_text),
                }
            )
            summary_repair_attempts = attempt
            if repair_exit_code != 0 or not repair_text.strip():
                continue

            footer_lines = [extract_prefixed_line(repair_text, prefix) for prefix in REQUIRED_SUMMARY_PREFIXES]
            if all(footer_lines):
                result_text = merge_footer(result_text, footer_lines)
                summary_repaired_by = "retry"
                break

    if repair_attempt_summaries:
        write_text(
            OUTPUT_DIR / "summary-repair-attempts.json",
            json.dumps(repair_attempt_summaries, ensure_ascii=False, indent=2) + "\n",
        )

    after = snapshot_files(WORKDIR)
    changed_files = sorted(path for path in set(before) | set(after) if before.get(path) != after.get(path))
    docs_updated = any(is_docs_path(path) for path in changed_files)
    non_doc_changed_files = [path for path in changed_files if not is_docs_path(path)]
    doc_pattern_hits = forbidden_doc_pattern_hits(task, after, changed_files)
    transcript_scanned, transcript_pattern_hits = forbidden_transcript_pattern_hits(task, payload)
    required_transcript_scanned, required_transcript_misses = required_transcript_pattern_misses(task, payload)
    completed = len(changed_files) > 0
    patch_text = build_patch(before, after)
    write_text(OUTPUT_DIR / "workspace.patch", patch_text)
    write_text(OUTPUT_DIR / "changed-files.json", json.dumps(changed_files, ensure_ascii=False, indent=2) + "\n")
    write_text(OUTPUT_DIR / "task-prompt.txt", prompt + "\n")

    verification_summary_present = has_line_prefix(result_text, "Verification status:")
    review_present = has_line_prefix(result_text, "Review outcome:")
    risks_present = has_line_prefix(result_text, "Remaining risks:")
    if missing_summary_prefixes(result_text):
        result_text = merge_footer(
            result_text,
            synthesize_footer(
                verification_required=verification_required,
                tests_run=tests_run,
                tests_passed=tests_passed,
                review_required=review_required,
                review_present=review_present,
            ),
        )
        summary_repaired_by = "synthetic-footer" if summary_repaired_by == "none" else summary_repaired_by
        verification_summary_present = has_line_prefix(result_text, "Verification status:")
        review_present = has_line_prefix(result_text, "Review outcome:")
        risks_present = has_line_prefix(result_text, "Remaining risks:")

    write_text(OUTPUT_DIR / "claude-result.txt", result_text)

    recovery_mode = completed_task_recovery_mode(
        exit_code=exit_code,
        payload_subtype=payload_subtype,
        fatal_error=fatal_error,
        completed=completed,
        verification_required=verification_required,
        tests_run=tests_run,
        tests_passed=tests_passed,
        verification_summary_present=verification_summary_present,
        review_required=review_required,
        review_present=review_present,
        risks_present=risks_present,
        docs_required=docs_required,
        docs_updated=docs_updated,
        category=task["category"],
        non_doc_changed_files=non_doc_changed_files,
        doc_pattern_hits=doc_pattern_hits,
    )
    timeout_recovered = recovery_mode == "timeout"
    max_turns_recovered = recovery_mode == "max_turns"
    recovered_nonzero_exit = recovery_mode != "none"

    status = "passed"
    failures: list[str] = []

    if exit_code != 0 and not recovered_nonzero_exit:
        failures.append(f"claude_exit_code={exit_code}")
    if fatal_error and not recovered_nonzero_exit:
        failures.append(fatal_error)
    if not completed:
        failures.append("workspace_changed=false")
    if verification_required and not tests_run:
        failures.append("verification_not_run")
    if verification_required and not tests_passed:
        failures.append("verification_failed")
    if verification_required and not verification_summary_present:
        failures.append("verification_summary_missing")
    if review_required and not review_present:
        failures.append("review_summary_missing")
    if not risks_present:
        failures.append("risk_summary_missing")
    if docs_required and not docs_updated:
        failures.append("docs_not_updated")
    if task["category"] == "docs" and non_doc_changed_files:
        failures.append("docs_task_changed_non_docs")
    if doc_pattern_hits:
        failures.append("docs_forbidden_content")
    if transcript_pattern_hits:
        failures.append("transcript_forbidden_content")
    if required_transcript_misses:
        failures.append("transcript_required_content_missing")

    if failures:
        status = "failed"

    runtime_seconds = round(time.monotonic() - started_at, 3)
    notes = (
        f"Claude model={MODEL_NAME}. "
        f"Exit code: {exit_code}. "
        f"Changed files: {', '.join(changed_files) if changed_files else 'none'}. "
        f"Provider retry attempts: {provider_retry_attempts}. "
        f"Provider repaired by: {provider_repaired_by}. "
        f"Output budget retry attempts: {output_budget_retry_attempts}. "
        f"Output budget repaired by: {output_budget_repaired_by}. "
        f"Summary repair attempts: {summary_repair_attempts}. "
        f"Summary repaired by: {summary_repaired_by}. "
        f"Timeout recovered: {timeout_recovered}. "
        f"Max-turns recovered: {max_turns_recovered}. "
        f"Transcript scanned: {transcript_scanned}. "
        f"Forbidden transcript hits: {'; '.join(transcript_pattern_hits) if transcript_pattern_hits else 'none'}. "
        f"Required assistant transcript scanned: {required_transcript_scanned}. "
        f"Required assistant transcript misses: {'; '.join(required_transcript_misses) if required_transcript_misses else 'none'}. "
        f"Failures: {', '.join(failures) if failures else 'none'}. "
        f"Result: {truncate(result_text, 700) or 'missing'}. "
        f"Verification: {truncate(verification_output, 700) or 'not required'}"
    )

    result = {
        "task_id": task["id"],
        "status": status,
        "completed": completed,
        "verification_required": verification_required,
        "tests_run": tests_run,
        "tests_passed": tests_passed,
        "review_required": review_required,
        "review_present": review_present,
        "docs_required": docs_required,
        "docs_updated": docs_updated,
        "policy_violations": 0,
        "tool_failures": 0 if status == "passed" else 1,
        "runtime_seconds": runtime_seconds,
        "notes": notes,
        "category": task["category"],
        "changed_files": changed_files,
        "non_doc_changed_files": non_doc_changed_files,
        "verification_summary_present": verification_summary_present,
        "risk_summary_present": risks_present,
        "claude_exit_code": exit_code,
        "claude_subtype": payload_subtype,
        "claude_stop_reason": payload_stop_reason,
        "timeout_recovered": timeout_recovered,
        "max_turns_recovered": max_turns_recovered,
        "recovered_nonzero_exit": recovered_nonzero_exit,
        "summary_repaired_by": summary_repaired_by,
        "summary_repair_attempts": summary_repair_attempts,
        "permission_denials_count": len(permission_denials),
        "first_permission_denial": first_permission_denial_summary(permission_denials),
        "forbidden_doc_pattern_hits": doc_pattern_hits,
        "transcript_scanned": transcript_scanned,
        "forbidden_transcript_pattern_hits": transcript_pattern_hits,
        "required_transcript_scanned": required_transcript_scanned,
        "required_transcript_pattern_misses": required_transcript_misses,
        "fatal_error": fatal_error,
        "failures": failures,
    }

    write_text(OUTPUT_DIR / "result.json", json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    write_text(
        OUTPUT_DIR / "task-summary.txt",
        build_task_summary(
            task=task,
            prompt=prompt,
            status=status,
            exit_code=exit_code,
            changed_files=changed_files,
            failures=failures,
            raw_json=raw_stdout,
            payload=payload,
            payload_subtype=payload_subtype,
            payload_stop_reason=payload_stop_reason,
            permission_denials=permission_denials,
            result_text=result_text,
            verification_output=verification_output,
            stderr_text=raw_stderr,
            debug_log_text=debug_log_text,
            patch_text=patch_text,
            transcript_scanned=transcript_scanned,
            transcript_pattern_hits=transcript_pattern_hits,
            required_transcript_scanned=required_transcript_scanned,
            required_transcript_misses=required_transcript_misses,
        ),
    )
    if fatal_error:
        write_text(OUTPUT_DIR / "runner-error.txt", fatal_error + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

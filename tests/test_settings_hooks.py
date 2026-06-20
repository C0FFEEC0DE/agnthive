"""Tests for validating claude-code settings.json hooks structure.

According to official Claude Code documentation:
https://code.claude.com/docs/en/hooks.md

All hook events use the nested structure:
  {"hooks": [{"type": "...", "command": "..."}]}

Matcher-based events add a "matcher" field:
  {"matcher": "Bash", "hooks": [...]}
"""
import json
from pathlib import Path


HOOK_EVENTS = {
    "SessionStart",
    "InstructionsLoaded",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PermissionDenied",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "TeammateIdle",
    "TaskCompleted",
    "Notification",
    "ConfigChange",
    "PreCompact",
    "PostCompact",
    "SessionEnd",
}

# Events that support matcher filtering
MATCHER_EVENTS = {
    "InstructionsLoaded",
    "PreToolUse",
    "PermissionRequest",
    "PermissionDenied",
    "PostToolUse",
    "PostToolUseFailure",
}

# Valid keys for hook record objects
VALID_HOOK_RECORD_KEYS = {"matcher", "hooks"}

# Valid keys for command hook definitions
VALID_COMMAND_HOOK_KEYS = {"type", "command", "async"}


def load_settings_json() -> dict:
    """Load the settings.json from claudecfg directory."""
    repo_root = Path(__file__).resolve().parents[1]
    settings_path = repo_root / "claudecfg" / "settings.json"
    with settings_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def validate_hook_record(hook_record: dict, event_name: str, expects_matcher: bool) -> list[str]:
    """
    Validate a hook record object.

    According to official docs, ALL events use nested {"hooks": [...]} structure.
    Matcher-based events also have a "matcher" field.

    Args:
        hook_record: The hook record to validate
        event_name: Name of the hook event (for error messages)
        expects_matcher: Whether this event should have a matcher

    Returns:
        List of validation errors
    """
    errors = []

    # All events must have "hooks" key with array value
    if "hooks" not in hook_record:
        errors.append(f"{event_name}: missing required 'hooks' key - all events use nested format")
    elif not isinstance(hook_record["hooks"], list):
        errors.append(f"{event_name}: 'hooks' must be an array")
    elif len(hook_record["hooks"]) == 0:
        errors.append(f"{event_name}: 'hooks' array must not be empty")
    else:
        # Validate each hook definition in the array
        for idx, hook_def in enumerate(hook_record["hooks"]):
            nested_errors = validate_hook_definition(hook_def, f"{event_name}.hooks[{idx}]")
            errors.extend(nested_errors)

    # Check matcher requirement
    if expects_matcher and "matcher" not in hook_record:
        errors.append(f"{event_name}: matcher-based event missing 'matcher' key")

    # Check for invalid keys
    invalid_keys = set(hook_record.keys()) - VALID_HOOK_RECORD_KEYS
    if invalid_keys:
        errors.append(f"{event_name}: invalid keys in hook record: {invalid_keys}")

    return errors


def validate_hook_definition(hook_def: dict, path: str) -> list[str]:
    """
    Validate a hook definition object (type/command structure).

    Args:
        hook_def: The hook definition to validate
        path: Path string for error reporting

    Returns:
        List of validation errors
    """
    errors = []

    if not isinstance(hook_def, dict):
        errors.append(f"{path}: hook definition must be an object, got {type(hook_def).__name__}")
        return errors

    if "type" not in hook_def:
        errors.append(f"{path}: hook definition missing required 'type' key")

    if hook_def.get("type") == "command":
        if "command" not in hook_def:
            errors.append(f"{path}: command hook missing required 'command' key")

        # Check for invalid keys in command hooks
        invalid_keys = set(hook_def.keys()) - VALID_COMMAND_HOOK_KEYS
        if invalid_keys:
            errors.append(f"{path}: invalid keys in command hook definition: {invalid_keys}")

    return errors


def test_settings_json_valid():
    """Test that settings.json is valid JSON."""
    settings = load_settings_json()
    assert isinstance(settings, dict)


def test_hooks_section_exists():
    """Test that hooks section exists in settings.json."""
    settings = load_settings_json()
    assert "hooks" in settings
    assert isinstance(settings["hooks"], dict)


def test_output_style_stays_default_for_coding_profile():
    """Default output style preserves Claude Code's built-in coding-oriented behavior."""
    settings = load_settings_json()
    assert settings.get("outputStyle") == "Default"
def test_all_hook_events_are_known():
    """Test that all hook events in settings are known event types."""
    settings = load_settings_json()
    hook_events = set(settings["hooks"].keys())

    unknown_events = hook_events - HOOK_EVENTS
    assert not unknown_events, f"Unknown hook events in settings.json: {unknown_events}"


def test_hook_events_have_arrays():
    """Test that all hook events contain arrays of hook records."""
    settings = load_settings_json()

    for event_name, event_value in settings["hooks"].items():
        assert isinstance(event_value, list), f"{event_name}: must be an array"
        assert len(event_value) > 0, f"{event_name}: array must not be empty"


def test_all_events_use_nested_hooks_format():
    """
    Test that ALL events use the nested {"hooks": [...]} format.

    According to official Claude Code documentation, all hook events
    must use the nested structure, not flat format.

    See: https://code.claude.com/docs/en/hooks.md
    """
    settings = load_settings_json()

    for event_name, event_array in settings["hooks"].items():
        for idx, hook_record in enumerate(event_array):
            assert "hooks" in hook_record, (
                f"{event_name}[{idx}]: missing 'hooks' key - "
                f"ALL events must use nested format per official docs. "
                f"Correct: {{'hooks': [{{'type': 'command', 'command': '...'}}]}}"
            )
            assert isinstance(hook_record["hooks"], list), (
                f"{event_name}[{idx}]: 'hooks' must be an array"
            )


def test_matcher_based_events_have_correct_structure():
    """Test that matcher-based events have matcher and hooks keys."""
    settings = load_settings_json()

    for event_name in MATCHER_EVENTS:
        if event_name not in settings["hooks"]:
            continue

        event_array = settings["hooks"][event_name]
        for idx, hook_record in enumerate(event_array):
            assert "matcher" in hook_record, (
                f"{event_name}[{idx}]: matcher-based event missing 'matcher' key"
            )
            assert "hooks" in hook_record, (
                f"{event_name}[{idx}]: matcher-based event missing 'hooks' key"
            )
            assert isinstance(hook_record["hooks"], list), (
                f"{event_name}[{idx}]: 'hooks' must be an array"
            )


def test_post_tool_use_tracks_all_file_write_tools():
    """File-writing tools must all update session state for Stop gating."""
    settings = load_settings_json()

    post_tool_hooks = settings["hooks"].get("PostToolUse", [])
    matchers = {hook.get("matcher", "") for hook in post_tool_hooks}

    assert "Edit|MultiEdit|Write|NotebookEdit" in matchers


def test_notification_hook_targets_notification_script():
    """Notification hook should point at the bundled notification script."""
    settings = load_settings_json()

    notification_hooks = settings["hooks"].get("Notification", [])
    assert notification_hooks, "Notification hook must be configured"

    record = notification_hooks[0]
    assert "matcher" not in record, "Notification hook should use the non-matcher form in this profile"

    nested_hooks = record.get("hooks", [])
    assert nested_hooks, "Notification hook must define nested hooks"

    hook_def = nested_hooks[0]
    assert hook_def.get("type") == "command"
    assert hook_def.get("command") == "\"$HOME\"/.claude/hooks/notification.sh"
    assert hook_def.get("async") is True
def test_non_matcher_events_dont_have_matcher():
    """Test that non-matcher events don't have matcher key."""
    settings = load_settings_json()

    non_matcher_events = HOOK_EVENTS - MATCHER_EVENTS

    for event_name in non_matcher_events:
        if event_name not in settings["hooks"]:
            continue

        event_array = settings["hooks"][event_name]
        for idx, hook_record in enumerate(event_array):
            assert "matcher" not in hook_record, (
                f"{event_name}[{idx}]: 'matcher' key only valid for: "
                f"{', '.join(sorted(MATCHER_EVENTS))}"
            )


def test_no_invalid_keys_in_hook_records():
    """Test that hook records don't contain invalid keys."""
    settings = load_settings_json()

    for event_name, event_array in settings["hooks"].items():
        expects_matcher = event_name in MATCHER_EVENTS

        for idx, hook_record in enumerate(event_array):
            errors = validate_hook_record(hook_record, f"{event_name}[{idx}]", expects_matcher)
            assert not errors, f"Validation errors: {'; '.join(errors)}"


def test_hook_definitions_have_required_keys():
    """Test that all hook definitions have required 'type' and 'command' keys."""
    settings = load_settings_json()

    for event_name, event_array in settings["hooks"].items():
        for idx, hook_record in enumerate(event_array):
            hook_list = hook_record.get("hooks", [])
            for nested_idx, hook_def in enumerate(hook_list):
                assert "type" in hook_def, (
                    f"{event_name}[{idx}].hooks[{nested_idx}]: missing 'type' key"
                )
                if hook_def.get("type") == "command":
                    assert "command" in hook_def, (
                        f"{event_name}[{idx}].hooks[{nested_idx}]: "
                        f"command hook missing 'command' key"
                    )


def test_regression_no_flat_format_without_hooks_key():
    """
    Regression test: prevent 'PermissionDenied: Invalid key in record' error.

    This error occurred when hook records were missing the required 'hooks' key.
    All events must use nested format: {"hooks": [{"type": "...", "command": "..."}]}

    Flat format without 'hooks' key is INVALID per official documentation.
    """
    settings = load_settings_json()

    for event_name, event_array in settings["hooks"].items():
        for idx, hook_record in enumerate(event_array):
            # The key assertion: 'hooks' must exist in every record
            assert "hooks" in hook_record, (
                f"{event_name}[{idx}]: CRITICAL - missing 'hooks' key causes "
                f"'PermissionDenied: Invalid key in record' error. "
                f"Per https://code.claude.com/docs/en/hooks.md, ALL events require "
                f"nested format: {{'hooks': [{{'type': 'command', 'command': '...'}}]}}"
            )

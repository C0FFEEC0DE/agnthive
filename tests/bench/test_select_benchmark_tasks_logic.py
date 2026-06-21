"""Tests for previously-uncovered logic in select-benchmark-tasks.py.

Covers select_tasks branches (all/global-behavior/resume/fixture/agent/overlap
exclusion), unresolved_previous_tasks, the output helpers (format_label,
write_github_output, limit_tasks, apply_priority_profile), loaders, and pure
helpers (frontmatter_field, normalize_string_list, task_overlap_key,
is_global_behavior_change, impacted_fixtures). select_tasks is exercised with
synthetic task lists; the output helpers that call iter_tasks() use the real
repo's task set.
"""

import importlib.util
import json
from pathlib import Path

import pytest


def load_module():
    repo_root = Path(__file__).resolve().parents[2]
    module_path = repo_root / "scripts" / "select-benchmark-tasks.py"
    spec = importlib.util.spec_from_file_location("select_benchmark_tasks", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _task(tid, suite, *, path=None, related_agents=None, fixture="", overlap_key=None):
    return {
        "id": tid,
        "suite": suite,
        "_path": path or f"bench/tasks/{tid}.json",
        "related_agents": related_agents or [],
        "fixture": fixture,
        "overlap_key": overlap_key,
    }


SUITE = "subagents_smoke"


# ---- is_global_behavior_change ----

class TestIsGlobalBehaviorChange:
    def test_global_file(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.is_global_behavior_change(["CLAUDE.md"]) is True

    def test_global_prefix(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.is_global_behavior_change(["claudecfg/hooks/lib.sh"]) is True

    def test_unrelated(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.is_global_behavior_change(["docs/readme.md"]) is False

    def test_empty(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.is_global_behavior_change([]) is False


# ---- impacted_fixtures ----

def test_impacted_fixtures(monkeypatch, tmp_path):
    m = load_module()
    assert m.impacted_fixtures(["bench/fixtures/text-report/x.py", "docs/a.md"]) == {"text-report"}
    assert m.impacted_fixtures(["src/app.py"]) == set()


def test_impacted_agents_resolves_and_skips_unknown(monkeypatch, tmp_path):
    m = load_module()
    monkeypatch.setattr(m, "AGENT_FILE_TO_ALIAS", {"known_agent.md": "k"})
    monkeypatch.setattr(m, "SKILL_TO_ALIAS", {"known_skill.md": "s"})
    aliases = m.impacted_agents([
        "claudecfg/agents/known_agent.md",    # resolved -> k
        "claudecfg/agents/unknown_agent.md",  # not in map -> skipped (144->146)
        "claudecfg/skills/known_skill.md",    # resolved -> s
        "claudecfg/skills/unknown_skill.md",  # not in map -> skipped (148->140)
        "docs/unrelated.md",                  # neither agents nor skills path
    ])
    assert aliases == {"k", "s"}


# ---- task_overlap_key ----

class TestOverlapKey:
    def test_valid(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.task_overlap_key({"overlap_key": "  k  "}) == "k"

    def test_missing(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.task_overlap_key({}) is None
        assert m.task_overlap_key({"overlap_key": "   "}) is None


# ---- normalize_string_list ----

class TestNormalizeStringList:
    def test_filters_empty_and_non_str(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.normalize_string_list(["a", "  b  ", "", "  ", 5, None]) == ["a", "b"]

    def test_non_list(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.normalize_string_list("not a list") == []
        assert m.normalize_string_list(None) == []


# ---- frontmatter_field ----

class TestFrontmatterField:
    def test_reads_field(self, monkeypatch, tmp_path):
        m = load_module()
        p = tmp_path / "agent.md"
        p.write_text("---\nname: Tester\nalias: t\n---\nbody", encoding="utf-8")
        assert m.frontmatter_field(p, "alias") == "t"

    def test_no_frontmatter(self, monkeypatch, tmp_path):
        m = load_module()
        p = tmp_path / "x.md"
        p.write_text("no frontmatter here", encoding="utf-8")
        assert m.frontmatter_field(p, "alias") is None

    def test_missing_field(self, monkeypatch, tmp_path):
        m = load_module()
        p = tmp_path / "x.md"
        p.write_text("---\nname: Tester\n---\n", encoding="utf-8")
        assert m.frontmatter_field(p, "alias") is None


# ---- build_*_map (agent/skill label resolution) ----

class TestBuildMaps:
    def _agents_dir(self, tmp_path):
        d = tmp_path / "claudecfg" / "agents"
        d.mkdir(parents=True)
        return d

    def _skills_dir(self, tmp_path):
        d = tmp_path / "claudecfg" / "skills"
        d.mkdir(parents=True)
        return d

    def test_build_agent_file_map_skips_no_alias(self, monkeypatch, tmp_path):
        m = load_module()
        d = self._agents_dir(tmp_path)
        (d / "noalias.md").write_text("---\nname: NoAlias\n---\nbody", encoding="utf-8")
        (d / "has.md").write_text("---\nname: Has\nalias: h\n---\nbody", encoding="utf-8")
        monkeypatch.setattr(m, "REPO_ROOT", tmp_path)
        assert m.build_agent_file_map() == {"has.md": "h"}

    def test_build_agent_name_map_skips_no_alias_and_no_name(self, monkeypatch, tmp_path):
        m = load_module()
        d = self._agents_dir(tmp_path)
        # no alias -> both `if alias` and `if alias and name` False.
        (d / "noalias.md").write_text("---\nname: NoAlias\n---\nbody", encoding="utf-8")
        # alias but no name -> `if alias and name` False.
        (d / "alnoname.md").write_text("---\nalias: a\n---\nbody", encoding="utf-8")
        # alias and name -> mapped.
        (d / "full.md").write_text("---\nname: Full\nalias: f\n---\nbody", encoding="utf-8")
        monkeypatch.setattr(m, "REPO_ROOT", tmp_path)
        mapping = m.build_agent_name_map()
        assert mapping.get("a") == "a"  # alias-only still maps alias->alias
        assert mapping.get("f") == "f"
        assert mapping.get("full") == "f"
        assert "noalias" not in mapping

    def test_build_skill_map_skips_unmapped_agent(self, monkeypatch, tmp_path):
        m = load_module()
        d = self._skills_dir(tmp_path)
        # skill with no agent field -> alias None -> skipped.
        (d / "noagent.md").write_text("---\n---\nbody", encoding="utf-8")
        # skill whose agent is not in AGENT_NAME_TO_ALIAS -> alias None -> skipped.
        (d / "unknown.md").write_text("---\nagent: Ghost\n---\nbody", encoding="utf-8")
        # skill whose agent maps to an alias -> recorded.
        (d / "known.md").write_text("---\nagent: Tester\n---\nbody", encoding="utf-8")
        monkeypatch.setattr(m, "REPO_ROOT", tmp_path)
        monkeypatch.setattr(m, "AGENT_NAME_TO_ALIAS", {"tester": "t"})
        assert m.build_skill_map() == {"known.md": "t"}


# ---- loaders ----

class TestLoaders:
    def test_load_changed_files_none(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.load_changed_files(None) == []

    def test_load_changed_files_missing(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.load_changed_files(str(tmp_path / "nope.txt")) == []

    def test_load_changed_files_reads(self, monkeypatch, tmp_path):
        m = load_module()
        p = tmp_path / "c.txt"
        p.write_text("a.py\n\n  b.py  \n", encoding="utf-8")
        assert m.load_changed_files(str(p)) == ["a.py", "b.py"]

    def test_load_previous_summary_none(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.load_previous_summary(None) is None

    def test_load_previous_summary_missing_raises(self, monkeypatch, tmp_path):
        m = load_module()
        with pytest.raises(FileNotFoundError):
            m.load_previous_summary(str(tmp_path / "nope.json"))

    def test_load_previous_summary_reads(self, monkeypatch, tmp_path):
        m = load_module()
        p = tmp_path / "s.json"
        p.write_text(json.dumps({"unresolved_task_ids": ["t1"]}), encoding="utf-8")
        assert m.load_previous_summary(str(p)) == {"unresolved_task_ids": ["t1"]}


# ---- select_tasks ----

class TestSelectTasks:
    def test_all_mode(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE), _task("t2", SUITE), _task("t3", "other")]
        sel, reasons = m.select_tasks(tasks, SUITE, [], "all")
        assert [t["id"] for t in sel] == ["t1", "t2"]
        assert "manual_all" in reasons

    def test_global_behavior_selects_all(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE), _task("t2", SUITE)]
        sel, reasons = m.select_tasks(tasks, SUITE, ["CLAUDE.md"], "changed")
        assert [t["id"] for t in sel] == ["t1", "t2"]
        assert "global_behavior_change" in reasons

    def test_task_path_hit(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE, path="bench/tasks/t1.json"),
                 _task("t2", SUITE, path="bench/tasks/t2.json")]
        sel, reasons = m.select_tasks(tasks, SUITE, ["bench/tasks/t2.json"], "changed")
        assert [t["id"] for t in sel] == ["t2"]
        assert "task_file_change" in reasons

    def test_fixture_hit(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE, fixture="text-report"),
                 _task("t2", SUITE, fixture="other")]
        sel, reasons = m.select_tasks(tasks, SUITE, ["bench/fixtures/text-report/x.py"], "changed")
        assert [t["id"] for t in sel] == ["t1"]
        assert "fixture_change" in reasons

    def test_agent_hit(self, monkeypatch, tmp_path):
        m = load_module()
        # Hermetic: patch the skill->alias map so we don't depend on real repo state.
        monkeypatch.setattr(m, "SKILL_TO_ALIAS", {"test.md": "t"})
        tasks = [_task("t1", SUITE, related_agents=["t"]),
                 _task("t2", SUITE, related_agents=["cr"])]
        sel, reasons = m.select_tasks(tasks, SUITE, ["claudecfg/skills/test.md"], "changed")
        assert [t["id"] for t in sel] == ["t1"]
        assert "agent_or_skill_change" in reasons

    def test_overlap_exclusion(self, monkeypatch, tmp_path):
        m = load_module()
        # Two suites; tasks share an overlap_key. Excluding the other suite's
        # overlap removes the shared task from this suite's selection.
        shared = "shared-behavior"
        this = [_task("t1", SUITE, overlap_key=shared),
                _task("t2", SUITE, overlap_key=None)]
        other_suite = "other_suite"
        monkeypatch.setitem(m.SUITE_DEFAULTS, other_suite, "bench/tasks/other/*.json")
        other = [_task("o1", other_suite, overlap_key=shared)]
        tasks = this + other
        sel, reasons = m.select_tasks(
            tasks, SUITE, ["CLAUDE.md"], "changed",
            exclude_overlap_with_suites=[other_suite],
        )
        # global_behavior_change selects all of `this`; overlap exclusion drops t1.
        assert [t["id"] for t in sel] == ["t2"]
        assert "overlap_excluded:other_suite" in reasons

    def test_overlap_exclusion_skips_self_suite(self, monkeypatch, tmp_path):
        m = load_module()
        # Excluding the current suite itself is a no-op (guard: excluded == suite).
        tasks = [_task("t1", SUITE, overlap_key="k")]
        sel, reasons = m.select_tasks(
            tasks, SUITE, ["CLAUDE.md"], "changed",
            exclude_overlap_with_suites=[SUITE],
        )
        assert [t["id"] for t in sel] == ["t1"]
        assert not any(r.startswith("overlap_excluded") for r in reasons)

    def test_overlap_exclusion_skips_when_other_suite_has_no_overlap_keys(self, monkeypatch, tmp_path):
        m = load_module()
        other_suite = "other_suite"
        monkeypatch.setitem(m.SUITE_DEFAULTS, other_suite, "bench/tasks/other/*.json")
        # Other suite's tasks carry no overlap_key -> overlap_keys empty -> no exclusion.
        this = [_task("t1", SUITE, overlap_key="shared")]
        other = [_task("o1", other_suite, overlap_key=None)]
        sel, reasons = m.select_tasks(
            this + other, SUITE, ["CLAUDE.md"], "changed",
            exclude_overlap_with_suites=[other_suite],
        )
        assert [t["id"] for t in sel] == ["t1"]
        assert not any(r.startswith("overlap_excluded") for r in reasons)

    def test_overlap_exclusion_skips_when_no_actual_overlap(self, monkeypatch, tmp_path):
        m = load_module()
        other_suite = "other_suite"
        monkeypatch.setitem(m.SUITE_DEFAULTS, other_suite, "bench/tasks/other/*.json")
        # Other suite has overlap keys, but none match this suite's selected keys
        # -> filtered == selected -> no exclusion (321->303).
        this = [_task("t1", SUITE, overlap_key="this-key")]
        other = [_task("o1", other_suite, overlap_key="other-key")]
        sel, reasons = m.select_tasks(
            this + other, SUITE, ["CLAUDE.md"], "changed",
            exclude_overlap_with_suites=[other_suite],
        )
        assert [t["id"] for t in sel] == ["t1"]
        assert not any(r.startswith("overlap_excluded") for r in reasons)

    def test_no_changes_selects_nothing(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE)]
        sel, reasons = m.select_tasks(tasks, SUITE, ["docs/unrelated.md"], "changed")
        assert sel == []
        assert reasons == []

    def test_resume_requires_previous_summary(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE)]
        with pytest.raises(ValueError):
            m.select_tasks(tasks, SUITE, [], "resume", previous_summary=None)

    def test_resume_selects_unresolved(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE, path="bench/tasks/t1.json"),
                 _task("t2", SUITE, path="bench/tasks/t2.json")]
        prev = {"unresolved_task_ids": ["t2"]}
        sel, reasons = m.select_tasks(tasks, SUITE, [], "resume", previous_summary=prev)
        assert [t["id"] for t in sel] == ["t2"]
        assert "resume_previous_unresolved" in reasons

    def test_resume_with_no_resolvable_tasks_selects_nothing(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE, path="bench/tasks/t1.json")]
        # unresolved id references a task that no longer exists -> resumed empty
        # -> `if resumed_tasks` False (276->279); no resume reason.
        prev = {"unresolved_task_ids": ["ghost"]}
        sel, reasons = m.select_tasks(tasks, SUITE, [], "resume", previous_summary=prev)
        assert sel == []
        assert "resume_previous_unresolved" not in reasons


# ---- unresolved_previous_tasks ----

class TestUnresolvedPrevious:
    def test_explicit_ids_and_paths(self, monkeypatch, tmp_path):
        m = load_module()
        suite_tasks = [_task("t1", SUITE, path="bench/tasks/t1.json"),
                       _task("t2", SUITE, path="bench/tasks/t2.json")]
        prev = {"unresolved_task_ids": ["t1"], "unresolved_task_paths": ["bench/tasks/t2.json"]}
        sel = m.unresolved_previous_tasks(prev, suite_tasks)
        assert {t["id"] for t in sel} == {"t1", "t2"}

    def test_fallback_to_tasks_status(self, monkeypatch, tmp_path):
        m = load_module()
        suite_tasks = [_task("t1", SUITE, path="bench/tasks/t1.json"),
                       _task("t2", SUITE, path="bench/tasks/t2.json")]
        prev = {"tasks": [
            {"task_id": "t1", "status": "failed", "task_path": "bench/tasks/t1.json"},
            {"task_id": "t2", "status": "passed", "task_path": "bench/tasks/t2.json"},
        ]}
        sel = m.unresolved_previous_tasks(prev, suite_tasks)
        assert [t["id"] for t in sel] == ["t1"]

    def test_no_previous_returns_empty(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.unresolved_previous_tasks(None, [_task("t1", SUITE)]) == []

    def test_falls_back_to_task_path_when_id_unknown(self, monkeypatch, tmp_path):
        m = load_module()
        suite_tasks = [_task("t1", SUITE, path="bench/tasks/t1.json")]
        prev = {"tasks": [
            # task_id not in suite_tasks, but task_path matches -> selected via path.
            {"task_id": "ghost", "status": "failed", "task_path": "bench/tasks/t1.json"},
        ]}
        sel = m.unresolved_previous_tasks(prev, suite_tasks)
        assert [t["id"] for t in sel] == ["t1"]

    def test_explicit_unresolved_path_not_in_suite_skipped(self, monkeypatch, tmp_path):
        m = load_module()
        suite_tasks = [_task("t1", SUITE, path="bench/tasks/t1.json")]
        prev = {"unresolved_task_paths": ["bench/tasks/missing.json"]}
        # path not in tasks_by_path -> nothing selected (227->225).
        assert m.unresolved_previous_tasks(prev, suite_tasks) == []

    def test_previous_task_with_unknown_id_and_path_skipped(self, monkeypatch, tmp_path):
        m = load_module()
        suite_tasks = [_task("t1", SUITE, path="bench/tasks/t1.json")]
        prev = {"tasks": [
            # both task_id and task_path unknown -> neither branch selects (239->230).
            {"task_id": "ghost", "status": "failed", "task_path": "bench/tasks/missing.json"},
        ]}
        assert m.unresolved_previous_tasks(prev, suite_tasks) == []


# ---- limit_tasks / apply_priority_profile ----

class TestLimitAndPriority:
    def test_limit_none(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE), _task("t2", SUITE)]
        assert m.limit_tasks(tasks, None, []) == tasks

    def test_limit_truncates(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE), _task("t2", SUITE), _task("t3", SUITE)]
        reasons = []
        out = m.limit_tasks(tasks, 2, reasons)
        assert [t["id"] for t in out] == ["t1", "t2"]
        assert "task_limit:2" in reasons

    def test_limit_no_op_when_under(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE)]
        assert m.limit_tasks(tasks, 5, []) == tasks

    def test_priority_no_profile(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE), _task("t2", SUITE)]
        assert m.apply_priority_profile(tasks, None) == tasks

    def test_priority_orders_by_profile(self, monkeypatch, tmp_path):
        m = load_module()
        monkeypatch.setitem(m.PRIORITY_PROFILES, "p", ["t2", "t1"])
        tasks = [_task("t1", SUITE), _task("t2", SUITE), _task("t3", SUITE)]
        out = m.apply_priority_profile(tasks, "p")
        assert [t["id"] for t in out] == ["t2", "t1", "t3"]  # t3 unknown -> last


# ---- format_label / write_github_output ----

class TestOutput:
    def test_format_label_empty(self, monkeypatch, tmp_path):
        m = load_module()
        assert m.format_label([], SUITE) == ""

    def test_format_label_small_set(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task("t1", SUITE), _task("t2", SUITE)]
        assert m.format_label(tasks, SUITE) == "t1, t2"

    def test_format_label_large_set(self, monkeypatch, tmp_path):
        m = load_module()
        tasks = [_task(f"t{i}", SUITE) for i in range(6)]
        label = m.format_label(tasks, SUITE)
        assert label.endswith("+2 more")

    def test_format_label_all_suite_uses_default(self, monkeypatch, tmp_path):
        m = load_module()
        suite_tasks = [t for t in m.iter_tasks() if t.get("suite") == SUITE]
        if not suite_tasks:
            pytest.skip("no real suite tasks in repo")
        assert m.format_label(suite_tasks, SUITE) == m.SUITE_DEFAULTS[SUITE]

    def test_write_github_output_stdout(self, monkeypatch, tmp_path, capsys):
        m = load_module()
        monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
        tasks = [_task("t1", SUITE, path="bench/tasks/t1.json")]
        m.write_github_output(tasks, ["task_file_change"], SUITE)
        out = json.loads(capsys.readouterr().out)
        assert out["should_run"] is True
        assert out["task_ids"] == ["t1"]

    def test_write_github_output_file(self, monkeypatch, tmp_path):
        m = load_module()
        out_file = tmp_path / "gh.txt"
        monkeypatch.setenv("GITHUB_OUTPUT", str(out_file))
        tasks = [_task("t1", SUITE, path="bench/tasks/t1.json")]
        m.write_github_output(tasks, ["task_file_change"], SUITE)
        text = out_file.read_text(encoding="utf-8")
        assert "should_run=true" in text
        assert "task_files<<__TASKS__" in text
        assert "bench/tasks/t1.json" in text
        assert "__TASKS__" in text

    def test_write_github_output_empty_no_tasks(self, monkeypatch, tmp_path, capsys):
        m = load_module()
        monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
        m.write_github_output([], [], SUITE)
        out = json.loads(capsys.readouterr().out)
        assert out["should_run"] is False
        assert out["selection_reason"] == "no_matching_changes"

    def test_write_github_output_file_empty_task_lines(self, monkeypatch, tmp_path):
        m = load_module()
        out_file = tmp_path / "gh.txt"
        monkeypatch.setenv("GITHUB_OUTPUT", str(out_file))
        # No selected tasks -> task_lines empty -> the `if task_lines` branch is
        # False, so no task body is written between the heredoc markers.
        m.write_github_output([], ["no_matching_changes"], SUITE)
        text = out_file.read_text(encoding="utf-8")
        assert "should_run=false" in text
        assert "task_files<<__TASKS__\n__TASKS__\n" in text


# ---- main ----

class TestMain:
    def test_main_changed_mode(self, monkeypatch, tmp_path, capsys):
        m = load_module()
        changed = tmp_path / "c.txt"
        changed.write_text("CLAUDE.md\n", encoding="utf-8")
        monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
        monkeypatch.setattr("sys.argv", [
            "select-benchmark-tasks.py", "--suite", SUITE,
            "--changed-files-file", str(changed), "--selection-mode", "changed",
        ])
        m.main()
        out = json.loads(capsys.readouterr().out)
        assert out["should_run"] is True
        assert "global_behavior_change" in out["selection_reason"]
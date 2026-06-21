import importlib.util
import json
from pathlib import Path


def load_matrix_module():
    repo_root = Path(__file__).resolve().parents[2]
    module_path = repo_root / "scripts" / "build-benchmark-matrix.py"
    spec = importlib.util.spec_from_file_location("build_benchmark_matrix", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_chunk_task_paths_even_distribution():
    module = load_matrix_module()
    result = module.chunk_task_paths(["a", "b", "c", "d", "e"], 2)
    assert result == [["a", "c", "e"], ["b", "d"]]


def test_chunk_task_paths_fewer_tasks_than_shards():
    module = load_matrix_module()
    result = module.chunk_task_paths(["a"], 3)
    assert result == [["a"]]


def test_chunk_task_paths_empty():
    module = load_matrix_module()
    assert module.chunk_task_paths([], 2) == []


def test_chunk_task_paths_single_shard():
    module = load_matrix_module()
    result = module.chunk_task_paths(["a", "b", "c"], 1)
    assert result == [["a", "b", "c"]]


def test_chunk_task_paths_more_shards_than_tasks():
    module = load_matrix_module()
    result = module.chunk_task_paths(["a", "b"], 5)
    assert result == [["a"], ["b"]]


def test_build_matrix_shard_metadata():
    module = load_matrix_module()
    result = module.build_matrix(["a", "b", "c", "d", "e"], 3)
    assert len(result) == 3
    assert result[0]["shard_index"] == 1
    assert result[0]["task_count"] == 2
    assert result[0]["task_files"] == "a\nd"
    assert result[1]["shard_index"] == 2
    assert result[1]["task_count"] == 2
    assert result[1]["task_files"] == "b\ne"
    assert result[2]["shard_index"] == 3
    assert result[2]["task_count"] == 1
    assert result[2]["task_files"] == "c"


def test_build_matrix_empty():
    module = load_matrix_module()
    assert module.build_matrix([], 2) == []


def test_load_task_paths_missing_file(tmp_path):
    module = load_matrix_module()
    assert module.load_task_paths(tmp_path / "does-not-exist.txt") == []


def test_load_task_paths_strips_and_filters_blanks(tmp_path):
    module = load_matrix_module()
    p = tmp_path / "tasks.txt"
    p.write_text("a.json\n\n  b.json  \n   \n", encoding="utf-8")
    assert module.load_task_paths(p) == ["a.json", "b.json"]


def test_main_prints_matrix_json(monkeypatch, tmp_path, capsys):
    module = load_matrix_module()
    p = tmp_path / "tasks.txt"
    p.write_text("a.json\nb.json\nc.json\n", encoding="utf-8")
    monkeypatch.setattr(
        "sys.argv",
        ["build-benchmark-matrix.py", "--task-list-file", str(p), "--max-shards", "2"],
    )
    module.main()
    out = json.loads(capsys.readouterr().out)
    assert len(out) == 2
    assert out[0]["shard_index"] == 1
    assert out[1]["shard_index"] == 2


def test_main_missing_task_list_file(monkeypatch, tmp_path, capsys):
    module = load_matrix_module()
    monkeypatch.setattr(
        "sys.argv",
        ["build-benchmark-matrix.py", "--task-list-file", str(tmp_path / "nope.txt")],
    )
    module.main()
    assert json.loads(capsys.readouterr().out) == []


def test_main_default_max_shards(monkeypatch, tmp_path, capsys):
    module = load_matrix_module()
    p = tmp_path / "tasks.txt"
    p.write_text("a.json\n", encoding="utf-8")
    monkeypatch.setattr(
        "sys.argv", ["build-benchmark-matrix.py", "--task-list-file", str(p)]
    )
    module.main()
    out = json.loads(capsys.readouterr().out)
    assert out == [{"shard_index": 1, "task_files": "a.json", "task_count": 1}]

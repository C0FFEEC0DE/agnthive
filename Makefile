SHELL := /bin/bash

BENCH_OUTPUT_DIR ?= /tmp/claude-bench
BENCH_TASK_GLOB ?= bench/tasks/subagents/smoke/*.json
BENCH_TASK_LIST ?=
BENCH_TASK_LABEL ?=
BENCH_SOURCE_REF ?= working-tree
BENCH_RUNNER_CMD ?= python3 scripts/bench_runner_claude_code.py
BENCH_ANTHROPIC_BASE_URL ?= http://127.0.0.1:11434
BENCH_ANTHROPIC_AUTH_TOKEN ?=
BENCH_ANTHROPIC_API_KEY ?=
# No model is pinned by default; set OLLAMA_MODEL (or a BEHAVIOR_BENCHMARK_MODEL
# repo variable in CI) to the model id you want the benchmark runner to use.
OLLAMA_MODEL ?=
CLAUDE_CODE_MAX_OUTPUT_TOKENS ?= 768

BENCH_TASK_ARGS = --task-glob '$(BENCH_TASK_GLOB)'
ifneq ($(strip $(BENCH_TASK_LIST)),)
BENCH_TASK_ARGS = --task-list-file '$(BENCH_TASK_LIST)'
endif
ifneq ($(strip $(BENCH_TASK_LABEL)),)
BENCH_LABEL_ARGS = --task-label '$(BENCH_TASK_LABEL)'
endif

.PHONY: all lint hooks test node-test cov validate clean bench-mock bench-smoke bench-command bench-assert bench-report bench-rerun-failed

# Default: lint + test + hook contract tests.
all: lint test hooks

# Node test suites (test/bench, test/unit, test/security, ...). The glob form
# is required: `node --test test/unit/` (directory form) fails on Node 22 with
# "Cannot find module"; the quoted glob lets Node expand it recursively.
node-test:
	node --test 'test/**/*.test.mjs'

# Lint: Node ESM syntax check + python compile + ruff (if available). The hook
# runtime is now a platform-independent Node plugin (no Bash/shell scripts
# remain in the repo), so shell-syntax/shellcheck steps are no longer needed.
lint:
	node scripts/lint.mjs
	python -m compileall -q .
	@if command -v ruff >/dev/null 2>&1; then ruff check .; \
	else echo "ruff not installed, skipping"; fi

hooks:
	node scripts/test-hooks.mjs

# Full repository self-check (Node ESM port of the former scripts/validate.sh).
validate:
	node scripts/validate.mjs

test: node-test
	pytest -q

# Coverage with a ratcheting gate (branch coverage on scripts/*.py).
# COV_MIN defaults to the current baseline (100); raise it as coverage improves.
# The gate is intentionally NOT applied to `test` so CI on the existing suite
# is unaffected. Requires pytest-cov.
COV_MIN ?= 100
cov:
	@if command -v pytest >/dev/null 2>&1 && python3 -c "import pytest_cov" >/dev/null 2>&1; then \
		pytest -q tests/ --cov=scripts --cov-branch \
			--cov-report=term-missing --cov-fail-under=$(COV_MIN); \
	else echo "pytest-cov not installed, skipping coverage gate"; fi

# Remove regenerable test/benchmark artifacts so repeated runs do not exhaust
# disk quota. Safe: every file/dir removed here is recreated by the target that
# produced it. Covers: coverage data, pytest + python caches, and benchmark
# per-task logs/output (BENCH_OUTPUT_DIR defaults to /tmp/claude-bench, but a
# caller may point it inside the repo, so clean both).
clean:
	rm -rf .coverage .coverage.* htmlcov coverage.xml
	rm -rf .pytest_cache
	find . -name __pycache__ -type d -not -path '*/.git/*' -prune -exec rm -rf {} + 2>/dev/null || true
	rm -rf '$(BENCH_OUTPUT_DIR)' bench-output bench-output-*
	@echo "clean: removed coverage data, python caches, and benchmark output"

bench-mock:
	node scripts/run-benchmark.mjs \
		--output-dir '$(BENCH_OUTPUT_DIR)' \
		--mode mock \
		--ref '$(BENCH_SOURCE_REF)' \
		$(BENCH_TASK_ARGS) \
		$(BENCH_LABEL_ARGS)
	node scripts/assert-benchmark-summary.mjs '$(BENCH_OUTPUT_DIR)/summary.json'

bench-smoke: bench-command

bench-command:
	ANTHROPIC_BASE_URL='$(BENCH_ANTHROPIC_BASE_URL)' \
	ANTHROPIC_AUTH_TOKEN='$(BENCH_ANTHROPIC_AUTH_TOKEN)' \
	ANTHROPIC_API_KEY='$(BENCH_ANTHROPIC_API_KEY)' \
	OLLAMA_MODEL='$(OLLAMA_MODEL)' \
	CLAUDE_CODE_MAX_OUTPUT_TOKENS='$(CLAUDE_CODE_MAX_OUTPUT_TOKENS)' \
	BENCH_RUNNER_CMD='$(BENCH_RUNNER_CMD)' \
	node scripts/run-benchmark.mjs \
		--output-dir '$(BENCH_OUTPUT_DIR)' \
		--mode command \
		--ref '$(BENCH_SOURCE_REF)' \
		$(BENCH_TASK_ARGS) \
		$(BENCH_LABEL_ARGS)
	node scripts/assert-benchmark-summary.mjs '$(BENCH_OUTPUT_DIR)/summary.json'

bench-assert:
	node scripts/assert-benchmark-summary.mjs '$(BENCH_OUTPUT_DIR)/summary.json'

bench-report:
	@cat '$(BENCH_OUTPUT_DIR)/benchmark-report.md'

# Re-run only the FAILED subagent smoke tasks in CI (via workflow_dispatch
# auto_resume), instead of the whole suite — saves Ollama credits. Optional
# RUN_ID=12345 resumes a specific prior run instead of the last failed one.
bench-rerun-failed:
	node scripts/rerun-failed-benchmark.mjs $(if $(RUN_ID),--run-id $(RUN_ID))

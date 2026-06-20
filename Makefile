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

.PHONY: all lint hooks test bench-mock bench-smoke bench-command bench-assert bench-report bench-rerun-failed

# Default: lint + test + hook contract tests.
all: lint test hooks

# Lint: shell syntax + shellcheck (if available) + python compile + ruff (if available).
lint:
	@bash -n claudecfg/hooks/*.sh scripts/*.sh scripts/git-hooks/pre-push claudecfg/statusline.sh
	@if command -v shellcheck >/dev/null 2>&1; then \
		shellcheck claudecfg/hooks/*.sh scripts/*.sh scripts/git-hooks/pre-push claudecfg/statusline.sh; \
	else echo "shellcheck not installed, skipping"; fi
	python -m compileall -q .
	@if command -v ruff >/dev/null 2>&1; then ruff check .; \
	else echo "ruff not installed, skipping"; fi

hooks:
	bash scripts/test-hooks.sh
	bash scripts/test-hooks.sh tests/hooks/scenarios.json

test:
	pytest -q

bench-mock:
	bash scripts/run-benchmark.sh \
		--output-dir '$(BENCH_OUTPUT_DIR)' \
		--mode mock \
		--ref '$(BENCH_SOURCE_REF)' \
		$(BENCH_TASK_ARGS) \
		$(BENCH_LABEL_ARGS)
	bash scripts/assert-benchmark-summary.sh '$(BENCH_OUTPUT_DIR)/summary.json'

bench-smoke: bench-command

bench-command:
	ANTHROPIC_BASE_URL='$(BENCH_ANTHROPIC_BASE_URL)' \
	ANTHROPIC_AUTH_TOKEN='$(BENCH_ANTHROPIC_AUTH_TOKEN)' \
	ANTHROPIC_API_KEY='$(BENCH_ANTHROPIC_API_KEY)' \
	OLLAMA_MODEL='$(OLLAMA_MODEL)' \
	CLAUDE_CODE_MAX_OUTPUT_TOKENS='$(CLAUDE_CODE_MAX_OUTPUT_TOKENS)' \
	BENCH_RUNNER_CMD='$(BENCH_RUNNER_CMD)' \
	bash scripts/run-benchmark.sh \
		--output-dir '$(BENCH_OUTPUT_DIR)' \
		--mode command \
		--ref '$(BENCH_SOURCE_REF)' \
		$(BENCH_TASK_ARGS) \
		$(BENCH_LABEL_ARGS)
	bash scripts/assert-benchmark-summary.sh '$(BENCH_OUTPUT_DIR)/summary.json'

bench-assert:
	bash scripts/assert-benchmark-summary.sh '$(BENCH_OUTPUT_DIR)/summary.json'

bench-report:
	@cat '$(BENCH_OUTPUT_DIR)/benchmark-report.md'

# Re-run only the FAILED subagent smoke tasks in CI (via workflow_dispatch
# auto_resume), instead of the whole suite — saves Ollama credits. Optional
# RUN_ID=12345 resumes a specific prior run instead of the last failed one.
bench-rerun-failed:
	bash scripts/rerun-failed-benchmark.sh $(if $(RUN_ID),--run-id $(RUN_ID))

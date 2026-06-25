SHELL := /bin/bash

BENCH_OUTPUT_DIR ?= /tmp/claude-bench
BENCH_TASK_GLOB ?= bench/tasks/subagents/smoke/*.json
BENCH_TASK_LIST ?=
BENCH_TASK_LABEL ?=
BENCH_SOURCE_REF ?= working-tree
BENCH_RUNNER_CMD ?= node scripts/bench_runner_claude_code.mjs
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

.PHONY: all lint hooks test node-test cov validate clean bench-mock bench-smoke bench-command bench-assert bench-report bench-rerun-failed bench-precheck

# Default: lint + test + hook contract tests.
all: lint test hooks

# Node test suites (test/bench, test/unit, test/security, ...). The glob form
# is required: `node --test test/unit/` (directory form) fails on Node 22 with
# "Cannot find module"; the quoted glob lets Node expand it recursively.
node-test:
	node --test 'test/**/*.test.mjs'

# Lint: Node ESM syntax check only. The hook runtime is a platform-independent
# Node plugin (no Bash/shell scripts remain in the repo), and the fixtures/
# validators were ported from Python to Node --test .mjs, so there is no Python
# source tree left to compile or lint.
lint:
	node scripts/lint.mjs

hooks:
	node scripts/test-hooks.mjs

# Full repository self-check (Node ESM port of the former scripts/validate.sh).
validate:
	node scripts/validate.mjs

test: node-test

# The ratcheting branch-coverage gate (COV_MIN=100 on scripts/*.py) was retired
# when the bench runners were ported from Python to Node ESM: scripts/ is now
# Node-only, so there is no Python source tree left to cover. The validator
# suite (test/validators/) was ported to Node --test .mjs, so no Python coverage
# gate remains. `make cov` is kept as an alias of `make test` for muscle memory.
cov: node-test

# Remove regenerable test/benchmark artifacts so repeated runs do not exhaust
# disk quota. Safe: every file/dir removed here is recreated by the target that
# produced it. Covers: coverage data and benchmark per-task logs/output
# (BENCH_OUTPUT_DIR defaults to /tmp/claude-bench, but a caller may point it
# inside the repo, so clean both).
clean:
	rm -rf .coverage .coverage.* htmlcov coverage.xml
	rm -rf '$(BENCH_OUTPUT_DIR)' bench-output bench-output-*
	@echo "clean: removed coverage data and benchmark output"

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

# Local replica of the "Behavior Benchmark Subagents Smoke Precheck" CI job:
# collect changed files, select subagent smoke tasks, validate task/fixture
# alignment, build the shard matrix, and print a ready-to-run `make bench-smoke`
# command for the selected tasks. Deterministic (no model/token needed).
# Pass extra flags through BENCH_PRECHECK_FLAGS, e.g.
#   make bench-precheck BENCH_PRECHECK_FLAGS='--selection-mode=all --no-validators'
bench-precheck:
	node scripts/bench-precheck.mjs \
		--output-dir '$(BENCH_OUTPUT_DIR)' \
		$(BENCH_PRECHECK_FLAGS)

bench-report:
	@cat '$(BENCH_OUTPUT_DIR)/benchmark-report.md'

# Re-run only the FAILED subagent smoke tasks in CI (via workflow_dispatch
# auto_resume), instead of the whole suite — saves Ollama credits. Optional
# RUN_ID=12345 resumes a specific prior run instead of the last failed one.
bench-rerun-failed:
	node scripts/rerun-failed-benchmark.mjs $(if $(RUN_ID),--run-id $(RUN_ID))

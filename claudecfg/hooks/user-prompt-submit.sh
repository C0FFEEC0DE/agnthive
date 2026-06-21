#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib.sh"

ensure_state

stop_safe_hint=" If a later reply in the same session makes no additional changes, still report the actual verification, review, changed files, docs status when relevant, and remaining risks instead of using a no-change shortcut after code or config changes."

prompt="$(json_get '.prompt' | tr '[:upper:]' '[:lower:]')"
task_type="other"
manager_mode="none"
required_subagents='[]'
required_subagent_any_of='[]'
context_message=""
informational_model_query="false"
override_task_type=""
docs_required="false"

if grep -Eiq '(^|[[:space:]])(@m|@manager|/manager)($|[[:space:][:punct:]])' <<<"$prompt"; then
    manager_mode="orchestrate"
fi

if grep -Eiq '(plan only|only plan|plan-only|только план|только спланиру|только составь план|сделай план,? но не выполняй|без выполнения|без реализации)' <<<"$prompt"; then
    manager_mode="plan_only"
fi

override_task_type="$(
    grep -Eo 'workflow override: treat this as a (feature|bugfix|refactor|review|docs|support|other) workflow' <<<"$prompt" \
        | sed -E 's/.* a ([a-z]+) workflow/\1/' \
        | head -n1 || true
)"

if [ -z "$override_task_type" ]; then
    override_task_type="$(
        grep -Eo 'workflow_category:[[:space:]]*(feature|bugfix|refactor|review|docs|support|other)' <<<"$prompt" \
            | sed -E 's/.*workflow_category:[[:space:]]*([a-z]+)/\1/' \
            | head -n1 || true
    )"
fi

if grep -Eiq '(model|models|llm|ollama|openrouter|qwen|llama|deepseek|mistral|claude|gpt|gemini|command r|модел|модели|модель)' <<<"$prompt" \
    && grep -Eiq '(which|what|recommend|recommendation|compare|best|better|vs|versus|open source|opensource|closed model|api|creative|creativity|style|storytelling|какую|какой|посовет|совет|рекоменд|сравн|лучш|выбрат|подскажи|подбери|нужн|креатив|стиль|сторител|иде[йи])' <<<"$prompt" \
    && ! grep -Eiq '(feature|implement|add support|integrat|new capability|фич|добав|интеграц|подключ|fix|bug|defect|баг|ошиб|исправ|refactor|rename|cleanup|tech debt|рефактор|почист|переимен|review|audit|ревью|аудит|проверь|docs|readme|document|док|ридми)' <<<"$prompt"; then
    informational_model_query="true"
fi

if [ -n "$override_task_type" ]; then
    task_type="$override_task_type"
elif [ "$informational_model_query" = "true" ]; then
    task_type="other"
elif grep -Eiq '(^|[^[:alpha:]])(bugfix|bug|defect|regression|fix|fixes|fixed|fixing|баг|ошиб|исправ)([^[:alpha:]]|$)' <<<"$prompt"; then
    task_type="bugfix"
elif grep -Eiq '(refactor|rename|cleanup|tech debt|рефактор|почист|переимен)' <<<"$prompt"; then
    task_type="refactor"
elif grep -Eiq '(review|audit|ревью|аудит|проверь)' <<<"$prompt"; then
    task_type="review"
elif grep -Eiq '(docs|readme|document|док|ридми)' <<<"$prompt"; then
    task_type="docs"
elif grep -Eiq '(feature|implement|add support|integrat|new capability|фич|добав|интеграц|подключ|модел|pyrit|openrouter)' <<<"$prompt"; then
    task_type="feature"
fi

if [ -z "$override_task_type" ] && [ "$informational_model_query" != "true" ] && [ "$task_type" != "other" ]; then
    has_code_signals="false"
    if grep -Eiq '(\.py\b|\.js\b|\.ts\b|\.tsx\b|\.jsx\b|\.rs\b|\.go\b|\.java\b|\.kt\b|\.c\b|\.cc\b|\.cpp\b|\.h\b|\.hpp\b|package\.json\b|pyproject\.toml\b|cargo\.toml\b|go\.mod\b|pom\.xml\b|build\.gradle\b|cmakelists\.txt\b|makefile\b|dockerfile\b|src/|tests?/|pytest\b|jest\b|vitest\b|npm\b|yarn\b|pnpm\b|pip\b|venv\b|ci\b|github actions\b|pull request\b|commit\b|branch\b|diff\b|patch\b|код\b|файл\b|репозитор|проект\b)' <<<"$prompt"; then
        has_code_signals="true"
    fi

    has_tech_support_signals="false"
    if grep -Eiq '(fedora|ubuntu|debian|arch linux|kernel|ядро|dmesg|lsusb|udev|systemctl|modemmanager|ttyusb|ttys|/dev/tty|dialout|uucp|com[- ]?port|rs[- ]?232|serial|usb[- ]?to[- ]?serial|driver|драйвер|pilot[- ]?link|hotsync|palm\b|palmos|кредл|док[- ]?станц)' <<<"$prompt"; then
        has_tech_support_signals="true"
    fi

    if [ "$has_tech_support_signals" = "true" ] && [ "$has_code_signals" != "true" ]; then
        task_type="support"
    fi
fi

if [ "$manager_mode" = "plan_only" ]; then
    required_subagents='[]'
    required_subagent_any_of='[]'
fi

case "$task_type" in
    feature)
        if [ "$manager_mode" != "plan_only" ]; then
            required_subagents="$(jq -cn --argjson existing "$required_subagents" '$existing + ["t","cr"] | unique')"
            required_subagent_any_of='[["e","a"]]'
        fi
        context_message="Treat this as a feature workflow."
        docs_required="true"
        ;;
    bugfix)
        if [ "$manager_mode" != "plan_only" ]; then
            required_subagents="$(jq -cn --argjson existing "$required_subagents" '$existing + ["t","cr"] | unique')"
            required_subagent_any_of='[["bug","e","dbg"]]'
        fi
        context_message="Treat this as a bugfix workflow."
        docs_required="true"
        ;;
    refactor)
        if [ "$manager_mode" != "plan_only" ]; then
            required_subagents="$(jq -cn --argjson existing "$required_subagents" '$existing + ["t","cr"] | unique')"
            required_subagent_any_of='[["a","e"]]'
        fi
        context_message="Treat this as a refactor workflow."
        docs_required="true"
        ;;
    review)
        if [ "$manager_mode" != "plan_only" ]; then
            required_subagents="$(jq -cn --argjson existing "$required_subagents" '$existing + ["cr"] | unique')"
        fi
        context_message="Treat this as a review workflow."
        ;;
    docs)
        if [ "$manager_mode" != "plan_only" ]; then
            required_subagents="$(jq -cn --argjson existing "$required_subagents" '$existing + ["doc"] | unique')"
        fi
        context_message="Treat this as a docs workflow."
        docs_required="true"
        ;;
    support)
        context_message="Treat this as a support workflow."
        ;;
esac

if [ -n "$context_message" ]; then
    case "$task_type" in
        feature)
            if [ "$manager_mode" = "orchestrate" ]; then
                context_message="${context_message} Manager-led orchestration is active. Required before completion: successful verification or @t, plus @cr and one of @e/@a. Start the first required specialist handoff early instead of spending multiple turns in manager-only exploration. Keep the workflow moving through implementation, verification, review, and docs when behavior changes.${stop_safe_hint}"
            elif [ "$manager_mode" = "plan_only" ]; then
                context_message="${context_message} Plan-only manager mode is active. Return a concrete execution plan without continuing implementation or specialist handoffs in this session."
            else
                context_message="${context_message} Required before completion: successful verification or @t, plus @cr and one of @e/@a. Finish implementation, run verification successfully, address review findings, and update docs when behavior changes. release/deploy remains out of scope.${stop_safe_hint}"
            fi
            ;;
        bugfix)
            if [ "$manager_mode" = "orchestrate" ]; then
                context_message="${context_message} Manager-led orchestration is active. Required before completion: successful verification or @t, plus @cr and one of @bug/@e/@dbg. Start the first required specialist handoff early instead of spending multiple turns in manager-only exploration. Reproduce or describe the failure mode, implement the fix, execute regression verification, and update docs if behavior changed.${stop_safe_hint}"
            elif [ "$manager_mode" = "plan_only" ]; then
                context_message="${context_message} Plan-only manager mode is active. Return a concrete bugfix plan without continuing implementation or specialist handoffs in this session."
            else
                context_message="${context_message} Required before completion: successful verification or @t, plus @cr and one of @bug/@e/@dbg. Reproduce or describe the failure mode, implement the fix, execute regression verification, and update docs if behavior changed.${stop_safe_hint}"
            fi
            ;;
        refactor)
            if [ "$manager_mode" = "orchestrate" ]; then
                context_message="${context_message} Manager-led orchestration is active. Required before completion: successful verification or @t, plus @cr and one of @a/@e. Start the first required specialist handoff early instead of spending multiple turns in manager-only exploration. Keep scope to structure and maintainability, preserve behavior, run verification after changes, and decide whether docs need updates.${stop_safe_hint}"
            elif [ "$manager_mode" = "plan_only" ]; then
                context_message="${context_message} Plan-only manager mode is active. Return a concrete refactor plan without continuing implementation or specialist handoffs in this session."
            else
                context_message="${context_message} Required before completion: successful verification or @t, plus @cr and one of @a/@e. Keep scope to structure and maintainability, preserve behavior, run verification after changes, and summarize risks plus changed files before stopping.${stop_safe_hint}"
            fi
            ;;
        review)
            if [ "$manager_mode" = "orchestrate" ]; then
                context_message="${context_message} Manager-led orchestration is active. Required specialist handoff before completion: @cr. Start the code-reviewer handoff early instead of extending manager-only analysis. Focus on findings first, call out residual risks or testing gaps, and keep implementation out of scope unless the user explicitly asks for fixes.${stop_safe_hint}"
            elif [ "$manager_mode" = "plan_only" ]; then
                context_message="${context_message} Plan-only manager mode is active. Return the review plan without continuing specialist handoffs in this session."
            else
                context_message="${context_message} Required subagent handoff before completion: @cr. Focus on findings first, call out residual risks or testing gaps, and keep implementation out of scope unless the user explicitly asks for fixes.${stop_safe_hint}"
            fi
            ;;
        docs)
            if [ "$manager_mode" = "orchestrate" ]; then
                context_message="${context_message} Manager-led orchestration is active. Required specialist handoff before completion: @doc. Start the docwriter handoff early instead of extending manager-only analysis. Keep documentation accurate to current behavior, include examples when they materially help, and note any remaining drift or missing verification.${stop_safe_hint}"
            elif [ "$manager_mode" = "plan_only" ]; then
                context_message="${context_message} Plan-only manager mode is active. Return the docs plan without continuing specialist handoffs in this session."
            else
                context_message="${context_message} Required subagent handoff before completion: @doc. Keep documentation accurate to current behavior, include examples when they materially help, and note any remaining drift or missing verification.${stop_safe_hint}"
            fi
            ;;
        support)
            if [ "$manager_mode" = "plan_only" ]; then
                context_message="${context_message} Plan-only manager mode is active. Return the diagnostic plan without implementation or specialist handoffs in this session."
            else
                context_message="${context_message} Keep this in advisory or troubleshooting mode unless the user explicitly requests repository changes. No workflow-specific specialist handoffs are required before completion."
            fi
            ;;
    esac
fi

_atomic_state_update \
    --arg task_type "$task_type" \
    --arg manager_mode "$manager_mode" \
    --argjson docs_required "$docs_required" \
    --argjson required_subagents "$required_subagents" \
    --argjson required_subagent_any_of "$required_subagent_any_of" \
    '.task_type = $task_type
    | .manager_mode = $manager_mode
    | .docs_required = $docs_required
    | .required_subagents = $required_subagents
    | .required_subagent_any_of = $required_subagent_any_of
    # A real user prompt starts a new attempt after a terminal stop-hook
    # failure.  Continuations caused by Stop do not fire UserPromptSubmit, so
    # this cannot reset an in-flight loop.
    | .stop_block_count = 0
    | .stop_block_reason = ""
    | .stop_block_message = ""
    | .stalled_by_policy = false
    | .policy_stall_reason = ""'

if [ -n "$context_message" ]; then
    emit_context "UserPromptSubmit" "$context_message"
    exit 0
fi

exit 0

# План: стабилизация benchmark dispatch без смены модели

Note (2026-06-25): The benchmark fixtures have since been ported from Python to Node; they now run via node --test against calculator.mjs and reporter.mjs under bench/fixtures/. The pytest and calculator.py references below describe the state at the time this plan was written and are preserved as history.

## Цель и границы

Улучшить наблюдаемость и вероятность реального agent dispatch для
`glm-5.2:cloud`, не меняя модель и не засчитывая текстовое упоминание агента
за вызов Agent tool.

Инварианты:

- `strict`-режим засчитывает только фактический `SubagentStart`.
- Inline-работа с прошедшим `pytest` остаётся функциональным успехом, но не
  dispatch-успехом.
- `dispatch_enforced` маркируется отдельно: это проверка поведения под
  ограничением harness, не естественная оркестрация модели.
- Не менять модель и не маскировать красный strict-result.

## Этап 1. Зафиксировать исходную статистику

1. Прогнать только два падающих task по 5–10 раз каждый.
2. Сохранить для каждого запуска:
   - наличие Agent tool в доступных инструментах;
   - первый tool call;
   - `SubagentStart` события;
   - изменённые файлы и `pytest`;
   - stop reason и число turns.
3. Сформировать таблицу `role × route × attempts` для трёх способов:
   - текущий `@bug` / `@t`;
   - slash route `/bug` / `/test`;
   - явный вызов Agent tool с каноническим именем роли, взятым из фактической
     tool schema.

Результат: станет ясно, проблема в alias/skill routing или в принципиальном
отказе модели делегировать.

## Этап 2. Сделать evidence строгим и наблюдаемым

Изменить `scripts/bench_runner_claude_code.mjs`.

1. Разделить источники evidence:
   - `hook`: `SubagentStart` или `Recorded subagent handoff`;
   - `transcript`: launch-like запись в transcript;
   - `claimed`: `Handoff evidence:` или текст финального ответа.
2. Для `required_used_agents` в strict-задачах принимать только `hook`.
3. `claimed` сохранить в `summary.json` как диагностику, но не использовать
   для pass/fail.
4. В summary добавить:
   - `observed_agent_aliases`;
   - `claimed_agent_aliases`;
   - `agent_evidence_by_alias`;
   - `dispatch_mode`.

Это устранит противоречие: сейчас текст `Handoff evidence` способен
засчитываться как usage, хотя задача заявлена как проверка реального Agent tool.

## Этап 3. Устранить конфликт task contract и generic workflow contract

Сейчас benchmark говорит «нужен только `@bug`», но категория `bugfix` в plugin
добавляет `@t`, `@cr` и one-of группу. Для маленькой task это лишнее и создаёт
разные требования у runner и hook.

1. В task JSON добавить явный контракт:

```json
"dispatch_contract": {
  "mode": "observed",
  "required_agents": ["bug"],
  "root_only": true
}
```

Для tester — `["t"]`.

2. В `buildPrompt()` генерировать компактный машинно-читаемый marker:

```text
BENCHMARK_DISPATCH_CONTRACT: root_only; mode=observed; roles=bug
```

3. В `plugins/agent-hive/modules/workflow.mjs` распарсить marker.
   Если он есть:
   - `required_subagents` взять только из marker;
   - `required_subagent_any_of` очистить;
   - не добавлять category-default роли.
4. Marker должен присутствовать только в root prompt, чтобы subagent не пытался
   рекурсивно запускать самого себя.

## Этап 4. Унифицировать маршруты навыков

Сравнить и выровнять `bug` с рабочими агентскими skills.

1. Превратить `plugins/agent-hive/skills/bug/SKILL.md` из
   минимального command-skill в agent-backed skill по форме `skills/test`:
   - `agent: Bugbuster`;
   - `context: fork`;
   - ограниченный `allowed-tools`;
   - допустимые paths.
2. Не гадать о синтаксисе Agent tool в prompt: строить его из доступной tool
   schema или использовать маршрут, который A/B probe показал рабочим.
3. Для benchmark prompt требовать:
   - первый содержательный action — запуск нужного specialist;
   - root не выполняет `Edit`/`Write` до появления `SubagentStart`;
   - роль и scope конкретны.

## Этап 5. Добавить `dispatch_enforced` как отдельный режим

Этот этап выполнять только после A/B probe — если direct route иногда работает,
но модель выбирает inline-работу.

1. Добавить второй режим:

```json
"dispatch_contract": {
  "mode": "enforced",
  "required_agents": ["bug"],
  "root_only": true
}
```

2. В `plugins/agent-hive/hooks/hooks.json` зарегистрировать
   `PreToolUse` также для `Edit|MultiEdit|Write|NotebookEdit`.
3. В `handlePreToolUse`:
   - до старта обязательной роли отклонять parent `Edit`/`Write`;
   - при необходимости блокировать mutating Bash;
   - вернуть короткое actionable сообщение: «требуется Agent dispatch к
     `@bug`; следующий action — запуск specialist».
4. После `SubagentStart` ограничение снимается.
5. Не использовать этот режим для strict-observed benchmark: он отдельный, с
   отдельным именем и отчётом.

## Этап 6. Разделить CI-результаты

В workflow создать три явно названные линии:

| Линия | Что означает pass |
| --- | --- |
| `functional` | Фикс, тест и итог корректны |
| `dispatch-observed` | Модель сама вызвала Agent tool |
| `dispatch-enforced` | Модель вызвала Agent tool после hard guard harness |

`dispatch-observed` не должен быть скрыт или «чиниться» через final text. Если
он остаётся красным, это честный capability signal.

Если PR нельзя блокировать из-за stochastic одного прогона, blocking merge
check должен быть `functional`; observed-dispatch остаётся видимым отдельным
check. Если strict-dispatch обязан блокировать merge, он законно останется
красным, пока GLM не начнёт делегировать стабильно.

## Этап 7. Тесты и критерии готовности

Добавить тесты на:

- strict mode не принимает `Handoff evidence` без `SubagentStart`;
- marker корректно отменяет category-default agent requirements;
- `bug` проходит validator как agent-backed skill;
- `PreToolUse` в enforced mode блокирует root edits до dispatch и разрешает
  после;
- summary корректно разделяет `observed` и `claimed`;
- существующие task fixtures валидны.

Готово, когда:

1. `npm test` и hook/validator tests зелёные.
2. `subagent-bugbuster` и `subagent-tester` имеют корректный единый контракт в
   runner и hook.
3. В отчёте нельзя перепутать «модель сказала, что делегировала» и «модель
   реально вызвала Agent».
4. Есть повторный замер по 5–10 попыток и понятен dispatch-rate для каждого
   маршрута.
5. Workflow-комментарий обновлён: без устаревшего утверждения о 9/11 и без
   двусмысленности о strict/evidence.

## Результаты Этапа 1 (локальный замер 2026-06-24, без платного ключа)

> **ИСПРАВЛЕНИЕ 2026-06-24 (apples-to-apples реальный bench runner).** Нижеследующий
> замер через hand-crafted probe содержал ошибку скрипта: `run_one` НЕ делал `cd`
> в workdir перед `claude -p`, поэтому claude запускался в **корне репозитория**
> (cwd фоновой shell), а не в изолированном workdir. Из-за этого probe показал
> «надёжный dispatch + escape в fixture репо» — оба артефакта скрипта, не поведение
> bench runner'а. Реальный bench runner (dummy token, настоящий `buildPrompt`,
> изолированный workdir) даёт **противоположный** результат — см.
> «Результаты Этапа 1b» ниже. Вывод о routing/refusal в нижеследующем тексте
> **неверен**; корректный вывод — under-delegation реальна под настоящим bench
> prompt'ом. Workdir-изоляция bench runner'а при этом **работает корректно**
> (правки ложатся в workdir, fixture репо чист). Текст probe оставлен для
> истории ошибки.

Локальный Ollama проксирует `glm-5.2:cloud` через ollama.com по сохранённую
учётке — платный `OLLAMA_API_KEY` не нужен. Чтобы Claude Code в headless `-p`
не коротил на «Not logged in», нужен непустой `ANTHROPIC_AUTH_TOKEN`
(placeholder; локальный Ollama его игнорирует):

```
ANTHROPIC_BASE_URL=http://127.0.0.1:11434 ANTHROPIC_AUTH_TOKEN=dummy-local-not-used \
OLLAMA_MODEL=glm-5.2:cloud claude -p ... --plugin-dir plugins/agent-hive
```

Замер: 3 маршрута (A=alias `@bug`, B=slash `/bug`, C=явный Agent tool с
`subagent_type Bugbuster`) × по 3 попытки, прямой `claude -p` с плагином.
Из 9 запусков 4 завершились до остановки зонда (A-1, B-1, C-1, A-2); все 4
согласованы:

| run | SubagentStart | правка в workdir | правка в репо |
| --- | ---: | --- | --- |
| A-1 | 12 | нет | да (`bench/fixtures/python-math/`) |
| B-1 | 6  | нет | да |
| C-1 | 6  | нет | (увидел `git status` от earlier runs, заявил «уже починено») |
| A-2 | 12 | нет | да |

**Главный вывод — проблема НЕ в routing и НЕ в принципиальном отказе
делегировать.** `glm-5.2:cloud` надёжно запускает сабагентов через Agent tool
по всем трём маршрутам (`SubagentStart` срабатывает 6–12 раз за запуск).
Реальная причина провала — **сабагент не остаётся в изолированном workdir
бенчмарка**: он `cd` в настоящий fixture репо
(`/var/home/chaos_weaver/code/claude-crew/bench/fixtures/python-math/`) и
редактирует/тестирует его, а не копию в workdir задачи. Поэтому runner видит
`workspace_changed=false` (копия нетронута) и ставит задаче fail, хотя сабот
реально выполнен — но в неправильном месте. Ни один запуск не сослался на
путь probe-workdir (`/tmp/stage1-probe/...`).

> *Следствие ниже отменено исправлением в начале раздела: «модель уже
> делегирует» и «Этап 5 НЕ нужен» — артефакты confounded probe (корень репо +
> `CLAUDE.md`), не bench-условия. Корректный вывод — см.
> «Результаты Этапа 1b»; Stage 5 остаётся экспериментом.*

**Следствие для плана:** Этап 5 (`dispatch_enforced` hard guard), по всей
видимости, НЕ нужен — модель уже делегирует. Реальный фикс — изоляция workdir
в harness/prompt: сабот должен работать в копии fixture внутри workdir задачи,
а не в `bench/fixtures/python-math/` репо. Это и валидность бенчмарка, и
safety (зонд мутировал реальный fixture репо — откачено через `git checkout`).

**Неразрешённое расхождение с CI-памятью:** CI-замер (PR #4, sha fb37fc3,
ДО правок Этапов 2–6) показывал `used_agent_aliases: []` (9/11 under-delegation).
Локальный замер (ПОСЛЕ Этапов 2–6, dispatch_contract marker + agent-backed
bug skill) показывает надёжный dispatch. Гипотеза: правки Этапов 2–6
исправили under-delegation, либо поведение зависит от длинного bench-prompt'а
vs короткого probe-prompt'а. **Нужен apples-to-apples замер**: прогнать
настоящий bench runner (dummy token) на bugbuster-задаче и проверить,
dispatch'ит ли модель под реальным buildPrompt и воспроизводится ли
workdir-escape там. После — откатить любое мутирование `bench/fixtures/python-math/`.

**Ограничения:** 4 запуска (не 5–10), hand-crafted prompt (не точный bench
prompt), модель работала через локальный прокси (не напрямую ollama.com cloud).
Предварительно — но направление ясное: routing/refusal отброшены, корневая
причина — изоляция workdir.

## Результаты Этапа 1b (исправление: реальный bench runner, 2026-06-24)

Прогон **настоящего** bench runner'а (`scripts/run-benchmark.mjs` →
`scripts/bench_runner_claude_code.mjs`) на одной задаче
`subagent-bugbuster-zero-division-lite` с dummy-токеном, реальным
`buildPrompt`, изолированным workdir, `OLLAMA_MODEL=glm-5.2:cloud`,
`--plugin-dir plugins/agent-hive`, `--max-turns 8`:

Поля `result.json` runner'а:

| поле | значение |
| --- | --- |
| `status` | `failed` |
| `observed_agent_aliases` (hook) | `[]` — реального `SubagentStart` НЕТ |
| `claimed_agent_aliases` (text) | `["bug"]` — только `Handoff evidence: @bug ...` в прозе |
| `agent_evidence_by_alias.bug` | `{hook: false, transcript: false, claimed: true}` |
| `dispatch_mode` | `observed` |
| `failures` / `tool_failures` | `["required_used_agents_missing"]` / `1` — это та же dispatch-failure (не aborted Agent-call) |
| `tests_run` / `tests_passed` | `true` / `true` (3 passed) |
| `changed_files` | `calculator.py, test_calculator.py` — **в workdir** |
| fixture репо | **чист** (`git diff --quiet -- bench/fixtures/python-math` = 0) |

Дополнительно (не поля `result.json`): `num_turns=7` — из raw Claude
result-payload (debug-лог runner'а), не из структурированного `result.json`.
Старое поле `used_agent_aliases:["bug"]` (text-credited) всё ещё сидит в записи
рядом с пустым `observed_agent_aliases:[]` — pass/fail корректно использует
`observed`, но сосуществование двух полей — поверхность путаницы, которую
Stage 2 формально не убрал.

Gate lines (производная классификация — рендерится `render-benchmark-summary.mjs`
из `summary.json`, это НЕ поля `summary.json`): `functional=passed`
(merge-blocking), `dispatch-observed=failed` (Agent tool не вызван),
`dispatch-enforced=no-enforced-tasks` (Stage 5 не подключен).

**Корректный вывод (заменяет вывод probe):**

1. **Under-delegation реальна и подтверждена apples-to-apples.** Под настоящим
   bench prompt'ом `glm-5.2:cloud` НЕ вызывает Agent tool — делает работу
   inline, пишет `Handoff evidence: @bug ...` текстом, `observed_agent_aliases`
   пуст. Это **точно совпадает с CI-памятью** (`used_agent_aliases: []`,
   9/11 under-delegation, sha fb37fc3). Расхождения с CI нет — правки Этапов
   2–6 не «исправили» under-delegation; они лишь разделили CI-линии, чтобы
   functional-progress не тонул в dispatch-failure.

2. **Workdir-изоляция bench runner'а работает корректно.** Правки легли в копию
   fixture внутри workdir; `bench/fixtures/python-math/` репо осталась чистой,
   откатывать нечего. «Escape в fixture репо» из probe был артефактом скрипта
   (claude запущен в корне репо, а не в workdir), НЕ багом harness'а.

3. **Этапы 2–6 продемонстрированы на одном локальном прогоне** (не «валидированы
   в CI» — gate lines здесь выведены локально, не измерены в CI). Gate-line
   split дал целевую картину: `functional=passed` (merge-blocking, прогресс
   мерджируется), `dispatch-observed=failed` (видимый non-blocking честный
   capability signal), `dispatch-enforced=n/a`. Это и есть назначение правок
   Этапов 2–6; один локальный прогон подтверждает, что split рендерится верно.

4. **Этап 5 (`dispatch_enforced` hard guard) — это эксперимент, который надо
   построить и проверить, а не уже доказанный рычаг.** Probe показал, что
   **жёсткая инструкция** («Do NOT edit any file yourself; only @bug touches the
   code; start by calling the Agent tool») elicitiрует реальный dispatch — 6–12
   `SubagentStart`, тогда как мягкая формулировка bench prompt'а («start the
   first required handoff» + «modify existing files in place») оставляет
   inline-путь открытым, и glm его берёт. **НО этот сигнал конфаундирован**:
   probe бежал в корне репо, где claude видит `CLAUDE.md`, насыщенный
   dispatch-протоколом/`@bug`/hook-gated языком; реальный runner бежит в
   изолированном workdir БЕЗ `CLAUDE.md`. cwd определяет не только где ложатся
   правки, но и какие context-файлы видит модель — поведенчески решающее отличие
   для dispatch salience, независимое от формулировки prompt'а. Probe и реальный
   runner отличаются минимум по трём осям (cwd/context, длина prompt'а, жёсткость
   инструкции), поэтому выживший «firm-instruction» сигнал не изолирован.
   Probe доказывает лишь, что glm *может* dispatch'ить в условиях корня-репо +
   `CLAUDE.md`; он НЕ доказывает, что glm dispatch'ит в bench-условиях (workdir,
   без `CLAUDE.md`, длинный `buildPrompt`), когда inline-путь заблокирован.
   PreToolUse guard, блокирующий root `Edit`/`Write` до `SubagentStart`,
   mechanistically убирает inline-альтернативу вместо nudging'а — это sound lever
   в принципе, но его исход до прогона неизвестен: он может дать реальный dispatch
   так же, как и no-op failure (модель не может ни редактировать, ни dispatch'ить), если
   dispatch salience приходит из контекста, а не из инструкции. Stage 5 — это
   эксперимент, который это проверит, как отдельный enforced-mode task variant с
   собственной dispatch-enforced линией.

**Ограничения 1b:** 1 прогон (не 5–10), одна задача (bugbuster), локальный прокси.
Результат under-delegation однозначен и совпадает с CI; вывод про Stage 5 —
гипотеза для проверки, а не доказанный рычаг (см. конфаунд в п.4).

**Решение по плану:** Этапы 1–4 и 6 завершены (gate-line split продемонстрирован
на одном локальном прогоне). Оставшаяся реальная работа — **Этап 5**
(dispatch_enforced PreToolUse guard + enforced-mode task fixture) как
эксперимент, проверяющий гипотезу «block inline path → модель dispatch'ит в
bench-условиях». После Stage 5 — Этап 7 (тесты + критерии готовности), включая
повторный замер 5–10 попыток по enforced-маршруту; если guard даёт no-op
failures вместо dispatch, это честный красный enforced-результат (не
маскировать).

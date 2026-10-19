# Ревью harness и упрощение agnthive

Дата: 2026-10-19. Статус: **результат ревью; целевые решения приняты в ADR 0008–0013, реализация не начата**.

База: `2cd40df`, agnthive `0.3.0`. План реализации:
[`2026-10-19-harness-modernization-and-simplification.md`](../plans/2026-10-19-harness-modernization-and-simplification.md).

Принятые решения и их отношения с историческими ADR: [индекс ADR](../adr/README.md).
Для реализации использовать контракты ADR 0008–0013; findings ниже описывают baseline.

## Вывод

Сначала исправить достоверность runtime-состояния и benchmark evidence, затем упростить orchestration. Отдельный Manager **не нужен в стандартном пути**: основная сессия уже получает запрос пользователя, планирует, вызывает Agent, проверяет результат и отвечает пользователю. Дублирование этой функции в дочернем агенте добавляет контекст, задержку и отдельные исключения в Stop/idle-логике.

Предлагаемый основной набор: **Reviewer, Explorer, Debugger**. Reviewer даёт независимый взгляд; Explorer изолирует большое исследование; Debugger изолирует воспроизведение и поиск причины. Все три вызываются по потребности. Design, Test, Docs и Refactor остаются навыками/процедурами, без обязательного отдельного агента. Bugbuster объединяется с Debugger для расследований и с Reviewer для статического анализа.

Ценность плагина — воспроизводимая проверка результата и независимое ревью существенных изменений. Обязательное посещение ролей и форматирование четырёх строк сами по себе не доказывают качество.

## Область и ограничения проверки

- Проверены hooks, dispatcher, state, workflow, summaries, агенты, skills, benchmark runner, валидаторы и CI.
- Установленный CLI: **Claude Code 2.1.292**; Node: **22.22.2**.
- На момент чтения официальный upstream changelog начинается с **2.1.303**. Это наблюдаемая версия источника, а не утверждение о версии во всех каналах доставки. Changelog не даёт даты каждому релизу; даты релизов не восстанавливались по догадке.
- Выполнены `node scripts/validate.mjs`, strict validation manifest, agents и skills; все прошли.
- `make lint test hooks`: lint 95 файлов, **766 тестов прошли**, **170 hook cases и 3 scenarios прошли**. Первый sandbox-запуск дал `spawnSync /usr/bin/node-22 EPERM`; приведён результат повторного запуска вне sandbox.
- Платные model runs, настоящий auto-mode denial, compact/resume и интеграция на 2.1.303 не запускались. Где это существенно, ниже явно указан пробел проверки.
- Runtime-код в рамках ревью не менялся. Зелёные tests подтверждают существующие fixtures, а не автоматически соответствие внешнему runtime.

## Первичные источники и актуализация

| Источник | Что использовано |
|---|---|
| [Официальный changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) | 2.1.295: `onFailure`; 2.1.299: порядок prompt/skill expansion; 2.1.302: fork в headless; 2.1.219: вложенные subagents |
| [Hooks reference](https://code.claude.com/docs/en/hooks) | Схемы событий, output и lifecycle |
| [Plugin manifest](https://code.claude.com/docs/en/plugins-reference) | Manifest, strict validation, settings, userConfig |
| [Plugin components](https://code.claude.com/docs/en/plugins/components) | Namespaced команды, поля plugin-agent, data directory |
| [Subagents](https://code.claude.com/docs/en/sub-agents) | Делегирование, tools, fork, nesting |
| [Skills](https://code.claude.com/docs/en/skills) | Процедура в основной сессии и выполнение через fork |

Короткая внешняя контрактная база: `PermissionDenied` использует `hookSpecificOutput.retry`; `UserPromptSubmit` вызывается также на возврате фоновой работы; пользовательская slash-команда приходит до expansion; `Stop` содержит сведения о фоновых задачах; `prompt_id` позволяет корреляцию; `PostCompact` не является документированным каналом синхронной инъекции контекста; для `Notification` используется `notification_type`. Основание: [Hooks reference](https://code.claude.com/docs/en/hooks).

Уже корректные возможности **сохранить**: exec-form `command + args`, `defaultEnabled: false`, `userConfig`, `subagentStatusLine`, Node-only runtime, per-agent stop counters и namespace-aware нормализацию. Они поддерживаются текущей документацией; откат к shell hooks или удаление этих manifest-полей не обоснованы. Не добавлять выдуманное поле `requirements` ради minimum-version: текущая migration spec обещает его, но manifest его не содержит.

## Findings

Severity: P1 — нарушает workflow/evidence; P2 — надёжность, совместимость или ненужная сложность. «Воспроизведено» означает локальную проверку функций/dispatcher, а не полноценный model run.

### F01 · P1 · Фоновый запуск теста считается успешной проверкой

Код: `plugins/agnthive/modules/hook-dispatcher.mjs:184`, `handlePostToolUseBash`; `verification.mjs`; `summary-contract.mjs:183`.

Обработчик передаёт `failed: false` на любой PostToolUse Bash, не анализируя завершение команды и `tool_response`. Воспроизведение: PostToolUse для `npm test`, `run_in_background: true`, ответ с `backgroundTaskId` → `tests_ok: true`. Форма ответа здесь синтетическая; ошибка видна независимо от имени поля: ответ вообще не читается.

Вторая сторона ошибки: после успешного теста `handlePostToolUseEditWrite` не инвалидирует результат. Тест до последующей правки остаётся доказательством проверки. При параллельных агентах проверка одного checkout может закрыть изменения другого.

Нужно: distinguish pending/completed/failed/unknown; привязать результат к проверенному состоянию файлов и рабочей директории. Поддерживаемые реальные payloads снять на целевом CLI. Не считать отсутствие error доказательством успеха.

### F02 · P1 · Возврат фонового агента перезаписывает workflow

Код: `hook-dispatcher.mjs:63`, `workflow.mjs:385`.

Каждый UserPromptSubmit заново классифицирует текст, перезаписывает required roles и dispatch mode, сбрасывает stop state и очищает **все** per-agent stop counters. Воспроизведён переход `feature` → `other` после сообщения `Outcome: DONE...`; существовавший counter agent-A исчезает.

Следствие: служебное сообщение может ослабить текущий контракт и вмешаться в параллельную ветку. Обратная проблема: роли и tests_ok живут всю сессию, поэтому старая работа может удовлетворять новую задачу.

Нужно: отдельный жизненный цикл активной задачи; `prompt_id` для корреляции, но **не** как доказательство происхождения сообщения. Не придумывать недокументированный `prompt_source`. Если происхождение не установлено, сохранять незавершённый контракт; использовать подтверждённые runtime-сигналы/активные agent IDs и явную границу новой задачи.

### F03 · P1 · Benchmark читает legacy state и принимает текст за hook evidence

Код: `scripts/bench_runner_claude_code.mjs:621`, `:890`; `plugins/agnthive/modules/util.mjs:18`; `state.mjs`.

Runner ищет `~/.claude/state/<session>.json`, runtime пишет event-store в `${CLAUDE_PLUGIN_DATA}/<session>/`. Воспроизведение: SessionStart сохраняет существующий transcript в новом state; `resolveTranscriptPath({session_id})` возвращает `null`.

`hookSourceAliases` ищет строки по regex во всём debug log. Воспроизведение с `buildAgentLabelMap(process.cwd())`: строка `untrusted text: Recorded subagent handoff: @cr.` даёт `hook: ['cr']`. Это доказывает слабость парсера, **не** доказанный end-to-end exploit через конкретный tool output.

Нужно: per-run structured evidence, session/run/agent identity, импорт штатного state reader либо явный индекс, никакой классификации произвольной строки как подтверждённого runtime-события. При отсутствии evidence — unknown/failure, не восстановление успеха из prose.

### F04 · P1 · Роли проверяются по запуску, не по завершённому результату

Код: `summary-contract.mjs:229`, `agents.mjs:128`, `hook-dispatcher.mjs:264`.

`subagents_started` достаточно для role gate. Завершение reviewer, его finding и связь с последней версией кода не требуются. Runtime также объединяет реальные роли с regex-упоминаниями из transcript. Запуск reviewer до реализации может закрыть gate после реализации; слово `@cr` не равно ревью.

Это системный дефект цели проверки: множество обязательных агентов создаёт процессную нагрузку, не обеспечивая заявленное качество. Исправление: доказательства выполненных действий; role roster оставить только для тестов явного dispatch.

### F05 · P2 · PermissionDenied возвращает неактуальную форму JSON

Код: `plugins/agnthive/modules/hook-output.mjs:71`, `hook-dispatcher.mjs:160`.

Воспроизведён output `{ "retry": true }`; текущая reference требует event-specific envelope (см. контрактную базу). И tests закрепляют старую форму. Исторический changelog действительно использовал shorthand `{retry:true}`, поэтому не предполагать, что это обязательно перестало работать на каждой старой версии. На целевой версии валидировать новый envelope и поведение.

### F06 · P2 · Namespaced slash-команда не включает manager mode

Код: `workflow.mjs:15`; README и все skills; `agents.mjs` launch regex.

Воспроизведено: `classifyPrompt('/agnthive:manager implement new feature').managerMode === 'none'`. [Plugin components](https://code.claude.com/docs/en/plugins/components) описывает namespaced entry points; README рекламирует короткие `/manager`, `/review` как универсальные.

Нужно нормализовать точную команду/namespace, отделить её от аргументов; учитывать новый порядок expansion. Для чужих plugin namespaces не включать локальные роли. В упрощённой схеме `/agnthive:manager` становится совместимым входом в root workflow, а не spawn Manager.

### F07 · P2 · Возврат ledger после compaction не доказан на host

Код: `hook-dispatcher.mjs:550`, `hooks/hooks.json` PostCompact async, `test/unit/progress-ledger.test.mjs`.

Tests проверяют напечатанный JSON, а не доставку ledger модели. Сейчас `additionalContext(..., 'PostCompact')` отправляется асинхронно; ни валидность этого event-specific output, ни своевременная доставка на выбранном CLI не проверены. Это **не подтверждённое утверждение**, что ledger никогда не доставляется: async delivery требует отдельного исследования.

Рекомендуется детерминированное восстановление через SessionStart `source=compact`/resume с ограниченным контекстом; PostCompact оставить для наблюдаемости. Проверить ручную/автоматическую/idle compaction и отсутствие двойной инъекции.

### F08 · P2 · Новые background/fork события не учтены в жизненном цикле

Код: `workflow.mjs:405`, `transcripts.mjs` background inference, `agents.mjs:9`, `hook-dispatcher.mjs:264`.

Stop определяет background manager по transcript-эвристике и специальной роли `m`, а не по текущим задачам. `SubagentStart` каждый раз увеличивает счётчик без agent identity: resume может стать «новым специалистом». `GENERIC_TYPES` не включает `fork`; при повреждённых aliases fallback может навязать чужому fork footer.

Нужно: idempotent lifecycle по agent ID и явная обработка unknown/fork. Пустой актуальный task list не заменять устаревшим transcript match. Не ждать в Stop произвольный cron/monitor бесконечно.

Уточнение при актуализации ADR: прежний ADR index ошибочно отрицал документированность `agent_transcript_path`. Разделять parent/subagent transcript и delivered report/closing text; при SubagentHandback это разные данные. Контракт и проверки fallback зафиксированы в [ADR 0010](../adr/0010-task-and-agent-lifecycle-identity.md).

### F09 · P1/P2 · Enforce не равен гарантии исполнения, portability неполная

Код: `hook-dispatcher.mjs:234`, `:599`, `:669`; `hooks/hooks.json`.

Ошибки state writes проглатываются, исключение handler превращается в `{}`. Hooks не задают timeout/failure policy. Поэтому «enforce fail-closed» описывает классификатор, но не отказ Node, чтения state или запуска hook. `onFailure: block` сам по себе не исправит обработчик, который проглотил ошибку и вернул exit 0.

Кроме того, matcher только Bash: PowerShell-команда не доходит до имеющего PowerShell-паттерны command policy. Это P1 для заявленного enforcement, P2 для advisory. Предлагается явно описанный режим degradation и parity для native shell tools; telemetry failures не должны прерывать работу.

Отдельно проверить семантику advisory: `handlePreToolUse` возвращает явный `permissionDecision: allow` для всех не-deny результатов. Это не нейтральное наблюдение. Не сохранять blanket allow по инерции; разрешение команды со стороны плагина должно быть осознанным контрактом, а обычный advisory passthrough — оставлять решение штатной permission flow.

### F10 · P2 · Observability и CI переоценивают полноту проверки

Код: `notifications.mjs:89`, `:113`; `.github/workflows/validate.yml:82`; `docs/plugin-best-practices.md`.

Notification сохраняет `subtype`, а не актуальное `notification_type`; agent/prompt identity не сохраняется. `postCompactPayload` пишет полный `compact_summary`, хотя комментарий обещает отсутствие prompt/transcript contents: текст summary может содержать чувствительные данные. Требуется точное описание хранения и ограничение полей/объёма, а не обещание полной redaction.

Официальный CLI в CI ставится best-effort без версии; его отсутствие превращает обязательную совместимость в skip. Strict manifest check не проверяет применение output hook к работающей сессии. `claude plugin test` предназначен для mods (подтверждено локальным `--help`); заменять им Node tests без миграции нельзя.

## Ревью набора агентов

| Сейчас | Решение | Почему и когда делегировать |
|---|---|---|
| Manager | Убрать из стандартной цепочки; root skill для orchestration | Root уже владеет целью и инструментом Agent. Отдельный координатор допустим позднее только для автономной крупной подзадачи с измеримой пользой |
| Code Reviewer | Оставить отдельным read-only агентом | Независимость от автора изменения полезна для существенного diff и security-sensitive работы |
| Explorer | Оставить опциональным | Большой/незнакомый репозиторий, параллельное исследование; не вызывать для известного маленького файла |
| Debugger | Оставить опциональным | Воспроизведение, сложный failure, логи и длительная диагностика |
| Bugbuster | Объединить | Статический поиск дефектов дублирует Reviewer; reproduction/fix дублирует Debugger |
| Architect | Навык design/refactor в root | Нужен метод принятия решения, но отдельный контекст полезен не всегда. Большую альтернативную проработку можно делегировать штатному агенту |
| Tester | Навык test; делегирование по объёму | Запуск тестов не требует отдельной персоны. Отдельный исполнитель уместен для большой test suite/новых тестов |
| Docwriter | Навык docs; делегирование по объёму | Короткое обновление README делает автор изменения. Большая документация может быть отдельной задачей |

Это архитектурная рекомендация по текущему коду; экономия токенов/времени пока **не измерена**. 782 строки agent prompts и 1413 строк трёх workflow-модулей — ориентир масштаба, не оценка токенов или доказательство overhead.

Дополнительные логические несоответствия:

- Reviewer требует «делегировать Explorer», но его `tools` содержат только Read/Glob/Grep. Передавать уже собранную карту из root; не расширять доступ только ради выполнения собственной инструкции.
- Manager запрещает Edit/Write/NotebookEdit, но наследует Bash: это организационное пожелание, а не надёжная запретительная граница записи.
- Architect с `type: Plan` имеет Edit/Write/Bash. Не считать локальное metadata-поле `type` эквивалентом runtime permission mode.
- Feature/bugfix/refactor всегда ставят `docs_required`, даже при внутренних изменениях без новой пользовательской семантики. Нужна оценка необходимости документации с объяснением `not_required`.
- `stop_hook_active` после первого блока приводит к passthrough по ADR-0003. Это защита от цикла, а не доказательство исправления. Документировать gate как ограниченное сопровождение; факт failed verification остаётся failed даже когда runtime завершил turn.
- Текущий manager canary требует реального `@m` заранее. Он измеряет выполнение команды dispatch, а не полезность Manager. На нём нельзя честно сравнить архитектуры.

## Целевая логика

1. Root понимает цель и выбирает достаточную процедуру. Для маленькой задачи работает сам.
2. Навыки содержат процедуры design/debug/test/docs/refactor; не форкаются только из-за названия этапа.
3. Агент вызывается ради независимой оценки, изоляции контекста или отдельной параллельной задачи.
4. Проверка привязана к текущим изменениям: завершённая команда, outcome, cwd/worktree, revision. Запуск Tester не заменяет результат.
5. Существенные изменения получают завершённое независимое review текущего diff. Критерии существенности: security/permissions, migration, concurrency, public API, несколько подсистем; число строк само по себе недостаточно.
6. Для trivial/docs-only задач нет обязательной квоты агентов. Решение и применённые проверки видны в отчёте. Не разрешать эвристике из одного слова в prompt отключать проверки обнаруженных изменений.
7. Root завершает задачу с результатом, проверками и ограничениями. Не блокировать полезную работу исключительно ради пунктуации footer. Структурированное evidence хранится отдельно; текстовый footer может оставаться компактной рекомендацией.

## Границы нового дизайна

- Не переписывать весь плагин в mods, Agent SDK или другой harness.
- Не вводить все новые hooks «на всякий случай». `StopFailure` полезен для диагностики; новые UI/model/worktree ownership hooks не нужны текущей задаче.
- Сохранить native permissions, per-agent isolation, Node ESM и portable paths. Не создавать собственную платформу планирования агентов.
- Хранить evidence с минимальными полями; не копировать весь transcript/compact summary по умолчанию.
- Совместимость alias и старых session logs мигрировать явно. Legacy aliases — интерфейс, не доказательство полезности старой архитектуры.
- Benchmark различает correctness, policy compliance и overhead. Enforced dispatch не выдавать за естественное поведение модели.

## Политика перехода

Сначала runtime correctness и независимые от ролей benchmarks. Затем экспериментальный lean profile с root orchestration. После сравнительных прогонов — lean default, legacy profile на один переходный релиз. Удаление deprecated agent definitions и старых исключений — отдельный совместимый переход с release notes. Во время планирования никаких bump/release/deploy не выполнять.

Целевой CLI для новой реализации: зафиксировать проверенную доступную версию; исходный кандидат — **2.1.303**. Старую 2.1.292 считать compatibility baseline, а не автоматически поддерживаемым minimum для новых hooks. Minimum объявить только по результатам version matrix. `onFailure` требует как минимум 2.1.295; доступность UserPromptExpansion проверить отдельно. Не обещать неизвестные lower-version возможности.

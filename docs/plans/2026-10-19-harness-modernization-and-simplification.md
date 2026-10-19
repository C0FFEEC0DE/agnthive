# План агенту: актуализация harness и упрощение orchestration

Дата: 2026-10-19. Статус: **готов к реализации; реализация не начата**.

Основание всех задач: [ревью и дизайн](../specs/2026-10-19-harness-review-and-simplification-design.md), baseline `2cd40df`, plugin `0.3.0`.

Решения приняты в [ADR 0008–0013](../adr/README.md); статус Accepted не означает,
что runtime уже изменён. Нормативные контракты: orchestration — 0008, evidence —
0009, lifecycle — 0010, failure policy — 0011, compatibility/rollout — 0012,
ledger/telemetry — 0013. Исторические ADR сохраняются с указанными поправками.

## Результат, который нужно получить

Плагин корректно работает с проверенной текущей версией Claude Code, не выдаёт старт тестов/агента за завершённую проверку, переживает background/compact/resume и координируется основной сессией. Основные специализированные агенты — Reviewer, Explorer, Debugger. Design/Test/Docs/Refactor — навыки без обязательного fork. Manager не нужен для обычного запуска.

Не ограничиваться переписыванием prompts: в текущем коде именно hooks и validators навязывают набор ролей. Изменять policy, evidence, prompts, tests и benchmarks согласованно.

## Указания исполнителю

- Прочитать design целиком, затем этот план; сверить HEAD и рабочие изменения. Findings привязаны к baseline, номера строк после правок изменятся.
- Не считать предложения этого документа уже работающими возможностями. Не обновлять release version до окончания реализации и проверки.
- Вести progress ledger с выполненными задачами, проверками и ревизиями; не записывать секреты и полный transcript.
- Каждый пронумерованный пункт внутри задачи — отдельный небольшой шаг. Если шаг требует нескольких файлов/исследования, разделить его на блоки по 2–5 минут; не маскировать исследование runtime как известное изменение схемы.
- Воспроизводящий тест должен падать на baseline по причине finding, а не потому что новый символ ещё не экспортирован. После исправления проверить соседние сценарии.
- Не менять исходный смысл legacy tests молча. Перенести контракт в legacy suite либо явно заменить его новым проверяемым поведением и объяснить delta.
- Не включать платный eval в offline `make precommit`. Для live-прогонов использовать уже разрешённый в окружении provider/budget; отсутствие доступа записать как unverified, не как pass.
- Не создавать дополнительные agent layers по умолчанию при исполнении плана. Один исполнитель может выполнить весь план последовательно; независимый review нужен перед завершением существенных изменений.

## Порядок поставки

| Блок | Задачи | Условие перехода |
|---|---|---|
| A. Контракт и подтверждения | 01–02 | Зафиксированы target CLI и реальные payloads |
| B. Корректность runtime | 03–08 | Новые regression tests и offline suite зелёные |
| C. Достоверные измерения | 09–10 | Native/legacy/lean можно сравнивать без квот ролей |
| D. Упрощение продукта | 11–13 | Lean работает и старые entry points имеют migration path |
| E. Проверка и переход | 14–16 | Проверенная совместимость, сравнение качества, актуальные docs |

Блок D зависит от исправления evidence: нельзя принимать архитектурное решение по benchmark, который неверно определяет dispatch или verification.

### 01. Зафиксировать контракт поддерживаемого harness

**Файлы:** новый `docs/compatibility.md`, `.github/workflows/validate.yml`, `scripts/plugin-install-smoke.mjs`, `test/unit/plugin-install-smoke.test.mjs`. Design: актуализация, F10.

1. Записать `claude --version`, Node version, plugin version/SHA; снять `claude plugin validate --help`, `plugin eval --help`, `plugin test --help` без запуска eval.
2. Проверить доступность 2.1.303 или более новой версии, которую реально удаётся установить воспроизводимо. Зафиксировать точный номер; не подменять локальную установленную CLI без необходимости, использовать отдельное окружение CI/temp.
3. Составить матрицу: event/field → supported CLI → use in plugin → test fixture → fallback. Отдельно `PermissionDenied`, UserPromptExpansion, `onFailure`, `prompt_id`, background/fork, compact, PowerShell.
4. В required CI убрать best-effort skip official validation; ошибка установки — infrastructure failure. Добавить manifest, agents, skills validation на pinned CLI. Floating latest оставить дополнительным canary.
5. Minimum-version описывать в docs/diagnostics; не добавлять неподдерживаемый manifest key. Проверить obsolete обещание `requirements` в старой migration spec.

**Приёмка:** повторный прогон фиксирует ту же версию; отсутствие CLI не даёт зелёный required check; подтверждены exec form/defaultEnabled/userConfig/settings без лишней миграции.

### 02. Добавить независимые runtime contract fixtures

**Файлы:** новая `test/compatibility/`, `scripts/test-hooks.mjs`, `test/hooks/cases.json`, `test/hooks/scenarios.json`, `test/unit/hook-output.test.mjs`. Design: F01–F10.

1. Добавить краткий fixture manifest: CLI version, источник, captured/synthetic, scenario; очистить пути и приватные данные. Не называть синтетический payload captured.
2. Снять реальные inputs для foreground/background command, return subagent, namespace slash, Stop с активной/завершённой работой, compact/resume, повторного SubagentStart. Если capture недоступен — явный pending integration check.
3. Вынести event-specific output assertions: разрешённые поля, stdout/stderr/exit code. Сохранить exit 2 для TaskCompleted/TeammateIdle; общий `{decision:block}` не является универсальной заменой.
4. Разделить direct dispatcher tests и host integration. Для host проверить не только строку JSON, но фактическое применение результата.
5. В test runner считать `spawnSync.error`/signal самостоятельным failure и печатать его, даже если status равен 0: это устраняет непрозрачность обнаруженного sandbox EPERM.

**Приёмка:** старый top-level retry обнаруживается контрактным тестом; failed spawn не выглядит как «empty stdout» без причины; fixtures не выводятся из текущих constructors.

### 03. Исправить PermissionDenied и shell parity

**Файлы:** `plugins/agnthive/modules/{hook-output,hook-dispatcher,command-policy}.mjs`, `plugins/agnthive/hooks/hooks.json`, `test/security/`, `test/integration/security-parity.test.mjs`, permission fixtures. Design: F05, F09.

1. Возвращать `{hookSpecificOutput:{hookEventName:'PermissionDenied',retry:boolean}}`; обновить unit/fixture expectations.
2. Сохранить существующие no-retry для запрещённых команд/benchmark CI. Обработку no-verdict reason не превращать в обход отказа runtime.
3. Поддержать native `PowerShell` в matchers и routing всех policy/verification events, где это необходимо. Использовать общий shell predicate, не копировать всю policy.
4. Проверить одинаковые safety cases для Bash и PowerShell: safe read, destructive operation, indirection, advisory/enforce. PowerShell response schema проверять отдельно.

**Приёмка:** documented envelope; native permissions не ослаблены; обе оболочки проходят одни инварианты. Наличие PowerShell parser без соответствующего matcher больше не выдаётся за поддержку.

### 04. Считать verification только после завершения и для текущих изменений

**Файлы:** `modules/{verification,hook-dispatcher,state,summary-contract}.mjs`, `test/unit/verification.test.mjs`, `test/integration/post-tool-use.test.mjs`, новые fixtures. Все module paths в этом плане относительны `plugins/agnthive/`. Design: F01.

1. Ввести малую нормализованную модель результата: command kind, tool use ID, status `pending|passed|failed|unknown`, cwd, worktree/scope, revision, доказательство завершения.
2. В адаптере payload → result поддержать реально снятые foreground/background ответы. Unknown response не трактовать как passed. Не привязываться только к синтетическому `backgroundTaskId` из ревью.
3. Связать background launch с completion; если надёжного completion-сигнала нет, требовать foreground rerun для gate. Не разрабатывать универсальный scheduler.
4. Ввести change revision для отслеживаемых code/config edits. Новая правка инвалидирует прежнее verification/review; результат команды, стартовавшей до параллельной правки, не закрывает новую ревизию.
5. Сохранять документы отдельно, если они не меняют требуемые build/test inputs; явно тестировать это правило. Предусмотреть Bash/external edits через diff fingerprint/checkpoint или документированный консервативный fallback — счётчик Edit/Write не покрывает весь filesystem.
6. Для разных worktrees не смешивать результаты; после интеграции изменений требуется verification результирующего diff. Не требовать git commit для каждой проверки.

**Tests:** launch background → не passed; completion success/failure; interrupted/unknown; test→edit→stop; edit→test→stop; edit during test; test worktree A ≠ changes worktree B; config edit; no detected command с явным verification gap.

**Приёмка:** Tester start никогда не заменяет тест; новый код не проходит на старом tests_ok. Отсутствие тестов отображается честно, не порождает бесконечный stop loop.

### 05. Отделить задачу от входящего сообщения и восстановить slash routing

**Файлы:** `modules/{hook-input,workflow,hook-dispatcher,state}.mjs`, `hooks/hooks.json`, `test/integration/user-prompt-submit.test.mjs`, `test/unit/workflow.test.mjs`. Design: F02, F06.

1. Нормализовать typed command в `{namespace, command, args}`. `/agnthive:manager` и подтверждённый legacy `/manager` ведут в одну процедуру; `/other:manager` — нет.
2. Если target поддерживает UserPromptExpansion, использовать его для command-specific context. UserPromptSubmit и Expansion одного prompt не должны дважды сбрасывать state.
3. Добавить task identity/active contract отдельно от prompt identity. Не классифицировать assistant handoff как новую пользовательскую цель только по тексту.
4. Реализовать явные переходы start/continue/complete/new task. Не сбрасывать counters активных siblings на continuation; новую пользовательскую задачу не удовлетворять старыми roles/evidence.
5. Зафиксировать поведение неоднозначного нового сообщения: продолжать открытый контракт и добавлять уточнение, пока нет надёжной границы. Не выводить provenance из наличия `prompt_id`.
6. Сохранить планирование без реализации: запрос «составь план» не должен требовать записи кода, запуска Tester или принудительного dispatch.

**Tests:** namespace/foreign namespace; plain prompt; command args содержат слова review/docs; background result; новый prompt при живом sibling; две разные задачи в одной сессии; duplicate prompt processing; plan-only.

**Приёмка:** reproductions F02/F06 исправлены; `BENCHMARK_DISPATCH_CONTRACT` работает только в своём тестовом режиме и не определяет обычный lean workflow.

### 06. Упростить lifecycle background и agent identity

**Файлы:** `modules/{agents,state,workflow,hook-dispatcher,transcripts}.mjs`, `test/unit/{agents,state,dispatcher}.test.mjs`, `test/integration/subagent-start.test.mjs`. Design: F04, F08.

1. Сохранять agent ID, role, scope, task ID, lifecycle status. Parent identity хранить только когда получена из подтверждённого источника; не предполагать поле `parent_agent_id` во всех hook payloads.
2. Разделить число событий start и число уникальных agent instances. Resume существующего ID обновляет lifecycle, не создаёт второй результат ревью.
3. Stop использует актуальный task registry payload, когда он есть; fallback transcript только диагностический и ограниченный. Empty registry означает отсутствие фоновой работы.
4. Различать waiting-for-subagent и completed; не требовать финальный результат до нужного handoff. Не пропускать failed verification из-за произвольного фонового cron.
5. `fork` и неизвестные внешние роли не должны получать agnthive footer requirements, в том числе при missing aliases. Добавить negative fixtures для чужого namespace.
6. Сохранить per-agent map event operations ADR-0002/0005/0006; не возвращаться к whole-map read/modify/write.
7. По ADR 0010 разделить parent `transcript_path` и `agent_transcript_path` в fallback. Для SubagentHandback проверять доставленный report, а не только закрывающий текст SubagentStop. Добавить fixtures parent/child с разными сообщениями и handback report, отличающимся от closing text; отсутствие данных даёт unknown, а не чужой результат.

**Приёмка:** два параллельных reviewer не ломают counters друг друга; resume idempotent; nested/headless результат относится к нужной задаче; stale transcript не держит сессию в ожидании.

### 07. Восстановление ledger и минимальная telemetry

**Файлы:** `modules/{ledger,hook-dispatcher,notifications}.mjs`, `hooks/hooks.json`, `test/unit/{ledger,progress-ledger,notifications}.test.mjs`, `test/integration/lifecycle.test.mjs`. Design: F07, F10.

1. Снять compact lifecycle целевой версии. Перенести гарантированное восстановление ledger в SessionStart compact/resume; сохранить обычный session context.
2. PostCompact использовать для bounded bookkeeping. Удалить обещание контекстной доставки через неподтверждённый output envelope; не допустить дублирования ledger.
3. Ограничить внедряемый текст компактным task/revision summary и ссылкой на ledger. Existing byte cap 64 KiB не означает, что весь текст полезно отправлять в каждый turn.
4. Записывать `notification_type`, agent/prompt correlation; оставить read compatibility старого subtype при необходимости.
5. Вместо полного compact_summary по умолчанию хранить metadata/размер/статус. Если verbose режим нужен, сделать его явным и документировать retention/privacy.
6. Добавить минимальный StopFailure telemetry без обработки API error text как completion summary. Не подключать внешние сервисы.

**Приёмка:** compact→resume сохраняет место выполнения; missing/oversize ledger не ломает сессию; в default logs нет полного summary; API failure не считается успешной задачей.

### 08. Сделать failure policy честной и ограниченной

**Файлы:** `modules/{hook-dispatcher,hook-output,command-policy}.mjs`, `hooks/hooks.json`, `test/unit/dispatcher.test.mjs`, `test/security/`, `README.md`, `plugins/agnthive/README.md`. Design: F09.

1. Разделить enforcement, workflow guidance и telemetry. Для каждого класса определить exception/write/read/timeout behavior.
2. Для enforce вернуть проверяемый blocking failure при невозможности решения; не проглатывать его в общем `dispatch catch`. Advisory сообщает degradation и продолжает; logging failure остаётся nonblocking.
3. На поддерживаемом CLI добавить явные timeouts и `onFailure` по ADR 0011: невозможность запуска/timeout общей safety registration блокирует действие, даже если пользователь выбрал advisory, поскольку недоступный handler не может определить режим. Работающий advisory handler сохраняет штатную permission flow; telemetry failure не блокирует. Проверить и описать host-level поведение отдельно от классификатора внутри Node.
4. Не обещать actionable Node-preflight из скрипта, который невозможно запустить без Node. Проверять prerequisite при install/diagnostics и документировать host failure.
5. Оставить ограничение stop retries. По исчерпании сохранять unresolved evidence и честный diagnostic; не превращать escape от loop в `passed`.
6. Пересмотреть blanket `permissionDecision: allow` для advisory/неопасных команд. Нейтральный advisory должен продолжать штатный permission flow; явный allow допустим только при документированном основании. Проверить влияние на headless benchmark отдельно, не расширять разрешения ради pass rate.

**Приёмка:** missing executable, timeout, malformed stdin, handler throw, read-only data directory, telemetry disk error имеют определённые отдельные результаты. Ни бесконечного stop loop, ни тихого ослабления enforce.

### 09. Перевести benchmark на структурированные доказательства

**Файлы:** `scripts/bench_runner_claude_code.mjs`, `scripts/bench/lib.mjs`, `modules/{state,util,hook-dispatcher}.mjs`, `test/bench/bench_runner_claude_code.test.mjs`, `test/bench/bench_runner_transcript_patterns.test.mjs`, `bench/schema/summary.schema.json`. Design: F03/F04.

1. Создавать уникальный run ID и изолированный data/evidence directory. Проверить реальный effective CLAUDE_PLUGIN_DATA внутри plugin host: не считать внешний env override заведомо рабочим. При необходимости отдельный явный benchmark evidence sink, отключённый в обычных сессиях.
2. Читать plugin event-store через общий reader; старый `~/.claude/state` — только маркированный legacy fallback. Не сканировать home в поисках «подходящего» чужого transcript.
3. Записывать structured start/stop и verification outcomes с version/session/run/task/agent metadata. Дедупликация resume; partial/truncated record → diagnostic.
4. Debug text и final prose могут быть `claimed`/diagnostic, но не `hook` evidence. Обновить summary schema/renderers/tests согласованно.
5. Сохранить standard/observed/enforced как различные dispatch compatibility режимы. Не переносить forced dispatch успех на оценку lean orchestration.
6. Указать trust boundary: Node process под тем же пользователем не защищает evidence от намеренно вредоносного кода с доступом к файловой системе. Задача — достоверный harness signal, не криптографическое доказательство.

**Tests:** новый data root; parallel runs; old state fallback; fake `Recorded subagent handoff` в log/result/file; wrong session; missing event; duplicate resume; truncated JSONL; started-but-not-finished reviewer.

**Приёмка:** F03 воспроизведения больше не дают false evidence; потеря evidence явно снижает результат, а не восстанавливает «успех» из текста.

### 10. Добавить benchmark результата без обязательных ролей

**Файлы:** новая `bench/tasks/outcomes/`, `scripts/{run-benchmark,compare-benchmarks,render-benchmark-report,select-benchmark-tasks,build-benchmark-matrix}.mjs`, `bench/schema/summary.schema.json`, `test/bench/`, `docs/benchmarking.md`. Design: ревью агентов.

1. Добавить одинаковые задачи для трёх arms: native без plugin, corrected legacy plugin, lean plugin. Отдельный Manager-vs-root ablation при одинаковых остальных настройках.
2. Покрыть: малая code change, нетривиальный bug, planted security flaw review, cross-file refactor, docs-only, незнакомая подсистема, две независимые подзадачи, compact/resume, background verification.
3. Оценивать реальный diff/тесты/findings и запрещённые действия; не требовать `@m`, `@doc`, footer или минимальное число agents в outcome score.
4. Собирать pass rate, finding precision/recall где задан ground truth, false completion, turns, latency, input/output/cache usage, число dispatch и повторных чтений. Cost хранить только если provider его отдаёт либо помечать estimate.
5. Фиксировать model/provider/effort/token cap/CLI/fixture revision. Сравнивать не менее трёх повторов задачи на arm, по возможности чередуя порядок. При меньшем бюджете результат exploratory, а не доказанная экономия.
6. Legacy per-role suite сохранить как compatibility suite; lean в ней не должен автоматически считаться плохим продуктом из-за отсутствия удаляемой роли.

**Приёмка:** mock проверяет plumbing; live проверяет качество. Отчёт не смешивает эти выводы и не выдаёт 100% прохождение role-contract за полезность Manager.

### 11. Ввести lean policy с root orchestration

**Файлы:** `modules/{workflow,summary-contract,state,hook-dispatcher}.mjs`, manifest userConfig, `test/unit/{workflow,summary-contract,hook-output}.test.mjs`, integration tests, `references/{architecture,agent-contracts}.md`. Design: целевая логика.

1. Добавить единый временный selector `workflow_profile=legacy|lean` с env override, документированной precedence и validation. Не смешивать его с advisory/enforce command policy.
2. В lean убрать обязательные role quotas и tester-as-proof. Обязательные свойства: актуальная проверка, учёт известных failures, выполненное ревью когда policy его требует, честный unresolved status.
3. Для substantial/security changes требовать review текущего diff. Для trivial/docs-only допускать отсутствие отдельного reviewer с объяснением. Считать risk по touched surfaces + явной задаче, не только regex prompt.
4. Убрать жёсткие footer-only blocks в lean. Оставить краткий рекомендуемый summary и machine evidence; если report parser не уверен — unknown, а не выдуманное pass.
5. Review outcome связывать с закончившимся агентом, revision и artifact. Агентская оценка остаётся оценкой модели, а не гарантией отсутствия багов.
6. Не заставлять все refactor/bugfix менять docs. Требовать docs decision `updated|not_required|pending` с причиной при изменении внешнего поведения.

**Приёмка:** маленькая задача проходит без квоты агентов; серьёзная задача не проходит по одному SubagentStart; start reviewer→edit инвалидирует review; no tests остаётся gap; footer punctuation не создаёт repair loop.

### 12. Превратить Manager в root skill и сократить роли

**Файлы:** `plugins/agnthive/agents/*.md`, `plugins/agnthive/skills/*/SKILL.md`, `assets/aliases.json`, `references/{agent-contracts,subagent-driven-development,token-cost}.md`. Design: таблица ролей.

1. `/agnthive:manager` оставить как совместимый root skill для планирования/координации; убрать указание обязательно запускать Manager agent. Не задавать ему `context: fork`.
2. Основные agents: Code Reviewer, Explorer, Debugger. Уточнить каждый по входам/выходам и tool permissions. Reviewer остаётся read-only; карту Explorer запрашивает root, сам reviewer не обещает недоступный Agent.
3. Bugbuster checklist перенести в debug/review references; `/bug` — совместимый skill. Design/Refactor/Test/Docs выполняются в root и делегируются при масштабе задачи, а не автоматически.
4. Deprecated Manager/Architect/Tester/Docwriter/Bugbuster временно сохранить только для explicit legacy usage; исключить их из обычного перечня рекомендованных делегатов. Не утверждать «осталось три файла», пока compatibility stubs существуют.
5. Старые `@m/@a/@t/@doc/@bug` описать как legacy shorthand плагина, не как гарантированные native CLI aliases. Не менять meaning сохранённого evidence старых запусков.
6. Сократить повторяющиеся footer/model-selection наставления. Уважать явно выбранную пользователем модель; выбирать model/effort по сложности без обязательной смены и без недоказанных утверждений о стоимости.

**Приёмка:** normal lean сценарий не вызывает Manager; сложная задача допускает отдельного исполнителя без второго координатора; explicit старые входы имеют определённое поведение и migration note.

### 13. Обновить валидаторы под процедуры и необязательных агентов

**Файлы:** `scripts/validate.mjs`, `scripts/plugin-install-smoke.mjs`, `test/unit/{skills-frontmatter,agents,settings-hooks,plugin-install-smoke}.test.mjs`, `test/validators/task-fixture-alignment.test.mjs`, `test/hooks/{cases,scenarios}.json`. Design: F04/F10, упрощение.

1. Заменить жёсткий список agent-backed skills правилами по фактическому execution type: root procedure либо forked specialist.
2. Проверять, что указанная цель существует и namespace корректен; не требовать `agent/context: fork/paths` у root skills только ради старого теста.
3. Не навязывать восемь agents или обязательные handoff markers outcome benchmark. Для legacy suite такие требования сохраняются явно.
4. Добавить negative fixtures: skill с отсутствующей agent target, неизвестный hook field, неподдерживаемая version capability, lean task со случайно унаследованной role quota.

**Приёмка:** проверки ловят реальные ошибки wiring и позволяют утверждённый дизайн. Нет удаления всего покрытия ради зелёного результата.

### 14. Проверить совместимость и качество

**Команды, из корня:**

```sh
node scripts/validate.mjs
make lint test hooks
make bench-precheck
make bench-mock
claude plugin validate --strict plugins/agnthive
claude plugin validate --strict plugins/agnthive/agents
claude plugin validate --strict plugins/agnthive/skills
```

1. Использовать отдельный BENCH_OUTPUT_DIR для каждого mock/live run. Проверить Node 22 и CI Node 24, Linux/macOS/Windows по существующей matrix.
2. На pinned CLI выполнить host canaries: namespace skill, normal workflow, genuine agent return, background test, compact/resume, correct permission output. Сохранить обезличенные artifacts.
3. Для baseline CLI отдельно проверить fallback или документированный unsupported path. Не считать strict validation доказательством runtime behavior.
4. Выполнить outcome comparison из задачи 10; разбирать расхождения по задачам. Минимум: ноль новых false completion/permission regressions; все детерминированные correctness checks; отсутствие потерянного существенного finding.
5. Для качества и стоимости показать paired результаты, разброс и число повторов. Уменьшение dispatch — ожидаемый эффект, но не достаточный release gate.

**Приёмка:** review package содержит команды, реальные версии, pass/fail/unknown и оставшиеся live gaps. Никаких claims о measured savings без результатов.

### 15. Обновить документацию и переключить default по результатам

**Файлы:** `README.md`, `CLAUDE.md`, `plugins/agnthive/README.md`, `docs/{compatibility,benchmarking,plugin-best-practices}.md`, `references/{architecture,agent-contracts,progress-ledger,token-cost}.md`, `docs/adr/`, changelogs. Design: политика перехода.

1. Описать root orchestration и три основные роли; canonical namespaced команды; legacy aliases и сроки deprecation.
2. Обновить implementation status существующих ADR 0008–0013 по фактическим изменениям и проверкам. Эти решения уже записаны; новые ADR нужны только при изменении принятого контракта. Указать, какие legacy clauses действительно заменены, а какие остаются до конца compatibility окна.
3. По результатам задачи 14 перевести lean в default; legacy оставить на один переходный релиз. Если quality gate не пройден — исправить деградацию, оставить экспериментальный режим и честно отметить незавершённость перехода.
4. Обновить claims про minimum CLI, verification, data paths и telemetry. Исторические планы не переписывать как будто они никогда не существовали: добавить superseded note/link.
5. Не выполнять release/deploy/push в рамках этой задачи без соответствующего поручения. Подготовить release notes с изменением workflow defaults.

**Приёмка:** installed behavior совпадает с README; переключение профиля не повреждает state; нет обещаний абсолютного fail-closed или гарантированного качества по footer.

### 16. Удалить compatibility debt отдельным завершающим изменением

**Файлы:** deprecated agent definitions, aliases, legacy policy branches, старые manager-specific stop/idle exceptions и связанные tests/docs.

1. В переходном релизе пометить legacy inventory и telemetry usage (без отправки наружу). Удаление сделать после согласованного compatibility окна, не в середине первой миграции.
2. После окна удалить неиспользуемые определения и mandatory-role branches; не оставлять два SDLC engines навсегда.
3. Сохранить reader старого evidence, если это нужно для historical benchmark reports; runtime routing legacy aliases мигрировать явно.
4. Повторить relevant checks и outcome comparison только для изменённого поведения. Обновить документацию: теперь три реальных agent definitions, а не три recommended плюс скрытый набор.

**Приёмка:** меньше prompt duplication и manager-specific state; весь поддерживаемый public interface имеет актуальную документацию. Если compatibility окно ещё не прошло, задача явно deferred, а не ложно completed.

## Матрица минимальных регрессий

| Сценарий | Ожидаемый результат |
|---|---|
| Background test только стартовал | pending, verification gate не закрыт |
| Passed test → новая code/config правка | предыдущее verification устарело |
| Фоновый агент вернул результат | активная задача и sibling counters сохранены |
| Reviewer стартовал, но не завершился | независимое review ещё не выполнено |
| Reviewer завершился до последнего diff | review устарело |
| Произвольный текст `@cr`/handoff echo | только claimed, не runtime evidence |
| Plugin state только в новом data root | runner находит session/transcript/evidence |
| `/agnthive:manager` | root procedure без обязательного Manager spawn |
| Чужой `/plugin:manager` | не включает локальную orchestration |
| Fork/resume/nested agent | стабильный ID, без двойного зачёта и чужого footer |
| Compact/resume | ledger возвращается один раз через проверенный канал |
| API error/StopFailure | failed/incomplete, не success |
| Small docs-only task | нет обязательного Docwriter |
| Plan-only запрос | план без принуждения к implementation |
| Enforcement hook не смог прочитать state | результат согласно явной failure policy |
| Stop escape от повтора | завершение turn не превращает failed checks в passed |

## Готовый стартовый brief агенту

> Реализуй этот план по блокам A–E, начиная с проверки текущего HEAD и target Claude Code. Основной продуктовый результат — root orchestration без обязательного Manager, три специализированных агента и проверка выполненной работы вместо посещения ролей. Сначала исправь F01–F10 и benchmark evidence; затем включай lean profile. Сохрани имеющиеся корректные plugin contracts и legacy compatibility на переходный период. Для каждой задачи представь diff, воспроизводящий тест, результат проверок и ограничения. Не выдавай mock/static validation за live runtime test; не обещай снижение стоимости без замера. Release и удаление compatibility до окончания окна не входят в первоначальную реализацию.

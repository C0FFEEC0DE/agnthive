# Claude Code Plugin Best Practices

Извлечено из официальной документации Claude Code (docs.claude.com) — июнь 2026.

## Структура директорий

### ✅ Правильная структура

```
my-plugin/
├── .claude-plugin/           # ТОЛЬКО plugin.json здесь
│   └── plugin.json
├── skills/                   # Корень плагина
│   └── my-skill/
│       └── SKILL.md
├── agents/                   # Корень плагина
│   └── reviewer.md
├── hooks/                    # Корень плагина
│   └── hooks.json
├── modules/                  # Ваш код
│   └── dispatcher.mjs
├── .mcp.json                # Корень плагина
├── .lsp.json                # Корень плагина
└── settings.json            # Корень плагина
```

### ❌ Частая ошибка

```
my-plugin/
└── .claude-plugin/
    ├── plugin.json          # ✅ Здесь
    ├── skills/              # ❌ НЕ ЗДЕСЬ!
    ├── agents/              # ❌ НЕ ЗДЕСЬ!
    └── hooks/               # ❌ НЕ ЗДЕСЬ!
```

**Правило:** Внутри `.claude-plugin/` должен быть **только** `plugin.json`. Все остальное — в корне плагина.

## Версионирование

### Не дублируйте версии

❌ **Плохо:**
```json
// plugin.json
{ "version": "1.0.0" }

// marketplace.json
{ "plugins": [{ "name": "my-plugin", "version": "1.0.0" }] }
```

**Проблема:** `plugin.json` молча выигрывает, и версия в marketplace игнорируется. Это создает иллюзию согласованности.

✅ **Хорошо (вариант 1 — explicit version):**
```json
// plugin.json
{ "version": "1.0.0" }  // ЕДИНСТВЕННЫЙ источник истины

// marketplace.json
{ "plugins": [{ "name": "my-plugin" }] }  // БЕЗ version
```

✅ **Хорошо (вариант 2 — commit-SHA version):**
```json
// plugin.json
{}  // БЕЗ version

// marketplace.json
{ "plugins": [{ "name": "my-plugin" }] }  // БЕЗ version
```
→ Каждый новый коммит автоматически считается новой версией.

### Когда использовать explicit vs commit-SHA

| Подход | Когда | Обновления |
|---|---|---|
| **Explicit** `"version": "1.0.0"` | Стабильные релизы для публикации | Только при bump версии |
| **Commit-SHA** (нет `version`) | Внутренние/team плагины, активная разработка | Каждый коммит |

**Важно:** Если используете explicit версию, **обязательно** повышайте её при каждом релизе. Без bump пользователи не получат обновления.

## Hooks: exec-форма > shell-форма

### ✅ Рекомендуется: exec-форма

```json
{
  "hooks": {
    "PostToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "node",
        "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/process.sh"]
      }]
    }]
  }
}
```

**Преимущества:**
- Нет шелла → нет shell injection
- Явная передача аргументов
- Кроссплатформенность (Windows/Unix)

### ⚠️ Shell-форма (используйте только если действительно нужен шелл)

```json
{
  "type": "command",
  "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/process.sh"
}
```

**Минусы:**
- Требует квотирования пробелов
- Зависит от шелла хоста
- Риск injection

## Переменные окружения

Всегда используйте эти переменные вместо хардкоженных путей:

| Переменная | Когда использовать |
|---|---|
| `${CLAUDE_PLUGIN_ROOT}` | Скрипты/бинари/конфиги **внутри плагина**. Меняется при обновлении плагина |
| `${CLAUDE_PLUGIN_DATA}` | Персистентные данные (node_modules, кэши, БД). **Переживает** обновления |
| `${CLAUDE_PROJECT_DIR}` | Путь к проекту пользователя |

**Квотирование:** Всегда оборачивайте в кавычки в shell-форме: `"${CLAUDE_PLUGIN_ROOT}"`

## Manifest (plugin.json)

### Минимальный манифест

```json
{
  "name": "my-plugin",
  "description": "Brief description",
  "version": "1.0.0",
  "author": { "name": "Your Name" },
  "license": "MIT"
}
```

### Полезные опциональные поля

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "displayName": "My Plugin",      // Человекочитаемое имя (v2.1.143+)
  "homepage": "https://...",
  "repository": "https://github.com/...",
  "keywords": ["tag1", "tag2"],
  "defaultEnabled": false,          // Установка в disabled (v2.1.154+)
  "userConfig": {
    "api_token": {
      "type": "string",
      "title": "API Token",
      "description": "Your API token",
      "sensitive": true              // → keychain, не settings.json
    }
  }
}
```

### Нераспознанные поля

Claude Code игнорирует неизвестные поля → можно держать метаданные из других экосистем (npm, VS Code) в одном файле.

`claude plugin validate --strict` превратит warnings в errors для CI.

## Skills vs Commands

✅ **Используйте `skills/` для новых плагинов:**
```
skills/
  ├── code-review/
  │   └── SKILL.md
  └── deploy/
      └── SKILL.md
```

⚠️ **`commands/` — legacy форма** (плоские `.md` файлы). Работает, но `skills/` предпочтительнее.

## LSP/MCP серверы

**LSP:** Плагин конфигурирует подключение, но **не включает** сам бинарь. Пользователь устанавливает сепаратно:

```json
// .lsp.json
{
  "python": {
    "command": "pyright-langserver",
    "args": ["--stdio"]
  }
}
```

Пользователь: `pip install pyright` (или `npm install -g pyright`)

**MCP:** Можно bundle сервер внутри плагина:

```json
// .mcp.json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/servers/server.js"]
    }
  }
}
```

## LICENSE

MIT обязывает указать **copyright holder**:

❌ **Плохо:**
```
Copyright (c) 2026
```

✅ **Хорошо:**
```
Copyright (c) 2026 Your Name
```

## Публикация

### Pre-flight checklist

- [ ] `claude plugin validate . --strict` → exit 0
- [ ] `LICENSE` содержит copyright holder
- [ ] `version` либо явно задана, либо полностью отсутствует (commit-SHA)
- [ ] Нет дублирования версии между `plugin.json` и `marketplace.json`
- [ ] `package.json` `main` (если есть) указывает на реальный файл
- [ ] `README.md` описывает установку, настройку, использование
- [ ] `CHANGELOG.md` (Keep-a-Changelog формат)
- [ ] `SECURITY.md` с policy/scope
- [ ] Все компоненты (`skills/`, `agents/`, `hooks/`) в корне плагина, не в `.claude-plugin/`

### Два marketplace подхода

| Подход | Структура |
|---|---|
| **Source repository** | `github.com/user/my-plugin` — весь репо = плагин |
| **Catalog repository** | `github.com/user/plugins` с `.claude-plugin/marketplace.json` и `plugins/<name>/` |

Второй подход — для multi-plugin маркетплейсов.

### Submission (community marketplace)

1. Локально: `claude plugin validate . --strict`
2. Форма: [claude.ai/.../plugins/new](https://claude.ai/admin-settings/directory/submissions/plugins/new) (Team/Enterprise) или [platform.claude.com/plugins/submit](https://platform.claude.com/plugins/submit) (индивидуалы)
3. Ревью → pin commit SHA в [`anthropics/claude-plugins-community`](https://github.com/anthropics/claude-plugins-community)
4. CI auto-bump → nightly sync → installable

**Official marketplace (`claude-plugins-official`)** — curated, нет application процесса.

## Распространенные ошибки

| Ошибка | Как избежать |
|---|---|
| Компоненты внутри `.claude-plugin/` | Только `plugin.json` в `.claude-plugin/`, все остальное — в корне |
| Дублирование версий | Один источник истины: либо `plugin.json`, либо commit-SHA |
| Shell injection в hooks | Используйте exec-форму с явными `args` |
| Битый `main` в package.json | Проверьте что файл существует |
| Путь без квотирования | `"${CLAUDE_PLUGIN_ROOT}"` в shell-форме |
| `CLAUDE.md` в плагине | Не загружается. Используйте skill для контекста |

## Ресурсы

- [Create plugins](https://docs.claude.com/en/docs/claude-code/plugins)
- [Plugins reference](https://docs.claude.com/en/docs/claude-code/plugins-reference)
- [Plugin marketplaces](https://docs.claude.com/en/docs/claude-code/plugin-marketplaces)
- [Skills guide](https://docs.claude.com/en/docs/claude-code/skills)
- [Hooks guide](https://docs.claude.com/en/docs/claude-code/hooks)

---

*Документ создан автоматически при рефакторинге `agent-hive` плагина.*

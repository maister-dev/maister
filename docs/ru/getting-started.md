[← Обзор](overview.md) · [Back to README](../../README.md) · [Рабочий процесс →](workflow.md)

# Первый запуск

Эта страница описывает локальный запуск MAIster для разработки и знакомства с
инструментом. Подробная английская инструкция живёт в
[docs/getting-started.md](../getting-started.md); здесь собран практический
минимум.

## Что понадобится

| Инструмент | Зачем нужен |
| ---------- | ----------- |
| Linux или macOS | На Windows только WSL2 (Ubuntu) с интеграцией Docker Desktop: `cli`-узлы и проверки требований идут через `bash`, установка Flow и capability создаёт символические ссылки, `MAISTER_WORKSPACE_ROOTS` разделяется двоеточием |
| Node 24 | Среда выполнения для веб-интерфейса и супервизора |
| pnpm | Менеджер пакетов монорепозитория |
| Docker | Локальный Postgres через Docker Compose |
| git | Рабочие копии `git worktree` для прогонов |
| pre-commit | Локальные проверки перед коммитом |
| Командные клиенты агентов | Claude/Codex/другие адаптеры, если вы запускаете реальные прогоны |

## Установка

```bash
git clone https://github.com/maister-dev/maister.git
cd maister
pre-commit install
pnpm install --frozen-lockfile
cp .env.example .env
cp web/.env.sample web/.env.local
cp supervisor/.env.sample supervisor/.env
```

Веб-процесс читает `web/.env.local`, супервизор — `supervisor/.env`, Docker
Compose — корневой `.env`. Задайте `AUTH_SECRET` в `web/.env.local` и при
необходимости переменные провайдеров моделей в `supervisor/.env`. Полный список
описан в [Configuration](../configuration.md).

Скрипт [`scripts/quickstart.sh`](../../scripts/quickstart.sh) выполняет
установку, копирование файлов окружения, запуск Postgres, миграции и сборку
MCP-фасада одной командой (`./scripts/quickstart.sh` из клона или
`curl -fsSL https://imaister.dev/quickstart.sh | bash` из пустой директории).
Существующие файлы окружения он не трогает, повторный запуск безопасен; хук
`pre-commit` и seed для разработки остаются ручными шагами.

## База данных

```bash
docker compose up -d postgres
pnpm --filter maister-web db:migrate
pnpm --filter maister-web db:migrate:brain
pnpm --filter maister-web db:seed
```

`db:migrate` применяет основную схему. `db:migrate:brain` применяет отдельную
линейку Project Brain и требует PostgreSQL с расширением pgvector. `db:seed` создаёт данные для разработки, включая
администратора и базовых платформенных исполнителей.

## Запуск процессов

MAIster состоит из двух Node-процессов:

```bash
pnpm --filter @maister/supervisor dev
```

Супервизор поднимается на `http://localhost:7777` и владеет ACP-сессиями.

```bash
pnpm --filter maister-web dev
```

Веб-интерфейс поднимается на `http://localhost:3000`.

Команда `pnpm dev` из корня репозитория запускает оба процесса в одном
терминале; вывод каждого помечен именем пакета.

## Проверка

1. Откройте `http://localhost:3000`.
2. Войдите под пользователем для разработки из подготовленных данных.
3. Проверьте, что в оболочке виден статус супервизора.
4. Перейдите в `/projects` или `/projects/new`, чтобы зарегистрировать проект.
5. Для реального запуска убедитесь, что нужный ACP-исполнитель доступен и готов.

## Частые проблемы

| Симптом | Что проверить |
| ------- | ------------- |
| Веб-интерфейс не видит супервизор | `MAISTER_SUPERVISOR_URL`, порт `7777`, запущен ли супервизор |
| Миграции не проходят | `DB_URL`, запущен ли Postgres, применялась ли старая схема |
| Прогон не стартует | Готовность исполнителя, чистоту родительского репозитория, лимит одновременных прогонов |
| Нет реального ответа агента | Установлен ли исполняемый файл адаптера и есть ли нужные токены окружения |

## См. также

- [Рабочий процесс](workflow.md) — что делать после запуска
- [Configuration](../configuration.md) — переменные окружения и манифесты
- [Supervisor](../supervisor.md) — HTTP+SSE контракт процесса-демона

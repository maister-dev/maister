[← Обзор](overview.md) · [Back to README](../../README.md) · [Рабочий процесс →](workflow.md)

# Первый запуск

Эта страница описывает локальный запуск MAIster для разработки и знакомства с
инструментом. Подробная английская инструкция живёт в
[docs/getting-started.md](../getting-started.md); здесь собран практический
минимум.

## Что понадобится

| Инструмент | Зачем нужен |
| ---------- | ----------- |
| Node 24 | Runtime для web и supervisor |
| pnpm | Менеджер пакетов monorepo |
| Docker | Локальный Postgres через compose |
| git | Worktrees для run/workspace |
| pre-commit | Локальные проверки перед commit |
| Agent CLIs | Claude/Codex/другие адаптеры, если вы запускаете реальные runs |

## Установка

```bash
git clone <repo-url> mAIster
cd mAIster
pre-commit install
pnpm install --frozen-lockfile
cp .env.example .env
```

После копирования `.env.example` заполните переменные для базы, supervisor,
секретов Auth.js и провайдеров моделей. Полный список описан в
[Configuration](../configuration.md).

## База данных

```bash
docker compose up -d postgres
pnpm --filter maister-web db:migrate
pnpm --filter maister-web db:migrate:brain
pnpm --filter maister-web db:seed
```

`db:migrate` применяет основную схему. `db:migrate:brain` применяет отдельную
линейку Project Brain; в SQLite-режиме это no-op, поэтому команда безопасна для
лёгкого локального запуска. `db:seed` создаёт dev-данные, включая
администратора и базовые platform runners.

## Запуск процессов

MAIster состоит из двух Node-процессов:

```bash
pnpm --filter @maister/supervisor dev
```

Supervisor поднимается на `http://localhost:7777` и владеет ACP-сессиями.

```bash
pnpm --filter maister-web dev
```

Web поднимается на `http://localhost:3000` и показывает UI.

## Проверка

1. Откройте `http://localhost:3000`.
2. Войдите под dev-пользователем из seed-данных.
3. Проверьте, что в shell виден статус supervisor.
4. Перейдите в `/projects` или `/projects/new`, чтобы зарегистрировать проект.
5. Для реального запуска убедитесь, что нужный ACP runner доступен и готов.

## Частые проблемы

| Симптом | Что проверить |
| ------- | ------------- |
| Web не видит supervisor | `MAISTER_SUPERVISOR_URL`, порт `7777`, запущен ли supervisor |
| Миграции не проходят | `DB_URL`, запущен ли Postgres, применялась ли старая схема |
| Run не стартует | Готовность runner, чистоту parent repo, лимит concurrent runs |
| Нет реального ответа агента | Установлен ли adapter binary и есть ли нужные env-токены |

## See Also

- [Рабочий процесс](workflow.md) — что делать после запуска
- [Configuration](../configuration.md) — переменные окружения и манифесты
- [Supervisor](../supervisor.md) — HTTP+SSE контракт daemon-процесса

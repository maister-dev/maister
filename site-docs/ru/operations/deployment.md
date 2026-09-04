---
title: "Развёртывание на одном хосте"
description: "Разверните MAIster на Linux с systemd, локальным supervisor, Postgres и TLS reverse proxy."
---

Поддерживаемая production-топология: web и execution supervisor работают как
непривилегированные сервисы хоста, Postgres работает локально, а TLS reverse
proxy публикует только веб-приложение.

## Топология

```text
client → TLS proxy → web :3000 → supervisor :7777
                         │              │
                         └→ Postgres    └→ agent adapters + git worktrees
```

Supervisor и Postgres слушают loopback. Не открывайте их порты во внешнюю сеть.

## Требования к хосту

- Современный Linux с systemd
- Node.js 24, pnpm, git и Docker
- Выделенный непривилегированный пользователь сервиса
- Постоянные директории для checkout, репозиториев, runtime state и данных агентов
- Авторизация провайдера для режима продвижения через pull request

## Сборка и база

```bash
pnpm install --frozen-lockfile
docker compose up -d postgres
pnpm --filter maister-web db:migrate
pnpm --filter maister-web db:migrate:brain
pnpm --filter maister-web build
pnpm --filter @maister/mcp build
```

Запускайте supervisor и web как отдельные systemd-сервисы под одним доверенным
пользователем. Задайте надёжный `AUTH_SECRET`, production `DB_URL` и URL
supervisor в окружении сервисов.

## Reverse proxy

Завершайте TLS в nginx, Caddy или эквивалентном proxy. Сохраните streaming для
SSE и передавайте исходные заголовки host и protocol. Публикуйте только web;
порт `7777` должен оставаться приватным.

## Обновления

Закрепляйте ревизию исходного кода или тег образа. До обновления сохраните
резервную копию Postgres и runtime state. Установите зависимости по lockfile,
выполните обе линии миграций и сборку, затем перезапустите supervisor перед web.
Проверьте готовность адаптеров и выполните некритичный smoke-прогон.

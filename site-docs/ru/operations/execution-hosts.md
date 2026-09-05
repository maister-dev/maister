---
title: "Узлы исполнения"
description: "Текущая граница одного узла супервизора и безопасный путь к нескольким узлам исполнения."
---

Execution host — supervisor-граница, которая владеет ACP-сессиями, процессами
агентов и execution workspaces. Web Core обращается к исполнению через durable
контракт хоста и assignment, а не считает URL или файловый путь ownership.

## Текущая топология

Поддерживаемая топология использует один активный доверенный локальный execution
host, loopback HTTP и общий локальный storage. Сейчас нет поддерживаемого
placement между несколькими одновременными хостами и нет обещания миграции
посреди turn.

Контракт хоста уже обеспечивает:

- durable host identity после рестарта supervisor;
- растущие assignment epochs и fencing устаревшего driver;
- durable command ledger и идемпотентные host receipts;
- opaque workspace handles для обычных session-операций;
- привязку sessions и node attempts к assignment.

## Путь к нескольким supervisors

Эти границы — основа будущего пула supervisor-хостов. Следующий этап должен
добавить remote transport, placement policy, видимость хостов и recovery на
границе attempts, не ослабляя fencing и ownership доказательств.

До реализации этого этапа разворачивайте один supervisor на MAIster control
plane и следуйте [руководству для одного хоста](/ru/operations/deployment).

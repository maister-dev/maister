[← Ключевые понятия](concepts.md) · [Back to README](../../README.md)

# Операторский гид

Эта страница для человека, который отвечает за MAIster-инстанс: подключает
проекты, следит за runners, помогает команде разбирать runs и держит систему
в рабочем состоянии.

## Базовый цикл оператора

| Действие | Где смотреть |
| -------- | ------------ |
| Проверить здоровье инстанса | Status bar, `/settings`, supervisor logs |
| Проверить, кто ждёт человека | `/inbox`, Needs-you badge |
| Проверить активные работы | Portfolio и rail active workspaces |
| Разобрать упавший run | Run detail, timeline, logs, supervisor status |
| Обновить runners или Flow-пакеты | `/settings`, `/studio` |
| Принять результат | Diff, evidence, readiness, promotion action |

## Подключение нового проекта

1. Убедитесь, что repo доступен на хосте MAIster.
2. Добавьте или проверьте `maister.yaml` в проекте.
3. Откройте `/projects/new`.
4. Выберите onboarding mode и укажите путь к проекту.
5. Проверьте найденные Flow-пакеты и runners.
6. Зарегистрируйте проект и откройте board.

Важно: MAIster ожидает чистую и понятную git-базу. Если parent repo грязный,
run может не стартовать, потому что worktree должен создаваться из
предсказуемого состояния.

## Настройка runners

Runner должен быть не только создан, но и launchable:

- adapter binary доступен на `PATH`;
- env-токены провайдера заданы на стороне web/supervisor;
- readiness diagnostics прошли;
- модель и provider совместимы с adapter;
- permission policy соответствует режиму работы.

Если run не стартует, сначала смотрите readiness runner, потом supervisor logs,
потом precondition error в UI.

## Работа с HITL

Оператору важно не просто “нажать approve”, а понять контекст:

1. Откройте HITL item из inbox.
2. Проверьте run, node, prompt и последние события.
3. Если это permission, выберите безопасный вариант.
4. Если это human review, дайте конкретные комментарии: что исправить,
   где проверить, какой результат нужен.
5. После ответа проверьте, что run вернулся в работу или корректно resumed.

## Разбор проблем

| Проблема | Первые действия |
| -------- | --------------- |
| Run завис в Pending | Проверить global cap и активные Running |
| Run ушёл в NeedsInputIdle | Ответить на HITL, затем проверить resume |
| Runner unavailable | Проверить adapter binary, env и readiness |
| Diff неожиданный | Открыть workspace, timeline и logs |
| Merge conflict | Передать работу в manual takeover или решить конфликт вручную |
| Supervisor недоступен | Проверить процесс, порт `7777`, `MAISTER_SUPERVISOR_URL` |

## Безопасная эксплуатация

- Не храните provider secrets в клиентском коде или Flow-файлах.
- Не давайте runner шире прав, чем нужно конкретному Flow.
- Проверяйте diff и evidence до promotion.
- Используйте package trust осознанно: trust открывает setup и enablement
  revision по жизненному циклу пакета, но не выдаёт произвольные runtime-права
  вне этой процедуры.
- Не удаляйте runtime artifacts руками, если run ещё нужен для аудита.
- Перед destructive reset остановите web и supervisor.

## Когда использовать scratch run

Scratch run подходит, если задача ещё не оформлена как board task:

- исследовать проблему;
- попросить агента прочитать код и предложить план;
- выполнить маленькую ручную правку;
- проверить гипотезу до создания Flow-задачи.

Для повторяемой delivery-работы лучше создавать task и запускать Flow.

## See Also

- [Первый запуск](getting-started.md) — локальная установка и процессы
- [Configuration](../configuration.md) — env и project/flow manifests
- [Error Taxonomy](../error-taxonomy.md) — доменные ошибки и реакции UI

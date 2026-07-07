[← Первый запуск](getting-started.md) · [Back to README](../../README.md) · [Ключевые понятия →](concepts.md)

# Рабочий процесс

Типичный путь в MAIster: зарегистрировать проект, создать задачу, запустить
Flow, наблюдать run, ответить на HITL, проверить diff и приземлить изменения.

## 1. Зарегистрировать проект

Проект в MAIster — это внешний git-репозиторий с `maister.yaml`.
Минимальная идея манифеста:

```yaml
schemaVersion: 2
project:
  name: myapp
  repo_path: /repos/myapp
  default_branch: main
  branch_prefix: maister/
flows:
  - id: bugfix
    source: github.com/org/maister-flow-bugfix
    version: v1.2.3
```

В UI откройте `/projects/new`, укажите путь к директории с `maister.yaml` и
дождитесь проверки. MAIster валидирует проект, Flow-пакеты, runners и
уникальность `slug`/`repo_path`.

## 2. Создать задачу

На странице проекта создайте task: название, prompt, Flow и при необходимости
runner override. Задача попадает в backlog и может иметь несколько попыток:
если run упал или был abandoned, задачу можно запустить снова.

## 3. Запустить run

Кнопка Launch создаёт workspace и отправляет supervisor запрос на ACP-сессию.
Перед запуском MAIster проверяет:

| Проверка | Зачем |
| -------- | ----- |
| Parent repo чистый | Чтобы run начинался с понятной базы |
| Branch свободна | Чтобы не перетереть чужую работу |
| Worktree path свободен | Чтобы не смешать артефакты прогонов |
| Runner доступен | Чтобы ACP adapter реально стартовал |
| Global cap не превышен | Чтобы не перегрузить хост и бюджет |

Если лимит занят, run становится `Pending` и ждёт свободный слот.

## 4. Следить за выполнением

Откройте run detail. Там важны:

- состояние run и активного node/session;
- timeline событий;
- логи и поток обновлений;
- workspace, файлы, diff и evidence;
- HITL-запросы, если агенту нужно решение человека.

Supervisor пишет события и output на диск, а web читает их через SSE. Поэтому
после reconnect UI может восстановить контекст по сохранённым событиям.

## 5. Ответить на HITL

HITL бывает нескольких видов:

| Вид | Пример |
| --- | ------ |
| Permission | Агент просит разрешить действие |
| Form | Flow ждёт структурированные поля |
| Human review | Человек возвращает комментарии на доработку |

Ответ отправляется из UI. Для permission-запросов web передаёт решение в
supervisor, а тот возвращает его в живую ACP-сессию. Для form/human ответ
записывается как артефакт в `.maister/` атомарно, чтобы runner не прочитал
полузаписанный JSON.

## 6. Проверить diff и evidence

Перед merge смотрите не только “успешно/неуспешно”, а набор доказательств:

- какие файлы изменены;
- какие проверки проходили;
- что написано в логах;
- есть ли review comments;
- не исчерпаны ли rework/budget limits;
- готова ли readiness summary.

## 7. Приземлить работу

Когда результат принят, можно продвинуть изменения:

- локальный merge в target branch;
- PR-mode promotion, если настроены provider credentials;
- manual takeover, если человеку нужно закончить работу в worktree руками.

`local_merge` не требует provider CLI или токенов. `pull_request` promotion
зависит от провайдера: для GitHub нужен `gh` или `GH_TOKEN`, для GitLab —
`glab` или `GITLAB_TOKEN`, для Gitea/GitVerse — соответствующий API token и
git push credential на web-хосте.

Если merge конфликтует, MAIster не пытается “магически” решить конфликт:
он останавливает promotion и показывает, что нужно ручное вмешательство.

## Ежедневная шпаргалка

| Нужно | Куда идти |
| ----- | --------- |
| Посмотреть, что требует внимания | `/inbox` или Needs-you badge |
| Запустить новую задачу | Project board |
| Запустить свободную агентную сессию | Scratch launcher |
| Понять, что делает агент | Run detail |
| Проверить итог | Diff, evidence, readiness |
| Настроить runners | `/settings` |
| Работать с Flow-пакетами | `/studio` |

## See Also

- [Ключевые понятия](concepts.md) — словарь рабочего процесса
- [Операторский гид](operators-guide.md) — сценарии владельца инстанса
- [Flow DSL](../flow-dsl.md) — детали графового Flow DSL

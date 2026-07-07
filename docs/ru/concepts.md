[← Рабочий процесс](workflow.md) · [Back to README](../../README.md) · [Операторский гид →](operators-guide.md)

# Ключевые понятия

Эта страница помогает читать UI и документацию MAIster без погружения в код.

## Project

Project — зарегистрированный внешний git-репозиторий. Он описывается
`maister.yaml`: имя, путь к repo, default branch, prefix для веток, Flow-пакеты
и настройки runners. Один repo path соответствует одному project.

## Flow

Flow — воспроизводимый сценарий доставки: какие шаги выполнить, какого агента
запустить, где нужны проверки, формы, human review или consensus. Flow может
быть установлен из package/source и привязан к проекту по версии.

## Task

Task — работа в backlog проекта. У задачи есть prompt и выбранный Flow.
Связь task к run — один ко многим: одну задачу можно запускать повторно,
получая новые attempts.

## Run

Run — конкретная попытка выполнить задачу или scratch-сессию. Run хранит
статус, runner snapshot, workspace, события, HITL, evidence и итоговый diff.

## Workspace

Workspace — изолированная рабочая копия, чаще всего git worktree. Агент меняет
код не в основной директории repo, а в workspace конкретного run. Это снижает
риск смешать чужие изменения и упрощает review.

## Supervisor

Supervisor — отдельный Fastify-процесс на Node.js. Он владеет ACP-сессиями,
запускает adapter binaries, следит за heartbeat, принимает permission input и
публикует события через HTTP+SSE. Web не запускает агентов напрямую.

## ACP

ACP (Agent Client Protocol) — стандартный протокол взаимодействия с агентами.
Для MAIster это граница между control plane и реальным coding agent. Благодаря
ACP можно поддерживать разные adapters: Claude, Codex и другие совместимые
рантаймы.

## Runner

Runner — настроенный способ запустить агента: adapter, модель, provider,
permission policy, sidecar и readiness. На практике runner отвечает на вопрос:
“каким агентом и с какими настройками выполнять этот node/run?”

## HITL

HITL (human-in-the-loop) — момент, когда Flow или агент ждёт человека.
Это может быть approve/deny, заполнение формы, комментарии к доработке или
ручной takeover. HITL делает автономность управляемой, а не бесконтрольной.

## Evidence

Evidence — проверяемые артефакты результата: diff, логи, проверки, node output,
review comments, readiness summary. MAIster использует evidence, чтобы человек
принимал итог не на вере, а по наблюдаемым данным.

## Package

Package — поставка нескольких Flow, skills, agents и связанных файлов из git
источника. MAIster хранит installs как immutable версии и позволяет доверять,
подключать и обновлять пакеты контролируемо.

## Статусы run

| Статус | Значение |
| ------ | -------- |
| Pending | Ждёт свободный execution slot |
| Running | Выполняется сейчас |
| NeedsInput | Ждёт человека, session ещё жива |
| NeedsInputIdle | Session checkpointed, ответ человека возобновит run |
| HumanWorking | Человек забрал worktree в ручную работу |
| Review | Работа остановлена для проверки: агент вышел успешно или оператор остановил run |
| Crashed | Процесс или session оборвались |
| Failed | Агент завершился с ненулевым кодом без recovery path |
| Done | Работа завершена и принята |
| Abandoned | Run остановлен и больше не продолжается |

Manual takeover, recovery и discard — это отдельные переходы между статусами.
Например, `Crashed` можно попытаться вернуть в `Running` через recover, а
`HumanWorking` возвращается в автоматический путь только после явного return.

## See Also

- [Рабочий процесс](workflow.md) — как понятия складываются в ежедневный flow
- [Supervisor](../supervisor.md) — детали daemon-процесса
- [System Analytics](../system-analytics/README.md) — доменные state machines

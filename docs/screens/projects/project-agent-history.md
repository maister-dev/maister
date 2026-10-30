# Project agent details

- **Type:** screen.
- **Status:** Designed — ADR-196–198.
- **Route:** `/projects/{slug}/agents/{agentId}`.

## JTBD

Find execution history or fix the specific blocker without confusing an agent infrastructure failure with the disposition of a request.

## Roles & capabilities

Project viewers see safe metadata/statuses. Members need `readRepoFiles` for prompt, memory and code-bearing evidence. `editTask` authorizes human assessment, `launchRun` authorizes a new eligible attempt, and `editSettings` changes future-run configuration. Routes recheck these grants; hiding a control is not authorization.

## Navigation

Enter from the project Agents summary or project tabs; history rows link to run details, request rows to task details and source. URL tab/filter/cursor survives refresh/back/forward. Detached agent history remains read-only. Foreign-project evidence is redacted.

## Layout & regions

Header: pinned identity, safe configuration provenance, retained/active counts and last launched/completed outcome. URL tabs: History, Attempts, Memory, Definition, Settings. Separate 25/max100 keyset cursors. Definition and Memory are permission-gated. Settings uses the existing modal. History remains after detach; settings/memory edits do not.

## States & interactions

Use shared skeleton/error boundaries. Empty history says not run yet, zero successful scan is a success, failed/crashed use exact localized status. Pending candidate is not Ready. Safe metadata remains available if definition/evidence is unavailable. Accessible text and icon supplement color; no operational Git/promotion actions. On concurrent edits show conflict and reload/merge, never overwrite. Retry previews identify one-off runner override separately from future defaults. Unknown effects disable retry with a precise remediation. Human asks keep separate request IDs. SSE refreshes changed content under stable card IDs; no client poller.

Use HeroUI, packaged icons, existing feedback and confirmations, focus-trapped dialogs with focus restore/Escape behavior, aria-live async feedback, mobile overflow and keyboard access. Header/controller lifetime is independent of transient status refresh.

## EN/RU copy

| EN | RU |
| --- | --- |
| Agent executions | Запуски агентов |
| Runs in retained history | Запуски в истории |
| Attempts | Попытки запуска |
| Not run yet | Ещё не запускался |
| New runs available | Доступны новые запуски |
| Definition unavailable | Определение недоступно |
| Run again… | Запустить повторно… |
| Runner for future runs | Раннер для будущих запусков |
| Reconciliation required | Нужна проверка выполнения |
| Incoming requests | Входящие задачи |
| Ready for backlog | Готово к backlog |
| Needs information | Нужны сведения |
| Needs review | Нужна проверка |
| Not actionable | Запрос не требует работы |
| Assessment pending validation | Оценка ожидает проверки |
| Evidence needs rechecking | Доказательства требуют повторной проверки |
| Execution evidence expired | Данные выполнения больше недоступны |

## Linked artifacts

- [Behavior](../../system-analytics/agent-activity-history.md)
- [Web API](../../api/web.openapi.yaml)
- [Screen index](../README.md)

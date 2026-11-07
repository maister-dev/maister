# Incoming requests

- **Type:** screen.
- **Status:** Implemented — ADR-196–198.
- **Route:** `/projects/{slug}?tab=incoming`.

## JTBD

Assess captured requests before accepting them for implementation; distinguish a held request from an agent execution failure.

## Roles & capabilities

Project viewers see safe metadata/statuses. Members need `readRepoFiles` for prompt, memory and code-bearing evidence. `editTask` authorizes human assessment, `launchRun` authorizes an explicit task launch or eligible operational retry, and `editSettings` changes future-run configuration. Routes recheck these grants; hiding a control is not authorization.

## Navigation

Enter from the project Incoming tab. Request rows link to task details, where the original source prompt, assessment evidence and local clarification are separate. URL incoming_state/page survives navigation and reload. Assessment bodies require editTask plus readRepoFiles.

## Layout & regions

Incoming is separate from accepted Backlog and personal Inbox. URL incoming_state
filters: unassessed, needs_information, needs_review, not_actionable; page contains
25 rows, bounded to 1,000 pages. Rows show source, qualification state/freshness,
next action and task link. Details show immutable assessment history, evidence
SHA, targeted question and qualified routing separately.

The complete structured assessment remains inspectable. Optional human assessment
uses one focus-trapped dialog with task/file/run selectors, generated internal
evidence IDs, explained checks and actionable validation; users do not enter enum
codes, evidence IDs or SHAs. A stale accepted assessment remains in immutable
history; clearing its current pointer does not fabricate a never-assessed state.

## States & interactions

Missing, stale, negative and failed-source assessments remain visible. They prevent automatic root launch; an authorized configured manual Launch does not require an assessment. A preparation failure before model execution is labelled as infrastructure failure with its cause and a diagnostic Run link, never a negative task verdict. Explicit task holds, capacity and technical gates remain independent. The [launch contract](../../system-analytics/task-launch-admission.md) owns admission.

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

- [Behavior](../../system-analytics/task-qualification.md)
- [Web API](../../api/web.openapi.yaml)
- [Screen index](../README.md)

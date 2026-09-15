# Запрос: permission-resume оставляет HITL-строку нерасклиниваемой навсегда

> Наблюдено на стенде, ран `841288f9`, 2026-09-15. Отдельный баг, НЕ следствие
> отравления `canonical-artifact-projector-v1` (тот закрыт коммитом `ef8c9ad9`):
> `lockPermissionSource` читает `execution_commands` и `node_attempts`,
> артефакты ему не нужны.

## Что происходит

Оператор отвечает на permission («Yes, and don't ask again») — в
`hitl_requests.response` ложится `optionId`, `responded_at` остаётся `NULL`,
потому что ответ ещё не доставлен в сессию. Сессия получает SIGKILL до
доставки. Платформа делает permission-resume: минтит новый assignment (epoch 2),
двигает `node_attempts.execution_assignment_id` и увеличивает
`action_prompt_ordinal` до 1, кладёт `action_resume`.

`hitl_requests.schema.flowPrompt` при этом никто не переписывает — там остаётся
пин на мёртвое поколение (`commandId 4e8a9bf3`, `assignmentId a4e9be4e`,
`promptOrdinal 0`).

Дальше строка выглядит в UI как живой запрос, но каждый сабмит уходит в 409:
`lockPermissionSource` (`web/lib/flows/graph/prompt-permission.ts:409-418`)
сверяет `row.attempt.executionAssignmentId` (новый) с `source.assignmentId`
(старый пин) и бросает `PromptOwnerInvariantError("permission_attempt_generation")`.
В логе это шесть раз: 00:48–00:51 и 11:38 следующего дня.

Если resume-ход не доедет до доставки или до result-handoff, состояние вечное:
ран стоит в `NeedsInput`, единственная кнопка в UI не работает, оператор ничего
сделать не может.

## Где именно дыра

- `authorizeNodePermissionResume` (`web/lib/flows/graph/permission-resume.ts:468`)
  двигает `node_attempts`, но `hitl_requests` не трогает вообще.
- `authorizeGatePermissionResume` (`web/lib/flows/graph/gate-permission-resume.ts:240`)
  — та же дыра в gate-домене: пишет `gate_results` и `node_attempts`, HITL не
  трогает.
- Их братья `authorizeNodePermissionResult` и `authorizeNodePermissionContinuation`
  закрывают строку правильно — через `completePermissionInputHandoff`
  (`web/lib/flows/graph/permission-result-evidence.ts:240`): `responded_at`,
  `response._audit`, закрытие назначения, статус рана, вебхук `hitl.responded`.
  Ровно этого нет в resume-ветке.

В штатном пути `responded_at` ставится на ACK доставки инпута
(`web/lib/flows/graph/prompt-permission.ts:814`), поэтому пока доставка
происходит — дыра не видна.

## ⚠ Две ловушки — прочитать до того, как писать код

**1. Просто поставить `responded_at` в момент resume НЕЛЬЗЯ.**
`lockNodePermissionSource` (`permission-resume.ts:357`) отбирает кандидатов по
`isNull(hitlRequests.respondedAt)`, и именно через него `authorizeNodePermissionResult`
и `authorizeNodePermissionContinuation` находят свой источник — при пустом
результате они бросают `permission_result_source_disappeared`. Закрыв строку в
resume, вы обменяете этот баг на регресс в штатном пути. Существующий
интеграционный тест на это опирается:
`web/lib/flows/graph/__tests__/permission-resume.integration.test.ts:786`
проверяет, что после успешного resume-сценария `responded_at` — Date (его
ставит более поздний шаг, не resume).

**2. Просто переприпиннить `schema.flowPrompt` на новое поколение — тоже не
решение.** Тогда повторный сабмит будет ПРИНЯТ и доставит ответ, который уже
едет в resume-промпте: второй раз в ту же сессию.

Правильное решение — решение о контракте, а не патч одной строки. Нужно
определить, чем именно является HITL-строка между авторизацией resume и его
завершением, и сделать это состояние явным.

## Что должно стать правдой

1. После авторизации permission-resume оператор не может отправить ответ
   повторно: либо строка не предлагается в UI как actionable, либо respond-путь
   отказывает осмысленно (типизированный отказ с понятной причиной), но НЕ
   инвариантным 409 `permission_attempt_generation`.
2. Ран, чей resume-ход не доехал, не остаётся вечно неразрешимым: у оператора
   есть путь (или система сама доводит состояние до терминального с настоящей
   причиной).
3. Штатный путь не сломан: `authorizeNodePermissionResult` и
   `authorizeNodePermissionContinuation` по-прежнему находят свой источник.
4. Node- и gate-домены ведут себя одинаково — дыра есть в обоих.
5. Инвариант `permission_resume_source_count` (не более одной незакрытой
   permission-строки на ран) продолжает держаться.

## Не входит

- Отказ от epoch-фенсинга или ослабление проверок в `lockPermissionSource` —
  они ловят настоящее рассогласование поколений.
- Терминализация рана из UI-пути.
- Переписывание prompt-owner'ов.

## Полезное, что уже есть

`hasFlowPermissionResume(db, runId)` и `pendingNodePermissionResumeExists()`
(`permission-resume.ts:640`, `:656`) — готовые предикаты «по этому рану resume в
полёте». Вероятный кандидат на то, чтобы гасить affordance в UI и/или отказывать
в respond-пути.

## Критерии приёмки

- Тест, воспроизводящий стендовый сценарий: ответ записан, `responded_at` NULL,
  сессия убита, resume авторизован — повторный сабмит НЕ даёт
  `permission_attempt_generation`.
- Тест на то же в gate-домене.
- Существующие `permission-resume.integration.test.ts` и
  `gate-permission-resume.integration.test.ts` зелёные без правки ожиданий
  (если ожидание всё же меняется — объяснить, устарело оно или сломано).
- Фальсификация: с откатом правки новый тест краснеет по названной причине.

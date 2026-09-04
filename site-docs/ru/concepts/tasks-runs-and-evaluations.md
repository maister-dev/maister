---
title: "Tasks, Runs и сравнение"
description: "Зависимости задач, несколько попыток реализации и воспроизводимое сравнение результатов."
---

**Task** хранит долговечное намерение. **Run** записывает одну попытку его
исполнить. Команда может повторять, сравнивать и аудировать реализации, а task
сохраняет полную историю.

## Граф задач и очередь

У задач есть стабильные project keys и типизированные связи:

- `blocks` и `depends_on` задают порядок доставки;
- `parent_of` связывает декомпозированную работу;
- `requires` описывает success-зависимости orchestrator-а;
- `duplicate_of` сохраняет решение triage.

Launchability вычисляется из этих связей и текущих состояний задач. Готовая
работа входит в priority queue; concurrency limits, pause и доступная ёмкость
определяют момент старта Pending Run. Позиция в очереди видна, поэтому корректный
launch не завершается ошибкой только из-за занятости execution host.

## Несколько Runs одной Task

Одна Task может иметь много Runs. У каждого сохраняются собственные Flow
revision, снимок runner и provider, workspace, evidence, стоимость, gates, diff
и terminal result. Ошибка и альтернативная реализация остаются в одном lineage.

## Сравнение реализаций

Evaluation Study сравнивает 2..N Runs одной Task. Участниками могут быть уже
существующие Runs или Runs, специально запущенные для Study. Сравнение использует
неизменяемые ограниченные снимки evidence и разделяет:

- objective facts: checks, artifacts, schema validation, статистику diff,
  длительность и стоимость;
- независимые попытки AI judgement от настроенных Judge Panels;
- детерминированную aggregation и disagreement;
- append-only human verdict: winner, tie или inconclusive.

Evaluation Methods поставляются как версионированный package content. N-way,
pairwise и tournament-методологии остаются идентифицируемыми и аудируемыми. UI
показывает несовместимые методологии рядом и не вычисляет для них универсальный
score.

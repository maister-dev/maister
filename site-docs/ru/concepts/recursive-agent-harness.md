---
title: "Рекурсивный контур агентов (RAH)"
description: "Ограниченные деревья агентов и Flow с типизированными результатами и независимой проверкой человеком."
---

RAH — управляемый паттерн MAIster для рекурсивной multi-agent работы.
`orchestrator` делегирует ограниченные дочерние Runs, ожидает их без удержания
активной agent session, собирает типизированные результаты и сводит их в один
результат для обычного контура evidence и review.

## Эталонная схема доставки

```text
orchestrator → writer → независимый judge → human review → promotion
      └──── read-only agent- или Flow-researchers ────┘
```

В эталонной схеме только один writer изменяет worktree. Research-children
работают read-only и публикуют проверенные по schema публичные Run results.
Coordinator собирает их по identity Runs, а не извлекает данные из свободного
текста ответа.

## Границы управления

RAH сохраняет свойства, которые обычно теряются у скрытых subagents:

- каждый child — first-class Run в видимом рекурсивном дереве;
- depth, fan-out, active children, общее число children, tokens, time и failure
  budgets ограничены и зафиксированы в snapshot;
- agent- и Flow-children используют одну очередь admission;
- schema, revisions, producer identity, validity и artifact manifest результата
  долговечны;
- failures проходят через bounded rework или human escalation;
- перед promotion сохраняются независимая проверка и стандартный readiness gate.

## Result-only research

Research Flow, который публикует валидный result и не меняет код, может
завершиться как `Done` без бессмысленного diff review. Run с изменениями кода
по-прежнему проходит обычные Review и promotion.

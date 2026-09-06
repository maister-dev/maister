---
title: "Манифест проекта"
description: "Настройте репозиторий, продвижение, привязки Flow и ограниченные возможности в maister.yaml."
---

`maister.yaml` находится в корне подключённого репозитория. Schema version 2
связывает проект с веткой по умолчанию, способом продвижения, Flow-пакетами,
исполнителями и возможностями.

## Минимальный манифест

```yaml
schemaVersion: 2
project:
  name: my-app
  repo_path: /repos/my-app
  default_branch: main
  branch_prefix: maister/
  default_runner: inherit
promotion:
  mode: local_merge
flows: []
```

## Привязка Flow

```yaml
flows:
  - id: feature
    source: github.com/example/maister-flow-feature
    version: v1.4.0
    runner: inherit
```

`version` закрепляет тег. При установке MAIster записывает конкретный commit,
поэтому позднее изменение тега не затрагивает активный прогон.

## Привязка пакета

```yaml
packages:
  - id: my-flows
    source: https://github.com/example/maister-packages
    version: my-flows/v1.1.0
    path: packages/my-flows
```

Одна запись `packages[]` подключает все Flow и наборы возможностей, которые
поставляет пакет, закрепляя один тег пакета вида `<name>/vX.Y.Z`. `path` —
директория пакета внутри репозитория с несколькими пакетами. MAIster записывает
эту запись при подключении, обновлении или откате пакета в интерфейсе, а при
регистрации репозитория устанавливает и подключает перечисленные версии. См.
[Источники пакетов и версии](/ru/guides/package-sources-and-versions).

## Продвижение

Используйте `local_merge` для слияния в локальную ветку. Выберите
`pull_request` и настройте remote, когда хост умеет выполнять push и
авторизован у провайдера.

## Возможности и секреты

Проект может привязать skills, MCP-серверы, инструменты, настройки, определения
агентов и профили окружения. В конфигурации допустимы только ссылки вида
`env:PROVIDER_TOKEN`; значения секретов хранятся в окружении нужного процесса.

## Ошибки валидации

Неизвестная версия схемы, повторяющиеся id Flow, пустой source или version и
неразрешимые ссылки на runner вызывают ошибку. MAIster не выбирает замену сам.

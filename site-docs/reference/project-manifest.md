---
title: "Project manifest reference"
description: "Configure a repository, promotion policy, Flow bindings, and scoped capabilities in maister.yaml."
---

`maister.yaml` lives at the registered repository root. Schema version 2 binds
the project to its default branch, promotion mode, Flow packages, runners, and
capabilities.

## Minimal manifest

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

## Flow binding

```yaml
flows:
  - id: feature
    source: github.com/example/maister-flow-feature
    version: v1.4.0
    runner: inherit
```

`version` is a tag pin. Installation records the resolved commit, and an active
Run stays on that revision even if the upstream tag later changes.

## Package binding

```yaml
packages:
  - id: my-flows
    source: https://github.com/example/maister-packages
    version: my-flows/v1.1.0
    path: packages/my-flows
```

One `packages[]` entry attaches every Flow and capability bundle a package
ships, pinned to one per-package tag of the form `<name>/vX.Y.Z`. `path` is the
package directory inside a multi-package repository. MAIster writes this entry
when a package is attached, upgraded, or rolled back in the UI, and installs
and attaches the listed versions when a repository is registered. See
[Package sources and versions](/guides/package-sources-and-versions).

## Promotion

Use `local_merge` when MAIster should land changes into a local target branch.
Use `pull_request` with a configured remote when the host can push and
authenticate to the provider.

## Capabilities and secrets

Project capabilities may bind skills, MCP servers, tools, settings, agent
definitions, and environment profiles to compatible agent families. Put only
secret references such as `env:PROVIDER_TOKEN` in configuration. Secret values
belong in the appropriate host process environment.

## Validation behavior

Unknown schema versions, duplicate Flow identifiers, empty sources or versions,
and unresolved runner references fail configuration validation. MAIster reports
the error and does not guess a replacement.

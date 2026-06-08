# AIF Flow package

The **AI Factory (AIF) flow package for MAIster**. A self-contained plugin
that wraps the [AI Factory](https://github.com/lee-to/ai-factory/tree/2.x)
agent workflows (plan, implement, review, fix, evolve, roadmap, init) as
MAIster flows backed by a shared skills + subagents bundle.

This package is self-contained and will move to its own git repo; nothing
here imports from MAIster core.

## Provenance

- **Framework**: AI Factory `2.x` —
  https://github.com/lee-to/ai-factory/tree/2.x
  (Apache-2.0). Its skills and subagents are vendored under `capability/`.
- **Dev workflow**:
  https://github.com/lee-to/ai-factory/blob/2.x/docs/workflow.md
- **Config reference**:
  https://github.com/lee-to/ai-factory/blob/2.x/docs/configuration.md

## Flows

Five flows ship with this package, each routed by what the incoming task is.

| flow id       | route_when                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------- |
| `aif-dev`     | A feature / enhancement / refactor with a clear spec (plan → review → implement → review → fix). |
| `aif-bugfix`  | A reported bug / error / regression to fix (`/aif-fix` loop; emits a self-improvement patch).  |
| `aif-evolve`  | Periodic maintenance: distill accumulated fix-patches into better skills (not feature work).   |
| `aif-roadmap` | A large / multi-milestone initiative needing a roadmap before planning.                         |
| `aif-init`    | One-time: project not yet AIF-initialized (`/aif` + `/aif-architecture`).                       |

Flow sources live under `flows/<id>/flow.yaml`.

## Package layout

| Path                          | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `capability/`                 | Shared bundle — vendored AIF skills (`skills/`) + subagents (`agents/`). |
| `flows/<id>/flow.yaml`        | The 5 flow sources listed above.                                        |
| `config/ai-factory.config.yaml` | Default `.ai-factory/config.yaml` template for a consuming project.    |
| `setup.sh`                    | Inert no-op (see below).                                                |

## How MAIster consumes it

A consuming project's `maister.yaml` registers this package twice over:

- **One shared `capability_imports` bundle** pointing at `capability/`.
  All five flows reuse the same vendored skills + subagents instead of each
  carrying their own copy. MAIster materializes these into the workspace
  (per ADR-043) — there is no `ai-factory init` and no npm install.
- **Five `flows[]` sources**, one per `flows/<id>/flow.yaml` above. Each flow
  resolves its steps against the shared capability bundle.

If a project has no `.ai-factory/config.yaml`, it receives
`config/ai-factory.config.yaml` as the default. The MAIster-compat overrides
in that template matter most for `git`: `git.create_branches: false` —
**MAIster owns the worktree and branch**, so AIF must not create its own.

Interactivity (questions, approvals, review gates) is delivered by
**MAIster-native HITL** (form / permission steps), not the AIF
`AskUserQuestion` tool.

> **Run the `aif-init` flow first** if the project has no
> `.ai-factory/DESCRIPTION.md`. The other flows assume an initialized AIF
> project (description + architecture present).

## setup.sh

`setup.sh` is an **inert no-op**: it prints a one-line notice to stderr and
exits `0`. MAIster delivers AIF skills through capability materialization, so
there is nothing to install at flow-setup time.

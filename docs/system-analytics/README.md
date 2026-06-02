# System Analysis

Domain-grouped analyst artifacts: state machines, sequence diagrams,
process flows, edge cases. One file per domain.

Every file in this folder follows the structure defined in
[`../CLAUDE.md#r5`](../CLAUDE.md#r5-process-and-domain-description-structure):

1. **Purpose** — one paragraph, name the domain and its boundary.
2. **Domain entities** — bulleted list of nouns (link to ERD if persisted).
3. **State machine** (where applicable) — `stateDiagram-v2`.
4. **Process flows** — `flowchart` or `sequenceDiagram` per scenario.
5. **Expectations** — acceptance contract per
   [`../CLAUDE.md#r5a`](../CLAUDE.md#r5a-expectations-section-fill-in-rules).
6. **Edge cases** — bulleted list with `MaisterError` code links.
7. **Linked artifacts** — pointers to API spec, ERD, ADR, source.

## Domains

| Domain | File | What it covers |
| ------ | ---- | -------------- |
| Identity and access | [`identity-access.md`](identity-access.md) | Users, Auth.js sessions, RBAC gates, user menu, personal settings, password changes. |
| Projects | [`projects.md`](projects.md) | Registration, slug derivation, archival, Flow plugin install on register. |
| Flow packages | [`flow-packages.md`](flow-packages.md) | Package revision lifecycle, trust, compatibility, enablement, upgrade, rollback. |
| Flows | [`flows.md`](flows.md) | Plugin packaging, step DSL (cli/agent/guard/human), executor override resolution. |
| Tasks | [`tasks.md`](tasks.md) | Board lifecycle (Backlog ↔ InFlight ↔ Done ↔ Abandoned), 1:N task ↔ run, retry loop. |
| Runs | [`runs.md`](runs.md) | Run state machine, ACP keep-alive + checkpoint/resume, crash recovery. |
| Scratch runs | [`scratch-runs.md`](scratch-runs.md) | Manual coding-agent dialog workspaces outside the task board, visible in active workspaces. |
| Executors | [`executors.md`](executors.md) | Executor identity, env-router vs CCR, per-step override resolution. |
| Workspaces | [`workspaces.md`](workspaces.md) | Worktree lifecycle, promotion policy, reconciliation on startup. |
| HITL | [`hitl.md`](hitl.md) | Three HITL kinds (permission / form / human), keep-alive activity tracking. |
| Assignments | [`assignments.md`](assignments.md) | M13 role-owned work queue, actor identities, claim/release/take-over lifecycle. |
| External operations | [`external-operations.md`](external-operations.md) | API tokens, external gate reports, and thin MCP facade for CI/scripts/agents. |
| Instance configuration | [`instance-config.md`](instance-config.md) | Read-only host roots (`MAISTER_REPOS_ROOT`, `MAISTER_WORKTREES_ROOT`), host-tool status, admin `/settings`. |
| Git integration | [`git-integration.md`](git-integration.md) | Provider detection, host-credential clone/init/remote, non-interactive git, URL redaction. |

## What this folder is NOT

- Not the place for ADRs (those live in [`../decisions.md`](../decisions.md)).
- Not the place for API specs (those live in [`../api/`](../api/)).
- Not the place for the canonical DB schema (that lives in
  [`../database-schema.md`](../database-schema.md) and [`../db/`](../db/)).

This folder is the **analyst's view** of how each domain behaves —
diagrams and bullets, with prose only as glue.

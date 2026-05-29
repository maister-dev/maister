# Product View

## Target User

MAIster serves a solo technical owner who runs several software projects and
already uses coding agents. The user wants one control plane for project state,
Flow launches, HITL, reviews, and merges instead of many terminals.

Phase 2 can add small-team collaboration. Enterprise governance, RBAC, and
large organization rollout stay outside the current target.

## Product Model

```text
Project -> Task -> Run -> Workspace -> Agent step -> HITL -> Review -> Merge
```

- **Project** — a registered repo with `maister.yaml` v2.
- **Flow** — a pinned plugin bundle with `flow.yaml` v1 steps.
- **Executor** — `{agent, model, env?, router?}`; claude and codex are current.
- **Task** — backlog intent. One task may spawn many runs.
- **Run** — one execution attempt with status, workspace, step records, and
  HITL rows.
- **Workspace** — one git worktree per run.
- **HITL request** — permission, structured form, or human-review input.

## Jobs To Be Done

| JTBD | User outcome |
| ---- | ------------ |
| See portfolio state | Know which projects have running, blocked, crashed, and review-ready work. |
| Launch a controlled run | Turn a backlog task into an isolated worktree and Flow execution. |
| Answer only needed questions | See all pending HITL requests in the UI and respond through the web tier. |
| Review the result | Inspect logs, artifacts, diff, and status before merge. |
| Retry without recreating work | Send a failed or abandoned task back to Backlog and launch attempt N+1. |

## Current Scope

- Multi-project registry using `maister.yaml` v2.
- Project-scoped executors and Flow plugin installs.
- Portfolio home with active workspaces and HITL count.
- Per-project board with `Backlog | In Flight`.
- Task creation with Flow and optional executor override.
- `POST /api/runs` launch path with scheduler, worktree creation, and
  background Flow runner.
- ACP supervisor process with claude/codex adapter binaries.
- Durable run SSE via `run.events.jsonl`.
- HITL response route with row-level claim, atomic artifacts, permission
  delivery, and runner-owned resume.
- Raw diff and merge workflow remain designed until their routes land.

## Phase 2

- Additional ACP executors after the claude/codex contract proves stable.
- Flow trust UI and sandboxing for third-party Flow sources.
- Guard enforcement for cost, time, and regex caps.
- Richer review, validation, and preview surfaces.
- Background agents, external board sync, notifications, and team workflows.

## Success Criteria

The current target succeeds when MAIster can register at least two real projects, install
their Flows, launch queued runs through claude or codex, stream durable events,
handle at least one permission HITL and one structured form HITL, recover cleanly
from ordinary failures, and merge a clean review result.

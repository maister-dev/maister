# Design request: shared-worktree review/promote ownership model

> **Status:** Shipped as ADR-102 (current truth: `../system-analytics/orchestrator.md`). Originally a gated-off Phase-2 planning request; this doc
> captures the problem + the decisions a `/aif-plan` pass must resolve before code.
> **Milestone:** follow-up to M37 (orchestrator engine, ADR-098/099/100).
> **Origin:** Codex adversarial-review Finding 2 (2026-06-21). Also tracked as the
> background-task chip `task_475bec6f`.

## Problem

The orchestrator's swarm Layer-2 supports `workspace_mode: shared` on a delegation:
N child runs of one orchestrator tree point at ONE pre-allocated git worktree
(`<slug>/agents/<rootRunId>`). The mode is **GATED at launch** (refused with
`MaisterError("CONFIG")`) because its review/promote ownership model is
under-specified:

- The **allocator** (first) child creates the `workspaces` row — `worktree_path` is
  UNIQUE. **Reuser** children get NO `workspaces` row of their own.
- `finalizeAgentRun` (`web/lib/agents/launch.ts`) decides Review-vs-Done from
  `finalStatusForCleanAgentExit(workspaceRows.length > 0)` — so a reuser child
  finalizes **`Done`, not `Review`**, and its diff is never individually reviewable
  (it can be stranded, or merged via the allocator's promote).
- Promoting the allocator child merges the WHOLE shared tree — including siblings'
  in-progress work — and nothing orders "promote the tree" **after** "all shared
  children have settled."

This contradicts the documented invariant that a `worktree` child produces a diff
and stops for `Review`.

## Relevant code

- `web/lib/agents/launch.ts`:
  - the launch gate `if (input.workspaceMode === "shared" && workspace === "worktree") throw CONFIG`
    (just after the `&& !input.rootRunId` check) — **remove to re-enable**;
  - `finalStatusForCleanAgentExit` (the Review-vs-Done signal);
  - the **dormant** shared-allocation block `if (isShared) { ... }` inside
    `if (workspace === "worktree")` (`sharedAgentWorktreePath`, `reuseSharedTree`,
    idempotent TOCTOU re-check → `CONFLICT`).
- `web/lib/scheduler.ts`: the **dormant** serialized-writer guard
  `sharedWriterSiblingActive` (one active writer per shared tree), already wired into
  BOTH `tryStartRun` and `promoteNextPending` — this prevents concurrent-write
  CORRUPTION; keep it.
- Docs: `docs/decisions.md` ADR-099 (worktree allocation modes, now gated/Phase-2);
  `docs/system-analytics/orchestrator.md` (edge cases); `docs/error-taxonomy.md`.

## Decisions to resolve (the plan's first job — surface as owner decisions)

1. **Review granularity.** Is review **per-tree** (one review for the shared diff) or
   **per-child**? A shared tree is ONE branch = ONE diff, so per-child review of the
   same diff is probably wrong.
2. **Ownership.** Who owns the shared tree's `workspaces` row + the promote — the
   allocator child, the orchestrator run itself, or a dedicated tree-level row?
3. **Ordering.** The shared tree must NOT promote until ALL shared children of that
   `root_run_id` have settled, else a mid-flight promote merges partial sibling work.
   How is "all shared children settled" detected and gated?
4. **Promotable handle.** How does each writable shared child reach Review/promote
   without N independent promotes of the same tree (each of which would merge it)?

## Acceptance criteria

- Every writable shared-worktree child's contribution is reviewable and promotable
  **exactly once**, with no sibling-merge surprise and no stranded diffs;
  concurrent-writer corruption stays prevented (the existing serialized-writer guard).
- Re-enable launch by removing the shared + writable-worktree `CONFIG` gate; **restore**
  the two former shared-allocation integration tests (currently replaced by a
  gate-refuse test in `web/lib/agents/__tests__/launch-worktree-modes.integration.test.ts`)
  and add the review/promote-model tests.
- Flip ADR-099 + `orchestrator.md` from "gated/Phase-2" back to Implemented.

## Notes

- Integration tests use testcontainers Postgres:
  `DOCKER_HOST=unix:///Users/developer/.docker/run/docker.sock pnpm exec vitest run --project integration <path>`
  (Bash `dangerouslyDisableSandbox: true`).
- Gates: `pnpm --filter maister-web typecheck && test:unit`, `pnpm validate:docs`,
  eslint scoped to changed files.

# Project Brain B/C Preflight

Date: 2026-07-03
Branch: `feature/project-brain-bc-consultant-improver`

## Repository Position

- Current feature HEAD after the plan commit:
  `35af3308eec71070a9920f6e1be04b1a4f768e5f`.
- `main` and `origin/main` both resolve to
  `e27bd51d00f30cac53a98d52a6d846db46d9bb06`.
- The branch contains only the committed plan before this preflight note.

## Prerequisite P7 Marker Check

- `web/lib/flows/graph/run-context.ts` carries the P7 run-context blackboard and
  the ADR-122 `brain` projection as already-recalled ambient context.
- `web/lib/flows/graph/runner-graph.ts` appends the literal run-context pointer
  and a separate Brain caveat:
  `Any \`brain\` entries in it are project memory distilled from prior runs`.
- Coverage exists in:
  - `web/lib/flows/graph/__tests__/run-context.test.ts`
  - `web/lib/flows/graph/__tests__/run-context.integration.test.ts`
  - `web/lib/flows/graph/__tests__/run-context-brain.test.ts`
- Disposition: the pasted P7 prerequisite is landed on `main`; do not rewrite
  this seam while adding indexed recall. Sub-project B may extend the ambient
  projection shape only through `run-context.ts` DTOs and existing Brain ambient
  service boundaries.

## Parallel Worktree And Collision Audit

Attached worktrees with named branches:

| Branch | Worktree | Relevant collision result |
| --- | --- | --- |
| `feature/project-brain-bc-consultant-improver` | `/Users/developer/.codex/worktrees/777d/mAIster` | Current branch. |
| `feature/m24-m25-wave1-long-lead` | `/Users/developer/.codex/worktrees/8640/mAIster` | `main...HEAD` has no file changes. No active collision. |
| `feature/experiment-comparison-studio` | `/Users/developer/.codex/worktrees/b5ef/mAIster` | `main...HEAD` has no file changes. No active collision. |
| `feature/stop_ai_advisor_run` | `/Users/developer/.maister/worktrees/maister-dev/9075903c-fe14-4ce4-a848-e5869c7b6da4` | `main...HEAD` has no file changes. No active collision. |
| `claude/optimistic-leakey-8fde07` | `/repos/mAIster/.claude/worktrees/optimistic-leakey-8fde07` | Touches `web/lib/flows/graph/runner-graph.ts`, `docs/decisions.md`, `docs/api/web.openapi.yaml`, `docs/db/erd.md`, `web/lib/db/schema.ts`, and main migration `0089_auto_promotion_lanes.sql`. |

Rebase order:

1. Keep this branch on top of current `main` through Phase 0.
2. Before implementation commits that touch `runner-graph.ts`,
   `docs/decisions.md`, `docs/api/web.openapi.yaml`, `docs/db/erd.md`, or
   `web/lib/db/schema.ts`, re-check whether
   `claude/optimistic-leakey-8fde07` merged and rebase/renumber if needed.
3. Brain schema changes stay in `web/lib/db/brain-migrations/0003`, `0004`,
   and `0005` unless Phase 0 records an unavoidable main-lineage ALTER.

## ADR Allocation

- `git --no-pager grep -n "^### ADR-" main -- docs/decisions.md` shows the
  current highest real ADR on `main` is ADR-125.
- The request says ADR-124 and ADR-126 are reserved by parallel work.
- Allocation for this branch:
  - ADR-127: Project Brain Consultant indexed tier.
  - ADR-128: Project Brain self-improvement proposal bridge.
- Renumber rule: before editing `docs/decisions.md`, re-run the ADR grep. If
  ADR-127 or ADR-128 already exists, allocate the next two free sequential
  numbers and update all docs/spec links in the same commit.

## Migration Allocation

- Brain migration journal on `main` has:
  - `0001_brain_foundation`
  - `0002_brain_review_fixes`
- Allocation for this branch:
  - `0003_brain_indexed_tier.sql` for Sub-project B.
  - `0004_brain_proposals.sql` for Sub-project C.
  - `0005_brain_proposal_decision_stats.sql` for Sub-project C decision
    analytics.
- Main migration journal currently ends at `0088_mixed_hercules`.
- Disposition: zero main-lineage DDL remains viable for the default contract.
  The existing `memory:read`/`memory:write` scopes and
  `agent_project_links.can_read_brain`/`can_write_brain` axes cover B/C. Do not
  add `can_propose_brain` unless Phase 0 explicitly changes FR-C6 and updates
  token issuance, authz, OpenAPI, route tests, and MCP tests together.

## Token And Agent-Link Contract

- `web/types/token-scopes.ts` includes `memory:read` and `memory:write` in
  `TOKEN_SCOPES` and `AGENT_TOKEN_SCOPES`.
- `web/lib/tokens/ext-handler.ts` maps:
  - `memory:read -> readBrain`
  - `memory:write -> writeBrain`
- `web/lib/authz.ts` keeps `readBrain` and `writeBrain` as project actions.
- `web/lib/db/schema.ts` has `agent_project_links.can_read_brain` and
  `can_write_brain`; the `can_propose_brain` comment is a deferred design hint.
- Disposition:
  - `memory_clusters` uses `memory:read` plus `can_read_brain`.
  - `memory_propose` uses `memory:write` plus `can_write_brain`.
  - Human proposal acceptance uses session/project RBAC such as
    `manageCatalog`, `createTask`, or `editTask`; Brain write access alone is
    not enough to publish or project docs changes.

## Serena Platform MCP Trust Disposition

- `web/lib/mcp/projection.ts` projects platform MCP rows solely by
  `enabled === true`; it does not check `trust_status`.
- Existing projection tests expect enabled untrusted rows to materialize.
- Disposition for the Serena seed:
  - Seed `id = "serena"` with `enabled = false` and
    `trust_status = "untrusted"` to keep execution non-materialized by default.
  - The row is a catalog/admin seed, not a project capability grant.
  - If product visibility later requires `enabled = true`, first add a trust
    gate to projection/materialization and update tests/docs together.

## Phase 0 Carry-Forward Decisions

- B is read-only over indexed canonical sources.
- C owns all write-back through `brain_proposals`, authored catalog drafts, and
  board task/projection machinery.
- Indexed source file content must be opened through the existing project files
  API/viewer and `readRepoFiles` gate, not returned by Brain source APIs.
- Ext rate limiting remains deferred until the multi-tenant middleware exists.
- No `auto_publish`, no direct repo writes from `web/lib/brain/*`, no new domain
  event kinds, no file watchers, no LSP edge connector in this slice.

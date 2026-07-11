# Project Brain B/C SDD Freeze

Date: 2026-07-03
Branch: `feature/project-brain-bc-consultant-improver`
Status: Phase 0 implementation contract

## Scope Boundary

Sub-project B is the read-only Consultant/indexed tier. It indexes canonical
project sources, stores chunks and pointers, and extends recall so agents and
humans can find decisions, direction, contracts, and conventions without making
the Brain authoritative.

Sub-project C owns all write-back. Recurring evidence becomes
`brain_proposals`; accepted or eligible proposals create M25 authored-catalog
drafts or board tasks. The Brain never writes repo files directly and never
publishes artifacts by itself.

## In-Scope Functional Requirements

| FR | Requirement | Source anchors | Implementation tasks | Required tests |
| --- | --- | --- | --- | --- |
| FR-B1 | Add indexed-tier Brain schema, chunk tables, source tables, edges, project config, and chunk embedding support in brain migration `0003`. | D2, D4, E-1, E-2, sec.4 | T1.1, T1.2 | `indexed-schema.integration.test.ts`, `check-brain-migrations.test.ts` |
| FR-B2 | Provide built-in typed chunkers through `ChunkerRegistry`; keep package-extensible chunkers deferred. | D5, D6, E-9 disposition, sec.7 | T2.1, T2.2 | `chunker-registry.test.ts` and fixture corpus |
| FR-B3 | Register per-project canonical sources and read tracked default-branch content through server-side repo state. | D7, sec.3.2 | T3.1, T3.2, T14.1 | source/indexer integration tests, Project Brain SSR component/route coverage |
| FR-B4 | Incrementally index source chunks with `source_hash`, chunker-version gating, bounded source jobs, and per-source errors. Owned-item reindex remains resumable from the missing-generation worklist. | E-7, E-8, sec.5.2 | T3.2, T4.1, T4.2 | `indexer.integration.test.ts` |
| FR-B5 | Extend explicit, MCP, ambient, and snapshot recall to a union of owned item hits and indexed chunk hits. | D9, E-12, E-13, sec.5.3 | T5.1, T5.2 | recall integration, ext route, MCP contract, ambient tests |
| FR-B6 | Resolve `decision`/`direction` home per project; refuse retain into canonical kinds when a covering source exists. | D7, sec.3.1, sec.3.2, E-13 | T6.1 | home-resolution integration tests |
| FR-B7 | Make `state_fact` supersede on changed near-duplicate content while preserving lesson/observation reinforce behavior. | sec.3.1, sec.13 | T6.2 | retain race and supersede tests |
| FR-B8 | Preserve graph references through `brain_edges` and best-effort re-anchor on re-chunking. | D10, E-14 | T7.1 | edge/re-anchor integration tests |
| FR-C1 | Add proposal schema and FSM in brain migration `0004`. | D8, E-5, sec.4, sec.5.4 | T9.1 | migration and FSM integration tests |
| FR-C2 | Add server-computed memory clusters and improver platform-agent path. | D8, ADR-111, sec.5.4, sec.14-C | T10.1, T10.2 | clusters/proposals tests, package smoke |
| FR-C3 | Review/accept/reject proposals through human session RBAC and M25 authored drafts. | E-5, M25 authored catalog | T11.1 | proposal review route/service tests |
| FR-C4 | Configure autonomy as manual by default with `auto_draft` only; `auto_publish` remains absent. | D8 | T12.1 | autonomy config tests and grep |
| FR-C5 | Project docs/state changes through board tasks and existing run/promotion machinery. | D7, D8, E-5, sec.3.2 | T12.2 | task creation and auto-launch integration tests |
| FR-C6 | Expose `memory_clusters` and `memory_propose` through ext HTTP and MCP using existing memory scopes. | E-5, token contract | T10.1 | ext authz tests and MCP dispatch tests |
| FR-C7 | Seed Serena as a visible but non-executable platform MCP catalog row. | D6, sec.8 trust | T13.1 | MCP seed and projection tests |
| AC-Docs | Keep docs, contracts, screens, migrations, analytics, and tests complete and internally consistent. | docs rules, OpenAPI/AsyncAPI ADRs | T0.2, T0.3, T0.4, T15.1 | docs validators and contract validators |

## Deferred Or Non-Goals

| Anchor | Disposition |
| --- | --- |
| Package-extensible chunker/connector code execution | Deferred. Built-in chunkers ship now; package-delivered executable chunkers wait for a trust/sandbox slice. |
| LSP edge connector | Deferred. Serena is seeded as an optional non-executable MCP catalog row; no Brain dependency and no LSP-derived edge feed in this slice. |
| `auto_publish` | Non-goal. The highest autonomy mode in this slice is `auto_draft`; publishing remains human/catalog controlled. |
| Direct repo writes from Brain services | Non-goal. C routes proposals to authored drafts or board tasks only. |
| External rate limiting | Deferred until multi-tenant middleware exists. Request bounds and authz remain enforced now. |
| New domain-event kinds | Non-goal. Indexing uses existing run/promotion/package domain events plus explicit manual reindex. |
| RU stemming/indexing config | Deferred. Current lexical bias remains documented. |
| Separate DB or PG schema | Rejected by ADR-122; use `brain_*` tables in the existing Postgres instance. |

## Shared DTO Contracts

### Recall Hit Union

Owned hit:

```json
{
  "tier": "owned",
  "itemId": "brain_item_id",
  "kind": "lesson",
  "title": "Known release constraint",
  "content": "Full owned memory content",
  "confidence": 0.7,
  "score": 0.91,
  "provenance": {
    "runId": "run_id",
    "gateKind": "command_check"
  }
}
```

Indexed hit:

```json
{
  "tier": "indexed",
  "chunkId": "brain_chunk_id",
  "kind": "decision",
  "title": "ADR-122 Project Brain",
  "preview": "Capped excerpt from the canonical source",
  "confidence": 1,
  "score": 0.84,
  "pointer": {
    "sourcePath": "docs/decisions.md",
    "sourceRange": { "startLine": 10184, "endLine": 10305 },
    "stableId": "docs/decisions.md#adr-122"
  }
}
```

Snapshot rows store `returned_items` as:

```json
[
  { "tier": "owned", "itemId": "brain_item_id", "score": 0.91 },
  {
    "tier": "indexed",
    "chunkId": "brain_chunk_id",
    "score": 0.84,
    "pointer": {
      "sourcePath": "docs/decisions.md",
      "sourceRange": { "startLine": 10184, "endLine": 10305 },
      "stableId": "docs/decisions.md#adr-122"
    }
  }
]
```

Ambient P7 projection uses the same union after applying policy:

- owned hits keep priority for all K=5 slots;
- indexed hits fill remaining slots only;
- indexed ambient hits are capped at two and require the indexed threshold;
- preview text is capped and is always labeled as background, not instruction.

### Chunk Shape

All chunkers return this closed shape:

```json
{
  "kind": "markdown_section",
  "title": "Section title",
  "path": "docs/decisions.md",
  "symbol": "ADR-122",
  "content": "Chunk body",
  "metadata": { "parser": "markdown" },
  "source_range": { "startLine": 1, "endLine": 40 },
  "stable_id": "docs/decisions.md#adr-122"
}
```

The code type exports use camelCase. Database JSON and OpenAPI use the snake-case
field names above where the current API style already does so.

## Authz Matrix

| Route/tool/action | Token scope | Project action | Agent-link axis | Notes |
| --- | --- | --- | --- | --- |
| `GET /api/v1/ext/projects/{slug}/memory` / `memory_recall` | `memory:read` | `readBrain` | `can_read_brain` for agent tokens | Returns owned/indexed recall union and writes explicit snapshot. |
| `POST /api/v1/ext/projects/{slug}/memory` / `memory_retain` | `memory:write` | `writeBrain` | `can_write_brain` for agent tokens | Owned-tier retain only; `decision`/`direction` may be refused by home resolution. |
| `GET /api/v1/ext/projects/{slug}/memory/clusters` / `memory_clusters` | `memory:read` | `readBrain` | `can_read_brain` for agent tokens | Server computes clusters from existing evidence. |
| `POST /api/v1/ext/projects/{slug}/memory/proposals` / `memory_propose` | `memory:write` | `writeBrain` | `can_write_brain` for agent tokens | Creates pending proposals only; no publish or repo write. |
| Project Brain page read | session | `readBrain` | n/a | Pointer opening delegates to the existing file viewer and also needs `readRepoFiles`. |
| Project Brain source mutation/reindex | session | `editSettings` | n/a | Source body paths are repo-relative and server validated. |
| Proposal accept for rule/skill/flow | session | `manageCatalog` plus project access | n/a | Creates authored catalog draft; publishing path unchanged. |
| Proposal accept for adr/roadmap/state projection | session | `createTask` | n/a | Creates a board task and optional auto-launch metadata. |
| Project Brain settings | session | `editSettings` | n/a | Saves home-resolution and projection flow settings. |
| Admin Brain defaults | session | global admin | n/a | Embedding/distill/autonomy defaults. |
| Serena catalog seed | admin-catalog ensure | global admin path when exposed | n/a | Seed is `enabled=false`, `trust_status=untrusted`; not executable by default. |

## Edge-Case Ownership

| Edge case | Owning task | Expected result |
| --- | --- | --- |
| Binary or oversized source | T4.1 | Source records a terminal error; index job continues. |
| Malformed parse input | T2.1, T4.1 | Typed parser error scoped to source; no process crash. |
| Source vanished from HEAD | T4.1 | Source records vanished state and retires chunks per indexer decision. |
| Glob source exceeds match/byte budget | T3.2, T4.1 | Registration/indexing refuses with `PRECONDITION`; an existing source records `brain_sources.last_error` and the worker continues. |
| Source produces too many chunks or embedding segments | T4.1 | Indexing records a deterministic source error and does not insert partial chunks. |
| Glob overlaps an enabled exact source of the same project/kind | T4.1 | The glob excludes the exact peer path so recall does not duplicate canonical chunks. |
| HTML normalized to markdown | T2.1 | `source.kind=html`, `chunker_id=markdown`, range maps to normalized intermediate. |
| Embedding outage mid-index | T4.1 | Job remains retryable/running with `EMBEDDING_UNAVAILABLE`. |
| Supersede vs reinforce race | T6.2 | Existing advisory lock serializes state_fact supersede and lesson reinforce paths. |
| Improver evidence expires mid-run | T9.1, T10.2 | Proposal may still reference evidence ids; review shows expired evidence state. |
| Duplicate `memory_propose` with `cluster_hash` | T10.1 | Idempotent no-op returning the existing pending proposal. |
| Duplicate `memory_propose` without `cluster_hash` | T10.1 | Creates a separate proposal unless the closed duplicate policy says otherwise. |
| Projection task run fails | T12.2 | Proposal remains applied; linked task/run shows normal failure state. |
| Project delete | T1.1, T9.1 | Cascades all new Brain tables and proposal rows. |
| Invalid DB configuration | T1.1, T5.1, T10.1 | Missing, malformed, or non-Postgres DB configuration fails before Brain; Postgres Brain availability keeps its typed service/tool guard. |
| Reindex vs retain | T4.1, T5.1 | Immutable generation rows plus exact-one embedding target prevent duplicates. |
| Chunker-version bump | T7.1 | Edges re-anchor by symbol/path; unmapped edges become degraded. |
| Machine actor accept/reject | T11.1 | Refused; only human/session or explicit autonomy path can conclude. |
| Serena seed repeated through admin-catalog ensure | T13.1 | Insert-only idempotent ensure with `created`/`skipped` counts. |

## Test Design Rules

- Every production behavior starts with a failing RED test that exercises the
  real service or route boundary when practical.
- Unit tests are reserved for pure chunkers, DTO transforms, ranker policy, FSM
  reducers, and closed config parsing.
- Integration tests own DB migrations, route authz, source/index jobs, recall,
  proposals, and task projection.
- SSR component, route, auth, and integration tests own this branch's
  server-rendered Project Brain UI, source actions, proposal review, settings
  blocks, and i18n parity. Add Playwright when a browser-only Brain interaction
  or file-viewer journey is introduced.
- Tests must avoid overlap: one edge case has one owning test unless a second
  boundary must prove contract parity, such as ext route plus MCP mirror.
- Trivial tests that repeat TypeScript checking, static rendering, or constant
  presence are not acceptable.

## Completeness Pass

- D1-D10 are either already implemented by A, in scope for B/C, or explicitly
  deferred above.
- E-1 through E-14 have an owning FR, existing A implementation, or a deferral.
- Section 14-B maps to FR-B1 through FR-B8 and section 14-C maps to FR-C1
  through FR-C7.
- Every in-scope FR has at least one implementation task and one required test.

## Consistency Pass

- Chunk shape is fixed once and reused by DB JSON, chunker return types, indexed
  recall, screen docs, and OpenAPI.
- Recall responses use one owned/indexed union across ext HTTP, MCP,
  `writeBrainSnapshot`, and ambient P7 projection.
- B/C authz uses current `memory:read`/`memory:write` scopes and
  `can_read_brain`/`can_write_brain`; no proposal-specific main DDL is assumed.
- Source file content is opened only through the existing project files route and
  viewer, so Brain source APIs expose metadata and pointers, not blob content.

## Logical-Holes Pass

- A Brain-disabled project fails closed at route/service/tool execution time
  even when MCP tools stay statically listed. SQLite is no longer a supported
  project/runtime state: non-Postgres DB configuration fails at boot before
  this guard runs.
- Concurrent retain/reindex paths use immutable embedding generations and exact
  one-of item/chunk embedding constraints in `0003`.
- B has no write-back surface; all canonical mutation flows enter C proposals,
  authored catalog drafts, or board tasks.
- Serena cannot be executable by default under current projection semantics
  because the seed is disabled until explicit trust/enabling work occurs.

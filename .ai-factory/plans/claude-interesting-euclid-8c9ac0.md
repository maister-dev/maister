# Plan — Project Brain, Sub-project A (Foundation)

**Branch:** `claude/interesting-euclid-8c9ac0` (existing isolated worktree — no new branch)
**Created:** 2026-07-01 · **Refined:** 2026-07-02 (/aif-improve pass — seams re-verified in code, owner Q1–Q5 resolved)
**Spec (SSOT):** [`docs/plans/2026-07-01-project-brain-architecture.md`](../../docs/plans/2026-07-01-project-brain-architecture.md) — locked decisions D1–D10, data model §4, pipelines §5, deps §7, JTBD §12, Expectations §13, Acceptance §14. **Spec amended 2026-07-02** in the same pass: §4 embeddings (untyped vector + per-generation HNSW expression indexes), §4 snapshots (consumption-time, nullable `run_id` + actor + trigger), §9 (chunkers → B), §11 (all open items resolved).
**ADR:** ADR-122 (reserved at main HEAD; max is 121 — verified `git show main:docs/decisions.md`)
**Migrations:** main lineage `0088` (ALL shared-table ALTERs, see T1.2) + **new brain lineage** `web/lib/db/brain-migrations/0001` (`brain_*` + pgvector, own `_journal.json` + own ledger table `__drizzle_brain_migrations`). Renumber-check the single main `0088` at merge (worktree journal is at `0086_yellow_pyro`; main is at `0087_shocking_epoch` — 0088 is correct vs main HEAD).

## Settings

- **Testing:** yes — strict TDD, **RED → GREEN → refactor** on every code task.
- **Logging:** verbose (DEBUG on write/recall/harvest/decay paths; never log secret values).
- **Docs:** yes — mandatory checkpoint; system-analytics + ERD + OpenAPI are **Phase-0 deliverables**, not trailing sync.
- **Roadmap linkage:** none. Rationale: Project Brain is a new multi-sub-project epic (E3/project-memory) with no existing ROADMAP milestone; add via `/aif-roadmap` (owner command), then link. `/aif-verify --strict` should WARN, not fail, on missing linkage alone.

## Research Context (Active Summary)

Build-thin on existing Postgres 16 + pgvector (not Hindsight/GBrain). Brain = bounded context (`brain_*` prefix, `web/lib/brain/*` module). Sub-project A = **owned-tier** only: `lesson`/`observation`/`state_fact`, harvested from `domain_events`, auto-write + decay, recall via hybrid ranker (no LLM at read) + MCP tool (explicit) + P7 run-context (ambient, **flow runs only** — `writeRunContext` is called only from `runner-graph.ts`; agent/scratch runs use the explicit MCP tools). Indexed/consultant tier, typed chunkers, and the self-improvement proposal bridge are **Sub-projects B/C**.

### Scope decisions locked into this plan (owner-approved 2026-07-02)

1. **Two migration lineages, two ledger tables.** Shared-table ALTERs → **main** `0088`. `brain_*` CREATEs + `CREATE EXTENSION vector` → **separate brain lineage** `web/lib/db/brain-migrations/0001` (own `_journal.json`). The brain lineage MUST use its own drizzle ledger table (`migrationsTable: "__drizzle_brain_migrations"`) — `web/lib/db/migrate.ts` hardcodes `./lib/db/migrations` and both lineages would otherwise share `drizzle.__drizzle_migrations`, corrupting migration accounting. Brain lineage is **hand-authored SQL only** (no `db:generate:brain` — a second drizzle-kit generate target re-opens the snapshot-drift gotcha); `web/lib/brain/schema.ts` exists for runtime types only. Migrate order fixed: **main → brain** (`brain_*` FK → `projects`/`runs`). Brain lineage provisioned only on Postgres; skipped under SQLite (D3). Boot guard: extend `web/lib/db/check-migrations.ts` to also compare the brain journal vs `__drizzle_brain_migrations` when the dialect is pg and the brain lineage is provisioned.
2. **Chunkers deferred to Sub-project B** (spec §9 amended accordingly). A's owned items are short text embedded directly; oversize content (rare) uses one minimal recursive splitter (`@chonkiejs/core` `RecursiveChunker` — the maintained chonkie TS package; the only A dependency on it). A tables drop `brain_chunks`/`brain_sources`/`brain_edges`/`brain_proposals` → B/C.
3. **A tables:** `brain_items`, `brain_embeddings` (`item_id` FK; `chunk_id` added in B), `brain_snapshots`, `brain_index_jobs`.
4. **Embedding default + dimension strategy (Q1):** default `text-embedding-3-small` @ **1536** (`openai_compatible`). `brain_embeddings.vector` is **dimension-untyped**; HNSW rides **per-generation expression indexes** — `CREATE INDEX … USING hnsw ((vector::vector(N)) vector_cosine_ops) WHERE embedding_model = M AND embedding_dimensions = N` — created by an `ensureEmbeddingIndex(model, N)` step at configure/reindex time (controlled DDL, deterministic index name `brain_embeddings_hnsw_<modelslug>_<N>`). Runtime model **and dimension** switches are supported: new generation + new index, old rows intact, **no schema migration ever** (owner requirement).
5. **Distillation (Q2)** = a new `openai_compatible` **completion** client (symmetric with the embedding client; shared HTTP module) using nullable `platform_runtime_settings.distill_model` on the same `embedding_base_url`. **Enable-gate**: PATCH `projects.brain_enabled=true` refuses `CONFIG` unless platform embedding config AND `distill_model` are set — harvest never runs unconfigured by construction. If distill config is cleared while projects are enabled, harvest treats it as **transient** (throw, cursor holds, retry next tick) — missing config NEVER skip-and-advances (that would silently lose events forever).
6. **Snapshot semantics:** launch persists only the *decision* (`runs.brain_context boolean` nullable — null = inherit flow/agent config); `brain_snapshots` rows are written **at consumption** — ambient inject at run-context build (`trigger='ambient'`, `run_id`+`node_attempt_id`) and explicit recall (`trigger='explicit'`, `run_id` nullable — set from the agent-run token when run-bound, else actor-only). No embedding HTTP call ever runs inside the launch transaction.
7. **Policy constants (Q3):** τ=0.85 (dedup cosine), confidence₀=0.3, TTL=30d, reinforce = +0.1 confidence / push `expires_at` +30d, ambient K=5 — named constants in `web/lib/brain/policy.ts`, marked tune-on-real-runs. Not env, not DB, in A.
8. **Memory scopes (Q5) + write axis:** `memory:read`/`memory:write` are added to the M34 `AGENT_TOKEN_SCOPES` fixed set now (one-line in `web/types/token-scopes.ts`); actual access still gated by `projects.brain_enabled` + per-agent-link booleans: `agent_project_links.can_read_brain` gates recall, **`can_write_brain` gates retain** (separate axis — scope alone must not open `memory_retain` to every agent token; memory-poisoning guard). Both default `false`; agent-retained items additionally start at confidence₀ 0.3 + TTL (decay is the second poisoning valve). `can_propose_brain` = Sub-project C.
9. **pgvector stays out of the main lineage (test-infra invariant):** main `0088` is shared-table ALTERs ONLY — no `CREATE EXTENSION`, no `vector` type. Every existing integration test on `postgres:16-alpine` keeps passing unchanged; only brain tests (via the T1.4 helper) require `pgvector/pgvector:pg16`.

### Global conventions (every code task)

- **TDD:** failing test first (name the vitest project + confirm the glob matches), implement to green, then refactor. Per-phase exit: `pnpm test:unit && pnpm test:integration` green.
- **Integration tests** are `*.integration.test.ts` under `web/lib/brain/__tests__/` — matched by the existing `lib/**/*.integration.test.ts` glob in `web/vitest.workspace.ts` (verified). They spin **`pgvector/pgvector:pg16`** (NOT `postgres:16-alpine` — `CREATE EXTENSION vector` requires it), migrating **both** lineages via a brain-aware helper. Unit tests are `*.test.ts`.
- `MaisterError` with `code` (never plain `Error`); the new `EMBEDDING_UNAVAILABLE` code lands in **both** `web/lib/errors-core.ts` (union, client-safe) and re-exports via `web/lib/errors.ts`. `atomicWriteJson` for `.maister/` writes; **no `fs.watch`/polling**; strict TS, no `any`; secrets as `env:NAME` (mirror `web/lib/mcp/projection.ts` `stripEnvPrefix`/`refsToMap`), server-only.
- **`projectId` is always server-derived** (from the token/session), never a body field.
- Each task lists the spec Expectation (E-n, §13, numbered top-to-bottom) / Acceptance (AC-A-n, §14) it satisfies. T0.2 pins the E-n numbering in the analytics doc so citations stay unambiguous.

---

## Phase 0 — Analytics & Contracts (SDD, docs-first — BLOCKING; complete + internally consistent before any code phase)

**T0.1 — Reserve ADR-122 + migration numbers.**
- Files: `docs/decisions.md` (write `### ADR-122 — Project Brain (per-project memory substrate)` — full ADR: context, decision D1–D10 summary incl. the per-generation expression-index strategy and two-ledger migration lineages, consequences); note main `0088` + brain-lineage `0001` reservations in the ADR.
- Traces: governance (skill-context: allocate ADR+migration up front).
- Acceptance: ADR-122 header exists at HEAD; `scripts/validate-docs-adr-anchors.mjs` green; any `[ADR-122]` citation resolves.

**T0.2 — System-analytics doc.**
- Files: new `docs/system-analytics/project-brain.md` (R5 order): Purpose · Domain entities · **State machine** (`stateDiagram-v2`: item lifecycle `active → reinforced → expired|superseded`; embedding generation immutable + active-generation pointer; `brain_index_jobs` states; snapshot-at-consumption) · **Process flows** (`sequenceDiagram`/`flowchart`: harvest→distill→retain; retain dedup-or-reinforce incl. advisory-lock serialization; recall hybrid incl. active-generation vector leg + lexical fallback; decay sweep; ambient inject; reindex-on-switch incl. dimension change) · **Expectations** (the A-subset of spec §13 with pinned E-n numbering, ≤12 testable bullets) · **Edge cases** → `MaisterError` (`EMBEDDING_UNAVAILABLE`, `CONFIG`, `PRECONDITION`, `CONFLICT`) — incl. the harvest failure rule: **transient** failures (`EMBEDDING_UNAVAILABLE`, network, `CONFIG` distill-unset — config can be restored, cursor must hold) **throw-and-retry**; **permanent** failures (schema-invalid distill output after one in-process retry) **log + skip-and-advance** (dispatcher cursor semantics); plus the harvest predicate: `RUN_TERMINAL_EVENT_KINDS` + `gate.failed` only — `run.review` excluded (different payload, orchestrator child-settled signal, duplicates the eventual terminal) · Linked artifacts. R6 tags: A pieces `(Designed)` here, flipped `(Implemented)` in T6.2; B/C pieces `(Phase 2)`. Add glossary row in `docs/CLAUDE.md` + component row in `docs/architecture.md` (`web/lib/brain/*`).
- Traces: E-1,2,3,4,6,7,8,10,11,12.
- Acceptance: every state transition + refusal enumerated **as code will gate** (allow-list form); `pnpm validate:docs` green.

**T0.3 — ERD (both artifacts).**
- Files: new `docs/db/brain-domain.md` (`erDiagram` for `brain_items`/`brain_embeddings`/`brain_snapshots`/`brain_index_jobs` + `platform_runtime_settings` new cols + `projects.brain_enabled` + `agent_project_links.can_read_brain`/`can_write_brain` + `runs.brain_context`; Keys/constraints incl. partial UNIQUEs; Indexes [per-generation HNSW expression indexes `vector_cosine_ops`, GIN `tsvector`, btree `(project_id,status,expires_at)`]; Cascade chain [all `brain_*` FK `project_id` `ON DELETE CASCADE`]; Retention [immutable embeddings + decay]; Linked artifacts) + update `docs/db/erd.md` (consolidated) + `docs/database-schema.md` (narrative). Add `docs/db/brain-domain.md` row to `docs/CLAUDE.md` glossary.
- Traces: E-1,2,12.
- Acceptance: both consolidated + domain ERDs updated (not one); `validate:docs` green.

**T0.4 — API + tool contracts.**
- Files: **`docs/api/external/operations.openapi.yaml`** (NOT web.openapi.yaml — verified: ext routes live here) — ext routes `GET /api/v1/ext/projects/{slug}/memory` (recall: `q`,`limit`,`kinds`,`minConfidence`) + `POST` (retain: `content`,`kind`,`tags`); scopes `memory:read`/`memory:write` under the existing `projectToken` security scheme; responses incl. `422 CONFIG`, `409 CONFLICT`, `503 EMBEDDING_UNAVAILABLE` (requires the new `httpStatusForExtCode` arm — T4.2), `404` project-slug-mismatch, `403` missing scope OR agent link lacking `can_read_brain`/`can_write_brain`; example payloads. **`docs/api/web.openapi.yaml`** — admin `GET/PATCH /api/admin/brain-settings`; project settings PATCH gains `brainEnabled`. `memory_recall`/`memory_retain` MCP tool specs (name·description·inputSchema) documented in `docs/system-analytics/external-operations.md` (the MCP-facade doc), matching the `mcp/src/tools.ts` `TOOL_SPECS`/`resolveRouting` pattern. Contract note: scope wiring touches `web/types/token-scopes.ts` + `PROJECT_ACTION_BY_SCOPE` (`web/lib/tokens/ext-handler.ts`) + `PROJECT_ACTION_MIN` (`web/lib/authz.ts`) — implemented in T4.2, enumerated here as contract surface.
- Traces: E-1,6,10; AC-A-4,7; skill-context (trace every contract surface; identifiers labelled — `slug`=url-param, `projectId`=server-state, body carries **no** project id).
- Acceptance: `npx @redocly/cli lint` zero errors on both touched specs; each route has an identifiers sub-bullet in the ADR/plan.

**T0.5 — Error taxonomy.**
- Files: `docs/error-taxonomy.md` — add `EMBEDDING_UNAVAILABLE` (HTTP 503, UI action "retry / check embedding provider"). Only new code; validation reuses `CONFIG`/`PRECONDITION`/`CONFLICT`.
- Acceptance: code + mapping documented.

**T0.6 — Config + deployment docs.**
- Files: `docs/configuration.md` env-vars table (`EMBEDDING_API_KEY` name-only example; note the value is referenced as `env:EMBEDDING_API_KEY`), `.env.example` (repo root — verified location; add the key), `docs/getting-started.md` + `docs/deployment.md` (Postgres image must be **pgvector-enabled** `pgvector/pgvector:pg16`; note the dev-volume swap from `postgres:16-alpine` is data-compatible — same PG16 data dir; brain lineage migrate step + conditional provisioning; runtime model/dimension switch = reindex, no migration).
- Traces: E-10; skill-context (deployment touchpoints).
- Acceptance: env table + `.env.example` carry the key name; deployment docs state the pgvector image + `db:migrate:brain` step.

**Phase 0 EXIT + COMMIT:** analytics complete + internally consistent; `validate:docs` + `validate-docs-adr-anchors.mjs` + redocly lint green. Commit: `docs(brain): ADR-122 + analytics/ERD/contracts (Sub-project A)`.

---

## Phase 1 — DB foundation: two lineages + pgvector (TDD, real-PG)

> Unblocked: embedding default fixed (Q1 = `text-embedding-3-small`@1536) and the untyped-vector strategy removes the dimension hard-block entirely.

**T1.1 — Brain-lineage tooling (own ledger, hand-authored SQL).**
- Deliverable: `web/lib/db/migrate-brain.ts` (or parameterize `migrate.ts` — pick the smaller diff) running the brain folder with drizzle `migrationsTable: "__drizzle_brain_migrations"`; `db:migrate:brain` script in `web/package.json`; chain prod `db:migrate` = main → brain (brain step no-ops under SQLite). **No `db:generate:brain`** — brain lineage is hand-authored SQL + hand-maintained `_journal.json` only. `web/lib/brain/schema.ts` with a `customType` untyped `vector` (pattern: the existing `xid8` customType in `web/lib/db/schema.ts`) for runtime typing. Extend the boot guard `web/lib/db/check-migrations.ts` (`findPendingMigrations` + `instrumentation.ts` call) to also compare the brain journal vs `__drizzle_brain_migrations` when dialect = pg.
- Files: `web/lib/db/migrate-brain.ts`, `web/lib/db/check-migrations.ts`, `web/package.json`, `web/lib/brain/schema.ts`.
- Test (unit): boot guard flags a pending brain migration; skips brain check under `DB_URL=file:`.
- Acceptance: `pnpm db:migrate:brain` runs the brain journal into its own ledger table; main ledger untouched; typecheck green.

**T1.2 — Main-lineage ALTER migration `0088` (ALL shared-table ALTERs, one migration).**
- Deliverable: `platform_runtime_settings` += `embedding_base_url`, `embedding_model`, `embedding_dimensions`, `embedding_api_key_ref`, `distill_model` (all nullable); `projects` += `brain_enabled boolean not null default false`; `agent_project_links` += `can_read_brain boolean not null default false`, `can_write_brain boolean not null default false`; `runs` += `brain_context boolean` (nullable — null = inherit flow/agent config; the persisted launch-time decision, per skill-context "persist what the consuming path reads"; NOTE: `runs.runner_snapshot` no longer exists — M42 moved runner state to `run_sessions`, so a dedicated column is required). Drizzle schema.ts edits → `pnpm db:generate` → migration `0088`.
- Files: `web/lib/db/schema.ts`, `web/lib/db/migrations/0088_*.sql`.
- Test: none standalone — column presence/defaults asserted inside T1.3's integration test (same container, no trivial-test duplication).
- Traces: E-11 groundwork; AC-A-6.
- Acceptance: main migrate green; renumber-check `0088` vs main `_journal` at merge (T6.3).

**T1.3 — Brain-lineage migration `0001` (hand-authored) + `ensureEmbeddingIndex`.**
- Deliverable: `CREATE EXTENSION IF NOT EXISTS vector;` + tables: `brain_items` (`id, project_id FK cascade, kind, tier, title, content, status, confidence, reinforcement_count, last_reinforced_at, expires_at, content_hash,` **provenance:** `source_run_id?, source_node_attempt_id?, source_domain_event_id?, source_gate_kind?,` `created_at, updated_at`, generated `tsv tsvector`), `brain_embeddings` (`id, item_id FK cascade, split_ordinal, vector` **(untyped `vector`)**`, embedding_provider, embedding_model, embedding_dimensions, embedding_version, source_hash, content_hash, embedded_at` — **immutable**; N rows/item across generations × splits), `brain_snapshots` (`id, run_id? FK, node_attempt_id?, actor_type, actor_id, trigger('ambient'|'explicit'), query, query_hash, embedding_model, returned_items jsonb ([{itemId, score}] — ids AND scores, auditable ranking), ranker_version, created_at`), `brain_index_jobs` (`id, project_id FK, reason, status, progress, resumable_cursor, created_at`). Static indexes in the migration: GIN on `brain_items.tsv`, btree `(project_id, status, expires_at)`, **partial UNIQUE `(project_id, source_domain_event_id) WHERE source_domain_event_id IS NOT NULL`** (harvest at-least-once idempotency at the DB), **partial UNIQUE `(project_id, content_hash) WHERE status = 'active'`** (exact-dup race guard at the DB). **HNSW is NOT in the migration**: `web/lib/brain/embedding-index.ts` `ensureEmbeddingIndex(model, N)` creates the per-generation expression index `brain_embeddings_hnsw_<modelslug>_<N>` = `USING hnsw ((vector::vector(N)) vector_cosine_ops) WHERE embedding_model = $M AND embedding_dimensions = $N` — invoked from brain-settings configure (T5.1) and reindex (T5.5). **Pattern verified against the pgvector README FAQ** (untyped column + expression HNSW with cast + partial WHERE; queries must repeat the exact cast) and drizzle-orm's `migrationsTable` option verified in the pinned version — no residual library risk.
- Files: `web/lib/db/brain-migrations/0001_*.sql`, `web/lib/db/brain-migrations/meta/_journal.json`, `web/lib/brain/schema.ts`, `web/lib/brain/embedding-index.ts`.
- Test (integration): brain-aware helper (`pgvector/pgvector:pg16`, migrate main→brain) — 0088 columns exist with defaults (folded from T1.2); insert item + embedding; `ensureEmbeddingIndex('text-embedding-3-small', 1536)` → `pg_indexes` shows the expression HNSW + GIN + both partial UNIQUEs; cosine query through the cast returns; second `ensureEmbeddingIndex` call is idempotent; deleting a `projects` row cascades `brain_*`.
- Traces: E-1,2,12.
- Acceptance: brain migrate green on pgvector image; all indexes present.

**T1.4 — Brain-aware test helper + dialect guard.**
- Deliverable: `web/lib/brain/__tests__/helpers.ts` — starts `pgvector/pgvector:pg16`, runs both lineages (via T1.1 runners), calls `ensureEmbeddingIndex` for the test default. Brain **disabled under SQLite** (D3): `isBrainProvisioned(db)` guard in `web/lib/brain/guard.ts` (hook: the dialect decision in `web/lib/db/client.ts` `buildClient`); brain service entrypoints no-op/throw `PRECONDITION` when dialect ≠ pg.
- Files: `web/lib/brain/__tests__/helpers.ts`, `web/lib/brain/guard.ts`.
- Test: unit — guard returns false under `DB_URL=file:`; brain ops throw `PRECONDITION`.
- Traces: E-11; AC-A-6.
- Acceptance: guard covered; helper reused by later phases.

**COMMIT:** `feat(brain): two-lineage migrations + pgvector schema (ADR-122)`.

---

## Phase 2 — Embedding registry + retain/dedup (TDD)

**T2.1 — openai-compatible client (embed + complete).**
- Deliverable: `web/lib/brain/openai-compatible.ts` — `embed(texts)` (POST `{embedding_base_url}/embeddings`, model = `embedding_model`) + `complete(prompt, schema)` (POST `{embedding_base_url}/chat/completions`, model = `distill_model`; `distill_model` unset → `CONFIG`); config from `platform_runtime_settings`; key resolved `process.env[stripEnvPrefix(embedding_api_key_ref)]`; **bounded retry** on timeout/429/5xx (2 retries, exponential backoff, structured redacted `warn` per attempt — never the key, never the payload), then throws `EMBEDDING_UNAVAILABLE`. Records provider/model/dimensions/version. Add `EMBEDDING_UNAVAILABLE` to `web/lib/errors-core.ts` union (+ `errors.ts` re-export).
- Test (unit, mocked fetch): returns vector; transient 5xx then success → retried, no error; `EMBEDDING_UNAVAILABLE` after retries exhausted; **secret never appears in logs/thrown message**; returned-vector dimension mismatch vs configured `embedding_dimensions` → `CONFIG`; `complete` without `distill_model` → `CONFIG`.
- Traces: E-2,10; new code `EMBEDDING_UNAVAILABLE`.
- Acceptance: RED (no client) → GREEN.

**T2.2 — retain service (atomic dedup-or-reinforce, race-safe).**
- Deliverable: `web/lib/brain/retain.ts` — `retain(projectId, item, provenance)`: **oversize guard** (content > embedding-model token limit → split with the minimal recursive splitter into ordered segments, one `brain_embeddings` row per `split_ordinal`; short content = single embedding) → embed (outside the tx) → within **one `db.transaction`**: take `pg_advisory_xact_lock(hashtextextended(project_id, 0))` (serializes concurrent retains per project — the harvest consumer is lease-serialized but MCP `memory_retain` can race it) → if cosine-sim > τ (`policy.ts`) to an active item, **reinforce** (confidence +0.1, `reinforcement_count`++, push `expires_at` +30d) else insert (confidence₀ 0.3 + TTL 30d) + write embedding generation(s). `content_hash` exact-dup → idempotent no-op (belt: the partial UNIQUE from T1.3 makes the race a `CONFLICT`-mapped constraint, not a duplicate). All persistent writes atomic (skill-context: atomic multi-store).
- Test (integration, real pgvector): two near lessons → **one row reinforced, no duplicate**; identical content twice → idempotent; **two concurrent retains of the same content → exactly one active row** (race test); a re-embed writes a **new** `brain_embeddings` row, never mutates the old (E-2).
- Traces: E-2,3; AC-A-2.
- Acceptance: RED → GREEN → refactor.

**T2.3 — RecallRanker seam.**
- Deliverable: `web/lib/brain/recall-ranker.ts` — `RecallRanker` interface (DIP) + default pgvector impl stub (full impl in **T4.1**). Injectable (SOLID).
- Test (unit): interface contract; default impl selected by config.
- Traces: D9.
- Acceptance: interface defined + injectable.

**COMMIT:** `feat(brain): embedding registry + atomic retain dedup-or-reinforce`.

---

## Phase 3 — Harvest + distillation + decay (TDD)

**T3.1 — Distillation.**
- Deliverable: `web/lib/brain/distill.ts` — build prompt from **concrete sources** (event payloads carry only ids + reason — verified): run-terminal payload (`runId`,`taskId`,`flowId`,`runKind`,`reason`) / gate payload (`gateId`,`gateKind`,`blocking`,`nodeAttemptId`) + fetched `review_comments` (by `runId`), `node_attempts` rework chain (`reworkFromNode`), task title + prompt. Do **NOT** depend on `runs.summary` — the column exists but is unpopulated (known P0 gap). → `openaiCompatible.complete(prompt, lessonSchema)` → validate with `validateStructuredOutput` (`web/lib/flows/output-schema.ts`, verified signature `(value, schema) → {ok}|{ok:false,message}`). Invalid shape → reject, **no write**.
- Test (unit, mocked complete): valid `{content,kind,tags}` returned; malformed → rejected, retain not called; prompt assembles review-comment + rework inputs.
- Traces: E-4 (confidence₀ set here via policy); structured-output discipline.
- Acceptance: RED → GREEN.

**T3.2 — Harvest consumer.**
- Deliverable: `web/lib/domain-events/memory-harvest.ts` (`DomainEventConsumer`, `startFrom: "now"`, idempotent) registered in the `DOMAIN_EVENT_CONSUMERS` array (`web/lib/domain-events/consumers.ts`; `noopConsumer` is the shape reference). Consumes an **explicit harvest predicate** over `(kind, payload)`: `RUN_TERMINAL_EVENT_KINDS` + `gate.failed` (both exist in `taxonomy.ts` — no taxonomy change). **NOT `RUN_SETTLED_EVENT_KINDS`** — that set includes `run.review` (orchestrator child-settled signal, different payload shape, would double-harvest with the child's eventual terminal event). The predicate documents per kind which `DomainEventRow` payload fields it reads (terminal: `runId`/`taskId`/`flowId`/`runKind`/`reason`; gate: `gateId`/`gateKind`/`blocking`/`nodeAttemptId`). **Guarded by `projects.brain_enabled`** (disabled → skip+advance, intentional non-consumption); per-event idempotency via `source_domain_event_id` (+ the T1.3 partial UNIQUE). **Failure semantics (dispatcher is at-least-once; cursor does NOT advance on throw — verified):** transient errors (`EMBEDDING_UNAVAILABLE`, network, **`CONFIG` distill-unset** — restorable config, cursor holds so no event is lost; unreachable in steady state given the T5.2 enable-gate) → **throw** (retry next tick); permanent errors (schema-invalid distill output, after one in-process retry) → **log + skip event** (advance) — no poison-pill loop. Calls distill → retain with provenance FKs (`source_run_id`, `source_domain_event_id`, `source_gate_kind?`).
- Test (integration): `run.done`-with-rework event → `lesson` with provenance FKs; **re-delivery → no duplicate** (idempotency); `run.review` event → NOT harvested; `brain_enabled=false` → no write, cursor advances; `distill_model` unset (cleared post-enable) → **throw, cursor NOT advanced**, no write; invalid distill output twice → skipped, cursor advances; transient embed failure → cursor NOT advanced.
- Traces: E-4; AC-A-1.
- Acceptance: RED → GREEN.

**T3.3 — Decay sweep (time-based, throttled).**
- Deliverable: `web/lib/brain/decay.ts` `runBrainDecaySweep()` folded into `runSystemSweep()` (`web/lib/scheduler/system-sweeps.ts`, `try/catch`→summary, like cost-reconcile — verified pattern + `SystemSweepSummary` extension). The system tick is **60 s** (verified `DEFAULT_SYSTEM_SWEEP_CADENCE_SECONDS`): the sweep self-throttles via a last-run stamp to **hourly**, and confidence aging is computed from **elapsed time** (never per-tick decrements). Expire items past `expires_at`; expired excluded from recall.
- Test (integration): item past `expires_at`, no reinforce → `status='expired'`, absent from recall; aging is elapsed-time-proportional (two sweeps close together ≠ double-age); sweep error swallowed into summary (not thrown).
- Traces: E-4; AC-A-3.
- Acceptance: RED → GREEN.

**COMMIT:** `feat(brain): harvest consumer + distillation + decay sweep`.

---

## Phase 4 — Recall + MCP tools + ambient (TDD)

**T4.1 — Hybrid recall + default ranker.**
- Deliverable: `web/lib/brain/recall.ts` + default `RecallRanker`: hybrid rank — **vector leg** = cosine over the **active generation only** (`WHERE embedding_model = active AND embedding_dimensions = active_N`, cast `vector::vector(N)` matching the T1.3 expression index so HNSW is used) + **lexical leg** = `tsvector` rank (also covers items not yet re-embedded mid-reindex) + recency/confidence boost; **no LLM at read**; project-scoped; excludes expired/other-project; de-dupes multi-split items to one hit (best-scoring segment). (Splitting happens at retain/embed time — T2.2 — not here.)
- Test (integration): returns only the project's active items, ranked; **no completion/LLM call at read** (spy asserts only the query-embedding call, ranking is SQL); **cross-project isolation** — a query bound to project X never returns Y (E-1); stale-generation embeddings are ignored by the vector leg; index-usage assertion runs under `SET LOCAL enable_seqscan = off` (`EXPLAIN` shows the expression HNSW index — deterministic on small test datasets, where the planner would otherwise seq-scan).
- Traces: E-1,6; AC-A-4,7.
- Acceptance: RED → GREEN → refactor.

**T4.2 — MCP tools + ext routes + scope wiring.**
- Deliverable: `memory_recall`/`memory_retain` in `mcp/src/tools.ts` (`TOOL_SPECS` + `resolveRouting`) → ext routes `web/app/api/v1/ext/projects/[slug]/memory/route.ts` wrapping **`handleExt`** (`web/lib/tokens/ext-handler.ts`) with scopes `memory:read`/`memory:write`; **`projectId` server-derived** (token row + slug cross-check → 404 on mismatch, verified handleExt behavior). Scope wiring (FOUR touchpoints, verified): `web/types/token-scopes.ts` (scope defs + one-line `AGENT_TOKEN_SCOPES` addition per Q5), `PROJECT_ACTION_BY_SCOPE` in `ext-handler.ts`, `PROJECT_ACTION_MIN` in `web/lib/authz.ts`, **and a `case "EMBEDDING_UNAVAILABLE": return 503` arm in `httpStatusForExtCode` (`ext-handler.ts`)** — without it the code falls to the `default: 500` and the T0.4 contract lies. Route work enforces `projects.brain_enabled` + (for agent tokens) `agent_project_links.can_read_brain` for recall / **`can_write_brain` for retain** (scope alone never suffices — Q5/write-axis), and writes a `brain_snapshots` row per recall: `trigger='explicit'`, `run_id` = the agent-run token's run when run-bound else NULL, `actor_type`/`actor_id` always set, `query_hash`/`embedding_model`/`returned_items` scores included.
- Test (integration): recall via ext returns ranked items **and writes a `brain_snapshots` row** (run-bound and non-run-bound variants); retain writes an item; **cross-project token → 404** (body carries no project id — skill-context server-derived-identifier rule); missing scope → 403; `can_read_brain=false` agent token → recall denied; `can_write_brain=false` agent token → retain denied (read alone does not grant write); embedding outage during retain → HTTP 503 with `code: EMBEDDING_UNAVAILABLE`; SQLite dialect → tools stay listed (static `TOOL_SPECS`) but the call fails closed with `PRECONDITION`.
- Traces: E-12; AC-A-4,7; skill-context (body-controlled identifiers).
- Acceptance: RED → GREEN.

**T4.3 — Ambient via P7 (flow runs).**
- Deliverable: extend `RunContextFile` in `web/lib/flows/graph/run-context.ts` with a `brain` field. **Purity contract (verified: `buildRunContext` is documented PURE, no I/O):** recall is computed in **`runner-graph.ts`** (which has db + policy) and the ready brain projection is passed INTO `writeRunContext` as an optional arg → `buildRunContext` receives it as plain data — `buildRunContext` stays pure, no recall/embedding call inside it. **Ambient query = task title + prompt (+ current node id)**; the query embedding is **memoized per runner process, keyed by `hash(query + embedding_model + embedding_dimensions)`** (run-context is rewritten per node attempt — verified — so recall must not re-embed every node; model in the key so a mid-run settings switch never serves a stale-generation vector). Enablement: `runs.brain_context` (launch decision, T5.3) ?? flow/agent config (explicit default, opt-in ambient). Each inject writes a `brain_snapshots` row (`trigger='ambient'`, `run_id`+`node_attempt_id`). Scope note: `writeRunContext` is called only from `runner-graph.ts` (flow runs) — agent/scratch runs are explicitly out of ambient scope in A (they use the MCP tools).
- Test (integration): ambient-enabled → `run.json` contains `brain` top-K AND a snapshot row per inject; disabled → absent; write stays git-excluded (existing `isRunContextWriteSafe` guard).
- Traces: AC-A-5; E-12.
- Acceptance: RED → GREEN.

**COMMIT:** `feat(brain): hybrid recall + memory MCP tools + P7 ambient`.

---

## Phase 5 — 4-layer enablement + settings + snapshots (TDD)

**T5.1 — Platform embedding config.**
- Deliverable: `web/app/api/admin/brain-settings/route.ts` (`GET/PATCH`, `requireGlobalRole("admin")`, zod `.strict()`, key stored as `env:NAME` name-only) mirroring `webhook-settings` (verified pattern: singleton `platform_runtime_settings` row). Fields: `embeddingBaseUrl`, `embeddingModel`, `embeddingDimensions`, `embeddingApiKeyRef`, `distillModel`. On model/dimension change: call `ensureEmbeddingIndex(newModel, newN)` + enqueue a `brain_index_jobs` reindex row (worker = T5.5).
- Test (integration): PATCH sets config; **SET/CLEAR/re-SET round-trip** (clear → null default; re-set → value) — skill-context config-state symmetry; stored value is the name, never the secret; model change enqueues a reindex job + creates the new expression index.
- Traces: E-10; D4.
- Acceptance: RED → GREEN.

**T5.2 — Project `brainEnabled` (with enable-gate).**
- Deliverable: extend `web/app/api/projects/[slug]/settings/route.ts` PATCH schema + update (`deliveryPolicyDefault` precedent, verified: zod `.strict()` + `requireProjectAction(project.id, "editSettings")`). **Enable-gate (scope decision 5):** setting `brainEnabled=true` refuses `CONFIG` (422) unless `platform_runtime_settings` has embedding config AND `distill_model` set — a project can never be enabled into an unharvest-able state.
- Test (integration): enable/disable; enable with distill/embedding unset → `CONFIG`, not persisted; disabled project → harvest + recall no-op.
- Traces: AC-A-6 (project axis).
- Acceptance: RED → GREEN.

**T5.3 — Agent-link + run-launch axes (columns land in 0088).**
- Deliverable: wire `agent_project_links.can_read_brain` + `can_write_brain` (columns from T1.2/0088; `can_propose_brain` = Sub-project C) into agent-link settings + the T4.2 route guards (read gates recall, write gates retain); run-launch "include brain context" option → persist `runs.brain_context` at launch (`web/lib/agents/launch.ts` — inside its existing launch transaction, verified; + the flow-run launch path in `web/lib/services/runs.ts`) — **the launch persists only the boolean decision; NO recall/embedding call and NO snapshot insert happens at launch** (snapshots are consumption-time: T4.2/T4.3).
- Test (integration): launch with brain-context option → `runs.brain_context` persisted; ambient path then honors it (null = inherit); agent without `can_read_brain` → recall denied (403 at the route work).
- Traces: AC-A-4/6 (agent + run axes); skill-context: persist the launch-time decision the consuming path reads.
- Acceptance: RED → GREEN.

**T5.4 — Settings UI (minimal, i18n).**
- Deliverable: admin brain-settings panel (next to `WebhooksPanel`/`AcpRunnersPanel` on `/settings`) + project settings `brainEnabled` toggle (HeroUI; icon affordances; success = green check). Add EN + RU strings to `web/messages/en.json` + `web/messages/ru.json` (both mandatory).
- Test (unit): `renderToStaticMarkup` string-match (no jsdom; precedent `settings/__tests__/page-contract.test.ts`).
- Acceptance: renders expected controls; a11y label present; both message catalogs updated.

**T5.5 — Reindex worker (closes `brain_index_jobs`; D4/E-2; dimension change SUPPORTED).**
- Deliverable: `web/lib/brain/reindex.ts` — sweep-driven worker (hook in `runSystemSweep()`) consuming `brain_index_jobs`: re-embeds active items into a **new `embedding_version` generation** with the new model/dimensions (never mutates old rows), resumable via `resumable_cursor`. **Dimension change is a first-class path** (owner Q1): `ensureEmbeddingIndex(model, N)` already created the new expression index (T5.1); old-generation rows + old index stay intact (immutable; index GC is out of A). Recall (T4.1) follows the active settings automatically — mid-reindex, un-re-embedded items are covered by the lexical leg.
- Test (integration): model switch (same N) → new-generation embeddings for all active items, old rows intact (E-2); recall vector leg then uses only the new generation; **dimension switch (1536→768)** → new expression index exists, new generation written, old rows untouched, recall works; job resumes from `resumable_cursor` after a simulated interrupt.
- Traces: E-2,8 (resumable jobs); D4.
- Acceptance: RED → GREEN; no orphaned table; no `CONFIG` refusal on dimension change (removed by design).

**COMMIT:** `feat(brain): enablement + settings + snapshots + reindex`.

---

## Phase 6 — Deployment wiring + docs as-built + renumber pass

**T6.1 — Deployment wiring.**
- Deliverable: Postgres image → `pgvector/pgvector:pg16` in `compose.yml` (+ `compose.production.yml`; no override file exists — verified); note in the diff/commit that the dev volume is data-compatible (same PG16 data dir). The embedding key name added to the **web service `environment:` block** in compose (value from host env) + `.env.example` (repo root). `db:migrate:brain` in the migrate/entrypoint chain. New dep (`@chonkiejs/core`, oversize splitter only) in `web/package.json` + root `pnpm-lock.yaml`.
- Traces: skill-context (deployment touchpoints — every new env var/image/dep lands in a deploy artifact).
- Acceptance: compose uses pgvector image (matches the test-container image); `.env.example` carries the key; lockfile updated.

**T6.2 — Docs as-built checkpoint (`/aif-docs`).**
- Deliverable: flip R6 tags `(Designed)`→`(Implemented)` for shipped A pieces across `project-brain.md` / ERDs / OpenAPI; confirm code↔spec consistency (incl. the amended design-spec sections); `EMBEDDING_UNAVAILABLE` present everywhere.
- Acceptance: `validate:docs` + adr-anchors + redocly lint green; no spec section describes code absent at HEAD.

**T6.3 — Renumber pass (own session, AFTER rebase onto main).**
- Deliverable: reconcile main `0088` vs main HEAD `_journal` (main may advance past `0087`; 0088 now carries FOUR shared-table ALTERs — platform_runtime_settings/projects/agent_project_links/runs — keep them one migration through the renumber); fix non-monotonic `when`; re-run `db:migrate && db:migrate:brain` on a clean DB; boot-guard ledger==journal==sha for **both** lineages. Brain lineage `0001` is collision-free (independent journal + own ledger table) — only the single main `0088` needs reconciliation.
- Traces: skill-context (renumber pass; drizzle journal hazard).
- Acceptance: clean-DB migrate green both lineages; ledger/journal/sha aligned.

**FINAL COMMIT:** `docs(brain): as-built sync + renumber pass (Sub-project A)`.

---

## Commit Plan

1. Phase 0 → `docs(brain): ADR-122 + analytics/ERD/contracts`
2. Phase 1 → `feat(brain): two-lineage migrations + pgvector schema`
3. Phase 2 → `feat(brain): embedding registry + atomic retain`
4. Phase 3 → `feat(brain): harvest + distillation + decay`
5. Phase 4 → `feat(brain): recall + MCP tools + ambient`
6. Phase 5 → `feat(brain): enablement + settings + reindex`
7. Phase 6 → `docs(brain): as-built + renumber pass`

## Traceability (task → spec; E-n = §13 bullets top-to-bottom, pinned in T0.2)

Every AC-A-1..7 (§14) is covered: A-1 T3.2 · A-2 T2.2 · A-3 T3.3 · A-4 T4.1/T4.2/T5.3 · A-5 T4.3 · A-6 T1.4/T5.2/T5.3 · A-7 T4.1/T4.2. Every A-relevant Expectation (§13) is covered: E-1 (project isolation) T4.1/T4.2 · E-2 (immutable generations) T2.1/T2.2/T5.5 · E-3 (retain idempotent) T2.2 · E-4 (confidence floor + decay) T3.1/T3.2/T3.3 · E-6 (no LLM at read) T4.1 · E-8 (resumable jobs) T5.5 · E-10 (secrets env:NAME) T2.1/T5.1 · E-11 (SQLite off) T1.4 · E-12 (snapshot per consumption) T1.3/T4.2/T4.3. (E-5/7/9/13/14 = Sub-projects B/C: proposals, event-driven indexing of sources, chunker trust, canonical pointers, re-anchor.)

## Resolved questions (2026-07-02, owner)

1. **Embedding default** = OpenAI `text-embedding-3-small` @ 1536; runtime model **and dimension** switches supported via untyped `vector` column + per-generation HNSW expression indexes + reindex generation (no schema migration).
2. **Distillation** = direct `openai_compatible` `complete()`; `distill_model` nullable — project enable-gate requires it set (`CONFIG` at PATCH); cleared post-enable → harvest throws-and-retries (cursor holds, no event loss).
3. **Policy defaults** = τ 0.85 · confidence₀ 0.3 · TTL 30d · reinforce +0.1/+30d · K 5 — constants in `web/lib/brain/policy.ts`.
4. **Chunkers → Sub-project B** confirmed; design-spec §9 amended in the same pass.
5. **Memory scopes** added to `AGENT_TOKEN_SCOPES` now; access still gated by `brain_enabled` + `can_read_brain` (recall) / `can_write_brain` (retain) — separate write axis per review.

No open questions remain. NEXT: `/aif-implement` (reads this plan by branch stem `claude-interesting-euclid-8c9ac0`).

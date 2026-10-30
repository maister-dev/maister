# Implementation Plan: Agent activity, history and quiet operational attention

Branch: `feature/operational-agent-kind` — keep this checkout and branch.

Created: 2026-10-30. Updated after rebase and triager investigation.
Status: **Planned; UX-T01–UX-T28 remain unchecked. Rebase preparation is complete.**

This is the active follow-up plan for `/aif-implement`, `/aif-improve` and
`/aif-verify`. The completed original operational-agent plan and qualification
receipts are retained below under **Historical operational-agent delivery**;
its checked tasks are not acceptance evidence for this follow-up. The short
product-direction note at the end is historical input; the decisions here
resolve its alternatives.

## Settings and delivery boundary

- Full plan; user explicitly requested the current branch. User also authorized rebase: completed onto master
  `420f432b21ea190635b949dfeac22c36cdc940ec`, verified against GitHub master through
  the connected API on 2026-10-30. Integration metadata commit `d81a04728` restores
  both migration/ADR lineages. Safety branch:
  `codex/backup-operational-before-rebase-20261030`. No feature implementation or
  deployment migration ran; only rebase resolutions and validation changed code.
- SDD first. Phase 0 produces complete canonical specifications before code.
  Every behavior slice uses **RED → GREEN → REFACTOR** with real runner receipts.
  Tests and EN/RU documentation are required; standard structured logging;
  roadmap linkage remains `none`, following the user's confirmed defaults.
- Commit by the phase checkpoints below. No push, tags, hosted dispatch, live
  GitHub mutations or production deployment are authorized by this plan.
- Platform owns activity/history, shared failure projection, lifecycle settlement
  safe alternate-runner attempts and shared task qualification/admission. `maister-plugins` additionally owns
  `core:triager` operational adoption and shared intake qualification guidance
  (UX-D10–11/UX-T22/27), alongside both GitHub intake adopters. Platform-first then core release and explicit attachment upgrade remains
  mandatory. Legacy triager visibility/failure fixes must work before package update.
- Prompt **viewing** is required. Direct prompt editing and a new project
  override/fork workflow are deliberately deferred: the user's suggestion was
  optional, and current Studio routes select the newest install rather than
  necessarily the project pin. Memory editing and existing project settings
  remain available under their existing permissions.
- No new agent kind, run status, scheduler pool, automatic approval, automatic
  promotion, incident-generated Task creation, retention duration, polling loop, service, env var,
  dependency, port or host mount. Existing lifecycle and result contracts remain
  authoritative. Add a narrow Pending-failure entrypoint and durable retry intent;
  neither changes old run outcomes or resumes a session with another runner.

## Verified implementation anchors

Line references were inspected before and rechecked around the rebase; re-resolve
at implementation. The original history timestamp assumption is corrected below.
“New” paths in the task list are proposals, not assertions that files exist.

| ID | Current code reference | Consequence for this plan |
| --- | --- | --- |
| UX-E01 | `web/lib/queries/portfolio.ts:82-110,823-864,954-1036`; `web/app/(app)/layout.tsx:64-82,145` | Rail is workspace-oriented, inner-joins workspaces, omits Pending and lacks agent identity. A second run-based population is necessary; a cosmetic filter cannot fix missing agents. |
| UX-E02 | `web/components/chrome/left-rail.tsx:260-309,455-499`; `left-rail-sections.ts`; `mobile-rail-drawer.tsx` | Expanded, collapsed and mobile variants must use the same population and routing. |
| UX-E03 | `web/lib/scheduler.ts:101-120,147-176,217-240`; `web/lib/runs/run-status-sets.ts:40-52` | Agent capacity defaults to 3, separate from flow/scratch. Slot holders are Running/NeedsInput/HumanWorking; visible runs also include queued and parked executions. |
| UX-E04 | `web/lib/run-results/operational-visibility.ts:10`; `web/lib/queries/project.ts:366`; `portfolio.ts:446,1010` | Terminal operational runs already leave active copies. Preserve this and code-delivery retained-workspace behavior. |
| UX-E05 | `web/lib/runs/operational-attention.ts:16-161`; `web/lib/db/schema.ts:2240-2274`; `web/lib/queries/decisions.ts:245-273,421-427` | Current attention and acknowledgements are per run/reason/revision. Group before canonical queue/count projection; retain legacy acknowledgement meaning. |
| UX-E06 | `web/app/api/attention/stream/route.ts:175-215,323`; `web/components/attention/attention-live-refresh.tsx:33-40`; `web/lib/notifications/attention-consumer.ts:157-228,259-291` | Reuse attention SSE. Launch/start/queue invalidation is incomplete; ID-only signatures miss changed content under a stable group ID. |
| UX-E07 | `web/lib/agents/project-links.ts:215-277,774-821`; `web/app/(app)/projects/[slug]/page.tsx:850-920`; `web/app/api/projects/[slug]/agents/route.ts:51-72` | Project rows lack history stats; page and HTTP DTO are separate consumers. Detach deletes links/schedules, not runs or memory. |
| UX-E08 | `web/lib/agents/launch.ts:959-970,1411-1477`; `web/lib/db/schema.ts:1835-1851,1959-1962,2186-2214` | Agent-driven flow runs also have agent identity. Schedule FK and agent FK can become null. `startedAt` is later rewritten by scheduler; immutable launch time must be added. |
| UX-E09 | `web/lib/agents/launch-contract.ts:44-133`; `web/lib/run-results/types.ts:66-86`; `web/lib/run-results/operational-projection.ts:23-110`; `web/lib/run-results/operational-types.ts:80-92` | Reuse frozen definition/provenance and canonical successful/validation/integrity receipt. Do not derive success from status, prose or latest catalog definition. |
| UX-E10 | `web/lib/agents/finalization.ts:609-705,757-875,1073-1109`; `web/lib/gc/operational-disposition.ts:131-219,558-610`; `web/lib/agents/create-failure.ts` | Terminal results, cleanup transitions and domain facts have transaction owners. Extend those owners rather than adding another eventual result finalizer. |
| UX-E11 | `web/app/api/projects/[slug]/agents/[agentId]/memory/route.ts:66-117,120-162,185-237,256-274`; `web/components/board/panels/agent-memory-drawer.tsx` | Memory has attachment lookup, readRepoFiles/editSettings grants and hash CAS. Reuse, including concurrent agent/human writes. |
| UX-E12 | `web/lib/agents/effective.ts:61-159`; `web/lib/studio/load.ts:68-88`; `web/lib/local-packages/fork.ts:96-188` | Effective prompt is pinned; Studio viewer/fork chooses newest install. Fork lacks a durable crash/idempotency protocol; do not expand this change into a new editing workflow. |
| UX-E13 | `web/app/api/v1/ext/decisions/route.ts:19-34,70-96`; `docs/api/external/operations.openapi.yaml:7351`; `mcp/src/tools.ts`; `mcp/src/__tests__/tool-contract.test.ts` | External decision cardinality/action semantics and MCP projection must migrate with Inbox. |
| UX-E14 | `web/lib/queries/visible-projects.ts:88`; `web/lib/queries/__tests__/decision-queue-grants.test.ts`; project agent/memory routes above | Counts, history, incident diagnostics and prompt/memory have different data grants; navigation hiding is not authorization. |
| UX-E15 | `scripts/validate-requirement-coverage.mjs:32-37,177-183`; `web/vitest.config.ts`/runner configuration; existing operational E2E | Extend existing traceability/runner discovery. Existing parser recognizes T-number headers, not UX-T headers: add support and a non-vacuity test before claiming follow-up traceability green. |
| UX-E16 | `web/lib/queries/project.ts:332-375,477-488`; `portfolio.ts:410-455,230-243`; project page `:928-1007` | Project/portfolio include failed rowless sessions as working copies and render generic green done; fix all populations, not just rail. |
| UX-E17 | `web/lib/scheduler.ts:572,1087`; `web/lib/agents/launch.ts:1617-1647`; `finalization.ts:128-140` | startedAt mutates on admission; post-insert failures need a narrow Pending settlement path. |
| UX-E18 | `web/app/api/projects/[slug]/agents/[agentId]/launch/route.ts:17-23,68-75`; `web/lib/agents/launch.ts:1024-1067,1662-1684`; `web/lib/execution-host/create-intent.ts:85-112`, `owned-session-create.ts:140-201,291-303` | Manual launch supports runner override but loses original event context and has no source-retry receipt. Owned create retries cannot change runner payload. |
| UX-E19 | `web/lib/runs/terminal-cause.ts:60-102`; `agents/prompt-owner.ts:634-653`; `reconcile.ts:510-517,2199-2225`; `services/triage.ts:380-409` | Reuse terminal/owned-command diagnostics and reconcile; agent recovery is not graph recovery, and Send to triage resets task state. |
| UX-E20 | `plugins:packages/core/maister-agents/triager.md:1-54,90-231`; platform `triager-definition`, `triager-package` and `triager-wire` tests | Triager is a none/session MAIster operator, but currently has default kind and fresh-run clarification instructions. Operational adoption requires prompt/HITL/result changes. |


## Design decisions and acceptance contract

### UX-D01 — Agent identity, history population and snapshots

Add `runs.sourceAgentId` (nullable text, immutable, **no FK to catalog agents**)
and immutable `runs.launchedAt` (database-owned insert timestamp for new launches)
for every agent-origin launch, including `runKind=flow` launches. Identity is the
existing package-qualified ID, scoped by `projectId`. Detach/reattach and package
updates retain this identity; an explicit rename creates a distinct history.
Deleting/recreating the same qualified ID resumes its identity, with historical
name/version retained per run. Never group unrelated null agents by display name.

Freeze a small versioned `agentActivitySnapshot` at launch: qualified ID, display
name, definition digest, package install/version/revision, and the versioned
operational comparison scope where applicable. Reuse existing frozen definition,
config, trigger and result payloads rather than copying complete prompts/results
into new tables. Historical code-delivery rows without a full prompt snapshot
must say “Launch prompt unavailable”; current prompt is never substituted.

Backfill source identity from `runs.agentId`, then verified operational definition
snapshot, then an existing explicit delegation snapshot. Reconstruct a qualified
ID only with proven package identity and stem; a bare stem is not globally unique.
Conflicting candidates fail the backfill with a typed diagnostic. Rows with no
proof remain historical run records, individually addressable, under a visible
“Agent identity unavailable” diagnostic; no fabricated association. New launches
must always provide identity, enforced at the launch seam and by a constrained
schema relation for the new snapshot version. Existing runs keep frozen completion
semantics when new metadata is backfilled.

History includes manual, cron, event, webhook, delegated and flow-driving launches
identified by this key. A Flow node merely using an agent persona is not another
launch. Project/agent pages remain available in read-only historical mode after
detach or catalog deletion when authorized retained history exists; current
settings, effective definition and memory mutations require a current attachment.

**UX-AC01:** a package update, schedule deletion, detach/reattach or catalog deletion
does not reclassify or lose provably associated retained runs. An unresolved legacy
identity is explicit and never merged into another agent's history.

### UX-D02 — Active rail, workspace review and capacity

Use a dedicated run query, with no workspace prerequisite. Agent-origin executions
in `Pending | Running | NeedsInput | NeedsInputIdle | HumanWorking |
WaitingOnChildren` appear individually in the **Agents / Агенты** section. Derive
one exhaustive status classification from the canonical RunStatus union; new
statuses must not enter implicitly. Include agent-driven flow launches, with a
Flow badge and their actual pool classification. Two concurrent runs of one agent
are two accessible rows. “Waiting for input” rows retain each request's own control.

All working-copy queries require an actual retained workspace; project and
portfolio gain a distinct active-executions section too (UX-D08). Rail workspace
query additionally excludes runs currently represented in the agent section. At code-delivery Review/Failed/Crashed, existing review/recovery/retention
workspace rows remain available. Terminal operational runs never appear in either
rail population, regardless of success, retained diagnostic bytes or cleanup
failure. Change project/portfolio population deliberately at its domain boundary, while
retaining real code-delivery workspaces and ordinary promotion semantics.

Rows show agent and project, status, launch time, run link and pending-input count;
reuse authorized Stop/run navigation, not Git actions. Use semantic icon/text in
addition to color. Expanded rail, collapsed flyout and mobile drawer share this
population; long active lists scroll without hiding concurrent executions.

Show visible active and queued counts, explicitly scoped to accessible projects.
Do not introduce a global occupancy fraction for ordinary members: it would leak
inaccessible activity and the agent-driven Flow entries use another pool. The
existing scheduler/admin surface remains the capacity authority. No new capacity
widget is required; the section label must not imply a new operational-only pool.

**UX-AC02:** all listed active states are individually accessible for none,
repo_read and worktree modes; no duplicate rail row. 1,000 completed operational
successes or failures leave zero terminal rail rows. Code-delivery Review still
opens normal review and promotion. Visibility count is not scheduler occupancy.

### UX-D03 — Project summary and agent page

Project Agents rows link to `/projects/[slug]/agents/[agentId]` and show retained
run count, active count, and the last launched run's status/time/outcome. In the
page header also show last completed run, so a new Pending run does not conceal
last failure. Label counts **Runs in retained history / Запуски в истории**;
these are not lifetime counters independent of retention. Zero runs means “Not
run yet / Ещё не запускался”. Use one batched aggregate/latest query, not N+1.

The full-width page has URL-addressable tabs: History, Memory, Definition and
Settings. History is default and uses keyset pagination, default 25/max 100,
newest `(launchedAt,id)` first for new/verified rows. Preserve mutable startedAt
as execution/admission time, never use it for causal recovery. Backfill launch time
only from verified creation evidence; otherwise retain a stable legacy sort time
with explicit estimated provenance and disallow it as a recovery witness. Filters
are URL-synchronized allow-listed status, trigger source and operational outcome;
reset cursor on filter change. Cursor binds project, agent, filters and upper
launch boundary. Tampered/mismatched cursors return 400; all queries still enforce
authorization independently. New launches do not displace rows between existing
pages; live updates display “New runs available” with an explicit first-page
refresh. Dynamic status/outcome filters reflect current canonical state, not a
historical database snapshot; do not promise frozen membership across transitions.

Each history row uses `loadOperationalOutcomes` and normal run details for evidence,
counts, diagnostics, cancellation/crash, cleanup and confirmed task links. Only
links belonging to this authorized project are exposed. No diff/promotion controls
for operational rows. History and summary use the same identity/filter foundation;
summary is unfiltered and labeled accordingly.

Memory reuses current persistence, grants and hash CAS. Definition shows the pinned
current prompt and safe resolved configuration/provenance, not token-expanded
runtime text. Apply `readRepoFiles` to prompt/memory/config values; membership may
see safe metadata and history statuses without protected text. Missing/untrusted/
incompatible package yields a localized section error while history remains usable.
Never fall back to the newest catalog definition. Studio “View package” link is
shown only when the resolver selects exactly this authorized pinned install.
Project settings reuse the existing editSettings-protected modal/endpoint. No new
prompt write endpoint; installed files remain immutable.

**UX-AC03:** summary → page → next history page → run works for EN/RU, keyboard and
mobile; counts/latest are deterministic, safe and scoped. Memory conflicts are
visible; unauthorized users cannot retrieve protected data by calling the API.

### UX-D04 — One Inbox item, distinct causes and quiet repetitions

For operational terminal problems and eligible workspace-less legacy execution
failures defined in UX-D08, group **before** the canonical decision queue
by `(projectId,sourceAgentId)`. ID is stable for this pair and independent of a
representative run. One card summarizes all unresolved, unacknowledged cause
**episodes**; no automatic Task, no terminal rail card and no per-run notification
storm. Individual HITL decisions retain original request IDs and are never grouped.

A cause fingerprint is versioned canonical structured data: platform reason,
normalized diagnostic code/operation/service/httpStatus where applicable, and
comparison scope. Never hash prose, remediation text, raw response bodies, dynamic
URLs, run IDs or timestamps. Platform validation/integrity/crash/missing-result
reasons take precedence over agent-authored diagnosis. A run with several distinct
causes contributes one occurrence to each cause but only one distinct failed-run
count to the card. Cap displayed causes at 10 with a paginated detail expansion;
the summary reports total causes and never silently drops the remainder.

Scope is a frozen hash of definition digest, effective declared instance config,
completion-contract version and semantic trigger input. Implement explicit trigger
normalizers: cron/manual scan with identical declared scope can match; event,
webhook or delegated inputs retain target identifiers/payload semantics while
excluding delivery IDs/timestamps only where the existing trigger contract proves
them nonsemantic. Unknown/legacy scope is **not comparable for automatic recovery**.
No secret-bearing scope inputs/hash preimages are exposed or logged. Changed scope
starts a distinct cause episode inside the same agent/project card.

Repeated observations in an open episode increment exact occurrence counts and
first/last timestamps, update latest-run evidence and content revision, but do not
raise actionable revision or undo a user's episode acknowledgement. A new cause,
escalation to a different fingerprint, or a recurrence after confirmed recovery
creates a new episode and re-arms attention. Acknowledgement is per user and means
“seen”, not “fixed”; acknowledged ongoing problems remain on the agent page.
No wall-clock cooldown and no automatic repeat reminder in this scope.

New episode acknowledgement accepts the exact observed episode IDs and immutable
attention revisions. An unknown/cross-agent ID fails atomically; a concurrently
created different episode remains unacknowledged. Repeated occurrences within the
same episode need not cause a 409 or force the user to chase a minute-by-minute
moving revision. A closed observed episode is an idempotent no-op. Another user's
attention does not change.

**UX-AC04:** 1,000 identical failures produce one card with correct distinct-run
count; after acknowledgement they produce no new unread/actionable item until a
new cause/episode. Two independent causes remain distinguishable inside one card;
other agents/projects and both readers remain isolated. No Task rows are inserted.

### UX-D05 — Recovery, concurrency, cleanup and retention

Normal business/API episodes, including authorization failures, can close only on a canonical validated,
source-clean **complete successful** result in the **same comparable scope**, whose
launch timestamp is strictly later than every occurrence's terminal timestamp.
A success launched before or during a failing run cannot establish recovery.
Use the new immutable database-owned launchedAt and terminal evidence; estimated
legacy times cannot prove recovery. UUID tie-breaks order pages, not causal proof. A
zero-new-work complete scan is eligible. Recovery eligibility is a platform cause
classification, independent of the diagnostic retryable flag: a 403 may be
non-retryable until access is repaired yet recover after an eligible successful scan.
Partial, missing, malformed, cancelled or
prose-only outcomes are not. A changed definition/config is a different scope and
does not falsely resolve the old problem; the UI permits acknowledging it as seen.

Integrity violations, unresolved external effects and unavailable evidence are
safety episodes: a later clean scan never closes them. Keep their diagnostic links
and existing remediation; acknowledgement can quiet the reader without asserting
repair. Cleanup episodes close only when their original resource's canonical
cleanup state proves removal/release; a different run's success cannot close them.
Rearming cleanup is not successful cleanup. Another exhaustion of the same open
cause updates occurrence evidence without revoking acknowledgement; exhaustion
after verified recovery creates a new episode. A cleanup episode shared by several
runs resolves only after every unresolved source occurrence has verified disposal.
Partial removal,
lease recovery and source evidence preservation keep their existing owners.

Serialize episode changes per project/agent with transaction-scoped advisory lock,
then episode/occurrence row locks and uniqueness constraints. Integrate with
existing terminal CAS and cleanup transactions. Inventory actual run-row locking
first and use one consistent lock order across finalization, failure, reconciliation,
cleanup and acknowledgement; never add a reverse acquisition order. No Git,
filesystem inspection, supervisor call or await on an external service inside this
transaction. Persist terminal/cleanup fact + incident projection + invalidation
fact atomically. On rollback, none becomes visible; on replay, unique source keys
prevent double counting. Applying a delayed/backfilled failure first checks for a
canonical success satisfying the same strict recovery witness; already-recovered
failures remain historical instead of reopening attention due to processing order.
Stop/cancellation without another failure creates no
operation episode; exhausted cleanup after cancellation still requires attention.
Recovery/resume of a crashed run preserves the original occurrence. A later status
change cannot erase it or pretend the failed attempt never happened; terminal
revision/source identity, not mutable run status alone, keys the incident fact.
Use the stable terminal-transition event/generation identity minted in the source
transaction; multiple terminal attempts of a recovered run must not share a boolean
“already applied” marker. Scheduler writers are verified to change startedAt; the new immutable launchedAt
is mandatory and must remain unchanged through Pending admission and resume.
Acquire the source run lock first, then the project/agent advisory lock and episode
rows; acknowledgements lock only episode rows and never acquire source-run locks.

Hard deletion of run history must not cascade away an unresolved episode. Retain a
small safe occurrence tombstone with timestamps and source fact key (`run_id` FK
SET NULL) and show “Execution evidence expired” when normal retention removes the
link. Aggregate counts are exact for ingested occurrences, distinct from the
retained-history summary. This first release performs no automatic episode/occurrence pruning: these small
ledger records persist with the project. Any later pruning policy needs an explicit
contract and owner. Evidence expiry alone creates no new incident. Project hard delete
may cascade its own groups after existing authorization; catalog detach/delete may
not. User delete cascades only that user's acknowledgement rows.

**UX-AC05:** reversed completion order, duplicate finalization, crash/restart,
acknowledgement races and cleanup retries neither double-count nor lose attention.
Old/overlapping successes do not resolve new failures. Cleanup/evidence loss cannot
silently erase an open problem or create review/promotion affordances.

### UX-D06 — Minimal persistence, migration and rollout

Proposed additive schema, finalized in Phase 0:

| Object | Fields/invariants and access path |
| --- | --- |
| `runs` | Immutable `source_agent_id`, `launched_at` plus explicit legacy timestamp provenance, versioned `agent_activity_snapshot`, retry lineage; history index `(project_id,source_agent_id,launched_at DESC,id DESC)` with nonnull predicate. No persisted mutable run-count columns. |
| `agent_incident_episodes` (new) | UUID ID, project FK, immutable agent key, scope digest/version or explicitly unknown, reason/fingerprint, state open/resolved, attention revision, first/last terminal timestamps, resolvedAt/recovery evidence. Unique open episode per `(project,agent,scope,fingerprint)`; unknown scope uses an explicit key, not SQL NULL uniqueness. Index open episodes by authorized project/agent. |
| `agent_incident_occurrences` (new) | Episode FK, immutable source fact key, nullable run FK SET NULL, original run ID for dedup/distinct count, fact channel (operational terminal, execution failure, admission refusal, cleanup), result/terminal/attempt or cleanup revision, observed terminal timestamp, per-occurrence verified cleanup resolution and minimal safe reason. Unique `(source fact key,cause fingerprint)`; no copied result bodies or prompts. Source key survives run deletion. Index episode/time and run/revision lookup. |
| `agent_incident_reader_states` (new) | User/episode/attention-revision PK; nullable acknowledgedAt; independent notificationRecordedAt, notificationMode (published/baseline), nullable notificationEventId. A notification receipt never implies acknowledgement. CHECKs enforce valid null/mode combinations. User FK cascade; publication receipt survives outbox retention. Old per-run acknowledgement table remains for compatibility. |

The separate `agent_retry_intents` ledger and unique retry-child relation in UX-D09
are required for explicit rerun idempotency, not incident aggregation.
Do not add a group table, general notification engine, lifetime counter or new
consumer clock. Content revisions can be hashes over bounded canonical summary
fields; actionable revisions depend on episode identity, not occurrence counts.
Use a bounded keyset backfill under the existing maintenance/upgrade fence before
opening new readers. Persist progress through the existing upgrade mechanism if
available; otherwise add one explicit upgrade progress record, not process-memory
state. Each page is committed with its cursor; retries are idempotent. Backfill
identity before episodes; process terminal facts deterministically and use the
same transition function as live writers. Surface corrupt/unclassifiable rows,
with exact counts and a deploy refusal, instead of silently skipping them.

Legacy per-run acknowledgements suppress only their corresponding existing
occurrences. Backfill creates **no explicit episode acknowledgement** from legacy
rows. Visibility derives from all current historical tuples being acknowledged;
only the new explicit action writes reader-state acknowledgedAt. Legacy acknowledgement
endpoints continue their exact run/reason/revision behavior; they must never grant
an episode-wide acknowledgement of future repeats. Define effective visibility as
explicit episode ack OR all current occurrence tuples individually acknowledged;
a later new tuple becomes visible without an explicit episode ack. New UI uses
explicit episode acknowledgement. The legacy read projection also honors an
explicit episode acknowledgement for its covered tuples, while retaining the old
per-run response shape. This preserves old clients without silently widening a
legacy write decision.

**Rebase reconciliation completed:** master retains ADR-194 and migrations
0194–0198 for project configuration. The unpublished operational branch now uses
ADR-195 and migrations 0199–0203. SQL bodies were renamed without business edits;
master snapshots remain unchanged and new operational snapshots include both
schemas. The operational incremental test now starts at canonical master 0198.
`db:generate` reports no schema changes; fresh and incremental local PostgreSQL
qualification passed. No deployment database was touched. Previous conflict-free
receipts in the historical section do not describe this new base.

Provisionally reserve follow-up migration 0204 for activity/incidents and 0205 for
retry persistence, 0206 for qualification; reserve ADR-196 for activity/attention,
ADR-197 for explicit retry/effect boundaries and ADR-198 for task qualification. Recompute against authoritative master at implementation.
UX-T01 still owns deployment-ledger inventory: a durable DB using the pre-rebase
operational 0194–0198 sequence must refuse ordinary upgrade until an explicit
ledger reconciliation path is specified/qualified; never rewrite that DB's applied
checksums or pretend canonical-master upgrade proof covers it.

Migration deliverables are SQL + journal + snapshot + Drizzle schema, generated
DBML, domain Mermaid ERD and column/cascade narrative. Qualify fresh install and
incremental upgrade from canonical master, as well as an already-operational
branch database if one is supported. `db:generate` must report no residual schema
change. A single quiet maintenance cutover drains old writers, migrates/backfills,
deploys all new writers/readers, validates projection, then reopens admission.
Do not support mixed old/new incident writers during the cutover. Rollback fences
admission, retains additive data, rolls back compatible binaries/readers together;
old per-run attention may be noisier, but history/results are not removed.

**UX-AC06:** migration resumes after interrupted pages without duplicates; old
acknowledgements retain meaning; source identity survives FK deletion; constraints
and generated schema match. New code is not enabled on partial backfill.

### UX-D07 — HTTP, external contracts, authorization and live updates

All responses use explicit typed/Zod DTOs and shared projections. API specs and
examples are written before handlers. Typed 400/401/403/404/409/503 errors use the
project taxonomy and localized UI mapping; never string-match server messages.
GETs are side-effect-free. New acknowledgement is DB-only (no downstream delivery
acknowledgement gap). Existing memory/settings/cleanup actions retain their own
transaction, CAS and external-effect protocols; no new hidden side effect.

| Surface | Planned contract and identifiers | Specification owner |
| --- | --- | --- |
| `GET /api/projects/{slug}/agents` | Add safe batched `activity` summary to attached agent DTO; slug=url-param, reader=auth-context, project/agent rows=server-state. Existing grants remain. | `docs/api/web.openapi.yaml`, agents analytics |
| `GET /api/projects/{slug}/agents/{agentId}` (new method) | Safe metadata/activity + attachment/historical state; definition capability flags, not protected prompt by default. slug/agentId=url-param; resolved project/source key=server-state; reader=auth-context. 404 only when neither visible attachment nor proven history exists. | Same |
| `GET .../{agentId}/runs` (new) | `{items,nextCursor,asOf}`; cursor/limit/filter=query-controlled and validated, with server-derived project scope. Invalid cursor 400; inaccessible project follows existing 403/404 policy. | Same |
| `GET .../{agentId}/definition` (new) | readRepoFiles gate; current pinned safe prompt/config/provenance or typed unavailable state. Missing current attachment is 404; valid historical page still works. No runtime secrets/private paths. | Same |
| `GET .../{agentId}/incidents` (new) | Bounded episode/cause details and acknowledgement state, separate cursor; member gets safe metadata, protected evidence/diagnostics use existing run-data grants. Derive group via project/source key, not an arbitrary representative run. | Same, attention analytics |
| `POST .../{agentId}/incidents/acknowledge` (new) | body-controlled nonempty bounded array of `{episodeId,attentionRevision}`; compare every ID to server-state project/agent, derive user from auth and require the existing `answerHitl` project action. 200 accepted/replayed/closed no-op; 409 stale invalid revision; 400 malformed; 403/404 unauthorized. All-or-none, no run/source IDs supplied in body. | Same, operational lifecycle AsyncAPI |
| Existing `POST /api/runs/{runId}/operational/acknowledge`, cleanup retry, project memory/settings | Preserve existing body/status/grants. Run/project/path locators=url-param; scope/user/cleanup owner=server-state/auth-context. Old per-run acknowledgement never means new episode acknowledgement. Document cutover compatibility. | Existing web OpenAPI paths |
| `GET /api/v1/ext/decisions` and MCP decisions tool | Opt-in query `operationalGrouping=agent` selects the grouped DTO with `aggregation: agent`, stable group/agent identity, episode/reason summary and counts; representative run is nullable navigation only. Omitted query preserves legacy per-run wire semantics; bundled MCP explicitly opts in. Validate the query allow-list, retain old safe fields and forbid representative-run group mutation. Read grants still govern nested fields. No new external mutation tool or prompt/history API required; grouped DTO exposes safe retry availability/navigation only. | `docs/api/external/operations.openapi.yaml`, `mcp/src/tools.ts`/contract tests |
| Attention SSE | Reuse `attention.tick` invalidation regions; add durable launch/queue/start/park/resume/terminal/incident-ack changes to scanned sources. Include content fingerprint in change signature. One subscription, reconnect/catch-up via existing cursor. | `docs/api/async/attention-stream.asyncapi.yaml`, domain taxonomy and attention analytics |
| Internal domain facts | Versioned activity/incident changed payloads contain IDs/revisions only, no prompt/diagnostic bodies. Emit in the owning transaction; notify-after-commit is only a wake optimization. Terminal and cleanup facts stay canonical. | `docs/api/async/operational-lifecycle.asyncapi.yaml`; outbound webhook spec only if a public webhook actually changes |

A grouped read response cannot expose secrets merely because a user can see
counts. Restrict prompt/memory/config and evidence payloads independently; redact
nested diagnostic/reference data before serialization. Project visibility applies
before SQL aggregation, cursor construction and notification generation. Tokens
must never acknowledge as a human by taking a userId from the request. Existing
HITL routes, permission IDs and resume behavior remain unchanged.

The Inbox badge counts groups plus independent existing decisions. Activity and
cause content changes refresh UI even when count/ID stays constant. Notification
creation uses newly actionable episode IDs, not count increase alone: a second
cause in one existing card must notify once; another identical occurrence must
not. Under the existing per-user notification lock, atomically insert the existing
outbox event and record each `(reader,episode,attentionRevision)` publication in
reader state. A failure before commit leaves both retryable; committed publication
uses the existing delivery retries. Outbox retention must not erase the receipt.
Both the event consumer and existing system_sweep backstop (`notifications/digest-trigger.ts`)
call this same publisher, including unchanged-count cases; preserve count-delta
semantics for other decision kinds. Bound each page of new episodes and make the
receipt the durable progress marker; do not advance past failed publication. New
activity facts must not feed an unintended agent-trigger/self-trigger loop.
On initial/backfill activation, mark the consumer baseline without generating
one historical notification per old failure. Bound summary queries and avoid
loading all historical operational runs on every badge render. The agent page
uses the same attention refresh mechanism; no timer/poll-based data fetching.

**UX-AC07:** browser and opt-in REST/bundled MCP agree on grouped cardinality; stale representative
runs do not control mutations. Same-count changes update live UI, repeated failures
do not create notifications, a new cause does, inaccessible-project activity leaks
neither counts nor events, and reconnect converges without a reload/poll loop.

### UX-D08 — Session failures, project working copies and truthful state

The reported screenshot is consistent with a verified read-model defect, not proof
that 20 physical worktrees exist. `project.ts:332-375` and
`portfolio.ts:410-455` left-join workspace-less agents into `activeWorkspaces`;
`project.ts:477-488` substitutes agentId for branch; `portfolio.ts:230-243` maps
Failed/Crashed to generic `done`. The project renderer at
`web/app/(app)/projects/[slug]/page.tsx:928-1007` shows that as a green dot and
passes workspace availability unconditionally. Actual statuses, installed pin and
runner health in the user's live installation have not been inspected.

Fix the domain boundary in **all three surfaces**: rail, project and portfolio.
“Working copies / Рабочие копии” contains actual retained workspace rows only.
An independently named “Agent executions / Запуски агентов” section contains the
same active agent-run population as the rail, including Pending and parked runs.
Each DTO carries exact run status, explicit workspace availability and separate
counts. No-workspace session rows cannot receive Git actions or inflate working
copy totals. Failed is danger/error, Crashed has its own localized state; neither
is rendered as successful Done. Review has its own label and retains real review
controls. Preserve real code-delivery failed/crashed/review workspaces and their
cleanup/recovery evidence; never infer a new kind from an empty diff or an agent ID.

Extend grouped incident eligibility beyond newly operational runs to
`runKind=agent` terminal Failed/Crashed executions whose **frozen** workspace mode
is none/repo_read and which have no retained delivery workspace. This includes
legacy `core:triager` without changing its historical `agentKind` or completion
contract. Operational runs remain eligible in every supported workspace mode.
Agent-driven Flow/code-delivery worktree failures retain their existing recovery/
review queue rather than producing a duplicate grouped incident. Unknown legacy
workspace/identity evidence is shown explicitly and never silently classified.
No `agentId === 'core:triager'` branch in generic lifecycle or visibility code.

Use a shared `AgentExecutionFailure` projection for both kinds: stage
`admission | materialization | session_create | prompt_dispatch | execution |
finalization | unknown`, typed reason/code, safe message/remediation, failed runner
ID and immutable runner snapshot label, occurrence time, source evidence locator,
retry eligibility and refusal reasons. Prefer canonical terminal event
`web/lib/runs/terminal-cause.ts:60-102`, owned execution command `lastError`, and
verified prompt evidence; do not parse prose or guess runner failure from status.
Missing evidence is `unknown`, not a fabricated HTTP/auth diagnosis. Operational
results add business detail but are not required to represent legacy execution
failure. Runner ID/config digest belongs in infrastructure cause identity;
business causes keep their original scope rules.

Correct actual stranded state as well as its projection. A known failure after
run INSERT but before dispatch must settle through a specific Pending-admission
failure finalizer. Under the run lock require Pending, matching launch ownership,
and proof of no dispatched prompt or live/unknown create. Use the same atomic
terminal/result/token/event/cleanup owner and release queue capacity exactly once.
Do not widen the general Failed status allow-list. If scheduler wins Running,
hand off to the current generation's ordinary finalizer/reconcile owner.

Unknown create/prompt outcome is not “failed safely”: reconcile the durable command,
assignment and supervisor evidence before concluding no live work remains. Review
all post-insert mkdir, `tryStartRun`, dispatch microtask and pre-spawn exception
paths (`launch.ts:1617-1623`, scheduler dispatch and create-failure paths). No
log-only stranded Pending/Running run. Startup/reconcile must recover a process
crash between durable launch and worker dispatch, with bounded existing-owner
retry; no new polling service and no forced status flip while a session may live.
Admission refusal before a run exists stays on its existing scheduler attempt/
launch HTTP diagnostic and agent summary; do not fabricate successful executions
or count rejected HTTP requests as runs. Repeated scheduler refusals use the same
agent attention card when they have durable attempt evidence, with a distinct
source fact key and **attempt count**, not a fake failed-run count. Where an
existing trigger lacks durable pre-run refusal evidence, record that refusal in
its existing domain-event/attempt ledger in this scope; an exception log is not
history. Include manual refusal feedback without manufacturing a run.

**UX-AC08:** twenty failed workspace-less triagers yield zero working copies, one
agent failure card, and twenty retained run records with accurate failure labels.
Queued/running agents remain accessible. Known pre-dispatch failures terminalize;
unknown host outcomes remain actionable and recoverable until reconciled. Real
code-delivery workspaces and individually actionable HITL are preserved.

### UX-D09 — Explicit new attempt with another runner

Provide **“Run again…” / “Запустить повторно…”** on eligible failed-run details,
agent history and the incident's representative-run action. A picker shows the
source runner, compatible ready alternatives and precise refusal reasons. Preview
states that this is a new session/attempt using the **current effective pinned
agent definition/configuration**, preserving the source task and semantic trigger
input. Show differences from source snapshots, including kind/contract changes;
never pretend this resumes the old ACP session or reproduces an unavailable prompt.

One-off runner override and **“Runner for future runs / Раннер для будущих запусков”**
are separate controls. New attempt requires existing `launchRun`; permanent
attachment override uses existing PATCH plus `editSettings`. A member can retry
without changing defaults. Do not alter `triage_set.runnerId` when choosing the
triager runner: that field controls the downstream task Flow, a different choice.
No automatic failover, automatic retry storm, schedule re-enable or default change.

Reuse `launchAgentRun` resolution, admission, permissions, isolation, trust,
maintenance and queue machinery, but introduce a server-owned retry intent rather
than calling the current manual launch endpoint blindly. The existing launch route
accepts runnerId/taskId but discards event context; reusing original triggerEventId
would hit `(agentId,triggerEventId)` dedup and return the old failed run. Generic
`POST /api/runs/{id}/recover` is not a runner-switch API and remains unchanged.

Retry safety is an explicit preview/action contract:

| Source / state | Decision |
| --- | --- |
| Settled nonpersistent standalone agent Failed/Crashed; owned durable evidence proves prompt/work never dispatched and no source session/create can still execute | Allow a new attempt, including verified legacy workspace-less triager failures; retain original task and trigger context. |
| Running, Pending, NeedsInput, NeedsInputIdle, HumanWorking, WaitingOnChildren, or any unresolved create/prompt delivery | Refuse; link to the source Stop/reconcile/HITL action. Never run two live attempts through this control. |
| Post-dispatch failure, partial business work, unknown writes or incomplete audit evidence | `reconciliation_required`; preserve confirmed effects/references and refuse blind replay. Existing explicit task/business remediation may be used, but is not falsely presented as idempotent retry. |
| Clean complete successful source or already-answered/claimed task, stale task revision, archived project, detached/disabled agent, unavailable/untrusted package, unsupported trigger, persistent/shared/delegated agent or driven Flow | Typed refusal with current-state remedy; use existing appropriate launch/Flow recovery paths. No implicit task reset/requeue or authority inherited from an expired parent. |
| Same retry request delivered twice / concurrent callers for one source | Same-key replay returns the same receipt; a different request key conflicts with an existing accepted/launched intent. At most one retry child per source; retry a failed child from that child. |

The first release deliberately guarantees safe runner substitution for proven
pre-work failures. It does not promise exactly-once replay of arbitrary MCP writes.
The eligibility predicate uses command/assignment evidence, not “no result file”,
empty diff, exit code, mere audit-log absence or an agent's statement. If legacy
records cannot prove safety, show that reason and retain ordinary manual launch/
task remediation as distinctly named existing actions. Keep task state unchanged
until the new attempt performs an authorized operation.

Add `agent_retry_intents` with immutable ID, sourceRunId/project/agent/actor,
request key and canonical request digest, selected runner, frozen current-definition/
config/input/task-revision preview fingerprint and its protected server-owned recipe
(exact package/definition digest, resolved configuration, semantic trigger payload,
task revision, selected-runner snapshot and policy inputs), preallocated successorRunId,
state `accepted | launched | refused`, typed refusal, timestamps, mandatory admission
lease owner/fence/expiry, attempt count, due time and allocation progress/provenance. Partial unique sourceRunId while state is accepted/launched serializes an active
claim; unique nonnull runs.retryOfRunId permanently enforces one created successor.
Unique `(actor,requestKey)` and payload comparison reject key reuse
with different contents. `runs.retryOfRunId`/retry-origin snapshot persist lineage
and original trigger/event/schedule semantics. Derive every locator from source
state; the new run's `triggerEventId` does not reuse the original delivery key.
Keep the original trigger source/payload as semantic input with an explicit manual
retry-origin envelope; no new trigger enum is necessary. The prompt builder must
read this server-derived retry context rather than replacing an event with an
empty manual prompt. Do not count a retry as another scheduled delivery or reset
cron `nextFireAt`; history labels it as an explicit retry.

Validate cheap preconditions first; then lock source run/task and revalidate source
quiescence, current permissions, task revision and preview fingerprint before
committing retry intent. No network/Git/filesystem work in the transaction. The
accepted recipe is immutable, not just a hash of mutable rows. The launch seam
consumes that recipe; it must not re-resolve a newer pin/kind/config silently.

After commit, the launch owner claims the intent with a database lease and fencing
generation. Immediate post-commit dispatch and a bounded `runAgentRetryAdmissionSweep`
called by existing `runSystemSweep` (`web/lib/scheduler/system-sweeps.ts:343`) share
this owner. Run this recovery pass before workspace-orphan reconciliation; add no
new timer/job kind. Before allocation, revalidate current actor grants, attachment,
package trust/availability, runner readiness/policy, source quiescence and task
revision against the accepted recipe. Preview-relevant drift yields a typed
`retry_context_changed` refusal requiring a fresh preview; revoked authority never
inherits the earlier grant. No workspace/session is allocated on this refusal.

Use the **preallocated run identity** and durable per-resource allocation receipt,
not a fresh random ID/path on retry. Protect allocation and adoption with the
existing materialization/context filesystem mutex pattern plus the DB fence;
a live filesystem owner is not stolen merely because a lease expired. Persist
intent-owned allocation provenance before the crash window; ordinary orphan GC
must recognize accepted-intent resources. On crash after worktree allocation but
before run insertion, adopt only the exact matching owned branch/path/provenance
under the renewed fence. Unknown/conflicting bytes are preserved and refused for
diagnosis, never overwritten, deleted or silently recreated. A stale worker cannot
insert a child or clean resources after another generation takes ownership.

Before successor INSERT, recheck the fence, source quiescence, task revision,
current authority and accepted recipe under the owning transaction locks. Insert
successor run, immutable snapshots and intent→run receipt atomically; then dispatch
via existing recoverable command ownership. A final-check refusal after allocation
records a durable resource disposition for the exact owned allocation, processed
by the existing lifecycle/cleanup owner with preservation and bounded retries;
never mark resources disposed merely because the intent is refused. Recovery after
receipt adopts that same child, never creates another. Transient admission failures
use bounded due-time retries with structured warnings; exhaustion becomes a typed
refusal and grouped attention, while retained resources keep a separate cleanup
obligation. A poison intent cannot starve the sweep. Unknown session-create outcome
stays under existing command reconciliation, not this pre-insert retry mechanism.

An accepted intent is 202, not a claim that the new runner has started or succeeded.
A launched child remains visible Pending when capacity is full. A terminally refused
intent can be explicitly re-prepared with a new request key after fixing the
precondition, only if it never minted a successor and its allocation ownership has
been safely settled; preserve earlier attempts in audit, never overwrite receipts.
The refused intent releases only its active-intent claim; a created successor can
never be replaced by refusing or deleting its receipt.

New routes:

- `GET /api/runs/{runId}/retry-options`: source run=url-param, actor=auth-context;
  project/agent/task/original trigger/current pin/readiness=server-state. Require
  project `launchRun` before disclosing compatible runners; protected original
  input remains behind its existing data grant. Return eligibility/refusal,
  compatible runner metadata, safe differences and expiring preview fingerprint.
- `POST /api/runs/{runId}/retry`: body-controlled `{runnerId,requestKey,previewFingerprint}`
  only. runnerId must resolve in the authorized compatible set; request key UUID;
  no taskId/projectId/cwd/package path/eventId supplied by client. Server derives
  input. 202 `{retryIntentId,sourceRunId,runId,state,queueReason?}` for accepted
  intent or its pending replay; state distinguishes accepted/queued/started and never
  claims completion. Before creation, runId is null; the reserved identity is
  server-only. Read the intent through `GET /api/runs/{runId}/retry/{intentId}`
  (both IDs=url-param, verify source/intent match and project grant) with SSE
  invalidation. It returns 200 with current state and nullable created runId.
  Same-key replay of an asynchronously refused intent returns 200 with state refused
  and typed reason; it never restarts that receipt. 400 malformed, 403 denied, 404 unavailable source,
  409 stale/unsafe/conflicting request or successor already owned by another
  intent, 503 maintenance/admission infrastructure unavailable before acceptance.
  Post-acceptance delivery failure is recorded on intent/run; it is not a blind
  HTTP retry that creates another child. Exact same-key replay returns same receipt.

Specify these in web OpenAPI, agent/run analytics, error taxonomy and attention
AsyncAPI. Reuse existing SSE for intent/new-run/terminal changes. No new MCP retry
tool or external write scope in this release; grouped external decisions expose
safe action availability and navigation without pretending a review action starts
work. Add migration SQL/journal/snapshot/schema/ERD and payload-hash checks in the
same Phase-0 design. Reserve a separate follow-up migration for retry persistence
and ADR for its effect/replay boundary. No data-dependent unreviewed auto migration.

A successful retry links the work-item recovery in history but does not rewrite the
old failure or certify the old runner healthy. Infrastructure episodes for runner A
are not automatically closed by success on runner B; a matching healthy witness or
explicit per-user acknowledgement is required. A one-off override does not repair
an attachment that will still choose A tomorrow. The UI offers the separately
authorized future-run setting with this distinction visible.

**UX-AC09:** a proven failed runner launch can create exactly one new attempt with
selected runner B, same intended task/input and a new frozen current contract,
while runner A's original record remains unchanged. Double click, timeout/replay,
concurrent readers and process death cannot duplicate work. Unsafe/unknown effects
and unauthorized/unready runners refuse with actionable reasons. Neither task Flow
runner nor project defaults changes implicitly.

### UX-D10 — Migrate core:triager as an operational package agent

Verified package owner: `/Users/kaa/Work/dev/github/maister-plugins`, main
`0bab5fa5bd41ff825e160ed5a998412c2537c29e` during investigation. Original intake
changes also exist on local branch `codex/operational-agent-kind` at
`fc24713c00558bf2aa72195c22c8433c42d6e21c`; continue that authorized package work
rather than overwriting main or dropping the intake changes. Reverify both before
editing. Platform fixture is
`web/lib/agents/__tests__/fixtures/core-package/maister-agents/triager.md`.

`packages/core/maister-agents/triager.md` currently declares none/session/read_only
and manual/domain-event triggers, without kind/completion/Flow. It performs MAIster
operations: relation/comment/flag creation, clarification, triage verdict and
enqueue intent; it forbids direct Flow launch. No separate triage skill is referenced.
Use `kind: operational` + `completion.contract: operational_v1`, preserving permission governance, trigger bindings and downstream Flow dispatch.
UX-D11 deliberately extends its workspace/configuration semantics for qualification;
that extension requires its own engine capability floor, not an agent-ID exception.

This is a prompt/protocol migration, not just frontmatter. Current prompt lines
135–158 request `reTriggerMode: triage` and assume terminalization followed by a
fresh run. Operational clarification must use the existing `agent` continuation
mode: ask → park → human answer → **same run** resume → reread confirmed task
clarifications → continue. Do not emit final success while parked. Keep explicit
`task.triage_requeued` binding for deliberate requeue only. Verify no duplicate spawn
from answer events (`agent-question.ts:471-486`, `hitl.ts` requeue branch and
`triggers.ts:580-587`). Max-round behavior and human-triage flag remain intact.

Define one work item as the triggering task, not each MCP call. Confirmed verdict,
confirmed duplicate/human-triage flag and an already-flagged no-op are valid success
with zero created tasks. Failure to persist a required mutation is failed/blocked;
confirmed earlier relations/comments plus an incomplete remaining operation can be
partial. Respect strict count equations, confirmed/unresolved references and fixed
operational-v1 top-level fields; do not add verdict/flowId/enqueue/needs_human fields.
Absent/malformed result fails, never inferred from prose. Package update affects
new launches only; historical legacy triagers retain old completion semantics and
are covered by UX-D08's generic failure projection.

Update the canonical package, README/compatibility/release notes, platform fixture
and synthesized fixture manifest floors in triager package/wire suites together.
UX-D11 adds shared qualification guidance to triager and both GitHub intake
variants. Linked-PR filtering, credentials and automatic failover remain outside scope. Qualify exact
package revision through normal install/trust/attach/launch, not only fixture parse.
Platform (including same-run continuation and new surfaces) first, then the updated
core release and explicit attachment pin upgrades. No tag/push/publication in the
implementation session without separate authorization.

**UX-AC10:** triager verdict, flagged no-op and human escalation complete as valid
operational outcomes; authorization/partial/malformed-result failures are visible
as failures; human answer resumes one run, explicit requeue remains distinct,
downstream Flow runner choice remains distinct, qualification additionally gates
launch under UX-D11, and pre-update runs keep
their snapshots. Both original GitHub intake adopters remain qualified.


### UX-D11 — Shared task qualification before accepted backlog and execution

**Verified gap:** `plugins:packages/core/maister-agents/triager.md:65-79,126-168`
permits no repository access and asks mainly when routing is unclear;
`triage_only` deliberately postpones detail. Neither contradictions nor current
implementation/bug validity are mandatory checks. Both GitHub variants use
`packages/core/capability/skills/github-issue-intake/SKILL.md:85-102,134-148`, which
carries unanswered questions into `task_create`. `services/tasks.ts:170-192,270-275`
creates Backlog before `task.created`; `work/stage.ts:90-123,200` calls untriaged
work Triage but includes it in backlog. `services/triage.ts:187-225` stores routing,
not a validated qualification; confidence is advisory. This is an explicitly
requested expansion of intake scope, not a claim current prompts enforce it.

**Carrier and product boundary.** Reuse the task row, source identity, comments,
clarifications and task activity as the durable intake carrier. Add **Incoming
requests / Входящие задачи** as a distinct project view/read-model partition,
separate from accepted Backlog and the user's personal Inbox. No second issue store
or new TaskStatus/RunStatus. On projects with the new qualification policy enabled,
all newly created independent requests (UI, GitHub, MCP/API, librarian and
ordinary agent `task_create` requests)
start unqualified in Incoming; supplying a Flow does not bypass this. A persisted
KEY-N intake record is not accepted backlog work. The importer records source and
imports into Incoming; the triager qualifies once before accepting it. This meets
the product boundary without duplicating semantic judgments in each transport.

Use a project-owned versioned `taskQualificationPolicy` (`legacy | required`),
configured through existing project settings/config contracts with `editSettings`.
Existing projects/tasks migrate as explicit legacy, not fabricated qualified.
New projects default required; upgrading the core intake/triager attachment requires
required policy through the normal explicit project configuration change. Package
activation refuses incompatible policy with a remedy; the agent cannot enable it.
Existing in-flight/review work continues. An explicit existing-task requalification
opts that task in; once required, disabling project policy does not silently waive
its hold. No agent-ID special case: package capability requirements declare this
boundary. Existing generic code-delivery fixtures remain legacy unless testing the
new policy. This versioned cutover must be visible in settings and release docs.

**One quality contract, separate from execution outcome.** Add immutable,
versioned `task_qualifications` revisions and a task's current qualification pointer
plus server-owned qualification-input revision. The record contains task/project,
policy version, input revision/digest, author/run, evaluated repository target/SHA,
structured check results, evidence references, decision, reason codes and specific
next actions. Strict schema with bounded collections/text; no arbitrary dynamic
keys or credentials. Reuse statement concepts (`tasks/statement.ts:21-32`) rather
than a parallel freeform specification: context/goal/acceptance/constraints/scope/
links/open questions. Do not require librarian conversation ownership for ordinary
tasks; `statementRevision` alone is not a universal freshness token.

Required checks: clear goal and scope; sufficient acceptance criteria; internal
consistency; relevant constraints/dependencies; strong duplicates; current relevance.
Bug checks include expected vs actual behavior, environment/version, credible
reproduction or observed evidence and why behavior violates the intended contract.
Feature checks compare requested behavior with current implementation/docs/tests.
No mandatory ceremonial template for a small clear task. Each check is
`pass | fail | unknown | not_applicable` with rationale and evidence; N/A requires
a justified request-type rule, not an escape from relevance. Decisions:

| Decision | Meaning / product result |
| --- | --- |
| `ready` | All applicable blocking checks pass, no blocking contradiction/question; accepted backlog. Routing and launch intent still govern execution. |
| `needs_information` | Missing requester facts or contradictory requirements; stay Incoming and use existing task Human ask. |
| `needs_review` | Evidence inaccessible, insufficient, stale or uncertain; stay Incoming with explicit evidence gap and human/technical verification action. |
| `not_actionable` | Evidence supports duplicate, already satisfied, obsolete or invalid request; stay in Incoming's resolved/held filter with reason and evidence. No automatic deletion, GitHub closure or irreversible task abandonment. |

Task rejection/needs-information can be a **successful operational run**: the agent
completed qualification correctly. Provider/auth/tool/persistence failure is an
operational failure, leaves the task unaccepted and uses grouped agent attention.
Do not add these decisions as fields/statuses to fixed `operational_v1`; its
references point to the task/qualification record. Import success means captured
in Incoming, never “accepted for implementation”; UI counters distinguish these.

**Evidence capability.** Change the upgraded triager to operational `repo_read`
with a disposable detached checkout of a **server-resolved task target/project
default commit**, using the existing read-only checkout/integrity/cleanup owners.
Add explicit `workspace_ref: task_target` resolution, authorized only for a bound
project task, with target derived from server configuration, never issue text.
Current `workspace_ref: trigger` only accepts webhook/run.* sources
(`agents/launch.ts:747-823`), so it cannot be reused unchanged for task.created.
Freeze resolved SHA and target at launch, including recovery; do not inspect a
mutable dirty developer checkout. Keep read-only tools, permissions and isolation;
no implicit shell or automatic approvals. Qualify actual runner file-read support.
Brain recall, when authorized, is supporting context with provenance, not proof of
current code. Read-only inspection may support relevance but must never be labeled
“bug reproduced.” Runtime reproduction needed beyond read-only inspection requires human-supplied
evidence in this release (which may reference a separately authorized existing
run). Do not launch a diagnostic task Flow from held intake: it would require a
separate evidence-only execution contract. Never execute issue-supplied commands
automatically. Insufficient runtime evidence remains unknown/needs_review,
not “invalid bug.” A good specification can therefore remain held for verification.

**Freshness and launch enforcement.** Bind assessment to title/prompt/accepted
statement, source version, target and answered blocking clarifications through one
server-owned input revision/digest. Inventory every writer: UI/ext/MCP/librarian
updates, source refresh, clarification answer, target changes and explicit requeue.
Advance this revision and invalidate the active qualification transactionally;
ordinary comments/priority/queue pauses do not invalidate unless explicitly adopted
as requirements. A comment is discussion, not a silent amendment. Qualification
and verdict writes never invalidate their own input. Historical records remain
immutable. Explicit task requeue invalidates readiness and clears old enqueue;
answering a question resumes the same agent with freshly loaded input.

Extend existing `triage_set` transaction with a typed qualification, expected input
revision and expected current qualification revision/pointer (null for first write).
Lock the task and CAS both: a late agent assessment must not overwrite a newer
human needs_review/not_actionable decision on unchanged input. Request-key replay
returns the original receipt; it never reapplies an obsolete assessment. For required tasks, only a current `ready` receipt can stamp launchable
routing/arm enqueue. Publish qualification, verdict/hold, enqueue intent, audit and
event atomically; stale writes return CONFLICT without partial mutation. Legacy
callers can flag/ask but cannot ready a required task without the contract. Existing
`auto_enqueue=always` and `triage_only` may not bypass quality; always means enqueue
only after qualification, and triage_only holds unclear requests without asking.
A ready task without a Flow remains unconfigured; ready with enqueue off stays
accepted Backlog; dependencies and permissions still gate work. Human correction or
assessment uses the same revisioned contract with existing task-edit/triage authority,
explicit rationale/evidence and audit; no generic force/checkbox bypass.

Enforce the same predicate in manual, force, scheduler, schedule, external/MCP and
agent-driven task Flow and task-bound code-delivery agent launch paths before
allocation and again in the task-lock
admission transaction. Task-bound operational qualification/inspection agents must
remain able to inspect held intake; distinguish operation purpose from delivering
the task, without an agent-ID exception or an operational agent bypass into Flow
launch. Existing task-scope permissions still apply. Pending work must recheck before dispatch; stale pending
admission settles through its existing owner without dispatch. Running/review work
is not silently canceled by an edit; expose new-input drift for ordinary rework.
Repo evidence is scoped to the checked target/SHA. Before accepting readiness and
before starting work, resolve the intended base outside the DB transaction and pin
allocation to that exact checked SHA; if it differs from assessment, hold/requalify.
No mutable branch-name checkout after the check. This is local registered-repository
revision evidence, not a claim of remote freshness. No per-commit event storm: stale
is detected at decision/admission or explicit requalification, using existing event
ownership; user-facing status must indicate when evidence needs rechecking.

**Existing orchestrator decomposition.** Internal execution-plan carriers are not
independent intake requests. Preserve `run_plan`/task-mode `run_delegate` under an
already admitted governed parent using an explicit server-owned qualification
provenance `execution_child`: parent run/task, its frozen admission receipt (or
explicit legacy admission), plan revision, child input digest and relation. Derive
this only inside the existing bound-parent-token transaction after parent activity,
project, delegation scope and child target checks; never accept a client field or
infer it from any `parent_of` relation. This authorizes work under the already
admitted parent contract, not a claim the child has passed independent triage. Keep
these carriers in the existing execution-plan view rather than Incoming/accepted
backlog. Ordinary `task_create` cannot obtain this exemption. A stopped/revoked
parent cannot launch new children. Independent reuse, detachment or edits outside
the owning plan invalidate inherited admission and require normal qualification;
no permanent reusable pass. Existing parent/child constraints, requires edges and
cascade/cancel ownership remain authoritative. If a required parent lacks a valid
admission receipt, reject the plan/delegation before carrier creation, with a typed
prequalification remedy; do not create and immediately abandon an entire DAG via
existing launch-refusal compensation (`ext/runs/plan/route.ts:627-650`,
`delegate/route.ts:66-90`). No new durable parent waiting protocol is introduced.
Prove this narrow exception at real plan/delegate boundaries; legacy and previously
admitted code-delivery orchestrators retain their governed decomposition behavior.

**Importer and UX.** Both transports use one shared qualification guidance skill
with the triager. Importer handles source scope, provenance, identity and basic
structure; it neither invents missing facts nor repeats repository assessment.
Keep the original body and explicit gaps. Repeated scans link the same existing
source/task and do not issue repeated questions. Where existing source refresh is
available, a changed source version invalidates qualification atomically; otherwise
show that the recorded source is a snapshot and require explicit refresh. Do not
claim silent external synchronization. Additional GitHub qualification/clarification comments, labels or closure remain
excluded, as do credential changes and linked-PR filtering. Preserve the original
importer pending/completion receipt comments and their existing authorization;
this scope adds no new external message type. Clarification occurs
in MAIster using the durable task carrier, not an unauthorized GitHub mutation.
Board/work-table/project/portfolio use the same Incoming-vs-accepted predicates,
including aggregate counts (current portfolio counts every Backlog row at
`queries/portfolio.ts:404`). Incoming has URL filters/counts for unassessed/needs info/needs review/not actionable,
links to source/assessment/run, specific fix actions and a separate accepted backlog
count. Task detail shows evidence SHA, freshness and route/launch intent separately.
EN/RU copy must distinguish “request already satisfied” from “runner failed.”

**Contracts, migration and compatibility.** Add additive task fields/policy and
qualification ledger, unique `(taskId, inputRevision, requestKey)` idempotency with
payload-conflict rejection, same-project FK/pointer validation, writer CAS and
bounded latest/history indexes, including immutable server-owned execution-child
provenance and current-assessment pointer CAS. Proposed next migration 0206 after activity/retry;
recheck names at T01. No history rewritten to pass. Protect qualification evidence
under existing task/run retention and grants, with tombstones for unavailable
references. Extend task/triage REST DTOs, ext OpenAPI, MCP `task_get/list/create` and
`triage_set`, board/work-stage projections, project config import/export and SSE
invalidation atomically with the policy. Use existing 403/404/409/422 semantics;
invalid body is 400, version/capability incompatibility is an explicit precondition.
A reader cannot infer permission from an evidence URL. Specs must enumerate the
request/response fields, identifier trust, size bounds and all admission writers.
Add a named engine capability/floor for task qualification and `task_target`; reserve
3.10.0 only after checking the integration version registry. The core upgrade must
require the new capability; 3.9.0 remains sufficient only for original operational
completion. Platform/schema/MCP/UI first, then qualified core, policy configuration
and attachment upgrade; rollback keeps required tasks held rather than allowing an
older writer to launch them. Stop incompatible old writers at the maintenance gate.

**UX-AC11:** unclear/contradictory/unverified or evidence-backed non-actionable
requests from both GitHub variants and ordinary creation stay Incoming, out of
accepted backlog and every delivery execution path; the read-only operational
qualifier remains allowed to examine held intake. A current, evidenced ready decision
admits exactly the existing task; launch still follows explicit intent/routing.
Unknown is never converted into a false rejection. Missing/malformed assessments cannot admit work. Changes invalidate stale
qualification; source/decision history and legacy active code work remain intact.

## Phase tasks and commit checkpoints

Task IDs UX-T01–18 are retained; added UX-T19–28 are placed in their owning phases.
Dependencies, not numeric order, define execution order.
Every task lists its primary boundary test in the acceptance matrix below. Complete
checkboxes only after its expectations and relevant owning suites are green.
Task-local logging below uses the existing pino boundary: IDs/revisions/counts only;
INFO transitions, WARN retry/refusal, ERROR failed migration/projection, no payloads.
Pure selectors, docs and render-only components add no artificial log noise.

### Phase 0 — Base reconciliation and complete specifications

- [ ] **UX-T01. Establish the integration and migration baseline.** Dependencies: none.
  Rebase and identifier reconciliation are completed in `d81a04728`; do not redo
  them. Recheck both current tips/journals/ADR registries, review incoming project-config
  attachment changes, and record applied-ledger provenance. Confirm the recorded same-branch rebase remains current; reserve new numbers
  as UX-D06 specifies. Paths: `web/lib/db/migrations/**`, `schema.ts`,
  `docs/decisions.md`, `docs/decisions/`, references/fixtures containing old numbers,
  this plan. Do not rewrite an applied durable migration. Deliver a precise fresh/
  incremental support matrix and recorded unresolved deployment premise. Logging:
  existing migration logs only. Gate: no duplicate numbers/anchors, no lost original
  operational or incoming attachment behavior. Remaining work is applied-ledger provenance and future namespace reservation;
  the user separately authorized and received the rebase in this planning turn.
- [ ] **UX-T02. Specify activity, identity, history and screen contracts.** Depends: UX-T01.
  Paths: `docs/system-analytics/agents.md`, new
  `docs/system-analytics/agent-activity-history.md`, `docs/screens/chrome/left-rail.md`,
  `active-workspaces.md`, `docs/screens/projects/` agent-page reference (new),
  `docs/screens/inbox.md`, respective indexes. Use R5 structure, exact status table,
  detached/legacy states, permissions, wirefields, query/cursor bounds and EN/RU
  copy table. Specify prompt-edit deferral, truthful project/portfolio working-copy populations,
  runner-failure diagnostic UX and separate one-off/default-runner controls. Logging: none.
- [ ] **UX-T03. Specify incidents, persistence, APIs and migration safety.** Depends: UX-T01, UX-T02.
  Paths: `docs/system-analytics/attention.md`, operational lifecycle/results docs,
  new `docs/system-analytics/agent-incidents.md`,
  `docs/db/attention-domain.md`, `agents-domain.md`, `operational-agents-domain.md`,
  `docs/database-schema.md`, the OpenAPI/AsyncAPI files in UX-D07, new ADR record
  and stub. Deliver state/refusal tables for every occurrence/ack/recovery/retry/
  deletion/backfill path, causal recovery proof, locks and writer ownership, legacy
  endpoint compatibility, retry request/child idempotency and downstream-effect crash
  windows, failure-stage admission evidence and rollback matrix. Logging: none.
- [ ] **UX-T24. Specify shared intake qualification and authoritative admission.** Depends: UX-T01, UX-T03.
  Paths: `docs/system-analytics/triage.md`, `tasks.md`, task-intake qualification
  reference (new), task/agent DB domains, API/SSE contracts, MCP schemas, screen and
  EN/RU copy specs, new ADR. Freeze UX-D11 schema/state tables, project policy and
  legacy cutover, complete writer/launch inventory, repository SHA provenance,
  input invalidation, retention and exact capability floor. Distinguish business
  disposition from operational failure. Primary UX-AC11; logging: none.
- [ ] **UX-T04. Freeze executable acceptance traceability.** Depends: UX-T02, UX-T03, UX-T24.
  Paths: new `docs/system-analytics/agent-activity-traceability.md`,
  `scripts/validate-requirement-coverage.mjs` and its existing tests, `package.json`
  only if adding the follow-up validation alias; actual Vitest/Playwright config.
  Map UX-AC01–11 and UX-IT01–20/UX-E2E01–04 to requirements, tasks and one primary
  test each; add group-scoped UX-T parser support without weakening the original operational group.
  Prove nonempty runner discovery and negative coverage validator fixture. Gate:
  all design questions below resolved or bounded as stated; no contradictory tables
  or unowned migration writer. Future behavior stays Designed. Logging: none.

**Checkpoint P0:** `docs(agents): specify activity history and grouped incidents`.
All canonical specs complete and internally consistent; docs/contracts/traceability
validators green. No feature implementation before this gate. Migration-number
integration, if needed, is a distinct preparatory commit with its own evidence.

### Phase 1 — Durable identity and incident lifecycle

- [ ] **UX-T05. Add frozen identity and additive persistence.** Depends: UX-T04.
  Paths: `web/lib/db/schema.ts`, generated migration SQL/journal/snapshot,
  `web/lib/agents/launch.ts`, `launch-contract.ts`, new
  `web/lib/agents/activity-snapshot.ts`, generated `docs/db/erd.dbml`.
  Freeze source identity/immutable launchedAt for both standalone and flow-driving
  launches; add retry intent/lineage constraints in its separately allocated
  migration. Do not mutate completion
  contracts on existing runs. Implement constrained indexes/FKs and nullable legacy
  boundary. Primary: UX-IT01. Logging: snapshot/backfill versions and row counts,
  never config values. Gate: fresh/incremental schema and source identity, immutable launch time and unique retry lineage invariants.
- [ ] **UX-T06. Implement incident transitions in lifecycle owners.** Depends: UX-T05.
  Paths: new `web/lib/runs/agent-incidents.ts` (pure classification separated
  from transaction application), existing `operational-attention.ts`,
  `web/lib/agents/finalization.ts`, `create-failure.ts`, reconcile/terminal owners
  discovered by the Phase-0 writer inventory, `web/lib/gc/operational-disposition.ts`,
  `web/lib/domain-events/taxonomy.ts`. Include eligible legacy execution failures without converting their kinds, safe
  terminal/command diagnostics and durable admission-attempt source facts.
  Scope normalizers must reuse existing trigger
  and config contracts. Primary: UX-IT02–04. Atomic CAS+occurrences+event, replay
  uniqueness, consistent lock order, zero filesystem work in tx. Logging: episode
  created/recovered, source fact/reason/count; duplicates DEBUG only.
- [ ] **UX-T07. Implement cutover backfill and compatibility.** Depends: UX-T05, UX-T06.
  Paths: existing maintenance/upgrade infrastructure, new bounded backfill module
  alongside incident service, legacy acknowledgement route/service, migration tests.
  Preserve exact legacy ack meaning, backfill identity then deterministic episodes,
  seed notification baseline, persist page progress, verify facts/counts before
  cutover. Primary: UX-IT05. Exercise crash between page commit and next invocation,
  poison row, missing evidence, old reader behavior and catalog/run deletion.
  Logging: processed cursor/count/version, refusal context; no historical message
  dumps. Gate: no unchecked/unprocessed actionable facts hidden by new readers.

- [ ] **UX-T19. Settle known launch failures and retain unknown-outcome recovery.** Depends: UX-T05, UX-T06.
  Paths: `web/lib/agents/launch.ts`, `finalization.ts`, `create-failure.ts`,
  `web/lib/scheduler.ts`, `web/lib/reconcile.ts`, owned create/prompt owners,
  `web/lib/runs/terminal-cause.ts`, existing trigger attempt ledger. Primary:
  UX-IT13. Add narrow Pending failure preparation, close post-insert/microtask
  exception gaps, record safe stage/runner diagnostics and pre-run scheduler
  refusals. Unknown host creation remains under existing reconcile; no force-fail
  or duplicate spawn. Prove scheduler-vs-failure race and crash window. Logging:
  owned command/generation, failure stage/reason and actionable recovery state.

- [ ] **UX-T25. Persist qualification policy, inputs and immutable assessments.** Depends: UX-T05, UX-T24.
  Paths: `web/lib/db/schema.ts`, additive migration/journal/snapshot/ERD,
  `web/lib/tasks/qualification.ts` (new), project configuration schemas/apply,
  `services/tasks.ts`, statement/clarification/source-update owners. Implement
  explicit legacy policy, required-input revisions, CAS/idempotency and atomic
  invalidation with bounded queries. Primary UX-IT18. Log task/revision/decision
  IDs and invalidation reasons, never task bodies; migration validation required.

**Checkpoint P1:** `feat(agents): persist activity identity and incident episodes`.
RED/GREEN/refactor receipts, full web unit and integration suites green, migration
journal/snapshot parity, no residual generation delta, docs/ERD synchronized.

### Phase 2 — Queries, APIs and live projection

- [ ] **UX-T08. Build bounded project-agent summary/history/detail queries.** Depends: UX-T05, UX-T07.
  Paths: new `web/lib/agents/activity-queries.ts`, `project-links.ts`,
  `web/lib/run-results/operational-projection.ts`, project agent route GETs and
  new `runs/route.ts`, `definition/route.ts`, `incidents/route.ts` under
  `web/app/api/projects/[slug]/agents/[agentId]/`. Reuse auth/attachment helpers;
  history survives missing current definition. Primary: UX-IT06, UX-IT07. One batched
  summary, keyset history, independent grants and safe DTOs. Logging: typed refusal
  context via existing HTTP boundary, no per-row logs. Record EXPLAIN evidence for
  the index-backed path with 10,000 retained runs, bounded page results and no N+1.
- [ ] **UX-T09. Project one canonical decision and add episode acknowledgement.** Depends: UX-T06, UX-T07, UX-T08.
  Paths: `web/lib/runs/operational-attention.ts`, `web/lib/queries/decisions.ts`,
  new project-scoped incidents/acknowledge route, external decisions route,
  `mcp/src/tools.ts` and DTO consumers. Primary: UX-IT08. Group before sorting/count;
  route body schema/grants/CAS, per-reader seen semantics, legacy endpoint remains
  exact, representative run not mutation authority. Logging: reader/episode/revision
  accepted/refused, no diagnostic body. Reuse existing decision grants for read;
  preserve the existing `answerHitl` capability for authenticated human self-ack;
  cleanup retry retains `recoverRun` and memory/settings retain `editSettings`.
- [ ] **UX-T10. Complete durable activity invalidation and quiet notifications.** Depends: UX-T08, UX-T09.
  Paths: launch/scheduler/park/resume writers (only invalidation seams),
  `web/app/api/attention/stream/route.ts`, `web/lib/notifications/attention-consumer.ts`,
  `web/lib/notifications/digest-trigger.ts`, existing webhook outbox, reader-state
  schema, taxonomy and shared attention refresh. Primary: UX-IT09. Scan durable activity
  facts with existing cursor, detect content change under same count/group ID,
  notify only newly actionable episodes and preserve user-specific acks. Persist
  per-user publication receipts separately from acknowledgedAt and qualify the
  shared system_sweep retry at count 1→1. Audit all
  Pending/start/park/resume/stop/crash paths. Logging: existing structured cursor/
  lag/refusal diagnostics; no new poller or notify-on-every-repeat event stream.

- [ ] **UX-T20. Implement explicit safe rerun with one-off runner override.** Depends: UX-T05, UX-T08, UX-T10, UX-T19.
  Paths: new `web/lib/agents/retry.ts`, new run retry-options/POST/status routes,
  `launch.ts` reserved-identity seam, existing runner resolver/create-command
  dispatcher, `scheduler/system-sweeps.ts`, materialization/context mutex and orphan-GC
  ownership guards, retry intent migration from T05.
  Implement UX-D09 safety preview, source/actor/payload guards, durable intent,
  fenced allocation/adoption and immutable accepted recipe, delayed authority/task/config
  revalidation, atomic successor receipt and original trigger provenance without event redelivery.
  Primary: UX-IT14–15. No default change, task reset, cross-run ACP resume or
  speculative replay of partial effects. Logging: source/intent/successor/runner
  IDs, state/refusal and lease retry; never prompt or credential bodies.

- [ ] **UX-T26. Enforce qualification at triage and every task launch boundary.** Depends: UX-T25, UX-T19.
  Paths: `services/triage.ts`, `runs/launchability.ts`, `services/runs.ts`,
  scheduler admission/auto-launch handlers, ext task/triage and UI routes,
  `mcp/src/tools.ts`, task read models, `agents/launch.ts` task_target resolver.
  Add atomic qualification/verdict/enqueue plus safe read-only evidence context,
  exact-SHA launch, stale Pending dispatch refusal and explicit current-data APIs.
  Primary UX-IT19; audit all force/schedule/agent paths and permissions. Log typed
  refusals/input/evidence revisions. No shell approval bypass or guessed validity.

**Checkpoint P2:** `feat(agents): expose scoped history and grouped attention`.
Full web unit/integration suites green; API contracts and affected MCP tests/build
green; SSE catch-up and negative grant cases executed, not merely mocked selectors.

### Phase 3 — User surfaces and localization

- [ ] **UX-T11. Render all active agent executions in the rail.** Depends: UX-T08, UX-T10.
  Paths: `web/lib/queries/portfolio.ts`, `web/lib/queries/project.ts`, project and portfolio
  working-copy components, new agent activity read model/DTO as needed,
  `web/app/(app)/layout.tsx`, `web/components/chrome/left-rail.tsx`, shared rail
  sections/nav/mobile components and EN/RU catalogs. Primary: UX-IT10, UX-E2E01.
  Separate explicit active set from slot/retention sets; require real workspace
  rows for all working-copy surfaces, render exact localized status and actual
  availability, expose active executions separately; preserve review workspaces
  and no global inaccessible occupancy. Keyboard,
  collapsed/mobile parity, text/icon state, authorized Stop/run links. Logging: none.
- [ ] **UX-T12. Add project summary and dedicated agent page.** Depends: UX-T08, UX-T10.
  Paths: project page DTO mapping, `agents-attach-panel.tsx`, new
  `web/app/(app)/projects/[slug]/agents/[agentId]/page.tsx`, loading/error boundaries,
  new `web/components/agents/` page components, existing memory drawer/editor and
  settings modal, EN/RU catalogs. Primary: UX-E2E02. URL tabs/filters/cursors, prompt
  read grant, read-only historical mode, typed unavailable/error/reconnect/empty
  states, focus restoration and accessible update feedback. Reuse memory CAS;
  never expose a wrong-pin Studio link. Logging: none beyond shared HTTP errors.
- [ ] **UX-T13. Render grouped Inbox incidents and remediation.** Depends: UX-T09, UX-T10, UX-T12.
  Paths: `web/components/inbox/decision-card.tsx`, `decision-sections.tsx`,
  `web/app/(app)/inbox/page.tsx`, new focused incident details/ack component,
  EN/RU catalogs. Primary: UX-E2E01 plus service coverage UX-IT08.
  Show agent/project, count/first/last, distinct causes and page link; bounded
  cause expansion, per-user acknowledgement, individually targeted cleanup retry.
  Localize reason/status/remediation headings; never dump raw reason codes as main
  text. Preserve separate HITL cards and request-scoped response controls. Logging:
  no render logs; mutations use UX-T09 owner.

- [ ] **UX-T21. Add runner-aware failure and rerun UX.** Depends: UX-T12, UX-T13, UX-T20.
  Paths: agent history/details and Inbox incident component, run details controls,
  existing runner picker/attachment settings modal, shared mutation feedback,
  EN/RU catalogs. Show failure stage and source runner, retry safety/refusal,
  current-input differences, accepted intent/queued successor and source lineage.
  Keep one-off launch separate from editSettings-only future default. Primary:
  UX-E2E03. Preserve current task-delivery runner and distinct clarification/requeue
  actions. Safe one-click intent replay after lost response; no silent second run.
  Logging: existing mutation boundary only.

**Checkpoint P3:** `feat(ui): add agent activity history and quiet Inbox`.
Full owning web suites and focused Playwright EN/RU scenarios green with zero
retries/leaks; collapsed/mobile/keyboard cases executed; no terminal operational
rows, no hidden active executions or review regressions.

### Phase 3b — Core triager package adoption

- [ ] **UX-T22. Adopt operational completion in core:triager and qualify exact package.** Depends: UX-T19, UX-T20, UX-T21.
  Ownership: maister-plugins `packages/core/maister-agents/triager.md`, core
  manifest/README and platform triager fixture/fixture manifests. Preserve original
  intake changes on the plugin working branch. Update kind, strict result/count
  instructions and ask→same-run continuation (`reTriggerMode: agent`); keep explicit
  requeue and downstream Flow runner semantics. Primary: UX-IT16–17. Package
  parser/launch/wire and exact clean package revision install/attach controlled-run
  qualification, including unchanged approval policy and old snapshots. Logging:
  existing package/launch/result boundaries, no new polling or provider fallback.
  Commit platform fixture tests and package changes separately; record both SHAs.

**Checkpoint P3b:** `feat(core): make triager an operational agent` in maister-plugins;
platform fixture/compatibility receipt commit. No publication or live GitHub calls.

### Phase 3c — Shared intake qualification

- [ ] **UX-T27. Deliver Incoming UX and one shared qualification package skill.** Depends: UX-T22, UX-T26, UX-T12.
  Paths: `web/lib/work/stage.ts`, board/project/task queries and components,
  task detail/qualification controls, settings/config UI, EN/RU catalogs;
  canonical core triager, both intake definitions/shared skill and new shared
  task-qualification skill, package capabilities and fixture mirrors. Partition
  Incoming vs accepted backlog, show evidence/freshness/reasons, preserve original
  issue body and local clarification, wire policy capability refusal and current
  qualifier definition. Primary UX-IT20/UX-E2E04. Log only existing mutation events.

**Checkpoint P3c:** `feat(triage): qualify incoming requests before backlog admission`.
Complete owning web suites, exact candidate core install/attach and shared skill resolution pass; both transport
variants, required project policy and operational completion are qualified together.

### Phase 4 — Conformance, integration and release qualification

- [ ] **UX-T14. Close lifecycle and permission regressions across surfaces.** Depends: UX-T11–UX-T13, UX-T19–UX-T22.
  Paths: existing operational integration suites, memory/launch/scheduler/decisions
  suites and `web/e2e/platform-agents-operational.spec.ts`; new project-agent-page
  browser spec if the existing suite would become unfocused. Primary: UX-IT11,
  UX-IT12 and complete UX-E2E01–02. Test cancellation, checkpoint/resume, independent
  concurrent permission requests, crash/recovery, cleanup exhaustion/release and
  code-delivery review/promotion using existing controlled runtime. Do not duplicate
  all original source-integrity tests; retain them as regressions. Logging: harness
  evidence only. Repair any gap through its owning spec/test/code slice.
- [ ] **UX-T23. Verify failed-runner and rerun composition end to end.** Depends: UX-T14, UX-T22.
  Primary: UX-E2E03 plus UX-IT13–17 owning suites. Qualify bad-runner→terminal
  diagnostic→one Inbox card→new ready runner→one linked successor→structured Done;
  project/portfolio/rail counts agree. Include real DB concurrency, unknown-create
  refusal, partial triage mutation refusal and same-run human continuation. Do not
  turn a generic manual launch or triage-reset into evidence for safe retry.
  Paths: existing operational/project history E2E and triager wire suites,
  follow-up traceability/qualification receipt. Logging: harness evidence only.

- [ ] **UX-T28. Qualify task-quality admission and source-to-work composition.** Depends: UX-T27, UX-T23.
  Run UX-IT18–20/UX-E2E04 through actual creation/triage/launch APIs, Postgres,
  controlled read-only ACP and both importer transport fixtures. Assert task edit,
  answer, target/SHA and policy races; unknown evidence vs non-actionable result;
  manual/force/scheduler/MCP denial and accepted ready path. Reuse current HITL,
  integrity/cleanup and code-delivery regression suites. Logging: test receipts only.
- [ ] **UX-T15. Reconcile current docs and API/MCP compatibility.** Depends: UX-T14, UX-T23, UX-T28.
  Paths: all Phase-0 docs, `docs/screens/README.md` and domain indexes,
  `site-docs/concepts/`/`guides/` affected agent/operations pages and RU counterparts,
  API schemas, mcp explicit DTO/tool documentation, traceability matrix, this plan.
  Mark only qualified pieces Implemented. Publish opt-in grouped external API and
  legacy projection compatibility; there is no silent v1 nullability/action-semantic
  change. Publish retained-history vs incident
  occurrence-count semantics, prompt edit boundary, detach/unknown identity behavior,
  notification and ack semantics. Logging: none. Include triager package compatibility and rollout; no new custom
  operational output schema.
- [ ] **UX-T16. Qualify migration/release compatibility against current base.** Depends: UX-T14, UX-T15.
  Recheck base/journal/ADR allocation and budgets for renumbering at integration;
  do not reuse the old original-plan conflict-free receipt. Run fresh+incremental+
  interrupted backfill proof, authorized role probes, frozen snapshot stability and
  additive rollback drill on disposable DBs. Paths: migration tests, deployment/
  upgrade documentation, qualification receipts. Logging: existing maintenance
  progress and refusal logs. Confirm no new env/compose/Docker/runtime dependency
  needed. If wiring changes emerge, add an explicit wiring task before release.
- [ ] **UX-T17. Verify the complete acceptance matrix and review the final diff.** Depends: UX-T16.
  Read final diff against the integrated base for spec/code/schema parity, safety,
  source preservation, role leakage, query bounds, lifecycle writer coverage and
  SOLID/KISS/DRY. Record exact runner discovery and source identity for every primary
  test. Run full required suites/contracts/docs/ERD/MCP/browser gates; all required
  tests pass without skips/retries/relaxed invariants. No aggregated old failed run
  receipt is described as a fresh fully green invocation. Logging: evidence only.
- [ ] **UX-T18. Commit qualified delivery and hand off release order.** Depends: UX-T17.
  Mark completed tasks/criteria only with receipts; record phase commits, limits,
  deployment ledger premise and owner steps. Keep branch clean. Release order:
  reconcile base → maintenance/drain → additive schema and resumable backfill →
  compatible platform/MCP → scoped smoke → reopen admission → updated core
  package publication and explicit attachment pins (owner actions). Include the
  triager and both original intake variants in the same compatible core candidate. No
  push/deploy/tag execution. Logging: none.

**Checkpoint P4:** `test(agents): qualify activity history and incident lifecycle`,
then a small documentation/handoff commit only if needed. Do not squash away RED
and migration evidence; never mark unchecked deployment premises as executed.

## Minimum meaningful coverage and acceptance evidence

Tests are added to the **owning phase**, not delayed to Phase 4. Extend current
suites rather than mirror implementation with dozens of helper tests. Pure unit
coverage is justified only for fingerprint/cursor/status transformations; primary
acceptance uses real Postgres and actual route/runtime boundaries. Controlled ACP
fixtures are appropriate; no paid GitHub mutation is needed to exercise these UI
and ledger contracts. Each test ID has one primary owner, with a small browser
composition proving wiring, not re-running the whole matrix.

| Primary ID | Requirement / behavior and edge cases | Actual test owner / runner |
| --- | --- | --- |
| UX-IT01 | AC01/06: both launch seams snapshot ID; update/detach/delete/reattach; legacy proven/unknown/conflicting identity; fresh/incremental index/constraint parity | Existing `web/lib/agents/__tests__/launch-config-snapshot.integration.test.ts`, `agent-driven-flow.integration.test.ts` and migration integration fixture; Vitest integration, task T05 |
| UX-IT02 | AC04: 1,000 repeats, multiple causes/scopes/projects, partial/403/missing/malformed result, distinct-run vs cause counts, no Task creation | Extend `web/lib/runs/__tests__/operational-attention.integration.test.ts`; Vitest integration, T06 |
| UX-IT03 | AC05: simultaneous finalizers, replay, transaction rollback/process restart, overlapping/late success, zero-work recovery, reopened episode, safety reasons never auto-clear | New focused `operational-incidents.integration.test.ts` beside existing run suites; real DB separate connections, T06 |
| UX-IT04 | AC05: exhausted/rearmed/re-exhausted/released cleanup with two resources sharing one cause (one release cannot close both), partial disposal, cancellation and crash retained evidence; terminal/resource state and occurrence commit atomically | Extend `web/lib/gc/__tests__/operational-disposition.integration.test.ts` and actual finalizer owner; Vitest integration, T06 |
| UX-IT05 | AC01/06: interrupted/backfilled pages, no duplicate occurrence, existing per-run acks, unknown scope, catalog/run/user deletion, archived project, no historical notification storm | Migration/backfill integration suite using repository migration harness; T07 |
| UX-IT06 | AC03: batched summary, retained total/active/last-launched/last-completed, flow-driving/manual/scheduled/delegated population, equal timestamps, bounded keyset/filter cursor, no N+1 | Existing `project-links.integration.test.ts` + new activity-queries integration owner; T08 |
| UX-IT07 | AC03/07: real GET/grants contract, cross-project/cursor forgery, readRepoFiles vs membership, deleted/untrusted pinned definition, no latest-pin fallback, memory CAS regression | Existing route integration folders + memory route owner; T08 |
| UX-IT08 | AC04/07: group/badge/opt-in REST/MCP parity plus legacy default DTO; per-user ack repeat/replay; new cause racing ack; old per-run ack does not suppress future repeat; scoped cleanup action | Existing decisions, external decisions and operational attention route integration; MCP contract tests; T09 |
| UX-IT09 | AC07: taskless Pending→Running→park/resume→terminal, equal-count updated group, reconnect/cursor replay, access loss, new-cause one notification vs repeat zero, publication rollback and backstop replay at count 1→1 | Existing attention stream + notification consumer integration suites; T10 |
| UX-IT10 | AC02: all active statuses/modes and flow-driving pool distinction, simultaneous runs, terminal exclusion, workspace dedup and code Review/retained-workspace parity | Existing portfolio/project query integration suites plus focused rail DOM tests; T11 |
| UX-IT11 | AC02/05: two real independent permission requests, parked checkpoint/resume, stop/crash recovery free slots and update visibility; no autoapproval, no grouped HITL | Existing permission/queue/supervisor operational integration owners; T14 |
| UX-IT12 | AC01/02/05: run snapshot stable through pin update; original source materialization/integrity and cleanup guards stay green; code-delivery Review/promotion unaffected | Existing launch/result/integrity/finalization/promotion suites; T14, reuse not duplicate |
| UX-E2E01 | AC02/04/07: EN/RU active rail in expanded/collapsed/mobile, Pending and no-worktree row, SSE disappearance, one live failure card, ack then quiet repeat/new cause, separate HITL controls | Extend `web/e2e/platform-agents-operational.spec.ts`; Playwright repo runner, T11/T13/T14 |
| UX-E2E02 | AC01/03: summary→page→second page→run, URL tabs/back/forward, new-run refresh, role gates, memory CAS error/success, unavailable definition and detached read-only state | New `web/e2e/project-agent-history.spec.ts`; Playwright repo runner, T12/T14 |
| UX-IT13 | AC08: no-run admission refusal, post-INSERT Pending failure, scheduler race, dispatch exception, unknown create ACK, restart/reconcile, provider failure stage and immutable launchedAt | Extend agent-queue-terminal/create-failure/finalization/owned-create integration owners; real PostgreSQL and controlled supervisor, T19 |
| UX-IT14 | AC09: retry preconditions, source/context scope, selected runner readiness/grants, current-config fingerprint, old snapshot unchanged, stale task/partial effects refuse | New `web/lib/agents/__tests__/retry.integration.test.ts` plus actual run retry route integration; T20 |
| UX-IT15 | AC09: same/different-key concurrency, payload conflict, one successor, original event dedup intact, crash before allocation/after allocation/before receipt/after receipt, expired lease/stale worker/concurrent sweep, owned allocation adoption vs foreign bytes and orphan GC, post-acceptance pin/kind/config/task/grant drift before and after allocation, cleanup exhaustion, refused-intent reprepare and queue admission | Same retry integration owner with separate DB connections and owned dispatcher fixtures, T20 |
| UX-IT16 | AC10: real core parser/install/attach snapshots, verdict + enqueue, duplicate/human flag and flagged no-op, blocked/partial/missing/malformed result | Existing triager-definition/package/wire suites; actual compatible package qualification, T22 |
| UX-IT17 | AC10: ask→park→answer→same-run continuation, no task.triage_requeued duplicate; explicit requeue still launches once; old code-delivery source and task Flow runner unchanged | Existing agent-question + triager-wire integration owners, T22 |
| UX-E2E03 | AC08–10: 20 failed rowless triagers vs zero working copies; safe bad-runner attempt→failure details→choose B→one linked successor; defaults/member/admin separation; unknown/partial refusal; EN/RU | Extend project-agent-history and operational browser composition using real route/DB/runtime fixtures, T21/T23 |
| UX-IT18 | AC11: legacy/required project and task migration, input revision writers, idempotency/CAS, qualification pointer/policy constraints, no fabricated legacy pass, no source mutation | Migration integration plus new tasks/qualification integration suite, T25 |
| UX-IT19 | AC11: valid/unclear/contradictory/duplicate/already-satisfied/unknown bug; actor and evidence grants; stale task/answer/SHA, same-input human-vs-agent assessment CAS, real run_plan/delegate inherited admission vs forged/invalid parent and no abandoned DAG, concurrent triage, exact checkout, every manual/force/schedule/MCP/admission path and stale Pending dispatch | Extend triage/launchability/queue admission/agent checkout integration owners with real DB/routes, T26 |
| UX-IT20 | AC11: both import transports capture Incoming with provenance, no-repeat import/questions, one shared qualification skill; capability/policy refusal; normal flag/clarification vs runner failure; exact core snapshots and no automatic GitHub mutation | Existing intake and triager package/wire integration suites, T27 |
| UX-E2E04 | AC11: GitHub request→Incoming→specific local clarification→current evidenced qualification→accepted Backlog→explicit enqueue; held/obsolete evidence view, stale edit, EN/RU/grants and counts; runner failure separate from request rejection | One browser composition in existing task/intake E2E owners with controlled runtime, T28 |

Runner gate: confirm actual discovery via Vitest list and Playwright `--list` with
repository configs; the `--passWithNoTests` script flag is not evidence. Every
behavior phase exits with `pnpm --filter maister-web test:unit` and
`pnpm --filter maister-web test:integration` fully green. Run affected suites
while iterating; repeat broad gates at the named phase checkpoints, not after each
formatting edit. A harness failure is not valid RED. Existing source assertions
expecting one item per run, workspace-only rail or raw reason text must migrate in
their owning phase (`operational-attention`, `decisions`, external route, rail and
Inbox suites), never be deleted/skipped to hide defects. User-required functionality
cannot be quarantined. Record unrelated blockers accurately and resolve before
claiming all acceptance green.

Final gates include web TypeScript and changed-file lint without unsolicited
`--fix`, affected supervisor suites if writer seams change, MCP typecheck/tests/build,
`pnpm validate:contracts`, `pnpm validate:docs:all`, public EN/RU doc links/build,
requirement coverage including the original operational group, migration integrity,
generated ERD check and no-delta Drizzle generation. Record commands, exact SHA/diff,
platform, discovered test titles, RED assertion, GREEN totals, refactor reruns and
limits. Hosted CI and production acceptance require their own receipts later.

## Open questions and explicit defaults

No unresolved product decision blocks implementation under this plan. The defaults
above choose separate active execution lists on rail/project/portfolio, truthful physical working
copy counts, one Inbox group, per-reader episode acknowledgement, conservative
same-scope recovery, safe new-attempt runner substitution, triager operational
adoption, shared task qualification through Incoming, and read-only current prompt. They are deliberate
choices, not claims the user requested every storage detail.

Two evidence questions are gating implementation/release, not questions to invent
answers to while planning:

1. **Applied migration inventory:** have the branch's current 0194–0198 migrations
   reached any non-disposable database? UX-T01 obtains actual deployment/ledger
   evidence. Until proved otherwise, do not rewrite applied migrations. A supported
   upgrade from such an installation needs an explicit reconciliation fixture.
2. **Moving base:** the current collision was resolved in the authorized rebase. UX-T01/UX-T16
   recheck the authoritative integration base before reserving final identifiers;
   today's local numbers are provisional. The user owns remote integration/release.

Bounded limitations: no automatic resolution across incomparable configuration or
unknown legacy scope; no reconstruction of missing historical prompts/identity;
no new prompt editing/fork flow, no external history mutation tool, no lifetime
metrics independent of retention, and no attempt to make concurrent GitHub imports
exactly-once. These do not weaken the active visibility, grouped attention or
history requirements of this follow-up.

## Planning verification

The initial activity plan received two bounded read-only reviews. This extension
received separate package, runtime and UI/API investigations against the rebased
code, then bounded review of retry and qualification decisions. Incorporated fixes:
mandatory retry lease/fence and allocation adoption, immutable accepted recipe and
delayed authority revalidation, concurrent-assessment pointer CAS, safe existing
orchestrator decomposition, qualifier access to held intake, human-provided runtime
proof beyond read-only inspection, and preservation of existing GitHub receipts.
Runtime and UI reviewers confirmed no remaining blocker in the corrected retry and
assessment/decomposition boundaries. Package review's two concrete contradictions
were corrected; no claim of executed feature acceptance follows from these reviews.

Plan checks: 28 unique unchecked tasks, 11 acceptance contracts, acyclic dependency
graph, primary integration/browser owners and diff-whitespace validation. The
original completed delivery body remains byte-identical to the rebase commit;
only the active follow-up and its historical bridge changed. Rebase code/schema/
documentation validation is recorded below. No activity, retry or task-qualification
feature behavior, new migration or triager package change has been implemented.

---


## Rebase receipt and follow-up qualification boundary

Base `420f432b21ea190635b949dfeac22c36cdc940ec` was verified against GitHub master;
SSH fetch failed authentication, so the connected GitHub API supplied the current
SHA, already present locally. The original plan was committed before rebase and
retained on the safety branch. All 15 commits replayed; integration reconciliation
is `d81a04728`. Master ADR-194 and migrations 0194–0198 remain intact; operational
ADR-195/migrations 0199–0203 append after them. No operational SQL body changed.

Local validation: web TypeScript; migration journal unit 19/19; fresh schema plus
incremental operational migration/cleanup integration 31/31; requirement validator
9/9 and both branch/master coverage groups; ADR anchors and docs/ERD validation;
Drizzle generate has no residual schema delta. Schema/ERD now contain 133 main
PostgreSQL tables and 144 consolidated tables including other documented domains.
No deployed database, hosted CI, remote branch, package release or live GitHub
operation was changed. This focused rebase proof is not acceptance of the planned
activity/retry/triager feature or a fresh full-product suite receipt.

## Historical operational-agent delivery

The following original plan is retained as completed historical evidence. Its
settings, numbering and base checks apply to that delivery, not the active UX tasks.

# Original Implementation Plan: Operational agents and explicit completion contracts

Branch: `feature/operational-agent-kind`

Created: 2026-10-29

Status: Complete; T1–T21 implemented and locally verified. Acceptance aggregation, retained scope limits and release handoff are recorded below. No push, tag, release or deployment was performed.

## Settings

- Testing: yes; TDD for every behavior slice, with RED → GREEN → REFACTOR receipts and minimum meaningful integration/E2E coverage, extending existing suites.
- Logging: standard structured logging, as confirmed by the owner. INFO for lifecycle decisions, WARN for recoverable refusals, ERROR for failed execution/cleanup; existing `LOG_LEVEL` controls optional DEBUG detail. Never log credentials or unrestricted API bodies.
- Docs: yes; a design checkpoint precedes implementation, with an as-built consistency check before completion.
- Repository changes during planning: this plan only. No implementation, tests, deployment, package release, push, or tag creation.
- Full planning used three read-only investigators, as required by `aif-plan`.
- Refinement: SDD/TDD requirements incorporated through `aif-improve`; this pass edits this plan only. All implementation tasks remain unchecked.

## Delivery contract: SDD first, TDD in every implementation slice

The sequence is **specified requirement → canonical contract → failing acceptance test → implementation → green owning suite → behavior-preserving refactor → specification conformance review**. A task is not complete merely because its code or checkbox exists.

1. **Specification gate (T1–T3):** finish and reconcile the operational analytics, complete API/event payloads and examples, persistence invariants/migration design, refusal/recovery tables, and bidirectional requirement matrix before application implementation. Mark future behavior Designed. The plan schedules this work; this refinement does not author or claim acceptance of those specs.
2. **RED:** for each T4–T16 behavior slice, select its requirement/edge IDs and write or extend its primary boundary test first. Run it against the previous implementation and retain the actual failing assertion and revision. A timeout, unavailable Docker/provider, broken fixture, wrong runner glob or missing test dependency is a harness refusal, not RED. An intentional schema-presence assertion is a valid migration RED; an unrelated SQL setup error is not. No production behavior is changed before the owning RED is demonstrated.
3. **GREEN:** make the smallest implementation that satisfies the frozen contract. Run the owning scenario, relevant existing regressions, then the full owning unit/integration suites at the phase checkpoint. Cover positive grants as well as refusals. Do not change an expected result to match a defect, delete required cases, add skips, or relax caps, deadlines or safety invariants to obtain green.
4. **REFACTOR:** only after green, simplify duplication and clarify types/functions within the feature's changed code. Keep tests green and re-run affected owners after every behavioral correction. Use pure single-purpose decisions composed with explicit effectful boundaries; apply SOLID where relevant, KISS and DRY without introducing a framework, OOP hierarchy, fallback, adjacent refactor or new dependency for this feature. Follow existing repository conventions, strict types, English comments, structured logging, MaisterError codes and atomic writes.
5. **Conformance:** compare implemented transitions, DB constraints/writers, HTTP/MCP/SSE payloads and refusal paths to the same requirement IDs. A design change updates its owning spec and acceptance test before implementation proceeds. Raw agent claims cannot amend the platform contract.
6. **Evidence:** record requirement IDs, exact command/test titles, source SHA or worktree diff identity, platform/runner, observed RED reason, GREEN counts and zero skips, refactor re-run, and remaining limits. Keep records in the implementation's existing review/qualification evidence area; do not create a new test framework or use chronological receipts as canonical product documentation.
7. **No late test phase:** T19 aggregates and re-runs already implemented acceptance coverage. Each earlier behavior task owns its tests, fixtures, runner registration and migrated assertions. T18 owns only the package/platform composition boundary; it does not repeat every lifecycle permutation through an LLM or browser.
8. **Release gate:** all requirements and edge rows have executed primary tests, the complete owning suites and required E2E/contract/doc/migration gates are green, and no safety question is left to the implementer. Unrelated pre-existing failures are reported explicitly and resolved as blockers or by an owner-approved scope decision; they are never silently quarantined to claim full acceptance.

## Roadmap Linkage

Milestone: `none`

Rationale: Skipped by user; track this as a separate cross-repository feature until explicitly linked.

## Goal and boundaries

Introduce an explicit operational agent kind for work whose deliverable is an external/platform operation and its evidence. Adopt it for both GitHub issue intake variants. Preserve default code-delivery behavior, permission policy, isolation, and governance.

Included: agent/package schemas and compatibility, catalog and Studio, immutable launch contracts, structured results, lifecycle/recovery/HITL, source-integrity enforcement, workspace cleanup and evidence retention, UI/history/attention, API/MCP contracts, EN/RU copy, and the necessary `maister-plugins` changes.

Excluded: linked-PR filtering, credential management, a new GitHub importer, arbitrary-shell auto-approval, automatic promotion of empty diffs, retroactive reclassification of old runs, new run statuses, and a general external-side-effect transaction engine.

## Verified baseline and repository ownership

| Repository | Inspected state | Ownership in this plan |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| MAIster | `/Users/kaa/.codex/worktrees/e790/mAIster`; `4a0b41b2e1911b9ad5adda250f1b8a937b0daf46`; initially clean detached HEAD. Local `master` and `origin/master` resolved to this SHA. Planning branch created from that exact state. | Platform contracts, DB, supervisor seams, runtime, UI, MCP, compatibility validator, tests and platform documentation. |
| maister-plugins | `/Users/kaa/Work/dev/github/maister-plugins`; clean `main...origin/main`; `0bab5fa5bd41ff825e160ed5a998412c2537c29e`. No applicable AGENTS.md/CLAUDE.md found there. | `packages/core` intake definitions, shared skill and package documentation/compatibility declaration; existing release wrapper. |

These are local verified revisions, not a fresh remote-state assertion. Recheck both repositories and their instructions before implementation. The plugin checkout is outside this worktree; make its edits in an explicitly selected writable checkout during implementation. Releases and remote mutations remain owner actions unless separately authorized.

## Evidence map

References are repository-relative unless prefixed `plugins:`. Line numbers refer to the inspected revisions above.

| ID | Verified source | Consequence |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1 | `web/lib/agents/definition.ts:267-343,349-481`; `web/lib/db/schema.ts:894-949`; `web/lib/agents/registry.ts:118-157,216-245` | Strict frontmatter has workspace/mode but no purpose/completion kind. Registry resync projects fields; invalid definitions are report-only. |
| E2 | `web/lib/agents/effective.ts:59-149`; `web/lib/agents/project-links.ts:304-353`; `web/lib/packages/attach.ts:326-351` | Effective definition comes from the project's trusted attached install, not the newest catalog projection. Agent registration currently cannot fail surrounding attachment. |
| E3 | `web/components/flows/artifact-editors/frontmatter-artifact-editor.tsx:589-635`; `web/components/studio/agent-view.tsx:90-94`; `web/lib/flows/artifact-validate.ts:132-154`; `web/lib/local-packages/validate.ts:294-302`; `web/lib/agents/admin-shared.ts:80-104` | Studio, local validation and explicit DTO projections must carry the new axes. |
| E4 | `web/lib/agents/launch.ts:1021-1054,1318-1344,1388-1430,3373-3401,3673-3686`; `web/lib/db/schema.ts:1835-1841,2084-2090` | Own worktrees exist; workspace/policy/config/result are snapshotted. Spawn still rereads effective definitions. Read-only access and permission auto-approval are separate decisions. |
| E5 | `supervisor/src/acp-client.ts:147-178,548-578`; `web/lib/agents/dirty-watchdog.ts:62-67` | `none/repo_read` deny non-read tools, including Bash materialization. Operational worktree use can retain normal shell/HITL without changing approval policy. |
| E6 | `web/lib/agents/finalization.ts:190-203,347-392,561-596`; `web/lib/agents/prompt-owner.ts:650-687,764-811`; `web/lib/agents/launch.ts:4071-4148` | Workspace presence chooses Review. Required results already validate before terminal CAS and publish in its transaction. Canonical and legacy completion paths both need coverage. |
| E7 | `web/lib/run-results/types.ts:35-62`; `agent-result.ts:26-93`; `validate.ts:81-117`; `flow-terminal.ts:61-99,122-195` in the same directory | Reuse sentinel transport, validator, ledger and no-promotion Done event pattern. Existing Flow result-only policy sends changed work to Review and is not the operational policy. |
| E8 | `web/lib/run-results/status.ts:42-53,78-98`; `web/lib/runs/run-result-dto.ts:88-107`; `web/lib/run-results/collect.ts:50-61` | Failed/Crashed/Abandoned payloads are currently unavailable, even with a valid ledger row. Diagnostic outcome availability needs an explicit narrow contract. |
| E9 | `web/lib/agents/materialization-manifest.ts:50-60,420-448,621-634`; `dirty-watchdog.ts:310-330`; `web/lib/runs/reviewable-changes.ts:3-44`; `workspace-clean.ts:43-84`; `web/lib/worktree.ts:2509-2572,2737-2745` | Path ownership/exclusion is not content integrity. Net diff alone misses commit-plus-revert. Validate history, index, files and materialization provenance before deletion. |
| E10 | `web/lib/gc/workspace-gc.ts:454-574`; `web/lib/gc/preserve.ts:147-168`; `web/lib/db/schema.ts:4756-4881` | Reuse lifecycle claims, preserve/archive/remove/record protocol and missing-worktree convergence. Generic GC can push archive refs: operational cleanup must force local-only preservation. |
| E11 | `web/lib/execution-host/runtime-object-retention.ts:117,136-140`; `web/lib/runs/run-status-sets.ts:15-42` | Evidence deadline currently follows workspace removal deadline. Immediate workspace cleanup must not expire evidence immediately or widen global status sets. |
| E12 | `supervisor/src/pending-permissions.ts:78-105`; `web/lib/agents/permission-resume.ts:95-106`; `web/lib/agents/launch.ts:4091-4099`; `web/lib/runs/keepalive-sweeper.ts:452-470` | Supervisor accepts multiple requests, but agent resume assumes at most one. Checkpoint is nonterminal; idle expiry abandons. |
| E13 | `web/lib/reconcile.ts:501-517,2199-2225`; `web/lib/workbench-lifecycle/service.ts:1883-1918,2165-2169`; `web/lib/runs/recover.ts:231-276,427-435`; `web/lib/agents/prompt-owner.ts:773-775` | Recovery re-observes live sessions; lost execution crashes; stop finalizes Abandoned. Terminal standalone agents have no existing graph Recover path; checkpoint continuation and terminal crash retry are different operations. |
| E14 | `web/lib/agents/triggers.ts:67-107,221-259`; `web/lib/scheduled-launches/queries.ts:468-485,560-584`; `web/lib/queries/runs-list.ts:74-93` | Dispatch outcome is distinct from business outcome. Agent automation history currently reports resulting run status as `Unknown`. |
| E15 | `web/lib/queries/portfolio.ts:81-110,418-447,998-1010`; `web/lib/queries/decisions.ts:54-98,211-229`; `decision-sources.ts:122-153`; `web/lib/notifications/attention-consumer.ts:157-180` | Done alone does not remove retained workspaces from every active surface. Ordinary failed/crashed agent operations have no suitable attention source. |
| E16 | `web/lib/workbench-git/policy.ts:98-117,230`; `facts.ts:211-231`; `web/lib/workbench-lifecycle/service.ts:505-530,1107-1124,1194-1209,1572-1585`; `web/lib/workbench-git/service.ts:348,563-576,756-768`; `web/lib/runs/promote.ts:676-719,2025-2057,2545-2594`; `web/lib/runs/sync-target.ts:791,932` | UI policy is insufficient: promotion has independent apply paths. Guard delivery, publication, revival and sync using frozen operational semantics, including paused-budget bypasses. |
| E17 | `web/lib/config.schema.ts:1278-1284,1678-1707`; `web/lib/flows/engine-version.ts:98`; `web/lib/run-results/resolve-profile.ts:26-28,50-107`; `web/scripts/validate-package-compatibility.ts:88-127` | Engine is 3.8.0. No package compat field exists. Result profiles depend on a parent Flow revision. Release validation omits platform agents; core has zero flows. |
| E18 | `plugins:packages/core/maister-agents/github-intake-gh.md:4-17,74-78`; `github-intake-mcp.md:4-20,67-72`; `packages/core/capability/skills/github-issue-intake/SKILL.md:167-187` | Both variants use worktree/session, recommend autoApply off, and forbid source changes. Shared skill already describes counts, incomplete scans, auth errors and unknown writes, but only as prose. |
| E19 | `plugins:packages/core/maister-package.yaml:6-27`; `packages/core/README.md:52-87`; `scripts/release-package.sh:36-46` | Core is agent-only, with no engine floor. Release wrapper validates selected MAIster checkout before tagging. Update documentation to match the actual gate. |
| E20 | `plugins:packages/core/capability/skills/github-issue-intake/SKILL.md:18-24,119-132`; `web/app/api/v1/ext/projects/[slug]/tasks/route.ts:34-43,153-176`; `web/lib/services/tasks.ts:48-59,144-188`; `web/lib/db/schema.ts:1504-1521`; `web/lib/tokens/ext-handler.ts:711` | Existing intake warns against overlapping imports. Ordinary agent task_create has no atomic GitHub-origin uniqueness; librarian idempotency does not cover it. Do not promise exactly-once or safe overlapping same-source intake. |
| E21 | `docs/system-analytics/attention.md:7-13,36-48`; `docs/db/attention-domain.md:19-65`; `web/lib/notifications/attention-consumer.ts:10-30,96-120`; `web/lib/queries/decisions.ts:54-98` | Decision items are projected, not persisted acknowledgements. Read cursors and notification deltas cannot acknowledge a specific operational reason/revision. |
| E22 | `web/lib/agents/finalization.ts:470-479,510-527,561-596`; `web/lib/run-results/ledger.ts:91-146`; `web/lib/runs/run-result-dto.ts:48-107` | Finalization checks prepared provenance and publishes reported data, but has no durable operational integrity/effective-outcome receipt to project after cleanup. |
| E23 | `web/lib/gc/plain-agent-directory-gc.ts:25-30,116-160`; `web/lib/gc/ephemeral-agent-gc.ts:29-63,111-139`; `web/lib/agents/workspace-paths.ts:5-31`; `web/lib/db/schema.ts:4756-4772` | Plain `none` directories and detached `repo_read` checkouts have no workspace row; their separate cleaners currently restore/delete them. Worktree lifecycle columns alone cannot govern every supported workspace mode. |
| E24 | `scripts/validate-requirement-coverage.mjs:32-65,105-117,169-178`; `scripts/validate-docs-indexes.mjs:55-70,150-200` | Reuse existing bidirectional coverage tooling, but add the new group and support this plan's flat task syntax; current parser expects dotted IDs and another header shape. Avoid a vacuously green coverage check. |
| E25 | `web/lib/db/check.ts:15-62`; `web/lib/db/__tests__/migration-journal-integrity.test.ts:54-155`; `web/lib/db/__tests__/migration-0192-scratch-prompt-intent.integration.test.ts:18-59` | Qualify incremental upgrade and fresh install, journal time/order/hash integrity and snapshot parity; the existing pre-migration fixture helpers already support seeded upgrade tests. |
| E26 | `web/lib/maintenance/upgrade-fence.ts:7-43`; `web/lib/domain-events/taxonomy.ts:318-373` | Existing maintenance fences admission/scheduler/GC but keeps draining controls open. New attention mutations/cleanup changes need explicit event taxonomy, stream and notification invalidation ownership. |
| E27 | `web/lib/agents/permission-resume.ts:55-106`; `web/lib/db/migrations/0155_agent_pause_permissions.sql:1-72` | Parallel permission work must preserve supersession/source SQL constraints, original prompt ownership, delivery intent and request identity, not just remove a length check. |
| E28 | `plugins:packages/core/capability/skills/github-issue-intake/SKILL.md:150-186`; `web/lib/run-results/contract.ts:16-30,81-116`; `web/lib/run-results/validate.ts:6-15,81-117` | Confirmed task creation and later receipt failure are distinct facts. Built-in operational schema identity must not pretend to be a parent Flow profile; reuse FormSchema structural limits and add operational semantic checks. |

## Design decisions

### D1. Four separate axes and conservative defaults

- Definition `kind: code_delivery | operational`, default `code_delivery` when omitted. This is independent of `runs.run_kind` (`agent/flow/scratch/...`). Do not add `operational` to that run-kind enum.
- Keep `mode`, workspace access, execution/permission policy, and completion contract separate. Proposed explicit declaration for the adopters:

  ```yaml
  kind: operational
  mode: session
  workspace: worktree
  completion:
    contract: operational_v1
```

- `operational_v1` is a fixed platform-owned, required contract, not a package-defined meaning of success. Code delivery keeps existing contracts and Review/promotion behavior. Reject operational definitions without the contract, unknown contract versions, and contradictory code-delivery/operational declarations.
- First release supports independently owned, finite standalone session runs. `none` and `repo_read` retain their existing tool restrictions; they are usable when operations require no prohibited tool. Shell-requiring intake keeps `worktree`.
- Reject operational `mode: subagent`, `flow:` bindings, persona-only Flow-node binding, persistent sessions, and shared writable workspace overrides at definition or launch validation, as applicable. These combinations have no independently owned operational completion/cleanup boundary today. Do not silently ignore kind or reinterpret a Flow's completion policy. All supported workspace/mode combinations remain explicitly validated.
- Do not change `autoApply`, `autoApprovePermissions`, trust gates, token scopes, isolation settings or permissions based on kind. A risky external operation may require normal human permission.

### D2. Frozen launch truth

Persist `runs.agent_kind` plus a new `agent_operational` member of `runs.result_contract` in the run-insert transaction, alongside existing `agent_workspace` and execution policy. The member includes contract name/version, exact schema, schema digest, required=true, semantic-validator version, and source package install/revision/definition digest. Snapshot the operational prompt appendix or its immutable template version too.

Give the built-in schema an explicit identity such as `maister:operational_v1@<schema-sha256>`; this is server-derived and independent of a parent Flow. Extend the contract builder and every schemaRef reader/description that assumes `<flow>@<revision>:<stem>`. Hash canonical schema bytes deterministically. A package supplies the contract name, not replacement schema bytes or an arbitrary success predicate. Semantic-validator version dispatch remains available for already launched v1 runs after a later contract is introduced; unknown versions refuse, never fall back to current behavior.

Catalog kind/completion columns are projections. Attachments configure instances; they cannot override purpose or weaken the completion contract. Manual, cron, domain-event, webhook, scheduled, delegated and queued launch paths all use the same resolution. An incompatible delegated resultProfile must be rejected rather than overwrite the operational contract.

Frozen readers: initial and Pending spawn, prompt construction including overridePrompt, continuation, checkpoint/resume, permission recovery, re-observation/reconciliation, finalization, action policy, cleanup, API/DTO/collect and history. These readers must stop re-deriving completion semantics from `getEffectiveAgentDefinition` or the current attachment/catalog. Runtime capability resolution may retain its existing behavior where outside this feature, but it cannot replace the frozen completion appendix. Old/null snapshots mean legacy code-delivery behavior; an operational snapshot with an absent/corrupt contract fails closed.

### D3. Structured operational result, schema validity and business outcome

Reuse the existing final-turn `json maister:output` block, bounded full-output reader, validator and `run_results` ledger. Do not add a second result database or infer outcomes from prose, exit code, task-count zero, or workspace cleanliness.

Proposed canonical v1 value, frozen exactly in Phase 0:

```json
{
  "schemaVersion": 1,
  "outcome": "success",
  "summary": "Scan completed; no new tasks were needed.",
  "coverage": { "state": "complete", "remainingKnown": 0 },
  "counts": { "scanned": 0, "attempted": 0, "completed": 0, "failed": 0, "skipped": 0, "created": 0 },
  "references": [],
  "diagnostics": []
}
```

- Outcomes: `success`, `partial`, `blocked`, `failed`. Counts are required finite nonnegative integers. They count distinct input work items, not HTTP calls: attempted = completed + failed; attempted + skipped <= scanned. `created` counts attempted items with at least one confirmed creation and is <= attempted, independently of end-to-end completion. An item with a created task but a failed completion receipt therefore has attempted=1, completed=0, failed=1, created=1; its task and unresolved receipt references remain present. Do not erase that confirmed side effect or reject the result with the incorrect invariant created <= completed. Scan/pagination failure can have all-zero counts with an error diagnostic.
- Coverage is explicit: `state: complete | incomplete | not_started`, plus `remainingKnown` as a nonnegative integer or null when unknown. It records whether the intended source/work scope was enumerated; a successful non-scan operation marks its known scope complete. Success requires complete coverage with zero remaining; incomplete pagination cannot be described as success merely because processed items succeeded. Never invent a remaining count from an incomplete scan.
- References are bounded typed records (`task`, `external_issue`, `operation_receipt`, `other`) with stable IDs, explicit state (`confirmed` or `unresolved`) and optional validated URLs. Only confirmed receipt references establish progress; pending markers do not. Include created task IDs and existing pending/unknown-write receipts needed for reconciliation. Do not put credentials, raw response dumps or local filesystem paths in public results.
- Diagnostics are bounded records with stable code, severity, operation, safe message, retryability, actionable remediation, optional reference IDs, and optional safe service/HTTP status context. Unknown-write diagnostics explicitly require reconciliation before retry.
- Semantic validation follows structural validation: success has complete coverage, no unresolved error diagnostics, failed items or unknown effects; partial requires confirmed progress (completed item, confirmed creation or confirmed operation receipt) plus an incomplete/failed remainder; blocked/failed require an error and remediation. A zero-item complete scan is success. A completed import with an interrupted remaining scan is partial, even if no individual item is known failed. A task created before receipt failure is partial; an unknown write with no confirmed progress is blocked. Warnings that have been fully resolved do not force partial. Define all outcome/coverage/count combinations as an allow-list with rejected counterexamples in the result spec.
- Missing/malformed/oversize/unsafe/schema-invalid or semantically contradictory output is contract failure. Record its typed reason in the existing invalid-result plane and retain original execution evidence under existing access controls.
- Add an `operationalOutcome` diagnostic projection to DTO/collect over the same validated ledger row. Keep ordinary `resultStatus` semantics for usable answers: Failed remains unavailable as a successful answer. The projection distinguishes the validated agent's `reportedOutcome` from the platform's `effectiveOutcome`, and includes validation state, counts/references/diagnostics and terminal integrity/refusal facts. `successful` is true only for committed Done with a valid success result and verified integrity. A reported success with a source violation therefore has effectiveOutcome=failed and successful=false; the reported value remains evidence. Missing/invalid results expose their classified failure without unvalidated payloads. This projection is not a second persisted result or an instruction for coordinators to treat partial work as success.

### D4. Status mapping and terminal transaction

| Condition | Existing run status | Outcome/evidence | Attention / next action |
| --------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Valid success, integrity verified, session settled | Done | Valid operational result; completion=result_only; no promoted/merge/publication fields | History; no intervention |
| Valid partial | Failed | Valid diagnostic outcome with confirmed receipts | Reconcile remainder, then explicitly retry |
| Valid blocked, including GitHub 403 | Failed | Safe provider/status context and remediation | Fix permission/configuration, then explicitly retry |
| Valid business failed | Failed | Failure diagnostics and counts | Investigate/reconcile, then explicitly retry |
| Missing, malformed or invalid required result | Failed | Invalid-result reason and transcript | Fix agent contract/definition; no guessed success |
| Unexpected source/materialization mutation or indeterminate integrity | Failed | Integrity failure plus any original validated outcome retained as diagnostic evidence; effective success=false | Preserve and investigate; quarantine on proven contract violation |
| User stop/cancel or idle abandonment | Abandoned | Cancellation reason; confirmed receipts remain evidence, not a completed result | History; warn if effects remain ambiguous |
| Lost turn, vanished execution or unrecoverable host crash | Crashed | Last confirmed evidence and ambiguity diagnostic | Diagnose and reconcile receipts, then explicitly start a new attempt; no existing standalone terminal Recover action |
| Cleanup failure after terminalization | Keep the committed terminal status | Separate cleanup diagnostic; do not rewrite business outcome | Retry cleanup / inspect retained workspace |

Finalization order: settle all pending permissions and stop/prove quiescence of the supervised execution; consume original bounded output; validate output and integrity; CAS the run and persist outcome/invalid evidence, terminal turn settlement, timestamps, cleanup intent, and domain/webhook events in one transaction. Keep filesystem operations outside it. Existing prompt acknowledgement and fencing guarantees remain mandatory. Competing finalizers publish once. Cancellation/crash racing success cannot rewrite a committed result into a later success.

Persist a write-once `runs.operational_terminal` receipt in that transaction: version, terminal cause/status, effective outcome, success flag, validated result revision when available, integrity verdict/baseline reference, diagnostic reason codes and opaque evidence references. It stores platform decision metadata, not a copy of agent result values. Status alone cannot reconstruct whether a Failed run was blocked, malformed or changed source after its worktree is removed. Projection joins this receipt to the same result ledger revision; it must not recompute integrity from deleted paths or mutable catalog data. Cancellation/crash/pre-spawn failure receipts explicitly record unchecked/incomplete validation and successful=false. A DB shape/status constraint and write-once guard protect the receipt; terminal notifications use the committed effective decision.

Respect immediate CHECK evaluation: under the existing run/provenance lock, publish the result revision inside the transaction, then set status, terminal receipt and cleanup intent in one CAS UPDATE, then release assignment/settle turn and emit events. A lost CAS or later failure rolls the transaction back, including the result row. Do not temporarily commit or even statement-write an operational terminal status without the receipt required by its non-deferrable CHECK; cross-row result linkage uses the owning transaction/appropriate deferred validation rather than an invalid cross-table CHECK.

Reuse `run.done`/`run.failed`/existing terminal events and the `completion: result_only` pattern. Wake orchestrator/parent waiters, agent queues, scheduler admission and attention consumers through existing terminal signals. Do not merely change `runs.status` and omit slot release or parent wakeup.

### D5. Source integrity and preservation

Use instructions plus existing tool/isolation/governance controls during execution, then a mandatory integrity gate before operational success. This gate is not a claim of stronger arbitrary-shell containment than the selected execution policy provides.

- Capture launch base commit, branch/ref identity, and a platform-controlled materialization manifest containing exact paths, object types, expected content hashes/symlink targets, and previous content/ownership where restoration is needed. Keep authoritative baseline outside agent-writable materialization, referenced by run/workspace identity and digest.
- Update this baseline only for actual platform-owned writes at materialization/resume seams under existing ownership locks. Agent-authored marker/path content cannot confer ownership. Use existing settings backup/restore provenance; preserve user-owned files.
- After execution quiesces, verify branch/HEAD history against launch, staged and unstaged tracked changes, renames/deletions, untracked files, and newly introduced ignored files outside exact owned execution artifacts. Commit-plus-revert or a replaced HEAD is still an unexpected source operation. Do not use broad `.claude/`, `.maister/`, review-display filters or path-only leases as a success allow-list.
- Expected platform files may differ from the original checkout only when their content/type matches the trusted baseline. Mutation of an owned file, an unlisted file under an owned directory, corrupt ownership, symlink substitution or a failed Git/baseline probe fails closed. Avoid following links into foreign paths.
- Validate before destructive materialization release. Persist safe integrity facts and preserve all unexpected bytes, including binary/ignored files not covered by the existing Git archive. Reuse local Git preservation where sufficient; supplement it with opaque host-owned diagnostic objects for evidence it cannot capture. Never delete the only recoverable copy.
- Proven source-contract violation reuses existing agent quarantine and typed reason, without resetting/deleting the unexpected changes. Probe/infrastructure failure is not proof of agent misconduct and must not itself quarantine.
- Final success is never routed to Review. Failed integrity is never auto-promoted. Every server delivery apply path also refuses operational runs, including restored diagnostic workspaces and paused-budget bypasses (E16).

Workspace-specific scope is explicit. An owned worktree/detached checkout is compared with its frozen source baseline. A shared parent `repo_read` session never authorizes resetting, archiving or deleting that parent; an unattributable concurrent parent change is an integrity conflict, not proof permitting global agent quarantine. `none` has no source repository and validates only its owned materialization/directory boundary. Keep mutable adapter/runtime output in explicitly platform-owned execution roots separate from immutable source/materialization; do not hash a live cache as though it were source or allow arbitrary agent paths to become runtime exclusions. Bound traversal, file counts/bytes and probe duration in Phase 0; an exceeded limit yields a typed indeterminate failure with preserved evidence, never a blanket directory exclusion.

### D6. Workspace disposition, cleanup and evidence retention

Reuse `workspaces` lifecycle claims, preservation records, archive refs, `removed_at`, removal kind, root validation and reconciliation. No generic new cleanup service or scheduler job kind. Operational terminalization durably arms cleanup; a post-commit attempt and the existing system sweep own progress.

Use run-bound `runs.operational_cleanup` metadata so rowless `none` directories and detached `repo_read` checkouts are covered too (E23). Record version, resource kind/opaque ownership reference, arming revision/time, attempt budget, due time, safe last error, state and lease/attempt fence where there is no workspace row. For an ordinary worktree, retain its existing workspace claim as the sole destructive-operation claim; do not create a competing claim in the run metadata. For a rowless owned directory/checkout, extend its current cleaner with a run-bound CAS/lease and the same preservation prerequisites. Shared-parent `repo_read` cleanup releases only this run's materialization, context mounts and host workspace handle. No fictitious branch/workspace row is inserted for plain directories.

Route terminal cleanup in `agents/finalization.ts`, `gc/workspace-gc.ts`, `gc/plain-agent-directory-gc.ts`, `gc/ephemeral-agent-gc.ts`, `gc/agent-materialization-gc.ts` and startup reconciliation through this operational disposition before any restore/delete. Existing default-agent behavior stays intact. A legacy cleaner must not bypass diagnostic holds, integrity capture, retry exhaustion or evidence preservation because a directory has no workspace row. Missing-run/orphan cleanup cannot guess kind: rely on trusted ownership/intent evidence, otherwise preserve and surface an unclassified orphan rather than deleting uncertain bytes.

Reuse post-terminal host teardown rather than minting a new assignment: `web/lib/execution-host/client.ts:290-302` supports teardown binding of a released assignment, and `gc/workspace-reconciler.ts:446-477` releases an adopted workspace through the latest assignment. Follow preservation → local removal → durable removal record → fenced host workspace.release. A failed/ambiguous release stays in the existing command recovery ledger and the cleanup diagnostic state; never recreate the removed worktree or roll back business completion. If host liveness cannot be established before removal, preserve and defer deletion. The final receipt must distinguish local resource removal from host-handle release still pending.

- Active working copies mean runnable/reviewable working copies. All terminal operational runs leave portfolio, rail and project active-working-copy lists immediately after terminal commit, including cleanup-pending/held workspaces. This follows a real terminal outcome/disposition, not hiding Review. History exposes retained/pending/failed cleanup explicitly; workspace filesystem presence alone does not make it active.
- Done/Failed/Abandoned: dispose promptly after session quiescence, materialization verification, required local evidence preservation and execution-host release prerequisites. Preserve failures and unexpected changes before removal. No automatic source publication: force archivePush=false in every operational preservation/reconciliation path regardless of global GC configuration.
- Crashed: retain a diagnostic hold through an existing `gcAgeDays` window, shown in attention/history. Terminal standalone-agent recovery is diagnosis and explicit new-attempt retry; the graph-only Recover service cannot be reused. Before a run becomes terminal, live re-observation and checkpoint continuation retain their existing owners and original contract. Cleanup and any nonterminal continuation must arbitrate the same workspace lifecycle claim. On diagnostic-hold expiry, preserve locally and dispose if no active prompt/command/HITL recovery hold remains. Expose evidence and explicit new-attempt retry after disposal; never claim resumability of a deleted cwd.
- Pending/Running/NeedsInput/NeedsInputIdle and nonterminal host-pressure parks: retain workspace. Checkpoint is not completion. On resumed execution validate original baseline and refresh only actual platform materialization. Idle timeout follows existing abandonment behavior, then cleanup.
- Retry creates a new attempt with a new run/workspace. It does not silently replay uncertain external writes or change the old outcome. Reconcile provider/task receipts first when indicated.
- Cleanup failures leave a terminal historical run, preserved workspace and actionable cleanup attention; they never manufacture Review or falsely stamp removed_at. Destructive steps require the run/workspace/assignment fence, expected terminal status, no live session and a valid lifecycle claim. No deletion of common repo state or another run's leases/files.
- Durable retry budget: five automatic attempts per cleanup arming, with delays 1m, 5m, 30m and 2h after successive failures; exhaustion requires explicit re-arm. Persist attempts/arming revision and safe last error in operational_cleanup; use workspace scheduled_removal_at for its existing worktree deadline and a run-bound dueAt for rowless resources. Keep these due times synchronized where both exist. A failed read/quiescence probe does not assert removal. Sweep uses durable rotating keyset/progress so protected, already-missing or poison rows cannot starve later resources; arm/re-arm resets only that intent's budget, not other runs. Renew leases around long preservation/removal and fence every persistence boundary.
- Keep execution evidence retention independent: for operational runs, workspace scheduled_removal_at=now cannot shorten the ordinary endedAt + gcAgeDays evidence lifetime. Respect existing runtime-object/command holds, two-sided command retirement and stronger failure retention. No automatic deletion of run/result/history rows. This is a narrow operational deadline rule, not a global retention rewrite.

Crash windows to specify/test: before terminal commit; after commit before cleanup; after preservation before archive record; after archive record before removal; removed-but-not-recorded; lease expiry during preservation; materialization released but worktree removal failed; host unreachable after terminalization. Each converges from durable state and original snapshot without rerunning external business actions.

### D7. Concurrency and HITL

Independent operational runs are normal concurrent agents under existing global/per-agent admission rules. Dedicated workspaces, run-scoped contracts, ownership leases and request IDs must not collide. Do not introduce global operational single-flight or conflate kind with headless auto-approval.

Guard scopes match their invariants: terminal publication is per run/turn under its existing CAS; cleanup and resume arbitration is per workspace under lifecycle attempt/lease/expected-status fencing; materialization ownership is per physical cwd under the existing SQLite mutex; admission remains global under the existing scheduler lock; permission delivery is per run/session/request; attention acknowledgement is per run/reason/revision. Reuse these owners instead of adding per-agent locks for global properties. For races, drive the actual conflicting writers: two finalizers (or finalization versus cancel), cleanup versus continuation, and two request answers. In real Postgres tests assert the losing writer waits or loses the actual claim, the winner performs real writes, and stale completion is refused. Where a blocking DB lock owns the invariant, observe the waiting transaction through pg_stat_activity and verify that disabling the guard makes the race test fail.

Remove the one-current-permission assumption in agent resume. Persist/answer each request by run/session/request identity and preserve its options. Answering one does not mark the run Running while others remain open. Define recovery for multiple pending, answered-but-undelivered, checkpoint-cancelled and redelivered requests; never invent permission IDs or auto-select allow options. Reuse pause/continuation machinery and its cap gates. A failed request-creation persistence with no durable delivery owner explicitly cancels/releases that orphaned host deferred. Ambiguous delivery/network failure or lost acknowledgement keeps the same durable request-bound intent retryable and reconciles its delivery; do not cancel a potentially delivered decision or answer twice. Invalid user input leaves a valid pending request available for correction.

Normal explicit business decisions continue through existing agent_question/form HITL, with their own schema, identity and authorization. Retain pending-human-question finalization deferral. Permission answers cannot settle a business question, and answering a question cannot replace the required operational terminal result. Test an operational question→answer→continued execution→structured completion boundary using the existing agent-question integration owner, rather than adding a separate operational approval mechanism.

Existing GitHub intake's overlapping same-project/source restriction remains documented. Its ordinary task_create path has no atomic GitHub-origin uniqueness (E20); this feature does not claim exactly-once intake. Keep existing pending/unknown-receipt checks and report detected unsafe/ambiguous work as blocked or partial. Independent operations still run concurrently. Removing that importer restriction requires a separate scoped source-claim/idempotency design; it cannot be achieved by this kind field or skill wording.

### D8. UI, attention and API behavior

- Studio/catalog/project attachments show kind, workspace/tool restrictions and completion contract separately. Inline creation/editor validation matches launch validation. Package updates cannot edit existing run semantics.
- Run details lead with operation outcome, counts, references, safe diagnostics and evidence. No normal diff/review/promotion/merge/publication controls. Unexpected source evidence remains inspectable through an authorized diagnostic path; inspecting it does not grant delivery capability.
- Automation rows/history show dispatch outcome and actual resulting run outcome as separate fields. Replace literal Unknown joins; queued/running/nonterminal results show pending, never success. Preserve historical dispatch records.
- Add an actionable operational-run attention population for partial/blocked/failed, result/integrity failures, terminal crash diagnosis and cleanup failure. Reuse the central queue/count, grants and notification consumer. One run may carry separate business and cleanup reasons; deduplicate by reason/revision. Add per-user `operational_run_acknowledgements` keyed by (userId, runId, reason, revision): existing attention cursors/notification state cannot express this. Acknowledgement removes that reader's exact attention revision, not another reader's item, the underlying failure or audit history. A new failure/cleanup revision becomes actionable again. Retry, nonterminal checkpoint continuation, discard and cleanup re-arm remain separate authorized actions.
- Attention content derives grants from the data returned. Summary/diagnostics require project/run visibility; raw output/files require existing repository/evidence grants. Validate links and bound content. Do not expose secrets through richer automation DTOs or notification payloads. Terminal operational Crashed actions are diagnosis/reconcile/new-attempt retry/discard; do not render the Flow-only Recover action.
- Extend run DTO, list/detail/history, automation and ext run_collect with the same operational projection. Coordinators must inspect successful/outcome, never equate structurally valid partial output with completion success. Existing code-delivery collection semantics remain intact.
- Add EN/RU strings and accessible status cues for Operational/Code delivery, Completed/Partially completed/Blocked/Failed, zero-new-work success, result invalid, unexpected source changes, retained diagnosis, cleanup pending/failed, reconcile-before-retry and acknowledge/retry/re-arm actions. Examples: `Operational / Операционный`; `Partially completed / Выполнено частично`; `Blocked / Заблокировано`; `Scan completed; no new tasks / Сканирование завершено; новых задач нет`; `Reconcile previous changes before retrying / Проверьте предыдущие изменения перед повтором`.

### D9. Compatibility and rollout

Use a new engine feature floor, provisionally 3.9.0 after verifying current integration HEAD. Add optional package-level `compat.engine_min/engine_max` and enforce it for packages with or without flows. Operational definitions require a sufficient declared package floor; old manifests without these features retain existing behavior.

Old platforms' strict package schemas will refuse the new compat declaration instead of partially installing core and silently dropping operational definitions. New platforms validate platform agents at remote/local install, attach/update, registry/Studio validation, compatibility CLI and effective launch. Do not rely on best-effort agent registry indexing for safety. Existing report-only handling of unrelated invalid definitions need not be globally redesigned; an unsupported operational contract is a package compatibility refusal with a clear reason.

Extend the actual release gate to enumerate agents, not only flows/evaluation methods. Fixed operational contracts do not need parent Flow result_profiles; core remains agent-only. Package trust/setup execution ordering is unchanged.

Release order: platform additive migration + runtime/supervisor parity + UI/contracts + validator first; qualify candidate plugin bytes against that version; publish a new `core/vX.Y.Z` second; explicitly upgrade/reattach core third. Keep old pinned versions runnable and old in-flight snapshots unchanged. Never edit an existing immutable tag/install. Reverting to old platform binaries while operational runs/new core are present is unsupported: drain/finish runs and repin compatible core before rollback; retain additive DB data.

## Specification artifacts and requirement ownership

T1 creates three focused canonical analytics documents and a traceability matrix. This avoids adding repeated operational state machines to seven existing documents. Each analytics file follows the required Purpose → Domain entities → State machine → Process flows → Expectations → Edge cases → Linked artifacts structure, has at most 12 expectation bullets, and labels future behavior Designed. Existing agents/result/workspace/attention/scheduler/runtime-object docs gain the necessary integration transitions and cross-references, not copies of these contracts. Update the canonical analytics/DB/screen indexes when adding files.

| Canonical artifact to create | Owns | Required expectations / edge examples |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/system-analytics/operational-agents.md` | OPA: definition, policy axes, package/launch compatibility, frozen identity, both adopters and documentation parity | Defaults; unsupported combinations refused before allocation; kind never grants tools; every launch origin uses immutable contract; old/new package and binary behavior; SET/CLEAR/re-SET; per-version validators. |
| `docs/system-analytics/operational-agent-results.md` | OPR: exact v1 result, validation/limits, counts/coverage, terminal mapping and diagnostic projections | Full field schema and sizes; complete/partial/blocked/failed examples; task-created/receipt-failed example; malformed/missing/inconsistent refusals; reported versus effective outcome; result ledger/terminal receipt transaction; no success from prose/process exit. |
| `docs/system-analytics/operational-agent-lifecycle.md` | OPL: integrity, permission concurrency, cleanup/retention, failure attention and recovery | Every status × workspace-resource-kind × completion/recovery action; permissions and ambiguous ACKs; all destructive cleaner owners; evidence-before-delete; local-only archives; attempts/leases/progress; per-user acknowledgement; terminal crash diagnosis versus continuation. |
| `docs/system-analytics/operational-agents-traceability.md` | Bidirectional requirement → task → primary executed test | Exact existing coverage-tool table columns: ID, Contract, Tasks, Primary test, Status. Planned rows may cite planned titles; Implemented rows must resolve to actual discovered test titles and green receipts. |

Requirement declarations use `OPA-NN`, `OPR-NN`, `OPL-NN` and `EDGE-<prefix>-NN`. The IDs below are the planned allocation, not a claim that those specs/tests already exist. T1 freezes their normative wording and enforcer; T3/T21 freeze and validate each primary test mapping. Shared requirements can have several supporting tests, but each has one primary scenario at its owning boundary.

| Original requirement | Spec IDs | Enforcing tasks | Primary acceptance observation |
| --------------------------------------- | -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Explicit kind; independent axes | OPA-01 | T4,T6,T15 | Kind round-trips independently of mode/workspace/permission policy. |
| 2. Existing default behavior | OPA-02 | T4,T8,T9 | Omitted/legacy kind retains Review, promotion, existing result contracts and cleanup. |
| 3. Tools with existing governance | OPA-03 | T5,T6,T10 | Operational shell/API/MCP still enforces configured permissions, scopes, isolation and explicit HITL. |
| 4. Success/zero-work Done | OPR-01 | T8,T13,T16 | Complete zero/nonzero run becomes Done with no delivery side effects. |
| 5. Structured outcomes | OPR-02 | T4,T7,T8,T16 | Counts/coverage/refs/remediation validate; partial and unknown effects remain explicit. |
| 6. Reuse existing statuses | OPR-03 | T8,T13 | Exhaustive terminal mapping, correct events/slots/parent wake, no new run status. |
| 7. Leave active copies; retain evidence | OPL-01,OPL-07 | T11,T12,T13 | Terminal operational run disappears from every active projection while history/evidence remains. |
| 8. Failures in history/attention | OPL-02,OPR-04 | T8,T13,T14,T15 | Failure has durable effective decision and actionable authorized attention; valid diagnostics survive Failed. |
| 9. HITL and legitimate concurrency | OPL-03 | T6,T10 | Distinct runs/requests, partial answers, checkpoint/resume, no implicit allow or double delivery. |
| 10. No accepted source mutation | OPL-04 | T7,T8,T9 | Materialization-only accepted; unexpected source/history/owned-file change preserved and fails closed. |
| 11. Safe disposal under all exits | OPL-05,OPL-06,OPL-08 | T10,T11,T12 | No live/checkpoint deletion; failure/cancel/crash paths have explicit bounded cleanup/retry owners, fenced progress and durable lifecycle invalidation. |
| 12. Launch snapshot stability | OPA-04 | T4,T6,T8 | Pending/start/resume/finalization retain original schema, semantics and provenance after package update. |
| 13. Both GitHub intake variants | OPA-05 | T16,T18 | gh and MCP variants declare and obey the same fixed operational contract. |
| 14. EN/RU/schema/API/MCP/package/docs | OPA-06,OPA-07 | T4,T5,T13,T14,T15,T17,T18 | Payloads, migrations, authoring/compatibility, both locales and canonical docs match the implementation. |

Allocate edge IDs to the primary owners in the validation matrix: `EDGE-OPR-01` confirmed task then failed receipt; `EDGE-OPR-02` missing/malformed/oversize/unsafe output; `EDGE-OPR-03` count/coverage contradictions and unknown remaining work; `EDGE-OPA-01` update/detach while Pending or parked; `EDGE-OPA-02` unsupported binding/profile/contract before side effects; `EDGE-OPA-03` historical DB upgrade; `EDGE-OPA-04` zero-flow package floor and registry clear; `EDGE-OPL-01` concurrent requests/checkpoint; `EDGE-OPL-02` ambiguous input ACK and owner loss; `EDGE-OPL-03` cancel/crash/finalize race; `EDGE-OPL-04` history/index/untracked/ignored/symlink/materialization tampering and probe refusal; `EDGE-OPL-05` every evidence/DB/delete crash window; `EDGE-OPL-06` preservation failure, lease expiry, poison progress and retry exhaustion; `EDGE-OPL-07` evidence deadline independent of immediate cleanup; `EDGE-OPL-08` per-reader ack, changed reason/revision and live invalidation. Do not multiply tests merely because several assertions share an ID; table-drive distinct cases at their real boundary.

## Persistence and migration contract

T2 must finish exact SQL/JSON shapes and all writers before T4's RED. The following storage decisions close the prior unspecified persistence gaps; SQL names can change only with a consistent spec/test update. All new state is additive, main-lineage only; do not edit old applied migrations or touch Brain lineage.

| Store | Proposed shape/default | Invariants and upgrade behavior |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents.kind`, `agents.completion_contract` | Closed text kind, NOT NULL default code_delivery; nullable versioned declaration JSON | Allowed kind; operational iff declaration is supported operational_v1; registry writes/clears both symmetrically. Historical catalog rows start code_delivery until explicit resync from a new package. |
| `runs.agent_kind`, existing `runs.result_contract` | Nullable kind for legacy/non-agent rows; operational new union member has required version/schema/digest/provenance | New operational rows have matching kind/contract in their INSERT; non-agent/legacy rows remain null. DB trigger prevents changing an admitted operational kind/contract; code provenance CAS includes them. No agent-ID-based backfill. |
| `runs.operational_integrity_baseline` | Nullable versioned metadata/opaque object references, captured before prompt dispatch; no source bodies | Initial baseline is durable before execution; platform generation additions are append-only under run/generation fence. Missing/corrupt/unreadable baseline cannot yield Done. Never backfill historical source facts from today's checkout. |
| `runs.operational_terminal` | Nullable write-once decision metadata, as D4 | Operational terminal transition writes receipt and result/event/turn state atomically; successful iff Done + valid success + clean integrity; Failed/Crashed/Abandoned never successful; Review and delivery SHAs are forbidden for operational. Post-commit receipt mutation is refused. |
| `runs.operational_cleanup` | Nullable versioned bounded intent/attempt/error/lease metadata, as D6 | Default null means no new cleanup claim for historical runs. Attempts 0..5, monotonic arming/reason revision, explicit due time, legal state/lease combinations, no success without preservation/removal facts. Worktree claim stays in workspaces; rowless resource claim is run-bound. Index only due operational candidates, using a typed due field/expression chosen from the actual query in T2. |
| `operational_run_acknowledgements` | PK (user_id, run_id, reason, revision), acknowledged_at; FKs to users/runs, CASCADE | Exact per-reader reason/revision, revision positive, closed reason enum. One user cannot acknowledge for another. Run result/history is untouched; no payload/private diagnostics duplicated into this table. |
| Existing result/workspace/execution ledgers | Reuse current rows; no copied agent result table | Preserve run_results revision uniqueness, lifecycle lease constraints, command retirement holds, host object ownership and original permission-source constraints. Extend shared constraints only from current schema and cover every affected writer. |

Writer inventory: registry resync and attach/update projection; all run inserts including create-failure/delegation/trigger paths; initial/Pending spawn and materialization/resume generations; canonical/legacy/cancel/crash finalizers; all four GC families and startup reconciliation; permission pause/reissue/delivery; acknowledgement and cleanup re-arm routes; all seed helpers/fixtures that construct these shapes. List the actual functions/fixtures in T2; no runtime writer may be discovered after the migration ships without updating that inventory and its tests.

Migration acceptance is not fresh-install-only: (a) use `startMainPostgresTestDbUpTo` to seed historical Pending/Running/NeedsInputIdle/Review/Done/Failed agent, Flow/scratch/librarian, attachment/schedule/result/HITL/command rows; (b) apply the exact new SQL chain with the normal migrator; (c) verify IDs, FKs, snapshots, statuses, histories, pins and receipts are preserved and no operational semantics fabricated; (d) verify valid new writes succeed and contradictory/mutating rows fail the named CHECK/trigger; (e) migrate an empty database through the complete chain; (f) re-run the migrator with no pending work and unchanged ledger/data; (g) test transaction rollback on an injected migration failure using isolated test databases only. Never run migration probes against the owner's database during implementation tests.

Reserve the next actual ADR/migration numbers from integration HEAD in T1/T2. Generated table/column/index migration and a separate custom immutable/shared-constraint migration each have SQL, journal and matching snapshot; derive CHECK definitions from schema.ts. Require increasing idx/tag/when, exact applied hashes, no orphan SQL, latest snapshot present, db:check, generated ERD parity, and db:generate reporting no unintended residual changes. Re-run the seeded incremental test after rebase/renumber. Do not rewrite an applied durable migration to make a checksum mismatch disappear.

## API and event contract worklist (specify in Phase 0)

Every affected operation gets method/path, request/response schema, required/null fields, examples, authorization, stable error code/details, status mapping and retry/idempotency rules in its canonical OpenAPI/AsyncAPI before its behavior changes. A valid YAML document alone does not establish runtime conformance. Reuse named operational schemas by reference within each spec; add fixture parity across web/ext/MCP instead of copying success logic.

| Operation / surface | Contract change and acceptance |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing agent list/detail/project attachment routes and Studio artifact save | AgentSummary/AttachedAgent include kind and completion declaration. Attachment PATCH cannot override them; authoring/import/export round-trips both and CLEAR restores defaults. |
| `POST /api/projects/{slug}/agents/{agentId}/launch`, agent events, scheduled/cron/delegation launches | Keep existing request scope; clients cannot supply trusted kind/schema/provenance. 202 means admitted/queued, not operation success. Document 400 invalid declaration/combination, existing auth failures, 409 conflict and existing unavailable-host paths without adding a new business status. |
| Existing run list, server run-detail DTO, Git-state/change routes; `POST /api/v1/ext/runs/collect`; ext run/decision DTOs and MCP run_collect | Shared versioned OperationalOutcome DTO: pending versus terminal; reportedOutcome/effectiveOutcome/successful; validation and integrity classifications; result revision; bounded counts/coverage/references/diagnostics; cleanup state and attention reason revisions. No fictitious new GET run-detail route: the existing server-rendered detail uses its explicit DTO. Failed keeps result=null/resultStatus=unavailable while validated diagnostic data is available under operationalOutcome. |
| New `POST /api/runs/{runId}/operational/acknowledge` | Body {reason: operation_failure or cleanup_failure, revision: positive integer}; principal server-derived; exact reason/revision must exist and be visible/actionable to this user. 200 for inserted or identical prior acknowledgement; 409 for unacknowledged stale/different revision or wrong run kind; existing 400/401/403/404 conventions. Row-lock/CAS plus unique key; no host call and no change to business outcome. |
| New `POST /api/runs/{runId}/operational/cleanup/retry` | Body {expectedRevision}; use existing project discard/archive authority and server-owned run/resource IDs, never body paths. 202 durably arms cleanup; it does not claim deletion. Compare expected revision under run/resource lock and persist a re-arm receipt. Identical retry of the latest accepted revision returns that receipt without resetting budget; stale/changed request conflicts. Retain the latest re-arm receipt; older replays conflict without effects. Never re-arm active/checkpointed/unowned resources or reset business outcome. |
| Existing permission respond routes, web and ext | Preserve per-request identity/options, request-scoped intent/ACK and supersession checks across multiple pending requests. 4xx malformed/stale answer leaves valid unrelated requests intact; ambiguous host 5xx/network/ACK loss stays reconcilable, not marked delivered. Existing owner-bound host input protocol remains authoritative. |
| Existing promote, auto-promote, PR/finalize, sync, snapshot/handoff/export, reopen/reattach and paused-budget paths | Operational refusal before Git/provider effects and at apply claim, including direct service/token use. Keep default code-delivery responses unchanged. Separate authorized diagnostic evidence reads from delivery capability. |
| Existing terminal events and webhooks | Add frozen kind/completion and minimal effective-outcome/result-revision pointer where required. Preserve current event names and outbox transaction. Cancel/crash/invalid/integrity failure never emit success; callbacks/parent waiters see committed result/receipt. |
| New internal lifecycle facts `run.operational_attention_acknowledged` and `run.operational_cleanup_changed` | Define payloads in T2: runId, exact reason/revision/state pointer and actor; acknowledgement also has server-derived ownerUserId. Existing envelope supplies project scope. Emit transactionally with acknowledgement or cleanup-state commit, so failure/exhaustion/removal can refresh attention without another terminal event. Extend scanner and notification wake-source allow-lists, keeping count-delta notification policy. Per-reader acknowledgement belongs to attention invalidation, not the general unseen-activity population; do not notify other readers that their own issue closed. Same-count reason replacement still refreshes UI through a content-free invalidation. No result/error bodies enter these payloads. |
| Supervisor HTTP/SSE/MCP mirrors | No new supervisor DTO is assumed. If multi-request replay or baseline evidence transport changes a wire field, enumerate its authoritative web/supervisor schemas and mirrored types, then run the same scenario against fake and real peer. Do not send host-local paths through session/event APIs. |

Record operation identifiers by source: URL runId/slug/agentId/requestId; auth-context principal/token; server-state project, package, kind, schema, assignment and resource paths; body-controlled option/reason/revision/config. Compare every body-controlled identifier to server state. Grant decisions follow response data class: project/run summaries versus repository/file/evidence bodies; acknowledgement is per-user, re-arm uses mutation authority. Do not extend MCP token grants merely to expose diagnostic results; new mutation scopes would require an explicit separate contract decision.

## Tasks and acceptance criteria

Every task inherits the logging policy in Settings. Runtime tasks must log run/agent/package/contract/workspace/assignment/request IDs where applicable, outcome/refusal code, status transition, integrity verdict and cleanup attempt. Log summaries and safe diagnostics rather than result bodies. Schema/UI/docs-only tasks add no artificial runtime logs.

### Phase 0 — Complete the design contract before code

- [x] **T1. Freeze operational domain and recovery tables** (owner: MAIster; no dependencies). Create the three canonical operational analytics and traceability files in the specification-artifact table; update existing integration docs and indexes by reference, following `docs/CLAUDE.md`. Declare OPA/OPR/OPL expectations and all edge IDs, each with its enforcer and observable acceptance. Include D1–D9, the exhaustive status × workspace-resource-kind × action/refusal/recovery matrix, counts/coverage examples and cleanup/permission crash windows. Reserve the actual next ADR stub+record/index only after checking integration master's HEAD; baseline candidate 194 is not an existing reservation. Acceptance: all 14 original requirements covered, <=12 expectations per owning document, tables/prose consistent, all future behavior Designed and every recovery window owned.
- [x] **T2. Freeze persistence and wire changes** (depends T1). Write complete schema/ERD narrative and OpenAPI/AsyncAPI contracts from the worklists above, including new acknowledgement/re-arm routes and internal attention invalidation facts; do not leave these for T17. Finalize operational_terminal/baseline/cleanup metadata, per-user ack DDL, named CHECK/trigger semantics, every writer/fixture, body identifier trust labels, auth/refusal/status/idempotency examples and exact field/size limits. Use existing FormSchema limits plus one operational semantic validator. Reserve actual migration numbers from the current journal (baseline max idx=193) and specify generated versus custom-constraint migrations and seeded upgrade fixtures. Acceptance: valid/invalid examples, failure mapping, DB invariants and HTTP/MCP payloads agree before code, with no unresolved storage or authorization choice.
- [x] **T3. Freeze test and compatibility preflight** (depends T1,T2). Populate every requirement/edge traceability row with one primary owner/test title and supporting composition checks; assign tests to T4–T18 before those tasks execute. Discover runner projects/globs, establish baseline receipts and exact plugin/platform revisions without external GitHub writes. Confirm no new env var, binary, port or mount is required; any new deployment dependency needs an explicit Dockerfile/compose/.env.example task before implementation. Exit: complete coherent specs, no unresolved safety decision, no missing requirement/task/test owner, reproducible migration/provider/ACP fixtures and defined RED commands.
- [x] **T21. Wire the existing bidirectional coverage gate** (depends T1,T2,T3). This quality-tooling task follows spec freeze and precedes T4. Extend `scripts/validate-requirement-coverage.mjs`, its existing tests and docs-index group with operational documents/prefixes/matrix/this plan; support the current flat `T1` task/header format alongside dotted legacy plans. RED: a fixture missing an enforcing task or primary discovered test must fail, and this plan's task set must parse non-empty. GREEN: both directions pass for the completed Planned matrix; existing m51/librarian fixtures retain semantics. REFACTOR: share parsing only where necessary, no new coverage framework. Wire `node scripts/validate-requirement-coverage.mjs --group operational-agents` into the existing docs/contract qualification gate and document that Planned tests need not exist yet, but Implemented rows must resolve and run green. Acceptance: zero vacuous pass, original groups unchanged, command discovers all implementation tasks T4–T18 and all declared operational IDs. No product runtime changes in this task.

### Phase 1 — Definitions, compatibility and launch snapshots

- [x] **T4. Add typed kind/completion and additive persistence** (depends T1–T3,T21). Own RED migration/registry/schema tests first, including seeded pre-feature incremental upgrade, default and SET/CLEAR/re-SET, invalid relational/JSON shapes and immutable-field mutation. Change `agents/definition.ts`, registry/schema/admin DTOs, effective/project-link projections and the exact persistence inventory; add client-safe contract/built-in schema identity plus semantic-validator version. GREEN requires fresh and incremental migration, named constraints/triggers, SQL+journal+snapshot+schema parity, unchanged historical rows and positive valid writes. REFACTOR typed schema composition only after green; never amend old applied SQL. No old run is reclassified.
- [x] **T5. Enforce package compatibility for standalone agents** (depends T4). Update `config.schema.ts`, package install/attach/local validation paths, engine floor and `scripts/validate-package-compatibility.ts`. Exercise a zero-flow package. Acceptance: supported operational package installs/attaches/launches; insufficient/unknown floor or contract refuses before side effects; old code-delivery packages still work; CLI checks actual agents and identifies invalid file/pointer. Capture structured compatibility refusal evidence without executing untrusted package content.
- [x] **T6. Snapshot and consume immutable launch semantics** (depends T4,T5). Update all launch origins, run insert, Pending dispatch, prompt composition/override appendix, delegated profile conflict guard and continuation/recovery readers named in D2. Add no mutable catalog fallback for newly operational runs. Acceptance: update/detach/resync package after launch and before Pending dispatch, finalization or resume; original kind/schema/digest/instructions remain authoritative. Definition/attachment privilege checks still apply. Log snapshot provenance and mismatches.

### Phase 2 — Integrity and outcome finalization

- [x] **T7. Add operational workspace integrity evidence** (depends T6). Own RED real-Git/materialization cases before evaluator/baseline code. Cover each workspace resource kind, initial baseline/append-only platform generation writes, expected runtime roots and evidence preservation. GREEN: history/index/tracked/untracked/ignored changes, renamed paths and tampered owned files are detected; exact platform materialization accepted; limits/probe failure fail closed; shared parent never destructively altered or falsely attributed to the agent. REFACTOR into pure verdict classification plus bounded effects. Log verdict/digest and path counts; file contents remain evidence objects.
- [x] **T8. Add structured operational terminal decision** (depends T7). Own RED outcome/receipt/atomicity cases first, including created-task/failed-receipt, complete zero work, reported success plus integrity failure and cancellation/crash precedence. Extend contract/validation, `agents/finalization.ts`, canonical prompt owner, legacy observer and reconciliation. Persist reported result once in its ledger plus write-once effective terminal receipt and cleanup intent in the existing transaction; respect immediate CHECK ordering. GREEN: full D4 table, rollback/competing-finalizer/event/turn atomicity, parent wake/slot release and no delivery records. REFACTOR pure outcome decision shared by terminal readers; do not invoke Flow-specific completion policy. Log classified outcome and terminal cause.
- [x] **T9. Refuse delivery actions at every server boundary** (depends T6,T8). Add immutable operational facts to workbench policy/facts and guards at promotion/PR finalize claims, lifecycle commit/handoff/export, publication, sync, automatic/token promotion and reattach/revival seams (E16). Diagnostic restoration cannot become code delivery. Acceptance: direct REST/MCP/service calls refuse before Git/provider side effects, including forged Review status, paused budget bypass and retained/restored workspace; ordinary code-delivery Review/promotion regression stays green. Log typed reason `operational_delivery_forbidden` under existing PRECONDITION/CONFLICT taxonomy.

### Phase 3 — HITL, recovery and safe disposal

- [x] **T10. Handle multiple pending permission decisions** (depends T6). Own RED real supervisor/Postgres permission and explicit agent-question cases before changing `agents/permission-resume.ts` or pause/continuation/handoff seams. Preserve request identity, original prompt/source SQL constraints and per-request delivery acknowledgement through checkpoint/restart; supervisor changes only if the verified wire contract requires them. GREEN: two runs and two requests in one run, distinct approve/deny choices, one answer leaves others pending, explicit business question round-trip/terminal deferral, cap/idle behavior and no implicit approval. Orphaned creation failure releases the correct deferred; ambiguous delivery/ACK loss reconciles the same intent without cancellation/double-answer. REFACTOR request selection/classification without hiding distinct lifecycles behind flag-driven helpers. Log per-request lifecycle, never secret input.
- [x] **T11. Reuse lifecycle cleanup with durable operational intent** (depends T7,T8,T10). Own RED cleaner/lease/fairness/crash-window cases first across worktree, plain none directory, detached repo_read and shared-parent materialization. Update every cleaner named in D6 and scheduler/system-sweep wiring; use run-bound intent for rowless resources and existing workspace claim for worktrees. Preserve before removal, record removal, then release the host handle through the existing released-assignment teardown/command ledger. GREEN: no live/checkpoint deletion, failed/unknown evidence retained, no global archive push, removed-before-record converges, host-release ACK loss remains recoverable, five-attempt intent budget/re-arm and poison-row progress. REFACTOR shared pure classification only; no competing claim or generic cleanup service. Log attempt/fence/result and safe error.
- [x] **T12. Preserve evidence lifetime across cleanup and recovery** (depends T11). Narrowly decouple operational runtime-object deadline from immediate scheduled_removal_at; preserve current failure retention and command retirement holds. Cover startup/reobserve, checkpoint, lost turn, explicit retry and restored diagnosis. Acceptance: worktree can disappear while history/result/transcript/evidence remain readable for their normal authorized retention; live/checkpointed workspaces survive; terminal Crashed offers new-attempt retry rather than graph Recover; no business operation is automatically replayed; no archive push occurs even when global GC archive push is enabled.

### Phase 4 — Outcome read models, attention and bilingual UI

- [x] **T13. Project operational outcomes consistently** (depends T8,T12). Extend run result DTO/collect, run list/detail and automation projections; join actual agent resulting-run status while retaining dispatch records. Add shared operational workspace-disposition predicate for all portfolio/project/rail/sidebar readers; do not broaden shared status sets. Acceptance: Failed partial/403 retains usable diagnostics, success-zero is clear, no completed operational run remains an active working copy even with cleanup pending, and code-delivery retained workspaces keep their existing behavior. Log failed projections safely, never substitute guessed success.
- [x] **T14. Add actionable operational attention** (depends T13). Own RED queue/route/grant/idempotency/invalidation cases first. Add exact per-user acknowledgement and cleanup re-arm routes specified above; extend central decision union/source/rank/stage, DTOs, stream scanner/taxonomy and notification wake sources. Reuse existing retry/discard/nonterminal-continuation services without graph-only terminal Recover or delivery capability. GREEN: business/cleanup reasons distinct, exact reader/revision ack survives restart without hiding others, latest identical re-arm replay has no second effect, stale/different request refuses, new failure becomes actionable, count=list, same-count reason replacement refreshes UI, unauthorized denial and positive authorized mutations both pass. Preserve count-delta notification policy. Log actor/revision/reason, not private diagnostics.
- [x] **T15. Expose kind and outcome in Studio/run/automation screens** (depends T4,T13,T14). Update frontmatter editor, artifact labels/validation, Studio agent view, catalog/project attachments, run center/tabs/actions and automation/history panels; add EN/RU messages with accessible status names. Existing Files/Diff review center becomes operation result/evidence view for operational runs. Acceptance: editor/picker/launch contracts agree; no review/promotion/publication action, remediation is clear, task/issue references deep-link safely, zero work is successful, history survives cleanup.

### Phase 5 — Core package adopters and contract documentation

- [x] **T16. Convert both GitHub intake definitions** (owner: maister-plugins; depends T5,T8,T15). Add operational kind and completion declaration to `packages/core/maister-agents/github-intake-gh.md` and `github-intake-mcp.md`; keep worktree/session and existing approval recommendations/capability requirements. Add core package floor. Update shared `capability/skills/github-issue-intake/SKILL.md` to require the final structured result for success, zero work, partial listing/import, HTTP authorization failure, retry exhaustion and unknown-write reconciliation. Keep existing safety/concurrency restrictions truthful. Acceptance: both variants produce the same canonical outcome semantics and required references, without source/Git delivery or new intake features.
- [x] **T17. Reconcile as-built contracts and current docs** (both repos; depends T9–T16). Verify each owning implementation task updated the already frozen contracts alongside its code; this is not the first API/schema documentation pass. Update core README/release-gate description, public EN/RU guides and indexes; compare actual payload/constraint/refusal examples with specs and primary tests. Mark a requirement Implemented only after its owning RED/GREEN/REFACTOR evidence and conformance check. Acceptance: schema/DTO/MCP/analytics examples agree, traceability is bidirectional, no stale real-install claim or duplicated canonical contract, no undocumented behavior discovered at completion.
- [x] **T18. Qualify package and platform together** (both repos; depends T16,T17). Run the updated compatibility CLI against exact candidate package bytes plus a real zero-flow package install/attach fixture, then both intake adapters against controlled provider boundaries. Verify explicit 403 and partial-page/import outcomes with deterministic fixtures; no credential changes or writes to real user GitHub issues. Acceptance: exact platform SHA/package tree/tag candidate/runner/test receipts recorded; qualification covers both definitions and their shared skill, not only frontmatter parsing.

### Phase 6 — Acceptance, integration and release handoff

- [x] **T19. Aggregate complete acceptance evidence** (depends T9–T18,T21). Re-run/aggregate the already implemented primary tests, minimal composition E2E and default-agent regressions from the matrix; do not defer first test writing to this task. Check every requirement/edge ID, runner discovery, fixture/assertion migration, actual SHA/OS/runner and RED→GREEN→REFACTOR receipts. GREEN means all required suites/cases execute successfully with zero skips and no relaxed assertions; local evidence is not hosted acceptance. A missing primary case returns to its owning task as incomplete.
- [x] **T20. Rebase/number audit, adversarial review and release handoff** (depends T19). Recheck live integration base, ADR/migration number collisions, journal/snapshot/schema parity, prose references and new persistent-state writers. Review source-integrity bypasses, snapshot reads, parallel permission ordering, cleanup leases, evidence retention and every action guard; review each resulting fix cycle. Run final validators. Acceptance: no required task unchecked; exact release order/pins/rollback limitations and operator remediation are recorded; stop before push/tag/release unless owner authorizes them.

## Minimal meaningful validation matrix

Real Postgres and temporary Git repositories/worktrees exercise platform behavior. Controlled provider/ACP fixtures are justified for deterministic 403, malformed output, process death and permission ordering; they do not substitute for real platform lifecycle calls. Reuse fake/real supervisor parity where the two-process boundary changes.

**Coverage without duplication:** T3 assigns every requirement/edge exactly one primary scenario and exact discovered title, using `IT-OPA-NN`, `IT-OPR-NN`, `IT-OPL-NN` and `IT-EDGE-<prefix>-NN` (or an appropriate existing tier). The primary owner proves the full decision table at the lowest real boundary that owns it. DTO/MCP parity checks compare that same outcome fixture; browser cases verify wiring/rendering/actions/locale rather than re-running every malformed-result or GC permutation. Pure unit coverage is reserved for stable transformations/semantic tables that integration cases cannot distinguish economically; no test merely enumerates an enum, repeats a constant or mirrors a helper implementation. Each negative case names the unsafe behavior it would permit if the guard were removed. Reuse fixtures, not mocked production decisions.

Owning slices: T4 owns migration/default/registry symmetry (`OPA-01/02/07`, `EDGE-OPA-03`); T5 package floor/invalid combination (`OPA-06`, `EDGE-OPA-02/04`); T6 snapshot and admission (`OPA-03/04`, `EDGE-OPA-01`); T7 integrity (`OPL-04`, `EDGE-OPL-04`); T8 result/terminal transaction (`OPR-01..04`, `EDGE-OPR-01..03`, `EDGE-OPL-03`); T9 server delivery refusal supports OPA-02/OPL-04 with one case per independent apply guard; T10 request/owner transitions (`OPL-03`, `EDGE-OPL-01/02`); T11 disposal/leases/progress (`OPL-05/06/08`, `EDGE-OPL-05/06`); T12 retention (`OPL-07`, `EDGE-OPL-07`); T13 active/history projection (`OPL-01/02`); T14 acknowledgement/live invalidation (`EDGE-OPL-08`); T15 one UI/locale composition owner; T16/T18 both adopters (`OPA-05`). These are requirement owners, not instructions to copy the same test into each task.

| Cases | Existing suite / planned extension | Required assertions |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operational success with tasks; complete zero-new-work scan | `web/lib/agents/__tests__/agent-run-result.integration.test.ts` | Valid outcome/counts/refs; Done; one done event; no promotion/merge/publication; workspace cleanup intent. |
| Partial import/page failure; HTTP 403/API failure; unknown receipt; task created before posting receipt fails | Same suite, plus package fixtures in real install/attach acceptance | Failed; typed partial/blocked/failed; created=1 can coexist with completed=0/failed=1; confirmed task refs and unresolved receipt remain; coverage reflects actual scan; actionable safe diagnostic; reconcile before retry; no prose/exit-code inference. |
| Missing/malformed/oversize/schema/semantic invalid result | Same suite and `finalization-transaction.integration.test.ts` | Typed invalid reason; Failed; output retained as evidence; no business success. |
| Exact materialization versus tracked/index/untracked/ignored/committed changes, commit+revert, symlink/tampered marker, probe failure | Extend `launch-worktree-modes.integration.test.ts` and `dirty-watchdog.integration.test.ts` with operational cases | Expected platform bytes accepted; all unexpected changes fail; valid reported success plus integrity failure yields effective failure, successful=false and no success notification; bytes preserved before release; proven violation quarantines; indeterminate probe does not. |
| Immutable snapshots through package update, Pending dispatch, continuation and resume | Extend `launch-config-snapshot.integration.test.ts`, `effective.integration.test.ts`, `agent-session-reobserve.integration.test.ts` | Original kind/schema/semantic version/prompt remain authoritative; new launches get new package; old runs preserve old semantics. |
| Parallel operational runs and parallel permissions in one run | Extend `web/lib/services/__tests__/hitl-agent-resume-cap.integration.test.ts`, agent pause/continuation suites and supervisor pending-permission integration seam | Distinct workspaces/requests, no automatic approval, correct remaining-pending state, cap compliance, checkpoint/restart/denial and explicit deferred release after failed persistence. |
| Explicit human business decision | Extend `web/lib/services/__tests__/agent-question.integration.test.ts` | Operational question keeps its normal HITL schema/grants/deferral, resumes after the intended answer and still owes a validated final result; permission answer cannot settle the question. |
| Cancellation, live re-observe, lost turn/crash, idle abandon and new attempt | Agent session/recovery suites; GC integration suite | Correct Abandoned/Crashed; no false success; checkpoint stays nonterminal; no destructive cleanup before quiescence; no automatic replay. |
| Cleanup preserve failure, removal-before-record, expired claim/racing continuation, retry exhaustion/fair progress and global archivePush=true, across all owned resource kinds | `web/lib/gc/__tests__/workspace-gc.integration.test.ts`, `workspace-reconciler.integration.test.ts`, existing plain/ephemeral/materialization GC owners; actual system-sweep dispatch seam | Preservation and ownership fences; legacy cleaners cannot bypass new intent/holds; local-only archive; bounded retry/re-arm; poison row cannot starve; missing resource converges; stale fence refuses; removed local resource with host-release ACK loss retries teardown without recreation. |
| Evidence survives immediate workspace removal | `web/lib/execution-host/__tests__/runtime-object-retention.integration.test.ts` | Result/history/transcript still authorized/readable; not deleted at cleanup deadline; command/diagnostic holds remain effective. |
| Active visibility, real automation outcome, attention count/ack/re-open/grants/live invalidation | `scheduled-launches/__tests__/automations-list.integration.test.ts`, `queries/__tests__/decisions.integration.test.ts`, `portfolio-inbox.integration.test.ts`, `notifications/__tests__/attention-consumer.integration.test.ts`; new ack/re-arm route integration owner | Terminal ops absent from active surfaces; dispatch distinct from execution; failures actionable; list=count; one reader's ack preserves another's item; new reason/revision reopens; same-count replacement refreshes UI; latest identical re-arm retry is side-effect-free; stale/mismatched revision refuses; unauthorized mutation denied and authorized action succeeds. |
| Server delivery refusals plus unchanged code behavior | `workbench-git/__tests__/publish.integration.test.ts`, `pr-finalize.integration.test.ts`, `web/app/api/runs/[runId]/__tests__/promote-flow.integration.test.ts` | REST/token/auto/service paths refuse operational before side effects, including forged status/restoration/budget bypass; default agent still Review and promotes normally. |
| API/MCP result parity | `web/app/api/v1/ext/runs/__tests__/collect-v2.integration.test.ts`, existing delegated-profile integration; `mcp/src/__tests__/tool-contract.test.ts` | Failure diagnostic projection matches run DTO; partial never treated as successful result; ordinary result semantics unchanged. |
| Package validation, zero-flow install, registry SET/CLEAR/re-SET and old/new engine compatibility | Registry/package integration suites; `web/scripts/__tests__/validate-package-compatibility.test.ts` | Operational package cannot pass unchecked; valid zero-flow package works; unsupported floor refuses; old definitions retain defaults. |
| Seeded pre-feature upgrade, fresh chain, constraints/immutability, re-entrant migrator and rollback | New operational migration integration owner under `web/lib/db/__tests__/`, extending `migration-journal-integrity.test.ts` only where necessary | Historical rows/attachments/results/HITL unchanged; valid new snapshots succeed; mismatched kind/contract/receipt and forbidden mutation fail named constraints; failed migration rolls back in isolated DB; exact journal/hash/snapshot/ERD agree; no operational reclassification. |
| Browser acceptance with both locales | Extend `web/e2e/platform-agents-launch.spec.ts`, `project-automations.spec.ts`, `active-workspaces.spec.ts` with one shared seeded scenario | Operational success and 403/partial evidence surfaces, no git delivery controls, history/attention and immediate active departure; default code agent still exposes review. |

Existing assertion migration is explicit: agent-run-result tests that infer Review from workspace stay true for omitted/default kind and gain the operational branch; finalization transaction fixtures gain operational snapshot/result members; launch snapshot fixtures distinguish old/new package contracts; automation fixtures replace Unknown with actual joined status; portfolio active tests exclude only terminal operational runs; decision ordering fixtures add operational reasons/rank/stage; collect/tool-contract tests document the diagnostic field while preserving existing failure-result expectations; GC/runtime-object tests separate operational cleanup due time from evidence expiry.

Runner discovery: `web/vitest.workspace.ts` includes `lib/**/*.integration.test.ts` and `app/**/*.integration.test.ts` in integration, with normal pure tests in unit; new integration tests belong there. `web/playwright.config.ts` uses an explicit AUTHED_SPEC matcher, so extend an existing matched file above or register a new file in that matcher. Confirm discovery with `pnpm --filter maister-web exec vitest list --project integration` and `pnpm --filter maister-web exec playwright test --list --project authed`. MCP has its own `mcp/vitest.workspace.ts`; verify discovery there too. Do not claim browser results from the default health-only supervisor stub as real ACP execution; pair UI fixtures with the real supervisor integration seam.

Each behavior phase exits with the full owning suites green: run web `test:unit` then `test:integration` separately; run supervisor equivalents if changed; run MCP equivalents if changed. Relevant failures must be fixed. A pre-existing harness limitation blocks a claim of full green until resolved or the owner explicitly changes scope; do not add skips/excludes or delete assertions to manufacture success. No test execution occurred during planning/refinement.

Final commands, decomposed rather than shell-chained:

- `pnpm --filter maister-web typecheck`
- `pnpm --filter maister-web exec eslint <changed paths>` (read/check mode; the repository lint script applies fixes)
- `pnpm --filter maister-web test:unit`
- `pnpm --filter maister-web test:integration`
- Corresponding supervisor/MCP typecheck, lint check, unit and integration scripts when their code changes.
- `pnpm --filter maister-web test:e2e <extended spec paths>` through the repository E2E wrapper.
- `pnpm --filter maister-web validate:package-compatibility -- --mode release --source <exact candidate maister-plugins repo root> --tag core/vX.Y.Z` (verified CLI flags; use the selected candidate version, not a literal placeholder).
- `pnpm validate:contracts`
- `node scripts/validate-requirement-coverage.mjs --group operational-agents` after T21 wires the group; this command is not supported by the current unmodified validator.
- `pnpm validate:docs:all`
- `pnpm site-docs:validate`
- In isolated migration fixtures: `pnpm --filter maister-web db:migrate`, then `pnpm --filter maister-web db:check`; additionally verify fresh and seeded incremental application through the existing test helpers. No owner database is used for these tests.
- Migration integrity/ERD generation plus `pnpm --filter maister-web db:generate` with no unintended schema changes after the intended migration is generated.

## Contract and documentation inventory

| Changed surface | Implementation / canonical spec |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent frontmatter kind/completion; catalog/attachment DTO | `web/lib/agents/definition.ts`, registry/admin-shared/project-links; `docs/system-analytics/agents.md`, `docs/api/web.openapi.yaml` AgentSummary/AttachedAgent; public package/agent reference |
| Package compat and agent-only validation | `web/lib/config.schema.ts`, `web/lib/packages/`, `web/lib/local-packages/validate.ts`, `web/scripts/validate-package-compatibility.ts`; `docs/configuration.md`, package-management analytics, core README/release documentation |
| Snapshot/result/cleanup/ack persistence | `web/lib/db/schema.ts` + migration SQL/journal/snapshot; `docs/database-schema.md`, `docs/db/agents-domain.md`, `runs-domain.md`, `attention-domain.md`, execution-host domain if changed; regenerate `docs/db/erd.dbml` |
| Operational result and failure diagnostic projection | `web/lib/run-results/*`, `web/lib/runs/run-result-dto.ts`; `docs/system-analytics/run-results.md`, `docs/api/web.openapi.yaml`, `docs/api/external/operations.openapi.yaml`; `mcp/src/tools.ts` run_collect/run_delegate descriptions and contract tests |
| Terminal lifecycle/events, parents/queue/attention | Agent finalization/prompt-owner; `docs/api/async/web-runs.asyncapi.yaml`, `outbound-webhooks.asyncapi.yaml`, domain-event contract if widened, `attention-stream.asyncapi.yaml`; agent/result/scheduler/attention analytics |
| Permission checkpoint/resume across multiple requests | Agent permission/pause/continuation plus supervisor only as needed; `docs/supervisor.md`, `docs/api/supervisor.openapi.yaml`, `docs/api/async/supervisor-sse.asyncapi.yaml`, narrow external ACP spec only if wire changes |
| Workspace disposal, preservation and evidence lifetime | GC/lifecycle/runtime-object retention; workspace/reconciliation/execution-object analytics and run ERD; `site-docs/guides/run-git.md` and RU parity for diagnostic limitations |
| Run/history/automation/attention/action payloads | Queries and route DTOs; `docs/api/web.openapi.yaml` including agent automation rows; external operations OpenAPI; screen docs `chrome/active-workspaces.md`, `projects/project-automations.md`, `runs/workbench.md`, `runs/run-inspector.md`, `runs/list.md` |
| Error/refusal reasons and UI copy | Existing MaisterError codes with typed details/reasons; `docs/error-taxonomy.md`; EN/RU message catalogs and accessible labels |
| Agent-authored instructions | Platform prompt appendix/structured-output instruction source and drift tests; both plugin definitions and shared intake SKILL.md; do not change unrelated Flow DSL grammar |

Identifiers and authorization for touched routes:

- Launch: project slug/agent ID are URL params; principal comes from auth-context; attachment/package/workspace/run contract come from server-state. Body workspace/delegation/config inputs are untrusted and must pass operational combination/grant checks before allocation.
- Run detail/result/history/collect: runId is URL/tool input, principal from auth-context or owner-bound token; project/kind/contract/result are server-derived. Apply existing run visibility and repository/evidence grants to the actual response data class.
- Permission response: runId/hitlRequestId URL params; response option is body-controlled and checked against server-held request/options; session/request/assignment identifiers are server-state. Persist intent before host delivery; mark delivered/responded only after delivery. 4xx stale/conflict refuses; network/5xx leaves retryable intent; never cross-answer a different request.
- Delivery/sync/publication routes: runId/workspace ID from controlled URL/server lookup; destination/ref inputs untrusted; frozen operational guard runs before any remote/Git side effect and again under the apply claim.
- Attention acknowledgement/cleanup re-arm: the two explicitly planned operational routes use URL runId and auth-context actor; body reason/revision are compared to server-held terminal/cleanup facts. Acknowledge exact reader/revision under row lock/CAS; identical prior acknowledgement is idempotent. Re-arm persists its intent/receipt before scheduling cleanup and answers 202, not a removal claim. See the Phase-0 operation worklist for stale/conflict/replay semantics; no filesystem path comes from the body.

No body-controlled filesystem paths or redundant cross-resource locators are introduced. Host commands retain assignment fences and opaque workspace handles. Failed reads never write terminal business success. External side effects use existing durable intent/delivery protocols; cleanup is post-commit, lease-owned and recoverable, not a distributed transaction pretending to be atomic.

## Commit plan and release sequence

Commit checkpoints are logical implementation boundaries; each behavior checkpoint includes its owning tests and current contract changes.

1. After T1–T3 and T21: `docs: define operational agent lifecycle and result contracts`, plus `test: enforce operational requirement traceability` if the tooling change warrants its own commit.
2. After T4–T6: `feat(agents): add operational definitions and frozen launch contracts`.
3. After T7–T9: `feat(agents): validate operational outcomes and forbid code delivery`.
4. After T10–T12: `fix(agents): preserve parallel decisions and dispose operational workspaces safely`.
5. After T13–T15: `feat(ui): show operational outcomes and actionable failures`.
6. Plugin repository after T16–T18: `feat(core): adopt operational results for GitHub intake` (independent commit/tag lifecycle). Platform contract/doc qualification changes stay in MAIster commits.
7. After T17–T20: `test: qualify operational agents across lifecycle and package boundaries` with final as-built docs and any small reviewed fixes. Tests for earlier behavior are committed with their owning implementation, not introduced here for the first time. RED/GREEN receipts can precede the final green commit; do not leave a broken published checkpoint.

Use the existing maintenance/admission fence while replacing workers: drain/checkpoint existing work as appropriate, stop old web/scheduler/GC writers, apply additive migrations with recorded backup/ledger receipt, start only the new compatible platform/supervisor binaries, run db:check and smoke gates, then lift maintenance. The fence alone does not prove every old draining control is stopped. Do not admit an operational run while an old finalizer or cleaner can process it. Initially keep old core pinned. Complete platform acceptance, then qualify and release core, then upgrade attachment pins. Exact core version/tag is selected at release after checking existing tags; do not assume 1.3.1 or reuse core/v1.3.0. Record MAIster SHA/engine version, plugin SHA/tag, schema contract digest, test receipts and rollback prerequisites together. No deployment action is authorized by this planning pass.

## Resolved preflight decisions and retained limits

1. Names and versions are `code_delivery`, `operational`, `operational_v1`, engine 3.9.0, ADR-194 and migrations 0194–0198. Live integration bases and numbering were verified before qualification; no technical question remains open.
2. The persisted terminal/baseline/cleanup contracts, per-reader acknowledgement DDL and all changed API/event/MCP surfaces are implemented and verified against their owning specifications. Generated migrations and forward custom guards preserve historical rows.
3. Crashed execution uses existing `gcAgeDays` (default 14 days) for diagnosis, with stronger existing command/runtime-object holds. Checkpoint continuation keeps its original run; an unrecoverable terminal attempt requires explicit reconciliation and a new attempt.
4. Overlapping imports against the same project/source retain the existing intake restriction. Removing it would require a separate generic source-claim design. Independent operational runs and distinct permission decisions are supported and qualified.
5. Operational Flow/persona/subagent bindings, persistent sessions and shared writable workspaces are intentionally refused in the first release. Supporting them requires separate parent/child completion and resource ownership contracts.
6. Historical stranded Review runs retain their original semantics. Operator repair of selected old intake runs is separate work; there is no automatic agent-ID reclassification.
7. Rollback keeps additive database/evidence state and requires compatible finalization/cleanup readers. Repin compatible core and drain admitted operational work before any downgrade; do not use old writers against operational rows or clear immutable snapshots to force compatibility.

## Feature acceptance

The feature is accepted only when both intake definitions use the new contract; success including zero-new-work becomes Done without delivery actions; partial/403/malformed output becomes actionable failure with preserved evidence; source violations cannot become accepted/promoted output; snapshots survive package change; independent runs and parallel permissions work; completed operations leave active working copies and dispose safely; evidence survives disposal; and existing code-delivery Review/promotion remains unchanged. Platform/package compatibility and release-order tests must pass against the exact candidate revisions.

## Implementation evidence

- Specification freeze: ADR-194, three operational analytics, 34-row matrix, persistence ERD and web/ext/event contracts. `pnpm validate:contracts` and `pnpm validate:docs:all` pass under Node 24.15.0. No new environment variable, binary, port or mount is needed.
- T21 RED: existing parser returned an empty task set and the operational group was absent. GREEN: 24 script tests pass, including legacy groups; operational coverage reports 34 IDs/rows and 15 enforcing implementation tasks. Planned rows intentionally await their behavior phase.
- Baseline: original web unit suite 885 files / 9227 tests passed; the original full integration run exposed librarian continuation, projection-worker and permission-terminal harness failures before product edits and was interrupted at schema cutover. No full baseline integration pass is claimed. Discovery, deterministic provider/ACP seams and RED commands are established; full regression qualification remains open. Logs live under `/private/tmp/operational-agent-*`; these local receipts do not claim hosted acceptance.
- Plugin candidate checkout: `/private/tmp/maister-plugins-operational-agent-kind`, branch `codex/operational-agent-kind`, source 0bab5fa5bd41ff825e160ed5a998412c2537c29e. Original plugin checkout is untouched.

- Phase 1 implementation checkpoint: definitions default to code_delivery; operational declaration is explicit and independent. Engine/package floor is 3.9.0, zero-flow CLI validation checks actual agents. Runs freeze schema/digest, semantic version, definition and package provenance; Pending dispatch and resumed generation prompts read that snapshot. Migrations 0194/0195, registry SET/CLEAR/re-SET, snapshot mutation refusal, seeded normal-migrator upgrade, re-entry and failed-DDL rollback pass (29 targeted integration cases). Typecheck, contract validation, Drizzle no-residual-change gate and regenerated ERD pass. Full unit execution covered 9230 cases: corrected ownership inventory and two harness timeouts pass on the 13-case isolated rerun. Full integration and two isolated runtime-suite reruns remain in progress; this checkpoint is not full feature acceptance. Their later owning acceptance is recorded below.

- Phase 2 implementation checkpoint: source integrity hashes all non-Git material including ignored/binary files, index and reflog, with trusted parallel-ref evidence. Platform materialization appends exact generation hashes; home-redirect runtime homes use a separate managed sibling. Operational result validation drives atomic write-once terminal decisions; cancellation/crash and competing finalizers preserve status/result semantics. Frozen server guards refuse delivery/publication/PR/sync/reattachment including paused-budget bypass. Owning integration suites pass 55 cases, unit suites pass 432 cases, filesystem ownership passes 9 cases and typecheck passes. Remaining actual-launch composition, exhaustive lifecycle/cleanup, projections and final full regression are still open; this is not feature acceptance.

- Phase 3 implementation checkpoint: parallel live/checkpoint permissions retain separate choices and delivery receipts; operational business questions checkpoint and resume the same run with the confirmed answer bound to the next prompt. Real supervisor business-question and two-run concurrency scenarios pass; the existing 54-case prompt-owner suite passed before the final answer-binding refinement and remains scheduled for final regression. Durable disposition reuses lifecycle claims, preserves ignored/binary and Git history evidence in opaque objects, releases the original host assignment, bounds retries, rotates progress and excludes operational resources from legacy collectors. Unknown agent ownership is retained for diagnosis. Forward migrations 0196/0197/0198 add cleanup progress, correct ordered generation append enforcement and extend lifecycle events; previous applied migrations are unchanged. Owning cleanup/migration/default-question suites passed 53 cases; cleanup unit composition passed 27 cases; retention/history suites passed 19 cases. Full acceptance and remaining adversarial cases are still open.


- T4–T9 acceptance is qualified by the preserving migration/registry/snapshot suites, supported zero-flow exact-core install/attach, four owned-resource integrity/disposal scenarios, structured result/transaction suites, real launch concurrency and server delivery/default-promotion tests. Their tasks are checked complete. Phase 4 shared projections/acknowledgement/authorized routes/active-history composition pass 21 integration cases; live attention stream passes 18 cases; both EN/RU browser scenarios pass with zero retries. Full web unit qualification passes 885 files / 9,230 tests. Full integration is running serially on isolated databases; global acceptance remains open.

- T10–T15 owning acceptance: live/checkpoint parallel permission choices, sequential business questions, orphan compensation, conflicting-generation refusal and safe cleanup are qualified; final cleanup/result owners pass 32 cases, migration/snapshot/integrity/delivery/package owners pass 69, history/stream owners pass 22, and both EN/RU browser compositions pass without retries. Studio kind/completion changes are atomic and preserve body/workspace. Full regression aggregation remains T19.

- T16–T18: current-state analytics, ADR, persistence, API/event contracts and public EN/RU guides are reconciled. All 34 matrix rows are Implemented and resolve to discovered primary IDs; the coverage scanner now recognizes literal table-driven test titles (RED then GREEN without changing assertions or test identities).
- Exact cross-repository candidate: platform code `bd14107440ed7434f6bd20873c80a564f1031eae` (engine 3.9.0), plugin `fc24713c00558bf2aa72195c22c8433c42d6e21c`, core Git tree `fff0c64b57ed4153202be7a8c7862c2214a24323`, installer content revision `0c6fc725f93ea8fa8784884905aa9c9b53b82348`, schema SHA-256 `8c83781c8f59b78bd73d55484f82bfb1d2c905635dda645b3c09ff97e7e82cc6`. Proposed tag `core/v1.4.0` is absent remotely as checked through authenticated GitHub reads; no tag was created. Original plugin checkout is unchanged.
- Exact candidate CLI passes with zero flows, five agents (two operational), twenty skills and one evaluation method. Exact real install/attach plus CLI-subprocess/MCP controlled-provider compositions pass nine cases: empty, created task, partial receipt/page failure and HTTP 403 for both transports. These deterministic actors prove platform/package settlement and confirmed database effects; they do not claim live GitHub credentials or LLM instruction-following qualification. Receipt: `/private/tmp/operational-bd141-core-final.log` and `/private/tmp/operational-core-final-cli.log` on Darwin arm64, Node 24.15.0, owned ephemeral Postgres and local supervisor/provider fixtures.
- Final code-freeze web unit suite passes 885 files / 9,231 cases; owning question/projection/collect/attention contracts pass 43 integration cases, integrity/disposition pass 27, and exact-core qualification passes nine. Browser EN/RU scenarios pass with zero retries and zero invocation leaks. Contracts, five adapter mirrors, all internal docs/coverage, 142-table ERD, public links/anchors and no-residual Drizzle generation pass. The full integration run and current 57-case prompt-owner rerun remain T19 evidence in progress.
- T20 live-base audit: authenticated GitHub reads confirm platform master `4a0b41b2e1911b9ad5adda250f1b8a937b0daf46` and plugin main `0bab5fa5bd41ff825e160ed5a998412c2537c29e`; neither advanced beyond the implementation bases. No ADR/migration collision or rebase is needed. Adversarial review covered frozen readers, delivery guards, symlink/root/config integrity, exact ordered materialization, concurrent recorded archive refs, separate permission decisions, cancellation/late-result precedence, per-reader acknowledgements, fenced cleanup crash windows, evidence grants and retention. Root/config/ref probes, orphan compensation replay, sequential questions and cleanup release ACK recovery gained enforcing regression checks. No new runtime dependency, polling loop, approval bypass, status or MCP token grant was introduced.

- T19 regression gate reopened T10 after the full agent-steering suite reproduced a default persistent-run defect: the last reissued input counted its unacknowledged ancestor before completing that origin, leaving NeedsInput and preventing normal park. The fix settles the exact ancestor chain before the pending-decision query in the same delivery transaction. Existing steering T3.0(b) is the RED regression; full 13-case steering, 57-case prompt-owner and full unit qualification are running after the fix. No timeout, assertion, skip or runner setting was relaxed.

- Package delivery is durable in `/Users/kaa/Work/dev/github/maister-plugins` on local branch `codex/operational-agent-kind` at `fc24713c00558bf2aa72195c22c8433c42d6e21c`, copied from the qualification clone with a local-only fetch. The original `main` working checkout remains clean at its original SHA; no remote was changed.
- Browser acceptance now includes actual acknowledgement and cleanup-rearm POSTs, authorized response receipts, reader acknowledgement persistence and proof that rearming cleanup leaves Failed/blocked unchanged. All four browser cases (including auth setup) pass with zero retries and zero invocation leaks. Final MCP build plus 357 unit and six integration tests pass. All 34 primary requirement IDs occur in actual Vitest/Playwright discovery output, not only in source scanning.

- T10 is closed again after the exact ancestor-ordering fix: full steering 13/13, full prompt-owner 57/57, full web unit 9,231/9,231 pass with no added skips or relaxed checks. The existing T3.0(b) regression moved RED→GREEN by settling the ancestor before the pending-decision query.
- T15 final refinement: a browser RED case proved that a completed non-scan operation with created=0 was incorrectly labelled no-work. The result view now uses attempted=0 and generic localized operation wording. Both locales verify zero work versus actual completed work; all four browser cases, including real POST wiring, pass with zero retries and zero invocation leaks on owned E2E web port 3127. The fixed shared stub port was allowed to become free; no other checkout process or harness configuration was changed.

- Final regression aggregation: the serial broad invocation started at 2026-10-29 22:13 UTC before the later integrity/question/permission fixes. Its four flagged owning files have now passed in full on current code: prompt owners 57, steering 13, disposition 14 and agent-question service 17 (101 cases total). The initial broad result is retained separately; it is not reported as an all-green invocation. Current exact-core install/attach/provider qualification passes nine cases on `ac34bac14`; final contracts, five adapter mirrors, all internal documentation/coverage, 142-table ERD and lint of all 119 changed web TypeScript/JavaScript files pass. No skips or assertions were added or relaxed.

- Current repaired-suite receipts are `/private/tmp/operational-prompt-owners-ancestor-final.log` (57), `/private/tmp/operational-agent-steering-green.log` (13), and `/private/tmp/operational-cleanup-question-rerun.log` (31 across disposition and question service). Final package receipt: `/private/tmp/operational-ac34bac-core-qualified.log` (nine). Final static/spec receipts: `/private/tmp/operational-release-types.log`, `/private/tmp/operational-release-eslint.log`, `/private/tmp/operational-release-contracts.log`, `/private/tmp/operational-release-docs.log`, and `/private/tmp/operational-release-mermaid.log` (540 diagrams). Qualification uses Darwin arm64, Node 24.15.0, real isolated PostgreSQL databases, Git worktrees, local supervisor/controlled-provider fixtures and Playwright; no hosted CI or live GitHub mutation is claimed.

- T19 final acceptance: the full serial web integration invocation completed in 6028.20s with **593 passed / five failed / two skipped files; 5,309 passed / seven failed / two skipped cases**. It began before later fixes and retained pre-fix transformed modules. Its seven exact failures were: sequential operational question reuse; default steering permission ancestry; unrecorded Git configuration/plain-directory changes (two); recorded concurrent archive recognition; conflicting permission-generation recovery; independent operational question supersession. Every failed owning file subsequently passes in full on current code: **57 prompt-owner + 13 steering + 13 integrity + 14 disposition + 17 question-service = 114 cases**, no skips. The final integrity receipt is `/private/tmp/operational-integrity-release-rerun.log`. Replacing only those five file results gives **598 executable files / 5,316 cases qualified**; this is an explicit aggregation, not a claim that the initial broad invocation exited green. Its complete failed receipt remains `/private/tmp/operational-complete-integration.log`. The two unchanged optional skips are the existing opt-in event-plane and host-span load benchmarks; no required operational acceptance case is skipped.
- T19 remaining gates: full web unit 885 files / 9,231 tests; supervisor unit 50 files / 495 and integration 36 files / 319; MCP unit 357 plus integration six and build; both EN/RU browser compositions plus actual acknowledgement/rearm POSTs (four cases including auth setup, zero retries/leaks); exact core candidate nine install/attach/controlled-provider cases; all 34 primary IDs discovered by the actual runners; TypeScript, changed-file lint, contracts, five adapter mirrors, all docs/coverage, 142-table ERD, public-doc links/anchors/build and no-residual Drizzle generation. Earlier behavior checkpoints retain their RED→GREEN tests; the ancestry and generic zero-work UI regressions also have explicit RED/current GREEN receipts. Final uncommitted runtime edits are comments/import whitespace only, plus the current-state lifecycle diagram correction.
- T20 closed: the final authenticated live-base audit still matches MAIster master `4a0b41b2e1911b9ad5adda250f1b8a937b0daf46` and plugin main `0bab5fa5bd41ff825e160ed5a998412c2537c29e`. ADR-194, migrations 0194–0198 and generated schema/journal/ERD remain conflict-free; all affected writers/readers and action guards were reviewed against the frozen contract. There are no unresolved implementation questions or incomplete required tasks. Retained product limits and rollback requirements above remain explicit.
- Final qualified application code is `ac34bac1493cb38762ebf73f1fe5a52b1ea75382` (engine 3.9.0); the final handoff commit adds only acceptance bookkeeping, accurate lifecycle/persistence documentation, comments and import whitespace. Plugin delivery is local branch `codex/operational-agent-kind` at `fc24713c00558bf2aa72195c22c8433c42d6e21c` in the original maister-plugins repository; its main checkout is clean and unchanged. Release sequence remains maintenance/drain old writers → additive migrations and compatible platform → smoke/acceptance → new core release (proposed `core/v1.4.0`, not created) → project attachment pin upgrades. Deployment database checks, hosted CI receipts, live GitHub mutations and publication remain owner/release actions, not claimed local evidence.

Committed phase boundaries: specification/traceability `b67c4eb98`; definitions/snapshots `38e76981d`; results/integrity/delivery guards `0fed3674a`; permissions/disposition `673e28b1b`; UI/attention `258b8b7ac`; adversarial hardening `bd1410744`; contracts/package qualification `e2c9bad93`; ancestry regression `17e6f3213`; localized result refinement `ac34bac14`. Plugin phases are `bd14c3eba2131a8a3cb4303e66ac57a40047f71c` and `fc24713c00558bf2aa72195c22c8433c42d6e21c`. No remote state was mutated.


## Review remediation

The review at `6000b7444` reopened acceptance for the following concrete gaps.
Earlier receipts remain historical evidence, not proof of these new cases.

- [x] Context repositories: capture immutable witnesses before first dispatch, validate them on continuation and finalization, preserve unexpected changes, and never recreate mounted source on resume. Cover tracked/ignored/committed changes, absent legacy witnesses and snapshot immutability.
- [x] Context cleanup: propagate removal failures into durable retries and attention, preserve evidence before deletion, and converge after partial removal without losing the cleanup owner.
- [x] Operational UI and HITL wire: retain authorized Stop, follow shared UI conventions, return the documented continuation state, and verify real browser/HTTP behavior.
- [x] Current contracts and acceptance: reconcile operational status/migration claims, run the required gate battery, adversarially review the fixes, and commit verified phases.

The separate product proposal for a quiet operational rail, per-agent history
and deduplicated recurring incidents is not implemented by this remediation.
Current terminal runs leave active copies; active runs and per-run failure
attention retain their existing visibility until that product contract changes.

Review UI/API phase: `6f431fa74`. Current receipts: external HITL HTTP route
29/29, question service 17/17, Stop integration 9/9, browser four feature cases
plus authentication setup 5/5 with zero retries and zero leaked processes.
The browser covers EN/RU, actual Stop → Abandoned/released, stale cleanup revision
409 followed by successful retry, and shared mutation feedback. The response
regression validates the real route body against both published API schemas.
Logs: `/private/tmp/operational-review-{hitl-red,hitl-green,consumers,stop-consumers,ui-red,ui-green,ui-types,ui-lint}.log`.

Review runtime phase: `c647ee1a7`. Nine full owning integration suites pass
162/162 on the final implementation; the extracted shared context-consent
consumer additionally passes 5/5. The final receipt is
`/private/tmp/context-fixes-final-suites2.log`. Regressions cover dirty, ignored
and committed context changes; retained evidence bytes; immutable nested
baselines; missing witnesses/roots and descriptor mismatch; no-op and locked Git
removal; partial removal and partial initial creation; existing target refusal;
queued orphan cancellation; and both preparation/cancellation mutex orderings.
Both cancellation orderings preserve cleanup ownership and converge without Git
inside a PostgreSQL transaction. Per-run mutex metadata stays outside source
checkouts; no-context executions allocate no context mutex. No new migration.

Final review-fix gates pass: web and supervisor TypeScript; MCP TypeScript and
build; all API/event contract parsers and five adapter mirrors; all documentation
validators (540 Mermaid blocks, 4,333 links, requirement traceability and current
142-table ERD); six local-state reset tests; owned-file ESLint; diff whitespace.
An independent bounded adversarial rereview found no remaining blocker after
closing the preparation/cancellation race. This qualification is local and
focused on the fixes; the prior broad acceptance run remains a separate receipt.
All review findings are addressed. No remote push, hosted CI, production
migration or live GitHub mutation was performed. The quiet-rail/history/incident
aggregation proposal above remains unimplemented and needs its own specification,
API/persistence contract and TDD acceptance work.

## Follow-up product direction — specified, not implemented

The owner's clarification keeps every active agent run visible in the rail.
This supersedes the earlier suggestion to hide all operational run cards.
Completed operational runs must not accumulate there, whether successful or
unsuccessful. The review fixes above are complete; this follow-up is a separate
product change and is not included in their completed task checkboxes.

- **Active executions:** show individual agent runs in a distinct rail section,
  with a text/icon distinction rather than color alone. Preserve details, Stop,
  queue state and independent HITL requests. Existing scheduling already has a
  separate agent pool (`web/lib/scheduler.ts`, default three via
  `MAISTER_MAX_CONCURRENT_AGENTS`); operational and code-delivery agents share
  that pool. UI grouping must not imply a new capacity pool.
- **Project summary and agent page:** the project's Agents tab shows the last
  run's structured outcome and time, total run count, current activity and a link
  to the project-attached agent's page. That page contains paginated run history,
  memory, the effective prompt and configuration. Reuse existing memory access
  and mutation rules. History retains each run's frozen definition and result.
- **Prompt editing:** displaying the effective prompt is required; editing is
  a proposed extension whose scope must be specified before implementation.
  Distinguish package-definition editing through Studio from project-specific
  configuration/overrides. Any edit affects subsequent launches only and uses
  existing authorization and conflict/version checks.
- **Failures:** the owner accepts either one latest failure per agent in the
  rail or an Inbox item. The recommended design uses the existing Inbox decision
  queue, with one agent/project item summarizing unresolved incidents and linked
  run history. Repeated failures update counts and first/last occurrence rather
  than creating new rail cards or new project Tasks. Different actionable causes
  remain distinguishable inside the item; acknowledgement and recovery must not
  hide a new cause or a later incident. Keep the Inbox badge and list derived
  from the same canonical projection (`web/lib/queries/decisions.ts`).

Follow-up acceptance: every active execution remains individually accessible;
1,000 completed successes leave no terminal rail cards; repeated identical
failures produce one agent/project attention item with an accurate repeat count;
two simultaneous permission requests remain independently answerable. History
and summary counts agree, memory access remains scoped, prompt changes cannot
alter running or historical snapshots, and out-of-order concurrent completions
cannot falsely resolve an incident. Specify API/schema/migration compatibility,
EN/RU copy and meaningful RED→GREEN integration/browser coverage before building
the follow-up. Use existing live SSE updates, not a new polling loop.

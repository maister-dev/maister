# Implementation Plan: Scheduler clock and execution-event lag (P0-6 + P0-7)

Branch: `codex/scheduler-clock-ingest-lag`
Created: 2026-09-22
Status: Implemented; all tasks complete. Review remediation applied 2026-09-22 (see `.ai-factory/patches/`).
Method: specification-driven development (SDD), implemented in test-driven slices (RED → GREEN → REFACTOR).
Verified source: `7201d0607acc032c9c883a02df716cc9da4f5abf` (the supplied diagnosis baseline and this checkout's initial HEAD).

## Settings

- Mode: full. Plan only; no implementation, commit, merge, or push in this planning pass.
- Testing: yes, with the real Postgres/supervisor acceptance cases below. Small deterministic tests are appropriate for arithmetic and timer behavior; mocked sweep coverage alone is insufficient.
- Logging: structured INFO for samples/recovery, WARN for missing clock, retired configuration, overlap and sustained lag; DEBUG for bounded diagnostic details. Honor `LOG_LEVEL`; never log tokens, event bodies, prompts or runtime paths.
- Docs: yes, mandatory docs-first contract checkpoint and final as-built checkpoint through `aif-docs` during implementation.
- No new dependencies, database tables, columns, metrics service or time-series subsystem. One additive Postgres index migration supports ordered scheduler-attempt lookup (D7/T16); no SQLite migration. Existing scheduler attempt summaries retain their existing lifecycle.
- Runtime: repository Node 24 contract; use the existing isolated test database/supervisor helpers. Do not run the qualification lanes beside S5.2 isolation or another integration/E2E lane.

## Roadmap Linkage

Milestone: completed M24 maintenance amendment (P0-6/P0-7, 2026-09-22).
Rationale: this is the explicitly supplied execution-seam diagnosis P0-6/P0-7, related to Stage A/B stabilization and ADR-167 D8. It does not complete S5.2, P0-3, ADR-177 or a broader roadmap milestone. The stabilization plan remains outside this plan's edit ownership. `.ai-factory/ROADMAP.md` received one amendment recording this maintenance work, agreed as an exception to the line above.

## Outcome and boundaries

An administrator can establish, from `/admin/scheduler` and `/admin/execution-host`, whether periodic recovery is actually running, where event progress is behind, whether projection is poisoned, which durable workers are running, and whether accepted commands remain open. A configured external cron token is configuration evidence, not proof of a tick. A slow stream is observable without changing any execution decision.

`degradeStalledStream()`, `commandStreamLost()`, stall repair ordering, stream state values, command recovery decisions, node/run terminalization, the respond-route response shape, throughput/batching and outbox pressure policy are frozen. Lag must never write `execution_event_streams.state`, `last_error`, readiness or run state. Keep the two retired timers deleted; the scheduler remains the periodic sweep driver.

Per-run chips, P1 throughput work, S5.2 fixtures/refactoring, P0-3 behavior, P0-4 operator copy, and memory updates are not implementation deliverables here. A future memory update requires a separate explicit request.

## Source findings that change the proposed approach

| Finding at the verified revision | Consequence for this plan |
| --- | --- |
| `timer.ts` and `timer-config.ts` independently require exact `"true"`. | One configuration resolver must drive both boot and the card. |
| `claimDueJobs()` uses an atomic `FOR UPDATE SKIP LOCKED` claim/attempt insert; sweep leases renew. | Default-on is selected, conditional on real two-ticker qualification, not on an unverified claim about ADR-176 D2. |
| ADR-176 D2 is **Liveness is a probe, not a column**. | Do not cite it as evidence of scheduler two-instance safety. Existing scheduler integration tests provide the starting evidence. |
| `scheduler_job_runs` already stores start/finish/status/summary, but there is no complete-tick ledger. | Full tick duration and overlap are process-local; per-job activity is durable/cluster-visible. Label them separately. |
| The keepalive interval reader also feeds the live `runSweepTick()` log. | Remove that misleading interval field along with the dead timer and reader. |
| `runtime-data-boundary-inventory.ts` names `startKeepaliveSweeper`. | Claimed file disjointness is not exact: coordinate one deleted inventory entry with S5.2; do not refactor its harness. |
| Both host `SupervisorHealthResponseSchema` and the actual **web** `SupervisorHealthSchema` are strict. | New-web tolerance alone cannot repair an already-built old web. Negotiate the additive response with `?includeStream=true`. |
| `outboxBudgetSnapshot()` reads reservations as well as counters; `runtimeEventOutboxStats()` also examines physical storage. | Add a dedicated cheap health accessor; neither existing full snapshot is the `/health` implementation. |
| `getPlatformStatus()` is React request-cached but bypasses `resolver.ts`'s 30-second host memo. | Do not claim the pill already receives that memo. Keep heavy queries out of status rendering; define its coverage explicitly below. |
| The existing platform readiness pill is in `status-bar.tsx`, not in `left-rail.tsx`; the rail has runner readiness and launch copy. | Reuse the existing pill presentation, add the requested rail entry/link, and account for both chrome surfaces. |
| `recovery.ts` returns `impasse` per pass, and its historical lost-host lookup differs from `commandStreamLost()`. | Display **last sweep impasses**, timestamped; do not invent a cumulative counter or change the predicate. |
| Holding projection, throttling ingestion, and stopping ingestion affect different numbers. | Split L1/L2 into explicit scenarios; full ingest hold cannot prove an advancing-watermark predicate. |

## Decisions

The normative owner of each contract is listed in the traceability table below. Update that specification before changing its implementation, then derive acceptance tests from its observable requirements. This plan coordinates the work; it does not replace the canonical API/analytics contracts. Resolve conflicting prose/tables/examples in the same spec change. No completed implementation box may substitute for executed evidence.

### D1. Clock configuration and ownership

Choose option **(b)**. Preserve the current interval default of 60 seconds and current interval validation. Resolve one immutable configuration as follows:

| `MAISTER_SCHEDULER_TIMER_ENABLED` | Nonempty `MAISTER_CRON_TOKEN` | Driver |
| --- | --- | --- |
| unset | absent | `fallback_timer` |
| unset | present | `external_tick` |
| `true` | either | `fallback_timer` (token may also permit external ticks) |
| `false` | present | `external_tick` |
| `false` | absent | `missing_tick` |

Treat an empty assignment as unset and reject other nonempty values with actionable `CONFIG`; cover this explicitly rather than accidentally enabling a timer. Boot emits one WARN for `missing_tick`, naming `MAISTER_SCHEDULER_TIMER_ENABLED` and `MAISTER_CRON_TOKEN`, never the token value. Describe external cadence as an operator responsibility; the configured fallback interval is not the observed cron interval.

The job invariant is one live attempt for a due scheduler job, scoped to the job's existing database claim and renewable lease. The process-local timer guard is only for that process's interval callback; it is not a cluster lock. Keep the existing claim SQL and lease fences, and prove two `runSchedulerTick()` callers cannot dispatch the same due `system_sweep` concurrently before shipping the default change.

Introduce a lightweight `web/lib/scheduler/clock-health.ts`, using an interned global symbol like `workers/health.ts` so instrumentation/server bundles see the same process state. Record tick start, finish, duration, outcome and active count at `runSchedulerTick()` for timer, cron and explicit callers. Pair fields by invocation ID: overlapping manual/cron calls must not combine one tick's start with another tick's finish. Use monotonic elapsed time for duration and wall-clock ISO dates for display. Include process identity and observation time. Do not import timer/dispatcher modules from the read side.

Distinguish completed work, partial job failure, thrown tick failure and maintenance/no-op in the outcome contract. A resolved tick promise with failed jobs is not an all-green tick; a maintenance return is not proof that recovery ran. Show absent/disabled/overdue core jobs explicitly. Document the actual `runSchedulerTick()` return-to-outcome mapping in scheduler analytics before writing telemetry.

For an overlapping interval: increment total skipped and current streak; WARN only on the first skip with `streakLength: 1`; at completion emit INFO with final streak length, duration and outcome. The card shows total/current streak and last completed duration. A first warning cannot contain a streak's eventual length. Failed ticks must close their telemetry in `finally`; stop/drain and repeated startup remain idempotent. Process counters reset at restart and are labeled accordingly.

Use existing `listSchedulerStatusRows()` and its latest-attempt join to show per-job last started/finished/duration/status/next run. This is the proof of activity on another web instance. Never relabel a system-sweep duration as the duration of an entire scheduler tick.

The page's capped, next-run-ordered job list must not hide `system_sweep` or `domain_event_dispatch` behind 200 overdue project jobs. Add a targeted core-clock row loader sharing the same row projection, guarantee those two rows in the card, and disclose truncation/pagination of the remaining job list. Test that backlog-of-project-jobs case explicitly.

### D2. Retired timers and deployment

Delete the start/stop/global interval blocks for reconcile and keepalive, the now-unused reconcile reader in `instance-config.ts`, the private keepalive reader/default, and its obsolete live summary field. Preserve callable one-pass reconciliation/keepalive functions and their scheduler dispatch.

Warn once at boot when either `MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS` or `MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS` is present, including empty or invalid values. Ignore its value; do not refuse boot. Message: `ignored since P0-6 (2026-09-22); runs inside system_sweep on the scheduler clock`. Use this explicit retirement identifier because current package versions (`0.0.0`/`0.0.1`) do not distinguish the change; do not fabricate a release version.

Single-box deployment explicitly sets `MAISTER_SCHEDULER_TIMER_ENABLED=true`. External-cron/multi-instance instructions set it `false`, configure the token and schedule authenticated GET or POST `/api/cron/tick` every minute. Explain that missed external invocations stop periodic recovery, and verify actual job timestamps after installation. Include the authenticated command using a header, without embedding an example real secret.

Deployment is host-run web/supervisor plus **Postgres-only** compose. New web env documentation belongs in `.env.example`, `deploy/maister.env.example`, and the existing systemd EnvironmentFile flow. `compose.yml`, `compose.production.yml`, and `Dockerfile` are inspected, but gain no invented web service or environment block; `compose.override.yml` does not exist. No new volume, port or dependency is needed.

### D3. Additive host health with genuine mixed-version behavior

Document OpenAPI before implementation. Plain `GET /health` keeps its old response shape so the old strict web can still register a new host. `GET /health?includeStream=true` includes:

```text
stream: {
  streamId: string,
  headSequence: decimal-string | null,
  unacknowledgedCount: nonnegative-safe-integer,
  retainedCount: nonnegative-safe-integer,
  pressured: boolean,
  oldestUnacknowledgedAgeMs: nonnegative-safe-integer | null
}
```

`headSequence` is the last committed sequence (`next_sequence - 1`), not the next allocatable sequence and not the largest retained row. Empty stream => null; purged acknowledged history must not reduce the head. `pressured` means the existing event-outbox pressure bit. The oldest unacknowledged age uses the host's own observation time and the first logically unacknowledged event's host-stamped `created_at`; zero unacknowledged rows => null, not zero-age work.

Expose `HostState.runtimeEventHealthSnapshot()` (new) through one SQLite statement returning one row from existing stream identity/counters, the three budget rows, the pressure bit and an indexed pending-event lookup. Use the canonical logical ACK boundary, including lazy ACK materialization semantics. No event JSON decoding, wallet scans, filesystem stat/walk or pressure-policy mutation. This is one bounded result read, not a claim that SQLite touches only one physical row. Confirm the query plan on populated retained/ACKed/unACKed data.

Specifically, select the first outbox row with `e.stream_id = s.stream_id AND e.sequence_sort_key > COALESCE(s.acknowledged_sort_key, '') ORDER BY e.sequence_sort_key LIMIT 1`, using `runtime_event_outbox_stream_replay_idx`. `ackRuntimeEvents()` and `outbox-ack.ts` update an ACK range and counters without rewriting payload timestamps; **do not use raw `acknowledged_at IS NULL`** or synthesize every effective ACK timestamp. A fresh empty host may initialize its stream once before steady-state health reads; preserve that existing lazy identity initialization instead of fabricating a stream ID. Test a partially ACKed prefix whose raw timestamps remain null, then ACK everything and assert age null.

The new web requests the opt-in query and treats `stream` as optional. Make unknown response fields tolerant in the web parser, including the stream object's future extension keys, without weakening identity/known-field validation or unrelated command-envelope schemas. The old handler ignores this query, as verified at the baseline. Retain stream fields through `HostHealth`, `SupervisorHealth` and `toHostHealth()`.

The query contract is exact: omitted or one literal `includeStream=false` returns the legacy shape; one literal `includeStream=true` requests the block. Empty, repeated or other values return `409 PRECONDITION` with `details.reason=health_query_invalid`, matching this service's existing Zod/refusal convention; unknown query keys remain ignored for compatibility. Never coerce `"false"` with JavaScript truthiness. Specify these cases and the existing `503 EXECUTOR_UNAVAILABLE` storage-failure response in OpenAPI, with legacy, empty-stream, pending and fully ACKed examples. An opt-in snapshot failure returns the typed storage error; it must not omit the block and impersonate an older host.

`stream` is optional at the response boundary; if present, all six fields are required. Reuse the canonical sequence grammar/bound from `RuntimeEventSequenceSchema` (canonical nonnegative decimal <= signed BIGINT); `headSequence` is nullable for an empty stream; age has its separate empty-backlog null rule. Reject fractional/negative/unsafe counts, invalid IDs, nonfinite ages, and inconsistent count/age pairs. Require `unacknowledgedCount <= retainedCount`, with age null exactly when unACKed count is zero. A backwards wall-clock jump yields age zero plus a host diagnostic, never a negative age. Known fields remain validated. The producer's OpenAPI/schema can forbid unspecified output keys while the consumer ignores future keys: explicitly document this producer/consumer distinction instead of claiming identical strictness.

Identifiers: query `includeStream` is a validated presentation option, not a resource identifier. Host key, boot ID and stream ID are supervisor-owned server-state. No body-controlled host/run/path locator is introduced. Health access/authentication stays unchanged.

### D4. Arithmetic and bounded read model

Create one pure numeric module `web/lib/execution-host/events/lag.ts` and one I/O collector `events/lag-read-model.ts`, with DTOs in a client-safe type-only module. All sequence arithmetic is `bigint`; JSON/log/browser sequence values and differences are canonical decimal strings. Do not cast BIGINT to `number`.

| Metric | Definition |
| --- | --- |
| Host-to-manager ingest lag | `headSequence - lastReceivedSequence` |
| Manager contiguity gap distance | `lastReceivedSequence - lastContiguousSequence` |
| ACK confirmation distance | `lastContiguousSequence - lastAckConfirmedSequence` |
| Host ingest/ACK backlog | host `unacknowledgedCount` (not interchangeable with ingest lag) |
| Consumer/run sequence backlog | indexed `max(execution_events.run_sequence) - consumer.lastRunSequence` |
| Consumer service age | manager sample time minus `lastServedAt`, nullable when never served |

Sequences start at zero. Normalize a known never-received/never-served cursor to `-1n` for calculation; an empty horizon is `-1n` internally. First event `0` behind a null cursor yields `1`. Missing telemetry is unknown, not an empty stream. Sequence distances are not an exact count of missing rows when sequences contain gaps.

Join host telemetry only to the matching durable host and stream ID. Preserve boot ID/sample timestamps. A manager watermark ahead of a cached host head is a sampled-race/stale observation: expose the input numbers and unknown derived ingest lag, rather than a negative count or silently clamped healthy value. Identity replacement/restart resets comparison history. Inconsistent manager watermarks are an explicit diagnostic error, not zero lag. Timestamps describe age; duplicate events advancing `last_seen_at` never prove sequence progress.

Bound the consumer population to non-terminal runs using `run-status-sets.ts`, then obtain each run's actual horizon with an index-backed lateral descending read on `(run_id, run_sequence)`. Group by run once, join its consumers, order by backlog with deterministic run/consumer tie-breakers, then `LIMIT 20`. Do not pre-limit arbitrary candidates and call the result the top 20. Return population/scope and truncation counts. Non-terminal population size is not fixed by the concurrency cap (parked runs exist), so qualification must include many parked rows.

Projection work is the accepted canonical run sequence: filter `ingest_disposition='accepted' AND run_sequence IS NOT NULL`, matching `readProjectionEvents()` and `claimNextExecutionProjection()`. Include accepted manager/import events; do not treat pending gaps, stale epochs or quarantined host rows as projectable work. Explicitly test accepted-only horizon versus a higher unprojectable row. Read all manager-side numbers for one sample in one bounded read-only Postgres snapshot; health is separately timestamped and is never claimed to be atomically sampled with Postgres.

Consumers are run-scoped, not stream-scoped. Attribute a run's projection backlog to its **active execution assignment**, using the existing unique active-run assignment index. An unassigned run remains in an explicit unattributed group; do not drop it or guess from an arbitrary historical event/assignment. Do not duplicate its backlog onto all historical hosts. Report this as current ownership attribution, not a statement about where every historical event originated. Assignment/epoch changes reset that run's attribution; only the active local host's matching active stream participates in sustained-lag classification in today's supported topology. Historical host/stream rows are read-only paged diagnostics, not an unbounded observation map.

Query poisoned consumers separately, including terminal runs, with exact total and stable pagination (page size 20); each row carries event ID, cursor and error generation. Report per-host aggregates across the selected eligible population, not merely across the 20 displayed rows. Old/retired host rows remain visible with unknown live telemetry; only the supported local host is contacted. No multi-host placement or URL configuration is added.

Open commands use existing states/columns and indexes: counts by open state, accepted count and oldest accepted age; do not mislabel `created_at` as acceptance. Missing accepted timestamps are explicit. The existing `commandRecovery.impasse` is a timestamped last-pass result, not a new lifetime counter. Read readiness/reason, stream `last_error`, and the relevant latest node attempt's `error_code` together where a run is shown, without loading error/event bodies unnecessarily.

### D5. Sustained lag without new stream state

Defaults: `LAG_BACKLOG_THRESHOLD = 100` sequence positions/events, `LAG_CONSECUTIVE_SWEEPS = 3`, and `MAISTER_EVENT_STREAM_LAG_SECONDS=120` (the only new lag env; positive safe integer seconds whose millisecond conversion is safe, default only when absent; invalid/empty values raise `CONFIG`). Host eligibility means unACKed count **greater than** 100 and oldest unACKed age at least 120 seconds. Projection eligibility means the maximum attributed consumer backlog is greater than 100 continuously for at least 120 seconds, tracked by `projectionOverThresholdSince` in the prior stream observation. The maximum covers the full eligible consumer population, not just displayed top-N; it is aggregate persistence, not proof that the same consumer was behind throughout. `last_served_at` is displayed as service age only: claiming work updates it, so using it as backlog age hides actively serviced but slow consumers. When the maximum drops to <=100, reset its age. No per-consumer time-series state is needed.

For the same host/stream/boot identity, compare sweep samples with valid stream identity, manager watermarks and the qualifying backlog lane; unrelated missing diagnostics do not invalidate positive evidence. Stream progress means a manager received/contiguous/ACK watermark advanced, never just `last_seen_at`. The active stream must have progress and eligible host or projection backlog for three consecutive observations before the first `runtime-event-stream-lagging` WARN. The first sample establishes a baseline; stale/missing samples and gaps over two sweep cadences break consecutiveness. A held projector can qualify while ingest watermarks advance; a completely stopped ingest cannot. Consumer cursor progress is displayed numerically but does not substitute for the specified advancing-stream predicate.

Store only the bounded observation/streak metadata needed for the next comparison in the existing versioned `scheduler_job_runs.summary` for `system_sweep`. Read the immediately preceding attempt for that same job by `(claimed_at DESC, id DESC)`, excluding the current attempt; require a terminal status and a supported observation. An expired/reaped attempt or missing observation is a break, not permission to skip backward to an older success. D7's index owns this lookup. No separate observation writer/timer, new metrics table, or stream `last_error` field. Persist at most one current local stream observation, 20 top-consumer rows and 20 poison references, plus exact aggregate counts. Older/historical hosts and additional poison rows remain accessible through admin pagination. Do not copy arbitrary error bodies into this bounded summary.

Use the existing leased/fenced `recordJobAttemptResult()` persistence. Derive transition messages during collection; publish them only after that attempt's result CAS succeeds. One WARN when a qualifying streak first opens an incident, and one INFO `runtime-event-stream-lag-recovered` after a valid observation clears the qualifying backlog. A loss of progress while backlog remains is **not recovery**: expose backlog/not-advancing, retain the incident marker, and let the unchanged stall pass act independently. `lost` or identity change closes comparison as lost/reset, not recovered. Resumption during the same unresolved incident must not spam WARN.

Read-only page requests compute numbers but never advance streaks or emit transition logs. Alternating web owners load the same committed previous summary. A process death after commit but before its log can lose that transition log; after lease expiry it cannot publish an authoritative transition. This unavoidable log-delivery window is documented; the persisted summary and card remain the evidence. No exactly-once log-delivery claim.

Lag-read failures produce explicit `unavailable`/error fields and structured WARN, never healthy zeros or state degradation. Record them in `observation.errors` and the existing diagnostic `errors`, **not `bundleErrors`**: telemetry failure must not increment scheduler consecutive failures or disable recovery. An unrelated existing bundle failure keeps its original behavior and may still persist a valid observation in its failed attempt. The sweep still runs stall repair and command recovery in the original order. Collect lag after those passes so numbers reflect their resulting state, without changing either pass. Add observations, poison count, durable-worker health and command counts to the existing `system_sweep completed` summary, reusing `workers/health.ts` only. Label this pre-persistence log `sampled`, with attempt ID; only post-CAS transitions and persisted summaries are authoritative.

The versioned JSON contract is `summary.executionObservability = {schemaVersion: 1, attemptId, observerId, sampledAt, quality, errors, stream, consumers, poison, commands, workers}`. `quality` is `complete | partial | unavailable`; each source independently reports `available | unsupported | unavailable` with safe reason codes. `stream` includes matched identity, previous sample ID, watermarks, raw numbers, `projectionOverThresholdSince`, streak count, incident-open flag and `verdict`. Missing/older/newer unsupported schemas display unavailable and reset qualification; they never crash the scheduler/admin reader. Use one runtime parser on persisted JSON and typed DTOs; do not scatter `Record<string, unknown>` field probes among readers.

Pure observation transition table (no database or logging inside the reducer):

| Input | Next observation and log intent |
| --- | --- |
| First comparable active sample | `observing`, streak 0; establish baseline/above-threshold age; no WARN. |
| Comparable, progressing, eligible sample | Increment streak, saturating at 3; at 3 set `lagging` and open incident; WARN only if incident was closed. |
| Backlog above threshold but age not reached | `observing`, streak 0; preserve above-threshold start. |
| No stream progress while backlog remains | `not_advancing`, streak 0; retain open incident; no recovery. |
| Complete sample with both backlog lanes <=100 | `clear`, reset streak/age; recovered INFO only if an incident was open. Zero is the catch-up target, while <=100 is the warning-clear boundary. |
| Missing/stale/incomplete comparison, including DB timeout | `unknown`, streak 0, reset above-threshold age; preserve a known open incident for the same identity without declaring recovery. |
| Stream closed/lost or host/stream/boot identity changed | `inactive`/`reset`; discard that comparison's streak/age/incident; no recovered INFO; existing lost logging remains its owner. |

Freshness means samples no more than two 60-second **job cadences** apart, independent of fallback-timer interval. Duplicate sample/attempt IDs are not an extra sweep. Unsupported optional host metrics do not erase available projection arithmetic: they prevent a globally clear verdict, but projection-only positive evidence can qualify a lagging verdict when stream identity and progress are known. A missing source can never clear an incident. Old summaries with no incident state necessarily restart observation; document that upgrade window rather than fabricate continuity.

### D6. Cheap platform summary and admin surface

Strict default for the platform pill is the request's **health-only** constraint: add one `lag` summary field derived from the same optional host health sample, with `scope: host_backlog`, `clear | behind | unknown`, and sample time. `behind` here means aged host backlog above the documented thresholds; it is not the persisted three-sweep stream-lagging classification. Projection-only backlog is visible on the admin page/sweep, but cannot be inferred from `/health`. The UI must name that scope rather than claim all event consumers are caught up.

The alternative discussed during planning is a shared 30-second single-flight platform snapshot that reads health plus **one latest scheduler summary** on TTL expiry; it never runs the consumer backlog query. That would permit the pill to summarize projection lag across web instances, but deliberately relaxes health-only. With no changed preference supplied, this plan selects the strict default; the alternative is not an implementation task. The selected default needs no extra DB query or new polling timer; retain the current React request cache and current health call frequency.

Keep `PlatformStatus.kind`/readiness semantics unchanged: a host can be ready and behind. Status decoration must not disable launch or alter board behavior. Non-admins receive only the coarse safe summary, no host identifiers, errors, command IDs or cross-project details. Only admins get the navigation link to `/admin/execution-host`. Reuse `PlatformStatusPill` in the requested rail placement and the existing footer presentation; add no additional fetch per component. Cover expanded/collapsed/mobile rail navigation and retain runner readiness separately.

`/admin/execution-host` is an RSC-backed read-only page with:

1. Host identity/readiness/reason, boot ID, last seen, version and capabilities; host failure remains visible alongside stored manager data.
2. Stream state, sample times, manager watermarks, host head/backlog/age/pressure, errors, claim owner/expiry and a separately labeled lag observation.
3. Top-20 eligible consumer backlog with state, service age, retry time, host/run identity and run link.
4. A separately paged poison section, including terminal runs and exact repair command.
5. Current-process durable-worker health, labeled with process identity; latest sweep worker snapshot labeled with its own observer/time. Do not claim cluster-wide worker health from a local slot.
6. Open command counts/oldest accepted age plus last-sweep impasse count and diagnostic context.
7. Scheduler-clock summary linking to `/admin/scheduler`.

The repair text uses the existing CLI, with all five shell-quoted arguments:

```text
pnpm --filter maister-web execution:projection:rearm --consumer '<consumer>' --run '<run>' --event '<event>' --cursor '<decimal-or-null>' --error-generation '<uuid>'
```

Use the same evidence fields checked by `rearmExecutionProjection()`; no command if poison event/generation is missing or invalid. Show an actionable explanation. Copying a command is the only affordance: no automatic rearm or new mutation endpoint.

Data class is platform-wide operational metadata, so `requireGlobalRole("admin")` runs before the detailed collector. Query pagination is validated and bounded, with no client-selected host URL. Run/host IDs are server-state; no body-controlled resource IDs. EN/RU labels, accessible text-plus-color states, loading/error/empty/unsupported/stale views, full-width responsive tables and URL-backed pagination follow existing conventions.

Literal member HTTP 403 needs an explicit response mechanism: existing pages throwing `MaisterError` alone do not establish an HTTP 403 contract. Plan a page-local translation of only `UNAUTHORIZED` into Next's `forbidden()`, with `experimental.authInterrupts` and a localized forbidden boundary, while retaining the DB-authoritative role gate. The framework calls this experimental; qualify direct navigation, client navigation and production rendering before accepting this choice. Reference: [Next.js forbidden](https://nextjs.org/docs/app/api-reference/functions/forbidden). No replacement by a 200 error message or 500 is acceptable. Do not alter authorization behavior of other pages.

### D7. Additive index migration and JSON compatibility

Add `scheduler_job_runs_job_claimed_idx` with physical ascending keys `(job_id, claimed_at, id)` to `web/lib/db/schema.ts`; PostgreSQL serves the production `(claimed_at DESC, id DESC)` lookup with a backward index scan. The existing job-only index does not support the ordered prior-attempt lookup without sorting growing history. Keep the existing indexes; removing one is unrelated optimization. The query must order by both keys, exclude the current attempt and inspect the immediately previous row, rather than filtering out failed/reaped attempts and fabricating continuity.

At this revision the latest main migration is `0172`; the candidate is `0173_scheduler_observation_lookup`. Recheck the journal at implementation/integration time and use the next free number, updating references together. This plan does not reserve a number across worktrees. Generate SQL, `_journal.json` and the corresponding snapshot using the existing Drizzle workflow; never rewrite applied migrations or hand-invent a snapshot. Update `docs/database-schema.md`, `docs/db/scheduler-domain.md` and regenerate ERD/DBML through `db:erd` as required by its check. No new table, column, SQLite migration, Brain migration, backfill, enum/state or writer-version floor is justified.

Apply the additive index before deploying the new reader. Use the existing transactional migration runner and a maintenance window: ordinary index creation can block writes to this attempt ledger. Set a bounded migration-session lock timeout, fail visibly if it cannot acquire the lock, and retry during an operator-controlled window; do not introduce an ad hoc concurrent-index runner. Measure the populated-fixture build time and record the deployment lock/size expectation. A repeated normal migration run must be a no-op. Old binaries can use the migrated schema and ignore the new JSON member. Rollback leaves the harmless index in place; any later removal is a separate forward migration.

The persisted observation contract is additive application JSON, not a new database schema. Version handling, nullable/unknown fields, error codes, timestamps and summary-size limits belong to `scheduler.md`; arithmetic/source semantics belong to `execution-event-plane.md`. Cap the new `executionObservability` member at 64 KiB of UTF-8 JSON, omitting lowest-priority detail rows if necessary while retaining identity, comparison state, exact totals and explicit truncation. Never truncate a decimal or silently discard the state needed for the next comparison. Do not copy raw error bodies, commands or event envelopes into summary history.

## Specification ownership and requirement traceability

Each requirement below must have normative prose, input/output examples and failure behavior before its RED test. Extend existing analytics rather than creating a parallel architecture document. Add clock lifecycle and observation-transition diagrams to scheduler/event-plane analytics; diagrams, tables and code must agree about ownership. A migration index changes the index inventory, not entity relationships. Create only the missing screen document using its enforced template/index.

| Requirement | Canonical contract/specification | Implementation tasks | Primary acceptance evidence |
| --- | --- | --- | --- |
| R1 Clock resolution, boot warnings, external ownership | `scheduler.md`, `configuration.md`, `deployment.md` | T1/T2/T4 | C1 |
| R2 Tick outcomes, overlap and competing claims | `scheduler.md` clock lifecycle and card MUST list | T4/T6 | C2/C4; browser checks presentation only |
| R3 Retired timers and ignored knobs | `configuration.md`, `reconciliation-gc.md` | T2/T5 | C3 |
| R4 Negotiated health, validation and version skew | `supervisor.openapi.yaml`, `execution-hosts.md`, linked `supervisor.md` | T1/T7 | L4/H1 |
| R5 Exact ingest/gap/ACK/projection arithmetic, attribution and top-N | `execution-event-plane.md` Lag vs stall and read-model contract | T8 | Q1/O2; L1 proves live integration |
| R6 Durable sample/incident lifecycle and diagnostic failure isolation | `scheduler.md` summary JSON contract, `execution-event-plane.md` transition table | T9 | O1/O3/L1a/L1b |
| R7 Frozen stall/lost authority | `execution-event-plane.md`, existing ADR-177 semantics | T9/T13 | L1c/L2 and existing stream-health/impasse suites |
| R8 Admin diagnostics, poison repair text, role boundary | `docs/screens/admin/execution-host.md`, existing authz contract | T10/T11/T12 | L3/E1; admin integration owns read-only/data gating |
| R9 Coarse health-only pill, readiness unchanged | `execution-hosts.md`, chrome screen contracts, platform DTO | T11 | E2 |
| R10 Indexed lookup, migration lineage and bounded cost | `docs/db/scheduler-domain.md`, `database-schema.md`, D7 | T16/T8/T14 | M1/P1 |
| R11 Operator docs, rollout and delivered scope | deployment/configuration/screens, dated ADR-167 D8 amendment | T1/T2/T12/T15 | DOC1 documentation gate and deployment smoke |

Paths abbreviated in this table resolve to the explicit paths in owning tasks. `docs/api/web.openapi.yaml` and runtime AsyncAPI are reviewed for impact but unchanged: there is no new admin API, cron payload change or event envelope. The admin RSC DTO and platform `lag` DTO are internal TypeScript contracts, with normative field/null/security rules in analytics; do not invent an HTTP endpoint to document them. Public `/health` request/response/errors/examples are OpenAPI-owned. Producer schema, client parsing and fixtures must be checked against that contract, including both compatibility directions.

## SDD and TDD execution protocol

For **every behavior slice**, complete spec → RED → GREEN → REFACTOR before marking it done. T3 freezes scenarios/fixtures and discovery, not a large batch of failing tests left until the end. Before each test's implementation, run it and record the expected behavioral assertion failure. Missing imports, undiscovered tests, syntax errors, absent services and fixture/setup crashes are not RED evidence; a compiling seam may be introduced without the behavior to reach the intended assertion. Existing-behavior preservation tests may already be green and must be labeled baseline guards rather than falsely claimed RED.

GREEN implements only the owning requirement. REFACTOR removes duplicated logic, tightens types and separates pure calculation/transition code from database, transport and presentation effects while keeping those tests green. Use existing error types, lease helpers and query projections; no generic metrics framework, broad interface hierarchy, flag-driven multi-mode services, or independent copies of formulas in UI/log code. Follow SOLID through small responsibilities and explicit dependencies, and KISS/DRY through reuse, not speculative abstractions.

| Slice | RED authored/run before production change | GREEN owner | REFACTOR and boundary checks |
| --- | --- | --- | --- |
| Clock/default/retirement | T4 C1/C2/C4; T5 adds C3; T6 failing clock-card browser assertions | T4, then T5, then T6 | One resolver/telemetry model; preserve queue assertions, shutdown and cluster fences |
| Schema lookup | T16 M1 against predecessor schema: missing index/required ordered lookup | T16 | Generated schema/journal parity, existing rows unchanged, rerun migration no-op |
| Health | T7 L4/H1 over real Fastify/SQLite bodies and baseline parser fixture | T7 | Cheap accessor, one known-field schema, independent old-version oracle |
| Arithmetic/collection | T8 Q1/O2 and L1a/L1b raw-number assertions before adding collection | T8 | One arithmetic source; actual SQL/exact top-N; pure tests only for combinatorial number edges |
| Observation lifecycle | T9 O1/O3 and L1/L2 warning/recovery/non-degradation assertions before sweep wiring | T9 | Pure reducer plus fenced persistence/logging; unchanged stall functions |
| Admin/security/UI | T10 failing detailed authorization/read-model assertions and E1 production response; T11 L3/E2/browser field/link assertions | T10, then T11 | One read model/formatter, role check before detailed I/O, no heavy chrome query |

Author `lag-observability.integration.test.ts` incrementally in T8/T9, and `admin-execution-host.spec.ts` with authenticated discovery in T10/T11. T12/T13 are acceptance reruns and documentation closure, **not the first time those tests are written**. T4's boot suite initially covers C1; extend it with C3 at T5 and card assertions at T6 so task dependencies do not form a cycle. Tests remain committed with their corresponding behavior, not as an unrelated late testing commit.

Coverage has one primary owner per invariant: pure tests own arithmetic/reducer edge combinations; real PG owns joins, horizons, attribution, migration and CAS; real supervisor+PG owns live backlog and recovery causality; browser tests own rendered contract, roles and navigation. Do not repeat the full arithmetic matrix in E2E or add tests that only assert constants, mocks, private call order or line coverage. Use small table-driven cases where their failures distinguish requirements. Reuse fixtures while keeping independent expected values; do not compute test expectations with the production helper being tested.

Evidence per requirement: spec section, exact test name/command, RED assertion output, GREEN output, refactor rerun, source revision and any environment limitation. Store command logs/query plans outside runtime/worktree roots with the final handoff pointing to them. Final falsification supplements the original RED record; it cannot replace it. An unrun/blocked case stays pending, and an obsolete expectation requires a named spec change.

## Performance and failure budgets

- Test on isolated populated Postgres with 50,000 runs, a realistic long event history, many terminal rows, at least 1,000 non-terminal/parked rows and multiple consumers; include one very large backlog outside the first 20 run IDs and at least 50,000 scheduler attempts for one job. Capture `EXPLAIN (ANALYZE, BUFFERS)` for the actual production queries, including prior-attempt lookup, not simplified counts.
- Initial acceptance budget on a quiet machine: added collector SQL p95 <= 250 ms over 20 warm samples; added healthy-host sweep observation p95 <= 1 s; failure path bounded to 2 s by host timeout and SQL statement timeout. These are targets to qualify, not measurements already obtained. If they fail, optimize the query within scope or amend this plan before shipping; do not increase timeout/candidate truncation silently.
- Show that the horizon reads use `(run_id, run_sequence)`, and the host health scalar query uses existing stream/outbox order and counter indexes. No scan of all historical events, no JSON envelope decoding, no filesystem reads. Distinguish bounded returned rows from work proportional to active consumers.
- A timeout yields an explicit incomplete observation and breaks the streak; it must not abort the remaining unrelated system-sweep passes or turn a host lost. Enforce cancellation/statement timeout and release the read transaction/connection; a JavaScript timeout race leaving SQL running does not satisfy the bound. The existing job lease/renewal contains the added worst-case 2 s; re-measure the complete sweep and retain its heartbeat protection.
- Large decimal sequences above `Number.MAX_SAFE_INTEGER`, null cursors, unknown host capability, negative sampled deltas, duplicate-only traffic, stream reset, deleted runs and cross-instance sample age are acceptance cases.

## Tasks

### Phase 0 — Freeze the observable contracts

- [x] **T1. Write the docs-first design and compatibility contract.**
  - Files: `docs/api/supervisor.openapi.yaml`, `docs/supervisor.md`, `docs/system-analytics/execution-event-plane.md`, `docs/system-analytics/execution-hosts.md`, `docs/system-analytics/scheduler.md`, `docs/decisions/adr-167.md`, `docs/database-schema.md`, `docs/db/scheduler-domain.md`; draft the new screen contract at `docs/screens/admin/execution-host.md` and its index entry.
  - Deliver D1–D7 and the R1–R11 traceability: exact formulas/null semantics, thresholds/progress/streak/reset, status separation, sample scope, typed/versioned summary, query/error/response examples, unchanged default health, clock truth table, per-process labels and index migration/rollback. A dated ADR-167 amendment is **Designed** until T15; mark only this observability subset as-built later, not every metric promised in D8.
  - Enumerate enforcement points (CAS, read-only collector, schema parser, tests); preserve all existing stall/refusal transitions. No new ADR number or entity relationship is needed; index inventory/generated artifacts are owned by T16. Record the health-only pill limitation and the experimental 403 mechanism explicitly.
  - Logging: document messages/levels/fields and the commit-to-log crash window; no executable logging changes.
  - Acceptance: internally consistent analytics, OpenAPI examples and status tags; `pnpm validate:contracts` and `pnpm validate:docs:all` pass. Dependencies: none.

- [x] **T2. Deployment wiring and retired-env contract.**
  - Files: `.env.example`, `deploy/maister.env.example`, `docs/deployment.md` sections 4/7, `docs/configuration.md`, `docs/getting-started.md`, `docs/system-analytics/reconciliation-gc.md`.
  - State default-on resolution, explicit single-box setting, external cron authentication/cadence/verification and rollback; cross-link canonical configuration rows. Add the one lag-age env with default 120 s, constants, and retirement rows; stop advertising dead interval knobs as live timers.
  - Inspect `deploy/maister-web.service`, `Dockerfile`, `compose.yml`, `compose.production.yml`; keep the actual host EnvironmentFile wiring, with no irrelevant compose edits. Docs are marked planned until the corresponding runtime ships.
  - Logging: document boot WARNs and post-install clock evidence without printing secrets. Acceptance: examples agree with D1/D2; all new runtime knobs have a deployment destination. Depends: T1.

- [x] **T3. Freeze acceptance fixtures, ownership and discovery.**
  - Files: existing tests named in the matrix; new test files specified in later tasks; only the obsolete starter entry in `web/lib/execution-host/__tests__/fixtures/runtime-data-boundary-inventory.ts` is shared with S5.2.
  - Record the actual baseline/test discovery and confirm no competing qualification process. Reuse real PG/supervisor helpers read-only; request a focused owner handoff for that inventory entry if S5.2 owns it. Do not take over its fixtures. Confirm production HTTP403 behavior can be delivered by the scoped page boundary before broad UI work.
  - Logging: test evidence records revision, scenario, runner, timing and failures by exact test name; never credentials. Acceptance: all planned test paths match runner includes and no test relies on the developer supervisor/DB. Depends: T1.

Phase 0 exit: contracts complete, ownership exception documented, one achievable acceptance per gate. Contract/design work does not claim tests or behavior are implemented.

### Phase 1 — Make the recovery clock observable

- [x] **T4. Resolve the default driver and record tick/overlap telemetry.**
  - Files: `web/lib/scheduler/timer-config.ts`, `timer.ts`, `tick-service.ts`, new `clock-health.ts`, `web/instrumentation-node.ts`; new `web/lib/scheduler/__tests__/timer.test.ts` and `timer-config.test.ts`; extend `jobs.integration.test.ts`.
  - Implement D1, preserve shutdown and lease semantics, prove real competing `runSchedulerTick()` calls serialize the due job, and test heartbeat renewal plus stale-finisher refusal. Update runtime telemetry for failed/external/no-op ticks too; do not serialize all independent manual ticks through the fallback guard.
  - Default-on changes test startup too: explicitly set the normal Vitest/Playwright regression environment to `MAISTER_SCHEDULER_TIMER_ENABLED=false` in `web/vitest.workspace.ts` and `web/playwright.config.ts`; owning clock tests clear/override it deliberately. Real production clock smoke must test the truly unset case, not inherit that opt-out. Existing S5.2 helpers remain untouched; use their existing caller environment input where supported. A hidden test-only production branch is forbidden.
  - Add discoverable `web/lib/scheduler/__tests__/clock-boot.integration.test.ts`, using `buildProductionWeb()`/`startRealWeb()` from `web/test-support/real-web.ts`, real PG and the owned supervisor. First cover C1; extend the same suite for C3 in T5 and production card/external-tick behavior in T6. The helper spreads `process.env`: a serial test-owned child driver must delete inherited timer/cron settings before invoking it, then supply each case's env explicitly. Empty-string configuration is not evidence of the truly absent case. Normal Playwright provides a cron token and runs `next dev`, so it cannot substitute for this production test. Exercise out-of-order manual/cron settlements and coherent telemetry tuples in focused timer/tick coverage.
  - Logging: missing-driver boot WARN, one overlap WARN per streak, settlement INFO with final count/duration; all identify local process/driver. Acceptance: C1/C2 and two-ticker case green. Depends: T1–T3.

- [x] **T5. Remove the dead timer lifecycle and interval readers.**
  - Files: `web/lib/reconcile.ts`, `web/lib/runs/keepalive-sweeper.ts`, `web/lib/instance-config.ts`, `web/lib/runs/keepalive-config.ts`, `web/instrumentation-node.ts`, `web/lib/__tests__/instrumentation.test.ts`, `web/lib/__tests__/instance-config-reconcile.test.ts`, the coordinated inventory entry.
  - Delete dead starts/stops and readers only; preserve sweep functions. Remove the live keepalive log's obsolete interval. Replace obsolete instrumentation mocks/assertions with actual scheduler startup and retired-env warnings.
  - Logging: presence-only ignored-env WARN, including retirement identifier; invalid retired values do not throw. Acceptance: C3; repository search finds no executable starter/stopper/reader references, no test invents an old caller. Depends: T4.

- [x] **T6. Give the scheduler clock its own top card.**
  - Files: `web/app/(app)/admin/scheduler/page.tsx`, new `web/components/admin/scheduler-clock-card.tsx`, `scheduler-brain-index-queue.tsx`, `web/lib/queries/scheduler.ts`, `web/types/scheduler.ts`, `web/messages/en.json`, `ru.json`, `docs/screens/admin-scheduler.md`.
  - Move clock guidance above the job/Brain sections; reuse the job row projection for last/next activity, with the mandatory core-clock rows independent of the general list cap. Show configured versus observed behavior, process identity, null/never-observed and running/failure states. Brain card keeps queue only.
  - Migrate `web/components/admin/__tests__/scheduler-brain-index-queue.test.ts` clock assertions; keep its queue assertions. Add `web/e2e/admin-scheduler.spec.ts` and its `AUTHED_SPEC` entry in `web/playwright.config.ts`.
  - Logging: no per-render logs; existing authorized read/error reporting only. Acceptance: EN/RU card, C1/C2 display, timer-disabled external tick produces visible durable job activity. Depends: T4/T5.

Phase 1 exit: relevant tests execute and pass; full web unit and integration projects remain green. Every changed baseline expectation is classified as obsolete (intentional default/location/retirement change) or broken (regression), never silently removed.

### Phase 2 — Publish and measure event-plane progress

- [x] **T16. Add and qualify the ordered scheduler-observation index.**
  - Files: `web/lib/db/schema.ts`, generated main migration `0173_scheduler_observation_lookup.sql` and its journal/snapshot (number revalidated per D7), `docs/database-schema.md`, `docs/db/scheduler-domain.md`, generated ERD/DBML; new `web/lib/db/__tests__/migration-0173-scheduler-observation.integration.test.ts` with matching final number.
  - RED: start real PG at the predecessor migration using `startMainPostgresTestDbUpTo`, seed durable job/attempt rows and assert the required index contract; capture the missing-index failure. GREEN: generate/apply the additive migration through existing helpers/runner; assert exact keys/order, unchanged rows and normal migration rerun no-op. Exercise the specified ordered SQL on newest failed/reaped rows and equal claim timestamps; T9 owns proving the production reader uses those semantics.
  - REFACTOR: generation parity, journal integrity and migration checks; populated `EXPLAIN` verifies bounded index traversal, without requiring a particular planner choice for tiny fixtures. Record build/lock timing and rollback compatibility.
  - Logging: existing migration runner and qualification evidence only. Acceptance: M1; no backfill or new storage semantics; old reader/schema remain compatible. Depends: T1/T3.

- [x] **T7. Implement the opt-in cheap host health snapshot and skew-safe transport.**
  - Files: `supervisor/src/host-state.ts`, `http-api.ts`, `types.ts`; a narrow helper in `outbox-budget.ts` only if needed to reuse authoritative counters; `web/lib/supervisor-client.ts`, `web/types/platform-status.ts`, `web/lib/execution-host/contracts.ts`, `transports/local-direct.ts`.
  - Implement D3; no filesystem work or budget-policy changes. Extend `supervisor/src/__tests__/runtime-event-outbox.integration.test.ts` (real SQLite/Fastify health); extend `web/lib/__tests__/supervisor-client.test.ts` and `web/lib/execution-host/__tests__/registrar.integration.test.ts`.
  - Preserve an isolated fixture of the **baseline** strict web parser/default request and the baseline host response; using the newly tolerant parser for both sides does not prove old-web compatibility. Run the same schema cases against real response bodies.
  - Logging: normal health stays quiet; malformed known fields remain typed transport errors with safe response/status context. Acceptance: L4 both directions and opt-in path, unknown-key tolerance, empty/first/ACKed/purged head/age invariants, cheap SQL plan. Depends: T1–T3.

- [x] **T8. Implement pure lag arithmetic and the bounded Postgres collector.**
  - Files: new `web/lib/execution-host/events/lag.ts`, `lag-read-model.ts`, `web/types/execution-host-observability.ts`; new `events/__tests__/lag.test.ts`, `lag-read-model.integration.test.ts`; `web/lib/instance-config.ts` for the single lag-age env.
  - Implement D4 and the threshold inputs in D5. Reuse run status sets, indexed run horizons, separate poison pagination, current command counts and a shared safe rearm-command formatter. No status writes, no swallowed DB failure. Preserve nullable fields and bigint precision end-to-end.
  - Logging: collector timings/population at DEBUG and explicit incomplete/query errors at WARN; the pure arithmetic function logs nothing and mutates no inputs.
  - Author/run the raw-number L1a/L1b scenarios in new `events/__tests__/lag-observability.integration.test.ts` before implementing collection; use the existing real supervisor/PG helpers. Wire lifecycle assertions only in T9, after their own RED run.
  - Acceptance: Q1/O2 and real Postgres arithmetic including first sequence/null cursor, isolated projection backlog, poison on terminal run, exact top-20 ordering, query plans and budgets above. Depends: T7.

- [x] **T9. Integrate samples, sustained-lag transitions and sweep summary.**
  - Files: `web/lib/execution-host/events/stream-health.ts` (summary integration only), new `events/lag-observation.ts` and its small pure transition test, `web/lib/scheduler/system-sweeps.ts`, `tick-service.ts`, a narrow prior-summary loader in scheduler queries/jobs; extend `system-sweeps.test.ts`, `jobs.integration.test.ts`, `events/__tests__/lag-observability.integration.test.ts` and `stream-health.integration.test.ts`.
  - Carry versioned prior observation through existing attempt summaries and result fences. Add worker and command observations to the persisted/logged summary. Keep all stall/lost/recovery functions and ordering untouched. Make unknown/stale/partial samples explicit and read only `workers/health.ts`.
  - Add/run RED lifecycle assertions for L1a/L1b, O1/O3 before implementation; retain L1c/L2 as unchanged-authority baseline guards where already green. Observer failures beyond the job's failure-limit count must not disable the job; genuine existing bundle failures still follow their old policy. Test version/size limits and partially unavailable sources without resetting unrelated diagnostics to zero.
  - Logging: commit-gated WARN/recovered/reset transitions and the existing bounded system-sweep summary; no per-event logs. Acceptance: alternating tick owners preserve streak, stale owner cannot publish, timeout never writes lost, duplicate-only last-seen changes do not count as progress, lost/reset never logs recovered. Depends: T4/T8/T16.

Phase 2 exit: full supervisor unit/integration and web unit/integration projects green; contract validation green. No changed strict-envelope behavior outside health. No modifications to stall/lost decision functions.

### Phase 3 — Operator read surface

- [x] **T10. Build the admin read model and authorization boundary.**
  - Files: new `web/lib/execution-host/admin-status.ts`, `web/app/(app)/admin/execution-host/page.tsx`, localized forbidden boundary, `web/next.config.mjs` only for the qualified `authInterrupts` option; new `web/lib/execution-host/__tests__/admin-status.integration.test.ts` and `web/e2e/admin-execution-host.spec.ts`, its explicit `AUTHED_SPEC` inclusion and production HTTP403 case using existing real-web support.
  - Compose the D6 page data after the DB-authoritative global admin check. Read-only service functions are independently testable. No admin API/mutation route is needed. Use bounded URL poison pagination and explicit data-class gating. Display current DB metrics alongside timestamped last-sweep classification, without pretending they are one atomic host+Postgres snapshot.
  - Logging: existing auth refusal/debug conventions; typed collector failure at the server boundary, no render spam. Acceptance: admin positive access, member/viewer denial, live demotion, unknown older host, host-down manager evidence, literal member HTTP403 in production. Depends: T6/T9.

- [x] **T11. Render all diagnostics and wire safe chrome navigation.**
  - Files: new `web/components/admin/execution-host-status.tsx`, existing `web/components/chrome/platform-status.tsx`, `status-bar.tsx`, `left-rail.tsx`, `left-rail-sections.ts`, `left-rail-route.ts`, `web/app/(app)/layout.tsx` as needed to pass the authoritative role; `web/types/platform-status.ts`, `web/lib/execution-host/platform-status.ts`; EN/RU catalogs.
  - Render every D6 panel and the exact safe rearm command. Add the single summarized lag field within the selected cheap status policy; keep ready/launch behavior unchanged. Admin link is discoverable in rail and status pill; non-admin coarse status contains no privileged details. Reuse one request-cached health result across both surfaces.
  - Logging: none for ordinary presentation; render failures use existing boundaries. Acceptance: L3, nullable/partial states, mobile/collapsed rail, no heavy query from chrome and no extra health request per component. Depends: T10.

- [x] **T12. Qualify browser coverage and reconcile screen contracts.**
  - Files: new `web/e2e/admin-execution-host.spec.ts`, `admin-scheduler.spec.ts`, `web/playwright.config.ts` explicit `AUTHED_SPEC` alternatives; `docs/screens/admin/execution-host.md`, `docs/screens/README.md`, `docs/screens/admin-scheduler.md`, `docs/screens/chrome/left-rail.md`, `docs/screens/chrome/status-bar.md`, `docs/system-analytics/test-infrastructure.md`.
  - Follow the screen template (header/JTBD/roles/navigation/layout/states/data/i18n/links), index the new page and update the IA map. The requested new admin subdirectory does not justify moving existing screen docs or breaking their links.
  - Rerun the browser scenarios authored RED in T6/T10/T11: admin render, poison command values, actual member response status/no leaked data, links in both rail modes, and EN/RU copy. Verify Playwright lists both specs in the existing `authed` project; no unauthenticated accidental execution. Amend any newly discovered requirement/spec/test before fixing code.
  - Logging: evidence records first-attempt failures and server logs; no auth state/token dumps. Acceptance: new and owning admin/chrome E2E cases green, docs indexes/contracts green. Depends: T11.

Phase 3 exit: positive and negative browser access, first-class clock and full diagnostic page work; full web unit/integration projects remain green. No unauthorized DTO detail or client import of server-only modules.

### Phase 4 — Qualify the real behavior and close the contract

- [x] **T13. Run L1/L2 end-to-end on real supervisor and Postgres.**
  - Files: `web/lib/execution-host/events/__tests__/lag-observability.integration.test.ts`, already authored and driven RED → GREEN in T8/T9; reuse `web/test-support/real-supervisor.ts`, `pg-container.ts` and the existing mock ACP lifecycle adapter without taking ownership of S5.2 fixtures.
  - Execute the matrix below through real claim/ingest/projection/scheduler/read-model paths. Test-owned barriers control stream consumption and projection; no production test toggle. Capture accepted/acknowledged milestones before holds and drain after release. Check actual emitted frame boundaries with existing helpers.
  - Logging: capture sweep numbers, transition order, identity/sample times and DB evidence; evidence outside the worktree runtime roots. Acceptance: each L1/L2 variant passes against real storage, never merely mocked SQL or fake health. Depends: T9/T12.

- [x] **T14. Run falsification, performance and regression gates.**
  - Files: owning tests and the changed implementation only if a defect is found. Run the commands below on a quiet host, serializing lanes. Run any necessary baseline comparison at the verified revision in isolation.
  - Execute temporary mutation controls: zero/remove lag computation => L1 fails on first numeric assertion; remove overlap counter => C2 fails; remove tolerant web parser => unknown-field L4 fails. Also force unconditional stream emission on default `/health` => old-web L4 fails. Restore each mutation and rerun its owning case.
  - Classify full-lane failures by exact file/test name against baseline; no blanket acceptance of historical counts. An environmental inability to run a gate leaves qualification pending; no skip/quarantine added to make this item look green. Fix cycle includes adversarial review of health skew, arithmetic, authorization, stale observations and lease ownership.
  - Logging: runner/time/runtime/query-plan/failed-case evidence. Acceptance: selected performance budgets and all required owning cases green; no mutation remains. Depends: T13.

- [x] **T15. Complete as-built docs, deployment smoke and focused integration handoff.**
  - Files: T1/T2/T12 docs and the ADR-167 dated amendment; the plan's task markers only after evidence exists.
  - Change Designed to Implemented for delivered scope, record formulas/thresholds/coverage/limits, cross-link deployment and both admin pages. State that other ADR-167 D8 metrics remain under their own contracts. Smoke a single-box boot with unset/explicit settings and external cron, verify actual job timestamps, and exercise rollback configuration.
  - Recheck shared-file ownership with S5.2/P0-3 before local integration; retain the one inventory deletion only. No change to their semantics or qualification claims. No memory edit, push or broader completion claim.
  - Logging: deployment WARN/INFO evidence without secrets. Acceptance: contracts/docs gates green, rollback documented, all task-specific acceptance evidence exists. Depends: T14.

## Acceptance matrix

| ID | Test and evidence | Required behavior |
| --- | --- | --- |
| L1a | Real supervisor + PG; mock ACP emits while test consumer ingests a bounded subset per sweep, refreshing host telemetry. | Head minus received and host unACKed grow; raw admin and sweep values agree for identical inputs; progress is real; after N qualified observations one WARN; stream active and `commandStreamLost()` false; release/catch-up => zero and one recovered INFO. |
| L1b | Hold one real projection consumer while ingest/ACK continue. | Per-run backlog grows, host backlog may stay zero; exact top-N/admin/sweep show projection lag; no lost write; release projects the same retained events and clears backlog. |
| L1c | Hold stream claim entirely. | Host backlog grows, manager progress does not; raw backlog visible but no fabricated advancing-lag classification. This is not a substitute for L1a. |
| L2 | Continue a real ingest hold beyond stall threshold with an accepted command; call the existing passes. | Repair-first marker, then existing lost decision only if repair fails; lag observer performs no degradation. Summary shows backlog and stalled/degraded signals independently; recovered active stream alongside historical lost keeps `commandStreamLost()` false. |
| L3 | Real PG poisoned row; browser admin page, including terminal poisoned run. | Consumer/run/event/cursor/error-generation exactly match the CLI contract; shell quoting is valid; missing generation yields explanation rather than invalid command. |
| L4 | Four health combinations: old/old, new/new opt-in, new-web/old-host query ignored, old-web/new-host plain health. | Registration succeeds with appropriate identity/capabilities; absent stream is unknown. Separate future unknown keys parse; malformed known fields still fail. Use actual baseline parser/response fixtures. |
| C1 | Production startup plus resolver table tests. | Unset/no token starts fallback; explicit false/no token warns naming both vars; token-only resolves external, never claims observed tick; card matches runtime. |
| C2 | Held tick spanning several interval firings, then success and failure variants. | Total/skipped streak increment; one WARN per streak; INFO has final streak/duration; process-local card agrees; stop drains; next streak can WARN again. |
| C3 | Both retired env names present, even invalid, at boot. | WARN ignored, boot succeeds; no old start/stop implementation/interval reader remains; only canonical sweep executes. |
| C4 | Two real scheduler tick callers and long-running renewable attempt against one PG. | Exactly one attempt/dispatch for the same due job; stale result cannot commit; overlap counters describe only their own timer process. |
| O1 | Alternating scheduler owners/restart/lease-expired result. | Consecutive samples survive owner change through summary; invalid/missing observations reset qualification; stale owner cannot commit or emit an authoritative transition. |
| O2 | Duplicate-only ingest, large bigint, sequence zero/null, cached-old host head, stream/boot change. | No timestamp-based fake progress, off-by-one, precision loss, negative/false-zero lag or false recovered log. |
| O3 | Real scheduler attempts with observation failures for more than the configured max-failure count; separate genuine bundle failure control. | Host/SQL timeout yields explicit partial/unavailable within 2 s, retains available independent signals and leaves recovery job enabled; genuine bundle failure still increments its original counter. Malformed/old/future JSON is unavailable; new summary <=64 KiB preserves transition state/totals. |
| H1 | Real SQLite/Fastify contract tests, parameterized query/response edge cases. | Omitted/false health remains legacy; true is additive; invalid/duplicate query is typed 409; storage failure typed 503. Logical lazy ACK age, empty/purged head, pressure and counters agree with storage; all-present optional block validates safe counts, bigint strings, identities and null/age relations. No filesystem calls. |
| Q1 | Real PG collector with active/terminal/unassigned/reassigned runs and accepted/unprojectable events; poison pagination. | Exact indexed horizon and deterministic top20 across complete eligible population; accepted-only arithmetic; current assignment attribution without historical duplication; terminal poison retained; empty/never-served/service-age/retry values explicit; malformed pagination refused before query. |
| E1 | Authenticated EN/RU Playwright admin and member/viewer contexts; direct and client navigation. | Admin sees panels/links; member HTTP403 and no sensitive payload; coarse non-admin pill remains safe; specs run in the intended project. |
| E2 | Existing platform-status integration/presentation tests with host backlog, projection-only backlog and unknown/failed health. | One health-only coarse field; behind decorates ready without blocking launch; projection-only lag is not falsely advertised as global clear. No heavy DB query or second fetch for rail/footer; privileged link admin-only, payload has no host/run/command/error details. |
| M1 | Real PG predecessor→new migration, full migration rerun and populated ordered lookup. | Only the intended index is added; rows/summaries and older readers remain valid; journal/snapshot/schema consistent; rerun no-op; new failed/reaped/tied attempts selected in deterministic order, never skipped for an old success. |
| P1 | Populated real PG and SQLite query plans, serial timing samples. | Indexed horizons/ACK boundary lookup, exact top-N within stated population, budgets met, no heavy chrome query or filesystem work. |
| DOC1 | Contract/docs/index/ERD gates plus isolated single-box/external-clock deployment smoke. | Every R1–R11 points to current normative spec, enforcement and passing acceptance evidence; deployment env/routes match runtime; delivered ADR amendment does not claim the rest of D8; rollback preserves recovery and existing data. |

For cross-process comparisons, hold the test barriers and compare a shared sample ID/input snapshot: two independent live reads can legitimately differ. No arbitrary sleeps as proof of protocol progress. The elapsed-time aging fixture must exercise real stored observations; pure clock injection alone is not the end-to-end evidence. Cover threshold boundaries 100/101, age below/exactly120 s and streak2/3 in the pure reducer once; the real integration uses at least one complete qualifying/recovery sequence, not a duplicate Cartesian matrix. A bounded wait for the actual age contract is permitted with event/barrier synchronization and timeout diagnostics. Empty/malformed pagination and invalid known health fields are refusal cases; anonymous access follows the existing login boundary, while authenticated insufficient role is the explicit 403 requirement.

## Existing assertions to migrate or preserve

- `web/lib/scheduler/__tests__/system-sweeps.test.ts`: add explicit observer seam/results/errors and worker summary fields; do not import worker runtime or accidentally start real host activity from mocks.
- `web/lib/scheduler/__tests__/jobs.integration.test.ts`: preserve overlapping claims, lease renewal, successful and failed summary persistence; extend with complete competing tick path and observation commit fence.
- `web/lib/__tests__/instrumentation.test.ts`: dead-starter mocks/assertions are obsolete; replace with actual clock startup/drain and warning assertions.
- `web/lib/__tests__/instance-config-reconcile.test.ts`: only the removed interval-reader expectations are obsolete; preserve live reconciliation tuning tests.
- `web/components/admin/__tests__/scheduler-brain-index-queue.test.ts`: clock-inside-Brain markup is obsolete; queue assertions stay.
- `web/lib/__tests__/supervisor-client.test.ts`: strict unknown-key refusal for health is obsolete; malformed known data/timeout/HTTP failures remain required.
- `web/lib/execution-host/__tests__/registrar.integration.test.ts`: current identity/protocol/readiness refusal tests stay; optional stream does not become a registration prerequisite.
- `web/lib/execution-host/events/__tests__/stream-health.integration.test.ts`, `web/lib/execution-host/__tests__/command-impasse.integration.test.ts`: existing stall/lost/impasse assertions stay unchanged; failures are regressions, not new lag semantics.
- `web/lib/execution-host/events/__tests__/projection-worker.integration.test.ts`: preserve error-generation/cursor/event CAS rearm behavior; page command must match it.

## Validation commands

Run each command separately. Discovery is mandatory because package scripts use `--passWithNoTests`.

```bash
pnpm --filter maister-web exec vitest list --project unit lib/scheduler components/admin
pnpm --filter maister-web exec vitest list --project integration lib/scheduler lib/execution-host
pnpm --filter maister-web exec vitest list --project integration lib/db/__tests__/migration-0173-scheduler-observation.integration.test.ts
pnpm --filter @maister/supervisor exec vitest list --project integration src/__tests__/runtime-event-outbox.integration.test.ts
pnpm --filter maister-web exec playwright test --list admin-execution-host.spec.ts admin-scheduler.spec.ts
pnpm --filter maister-web exec vitest run --project unit lib/scheduler components/admin lib/__tests__/instrumentation.test.ts lib/__tests__/instance-config-reconcile.test.ts lib/__tests__/supervisor-client.test.ts
pnpm --filter maister-web exec vitest run --project integration lib/scheduler lib/execution-host/events lib/execution-host/__tests__/registrar.integration.test.ts lib/execution-host/__tests__/command-impasse.integration.test.ts lib/execution-host/__tests__/admin-status.integration.test.ts
pnpm --filter maister-web exec vitest run --project unit lib/execution-host/events
pnpm --filter maister-web exec vitest run --project integration lib/db/__tests__/migration-0173-scheduler-observation.integration.test.ts
pnpm --filter @maister/supervisor exec vitest run --project integration src/__tests__/runtime-event-outbox.integration.test.ts
pnpm --filter maister-web test:e2e admin-execution-host.spec.ts admin-scheduler.spec.ts admin-users.spec.ts execution-host-contract.spec.ts --workers=1
pnpm --filter maister-web test:unit
pnpm --filter maister-web test:integration
pnpm --filter @maister/supervisor test:unit
pnpm --filter @maister/supervisor test:integration
pnpm --filter maister-web typecheck
pnpm --filter @maister/supervisor typecheck
pnpm --filter maister-web exec eslint .
pnpm --filter @maister/supervisor exec eslint src
pnpm --filter maister-web db:check
pnpm --filter maister-web db:erd --check
pnpm validate:contracts
pnpm validate:docs:all
git --no-pager diff --check
```

Use the final assigned migration number in commands. Run `db:check` only with the owned isolated database configuration; migration tests own predecessor/application/rerun evidence. Use `pnpm --filter maister-web db:generate` after schema changes and again after generated artifacts settle to prove no unrepresented diff; review any generated output before retaining it. Use `pnpm --filter maister-web db:erd` to regenerate, then `--check`. Never point migration tools at the developer stand during qualification.

Use the production web test helper for the clock/skew/403 production smoke with owned ephemeral ports and roots; never kill another task's test process or reuse the live stand. Run the full default E2E lane once at final qualification if chrome/default startup changes affect more than the selected specs; compare exact failures to baseline. No S5.2 isolation lane is required or run concurrently for this item.

## Commit Plan

- Checkpoint 1, T1–T3: `docs: specify scheduler clock and event lag observability`
- Checkpoint 2, T4–T6: `feat: expose the scheduler clock and retire legacy timers`
- Checkpoint 3, T16 then T7–T9: `feat: measure execution event ingest and projection lag`
- Checkpoint 4, T10–T12: `feat: add execution host operator diagnostics`
- Checkpoint 5, T13–T15: `test: qualify clock and event lag observability`

These are future focused commits after their gates; planning creates no commit. Do not split a behavior from the contract/test changes needed to keep its checkpoint honest. Implementation stays local unless separately authorized.

## Rollout and rollback

1. Apply the additive index migration in the bounded maintenance window described in D7; confirm completion before the new reader. Deploy the backwards-compatible host health contract and new web in either order: the negotiated response preserves old-web registration, while new web reports unknown stream telemetry for an old host.
2. Explicitly select the deployment clock, verify startup logs and advancing durable job timestamps, then inspect the admin page during a representative dogfood run. Missing metrics are not a launch/readiness refusal.
3. To restore prior opt-in timer behavior, set `MAISTER_SCHEDULER_TIMER_ENABLED=false` and provision/verify external cron when periodic recovery is required. Do not disable both accidentally. Binary rollback retains the additive index; no destructive down migration or data rewrite is needed.
4. Reverting observability leaves canonical event/command/consumer state untouched. Old summaries without the observation schema are supported as unavailable baselines. New summaries are ordinary existing attempt JSON and require no cleanup migration.

## Completion criteria

All 16 tasks, R1–R11 and named acceptance cases are evidenced through their SDD and RED → GREEN → REFACTOR records; contracts/docs and migration artifacts agree; query budgets and mixed-version behavior are measured; the standalone clock card and admin page explain the two incident facts without SQL/log reconstruction. Every required new and existing owning test passes, every changed expectation is justified, and final code review checks the project's SOLID/KISS/DRY, strict typing and error conventions. Any failed/unrun gate remains explicitly pending. No claim of changes to stall/lost semantics, cluster-wide local timers/worker health, full D8 metrics coverage, or S5.2 completion is made.

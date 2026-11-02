# Implementation Plan: GitHub intake and task lifecycle reconciliation

Branch: `codex/github-task-reconciliation`
Created: 2026-10-31
Status: Designed; implementation has not started.
Platform baseline: `master` at `7cf28cc96`.
Companion baseline: `/Users/kaa/Work/dev/github/maister-plugins`, `main` at
`9b8f09a`, local annotated tag `core/v1.4.0`.

## Settings

- Testing: yes; SDD first, then RED → GREEN → refactor for each behavior phase.
- Logging: standard structured INFO for changes, WARN for retry/refusal, ERROR
  for exhausted failures; no issue bodies, credentials or raw private responses.
- Docs: yes; contracts and analytics precede implementation, then become
  Implemented only after their acceptance checks execute successfully.
- Roadmap linkage: none, using the user's previously selected defaults.
- Ownership: platform owns durable identity, reconciliation, authorization,
  admission, state and presentation; core owns the two provider transports and
  intake instructions. No GitHub issue/PR mutations except existing receipt
  comments; no credential management changes, deployment or remote publication.
- Existing `core/v1.4.0` and existing migrations remain immutable. No pushes.

## Confirmed requirements

1. New issues already being handled by a linked active PR must not create local
   implementation tasks. Draft PRs count as active work too.
2. An imported task with an active external PR must show external review, with
   the PR link and draft indication, and must not start another delivery attempt.
3. A GitHub issue closed as completed must finish its bound platform task as
   Done using external evidence, without requiring a local delivery run.
4. Duplicate and not-planned closure must close the task with the corresponding
   reason, distinct from successful completion. Duplicate identity is retained.
5. **Human decision confirmed on 2026-10-31:** retain an existing active local
   run, prevent new work for that task, and show one durable actionable conflict
   in Inbox. Never automatically cancel, discard or promote that run.
6. Source reopening, PR unlinking and PR closure without merge must be reversible
   safely; they must not resurrect an old run or bypass task qualification.
7. Repeated minute-by-minute scans must not create duplicate tasks, receipts,
   attention entries or new workspaces. Zero-change scans remain successful
   operational runs with the existing history/cleanup behavior.
8. Both gh and MCP variants use the same reconciliation contract and state
   reducer. Unsupported or incomplete provider evidence is explicit failure or
   partial coverage, never evidence that there is no PR or that work is Done.

## Verified baseline and affected seams

References are relative to the platform repository unless marked core. Line
numbers describe the baseline above and must be refreshed during implementation.

| Verified behavior                                                                                  | Reference                                                                                         | Consequence                                                        |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Tasks have Backlog/InFlight/Done/Abandoned, no native review status or structured provider binding | `web/lib/db/schema.ts:1556`, `:1586`, `:1596`                                                     | Add source lifecycle evidence rather than a run status             |
| `task_create` accepts a strict task payload without source identity                                | `web/app/api/v1/ext/projects/[slug]/tasks/route.ts:37`                                            | Prompt provenance cannot be the authoritative foreign key          |
| `task_complete` is human-only and requires newest Flow delivery evidence                           | `web/lib/services/task-completion.ts:42`, `:107`; `docs/api/external/operations.openapi.yaml:392` | Keep this contract; add a separate source reconciliation operation |
| Generic abandon requires that a task has never had a run                                           | `web/lib/services/tasks.ts:616`                                                                   | Do not reuse it for previously executed imports                    |
| OnReview and delivery currently derive from run state, with run precedence over task state         | `web/lib/board.ts:86`, `:104`, `:118`                                                             | Define source-aware task projection without rewriting runs         |
| Every task without a run is represented as a Backlog card                                          | `web/lib/queries/board.ts:740`                                                                    | Add an explicit source task card, not just a column predicate      |
| Incoming tasks are excluded from board; qualification predicates own that partition                | `web/lib/queries/board.ts:391`; `web/lib/tasks/qualification-predicates.ts:15`                    | Reconcile Incoming/board/history membership together               |
| Flow launch prepares and rechecks admission under the task lock                                    | `web/lib/services/runs.ts:631`, `:1675`, `:1930`                                                  | Extend this shared boundary and its concurrent claim               |
| Already admitted continuations differ from first dispatch                                          | `web/lib/tasks/qualification-admission.ts:180`, `:230`                                            | Preserve HITL/checkpoint/recovery of admitted runs                 |
| `queuePaused` suppresses idle resume, but not every initial/manual path                            | `web/lib/scheduler.ts:875`, `:891`, `:918`; `web/lib/runs/launchability.ts:131`                   | Add a separately owned external admission hold                     |
| `requires` releases only on Done; duplicate relation is non-gating                                 | `web/lib/social/relations.ts:32`, `:421`, `:483`                                                  | Duplicate/not-planned must not masquerade as success               |
| Ordinary Inbox fanout has no dedup key; successful scans can auto-resolve agent incidents          | `web/lib/social/inbox.ts:19`; `web/lib/runs/agent-incidents.ts:123`, `:225`                       | Source conflicts need their own durable resolution semantics       |
| Frozen qualifier grants and transaction-local digest replay already exist                          | `web/lib/tasks/qualification.ts:307`, `:353`, `:390`                                              | Reuse these patterns, not librarian-only idempotence middleware    |
| Existing PR scanning targets local workspace PRs                                                   | `web/lib/scheduler/handlers/pr-state-scan.ts:1`                                                   | Do not expand it into an independent second issue-sync owner       |
| Core scans closed issues only for receipt recovery and binds sources through prompt text           | core `packages/core/capability/skills/github-issue-intake/SKILL.md:53`, `:67`, `:104`, `:168`     | Add lifecycle reconciliation and conservative legacy adoption      |
| Existing core test scenarios call task creation directly, without executing provider instructions  | `web/lib/packages/__tests__/operational-core.integration.test.ts:223`                             | Keep fixture proof separate from transport/runtime proof           |

## Design decisions

### D1. Keep task outcome, execution and external progress separate

No new `runs.status` or `tasks.status` value. Add a structured external
disposition on a source record, with a shared task projection and admission
predicate. The board's OnReview column can display an **external review task**
without a Review run. Closed duplicate/not-planned tasks appear in the closed
task presentation with their reason, not as retryable Backlog work.

An external transition never writes run status, promotion state, merge SHA,
workspace retention or publication evidence. Existing run details, diffs,
promotion and human completion retain their contracts. External Done records
external completion evidence and releases success dependencies through ordinary
`tasks.status = Done`; duplicate/not-planned uses Abandoned and does not satisfy
`requires`.

### D2. One durable source, observations, and conflict episode

Introduce these entities in the main Postgres lineage (names to become the
Phase-0 schema contract):

- `task_external_sources`: server ID; project; provider `github`; normalized
  host; immutable repository node ID and issue node ID; current display
  owner/repository/number/URL; nullable unique task ID; lifecycle revision;
  latest accepted observation; sync-owned admission hold and reason; applied
  external terminal disposition and terminal-origin ownership; next scan/last
  attempt cursor fields; original import/task identity and tombstone. A source
  can exist without a task when import was skipped for a PR. Deleted tasks never
  make an imported source eligible for automatic reimport; explicit human
  reimport is required. Restrictive FKs/tombstones preserve referenced evidence.
- `task_external_observations`: server-issued generation/lease and claimant run
  form a mutable claim portion with enumerated claim/renew/settle transitions;
  normalized facts/digest, provider metadata, failure and final result become
  write-once on settlement. Store bounded sanitized facts, not arbitrary dumps.
  A settled observation cannot be renewed or overwritten.
- `task_external_receipt_intents`: durable comment effect identity and immutable
  marker/content digest, source/import linkage, confirmed/unknown state,
  append-only settlement receipts and an independently fenced repair claim.
  Unique source + import + comment phase prevents fresh intents for one effect.
- `task_external_conflicts`: one open episode per project/source/task, with
  current cause and evidence fingerprint,
  relevant observation revision, all protected run IDs, acknowledgement/read
  version, explicit resolution and actor. Existing decisions/Inbox projects
  this entity; do not append a comment or HITL request on every scan.

Use unique `(project_id, provider, host, issue_node_id)` source identity,
same-project FK ownership, and at most one source binding per task in v1.
Repository identity is validated against the attachment's allowed repository.
Numbers/URLs/titles are display locators, never an identity fallback for a
privileged mutation. Numeric provider IDs may be retained as corroboration;
missing immutable identity is unsupported evidence. Repository renames do not
create duplicates; transfer outside the allowed source holds for explicit
rebinding. No cross-project canonical duplicate details leak through references.

The source hold is independent from `tasks.queuePaused`. Clearing a source hold
never clears a user pause. All task creation/edit/qualification/terminal paths
must preserve source ownership and its hold unless they are the source reducer
or an explicit authorized human decision.

### D3. Observation and mutation boundary

Add optional agent definition capability
`external_task_sync: {contract: github_v1}`. It is valid for operational agents
only, and freezes the allowed source, project, transport and contract at launch
in `runs.external_task_sync_snapshot`, including stable attachment identity,
definition/contract revision, host/repository node identity and configuration
digest. Live disabling/revocation narrows authority; later config edits cannot
broaden an old snapshot. Operational kind or intake qualification alone grants
nothing. Registry, package ingestion, Studio, attachment validation,
serialization and retries must agree on the capability; absent means no grant.

The bound run and project come from verified credentials/server state. Agent
calls require this frozen capability and valid live credentials. Writes permit
an owned live session in Running or NeedsInput, allowing unrelated concurrent
permission requests; idle/checkpointed, waiting-on-children, human takeover,
review and terminal sessions cannot originate new observations or mutations.
Previously committed identical receipt reads remain authorized reads. Apply
must recheck credentials, ownership, lease and generation in its transaction.
Permission HITL/auto-approval policy remains unchanged.

Provider reads occur through the selected gh or MCP connection, outside DB
locks. The platform validates a **capability-authorized observation**, not a
cryptographic GitHub attestation: credentials authorize this narrow mutation
scope; strict structured facts and recorded tool/provider references make it
auditable. Free prose, issue labels and arbitrary comment text cannot assert
completion or PR linkage. Neither source content nor a user-supplied URL can
broaden the project/repository grant or instruct an arbitrary network fetch.

Claim before reading: one renewable source lease, fenced monotonically by the
server. An expired/replaced claimant cannot apply late facts. A retry uses the
same canonical payload digest and returns the stored receipt; same operation
key with a different payload is CONFLICT. Provider timestamps supplement this
ordering; do not assume issue `updatedAt` changes for every PR update or use an
agent clock as the ordering authority. Changing task revision or source binding
during a read causes a refresh/refusal, not an overwrite.

The local commit includes observation, reducer result, task/source changes,
conflict state, activity, audit and domain-event outbox atomically. For bound
updates lock the owning intake run/credential fence, then the task, then source
and conflict rows; recheck the unlocked source-to-task lookup after locking.
Never lock protected delivery runs while holding their task, which would invert
their run-to-task order. Admission reads the hold under its existing task lock;
every bound hold writer takes that same lock. New task creation additionally
takes the existing project `FOR NO KEY UPDATE` allocation lock before source and
create writes; no bound-source path may later take that project lock. Watch-only
claims need only source serialization. Phase 0 audits the complete order against
qualification, first dispatch, adoption and terminal writers, and exercises
deadlock/race probes. No provider request, Git operation or process cancellation
is performed while holding DB locks. Source claim and run creation must have a
two-racer test over the actual invariant: either an attempt is admitted first
and then protected, or the hold wins and admission is refused.

### D4. Authoritative state table

Apply rows only to a bound imported task or a new candidate. Unknown facts never
clear a previously known hold/terminal disposition. Read failures do not mean
the source was closed, deleted or unlinked.

Terminal ownership takes precedence over every row: automatically change or
reverse a terminal outcome only when the source reconciler owns it. Matching
local Done/source-completed is a no-op with evidence; source duplicate versus
local delivery Done, or source completed versus human Abandoned, is a conflict.
Never overwrite local statement edits. Source title/body digest changes are
separate from PR/comment updates; record divergence and hold unstarted work for
statement reconciliation/requalification. Automatic statement rewriting is out
of scope.

| Observed GitHub facts                                                           | No task yet                                                | Bound task with no protected local work                                                                                  | Protected local work                                                                       |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Open, no linked active/merged PR, complete evidence                             | Create Incoming once, without `flowId`; qualify normally   | Keep normal lifecycle; clear only source-owned review hold; requalify if returning from external progress                | Continue run; no source conflict if there is no divergence                                 |
| Open, one or more explicitly linked open PRs, including draft                   | Watch/skip; no task and no permanent imported receipt      | External OnReview with links/draft badge; block new delivery                                                             | Preserve local projection/run; hold new work; one Inbox conflict                           |
| Open, linked merged PR but issue still open                                     | Watch/skip for reconciliation; never infer full completion | External review/verification hold with merged evidence, not Done                                                         | Preserve run; one conflict; no implicit merge or cancellation                              |
| Open, last PR closed unmerged or explicitly unlinked; no other active/merged PR | Reconsider normal import after a fresh complete read       | Remove only external progress hold, invalidate stale assessment, return to Incoming before launch                        | Do not rewind an active run; reconcile/resolve only the cleared divergence                 |
| Closed, explicit completed reason                                               | Do not import                                              | Task Done with external evidence                                                                                         | Preserve task/run state, store desired external Done, hold new work and raise one conflict |
| Closed, duplicate with canonical issue identity                                 | Do not import                                              | Task Abandoned, reason duplicate; retain canonical reference and add `duplicate_of` only if a same-project target exists | Preserve task/run state; desired duplicate disposition and conflict                        |
| Closed, explicit not_planned                                                    | Do not import                                              | Task Abandoned, reason not_planned                                                                                       | Preserve task/run state; desired closure and conflict                                      |
| Closed, unknown reason or missing required canonical duplicate evidence         | Do not import; diagnostic                                  | Hold and actionable attention; never guess Done                                                                          | Preserve run; keep conflict and diagnostic                                                 |
| Reopened after sync-owned closure                                               | New eligibility still requires complete facts              | Backlog/Incoming, clear only sync-owned closure, invalidate qualification and require fresh assessment                   | Preserve run; resolve through the conflict policy                                          |
| Source is inaccessible, partial, truncated, contradictory or missing identity   | No import; failed/blocked observation                      | Retain last accepted state; hold new admission when a required safety read fails                                         | Preserve run; diagnostic, no automatic destructive change                                  |

Protected local work includes **all relevant runs**, not only the latest:
Running, NeedsInput, NeedsInputIdle, HumanWorking, WaitingOnChildren and admitted
Pending; also unresolved Review/Crashed delivery work or retained unpromoted
source changes. A Pending run that has not passed first dispatch is retained but
parked by the source hold. An already admitted checkpoint/HITL/crash continuation
may resume under its existing permissions. No deleted workspace is recreated by
source sync. Successful local delivery remains Done if GitHub remains open or
reopens; show divergence requiring a human decision instead of undoing delivery.

Recognize a task's own PR by immutable provider PR/repository identity in its
workspace/delivery ledger, never branch name or URL text alone. When all linked
work matches its own delivery, the existing PR observation/promotion path stays
the owner; do not manufacture an external conflict or bypass local delivery
proof. Different or mixed PR ownership, or contradictory closure reason, uses
the conflict policy above.

Conflicts do not auto-resolve because an intake run succeeds, because a human
marks Inbox read, or because a local run becomes terminal. Re-read GitHub and
re-evaluate protected work before applying a queued disposition. Human actions
are acknowledgement, inspect run/source, refresh evidence, and apply the external
disposition once safe. Changing an externally completed task whose success has
already admitted `requires` dependents raises a conflict; reopening must not
retroactively invalidate admitted dependent work. Preserve their evidence.
While success is disputed, the shared `requires` predicate blocks **new**
dependent admissions even if the preserved prerequisite status is Done; existing
dependent continuations remain admitted. Emit `task.source_reconciled` through
the transactional domain-event outbox for effective status/hold/conflict changes.
Dependency/auto-admission consumers re-evaluate only already-armed work under its
normal project/tree/launch policy; never synthesize `run.done` or implicitly arm
tasks. Replay must be idempotent.

### D5. Provider completeness and parity

Use explicit Development/closing PR linkage, not any textual reference to an
issue. Fully read the relevant connection including closed PRs and current
state, merge state and draft flag. Multiple PRs are reduced together. A merged
PR alone never proves the entire issue completed; explicit issue closure does.

The [GitHub Issue GraphQL reference](https://docs.github.com/en/graphql/reference/issues)
documents `closedByPullRequestsReferences`, pagination, `includeClosedPrs`,
manually linked PR inclusion, `stateReason` and `duplicateOf`. The gh variant
uses a typed read-only query and complete pagination via
[`gh api graphql`](https://cli.github.com/manual/gh_api). Provider GraphQL
errors, including partial-data errors, are not an empty successful response.

The current official GitHub MCP
[issue reader](https://raw.githubusercontent.com/github/github-mcp-server/main/pkg/github/issues.go)
enriches best-effort, limits the PR summary to five entries and can omit it;
its [compact types](https://raw.githubusercontent.com/github/github-mcp-server/main/pkg/github/minimal_types.go)
also require qualification for immutable identity and duplicate target fields.
Missing enrichment, filtering and truncation mean unknown, not zero. The MCP
variant must preflight the **response capability**, not just tool names. Phase 3
must pin/qualify a binding exposing the complete observation contract, or refuse
the affected operation with precise remediation. No gh fallback. Do not declare
full MCP lifecycle parity verified until the actual supported binding passes.
Immutable identity and complete PR evidence are required before import/admission
changes; closure reason is required for closed-source disposition; canonical
target is required specifically for duplicate closure, not ordinary open issues.

Separate initial-import cutoff/budget from recurring reconciliation. Closed,
reopened and moved-out-of-filter issues already bound to tasks remain scan
candidates. Watched PR-skipped sources must be revisited. Use durable rotating
keysets and per-attempt markers so poison sources and the first capped page
cannot starve later rows. Default per-source retries: three transient attempts
with bounded backoff within the run budget; honor rate-limit retry metadata.
Authentication/unsupported-contract failures stop that source without repeated
writes; reconcile an unknown write before repeating it.
Keep `batch_size` for new-import attempts (default 20, range 1–100) and add
`reconciliation_batch_size` (default 50, range 1–100). Bound and watched sources
share a rotating due-source cursor; unchanged reads and failures consume that
budget and advance the attempt cursor. Discovery and reconciliation reserve
independent capacity. Required remaining pages/due work after a cap mean
incomplete coverage, with remainingKnown exact only when known; observation
receipts count confirmed progress, so a capped scan can produce a valid partial
result without creating a task. Budget exhaustion never proves complete scope.

### D6. Reuse operational completion and receipt mechanisms

Keep `operational_v1` unchanged. No new result fields or run statuses. Count
distinct inspected issues; attempted issues require durable final receipts for
all local reconciliation effects and any required creation comments. In the new
package, a confirmed reconciliation receipt is an `operation_receipt`, even if
no task was created. Preserve `attempted = completed + failed`; `created` counts
only newly created local tasks. A create followed by a missing required GitHub
receipt remains partial/unresolved. A confirmed conflict recorded for human
resolution is a completed reconciliation action, not an unresolved write; its
task-specific attention remains open independently of scan outcome. Read/contract
failure is blocked/partial/failed using the existing result rules.

PR references use existing `other` references; task/source/receipt references
link to detailed history. Rich created/reviewed/closed/conflict summaries derive
from durable receipts in source/agent history, not extra v1 counters. Old launched
runs keep their old package instructions and count interpretation; snapshots and
pinned materialization must not read the new skill at resume/finalization.

The new source-managed protocol atomically commits source + eligible task + local
receipt + pending GitHub-comment intent, then posts/read-backs pending and
completion comments with that intent's stable marker. This intentionally replaces
the old pending-comment-before-create order: source uniqueness now guards local
creation. Persist confirmed/unknown/repaired comment states through
content-guarded receipt operations. Lost local response replays the same task;
unknown GitHub response requires marker read-back before any repeat. Legacy
pending comments remain recoverable evidence; an ambiguous orphan stays an
operator hold, never permission to create after lease expiry. Comments are not
locks; never claim transactionally exactly-once GitHub comments.

Post-commit comment work uses the intent's own repair claim, not the already
settled observation lease. A later live compatible same-source run may claim and
repair the intent after the original run ends, without changing that run's
observation or creating another task. Its current credential/source grant and
repair generation are rechecked on settlement. Unknown in-flight GitHub writes
are not made safe by lease expiry: read back the marker, and never automatically
repost while an older request might still finish. If its outcome cannot be
established, retain unknown and require operator reconciliation.

Close generic creation bypass: a sync-granted intake run cannot call ordinary
`task_create`; it must reconcile. Before source-managed mode activates, drain
or explicitly revoke incompatible same-source intake mutation credentials and
refuse incompatible attachments. Derive intake role/source from frozen snapshots
and attachment configuration, never agent IDs or prompt parsing. Preserve old
snapshots/history; require a fresh compatible run for further source mutations.
Normal unrelated agent creation stays unchanged. Serialize activation with
credential issuance and generic creation so an in-flight legacy caller cannot
slip through. Lease expiry must not erase legacy orphan receipt holds.

## API and contract inventory

Proposed names are fixed by Phase 0 before tests; later changes update this plan,
OpenAPI, MCP schemas and callers together.

Receipt repair additionally exposes
`POST /api/v1/ext/projects/{slug}/task-sources/github/receipts/{receiptId}/claim`
as `task_source_receipt_claim`, returning its own generation/lease and supporting
bounded same-owner renewal. A live compatible same-source run can claim an
unsettled intent after its prior owner ends/expires; observation settlement does
not block repair. Receipt settlement below validates this repair claim, not an
observation lease. Its resource IDs are URL parameters resolved through the
authorized source; no client actor/run/project identity is accepted.

| Surface                                                                                            | Required contract                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/ext/projects/{slug}/task-sources/github` / `task_source_list`                         | Authorized rotating keyset page of watched/bound sources, current projection, revision and due markers; no secret/provider body; same-project read grants                                                                                                                                                                                                                                         |
| `POST .../task-sources/github/observations` / `task_source_observe_begin`                          | Strict immutable issue identity, operation key and expected source revision; return server source/observation ID, generation, bounded renewable lease and expected task revision; no task creation yet                                                                                                                                                                                            |
| `POST .../observations/{observationId}/renew` / `task_source_observe_renew`                        | Same owner/generation only, bounded total lifetime; expired/stale returns CONFLICT; crash-safe replacement                                                                                                                                                                                                                                                                                        |
| `POST .../observations/{observationId}/reconcile` / `task_source_reconcile`                        | Strict success/failure union: normalized facts/completeness/references and optional new-task statement, or failed/interrupted read with sanitized diagnostic/coverage. Failure settles the claim/cursor and may set a safety hold, never replaces accepted facts or invents closure. No desired status or client actor/run/project IDs; return immutable receipt/task revision/conflict reference |
| `POST .../observations/{observationId}/receipts/{receiptId}/settle` / `task_source_receipt_settle` | Confirmed/unknown/repaired comment effect against server-issued intent and exact marker/content digest; unknown cannot become confirmed without read-back evidence; idempotent immutable receipt                                                                                                                                                                                                  |
| `GET .../observations/{observationId}` / receipt read                                              | Authorized recovery after a lost response; a read cannot reapply effects                                                                                                                                                                                                                                                                                                                          |
| Human task-source adoption                                                                         | Preview exact legacy identity/receipt matches; apply only explicit same-project verified task/source mapping with expected task revision; ambiguous/multiple matches refuse, never match by title alone                                                                                                                                                                                           |
| Human source-conflict resolution                                                                   | Versioned acknowledgement/refresh/apply-external action; session or owner personal credential, no generic agent resolution; protected work refuses application with actionable reason                                                                                                                                                                                                             |
| Task/board/Incoming/Inbox DTOs and agent history                                                   | Source summary, external review/closure reason, canonical refs, hold and conflict, optional for legacy tasks; task-only cards without run/promotion controls                                                                                                                                                                                                                                      |
| Agent definition/package/Studio/launch snapshot                                                    | Explicit `external_task_sync` capability, source configuration schema and supported engine floor; immutable launched semantics                                                                                                                                                                                                                                                                    |

For every route enumerate identifiers in Phase 0: slug/observation ID are
`url-param` and access-controlled; actor/run are `auth-context`; project, grant,
task and allowed repository are `server-state`; issue identity, revision, facts,
operation key and any adoption target are `body-controlled` and must match the
server scope. A cross-project/foreign-host URL is not a fetch instruction.
Personal/project/service/librarian tokens do not acquire agent mutation authority
merely by having task edit permission; give human adoption/resolution their own
explicit grants. Include positive and negative authorization checks.

Freeze scopes `tasks:sources:read` and `tasks:sources:sync`: read maps to existing
task visibility; sync requires project `editTask` plus the frozen operational
grant. Do not add sync to librarian, service, generic project or cross-project
grants. Human adoption/conflict application uses owner/session project `editTask`
with a distinct human-only action guard.

Use existing `MaisterError` codes: CONFIG/422 malformed or unsupported facts,
UNAUTHENTICATED/401, UNAUTHORIZED/403, PRECONDITION/409 missing execution
precondition/evidence, CONFLICT/409 stale revision/lease/digest/protected work.
Use explicit existence-hidden `NOT_FOUND`/404 lookup responses like existing
external routes; PRECONDITION does not automatically map to 404. Per-source
provider failure belongs in an observation/operational diagnostic with sanitized
status, provider operation, retry policy and remediation; it is not local task
closure. Phase 0 locks exact response bodies, reason enums and privacy rules.

## Tasks and commit phases

Every task below inherits Settings logging; no extra log framework or polling.
Each behavior phase starts with runnable failing integration assertions, proves
the intended failure, makes them green, then refactors with behavior preserved.
Per-phase exit: affected tests and the full web/MCP unit + integration suites
green, no silently excluded failures; docs/contracts/types/lint green. Existing
test expectations are changed only where this plan intentionally changes them.

### Phase 0 — Complete SDD and freeze contracts

- [ ] **T0.1 — Specify lifecycle, evidence and safety invariants.** Create
      `docs/system-analytics/github-task-reconciliation.md` using R5, with this state
      table, exact admission allow-lists, conflict/decision flows, failure/cancellation
      windows and at most twelve enforceable Expectations. Amend task queue,
      qualification, task lifecycle, agent activity/history and external-operations
      analytics by links and necessary changed semantics. Reserve the next ADR
      (baseline next is 199), then add its real record/stub before linking it.
      Expectations name their SQL/CAS/authorization/admission enforcement point.
      Log specification validation failures through existing validators only.
- [ ] **T0.2 — Freeze API, DB, UI and coverage contracts.** Update
      `docs/api/external/operations.openapi.yaml`, `docs/api/web.openapi.yaml`,
      affected existing AsyncAPI/domain-event definitions, `docs/database-schema.md`,
      a source-domain Mermaid ERD, screen references and canonical indexes. Mark all
      new behavior Designed. Specify field limits, nullable/terminal checks, FK and
      lock order, receipt examples, SET/CLEAR behavior, revocation, redaction and
      recovery. Reserve migration 0210 from the current journal; recheck collisions
      before generation/rebase. Record supported transport evidence and the MCP
      qualification gap explicitly. No imaginary ADR anchors or runtime claims.
      **Exit:** every state/refusal/capability/consumer has a concrete acceptance
      case below; no conflicting status or retry semantics remain. Depends T0.1.

### Phase 1 — Durable source model, reducer and admission

- [ ] **T1.1 — Add schema and evidence reducer with real Postgres coverage.**
      Change `web/lib/db/schema.ts`; generate a new migration, journal and snapshot;
      add `web/lib/tasks/external-sources/` typed schema/reducer/store modules.
      Reuse existing activity/audit/outbox patterns. Add relational uniqueness,
      immutable evidence, source generation, hold ownership and conflict constraints.
      Declare an additive writer floor for source-bound task transitions and run
      admission so an older web binary cannot bypass the hold. Update all writer
      pools/test DB builders. Preserve existing tasks/runs and leave them unbound.
      Legacy adoption is preview/apply with explicit mapping and abort-on-ambiguity,
      not a destructive SQL backfill. Regenerate DBML. INFO on state changes; WARN
      on stale generation/adoption conflict. Depends T0.1–T0.2.
- [ ] **T1.2 — Enforce the hold at every new-work boundary.** Extend
      `web/lib/tasks/qualification-admission.ts`, `web/lib/services/runs.ts`,
      agent delivery launch admission, `web/lib/runs/launchability.ts`, scheduler C2
      eligibility and Pending first dispatch. Check again inside the claim/task
      lock; `force` cannot bypass. Distinguish new delivery from existing admitted
      HITL/checkpoint/crash continuation. Qualification acceptance and local run
      finalization cannot erase an external hold or overwrite a pending conflict.
      Include every task status writer and dependency consumer in the implementation
      inventory before editing. Extend the success predicate for disputed external
      prerequisites and wire `task.source_reconciled` into dependency wake-up through
      `web/lib/domain-events/auto-launch.ts`/existing queue consumers without
      broadening auto-launch policies or synthesizing run events. WARN refused admission with stable reason/source ID;
      no changes to supervisor session cancellation. Depends T1.1.

### Phase 2 — Authorized reconciliation API, recovery and attention

- [ ] **T2.1 — Thread immutable capability and expose API/MCP.** Update
      `web/lib/agents/definition.ts`, registry/effective resolution, package gates,
      Studio/attachment validation, launch contract and run snapshots; add the
      external source service/routes, token scope/action/grant maps, `mcp/src/tools.ts`,
      `rest.ts`, `toolsets.ts` and their schema/dispatch contracts. Re-lock credentials,
      grant, source generation and task on apply. Validate SET → CLEAR → SET of the
      definition/config on new launches, while old runs/retries use their frozen
      grant and cannot broaden it after an update. Enforce generic `task_create`
      refusal for sync-granted callers, plus the source activation/legacy producer
      barrier and its credential-issuance race. Keep `task_complete` human-only.
      INFO reconciliation receipts, WARN authorization/CAS refusals with no secrets.
      Depends T1.1–T1.2.
- [ ] **T2.2 — Make claims, receipt repair and conflicts recoverable.** Persist
      due cursors and last-attempt markers; bound lease renewal and stale completion;
      expose durable read-back receipts, failed/interrupted observation settlement,
      and confirmed/unknown/repaired comment-intent settlement. Add the source conflict variant to existing
      decisions/Inbox projection, authorization and notification/read-receipt paths.
      One episode per task/source, unchanged observations do not increment attention or
      unread counts; acknowledgements survive normal scans. Fresh facts or a
      versioned human resolution settle conflicts, never generic scan success.
      Specify/run crash tests before claim, after claim, after local commit and after
      an unknown comment response. WARN exhausted/expired work with remediation;
      ERROR only unrecoverable processing failures. Depends T2.1.

### Phase 3 — Both core transports and operational receipts

- [ ] **T3.1 — Implement gh observations and revise shared intake protocol.**
      In the companion repository, update both definitions' shared configuration,
      explicit capability and shared `github-issue-intake/SKILL.md`; provide reusable
      validated gh observation query/parser rather than asking the model to infer
      state from prose. Initial candidates and bound/watched sources have independent
      fair budgets. Creation goes through source reconciliation, with Incoming
      qualification and pending/completion comment recovery preserved. Count only
      confirmed receipts under unchanged `operational_v1`; add references instead of
      extra counters. Preserve source body/qualification provenance on eligible
      import. WARN partial reads/unknown effects, never log bodies. Depends T2.1–T2.2.
- [ ] **T3.2 — Qualify MCP observation support explicitly.** Update MCP required
      capability contract, exact supported binding/revision documentation and read
      adapters; run the same normalized scenarios against actual response shapes.
      Tool names or up-to-five-reference summaries alone are insufficient. Missing
      identity/closure reason/canonical target/link completeness must refuse the
      affected action with `GITHUB_OBSERVATION_UNSUPPORTED` or
      `GITHUB_OBSERVATION_INCOMPLETE`, not fallback or assumed parity. If a compatible
      binding is unavailable, this task remains incomplete for full MCP parity;
      record the concrete upstream/binding extension needed rather than advertising
      it as supported. Do not broaden this into credential management or a new
      platform-owned GitHub polling service. Depends T3.1.

### Phase 4 — Task projection and user decisions

- [ ] **T4.1 — Show source lifecycle without artificial runs/workspaces.**
      Update `web/lib/board.ts`, board/task-detail queries and task DTOs/components;
      add a task-only source card and Incoming partition predicates. Apply explicit
      precedence: protected local work retains its run view plus conflict badge;
      externally closed source task renders closed despite older failed runs;
      external review without protected work renders OnReview with PR links, no
      merge/diff/promotion actions. Show duplicates/not-planned as closed with reason.
      Update project task/history and agent history summaries from receipt data;
      never insert source-only rows into active working copies or the rail. Extend
      relevant existing live refresh/SSE invalidations; no client polling. Add EN/RU
      copy, accessible source links, draft/merged indicators and conflict actions.
      INFO human decisions through activity/audit, no rendering logs. Depends T2.2.
- [ ] **T4.2 — Wire safe conflict/adoption UI.** Same-project legacy adoption
      preview explains exact identity/receipt match and ambiguity. Inbox conflict
      shows external fact, preserved runs, current hold and actionable refresh/apply
      controls. Apply is disabled/refused while protected work exists and rechecked
      server-side. Reading/acknowledging does not lift hold; no auto-cancel button
      hidden in a sync action. New facts preserve acknowledgement unless actionable
      remediation changed. EN/RU parity and navigation to task, run and GitHub.
      Depends T4.1.

### Phase 5 — Acceptance, compatibility and release readiness

- [ ] **T5.1 — Execute minimal cross-layer qualification and adversarial review.**
      Run the acceptance matrix below, exact companion candidate qualification and
      existing code delivery regressions. Inspect actual HTTP/MCP payloads, DB
      receipts, first-dispatch guards, board/Inbox behavior and workspace absence.
      Record controlled fixtures separately from actual supported provider probes.
      Review authorization, event order, lock ordering, protected-work predicates,
      UI precedence and every fix cycle; fix any discovered holes with a regression
      at the owning boundary. No coverage-number tests or checks that only mirror
      implementation. Depends T3.1–T3.2 and T4.1–T4.2.
- [ ] **T5.2 — Finish docs and platform-first compatibility gates.** Mark only
      verified features Implemented; publish supported-engine/transport requirements
      in current platform and EN/RU public docs and core README. Increment platform
      engine support from the baseline 3.10.0 to a dedicated capability floor
      (proposed 3.11.0; recheck actual master before reserving). New core release
      requires that floor and a new immutable version/tag after v1.4.0. Run the
      existing package release validator against the exact candidate. Rebase/number
      collision pass includes ADR, migration triple, schema and generated ERD;
      `db:generate` must report no pending changes. No release tag, push or deployment
      is implied by this implementation plan. Depends T5.1.

## Acceptance and minimal test ownership

New tests live under the runner globs already verified in
`web/vitest.workspace.ts` and `mcp/vitest.workspace.ts`; confirm with
`vitest list --project integration` before counting them. Extend an existing
fixture/scenario table where it owns the behavior rather than duplicating it
across service, route and browser tests.

| ID   | Required observable behavior and edge cases                                                                                                                                                                                                                                                                                                                                                             | Owning proof                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| AC1  | Open eligible issue with complete empty PR linkage creates exactly one Incoming task; zero new work creates none; local task statement/provenance preserved                                                                                                                                                                                                                                             | Real Postgres source reconciliation integration; extend exact-candidate core integration                               |
| AC2  | New active/draft/merged-linked issue is watched without a task; final unmerged PR closure/unlink makes it eligible again; multiple PRs prevent false eligibility                                                                                                                                                                                                                                        | Provider parser/adapter scenario table plus source reducer integration                                                 |
| AC3  | Bound task with external PR renders review without a run/worktree; closing completed yields Done without local delivery; duplicate/not-planned yield closed non-success reason and canonical reference                                                                                                                                                                                                  | Reconciliation DB integration; one task/board/Inbox Playwright journey                                                 |
| AC4  | Missing immutable ID, reason, duplicate target, incomplete pagination, GraphQL partial error, MCP missing enrichment/truncation/filtering never proves no PR or completion; 401/403/404/429/network exhaustion preserve prior facts with remediation                                                                                                                                                    | Shared raw provider contract fixtures; gh command boundary and supported MCP binding contract probes                   |
| AC5  | Same-key/same-payload receipt replay has no effects; different payload conflicts; overlapping gh/MCP claims cannot double-create; stale lease/generation, reversed apply order, rename/transfer and changed task revision cannot overwrite newer state; blocked dispatch vs reconciliation terminates without deadlock                                                                                  | Real Postgres two-client races at source/task admission invariant, including guard-disabled mutation check             |
| AC6  | Active/HITL/idle/child-waiting/human/local-review/crashed work survives source changes; concurrent runs all retained; initial Pending is parked; admitted resume/recovery permitted; new manual/force/scheduled/agent delivery attempts refused; own PR preserves local delivery ownership while foreign/mixed PRs conflict                                                                             | Extend qualification-admission/queue-write integration and service launch tests at actual allocation seam              |
| AC7  | Source hold cannot be cleared by qualifier success, run failure/finalization, a user queue-pause toggle or repeated scan; clearing source hold preserves manual pause                                                                                                                                                                                                                                   | Same admission integration table; no separate mirrored unit tests                                                      |
| AC8  | One durable Inbox conflict per task/source, including changed or simultaneous causes; repeated/successful scans and read acknowledgement do not resolve/re-notify it; meaningful remediation updates it; foreign users/projects cannot see/resolve it; concurrent permission requests remain usable                                                                                                     | Decisions/Inbox integration and shared Playwright journey                                                              |
| AC9  | Reopening/reason correction requalifies source-owned work; completed vs human-Abandoned and duplicate vs locally delivered Done preserve terminal ownership; new dependent work blocks on disputed success while existing dependents continue; external Done emits a real task event that wakes and launches an already-armed eligible requires-dependent; duplicate/not-planned never satisfy requires | Source reconciliation + task relations/domain-event integration                                                        |
| AC10 | Crash/cancel before/after claim, local commit and receipt-comment response recovers from durable evidence, preserves tasks/history, releases expired claims and advances fair cursors; orphan legacy marker remains held; failed/unchanged watched sources consume reserved budgets without starving bound sources; caps report incomplete, not complete                                                | Receipt/lease recovery integration with controlled provider HTTP server; existing operational cleanup suite regression |
| AC11 | Frozen capability works; absent/wrong-kind/foreign source/revoked/expired/terminal credential and body run/project spoofing refuse; SET/CLEAR/re-set and old-run snapshots remain stable; sync-granted generic task_create refuses; live legacy intake creation races cannot bypass source activation                                                                                                   | API/MCP auth integration; extend launch-config-snapshot and exact package installation tests                           |
| AC12 | Adoption is exact/revision-guarded; no/multiple/foreign match refuses; deleted-task tombstone prevents accidental reimport; migration preserves rows/refuses stale writers; contradictory facts violate constraints; referenced evidence survives deletion attempts                                                                                                                                     | Real migrated Postgres + writer floor/adoption integration                                                             |
| AC13 | Closed/review source tasks leave Incoming correctly and appear exactly once in board/history; protected run remains visible as before; no source task in rail/workspaces, no promotion affordance on source-only card; EN/RU equivalent                                                                                                                                                                 | Board/Inbox query integration and the single browser journey, including local delivery control case                    |
| AC14 | Ordinary code delivery still reviews/promotes/merges exactly as before, ordinary `task_complete` remains restricted, operational scan results remain v1 and completed workspaces are cleaned                                                                                                                                                                                                            | Existing task-completion, operational-kind/lifecycle and promotion integration suites                                  |

AC10 explicitly includes run A committing task + intent and then terminating;
run B claims that intent, reads back the existing GitHub marker and settles it
exactly once, leaving A's observation unchanged and creating no second task.

Run focused RED and GREEN commands through pnpm with Node 24; use existing
isolated Postgres/test-support fixtures and the project's E2E harness. The final
gate includes `pnpm --filter maister-web test:unit`,
`pnpm --filter maister-web test:integration`, MCP unit/integration/typecheck,
web typecheck/lint, `pnpm validate:contracts`, `pnpm validate:docs:all`, generated
ERD/schema checks and the targeted Playwright file. Update affected existing
assertions in board tests, `qualification-admission.integration.test.ts`,
`queue-write-paths.integration.test.ts`, `operational-core.integration.test.ts`,
`launch-config-snapshot.integration.test.ts` and MCP tool-contract tests in their
owning phases. Existing unrelated expectations must remain green; do not hide
failures with skips, weaker assertions or an inferred baseline pass.

## Crash, cancellation and retention contract

| Boundary                                             | Durable state and recovery owner                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before claim commit                                  | No observation/effect; next fair scan can retry                                                                                                                                   |
| Claim committed, provider read interrupted/cancelled | Observation records interruption/expiry; source stays due; next claimant fences the old owner; no task status guessed                                                             |
| Facts read, transaction refuses/rolls back           | No partial task/conflict/outbox change; refresh on conflict; provider facts alone are not an applied receipt                                                                      |
| Reconcile committed, client loses response           | Read/replay exact immutable receipt; do not repeat task creation                                                                                                                  |
| GitHub comment intent exists, response unknown       | Existing marker read-back repairs/finalizes receipt before retry; unresolved remains visible and prevents successful claim of completion                                          |
| Active run later completes/fails                     | Its own lifecycle/cleanup remains authoritative; conflict remains pending fresh source evaluation; never apply a stale queued closure blindly                                     |
| Intake workspace cleanup fails                       | Existing operational disposition/cleanup claims retain evidence and remediation; source/task transaction is not rolled back                                                       |
| Attachment disabled/credential revoked               | New claims/writes stop; old committed evidence/read authorization retained according to normal history policy; source bindings remain owned and visible for explicit reassignment |

No source record is deleted merely because a package is removed, a task is
closed, a scan workspace is cleaned or a repository becomes inaccessible.
Observation retention follows the existing evidence policies; retain the latest
accepted observation, applied closure evidence and open conflict references.
GC must not cascade away task/run provenance. Do not create a second retention
scheduler or delete unexpected source changes as part of reconciliation.

## Commit and release sequence

1. Platform: Phase 0 contracts/analytics (`docs: specify GitHub task reconciliation`).
2. Platform: Phase 1 schema/reducer/admission (`feat(tasks): persist external source lifecycle and admission holds`).
3. Platform: Phase 2 capability/API/attention (`feat(api): reconcile source-bound tasks with durable receipts`).
4. Companion: Phase 3 both intake transports (`feat(core): reconcile GitHub issue and task lifecycle`).
5. Platform: Phase 4 UI/decisions (`feat(tasks): show external review and closure evidence`).
6. Both repositories: Phase 5 acceptance/docs/compatibility, separate focused commits per repository.

Platform migration and compatible binaries/MCP must land before a new core pin
can activate the feature. Activation drains/revokes incompatible same-source
intake mutation credentials before enabling managed-source mode, including old
live runs; history/snapshots remain intact, but obsolete creation authority does
not. The activation transaction serializes with credential issuance/creation.
Deployment must drain incompatible web writers; the DB
writer gate refuses old admission writes for bound tasks. Roll back application
only to a build that understands the source hold; keep additive schema/evidence.
Do not downgrade to an old intake pin and silently re-enable task creation for
watched/bound sources. Disable the binding and show an unsupported-contract
diagnostic until a compatible version is selected. Existing launched runs keep
their launch snapshots; legacy runs without the grant cannot use the new writes.

Deployment wiring: no new daemon, port, filesystem mount, environment variable
or supervisor command in this design. Existing web DB migration and platform MCP
binary build are required. A proposed MCP binding extension introducing a binary
or env var must amend Phase 0 and add explicit Docker/compose/configuration wiring
before it can count as implemented; do not smuggle it into the transport task.

## Remaining qualification questions

- Which exact configured GitHub MCP binding/revision can produce complete
  immutable identity, current linked PR facts and duplicate canonical target?
  This is a qualification/release blocker for full MCP parity, not permission
  to guess or switch to gh. The gh implementation can be qualified independently.
- Verify supported GitHub server/API versions against the normalized contract;
  unsupported deployments must receive explicit evidence-capability diagnostics.
- Recheck ADR/migration/engine/package version reservations against master/main
  immediately before their owning phase and before integration. These moving
  identifiers are not unresolved lifecycle decisions.

All user-facing lifecycle policy is specified above. The confirmed active-run
decision is mandatory, not an option to revisit during implementation.

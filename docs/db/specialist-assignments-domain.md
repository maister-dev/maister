# Specialist assignment and company runtime persistence

**Implemented: assignment/input/run-link base, reviewed configuration, company standalone/graph execution, canonical intake and human context history and origin-delivery transport; Designed: governed cooperation — ADR-203.** [Runtime](../system-analytics/specialist-runtime.md), [assignments](../system-analytics/specialist-assignments.md) and [cooperation](../system-analytics/specialist-cooperation.md) own behavior. Existing human `assignments` and host `execution_assignments` are not repurposed.

## Migration reservations

Main `0232_company_grant_requests` and `0233_native_knowledge_execution` are implemented. Implemented base unit `0234_specialist_assignments` contains assignment heads, immutable inputs, existing-run links and state facts. Specialist bindings use `0236_company_specialist_bindings`; reviewed company Flow bindings use `0237_company_flow_bindings`. Trigger scope uses `0238_company_trigger_scope` on existing scheduler tables. Retry scope uses `0239_company_retry_scope` on the existing retry ledger. Native run ownership and internal credentials use `0240_company_agent_execution` and `0241_company_agent_credentials`. Context history uses `0259_specialist_context_revisions`. Assignment clarification subjects extend existing HITL storage through `0262_specialist_question_subject`; native answer receipts use `0263_specialist_question_answer`; `0264_specialist_flow_question` extends the existing node resume grammar and native source guards. Native session/bearer question and human-answer adapters reuse these existing rows and guards. Result-availability witnesses and immutable business delivery receipts use `0265_specialist_result_delivery`; `0266_specialist_delivery_targets` extends existing webhook deliveries and Inbox rows. Native delivery inspection and replay are locally qualified under T25; accepted-outcome publication remains T28. Logical-work storage uses `0269_specialist_logical_work`: immutable request definitions, canonical delegated intake receipts and explicit native child witnesses. Current-authorized delegation dispatch remains T27; acceptance/ownership and stand operations follow as generated logical units in their owning tasks. Allocate each numeric prefix from the then-current journal; later tables are not precreated as a prerequisite for the base store. Existing head/input/run-link rows survive each additive migration. The main migration units never FK a new Brain table; knowledge pointers store typed record/revision/witness/digest values and the owning service validates them after both lineages are ready. `runs.flow_revision_id` and existing immutable installed revision schema remain runtime truth.

The base business structures link existing execution records rather than duplicating attempts. Work persistence is implemented; its native delegation service remains T27. Acceptance and claim entities remain designed until their owning slices land; context history and specialist/Flow binding configuration are implemented.

```mermaid
erDiagram
    COMPANIES ||--o{ COMPANY_SPECIALIST_BINDINGS : configures
    COMPANY_SPECIALIST_BINDINGS ||--o{ COMPANY_FLOW_BINDINGS : coordinates
    FLOW_REVISIONS ||--o{ COMPANY_FLOW_BINDINGS : pins
    COMPANIES ||--o{ SPECIALIST_ASSIGNMENTS : owns
    PROJECTS ||--o{ SPECIALIST_ASSIGNMENTS : owns
    SPECIALIST_ASSIGNMENTS ||--o{ SPECIALIST_INPUT_REVISIONS : freezes
    SPECIALIST_ASSIGNMENTS ||--o{ SPECIALIST_CONTEXT_REVISIONS : appends
    SPECIALIST_ASSIGNMENTS ||--o{ SPECIALIST_WORK : delegates
    SPECIALIST_ASSIGNMENTS ||--o{ SPECIALIST_INTAKE_RECEIPTS : correlates
    SPECIALIST_ASSIGNMENTS ||--o{ SPECIALIST_RUN_LINKS : executes
    RUNS ||--o{ SPECIALIST_RUN_LINKS : existing_attempt
    RUN_RESULTS ||--o{ SPECIALIST_WORK_DECISIONS : exact_result
    SPECIALIST_WORK ||--o{ SPECIALIST_WORK_DECISIONS : accepts_reworks
    SPECIALIST_ASSIGNMENTS ||--o{ SPECIALIST_ACCEPTANCES : accepts
    SPECIALIST_ASSIGNMENTS ||--o{ SPECIALIST_DELIVERY_RECEIPTS : returns
    SPECIALIST_DELIVERY_RECEIPTS ||--o| WEBHOOK_DELIVERIES : existing_transport
    SPECIALIST_DELIVERY_RECEIPTS ||--o| INBOX_ITEMS : private_notice
    SPECIALIST_ASSIGNMENTS ||--o| SPECIALIST_OWNER_CLAIMS : fences
    SPECIALIST_DELIVERY_RECEIPTS {
        text id PK
        text assignment_id FK
        integer input_revision FK
        text run_id "logical existing Run"
        integer result_revision
        text signal "result_available"
        text source_event_id "exact server witness"
        text outbox_event_id UK
        jsonb snapshot "frozen owner input result target sources"
        timestamptz created_at
    }
    DOMAIN_EVENTS {
        bigint id PK
        jsonb assignment_result "nullable server-owned terminal witness"
    }
    WEBHOOK_DELIVERIES {
        text id PK
        text specialist_delivery_id FK,UK "exclusive with subscription and push targets"
        text status
        integer attempt_count
    }
    INBOX_ITEMS {
        text assignment_delivery_id FK,UK
        text company_id FK "exclusive native company or project"
        text project_id FK
        text task_id FK "required on legacy rows"
    }
    RUNS {
        text company_id FK "exclusive company or project owner"
        text project_id FK "NULL for company work"
        text task_id FK "NULL for company work"
        text flow_revision_id FK "actual installed graph pin"
        jsonb company_execution_snapshot "immutable v1 agent or v2 graph"
        jsonb operational_cleanup "shared bounded resource disposition"
    }
    SPECIALIST_ASSIGNMENTS {
        text id PK
        text company_id FK
        text project_id FK
        text status
        integer revision
        integer input_revision
        integer context_revision
        jsonb requester
        jsonb responsible
        text specialist_binding_id
        jsonb blockers
        jsonb origin
        jsonb destination
        text acceptance_id
        text terminal_reason
        timestamptz completed_at
    }
    SPECIALIST_OWNER_CLAIMS {
        text assignment_id PK,FK
        text owner_id
        bigint epoch
        text run_id FK
        timestamptz expires_at
        timestamptz renewed_at
    }
    SPECIALIST_INPUT_REVISIONS {
        text assignment_id PK,FK
        integer revision PK
        jsonb objective_input
        jsonb source_restrictions
        jsonb authority_snapshot
        jsonb standing_definition
        jsonb scheduled_request
        jsonb actor
        text digest
    }
    SPECIALIST_INTAKE_RECEIPTS {
        text id PK
        text source_kind
        text source_key
        text request_digest
        text disposition
        text assignment_id FK
        integer input_revision FK
        jsonb actor
        text work_id FK "NULL on created receipts"
        integer work_revision FK "exact delegated work revision"
        timestamptz created_at
    }
    SPECIALIST_CONTEXT_REVISIONS {
        text assignment_id PK,FK
        integer revision PK
        integer base_revision
        integer input_revision FK
        integer schema_version
        jsonb context
        jsonb source_restrictions
        jsonb actor
        bigint owner_epoch "NULL for human edits"
        text principal_key
        text request_key
        text request_digest
        text content_digest
        timestamptz created_at
    }
    SPECIALIST_WORK {
        text id PK
        integer work_revision PK
        text assignment_id FK
        integer input_revision FK
        text input_sha256
        text logical_work_id
        integer revision "business CAS"
        text decision_state
        text request_sha256
        text source_key UK
        text parent_run_id FK
        text reserved_run_id UK "intent only"
        text child_run_id FK,UK "actual existing Run"
        jsonb definition
        text definition_sha256
        jsonb actor
        jsonb authority_snapshot
        jsonb bounds
        jsonb source_restrictions
        timestamptz created_at
    }
```

## Canonical intake receipts

Generated main `0253_specialist_intake_receipts` adds one immutable source-delivery receipt per canonical owner/source key. It references the exact existing assignment input, retains the server actor and original request digest, and indexes assignment history. Source keys include the owner and canonical origin, manual requester identity, and the addressed specialist binding for task comments. A unique `(source_kind,source_key)` plus a bounded transaction advisory lock serializes concurrent deliveries; content conflicts do not repeat dependent writes. Insert validation binds source kind and actor to the retained assignment/input. UPDATE and DELETE refuse. No Brain table is referenced; existing rows are not rewritten. Source dispatch and continuation remain their owning slices.

Generated main `0254_specialist_project_flow_input` permits an explicit standing snapshot v2 only for newly retained project coordinator inputs. Its closed Flow witness names the project provider/ref, exact installed revision and resolved revision, plus the manifest SHA-256; v1 input bytes and existing assignment fields remain unchanged. A nullable `specialist_assignments.project_task_id` references the initial existing project task, with an owner CHECK, same-project reference guard, immutable non-null link and partial index. Its first CAS write and ordinary task creation commit together. No legacy task identity is invented; company assignments retain NULL. Existing input/history guards and the existing Run/node-attempt ledgers remain authoritative. No Brain FK or new execution ledger is introduced.


Generated main `0255_company_event_admission` leaves project event claims unique on agent/event and scopes company claims to company/professional/subscription/event. A source insertion/reference guard requires its exact existing reserved invocation, owned event and immutable assignment origin. Historical null/unknown triggers, original Run/input bytes and cron v1 snapshots remain unchanged; existing owner CHECKs remain in force. Event source references and inherited restrictions use existing assignment inputs; no Brain FK, clock or execution ledger is added.

## Immutable context history

Generated main `0259_specialist_context_revisions` adds retained version-one context snapshots with exact input references and content-guarded request receipts. The parent lock serializes revision allocation; a deferred invariant requires the context head to equal retained history. Existing heads/inputs remain byte-for-byte unchanged, and revision zero creates no synthetic history or attribution. An inconsistent pre-existing positive head aborts the migration instead of inventing rows. Main-only upgrade and ordinary company context edits work without Brain tables; there is no Brain FK.

New entries are bound to the server actor and introduced revision; unchanged entries retain their exact original attribution. Removed entries require an explicit replacement, and inherited source restrictions cannot shrink. Public human edits record NULL ownership epoch and cannot manufacture accepted work. Each snapshot is bounded to 256 entries/128 KiB of PostgreSQL JSONB text. Executing-agent appointment/fencing and exact child-result acceptance remain their owning runtime slices.

Generated main `0260_specialist_context_credentials` extends the existing company credential CHECK with `assignments:read`. It preserves the current Flow-node/standalone owner shape, immutable token binding, exact role limit and original credential bytes. Issuers add the scope only under the current reviewed binding; the external context service checks current assignment/input appointment and source access separately. No general Brain permission, table or execution ledger is added.

Generated main `0261_specialist_context_mutation_credentials` adds only `assignments:update` to the company credential CHECK, preserving `0258` read scope and every prior owner/node/immutability predicate. Context service writes bind the server Run/node actor, current update authority and full consuming-Run source closure. Existing credential rows are not widened or rewritten; rotation selects current reviewed limits. This unit adds no table or Brain dependency.

## Exact persistence contract

All new entity IDs are server-generated; timestamps UTC. Versioned closed JSON contains typed fields specified in the owning API/native schemas. Absence/null/legacy variants are explicit, not generic empty objects.

| Entity | Required fields, uniqueness and defaults | Deletion/index/transaction contract |
| --- | --- | --- |
| `company_specialist_bindings` (Implemented, 0234) | Stable company/role identity, current installed pin, enabled=false default, positive configuration revision, server creation identity/key/digest and retirement time | Live `(company_id,agent_id)` unique; current pin RESTRICT until explicit detach; retained heads cannot be deleted or reactivated; no project FK |
| `company_specialist_binding_revisions` (Implemented, 0234) | Binding/revision PK, self-contained versioned package/definition/raw/effective configuration/policy/action limits, server actor/authority witness, request key/digest, content witness and retirement reason | Immutable accepted configuration/replay receipt; exact owned head and positive sequential revisions; per-binding/actor/key unique; deferred head/history coherence; logical historical provider reference survives retirement |
| `company_flow_bindings` (Implemented, 0235) | Stable company/Flow identity, exact current Flow/package/specialist pins, enabled=false, positive revision, server creation receipt and retirement time | Live `(company_id,flow_ref_id)` unique; current foreign keys RESTRICT until explicit retirement; sequential immutable identity and deferred head/history coherence; no project `flows` row |
| `company_flow_binding_revisions` (Implemented, 0235) | Version-1 frozen manifest/package witness, exact responsible specialist configuration, reviewed result-only intent, human role mappings and original answer-grant witnesses, server reviewer/request receipt and content digest | Immutable accepted configuration/replay history; 4 MiB configuration and 32 KiB reviewer-authority bounds; historical provider identities remain logical after retirement |
| Existing schedule/trigger attempt (Implemented storage and native dispatch, 0236) | Exclusive company/project ownership, server-created company source receipt/configuration revision, exact v2 configuration references and unchanged v1 request snapshots; existing claim/fence/reserved-run identities | Preserve project ownership, unknown authorship and v1 bytes; null-safe company creation keys and partial owner due/history indexes; existing delivery/fence/run uniqueness unchanged; company source catalog retention and old project cascades; project consumers exclude company rows; native company consumers retain their distinct current authority |
| Existing run additions (Implemented storage and native dispatch, 0238/0246) | company_id/company binding reference, immutable owner snapshot and specialist assignment link; company result-only flow has project/task/project-flow null and exact flow_revision_id/result_contract | Dedicated CHECK for company run shape, not a new run kind; owner indexes for history/pool/recovery |
| Existing actor/human assignments | Company/project owner union and server principal binding; company role labels resolve reviewed explicit current users | Preserve existing human assignment IDs/claims/events; no fabricated project roles; same current answer authorization |
| `specialist_assignments` (Implemented) | Exclusive owner, binding, requester/responsible, origin/destination, blockers and state; business revision 1, input revision 1/context 0, terminal fields and timestamps | Immutable identity; next business revision and coherent heads; deferred retained-input-head check; failed/cancelled require reason. Completion is refused until the acceptance-owning migration. Owner/status/activity indexes |
| `specialist_input_revisions` (Implemented) | PK assignment/revision; objective/input/targets/refs/constraints/exact result/verification in objective_input; separate authority, standing, recurring request and source restrictions; digest, actor/time | Assignment FK RESTRICT; creation or input append and parent CAS commit together. UPDATE/DELETE refused; current access governs historical reads |
| `specialist_context_revisions` (Implemented human and execution boundaries, 0257) | PK assignment/revision; exact base/input revision, versioned structured context, inherited restrictions, server actor/time, nullable owner epoch, principal/key/request/content digests | Unique assignment/principal/key; exact input composite FK RESTRICT; parent row lock and context/input CAS; immutable history and deferred head/history coherence; retained entries preserve original attribution, supersession is explicit; human epoch NULL; no last-writer merge |
| `specialist_owner_claims` | Assignment PK, owner/run, positive epoch, renewed_at and expires_at, explicit claim state | Owner+epoch+fresh-expiry in every write predicate; lease 120s/renew 40s, not an in-memory mutex; no slot from lease alone |
| `specialist_intake_receipts` (Implemented native intake, 0251) | Server ID, source kind and owner/origin-scoped key hash, original request digest, created or delegated disposition, exact assignment/input and nullable exact work revision, server actor/time | UNIQUE source kind/key; owner derives from immutable assignment and is included in the key; exact input FK RESTRICT; source/actor binding guard and immutable receipt; same-key lock, creation and state event commit together |
| `specialist_run_links` (Implemented) | assignment/run PK, input/work revision and role; existing run pointer and nullable exact native work witness | Unique run, exact input composite FK, immutable links; 0267 native work witness requires exact work reservation, actual direct child and pinned role/Flow. Old opaque labels remain unenrolled; owning admission validates current authority. No independent attempt counter/ledger |
| `specialist_work` (Implemented storage, 0267–0268; standalone agent reservation through 0269) | Composite PK stable server ID/request revision; assignment/input/logical key, independent business CAS revision, actual parent/Run-node actor, pinned target, context/input/result/bounds/source witnesses and content digest; reserved/actual existing Run references | Unique assignment/logical-work/request revision; immutable definition and first reservation/binding; positive source/context/target witness matches required; initial request revision only until T28 decision-owned rework; business decisions separate from projected existing Run/result state; no synthetic legacy work |
| `specialist_work_decisions` | id/work revision/actor/input/result revision, decision/reason/evidence, owner epoch, digest/key/time | Unique work/idempotency key; exact result references RESTRICT; append-only decision history |
| `specialist_acceptances` | id/assignment/input/context/exact result revision, policy/actor/evidence/verification decision, key/digest/time | Unique content-guarded key, acceptance/terminal state/outbox one transaction; cross-row obligations checked transactionally |
| `specialist_delivery_receipts` (0263; locally qualified result availability) | Server ID, assignment/effective input/root Run/exact result revision, result-available signal, source event ID, frozen source/target/versioned witness and private outbox ID | Unique assignment/Run/result/signal and outbox; exact input FK; immutable witness equals the server-captured event; deferred private-outbox coherence. Transport status and attempts remain solely on existing webhook delivery rows |

## Backfill, guards and lifetime

Main `0270_specialist_work_witness_guards` strengthens the `0267` logical-work
insert/binding guard without rewriting retained rows. Source attribution,
context witnesses and current target ownership must positively match; SQL NULL
does not attest any of them. Company agent sources use immutable
`runs.source_agent_id`, so catalog deletion clearing the optional `agent_id` FK
cannot substitute another author. Project agent sources still require their
available `agent_id`; Flow sources still require their exact current professional
node attempt. Missing context fields or target owner identity are refused by the
existing named source/context/target constraints. These main-store checks do not
replace current permission checks or invent historical authority.

Main `0271_specialist_company_child_reservation` adds the standalone child
branch to the existing company Run guards. The insert requires the exact open
reserved Run identity, parent and root lineage, current receiving specialist
binding and grant, and the work’s assignment input and required result. The
deferred link guard checks that the same transaction binds that native work
appointment. Company child lineage and launch contracts are immutable. The
migration retains the existing v1 snapshot shape and writes no historical rows.

**Implemented standalone storage/runtime (T20, 0238):** `runs.company_id` and `runs.company_execution_snapshot` are nullable on legacy rows. New company standalone runs retain a closed version-1 server capture with company owner, business revision at reservation, exact assignment/input ID/revision/digest, specialist configuration ID/revision/digest and initiating user's current `assignments:update` grant witness. Company ownership requires a workspace-none finite operational agent, null project/task/Flow/local-package ownership and exact result contract. The snapshot is immutable, at most 32 KiB, validated against available owned main-store configuration/input history and linked through `specialist_run_links` atomically. Linking advances the assignment business revision separately from its immutable launch receipt. No new run kind or execution ledger is added. Company graph and delegated native-result shapes extend this CHECK only in their owning runtime slices. Old project/private/librarian rows are not assigned guessed company metadata.

**Company graph storage/runtime (T20.1, 0246; controlled ACP qualified):** the existing Run owner CHECK has a separate closed v2 Flow-capture branch. It requires null project/task/project-Flow/local-package ownership, a finite workspace-none graph, null `agent_kind`, responsible source role, pinned installed `flow_revision_id` and a required `flow_export` contract for that revision. The shared insert guard preserves its v1 branch and validates v2 against current queued assignment/input, owned specialist/configuration/authority and exact enabled coordinator history/provider/Flow manifest witnesses. The result producer list and optional native-validation marker must exactly match the pinned manifest. Source version labels come from the actual installed Flow revision and cannot be retargeted. The deferred link obligation requires the same assignment/input and `coordinator` role; the application link service uses the same version union. No table, new execution ledger, backfill or Brain FK is introduced. The main-only populated upgrade preserves v1 company, project and private Run bytes; project deletion remains possible with the Brain lineage absent. Allocation, credentials, graph execution and lifecycle qualification remain separate owning runtime gates.

**Implemented storage and internal service (T20, 0239):** company ephemeral credentials extend `project_tokens` with exclusive company/run references; project/user/librarian rows retain NULL company metadata. Company credentials remain `token_kind=agent`, project-less, expiring and source-role-bound. The existing terminal/GC revokers match their deterministic run name. A partial unique live-run index, exact run/assignment/provider/initial actor checks and immutable credential binding protect rotation. Deleting the initiating user may clear its optional owner FK; verification refuses the now-unavailable account rather than inventing a successor principal. No new credential or attempt ledger is introduced.

`agent_retry_intents` uses nullable `project_id` / `company_id` with an exclusive-owner CHECK, project cascade and company restrict semantics. Its original actor/request-key, source-claim and successor uniqueness remain effective when `project_id` is NULL. The company history index is partial on company ownership. Project v1/v2 recipes remain unchanged; company v3 recipes retain exact owned binding/coordinator and assignment/input witnesses. The insert trigger validates the available main-store history identities/digests and frozen role/configuration/input without calling Brain. Owner/recipe mutation is forbidden by the existing immutable-receipt trigger. Current project admission/cleanup selects only project-owned intents before its bounded limit; native company retry execution remains Designed. See the [versioned runtime contract](../system-analytics/specialist-runtime.md#retained-retry-scope).

Company identity migration precedes these tables; existing project schedules/actors/human assignments retain their real project owner. Old trigger/request/retry/result snapshots remain version-dispatched and unchanged; new company snapshots explicitly capture company binding. Do not rekey/drop live attachments or seed a guessed assignment for unrelated old runs.

Accepted context/input/work/decision rows are immutable by guarded database writes. Assignment parent/head, claim epoch and existing run/attempt/result updates share one DB transaction where their transition is atomic. Network/filesystem/target effects stay outside DB locks; durable intents precede them and success markers follow acknowledged evidence.

New FK/cascade policy is RESTRICT for referenced assignment inputs/results/effects. Existing run/task/project cleanup cannot silently cascade accepted or unresolved specialist evidence. Authorized soft retirement removes current launchability while preserving historical snapshots. A future retention purge needs explicit reference checks and target receipt retirement, not age-only DELETE.

Startup requires all main then Brain migrations; the runtime refuses new features while either ledger is pending. Fresh/populated/interrupted/second-boot integration and generated SQL/journal/snapshot/schema checks qualify rollout. Invalid existing state aborts loudly with actionable safe context rather than deleting rows.


### Existing human-work ownership extension

Company HITL uses the existing `actor_identities`, human `assignments` and
`assignment_events` ledgers with exclusive nullable project/company ownership.
Existing project rows retain their IDs, claims, events and real project cascade;
new company rows require a real company and owned Run, never a fabricated project.
Company actors are current users or server system identities. A scoped actor row
is an attribution identity and supplies no action authority. Human claim/answer
requires current explicit `assignments:read` and `assignments:answer` plus the Run's
retained source access. Server lifecycle cancellation uses an owned system actor.
Company human work has no repository task, branch or ref. It cannot complete
without a retained responding actor; source-unavailable or revoked human action
authority leaves work pending. Its event owner/Run and
all actor references must match the assignment owner; accepted owner identity is
immutable. User deletion may leave an orphan historical actor, which cannot act
or be rebound to another user. Migration adds NULL company metadata to old rows;
it invents no actors, historical authority or specialist assignment linkage.

This ownership foundation belongs to native company lifecycle (T20/T21), before
company Flow human/form waits. T24 later adds business question/input-revision
semantics and reuses these identities/claims rather than introducing a second
human-work ledger.

**Company graph credentials (T20.1, 0247; controlled ACP qualified):** the existing company/native-node token CHECKs accept an explicitly company-owned `agent-run` credential bound to `knowledge_node_attempt_id`. The insert reference guard requires v2 owner/input/coordinator witnesses, trusted pinned Flow/provider, initiating current read/update authority, current immutable node attestation, that professional's own enabled exact binding and scopes within both binding action sets. Newer node attempts fence old references. The standalone branch still requires a null node. Existing token identity/node immutable guards, one-live-company-token-per-Run index, hashes, expiry, rotation and terminal/GC revocation are reused. No table, token kind, parallel credential store, execution ledger or Brain FK is introduced. Populated upgrades must retain all preexisting token bytes and project cascade cleanup.

**Company graph resource witness (T20.1, 0248; controlled ACP qualified):** the existing `runs.operational_integrity_baseline` CHECK admits an explicit company-owned v2 workspace-none graph with required Flow export, retaining its existing operational-agent branch. No field/table/backfill is added. The same company/run opaque paths, baseline version/generation and integrity inspection are used; current resource-owner validation checks retained company, Run and managed paths. Internal workspace adoption carries an explicit agent/Flow discriminator derived from the validated Run; the host wire remains the existing company-owned directory contract. Populated v1 baseline and Run/token values remain unchanged, and project deletion stays independent of Brain. This is a resource witness, not an operational completion contract or proof of an external effect.

**Native company graph lifecycle (T20.1, 0249; controlled ACP qualification):** the existing graph loader retains an explicit company context and null Task/project-Flow/workspace records. Actual dispatch, node attempts, prompts, results, sessions, driver claims and host commands use the existing ledgers. The resource cleanup CHECK and due index include the exact finite workspace-none v2 Flow branch. The company event reference guard admits that retained owner for terminal, wait, escalation and cleanup facts while retaining the v1 operational-agent branch. Company graph results remain `flow_export`; `operational_terminal` remains NULL. No table, project, Brain FK, scheduler or attempt ledger is added. Main-only populated upgrade preserves prior Run/token values and permits project deletion without Brain tables. Native graph form/human response delivery now reuses the exact company input/actor owner and existing node-attempt vars; captures do not advance during graph input. Engine 3.12.0 supports this native lifecycle, including controlled-ACP permission/idle/restart and retained-result recovery. Full phase compatibility and actual companion/stand qualification remain separate gates.


## Native clarification subjects on existing HITL

Main `0262_specialist_question_subject` adds nullable specialist assignment, exact
source input revision and exact answered input revision to `hitl_requests`, with
composite FKs into retained assignment inputs and native request/history indexes.
It creates no question, execution or attempt ledger and no Brain FK. Legacy task
questions retain their schema, response, times and NULL native metadata; no
historical attribution, assignment or answer input is inferred.

A native question requires its closed server subject, matching company/project
owner, unambiguous current root appointment, exact input/context heads, complete
Run source capture and actual dispatched prompt/incarnation/fence. Subject,
FormSchema, prompt and attribution are immutable. A committed human answer requires
its exact retained input revision; the existing terminal close with NULL response
keeps the question unanswered. Recovery uses the existing pending-termination
state and successful checkpoint receipt. Main `0263_specialist_question_answer`
adds a nullable, immutable `specialist_answer` receipt to the same HITL row. A new
answer binds its exact question/Run, source and answered input revisions, new
input digest, actual human author, request/response digests and accepted time.
Legacy rows remain NULL without invented provenance. Database guards require
current waiting input, a checkpointed source, the next retained input and
unchanged standing/scheduled snapshots before permitting the receipt-bound
`waiting_input` to `active` transition.

The native company/project Inbox answer writer atomically retains that input,
completes the existing human work item, captures all sources and stamps the
existing resume intent. The existing continuation worker performs the actual
capacity/host claim, execution-fence handoff and prompt. A bounded native lineage
function follows at most 32 answer receipts from the Run's immutable original
input; this is lineage proof only, with current principal/professional/source
policy still required. Historical context may refer to an older input; current
question input is validated independently. No frozen Run or run-link snapshot is
rewritten. Main `0264_specialist_flow_question` admits a server-witnessed graph
prompt source and typed `clarification` action resume on the existing node attempt.
Database guards require the exact accepted prompt, current node/professional
identity and checkpointed original incarnation. Only acknowledged quiescence
permits the next ordinal; a successor epoch requires the immutable answer/input
receipt and original checkpoint. No existing task-question bytes or resume variants
are rewritten. Native question submission uses the current own appointment and source policy;
human answers use exact input/business revisions and personal-token authority.
Public routes add no persistence ledger.

### Native result-event and delivery target extensions (0263–0264; locally qualified)

`domain_events.assignment_result` is NULL for historical/unenrolled events. Its
server trigger captures only a real native root appointment's exact effective
input, pinned schema, valid result and complete source closure in the terminal
write transaction. Caller metadata cannot set the witness; updates cannot erase
or retarget it. No historical authorship, source or verification is backfilled.
The result digest uses the explicitly versioned PostgreSQL JSONB/SHA-256 witness.

`webhook_deliveries.specialist_delivery_id` is a third exclusive transport target.
Existing subscription/push rows retain their NULL native pointer and bytes. One
transport row owns each native routing receipt; immutable target identity and
existing leases, bounded retry curve, append-only attempts and replay are reused.
`inbox_items` adds an exclusive company/project native branch with an exact
routing-receipt pointer. Legacy rows still require a project and task. Native
recipient/owner/result/source references are checked at insertion and remain
immutable while recipient-owned read timestamps use the existing mutations.
There is no Brain FK, new execution ledger or second transport-attempt ledger.


### Project source ownership before a Run (Implemented — locally qualified)

Generated additive main `0267_specialist_source_handoff` extends only the existing
`agent_trigger_attempts` row with nullable closed v1 `specialist_assignment` JSONB.
The [assignment contract](../system-analytics/specialist-assignments.md#qualified-project-coordinator-source-handoff-implemented--locally-qualified)
owns its exact grammar, current-authority and recovery behavior. A CHECK enforces
project-only scope and bounded shape. A trigger validates its exact immutable
assignment/input/source binding, admits its first capture only before reservation
use, and refuses later mutation. Existing source identity/fence and queued-to-Run
guards remain authoritative. Legacy/company NULLs and all existing source/request
snapshots are preserved. There is no new source execution table, Brain FK,
backfilled attribution or project-deletion veto. Fresh/populated migration,
immutable-pointer, interrupted-intake and actual source/qualification/recovery
scenarios are locally qualified.

The partial expression index `agent_trigger_attempt_assignment_idx` covers
non-NULL handoff assignment IDs. Bounded resumption reuses this lookup and skips
carriers already owned by canonical launch intents; their existing worker owns
further dispatch and recovery. Historical attempts incur no invented pointer or
additional owner constraint.

Main `0268_project_source_recovery` preserves existing pointer bytes and extends
only first capture from an expired open or unknown invocation. Original Run
receipts, existing Run/intent identity or assignment Run links prohibit reuse;
current source checks and the exact original intake/input proof remain mandatory.
The queued-project partial index supports the existing job's bounded recovery and
qualification passes. It adds no scheduler or attempt ledger.

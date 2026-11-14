# Stand operation persistence

**Implemented — ADR-205.** [Stand maintenance](../system-analytics/stand-maintenance.md) owns exact authority, effect, health and recovery semantics. Main migrations `0299_stand_target_registry` and `0300_stand_target_registry_guards` add the company registry, reviewed revisions and component mappings. Migrations `0301_stand_operation_intents` and `0302_stand_operation_intent_guards` retain the exact assignment input, target configuration, action, authority and restart exclusion. The domain also retains authenticated permits, target receipts, independent health probes, recovery decisions and incident deliveries.

The resource claim links uncertainty across all assignment attempts, while verification stays independent.

```mermaid
erDiagram
    COMPANIES ||--o{ STAND_TARGETS : configures
    STAND_TARGETS ||--o{ STAND_TARGET_REVISIONS : retains
    STAND_TARGET_REVISIONS ||--o{ STAND_COMPONENTS : maps
    STAND_COMPONENTS ||--o{ STAND_OPERATIONS : receives
    SPECIALIST_ASSIGNMENTS ||--o{ STAND_OPERATIONS : requests
    STAND_OPERATIONS ||--o{ STAND_OPERATION_RECEIPTS : proves
    STAND_OPERATIONS ||--o{ STAND_AUTHORIZATION_PERMITS : authorizes
    STAND_OPERATIONS ||--o{ STAND_VERIFICATIONS : verifies
    STAND_OPERATIONS ||--o{ STAND_RECOVERY_DECISIONS : reconciles
    STAND_OPERATIONS ||--o| STAND_RESOURCE_CLAIMS : excludes
    STAND_TARGETS {
        text id PK
        text company_id FK
        text incarnation_id
        integer config_revision
        boolean enabled
    }
    STAND_TARGET_REVISIONS {
        text target_id PK
        integer revision PK
        jsonb connection
        jsonb component_ids
        text actor_id FK
        jsonb authority
        text request_digest
    }
    STAND_COMPONENTS {
        text target_id PK
        integer config_revision PK
        text component_id PK
        text canonical_resource_key
        jsonb config
        text runbook_sha256
    }
    STAND_OPERATIONS {
        text id PK
        text assignment_id FK
        text component_id FK
        integer input_revision
        text request_digest
        text effect_state
        text verification_state
        jsonb frozen_intent
        jsonb before_witness
        jsonb authority_snapshot
        text predecessor_operation_id FK
        timestamptz created_at
    }
    STAND_RESOURCE_CLAIMS {
        text canonical_resource_key PK
        text operation_id FK
        bigint owner_epoch
        text owner_id
        timestamptz expires_at
        boolean unresolved
    }
```

| Entity | Keys/checks/limits | Persistence and lifetime |
| --- | --- | --- |
| `stand_targets` | Server ID, company FK, unique stable incarnation, positive current config revision, enabled=false database default | Company keyset index and deferred check for a complete current configuration |
| `stand_target_revisions` | Target/revision, exact reviewed HTTPS origin and TLS/environment references, immutable component IDs, actor and authority, actor/delivery key and content digest | Retains each accepted configuration. Endpoint and credential references are administrative configuration. Credential values stay in host configuration. |
| `stand_components` | Target/revision FK, component ID, exact systemd scope/UID/unit, canonical resource key, actions/runbook/probe closed config, runbook witness digest | Aliases share the canonical key of the same target incarnation, service manager, scope, UID and unit. The revision's closed component list prevents later additions. |
| `stand_operations` | Server ID, exact assignment input and component revision, action, authority, delivery and intent digests, closed effect and verification axes | Unique assignment, initiating user and delivery key. Migrations `0321`–`0323` retain the current token-bound specialist, Run and node attempt when applicable. Historical session intent has a null execution witness. |
| `stand_resource_claims` | Canonical key PK, exact restart operation FK, positive epoch, owner, expiry and unresolved marker | Expiry leaves exclusion held. A successor requires an explicit linked recovery disposition and higher epoch. A new independent restart can take a resolved claim at the next epoch while the prior operation remains inspectable. |
| `stand_restart_approvals` | Operation PK, exact operation digest/revision, human actor, grant witness, decision digest, delivery key and reason | Immutable exact human decision. Migrations `0302` and `0303` retain it and check the current intent and grant at insertion. |
| `stand_operation_observations` | Exact operation/incarnation/resource/digest FK, target sequence, invocation, observed state and separate capture/receipt timestamps | Migrations `0309` and `0310` retain immutable before-effect observations while the restart is pending. The command retains the selected observation ID, and a dispatch permit requires the matching known-state observation. Migrations `0325` and `0326` add a separate unknown-operation revision and authenticated human read epoch for recovery inspections, leaving existing before-effect observations intact. |
| `stand_read_claims` | Exact operation and read purpose, current actor and grant witness, owner epoch and expiry | Migrations `0313` and `0314` fence helper reads independently of the original Run and mutation claim. Migration `0324` binds specialist reads to their current execution token. A read claim expires after 30 seconds; replacing it advances the epoch. |
| `stand_operation_receipts` | Operation/target receipt revision and sequence, exact retained permit and before/after witnesses, separate capture and receipt timestamps | Migrations `0315` and `0316` retain immutable authenticated target receipts. Adoption checks the exact dispatch and its prior observation, settles the original operation and only releases the claim when the effect is proved. Exact replay is inert. |
| `stand_authorization_permits` | Server permit ID, immutable operation FK, owner epoch, purpose, nonce and issued/expiry times | Migrations `0305` and `0306` bound expiry to five seconds, reject nonce replay and retain at most one dispatch permit per operation. Dispatch admission requires the current operation, resource owner, command placement, assignment input and approving grant. The operation FK retains the digest, resource and incarnation. Migrations `0307` and `0308` add and bind the existing ledger's `stand.dispatch` command. It holds one attempt, no ACP session and no automatic mutation replay. Read permits require the matching current read claim and grant. |
| `stand_verifications` | Server probe identity/nonce, exact operation and nullable applied receipt, actor and read epoch, target sequence and separate issue/observe/receive times | Migrations `0317` and `0318` retain immutable health observations. A verification sequence must follow the applied effect and any previously accepted probe. Projection must match the latest retained observation. Migration `0333` admits an exact read-only inspection probe with no effect receipt. |
| `stand_recovery_decisions` | Operation and resulting revision, actor and grant witness, decision, inspection references, reason, delivery key and digest | Migrations `0311` and `0312` retain immutable holds on unknown restarts with an unresolved claim. Exact replay is inert and changed input conflicts. Migration `0327` guards inspected successor decisions and requires an atomic resource transfer at commit. The original unknown outcome stays immutable. |

Main migrations reference existing main assignment/run/result identities. Runbook/witness references are typed record/revision/hash values validated by the service once both lineages are ready. Required accepted effect/probe references use actual main receipt rows and are checked transactionally at assignment acceptance. Migration `0330_stand_project_execution_attribution` extends the insert guard to project-owned appointments. It checks the original initiating human, current named professional, target grants and exact input without changing stored operations. Local constraints cover owner, lease, digest and state shape. The target receipt and independent probe establish effect and health.

Migration `0305_stand_effect_transition_guards` protects the effect state and
disposition on updates. It leaves existing rows intact. A recorded dispatch
precedes any confirmed effect. A confirmed outcome is immutable, and an
unknown outcome may retain a hold or record an authorized successor. Receipt
adoption remains responsible for proving each authorized transition.


### Scheduled appointment and health

Migration `0332` adds nullable `stand_inspection` on the existing company cron schedule and its trigger attempts. The appointment records target ID, incarnation, configuration revision and component ID. Changing the target requires a new reviewed source. The immutable v1 scheduled request keeps its existing text and shape. Migration `0333` requires the exact appointed operation, permits a health-only result with no applied effect and keeps the restart verification guard on the original receipt. Existing sources and attempts retain null appointments.

### Health incident episodes

Migration `0329_stand_incident_episodes` groups unhealthy or inconclusive independent probes by canonical resource and reason. It retains a single open episode per group, the first and latest contributing operations, and the number and time range of observed failures. A later healthy probe resolves eligible episodes in the same transaction as probe persistence. The assignment view requires current target-read authority and access to every contributing input and the recovery input before showing an episode. A complete scheduled stand result with no action, diagnostics or findings stays in execution and delivery history when it cites the latest healthy inspection probe. A blocked check with a matching incident notification also stays in history. The delivery worker retains delivery for explicitly selected outbound destinations.

Migration `0331_stand_incident_inbox` links existing Inbox rows to exact
episode transitions. The unique episode, recipient and event key makes
repeat publication inert. The insert guard matches the initiating or recovery
operation, assignment ownership and requester, and the row retains that
route when marked read.

The target helper uses its own durable configured journal directory with exclusive process/resource ownership, per-operation intent/receipt/tombstone records and atomic fsynced publication. A target receipt journal is external-effect evidence, not a run-attempt or scheduler ledger. Capacity/corruption refuses new effects before invocation; unresolved records cannot be garbage-collected by age. Pruning retained payloads leaves identity/digest replay protection or an explicit expired-request refusal. Recovery reads stay possible after original run/host placement termination under a separate current operation-recovery fence.

Fresh/populated migration tests cover unknown operations, two aliases/controllers, owner expiry, permit replay, result/target/run retirement, exact successor transfer and interrupted receipt adoption. No migration clears unknown resource claims or deletes receipts to satisfy constraints.

# Stand operation persistence

**Registry and intent persistence implemented — ADR-205.** [Stand maintenance](../system-analytics/stand-maintenance.md) owns exact authority, effect, health and recovery semantics. Main migrations `0299_stand_target_registry` and `0300_stand_target_registry_guards` add the company registry, reviewed revisions and component mappings. Migrations `0301_stand_operation_intents` and `0302_stand_operation_intent_guards` retain the exact assignment input, target configuration, action, authority and restart exclusion. Permit, receipt, verification and recovery tables below describe subsequent persistence work.

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
| `stand_operations` | Server ID, exact assignment input and component revision, action, authority, delivery and intent digests, closed effect and verification axes | Unique assignment, initiating user and delivery key; foreign keys retain historical input and configuration; intent fields are immutable |
| `stand_resource_claims` | Canonical key PK, exact restart operation FK, positive epoch, owner, expiry and unresolved marker | Expiry leaves exclusion held. A successor requires an explicit linked recovery disposition and higher epoch. A new independent restart can take a resolved claim at the next epoch while the prior operation remains inspectable. |
| `stand_restart_approvals` | Operation PK, exact operation digest/revision, human actor, grant witness, decision digest, delivery key and reason | Immutable exact human decision. Migrations `0301` and `0302` retain it and check the current intent and grant at insertion. |
| `stand_operation_receipts` | Operation+target receipt revision unique; target incarnation, permit, sequence and attributable before/after witnesses; received/capture times distinct | Immutable accepted target receipt digest; exact ID/digest/version checked before adoption; result cleanup cannot delete it |
| `stand_authorization_permits` | Server permit ID, operation/digest/resource/incarnation/epoch/nonce, initiating current principal/policy, issued/expiry/consumed times | Nonce unique per exact target/operation; single-use and <=5-second expiry, no model-supplied actor; current decision committed before response |
| `stand_verifications` | Server probe ID/nonce unique, exact operation/incarnation/config/probe, issue and target sequence, healthy/unhealthy/inconclusive evidence | Independent after-effect ordering; no stale healthy observation adoption; immutable results |
| `stand_recovery_decisions` | Exact operation/inspection/current actor/policy/reason/decision/key/digest and optional successor | Same decision replay inert; changed body conflicts; original unknown effect not rewritten by authorized successor |

Main migrations reference existing main assignment/run/result identities but no newly created Brain table. Runbook/witness references are typed record/revision/hash values validated by the service once both lineages are ready. Required accepted effect/probe references use actual main receipt rows and are checked transactionally at assignment acceptance. Generated CHECKs cover local owner/lease/digest/state shape; they do not pretend to verify cross-row health or target truth.

Migration `0305_stand_effect_transition_guards` protects the effect state and
disposition on updates. It leaves existing rows intact. A recorded dispatch
precedes any confirmed effect. A confirmed outcome is immutable, and an
unknown outcome may retain a hold or record an authorized successor. Receipt
adoption remains responsible for proving each authorized transition.

The target helper uses its own durable configured journal directory with exclusive process/resource ownership, per-operation intent/receipt/tombstone records and atomic fsynced publication. A target receipt journal is external-effect evidence, not a run-attempt or scheduler ledger. Capacity/corruption refuses new effects before invocation; unresolved records cannot be garbage-collected by age. Pruning retained payloads leaves identity/digest replay protection or an explicit expired-request refusal. Recovery reads stay possible after original run/host placement termination under a separate current operation-recovery fence.

Fresh/populated migration tests cover unknown operations, two aliases/controllers, owner expiry, permit replay, result/target/run retirement, exact successor transfer and interrupted receipt adoption. No migration clears unknown resource claims or deletes receipts to satisfy constraints.

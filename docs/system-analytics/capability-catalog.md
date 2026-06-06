# Authored capability catalog domain

## Purpose

This domain (**Implemented, M25**) covers the local data model and read/write
groundwork for MAIster-authored rules, skills, and flows. It complements the
Implemented M14 capability registry/import pipeline without changing git
install, trust, setup, Flow package enablement, or runtime materialization.

## Domain entities

- **Authored capability** (`authored_capabilities`, Implemented, M25) — stable
  project-local identity for `rule`, `skill`, or `flow`, keyed by
  `(project_id, kind, slug)`.
- **Authored capability revision** (`authored_capability_revisions`, Implemented,
  M25) — versioned draft/published/archive snapshot with `draft_version`,
  lifecycle, canonical content hash, body, and manifest.
- **Capability projection** (`capability_records`, Implemented M14, authored
  projection Implemented M25) — published authored rule/skill rows appear as
  `source='project'` with `material.origin='authored'`.
- **Capability import** (`capability_imports`, Implemented M14) — git-pinned
  import ledger; M25 reads beside it but never mutates it from authored edits.

## State machine

```mermaid
stateDiagram-v2
    [*] --> Draft: create authored cap
    Draft --> Draft: update body/manifest<br/>draft_version + 1
    Draft --> Published: publish-local
    Draft --> Archived: archive draft
    Published --> Draft: create new draft<br/>based on published revision
    Published --> Archived: archive published cap
    Archived --> [*]
```

## Process flows

### Publish authored rule or skill

```mermaid
flowchart TD
    Start([POST publish-local]) --> Load[load cap + active draft by project]
    Load --> Stale{draft_version matches?}
    Stale -- no --> C409[409 CONFLICT]
    Stale -- yes --> Collision{non-authored project row<br/>same kind+slug?}
    Collision -- yes --> C409b[409 CONFLICT]
    Collision -- no --> Tx[DB transaction]
    Tx --> Pub[mark revision Published<br/>set current_published_revision_id]
    Tx --> Project[upsert capability_records<br/>material.origin=authored]
    Project --> R200[200 published revision + contentHash]
```

### Config resync authored carve-out

```mermaid
flowchart TD
    Sync[upsertCapabilitiesFromConfig] --> Desired[normalize config-owned rows]
    Desired --> Set[SET matching config rows selectable]
    Desired --> Clear[CLEAR missing config rows]
    Clear --> Filter{material.origin == authored?}
    Filter -- yes --> Keep[do not disable authored row]
    Filter -- no --> Disable[selectable=false disabled_at=now]
```

### Authored flow publication

```mermaid
flowchart TD
    Draft[Authored flow draft] --> Publish[mark revision Published]
    Publish --> Store[store immutable local catalog revision]
    Store --> NoTouch[do not write flows or flow_revisions<br/>do not run setup.sh]
```

## Expectations

- `Published` in M25 MUST mean project-local visibility only; external catalog
  publication is a later state/table.
- Draft updates MUST require matching `draft_version` and fail stale writes with
  `CONFLICT`.
- Published revisions MUST be immutable.
- Local publish of `rule` and `skill` MUST project authored-origin
  `capability_records` in the same transaction.
- `upsertCapabilitiesFromConfig` MUST never disable rows with
  `material.origin='authored'`.
- Same `(project_id, kind, slug)` collisions with non-authored project rows MUST
  be refused with `CONFLICT`.
- Authored flow publish MUST NOT mutate `flows`, `flow_revisions`, project
  enablement, install caches, or setup status.
- Authored content MUST NOT run executable hooks in M25.
- Existing git-installed capability imports MUST remain read-only from authored
  catalog routes.

## Edge cases

- Stale `draft_version` returns `CONFLICT` and leaves the draft unchanged.
- Publishing without an active draft returns `PRECONDITION`.
- Same-slug collision with config-owned or import-owned project rows returns
  `CONFLICT` before any projection write.
- Config resync that removes a same-kind slug from `maister.yaml` disables only
  config-owned rows, not authored-origin projections.
- Archiving an authored cap disables only its authored-origin projection and
  preserves historic run snapshots.
- Authored flow publish returns local catalog data only; attempts to execute it
  through Flow package enablement remain a later milestone.

## Linked artifacts

- Spec: [`../../.ai-factory/specs/feature-m25-capability-catalog-groundwork.md`](../../.ai-factory/specs/feature-m25-capability-catalog-groundwork.md).
- API: [`../api/web.openapi.yaml`](../api/web.openapi.yaml).
- Existing capability domain: [`capabilities.md`](capabilities.md).
- Flow package lifecycle: [`flow-packages.md`](flow-packages.md) and
  [`../flow-installer.md`](../flow-installer.md).
- DB: [`../database-schema.md`](../database-schema.md),
  [`../db/capabilities-domain.md`](../db/capabilities-domain.md),
  [`../db/erd.md`](../db/erd.md).
- ADR: [ADR-061](../decisions.md#adr-061-local-authored-capability-catalog-lifecycle).
- Source seams: `web/lib/capabilities/catalog.ts`,
  `web/lib/capabilities/materialize.ts`, `web/lib/capabilities/cleanup.ts`.

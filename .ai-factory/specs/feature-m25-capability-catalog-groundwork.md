# Feature M25 — Capability Catalog Groundwork (E3 Wave-1 Slice)

## Status

Implemented, Wave 1.

## Value

MAIster can already install capability packages from git, but the operator has
no local data model for drafting and versioning rules, skills, or flows in the
app. M25 adds that authored-capability foundation while preserving the existing
read-only import path and deferring external publication/sync to later waves.

## Non-goals

- No PR publication to a catalog repo.
- No two-way sync between DB and a catalog repository.
- No `setup.sh` or executable hook for authored drafts.
- No automatic application of self-improvement proposals.
- No change to `capability_imports[]` fetch/trust/setup semantics.
- No authored flow enablement in `flows` or `flow_revisions`.

## Expectations

- Authored caps are DB records, not writes to `maister.yaml`.
- M25 lifecycle is exactly `Draft -> Published -> Archived`, where
  `Published` means project-local visibility inside this MAIster instance.
- Draft updates MUST require a matching `draft_version`; stale updates return
  typed `CONFLICT`.
- Published revisions MUST be immutable.
- Editing after publication MUST create a new Draft revision based on the
  current Published revision while preserving the published pointer.
- Local publish of `rule` and `skill` MUST project an authored-origin row into
  `capability_records` in the same DB transaction.
- Local publish of `flow` MUST create only an immutable authored revision; it
  MUST NOT mutate `flows`, `flow_revisions`, install caches, setup hooks, or
  project enablement.
- `upsertCapabilitiesFromConfig` SET/CLEAR MUST exclude rows whose
  `material.origin='authored'`.
- Same `(project_id, kind, slug)` collisions with non-authored project
  capability rows MUST be refused with typed `CONFLICT`.
- `content_hash` MUST be `sha256` over canonical JSON
  `{kind, body, manifest, schemaVersion}`.

## Authored model

| Entity | Purpose |
| --- | --- |
| `authored_capabilities` | Stable project-local identity: kind, slug, title, origin metadata, current draft/published pointers, archive state |
| `authored_capability_revisions` | Versioned draft/published/archive snapshots with `draft_version`, canonical hash, and immutable published revisions |
| `authored_capability_projection_events` | Optional retry/audit ledger if Phase 0 keeps auditable projection attempts |

## Acceptance criteria

- Create/update/list/read works for `rule`, `skill`, and `flow` authored caps.
- Stale draft updates fail with `CONFLICT` and no partial revision write.
- Updating a Published capability opens a new Draft revision without mutating
  the Published revision.
- Publishing a rule or skill creates/selects a `capability_records` row with
  `source='project'` and `material.origin='authored'`.
- Config resync never disables or re-enables authored-origin rows.
- Publishing over a non-authored same-slug project row is refused.
- Archiving disables only the authored-origin projection.
- Existing git-installed imports and Flow package lifecycle continue to pass
  unchanged tests.

## Contract trace

- API: `docs/api/web.openapi.yaml` (`/api/projects/{slug}/catalog/caps/*`).
- Domain: `docs/system-analytics/capability-catalog.md` and
  `docs/system-analytics/capabilities.md`.
- DB: `docs/database-schema.md`, `docs/db/capabilities-domain.md`,
  `docs/db/erd.md`.
- Config/trust: `docs/configuration.md`, `docs/flow-installer.md`,
  `docs/system-analytics/flow-packages.md`.
- ADR: `docs/decisions.md` ADR-061.

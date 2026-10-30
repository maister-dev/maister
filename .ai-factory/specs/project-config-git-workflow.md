# Explicit project configuration Git workflow

Status: Implemented. Local qualification and review-fix receipts are recorded in
the implementation plan; they do not claim hosted or live-agent qualification.

## Goal and scope

Apply settings to MAIster runtime state without implicit repository writes.
Explicitly review and commit exportable project fields and attached package
coordinates through the existing persist-config endpoint family. Push requires
its own bound review. No new configuration source or manifest schema expansion.

## Contract ownership

- [Persistence domain](../../docs/system-analytics/project-config-persistence.md)
  owns expectations, state transitions, failure/recovery and publication.
- [Traceability](../../docs/system-analytics/project-config-persistence-traceability.md)
  maps the original twelve requirements and twenty edge groups to tasks/tests.
- [OpenAPI](../../docs/api/web.openapi.yaml) owns wire DTOs and refusal codes.
- [Project schema](../../docs/db/projects-domain.md) owns persistence entities.
- [Implementation plan](../plans/project-config-git-workflow.md) owns sequencing,
  RED → GREEN → REFACTOR, phase-green evidence and local phase commits.

## Export boundary

Export project name/main branch/branch prefix/public branch template, default
runner, promotion mode, and attached package id/source/version/path. Patch owned
leaves in existing source; preserve unrelated comments/sections and promotion.remote.
Capabilities, standalone flows, flow roles and imports remain source-owned.
Runtime policies, Brain settings, queues, memberships, secrets and runner catalog
material remain DB/platform-only. Do not reconstruct lossy capability projections.

Local package export supports only verified resolvable sources matching the
attached immutable revision. Studio cuts currently store a deleted temporary
source directory: explicitly refuse export of that coordinate while preserving
runtime attachment/execution. Stable Studio locators and cross-instance local
package publication are outside this delivery. No omitted or guessed pins.

## Acceptance and implementation discipline

Every original behavior has CPC-01…CPC-12 acceptance and every edge group has a
primary integration/browser owner. Specifications precede each production slice;
actual causal RED, GREEN and refactor evidence precedes task completion. Schema
parser validation and test-title existence do not establish behavioral acceptance.
No skip, relaxed assertion or partial suite qualifies as full green.

## Upgrade boundary

Drain/stop old web writers, apply the main migration, start the new binary.
Mixed-version rolling repository writes are unsupported. Existing boot guards
check both main and Brain lineages before recovery. No migration modifies Brain.
No push, merge or deployment is implied by local implementation commits.

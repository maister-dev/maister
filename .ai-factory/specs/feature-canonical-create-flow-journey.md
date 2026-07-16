# Canonical Studio Create Flow Journey

> **Status: Designed.** This specification becomes Implemented only after the
> code, contract, documentation, and acceptance tests named below are green.

## Product contract

Studio is the only authoring route for a new launchable/pinnable Flow. A member
can create a package and its first Flow in one dialog from Studio Packages or
Local Packages, then add any additional Flow to an editable local package from
the package home. Both operations open the created
`flows/<flow-id>/flow.yaml` in the existing local-package editor.

The dialog requires package name in new-package mode, Flow ID, display title,
`metadata.summary`, and `metadata.route_when`. Labels, links, and sources are
optional. All user-visible copy calls these values **Flow metadata**, never
frontmatter.

Creation produces package manifest membership and a graph-valid Flow manifest:

```yaml
schemaVersion: 1
name: <flow-id>
metadata:
  title: <display-title>
  summary: <summary>
  route_when: <route-when>
compat:
  engine_min: "3.0.0"
capabilities: []
artifacts: []
nodes:
  - id: start
    type: ai_coding
    action:
      prompt: "Describe the task."
    transitions:
      success: done
```

`done` is the current graph engine's implicit terminal target. The feature does
not change the Flow DSL, engine version, local version naming, or package
installer. Initial package creation makes a clean Git commit; adding a Flow is
deliberately uncommitted until the existing Commit action. Cut remains
content-addressed `local-<digest>`; project Attach/Repoint and launch reuse the
existing immutable install path.

## Durable operation and recovery contract

`local_packages.creation_state` is a nullable, server-only JSONB operation
claim. It is not a Flow record and contains only operation ID, operation kind,
phase, Flow ID, and original/expected hashes. It never contains package bytes,
paths, names, request data, or backups. A private journal/backups directory
holds the filesystem-only recovery material outside package export and Git.

The create-package operation claims its database row before staging, validates
the complete in-memory files, stages and commits both files, verifies the final
rename, then clears the claim. The add-Flow operation obtains the edit lock and
mutation lease, claims its state with compare-and-set, writes/validates both
files atomically, and clears the claim.

Recovery is deterministic: it can finalize exact hashes, clear an exact prior
or compensated state, or surface `recovery_required`. It never guesses,
overwrites drift, or runs package code. A recovery-required package remains
visible, read-safe, and non-editable; Commit, Cut, archive, and delete are
blocked. Existing immutable cuts remain attachable because attachment never
reads the working tree.

`POST /api/studio/local-packages/{id}/creation-recovery` has no body and only
retries deterministic reconciliation. It does not accept a repair payload or
cross-resource ID. A non-empty body is a 422. Hash drift remains a localized
409 `PRECONDITION` with operator repair guidance.

Every writer uses this lock order: authorization/edit lock, mutation lease,
reload package state, mutate/validate, release in `finally`. Add Flow refuses
while an active local-package assistant could write the same working directory.

## HTTP identity contract

| Endpoint | Trusted identifiers |
| --- | --- |
| `POST /api/studio/local-packages` | Auth supplies the creator. Body supplies only `{name, flow}`. Server derives package UUID, slug, operation ID, branch, and filesystem paths. |
| `POST /api/studio/local-packages/{id}/flows` | URL `{id}` resolves the package. Auth supplies user. Body supplies only the lock capability `sessionId` and Flow data. |
| `POST /api/studio/local-packages/{id}/creation-recovery` | URL `{id}` resolves the package and durable operation. Auth supplies user. No body is accepted. |

No request accepts a project ID, package ID, path, version, attachment, working
directory, or journal locator redundantly. Responses omit working directories,
journals, and package content.

## Compatibility and legacy authored Flows

Existing empty local packages remain supported and cuttable/attachable. Studio
shows a localized No Flow Yet state and Add Flow action rather than silently
stranding them. Only the public scratch-package create route requires a Flow;
internal default/fork package plumbing may still create an intentionally empty
package.

`/flows/new` redirects to Studio. Its historical authored-catalog draft path
is not a launchable local package. Current code is authoritative: the authored
page action publishes catalog state only, whereas the separate REST
`publish-local` route invokes the executable bridge. The legacy authored-detail
surface remains catalog-only and links users to Studio for launchable Flows.

## Safety and observability

Creation never runs `setup.sh`, hooks, MCPs, installers, Flow nodes, or other
package code. Git initialization/commit uses `--no-verify`. Structured operation
logs contain only `operationId`, `localPackageId`, `flowId`, and phase/outcome;
they never contain names, paths, YAML, form values, Git output, or package bytes.

## Acceptance evidence

- Create package + Flow and add any further Flow through the same dialog.
- Validate required/optional metadata, duplicate IDs/paths, RBAC, stale/foreign
  locks, assistant conflicts, and recovery states before filesystem work.
- Prove every crash boundary recovers only hash-proven states and never executes
  package code.
- Prove Commit -> `local-<digest>` Cut -> Attach/Repoint -> graph-only all-CLI
  launch with terminal run/node-attempt evidence.
- Prove EN/RU key parity and OpenAPI/database/system-analytics/screen contract
  consistency.

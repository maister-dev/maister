# Project Settings → Git

- **Type:** section of project Settings.
- **Route:** `/projects/{slug}?tab=settings`.
- **Status:** Implemented.
- **Source:** `settings-panel.tsx`, `project-git-settings-control.tsx` and shared
  `components/projects/config-persist-control.tsx` / `config-persist-dialog.tsx`.

## Roles and entry points

Owners/admins and global admins manage Git settings. Configuration review,
confirmation, receipts, recovery and push also require `readRepoFiles`; server
permissions are authoritative. Scalar status requires `readBoard` and exposes
no diff or repository path.

The action is permanent for new and existing manifests. A dismissible detail
banner uses the same dialog; dismissal never removes Settings access. Portfolio
cards show unverified status without scanning repositories. Detail checks run
on access, focus, manual refresh and export-revision changes, without polling.
An open banner dialog owns its controller independently of banner visibility.
An in-sync result or status-read failure cannot dismiss its receipt, push review
or busy action; its opener remains available through explicit close.

## Configuration review

Export state (unverified, missing, pending, in sync or blocked) is separate from
repository readiness. A timestamp identifies the fresh Git observation. Applied
package and runner settings remain usable before saving.

Preview shows the full maister.yaml diff, branch, exact commit message and
conditional default-author notice. Confirmation creates a dedicated local
commit. A no-op explains why no commit is needed. Stale or expired reviews
require a new preview and confirmation. Comments and unrelated source sections
are preserved.

Cancel before confirmation has no repository effect. Busy confirmation blocks
duplicate submit, Escape, backdrop and cancel. Focus remains within the dialog
and returns to its opener. The client records operation identity before POST;
reload after a lost response reads that receipt. Explicit recovery inspects the
same accepted operation instead of creating another commit.

After local success, separate push review shows origin URL, destination,
recorded SHA, remote base and every outgoing commit. Its own confirmation
requests push. Failure or uncertainty preserves the local success receipt.
Known failure permits fresh push review; uncertainty requires inspection before
another push. Fresh local configuration review remains available independently.

## Other Git settings

Remotes list credential-redacted URLs. Existing add/edit/remove modals update
origin metadata. Generic remote push/fetch retains its contract; configuration
publication uses the separately reviewed recorded SHA.

Branch-sync defaults select rebase/merge and an optional resolver runner through
the aggregate settings PATCH. They remain DB-only; see
[branch sync](../../system-analytics/branch-sync.md).

## Contracts and copy

[OpenAPI](../../api/web.openapi.yaml) owns methods, strict bodies, permissions,
reasons and receipts. [Persistence analytics](../../system-analytics/project-config-persistence.md)
owns concurrency and crash recovery; [Git integration](../../system-analytics/git-integration.md)
owns generic remotes. EN/RU copy uses `projects.configPersistence`, remote strings
and localized guard feedback. Raw server errors never become user feedback.

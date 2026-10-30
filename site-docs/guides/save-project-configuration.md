---
title: "Save project configuration to Git"
description: "Review and commit MAIster configuration separately from applying runtime settings, then optionally publish the recorded commit."
---

## Prerequisites

- Project owner or administrator access, including permission to read repository files
- The configured main branch checked out on the MAIster host
- A clean checkout and index, with no unfinished Git operation
- Portable package sources that still resolve to their installed revisions

Attaching, detaching, upgrading or downgrading packages applies configuration in
MAIster. Changing the default runner also applies immediately. These actions
leave tracked repository files unchanged. New Runs use the selected runtime
configuration; existing Runs retain their pinned revisions.

## Review and commit

1. Open **Project → Settings → Git → Configuration in Git**.
2. Refresh status. MAIster compares exportable runtime values with the manifest
   committed on the configured main branch. A portfolio label saying
   **unverified** requires this fresh check.
3. Choose **Review configuration save**. Inspect the entire `maister.yaml` diff,
   target branch and exact commit message. Check the author notice if Git
   identity is incomplete.
4. Confirm **Commit reviewed configuration** to create one local commit.
5. Read the result and recorded commit SHA. The same action remains available
   for later changes, including projects that already have a manifest.

Cancel leaves the repository untouched. If the exported values already match
Git, MAIster reports that no change is needed and creates no empty commit.
Comments and unrelated manifest content are preserved.

The export includes project name, branch defaults, default runner, promotion
mode and package pins. Queue, Brain, synchronization policies and source-only
Flow/capability settings have separate ownership. Saving this projection does
not export every runtime setting or replace unrelated manifest sections.

## Publish separately

After a successful local commit, choose **Review push of this commit**. Review
the recorded SHA, origin URL, destination branch, remote base and complete
outgoing commit list before confirming **Push reviewed commits**. No push occurs
as part of the local save. This operation never force-pushes.

A rejected push leaves the local commit saved. Resolve the remote access or
hook problem, then create a fresh push review. An unknown push outcome must be
inspected through the same operation before another push is attempted. It does
not block a later local configuration save: choose **Review local configuration again**
to review that change while retaining the earlier push receipt.

## Resolve a blocked or interrupted save

- **Local or staged changes:** inspect and commit or move them manually. This
  includes an untracked `maister.yaml` left by an older registration flow.
  MAIster does not stash, discard or commit unrelated work.
- **Stale or expired review:** create a fresh preview and review its new diff
  before confirming. Changes to runtime configuration, Git state or access can
  invalidate the previous review.
- **Commit failure:** inspect hooks, author identity and signing policy, fix
  the cause and review again.
- **Lost response or interrupted operation:** reopen Settings and inspect the
  operation receipt. Use **Inspect and recover this operation** when offered.
  Keep its operation ID; avoid creating another save to guess the outcome.
- **Retained private output or unknown locks:** preserve the files and ask the
  host operator to inspect the reported operation before recovery or cleanup.

An export refusal does not detach packages or revert the applied runtime
configuration. A completed local commit remains saved even when publication or
receipt recovery needs attention.

See [Project manifest](/reference/project-manifest) for source-owned sections
and [Register a project](/guides/register-a-project) for initial setup.

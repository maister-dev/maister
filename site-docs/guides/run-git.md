---
title: "Manage a Run's Git worktree"
description: "Commit, preserve or discard changes, publish a branch, update it, open a pull request, and restore a removed worktree."
---

Open the Git panel from the Run's actions. It works on Flow, platform-agent,
and scratch workspaces when no agent is writing to them. Publishing a branch
or opening a pull request leaves the Run's status unchanged.

## Prerequisites

- Project `member` access or higher.
- A Run in **Review**, **Crashed**, **Failed**, **Done**, or **Abandoned** with
  an available worktree and no conflicting operation.
- In **Human working**, only the owner of an open rework claim can operate the
  worktree; finalization, archive, and drop remain unavailable during the claim.
- For publication, Git push credentials and a configured remote. For a pull
  request, provider authentication and publication to `origin` are also required.

Each disabled action explains its precondition. A stopped or failed Run may
still contain useful work; inspect its diff before choosing what to preserve.

## 1. Commit or discard local changes

The **Tree** section shows tracked and untracked changes. **Commit** records a
snapshot. **Discard** first saves a rescue snapshot, then resets the working
tree and removes untracked files. Its result supplies the rescue reference and
a copyable restore command. If staged content differed from the working tree,
the rescue reference's second parent preserves that staged version.

Commit or discard before updating the branch or opening a PR. Rescue references
survive archive and drop, but do not replace a remote backup.

## 2. Publish a branch

Choose a remote and inspect the public branch name. The default project template
is `feature/{task_key}-{slug}`; the internal Run branch keeps its original name.
An existing upstream or recorded publication fixes the public name.

A successful publish records the remote and branch and supplies checkout
commands. If the push would replace remote history, MAIster shows the affected
reference and remote commit before offering a confirmed retry. A newer remote
commit requires a new confirmation.

## 3. Update from another branch

In **Update**, choose the Run's base, target, or published branch, then select
rebase or merge. Inspect the push option: it defaults on for a published branch.
When remote-only commits would be lost, bring in the published branch first or
explicitly confirm replacement of the displayed remote head.

A mechanical conflict restores the pre-update state and lists affected files.
An AI resolver is offered only in **Review**. Update is unavailable for scratch
Runs, orchestrator children, shared worktrees, launched evaluation participants,
and already-promoted Runs. Other eligible Git actions remain independent.

Review and regenerate affected evidence after changing the branch.

## 4. Open a pull request and finalize

After publishing, open **PR**, enter the title, description, target branch, and
draft choice. The worktree must be clean and its HEAD must match the published
head on `origin`. Scratch Runs retain their locked target. An existing open PR
for the same head and target is returned without changing its title or draft
state. Draft handling depends on the provider; verify the resulting PR there.

**Finalize** marks the Run **Done**; it does not mean the provider merged the PR.
From **Review**, normal readiness and target-drift checks apply. From
**Crashed**, **Failed**, or **Abandoned**, finalization requires explicit
confirmation and does not assert that readiness checks passed.

Finalization checks the recorded PR's actual head. A closed PR is refused; a
merged PR missing later local commits requires a new PR for those commits.

## 5. Restore a removed worktree

When the worktree is missing, **Reattach** replaces the other panel sections.
MAIster tries the local Run branch, the published branch, then the archive
reference. Restoration preserves Run identity and does not resume the agent.
If no source remains or the destination is occupied by another directory, the
action reports a refusal. Eligible terminal worktrees receive a fresh cleanup
window after restoration.

Cleanup also preserves staged content that a working-tree snapshot would
overwrite. Reattach restores the working tree, not that separately saved index;
see [recover staged work after cleanup](/operations/troubleshooting#recover-staged-work-after-worktree-cleanup).

Archive and drop confirmations show work not present on a remote and can publish
it before removal. Verify publication succeeded before relying on a remote copy.

## Related guides

- [Review and promote](/guides/review-and-promote)
- [Review, rework, and human takeover](/guides/review-rework-and-takeover)
- [Run history and Run workspace](/product-tour/run-history-and-workbench)

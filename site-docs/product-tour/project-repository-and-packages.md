---
title: "Repository and project packages"
description: "Browse project source, attach installed packages, and use local package cuts without changing an immutable upstream revision."
---

The **Repository** and **Packages** tabs connect project source code to the
versioned processes that work on it. Project members can inspect both. Project
admins manage package attachments; global admins grant trust to executable
package revisions.

## Browse the repository

![Project repository browser](/assets/screens/en/project-repository.png)

Open **Project → Repository**. The file tree shows git-tracked files from the
registered repository. Select a file to read its contents and use the branch
controls to inspect the intended revision.

MAIster keeps this browser read-only. A Run writes through its isolated
workspace, while a reviewer inspects Run-scoped changes in the Diff view. Files
that git ignores and untracked files do not appear in the project browser.

If the tab cannot read the repository, check the repository path and the
project member's `readRepoFiles` permission. The browser never accepts a host
path from the URL.

## Attach a package to the project

![Packages attached to a project](/assets/screens/en/project-packages.png)

1. Open **Flow Studio → Sources** and refresh the source that contains the
   package.
2. Install the required package version. Installation records an immutable
   revision; it does not execute package code.
3. Return to **Project → Packages** and choose **Attach package**.
4. Select the installed package and revision. Inspect its Flow, agent, skill,
   MCP, restriction, schema, and script inventory.
5. Ask a global administrator to trust the revision before the project runs
   executable content from it.
6. Resolve runner slots and MCP requirements in the project tabs.

An attachment makes the package available to one project. It does not change
attachments in other projects. MAIster writes the selected package pin back to
`maister.yaml`; a write-back warning means the database attachment succeeded
but the repository file still needs attention.

## Use a forked local package

Installed revisions stay immutable. To change one:

1. Open its package page in Flow Studio and choose **Fork to edit**.
2. Change the local package in the Studio editor, review the diff, and commit.
3. Create a **cut** from that commit. The cut is another immutable installation.
4. Attach the cut in **Project → Packages** and grant trust after inspection.

The local package retains its upstream lineage. **Compare with upstream** shows
the divergence; **Update fork from upstream** performs a three-way merge. The
editor leaves conflicts for you to resolve and does not force-overwrite local
history.

Package names identify attachments. Rename the local package before cutting it
when you need the upstream package and the fork attached at the same time.

## What a Run records

A new Run pins the effective package revision and Flow revision. Later package
updates do not rewrite the Run's graph, agent instructions, evidence, or result
history. Detaching a package is blocked while a live Run still depends on its
revision.

## Related pages

- [Package sources and versions](/guides/package-sources-and-versions)
- [Flow Studio and package forks](/studio/flow-studio-and-packages)
- [AI assistant in Flow Studio](/studio/ai-assistant)
- [Project platform agents](/administration/project-platform-agents)
- [Project manifest](/reference/project-manifest)

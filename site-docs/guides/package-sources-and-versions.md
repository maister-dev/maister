---
title: "Package sources and versions"
description: "Register your own Flow package repository, install tagged versions, trust and attach them, upgrade or roll back per project, and iterate on a local fork."
---

A package source is a git repository, or a directory on the MAIster host, that
MAIster scans for Flow packages. A project never runs a package at the head of
a branch: it pins one installed version, and every Run records the exact
revision it started with. This page walks the whole loop from your own
repository to a project pin and back.

## Prerequisites

- Global administrator role to register sources, install revisions, and grant
  trust.
- Project administrator rights to attach, upgrade, roll back, or detach
  packages in a project.
- For a git source: the MAIster host can clone the repository with its own
  credentials (an SSH key, a credential helper, or an authenticated `gh` or
  `glab`). MAIster never asks for repository credentials in the UI.
- For publishing a fork back as a pull request: the provider CLI (`gh` or
  `glab`) and a host token such as `GH_TOKEN` or `GITLAB_TOKEN` in the web
  process environment. Without them MAIster pushes the branch and shows a
  compare link instead.

## Lay out a package repository

MAIster discovers packages by scanning `packages/*/maister-package.yaml` on the
source's default branch. Each package directory is self-contained:

```text
packages/
  my-flows/
    maister-package.yaml      # package manifest
    flows/feature/flow.yaml   # one directory per Flow
    flows/bugfix/flow.yaml
    capability/               # optional skills/ and agents/ bundle
    schemas/                  # optional JSON schemas for forms and results
    README.md
```

A minimal manifest:

```yaml
schemaVersion: 1
name: my-flows
metadata:
  title: "My delivery flows"
  summary: "Feature and bugfix Flows for our repositories."
flows:
  - { id: my-feature, path: flows/feature }
  - { id: my-bugfix, path: flows/bugfix }
capabilities: []
mcps: []
restrictions: []
```

Rules that fail installation when broken:

- `name` is the package name; version tags start with it.
- Every `flows[].id` equals the `name` inside that Flow's `flow.yaml`.
- Paths are relative and stay inside the package directory.
- MCP templates in `mcps[]` carry `env:NAME` references only, never secret
  values.
- The manifest has no version field. The git tag is the only version.

One repository can hold many packages; the built-in `maister-plugins`
repository is laid out this way. A repository with a single manifest at its
root is discovered only when registered as a local directory source (see
below). The Flow manifest format is described in the
[Flow manifest reference](/reference/flow-manifest).

## Version with git tags

- Tag each release as `<name>/vX.Y.Z`, for example `my-flows/v1.0.0`. Packages
  in one repository are tagged and released independently.
- MAIster reads the manifest from the default branch, so a package must be
  merged there to be discovered. The tag list decides which versions can be
  installed.
- Installing resolves the tag to a commit. The installed revision is immutable:
  moving or deleting the tag later changes nothing that is already installed,
  and a Run keeps the revision it started with.
- A Flow declares the minimum engine it needs in `compat.engine_min`. A
  revision outside the host's engine range stays inspectable but cannot be
  enabled or launched.

Release a version:

```bash
git tag my-flows/v1.1.0
git push origin my-flows/v1.1.0
```

Then refresh the source in MAIster so the new version appears.

## Register the source

1. Open **Settings → Package sources**. The same panel is available from
   **Flow Studio → Sources**.
2. Choose **Add package source**.
3. Fill in the form:

   | Field | Value |
   | --- | --- |
   | **Source kind** | `git` for a repository, `local` for a directory on the MAIster host |
   | Source | The clone URL, in the form the host can clone (HTTPS or SSH), or the absolute directory path for a local source |
   | **Publish base branch** | Optional. The branch that pull requests from published forks target. Empty means the remote default branch |
   | Note | Optional free text |
   | **Enabled** | A disabled source is neither refreshed nor offered for installation |

4. Choose **Refresh**. MAIster lists the repository tags and scans
   `packages/*` on the default branch. Discovered packages appear under the
   source with their installable versions.

A source refreshes automatically at web start when its snapshot is older than
`MAISTER_PACKAGE_DISCOVERY_STALE_HOURS` (24 hours by default). After pushing a
new tag, refresh by hand.

The built-in source `https://github.com/maister-dev/maister-plugins` is
registered on first start and marked **Built-in**. You can disable or delete
it. `MAISTER_DEFAULT_PACKAGE_SOURCES` sets the sources an installation
registers on start; an empty value registers none.

### Local directory sources

A `local` source points at an absolute path on the MAIster host that holds
either `maister-package.yaml` at its root or a `packages/*` layout. It has no
tags: the version of each package is a digest of its current content, shown as
`local-<digest>`. **Refresh** re-reads the directory and marks attachments
whose content changed as having an update available. Local sources are trusted
by policy because only a global administrator can register them. Use one for
fast iteration on a checkout; use a git source and tags for anything shared.

## Install a version

1. In the source's package list, choose the version and **install**.
2. MAIster clones the tag, validates the package manifest and every member
   Flow, records the resolved commit, and stores the bundle. Nothing from the
   package executes at this point: `setup.sh` and MCP commands run only after
   trust.
3. The revision appears under **Installed package revisions**. One tag installs
   once and is shared by every project that attaches it.

Failure signals:

- Manifest error (invalid schema, a Flow id that does not match its `flow.yaml`
  name, an unsafe path, a bad `env:` reference): nothing is installed. Fix the
  package and push a new tag.
- Clone failure: check the URL, the host credentials, and that the tag exists
  on the remote.
- Engine incompatibility: the revision is stored and inspectable but cannot be
  enabled or launched. Publish a version whose engine range includes this
  MAIster.

## Trust a revision

Trust has two parts. Logic trust decides whether a revision's Flows may launch
at all. Executable trust decides whether its `setup.sh` scripts and MCP
commands may run on the host.

| State | Meaning |
| --- | --- |
| **Untrusted** | The default for any git source. Launches, `setup.sh`, and MCP commands from the revision are refused. |
| **Trusted by policy** | Logic trust granted automatically: local sources, Studio cuts, and git sources whose URL starts with a prefix listed in `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES`. Executable content still needs the explicit confirmation. |
| **Trusted** | Confirmed by a global administrator in **Trust review**. |

To trust a revision, open **Trust review** on it, inspect the inventory
(Flows, agents, skills, MCP templates, scripts, and `setup.sh`), and confirm.
The decision applies to every project attached to that revision, and the
dialog shows how many projects that is. After confirmation MAIster runs each
member Flow's `setup.sh`; a failing script marks the revision as failed, and
launches are refused until a fixed version is installed.

Trust is granted per revision. A new version needs its own review, even from
the same source. Keep `MAISTER_TRUSTED_FLOW_SOURCE_PREFIXES` for repositories
you control.

## Attach to a project and pin

1. Open **Project → Packages** and choose **Attach**.
2. Pick the installed revision. The dialog shows its inventory: Flows, agents,
   skills, MCP requirements, restrictions, schemas, and scripts.
3. Confirm. The attachment adds the package's Flows to the project and writes
   the pin into the repository's `maister.yaml`:

   ```yaml
   packages:
     - id: my-flows
       source: https://github.com/example/maister-packages
       version: my-flows/v1.1.0
       path: packages/my-flows
   ```

4. Once the revision is trusted, **Enable** makes it the version new launches
   use. A revision trusted by policy is enabled right away.
5. Bind runner slots and MCP requirements in the project tabs before launching
   a task.

The pin belongs to one project. Other projects keep their own pins on the same
or another version, and one installed revision serves all of them. When a
repository is registered with `packages[]` already in its `maister.yaml`,
MAIster installs and attaches those versions during registration, so a project
can be recreated on another installation from git alone.

A write-back warning means the attachment is saved but `maister.yaml` could
not be updated; edit the pin by hand. Attaching fails when a package Flow id
collides with a standalone `flows[]` entry, or when an MCP or restriction id is
already provided by another attached package.

## Upgrade, roll back, and switch versions

- When a newer tag for an attached package is discovered, the attachment shows
  an available update. Choose **Upgrade** to open **Upgrade preview**: added,
  removed, and changed Flows, agents, skills, and MCP templates, with warnings
  such as "will stop working here" for an agent this project has attached.
  Confirm to move the project to the new revision. Runs already in flight keep
  their pinned revision; only new launches change.
- **Roll back** lists the installed revisions together with their active Run
  references. Choosing one moves the project's enabled revision back; the newer
  revision stays installed.
- Projects are independent. Two projects can stay on different versions
  indefinitely, and moving one project never affects the other. To align a
  project with a version another project uses, upgrade or roll back to that
  revision in the project itself.
- Detaching a package is refused while a live Run still depends on its
  revision.

## Iterate on a local version

Installed revisions are immutable, so changes go through a local package in
Flow Studio:

1. Open the installed package in Flow Studio and choose **Fork to edit**.
   MAIster copies the revision into a local package named `<name>-local` and
   keeps the lineage to the source revision. **Customize** creates a fresh copy
   when a fork already exists; **New local package** starts from scratch.
2. Edit in the Studio editor and commit. Commit validates the changed Flows,
   manifest, agents, skills, and schemas and refuses invalid content.
3. Choose **Cut version**. The cut installs as an immutable revision labelled
   `local-<digest>`. The dialog can advance projects already attached to a cut
   of this package; by default it advances none.
4. Attach the cut in **Project → Packages** like any other revision (it carries
   a *local cut* badge) and confirm executable trust.

If the fork keeps the upstream package name, it cannot be attached beside the
upstream in the same project. Rename it in the manifest, commit, and cut again.

### Choose a version at launch

When the project pins a package that has a newer cut, or the local package has
edits that are not cut yet, the launch dialog offers a choice:

| Option | Effect |
| --- | --- |
| **Keep pinned version** | Launch on the current pin. |
| **Adopt newer version** | Move the project pin to the newest cut, then launch. |
| **Try newer once** | Run this launch on the newest cut and leave the project pin unchanged. |
| **Cut latest & adopt** | Cut the current Studio state, move the pin to it, then launch. Refused while the editor lock is held or the content is invalid. |

### Keep a fork in sync with upstream

**Compare with upstream** shows the file-level divergence between the fork and
its source revision. When the upstream releases a new tag, choose **Sync from
upstream**, pick the version, and confirm **Install & sync**. MAIster installs
the tag and runs a three-way merge between the fork base, your changes, and the
new revision. Conflicting files are listed for resolution in the editor; finish
the sync from the banner, or abort to reset the working tree to the last
commit. MAIster never overwrites the fork's history.

### Publish a fork back to the source

Choose **Publish** in the local package editor, pick the **Target source**
(only registered git sources are offered), and confirm. MAIster pushes the
committed state to a branch named `maister/<package>` and, when the provider
CLI and token are available, opens or updates a pull request against the
source's publish base branch; otherwise it shows the branch and a compare link.
If the remote branch advanced past your fork, publishing stops with
**Upstream moved — sync first**: sync from upstream, resolve conflicts, and
publish again. Publishing never force-pushes.

## Failure signals

- Refresh degraded: MAIster shows the last snapshot. Check the URL, the host
  credentials, and that `packages/*` exists on the default branch.
- Version not listed: the tag is missing on the remote or does not start with
  the package name from the manifest. Push the tag and refresh.
- Launch refused for trust: the revision is untrusted or its `setup.sh` failed.
  Review and trust it, or install a fixed version.
- Attach refused: a Flow, MCP, or restriction id collides with content already
  attached to the project.
- Detach refused: a live Run still uses the revision. Wait for it to finish or
  abandon it.
- Publish refused: the target is not a registered git source, the branch name
  is invalid, or the upstream branch moved.

## Related pages

- [Repository and project packages](/product-tour/project-repository-and-packages)
- [Flow Studio and package forks](/studio/flow-studio-and-packages)
- [Project manifest reference](/reference/project-manifest)
- [Flow manifest reference](/reference/flow-manifest)

---
title: "Flow Studio and package forks"
description: "Browse sources and installed packages, fork immutable content, edit a local package, use the AI assistant, and publish a cut."
---

Flow Studio is the authoring workspace for portable delivery processes and
their supporting artifacts. A package can carry Flows, skills, platform agents,
subagents, MCP requirements, schemas, rules, scripts, and evaluation methods.

## Prerequisites

- An active MAIster account.
- Project catalog-management permission for project-scoped authoring actions.
- A Ready ACP runner if you want to use the AI authoring assistant.

![Flow Studio with sources, installed packages, and local packages](/assets/screens/en/flow-studio.png)

## Understand the three package states

| State | Meaning |
| --- | --- |
| Source | A registered upstream repository from which MAIster discovers package versions. |
| Installed package | A pinned, immutable revision that can be inspected, trusted, and attached to projects. |
| Local package | An editable git working copy owned by this MAIster installation. |

Installed content is never edited in place. Choose **Fork to edit** on a whole
package or supported element. MAIster copies the selected content into a new
local package and preserves lineage to the source revision.

## Work with a local package

![Flow graph and package file editors in a local package](/assets/screens/en/flow-editor.png)

The editor combines several views over the same draft:

- a graph canvas for nodes and outcome transitions;
- typed node, gate, decision, and runner controls;
- `flow.yaml` with completion and live graph regeneration;
- a package tree with forms for known frontmatter;
- editors for skills, agents, rules, scripts, and schemas;
- validation issues and the git diff of the local working copy.

Canvas changes and YAML changes share one manifest state. If YAML becomes
invalid, the editor keeps the last valid graph visible and reports the error.
Saving validates the graph, references, paths, schema files, and required
frontmatter before updating the draft.

## Use the AI authoring assistant

[Open the AI assistant beside a local Flow](/studio/ai-assistant) to ask about
the package or request a guarded edit. The short version of its safety model is
below.

Open the assistant drawer from a local package. It can answer questions about
the current package or propose a bounded edit.

The assistant receives a server-built snapshot of the package inventory,
hashes, Flow graph, and current editor focus. Its ACP workspace is read-only.
For an edit, it returns a structured action that names paths, base hashes, and
new content. MAIster validates the complete action and applies it atomically.

This boundary matters:

- the assistant cannot write package files directly;
- a stale base hash rejects the whole action instead of overwriting a newer edit;
- unsafe paths, invalid YAML, invalid frontmatter, invalid schemas, or an
  uncompilable graph are rejected before any file changes;
- the resulting diff remains visible for human review and normal git history.

Use the assistant for focused operations such as adding a node, changing a
runner slot, creating a result schema, or explaining a package reference. Split
broad redesigns into several reviewable turns.

## Save, commit, cut, and attach

1. Save a valid draft.
2. Review the package diff.
3. Commit the local package.
4. Create an immutable cut from the selected commit.
5. Attach that cut from **Project → Packages**.
6. Review executable content and explicitly trust the installed revision.
7. Bind its runner slots and MCP requirements before launching a task.

A cut, Flow definition, skill, and platform-agent instruction can move between
projects and MAIster installations. Installation-specific runner IDs, secrets,
and project bindings stay outside the portable package.

## Compare and synchronize a fork

For a local package with upstream lineage, **Compare with upstream** shows the
file-level divergence from the selected source revision. Synchronization uses a
three-way merge between the fork base, current local content, and the new
upstream revision. Resolve conflicts in the local package, validate, and commit
the result. MAIster never force-overwrites fork history.

Publishing a local package back to a registered source creates a normal branch
and pull request when the source host is configured. It does not mutate the
upstream default branch directly.

## Failure signals

- Save refused: fix blocking graph, YAML, schema, path, or frontmatter errors.
- Installed bundle unavailable: metadata and stored graph may remain visible,
  but fork and file inspection require the package bytes on the host.
- Assistant action stale: refresh package context and ask again; another edit
  changed one of its base hashes.
- Executable content untrusted: inspect the cut and grant trust explicitly.
- Attachment collision: rename the fork's package, commit, and create a new cut.

## Next steps

- Choose [Flow node types](/studio/node-types).
- Use the [AI assistant in Flow Studio](/studio/ai-assistant).
- Pass data with [structured results and Run context](/studio/structured-results-and-context).
- Configure [MCP bindings](/administration/mcp-and-secrets).
- Compare process outcomes in [Evaluation Lab](/evaluation/run-comparison).

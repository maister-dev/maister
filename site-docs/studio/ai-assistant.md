---
title: "AI assistant in Flow Studio"
description: "Open the assistant beside a local Flow, ask about the package, and apply guarded edits without giving the session direct write access."
---

The Flow Studio assistant works inside an editable local package. It can explain
the selected Flow, inspect related package files, and propose changes through a
validated action.

## Open the assistant

![AI assistant beside the Flow editor](/assets/screens/en/flow-assistant.png)

1. Open **Flow Studio → Local packages**. Create a package or use **Fork to
   edit** on an installed package.
2. Open a Flow file at `flows/<flow-id>/flow.yaml`. The package home and a
   read-only installed package do not show the Flow assistant.
3. Wait until the editor holds the package edit lock.
4. Click **AI** with the sparkles icon in the editor toolbar. The right-hand
   properties area changes to the assistant drawer. Click the same control or
   the close icon to return to node properties.
5. Select a Ready ACP runner, enter a focused request, and start the turn.

The assistant keeps its conversation mounted when you collapse the drawer. You
can return to node properties without losing the active turn.

## What the assistant receives

MAIster builds the context on the server from the current package inventory,
file hashes, selected Flow graph, and editor focus. Unsaved editor changes are
flushed before the turn starts. The ACP session reads the package through a
restricted workspace.

For a proposed edit, the assistant returns a structured action with file paths,
base hashes, and replacement content. MAIster checks the edit lock, paths,
hashes, YAML, frontmatter, schemas, and compiled graph before writing all files
as one action.

During an assistant turn the human editor becomes read-only. This prevents two
writers from changing the same draft. A stale base hash rejects the action and
keeps the newer human edit.

## Useful requests

- “Add a review node after `verify` and route rework to `implement`.”
- “Create a structured result schema for the planning node and expose it to the
  next node.”
- “Explain why this Flow fails validation without changing files.”
- “Move the low-cost runner to implementation while keeping the stronger model
  for planning and judgment.”

Ask for one reviewable operation per turn. Inspect the resulting canvas and
diff, then use **Commit state**. The assistant never commits or cuts a version
on your behalf.

## If the assistant is unavailable

| Symptom | Check |
| --- | --- |
| AI control is absent | Open a Flow file inside a local package. |
| Runner selector is empty | Configure and validate an ACP runner in Settings. |
| Launch is disabled | Enter a prompt and confirm that your editor owns the package lock. |
| Action was rejected as stale | Reload the package state and ask again against the new hashes. |
| Validation refused the action | Fix the named file, schema, reference, or graph error; MAIster did not apply a partial edit. |

## Related pages

- [Flow Studio and package forks](/studio/flow-studio-and-packages)
- [Flow node types](/studio/node-types)
- [Structured results and Run context](/studio/structured-results-and-context)

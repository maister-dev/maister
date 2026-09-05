# Implementation Plan: Public History and Local Checkout Migration

Branch: codex/public-history-local-migration
Created: 2026-09-05

## Settings

- Testing: yes
- Logging: minimal
- Docs: no

## Roadmap Linkage

Milestone: none
Rationale: This is repository hygiene and local Git-state migration, not a product milestone.

## Decisions

- Keep repository visibility unchanged throughout the work.
- Treat the rewritten remote default branch as the only trusted base for new work.
- Never connect a legacy object database to a cleaned repository through a remote, alternates, bundles, or object copying.
- Transfer uncommitted work as repository-relative patches and selected untracked files only.
- Transfer committed work as patch series, recreate commits with GitHub noreply identities, and rescan every resulting commit.
- Keep independent worksets on separate branches and worktrees so they can be reviewed and integrated independently.
- Exclude generated agent-bundle noise from dirty worksets unless it is a deliberate source change.
- Rewrite the companion plugin repository only when an audit finds sensitive metadata or content; require tree equivalence when the rewrite is metadata-only.
- Preserve the legacy repositories and worktrees as read-only recovery sources until all transplanted work is verified.

## Commit Plan

- **Commit 1** (after tasks 1-2): `chore(repo): align tooling with master branch`
- **Commit 2** (after tasks 5-6, per workset branch): preserve the original logical change boundary with noreply metadata
- **Commit 3** (after task 7): `chore(repo): record completed checkout migration`

## Tasks

### Phase 1: Establish the trusted baseline

- [x] Task 1: Create and verify the fresh canonical clone from the rewritten default branch.
  - Confirm the expected remote URL, default branch, exact starting commit, clean status, and strict object-database integrity.
  - Scan commit messages, paths, reachable text blobs, and contributor metadata for the public-readiness denylist.
  - Acceptance: the clone contains only refs fetched from the cleaned remote and no legacy remote or alternate object store.

- [x] Task 2: Align repository-owned branch configuration with `master`.
  - Update only project-specific operational references: AI Factory base branch, dogfood manifest branch, and supported-versions policy.
  - Leave generic examples and tests that intentionally exercise `main` unchanged.
  - Acceptance: targeted search finds no stale project-specific default-branch reference; lightweight config and documentation validation passes.

<!-- Commit checkpoint: tasks 1-2 -->

### Phase 2: Sanitize and relocate the companion repository

- [x] Task 3: Audit the full reachable companion-repository history and GitHub state.
  - Inspect branches, tags, annotated tag metadata, commit identities, commit and tag messages, paths, text blobs, secret-like values, pull requests, releases, and forks.
  - Classify fixtures and placeholders separately from real sensitive data.
  - Acceptance: every rewrite trigger is explicitly identified before refs are changed.

- [x] Task 4: Rewrite sensitive companion-repository metadata and publish the cleaned refs.
  - Use `git-filter-repo` in a fresh mirror and replace contributor and tagger email metadata with the verified GitHub noreply identity.
  - Preserve commit messages, trees, dates, names, branch topology, tag names, and tag messages.
  - Verify old-tip to new-tip tree equivalence, scan the rewritten mirror, then force-update only the audited branch and tag refs.
  - Create a fresh canonical clone from the rewritten remote in the repository host root.
  - Acceptance: the public remote and fresh clone expose only noreply contributor metadata, all intended tags remain, and strict fsck passes.

### Phase 3: Rebase active work onto the trusted history

- [x] Task 5: Transplant the three dirty worksets into isolated clean worktrees.
  - Documentation workset: transfer tracked edits and intentional untracked public documentation/assets.
  - Task lifecycle workset: transfer only the task-deletion and manual-completion plan/API/UI files; omit generated bundles.
  - Board concurrency workset: transfer tracked board, documentation, translation, and test edits plus its intentional plan file; omit generated bundles.
  - Acceptance: each destination branch is based directly on clean `master`, preserves the source diff intent, has no legacy objects, and passes a privacy scan.

- [x] Task 6: Transplant the two unique committed worksets as patch series.
  - Durable execution-host workset: replay its unique commit sequence in order.
  - Package compatibility workset: replay its single unique commit.
  - Recreate commit author and committer emails with verified GitHub noreply identities while preserving author names, dates, messages, and logical commit boundaries.
  - Acceptance: each destination range is patch-equivalent to its legacy source range apart from deliberate privacy cleanup and conflict resolution.

<!-- Commit checkpoint: tasks 5-6 -->

### Phase 4: Verify and hand off

- [x] Task 7: Run final integrity, privacy, and migration verification.
  - Run strict fsck and ref inventories for both canonical repositories.
  - Rescan all reachable destination branches and tags for prohibited identifiers, personal absolute paths, private contributor emails, and real secrets.
  - Compare every transplanted workset against its source using repository-relative name-status and patch checks.
  - Run the smallest existing validation suite appropriate to each changed workset and report any environment-limited checks explicitly.
  - Keep legacy repositories untouched and identify them as recovery-only until the user approves cleanup.
  - Acceptance: both canonical clones are clean and usable, all selected work is represented on named clean branches/worktrees, and no visibility setting changed.

<!-- Commit checkpoint: task 7 -->

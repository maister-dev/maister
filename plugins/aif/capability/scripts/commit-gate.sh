#!/usr/bin/env bash
# AIF commit gate — used by flow `commit` nodes via a `command_check`.
# Passes (exit 0) only when the worktree is clean AND HEAD is a Conventional
# Commit. Run with the worktree as CWD, after `/aif-commit` has committed.
set -euo pipefail

# 1) No uncommitted tracked changes (the commit must have captured everything).
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "commit-gate: FAIL — uncommitted tracked changes remain after commit" >&2
  exit 1
fi

# 2) HEAD subject follows Conventional Commits.
subject="$(git log -1 --pretty=%s)"
if ! printf '%s' "$subject" | grep -Eq '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+'; then
  echo "commit-gate: FAIL — HEAD subject is not Conventional Commits: ${subject}" >&2
  exit 1
fi

echo "commit-gate: PASS — clean tree, conventional HEAD (${subject})"

import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";
import { WORKBENCH_GIT_ACTION_ORDER } from "@/lib/workbench-git/policy";

// ---------------------------------------------------------------------------
// CONTRACT under test — i18n keys for the ADR-181 run git panel:
//   components/workbench/git-panel.tsx (panel copy under `workbenchGit`)
//   components/workbench/lifecycle-actions.tsx (action labels, ONE set under
//     `workbenchLifecycle.action` — the policy ids are the i18n keys, D16)
//
// Every key must be a non-empty string in BOTH EN and RU.
// ---------------------------------------------------------------------------

type Tree = Record<string, unknown>;

function at(tree: Tree, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Tree)[part] : undefined,
      tree,
    );
}

const DISABLED_REASONS = [
  "live-workbench",
  "human-owned",
  "missing-workspace",
  "removed-workspace",
  "worktree-missing",
  "worktree-present",
  "busy",
  "unsupported-status",
  "unsupported-run",
  "promoted",
  "no-remote",
  "not-published",
  "no-reattach-source",
  "pr-missing",
  "pr-closed",
];

// The service tokens (T0.1's final set), the C19 policy tokens, the push
// rejection, the error codes with copy, and the fallback.
const ERROR_KEYS = [
  "public_name_fixed",
  "public_branch_template_invalid",
  "clean_worktree",
  "dirty_worktree",
  "not_published",
  "published_remote_not_origin",
  "publish_stale",
  "target_branch_unknown",
  "provider_unsupported",
  "agent_requires_review",
  "base_branch_unknown",
  "pr_missing",
  "pr_closed",
  "target_drift",
  "review_only_field",
  "no_reattach_source",
  "worktree_path_occupied",
  "run_not_found",
  ...DISABLED_REASONS.map((r) => r.replace(/-/g, "_")),
  "workspace_git_identity_invalid",
  "workspace_preservation_failed",
  "non_fast_forward",
  "PRECONDITION",
  "CONFLICT",
  "CONFIG",
  "EXECUTOR_UNAVAILABLE",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "CRASH",
  "generic",
];

const PANEL_KEYS = [
  "title",
  "loading",
  "loadFailed",
  "cancel",
  "publicChip",
  "prChip",
  "prState.open",
  "prState.merged",
  "prState.closed",
  "prState.unknown",
  "busy",
  "section.tree",
  "section.publish",
  "section.update",
  "section.pr",
  "section.reattach",
  "section.commands",
  "tree.dirty",
  "tree.clean",
  "commit.message",
  "commit.submit",
  "discard.title",
  "discard.body",
  "discard.confirm",
  "discard.done",
  "publish.remote",
  "publish.name",
  "publish.force",
  "publish.unpushed",
  "publish.done",
  "publish.handoff",
  "update.onto",
  "update.target",
  "update.base",
  "update.published",
  "update.aheadBehind",
  "update.strategy",
  "update.rebase",
  "update.merge",
  "update.push",
  "update.agent",
  "update.runner",
  "update.runnerDefault",
  "update.outcome.noop",
  "update.outcome.synced",
  "update.outcome.conflict",
  "update.outcome.agent_launched",
  "reattach.local",
  "reattach.published",
  "reattach.archive",
  "commands.checkout",
  "commands.unpublished",
  "commands.restoreRescue",
  "commands.copy",
  "hint.commitOrDiscardFirst",
  "hint.cleanTree",
  "done.snapshotCommit",
  "done.discardChanges",
  "done.exportBranch",
  "done.update",
  "done.openPr",
  "done.finalizePr",
  "done.reattach",
  "guard.unpushed",
  "guard.publishThen.archive",
  "guard.publishThen.drop",
  ...DISABLED_REASONS.map((r) => `disabledReason.${r}`),
  ...ERROR_KEYS.map((k) => `errors.${k}`),
];

describe("i18n — the run git panel (ADR-181)", () => {
  it.each([
    ["en", en],
    ["ru", ru],
  ] as const)("%s carries every workbenchGit key", (_lang, messages) => {
    for (const key of PANEL_KEYS) {
      const value = at(messages.workbenchGit as Tree, key);

      expect(typeof value, `workbenchGit.${key}`).toBe("string");
      expect((value as string).length, `workbenchGit.${key}`).toBeGreaterThan(
        0,
      );
    }
  });

  it.each([
    ["en", en],
    ["ru", ru],
  ] as const)("%s labels every policy action id", (_lang, messages) => {
    for (const id of WORKBENCH_GIT_ACTION_ORDER) {
      const value = at(messages.workbenchLifecycle as Tree, `action.${id}`);

      expect(typeof value, `workbenchLifecycle.action.${id}`).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  // T0.6: the RU manual quotes these labels; the catalog must match it.
  it("ships the RU strings the manual names", () => {
    expect(ru.workbenchLifecycle.action.exportBranch).toBe("Опубликовать");
    expect(ru.workbenchLifecycle.action.snapshotCommit).toBe("Коммит");
    expect(ru.workbenchLifecycle.action.discardChanges).toBe(
      "Отменить изменения",
    );
    expect(ru.workbenchLifecycle.action.update).toBe("Обновить");
    expect(ru.workbenchLifecycle.action.openPr).toBe("Открыть PR");
    expect(ru.workbenchLifecycle.action.finalizePr).toBe("Завершить по PR");
    expect(ru.workbenchLifecycle.action.reattach).toBe("Вернуть рабочую копию");
    expect(ru.workbenchGit.title).toBe("Git-панель");
    expect(ru.workbenchGit.section.tree).toBe("Рабочее дерево");
    expect(ru.workbenchGit.section.update).toBe("Обновление");
  });
});

import { describe, expect, it } from "vitest";

import { RUN_STATUS_VALUES } from "@/lib/runs/run-status-values";
import {
  WORKBENCH_GIT_ACTION_ORDER,
  deriveWorkbenchGitActions,
  type WorkbenchGitAction,
  type WorkbenchGitActionId,
  type WorkbenchGitPolicyInput,
} from "@/lib/workbench-git/policy";

// ADR-181 D1 — ONE predicate for every run workbench git action. Inputs are the
// facts the loader assembles; the predicate itself is pure.

const OWNER = "user-owner";
const OTHER = "user-other";

function usableParked(
  over: Partial<WorkbenchGitPolicyInput> = {},
): WorkbenchGitPolicyInput {
  return {
    runKind: "flow",
    runStatus: "Failed",
    scratchDialogStatus: null,
    hasWorkspace: true,
    workspaceRemoved: false,
    claimOwnerUserId: null,
    viewerUserId: null,
    worktreePresent: true,
    busy: false,
    promotionState: "none",
    publishedBranch: null,
    hasRemote: true,
    prUrl: null,
    prState: null,
    updateSupported: true,
    reattachSource: null,
    ...over,
  };
}

function byId(
  actions: WorkbenchGitAction[],
): Record<WorkbenchGitActionId, WorkbenchGitAction> {
  return Object.fromEntries(actions.map((a) => [a.id, a])) as Record<
    WorkbenchGitActionId,
    WorkbenchGitAction
  >;
}

function enabledIds(input: WorkbenchGitPolicyInput): WorkbenchGitActionId[] {
  return deriveWorkbenchGitActions(input)
    .filter((a) => a.enabled)
    .map((a) => a.id);
}

const PARKED = ["Review", "Crashed", "Failed", "Done", "Abandoned"] as const;

describe("ADR-181 D1 — workbench git policy", () => {
  it("returns every action exactly once, in the one shared order, reason null iff enabled", () => {
    for (const runStatus of [...RUN_STATUS_VALUES, "Invented"]) {
      const actions = deriveWorkbenchGitActions(usableParked({ runStatus }));

      expect(actions.map((a) => a.id)).toEqual([...WORKBENCH_GIT_ACTION_ORDER]);
      for (const a of actions) {
        if (a.enabled) expect(a.disabledReason).toBeNull();
        else expect(a.disabledReason).not.toBeNull();
      }
    }
  });

  it.each(PARKED)(
    "admits the tree, publish and update git set on a usable %s worktree",
    (runStatus) => {
      const ids = enabledIds(usableParked({ runStatus }));

      expect(ids).toEqual(
        expect.arrayContaining([
          "archive",
          "drop",
          "exportBranch",
          "snapshotCommit",
          "discardChanges",
          "update",
        ]),
      );
      expect(ids).not.toContain("stop");
      expect(ids).not.toContain("reattach");
    },
  );

  it("gates openPr on a publication and finalizePr on a recorded, non-closed PR", () => {
    const unpublished = byId(deriveWorkbenchGitActions(usableParked()));

    expect(unpublished.openPr.disabledReason).toBe("not-published");
    expect(unpublished.finalizePr.disabledReason).toBe("pr-missing");

    const published = byId(
      deriveWorkbenchGitActions(
        usableParked({ publishedBranch: "feature/ABC-1-x" }),
      ),
    );

    expect(published.openPr.enabled).toBe(true);

    const prOpen = byId(
      deriveWorkbenchGitActions(
        usableParked({
          publishedBranch: "feature/ABC-1-x",
          prUrl: "https://example.test/pr/1",
          prState: null,
        }),
      ),
    );

    expect(prOpen.finalizePr.enabled).toBe(true);

    for (const prState of ["open", "merged"] as const) {
      expect(
        byId(
          deriveWorkbenchGitActions(
            usableParked({ prUrl: "https://example.test/pr/1", prState }),
          ),
        ).finalizePr.enabled,
      ).toBe(true);
    }

    const closed = byId(
      deriveWorkbenchGitActions(
        usableParked({ prUrl: "https://example.test/pr/1", prState: "closed" }),
      ),
    );

    expect(closed.finalizePr).toEqual({
      id: "finalizePr",
      enabled: false,
      disabledReason: "pr-closed",
    });
  });

  // ADR-181 D6 (amendment): finalize is admitted from Review and
  // Crashed | Failed | Abandoned only — a Done run is already finalized.
  it.each([
    ["Review", true],
    ["Crashed", true],
    ["Failed", true],
    ["Abandoned", true],
    ["Done", false],
  ] as const)(
    "finalizePr on %s with an open PR → enabled=%s",
    (runStatus, ok) => {
      const finalize = byId(
        deriveWorkbenchGitActions(
          usableParked({
            runStatus,
            prUrl: "https://example.test/pr/1",
            prState: "open",
          }),
        ),
      ).finalizePr;

      expect(finalize.enabled).toBe(ok);
      if (!ok) expect(finalize.disabledReason).toBe("unsupported-status");
    },
  );

  it("refuses publish and openPr without a remote, but only when the remote list is known", () => {
    const none = byId(
      deriveWorkbenchGitActions(
        usableParked({ hasRemote: false, publishedBranch: "feature/x" }),
      ),
    );

    expect(none.exportBranch.disabledReason).toBe("no-remote");
    expect(none.openPr.disabledReason).toBe("no-remote");
    expect(none.snapshotCommit.enabled).toBe(true);
    expect(none.update.enabled).toBe(true);

    // A card or rail row never probes git: `null` means "not probed", which must
    // not hide a reachable action.
    expect(
      byId(deriveWorkbenchGitActions(usableParked({ hasRemote: null })))
        .exportBranch.enabled,
    ).toBe(true);
  });

  it("refuses update for a run shape sync cannot take, and once a promotion is done or claimed", () => {
    expect(
      byId(deriveWorkbenchGitActions(usableParked({ updateSupported: false })))
        .update.disabledReason,
    ).toBe("unsupported-run");
    expect(
      byId(
        deriveWorkbenchGitActions(
          usableParked({ runStatus: "Done", promotionState: "done" }),
        ),
      ).update.disabledReason,
    ).toBe("promoted");
    // A STALE promotion claim is not `busy` (the loader decided), yet sync's
    // forward fence still refuses `claiming` — the button must not lie.
    expect(
      byId(
        deriveWorkbenchGitActions(usableParked({ promotionState: "claiming" })),
      ).update.disabledReason,
    ).toBe("busy");
    // Scratch runs cannot sync, whatever the caller passed.
    expect(
      byId(
        deriveWorkbenchGitActions(
          usableParked({ runKind: "scratch", updateSupported: undefined }),
        ),
      ).update.disabledReason,
    ).toBe("unsupported-run");
  });

  it("disables everything but stop's static reason while another writer owns the worktree", () => {
    const actions = byId(
      deriveWorkbenchGitActions(usableParked({ busy: true })),
    );

    expect(actions.stop.disabledReason).toBe("unsupported-status");
    for (const id of WORKBENCH_GIT_ACTION_ORDER.filter((i) => i !== "stop")) {
      expect(actions[id]).toEqual({
        id,
        enabled: false,
        disabledReason: "busy",
      });
    }
  });

  it("offers only reattach on a removed row, and names why the rest are gone", () => {
    const removed = deriveWorkbenchGitActions(
      usableParked({ workspaceRemoved: true, worktreePresent: false }),
    );

    expect(removed.filter((a) => a.enabled).map((a) => a.id)).toEqual([
      "reattach",
    ]);
    for (const a of removed.filter((x) => x.id !== "reattach")) {
      expect(a.disabledReason).toBe("removed-workspace");
    }
  });

  it("treats a vanished path on a live row as not usable (worktree-gone)", () => {
    const gone = deriveWorkbenchGitActions(
      usableParked({ runStatus: "Crashed", worktreePresent: false }),
    );

    expect(gone.filter((a) => a.enabled).map((a) => a.id)).toEqual([
      "reattach",
    ]);
    expect(byId(gone).exportBranch.disabledReason).toBe("worktree-missing");
  });

  it("refuses reattach when no source resolves, and on a usable worktree", () => {
    expect(
      byId(
        deriveWorkbenchGitActions(
          usableParked({ workspaceRemoved: true, reattachSource: false }),
        ),
      ).reattach.disabledReason,
    ).toBe("no-reattach-source");
    expect(
      byId(deriveWorkbenchGitActions(usableParked())).reattach.disabledReason,
    ).toBe("worktree-present");
    expect(
      byId(
        deriveWorkbenchGitActions(
          usableParked({ workspaceRemoved: true, busy: true }),
        ),
      ).reattach.disabledReason,
    ).toBe("busy");
  });

  it("refuses everything without a workspace row", () => {
    const actions = deriveWorkbenchGitActions(
      usableParked({ hasWorkspace: false, worktreePresent: null }),
    );

    expect(actions.every((a) => !a.enabled)).toBe(true);
    expect(actions.every((a) => a.disabledReason === "missing-workspace")).toBe(
      true,
    );
  });

  describe("HumanWorking — the ADR-160 carve-out, now the git set", () => {
    const humanWorking = (over: Partial<WorkbenchGitPolicyInput> = {}) =>
      usableParked({
        runStatus: "HumanWorking",
        claimOwnerUserId: OWNER,
        viewerUserId: OWNER,
        publishedBranch: "feature/x",
        prUrl: "https://example.test/pr/1",
        prState: "open",
        ...over,
      });

    it("gives the claim owner the git set and never archive, drop, stop or finalizePr", () => {
      const actions = byId(deriveWorkbenchGitActions(humanWorking()));

      expect(enabledIds(humanWorking())).toEqual([
        "exportBranch",
        "snapshotCommit",
        "discardChanges",
        "update",
        "openPr",
      ]);
      for (const id of ["stop", "archive", "drop", "finalizePr"] as const) {
        expect(actions[id].disabledReason).toBe("human-owned");
      }
    });

    it("lets the owner re-attach a vanished worktree", () => {
      expect(enabledIds(humanWorking({ worktreePresent: false }))).toEqual([
        "reattach",
      ]);
    });

    it.each([
      ["another member", { viewerUserId: OTHER }],
      ["an anonymous viewer", { viewerUserId: null }],
      ["a takeover with no claim owner", { claimOwnerUserId: null }],
      // `undefined === undefined` must never open the carve-out.
      [
        "a caller that omitted both ids",
        { claimOwnerUserId: undefined, viewerUserId: undefined },
      ],
    ])("refuses %s every action", (_label, over) => {
      const actions = deriveWorkbenchGitActions(
        humanWorking(over as Partial<WorkbenchGitPolicyInput>),
      );

      expect(actions.every((a) => !a.enabled)).toBe(true);
      expect(actions.every((a) => a.disabledReason === "human-owned")).toBe(
        true,
      );
    });
  });

  it.each(["Running", "NeedsInput", "NeedsInputIdle"] as const)(
    "a live %s run offers stop only",
    (runStatus) => {
      const actions = byId(
        deriveWorkbenchGitActions(usableParked({ runStatus })),
      );

      expect(enabledIds(usableParked({ runStatus }))).toEqual(["stop"]);
      expect(actions.exportBranch.disabledReason).toBe("live-workbench");
    },
  );

  it.each(["Pending", "WaitingOnChildren"] as const)(
    "a live but unstoppable %s run offers nothing",
    (runStatus) => {
      expect(enabledIds(usableParked({ runStatus }))).toEqual([]);
    },
  );

  it("keeps a live scratch dialog stop-only whatever runs.status says", () => {
    expect(
      enabledIds(
        usableParked({
          runKind: "scratch",
          runStatus: "Review",
          scratchDialogStatus: "WaitingForUser",
        }),
      ),
    ).toEqual(["stop"]);
  });

  it("admits nothing for an unknown status — an allow-list, never a deny-list", () => {
    const actions = deriveWorkbenchGitActions(
      usableParked({ runStatus: "PausedByPolicy" }),
    );

    expect(actions.every((a) => !a.enabled)).toBe(true);
  });
});

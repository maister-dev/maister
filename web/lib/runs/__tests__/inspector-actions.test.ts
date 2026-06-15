import { describe, expect, it } from "vitest";

import {
  deriveInspectorActions,
  type InspectorActionDto,
  type InspectorActionPolicyInput,
} from "@/lib/runs/inspector-actions";

function input(
  over: Partial<InspectorActionPolicyInput> = {},
): InspectorActionPolicyInput {
  return {
    runId: "run-1",
    runKind: "flow",
    runStatus: "Review",
    scratchDialogStatus: null,
    hasWorkspace: true,
    workspaceRemoved: false,
    workspaceArchived: false,
    recoverable: false,
    canPromote: true,
    reviewReady: true,
    targetDriftDetected: false,
    diffTruncated: false,
    reviewedTargetCommit: "abc1234",
    deliveryMode: "local",
    ...over,
  };
}

function byId(
  actions: InspectorActionDto[],
): Record<string, InspectorActionDto> {
  return Object.fromEntries(actions.map((action) => [action.id, action]));
}

describe("deriveInspectorActions", () => {
  it("enables only session stop for live flow runs", () => {
    const actions = byId(
      deriveInspectorActions(input({ runStatus: "Running" })),
    );

    expect(actions.stop.enabled).toBe(true);
    expect(actions.stop.endpoint).toBe("/api/runs/run-1/stop");
    expect(actions.exportBranch.enabled).toBe(false);
    expect(actions.archive.enabled).toBe(false);
  });

  it("enables only session stop for scratch WaitingForUser", () => {
    const actions = byId(
      deriveInspectorActions(
        input({
          runKind: "scratch",
          runStatus: "Running",
          scratchDialogStatus: "WaitingForUser",
        }),
      ),
    );

    expect(actions.stop.enabled).toBe(true);
    expect(actions.stop.endpoint).toBe("/api/scratch-runs/run-1/stop");
    expect(actions.exportBranch.enabled).toBe(false);
  });

  it.each(["NeedsInput", "HumanWorking", "Done", "Abandoned"] as const)(
    "keeps promote disabled for %s",
    (runStatus) => {
      const actions = byId(deriveInspectorActions(input({ runStatus })));

      expect(actions.promote.enabled).toBe(false);
    },
  );

  it("enables branch preservation, cleanup, and local promote in Review", () => {
    const actions = byId(deriveInspectorActions(input()));

    expect(actions.snapshotCommit.enabled).toBe(true);
    expect(actions.exportBranch.enabled).toBe(true);
    expect(actions.handoffBranch.enabled).toBe(true);
    expect(actions.promote.enabled).toBe(true);
    expect(actions.archive.enabled).toBe(true);
    expect(actions.drop.enabled).toBe(true);
  });

  it("uses the pull-request delivery action when requested", () => {
    const actions = byId(
      deriveInspectorActions(input({ deliveryMode: "pull_request" })),
    );

    expect(actions.promotePullRequest.enabled).toBe(true);
    expect(actions.promotePullRequest.endpoint).toBe("/api/runs/run-1/promote");
    expect(actions.promote).toBeUndefined();
  });

  it("preserves review safety blockers for delivery actions", () => {
    expect(
      byId(deriveInspectorActions(input({ diffTruncated: true }))).promote
        .disabledReason,
    ).toBe("diff-truncated");
    expect(
      byId(deriveInspectorActions(input({ targetDriftDetected: true }))).promote
        .disabledReason,
    ).toBe("target-drift");
    expect(
      byId(deriveInspectorActions(input({ reviewedTargetCommit: null })))
        .promote.disabledReason,
    ).toBe("missing-review-target");
  });

  it("enables recover only for recoverable crashed runs", () => {
    const crashed = byId(
      deriveInspectorActions(
        input({ runStatus: "Crashed", recoverable: true }),
      ),
    );
    const notRecoverable = byId(
      deriveInspectorActions(
        input({ runStatus: "Crashed", recoverable: false }),
      ),
    );

    expect(crashed.recover.enabled).toBe(true);
    expect(crashed.recover.endpoint).toBe("/api/runs/run-1/recover");
    expect(notRecoverable.recover.enabled).toBe(false);
    expect(notRecoverable.recover.disabledReason).toBe("recover-unavailable");
  });

  it("disables worktree actions after workspace removal", () => {
    const actions = byId(
      deriveInspectorActions(
        input({ runStatus: "Done", workspaceRemoved: true }),
      ),
    );

    expect(actions.exportBranch.enabled).toBe(false);
    expect(actions.exportBranch.disabledReason).toBe("removed-workspace");
    expect(actions.drop.enabled).toBe(false);
  });
});

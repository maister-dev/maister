import type { ScratchDetail } from "@/lib/scratch-runs/dialog";

import { describe, expect, it } from "vitest";

import {
  attachmentSummary,
  canCompose,
  canRecover,
  canSend,
  errorText,
  lifecycleActionsForScratchDetail,
} from "@/lib/scratch-runs/dialog";

function detail(over: {
  runStatus?: ScratchDetail["run"]["status"];
  dialogStatus?: ScratchDetail["scratch"]["dialogStatus"];
  workspace?: ScratchDetail["workspace"];
}): ScratchDetail {
  return {
    run: {
      id: "run-1",
      projectId: "project-1",
      projectSlug: "project",
      capabilityAgent: "claude",
      runnerSnapshot: { capabilityAgent: "claude" },
      status: over.runStatus ?? "Running",
      currentStepId: null,
      startedAt: "2026-06-16T09:00:00.000Z",
      endedAt: null,
      createdByDisplayName: "Owner",
    },
    scratch: {
      name: "demo",
      workMode: "auto",
      reasoningEffort: "high",
      planMode: "off",
      linkedIssueUrl: null,
      baseBranch: "main",
      baseCommit: "abc1234",
      targetBranch: null,
      dialogStatus: over.dialogStatus ?? "Running",
      errorCode: null,
      errorMessage: null,
    },
    workspace:
      over.workspace === undefined
        ? { branch: "scratch/demo", removedAt: null }
        : over.workspace,
    messages: [],
    attachments: [],
    pendingHitl: null,
    capabilityProfile: null,
  };
}

describe("scratch dialog status helpers", () => {
  it("canSend only for WaitingForUser", () => {
    expect(canSend("WaitingForUser")).toBe(true);
    expect(canSend("Running")).toBe(false);
    expect(canSend("Crashed")).toBe(false);
  });

  it("canRecover only for Crashed", () => {
    expect(canRecover("Crashed")).toBe(true);
    expect(canRecover("WaitingForUser")).toBe(false);
  });

  it("canCompose for WaitingForUser or Crashed", () => {
    expect(canCompose("WaitingForUser")).toBe(true);
    expect(canCompose("Crashed")).toBe(true);
    expect(canCompose("Running")).toBe(false);
    expect(canCompose("Done")).toBe(false);
  });
});

describe("errorText", () => {
  it("falls back to a generic message when payload is null", () => {
    expect(errorText(null)).toBe("Request failed.");
  });

  it("prefers message, then code", () => {
    expect(errorText({ message: "boom" })).toBe("boom");
    expect(errorText({ code: "PRECONDITION" })).toBe("PRECONDITION");
  });
});

describe("attachmentSummary", () => {
  it("formats an uploaded file with a short hash", () => {
    expect(
      attachmentSummary({
        id: "a1",
        runId: "run-1",
        messageId: null,
        kind: "uploaded_file",
        label: null,
        value: "ref",
        fileName: "notes.txt",
        mimeType: "text/plain",
        byteSize: 12,
        sha256: "deadbeefcafebabe",
        artifactRef: "ref",
      }),
    ).toBe("notes.txt · text/plain · 12 bytes · deadbeefca");
  });

  it("formats a labelled attachment as label: value", () => {
    expect(
      attachmentSummary({
        id: "a2",
        runId: "run-1",
        messageId: null,
        kind: "issue_url",
        label: "Issue",
        value: "https://example.com/1",
        fileName: null,
        mimeType: null,
        byteSize: null,
        sha256: null,
        artifactRef: null,
      }),
    ).toBe("Issue: https://example.com/1");
  });
});

describe("lifecycleActionsForScratchDetail", () => {
  it("offers only stop while the dialog is live", () => {
    expect(
      lifecycleActionsForScratchDetail(detail({ dialogStatus: "Running" })),
    ).toEqual(["stop"]);
  });

  it("offers worktree actions (not stop) for a terminal run with a workspace", () => {
    const actions = lifecycleActionsForScratchDetail(
      detail({ runStatus: "Done", dialogStatus: "Done" }),
    );

    expect(actions).not.toContain("stop");
    expect(actions).toContain("archive");
    expect(actions).toContain("drop");
  });

  it("offers nothing when the workspace is gone", () => {
    expect(
      lifecycleActionsForScratchDetail(
        detail({
          runStatus: "Done",
          dialogStatus: "Done",
          workspace: {
            branch: "scratch/demo",
            removedAt: "2026-06-16T10:00:00.000Z",
          },
        }),
      ),
    ).toEqual([]);
  });
});

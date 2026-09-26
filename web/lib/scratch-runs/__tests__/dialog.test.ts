import type { ScratchDetail } from "@/lib/scratch-runs/dialog";

import { describe, expect, it } from "vitest";

import {
  attachmentSummary,
  canCompose,
  canRecover,
  canSend,
  canSendWhileBusy,
  errorText,
  lifecycleActionsForScratchDetail,
  queuedMessageUnsendable,
  recoverErrorText,
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
    terminalCause: null,
    capabilityProfile: null,
  };
}

describe("scratch dialog status helpers", () => {
  it("canSend only for WaitingForUser", () => {
    expect(canSend("WaitingForUser")).toBe(true);
    expect(canSend("Running")).toBe(false);
    expect(canSend("Crashed")).toBe(false);
  });

  it("canSendWhileBusy only while the agent runs a turn (ADR-182)", () => {
    expect(canSendWhileBusy("Running")).toBe(true);
    expect(canSendWhileBusy("Starting")).toBe(false);
    expect(canSendWhileBusy("WaitingForUser")).toBe(false);
    expect(canSendWhileBusy("NeedsInput")).toBe(false);
    expect(canSendWhileBusy("Crashed")).toBe(false);
  });

  it("canRecover only when the dialog AND the run are Crashed (ADR-175 2026-09-26)", () => {
    expect(canRecover("Crashed", "Crashed")).toBe(true);
    expect(canRecover("WaitingForUser", "Running")).toBe(false);
    // A budget stop keeps a Crashed dialog under a Failed run — not recoverable.
    expect(canRecover("Crashed", "Failed")).toBe(false);
    expect(canRecover("Crashed", undefined)).toBe(false);
  });

  it("canCompose for WaitingForUser, or a Crashed dialog on a Crashed run", () => {
    expect(canCompose("WaitingForUser", "Running")).toBe(true);
    expect(canCompose("Crashed", "Crashed")).toBe(true);
    expect(canCompose("Crashed", "Failed")).toBe(false);
    expect(canCompose("Running", "Running")).toBe(false);
    expect(canCompose("Done", "Done")).toBe(false);
  });

  it("a queued row is unsendable once the dialog ended or the run Failed", () => {
    expect(queuedMessageUnsendable("Review", "Review")).toBe(true);
    expect(queuedMessageUnsendable("Done", "Done")).toBe(true);
    expect(queuedMessageUnsendable("Abandoned", "Abandoned")).toBe(true);
    expect(queuedMessageUnsendable("Crashed", "Failed")).toBe(true);
    // Recover sends a crashed run's queue first — still "Queued".
    expect(queuedMessageUnsendable("Crashed", "Crashed")).toBe(false);
    expect(queuedMessageUnsendable("WaitingForUser", "Running")).toBe(false);
    expect(queuedMessageUnsendable("Running", "Running")).toBe(false);
  });
});

describe("recoverErrorText", () => {
  it("names the refusal by the run status the route observed", () => {
    const refusal = (status: string, next?: string) => ({
      code: "CONFLICT",
      details: { reason: "scratch_not_recoverable", status, next },
    });

    expect(recoverErrorText(refusal("Failed"))).toBe("recoverRefused.Failed");
    expect(recoverErrorText(refusal("NeedsInputIdle", "respond"))).toBe(
      "recoverRefused.NeedsInputIdle",
    );
    expect(recoverErrorText(refusal("Running"))).toBe("recoverRefused.Live");
    expect(recoverErrorText(refusal("NeedsInput"))).toBe("recoverRefused.Live");
  });

  it("falls back to the generic copy for every other error", () => {
    expect(recoverErrorText(null)).toBe("errorGeneric");
    expect(
      recoverErrorText({ code: "CONFLICT", details: { reason: "busy" } }),
    ).toBe("errorGeneric");
    expect(
      recoverErrorText({
        code: "PRECONDITION",
        details: { reason: "scratch_not_recoverable", status: "Failed" },
      }),
    ).toBe("errorGeneric");
  });
});

describe("errorText", () => {
  it("returns a localized fallback key when payload is null", () => {
    expect(errorText(null)).toBe("errorGeneric");
  });

  it("does not surface server messages or codes", () => {
    expect(errorText({ message: "boom" })).toBe("errorGeneric");
    expect(errorText({ code: "PRECONDITION" })).toBe("errorGeneric");
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

  // ADR-181 D10: a removed worktree offers exactly the way back.
  it("offers only reattach when the workspace is gone", () => {
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
    ).toEqual(["reattach"]);
  });
});

import { describe, expect, it } from "vitest";

import {
  resolveScratchAttachmentPath,
  safeUploadFileName,
  uploadedFileMetadata,
  validateScratchAttachments,
} from "@/lib/scratch-runs/attachments";
import {
  normalizeScratchPrompt,
  projectSupervisorEventToScratch,
  sendScratchPromptAndProjectEvents,
} from "@/lib/scratch-runs/events";
import {
  decoratePromptForPlanMode,
  deriveScratchBranchName,
  scratchNameFallback,
  scratchStepId,
  workModeToPlanMode,
} from "@/lib/scratch-runs/launch";
import {
  assistantScratchMessageDraft,
  userScratchMessageDraft,
} from "@/lib/scratch-runs/messages";
import {
  assertScratchCanAcceptUserMessage,
  dialogStatusAfterPromptCompletion,
  dialogStatusAfterSupervisorStop,
  runStatusForDialogStatus,
} from "@/lib/scratch-runs/state";
import { legacyScratchApiToExecution } from "@/test-support/execution-host-module-mock";

describe("scratch launch helpers", () => {
  it("derives stable names, branches, and plan-mode prompts", () => {
    expect(scratchNameFallback("\nFix checkout flow\nwith details")).toBe(
      "Fix checkout flow",
    );
    expect(
      deriveScratchBranchName({
        branchPrefix: "maister/",
        projectSlug: "shop",
        requestedName: "Fix Checkout!",
        runId: "12345678-1234-1234-1234-123456789012",
      }),
    ).toBe("maister/shop/scratch/fix-checkout");
    expect(
      decoratePromptForPlanMode({ planMode: "plan-first", prompt: "Do work" }),
    ).toContain("wait for operator confirmation");
    expect(workModeToPlanMode("plan_first")).toBe("plan-first");
    expect(workModeToPlanMode("manual_approval")).toBe("off");
    expect(scratchStepId()).toBe("dialog");
  });

  it("keeps explicit skill commands first when adding run policy", () => {
    const decorated = decoratePromptForPlanMode({
      planMode: "off",
      reasoningEffort: "ultra",
      prompt: "@skill:aif-plan Plan full mode",
    });

    expect(decorated.startsWith("@skill:aif-plan")).toBe(true);
    expect(decorated).toContain("Reasoning effort policy: ultra");
    expect(
      normalizeScratchPrompt(decorated, "claude", { runId: "r1" }).startsWith(
        "/aif-plan",
      ),
    ).toBe(true);
  });

  it("keeps raw slash commands first when adding manual approval policy", () => {
    const decorated = decoratePromptForPlanMode({
      planMode: "off",
      workMode: "manual_approval",
      prompt: "/aif-plan Plan full mode",
    });

    expect(decorated.startsWith("/aif-plan")).toBe(true);
    expect(decorated).toContain("Manual approval policy");
  });
});

describe("scratch attachment helpers", () => {
  it("resolves file paths only inside project repo or worktree", () => {
    const projectRepoPath = "/repo/project";
    const worktreePath = "/repo/project/.worktrees/run-1";

    expect(
      resolveScratchAttachmentPath({
        value: "src/app.ts",
        projectRepoPath,
        worktreePath,
      }),
    ).toBe("/repo/project/.worktrees/run-1/src/app.ts");

    expect(() =>
      resolveScratchAttachmentPath({
        value: "/etc/passwd",
        projectRepoPath,
        worktreePath,
      }),
    ).toThrow(/outside/);
  });

  it("normalizes only file_path attachments", () => {
    expect(
      validateScratchAttachments(
        [
          { kind: "text_note", value: "hello" },
          { kind: "file_path", value: "README.md" },
        ],
        {
          projectRepoPath: "/repo/project",
          worktreePath: "/repo/project/.worktrees/run-1",
        },
      ),
    ).toEqual([
      { kind: "text_note", value: "hello" },
      {
        kind: "file_path",
        value: "/repo/project/.worktrees/run-1/README.md",
      },
    ]);
  });

  it("builds uploaded-file metadata with an opaque execution-object ID", () => {
    const metadata = uploadedFileMetadata({
      file: {
        fileName: "notes.txt",
        mimeType: "text/plain",
        byteSize: 5,
        bytes: new TextEncoder().encode("hello"),
      },
      objectId: "b7e5e032-6049-48b2-806f-e5db714a93cb",
    });

    expect(metadata).toMatchObject({
      kind: "uploaded_file",
      fileName: "notes.txt",
      mimeType: "text/plain",
      byteSize: 5,
      value: "b7e5e032-6049-48b2-806f-e5db714a93cb",
      storagePath: null,
    });
    expect(metadata.sha256).toHaveLength(64);
    expect(() => safeUploadFileName("../secret.txt")).toThrow(/invalid/);
    expect(() => safeUploadFileName("..\\secret.txt")).toThrow(/invalid/);
    expect(() => safeUploadFileName("C:\\secret.txt")).toThrow(/invalid/);
    expect(() => safeUploadFileName("nested/secret.txt")).toThrow(/invalid/);
  });
});

describe("scratch message and state helpers", () => {
  it("builds monotonic message drafts", () => {
    expect(userScratchMessageDraft({ content: "hi" })).toEqual({
      role: "user",
      content: "hi",
    });
    expect(
      assistantScratchMessageDraft({
        content: "ok",
        supervisorEventId: "7",
      }),
    ).toMatchObject({ role: "assistant", supervisorEventId: "7" });
  });

  it("guards accepted input by dialog status and session presence", () => {
    const accept = (
      dialogStatus: Parameters<
        typeof assertScratchCanAcceptUserMessage
      >[0]["dialogStatus"],
      hostSessionId: string | null = "sup-1",
    ) =>
      assertScratchCanAcceptUserMessage({
        runId: "run-1",
        runStatus: "Running",
        dialogStatus,
        hostSessionId,
      });

    expect(accept("WaitingForUser")).toBe("prompt");
    // ADR-182 D-D1: a running turn accepts the message (steered or queued);
    // `Starting` has no session to steer or queue for yet.
    expect(accept("Running")).toBe("busy");
    expect(() => accept("Starting", null)).toThrow(/not accepted/);
    expect(() => accept("NeedsInput")).toThrow(/not accepted/);
    expect(() => accept("Review")).toThrow(/terminal/);
    expect(() => accept("Running", null)).toThrow(/no live supervisor session/);

    expect(dialogStatusAfterSupervisorStop({ hasWorkspace: true })).toBe(
      "Review",
    );
    expect(dialogStatusAfterPromptCompletion("Running")).toBe("WaitingForUser");
    expect(dialogStatusAfterPromptCompletion("NeedsInput")).toBe("NeedsInput");
    expect(dialogStatusAfterPromptCompletion("Crashed")).toBe("Crashed");
    expect(runStatusForDialogStatus("NeedsInput")).toBe("NeedsInput");
  });
});

describe("scratch event projection", () => {
  it("maps lifecycle events to dialog statuses and drops protocol lines", () => {
    expect(
      projectSupervisorEventToScratch({
        type: "session.line",
        monotonicId: 1,
        line: '{"jsonrpc":"2.0","id":0}',
      }),
    ).toEqual({});

    expect(
      projectSupervisorEventToScratch({
        type: "session.permission_request",
        monotonicId: 2,
        requestId: "req-1",
      }),
    ).toMatchObject({ dialogStatus: "NeedsInput", hitlRequestId: "req-1" });

    expect(
      projectSupervisorEventToScratch({
        type: "session.exited",
        monotonicId: 3,
        reason: "intentional",
      }),
    ).toMatchObject({ dialogStatus: "Review" });

    expect(
      projectSupervisorEventToScratch({
        type: "session.crashed",
        monotonicId: 4,
      }),
    ).toMatchObject({ dialogStatus: "Crashed" });

    // ADR-166 E-EH-11: an eviction for a newer driver generation projects
    // nothing — that generation owns the dialog.
    expect(
      projectSupervisorEventToScratch({
        type: "session.exited",
        monotonicId: 6,
        reason: "fenced",
      }),
    ).toEqual({});

    // ADR-108 (M40): a scratch hook_trip never escalates to NeedsInput (D2) —
    // the projection emits no dialogStatus (the consumer adds a chat notice).
    expect(
      projectSupervisorEventToScratch({
        type: "session.hook_trip",
        monotonicId: 5,
        rule: "repetition",
        lifecycle: "pre_tool_call",
        disposition: "halt",
      }),
    ).toEqual({});
  });

  it("cancels supervisor permission when permission persistence fails", async () => {
    const cancelled: Array<{ sessionId: string; requestId: string }> = [];
    const api = {
      async cancelPermission(sessionId: string, requestId: string) {
        cancelled.push({ sessionId, requestId });

        return { ok: true as const };
      },
      async sendPrompt() {
        return { stopReason: "end_turn" as const };
      },
      async *streamSession() {
        yield {
          type: "session.permission_request" as const,
          sessionId: "sup-1",
          monotonicId: 4,
          requestId: "req-1",
          options: [{ optionId: "allow" }],
          toolCall: { title: "Edit file" },
        };
      },
    };
    const db = {
      // S2.9: the admission wait reads the session incarnation first.
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ state: "active" }] }),
        }),
      }),
      async transaction() {
        throw new Error("insert failed");
      },
    };

    await expect(
      sendScratchPromptAndProjectEvents({
        runId: "run-1",
        sessionId: "sup-1",
        stepId: "dialog",
        prompt: "go",
        owner: { variant: "initial" },
        db,
        execution: legacyScratchApiToExecution(api as never),
      }),
    ).rejects.toThrow(/insert failed/);
    expect(cancelled).toEqual([{ sessionId: "sup-1", requestId: "req-1" }]);
  });
});

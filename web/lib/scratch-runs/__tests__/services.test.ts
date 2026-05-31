import { describe, expect, it } from "vitest";

import {
  resolveScratchAttachmentPath,
  validateScratchAttachments,
} from "@/lib/scratch-runs/attachments";
import {
  projectSupervisorEventToScratch,
  sendScratchPromptAndProjectEvents,
} from "@/lib/scratch-runs/events";
import {
  decoratePromptForPlanMode,
  deriveScratchBranchName,
  scratchNameFallback,
  scratchStepId,
} from "@/lib/scratch-runs/launch";
import {
  assistantScratchMessageDraft,
  nextScratchMessageSequence,
  userScratchMessageDraft,
} from "@/lib/scratch-runs/messages";
import {
  assertScratchCanAcceptUserMessage,
  dialogStatusAfterPromptCompletion,
  dialogStatusAfterSupervisorStop,
  runStatusForDialogStatus,
} from "@/lib/scratch-runs/state";

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
    expect(scratchStepId()).toBe("dialog");
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
});

describe("scratch message and state helpers", () => {
  it("builds monotonic message drafts", () => {
    expect(nextScratchMessageSequence([1, 3, 2])).toBe(4);
    expect(userScratchMessageDraft({ sequence: 1, content: "hi" })).toEqual({
      sequence: 1,
      role: "user",
      content: "hi",
    });
    expect(
      assistantScratchMessageDraft({
        sequence: 2,
        content: "ok",
        supervisorEventId: "7",
      }),
    ).toMatchObject({ role: "assistant", supervisorEventId: "7" });
  });

  it("guards accepted input by dialog status and session presence", () => {
    expect(() =>
      assertScratchCanAcceptUserMessage({
        runId: "run-1",
        runStatus: "Running",
        dialogStatus: "WaitingForUser",
        supervisorSessionId: "sup-1",
      }),
    ).not.toThrow();

    expect(() =>
      assertScratchCanAcceptUserMessage({
        runId: "run-1",
        runStatus: "Running",
        dialogStatus: "Running",
        supervisorSessionId: "sup-1",
      }),
    ).toThrow(/not accepted/);

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
  it("projects supervisor events to dialog messages and statuses", () => {
    expect(
      projectSupervisorEventToScratch({
        type: "session.line",
        monotonicId: 1,
        line: "hello",
      }).message,
    ).toMatchObject({ role: "assistant", content: "hello" });

    expect(
      projectSupervisorEventToScratch({
        type: "session.permission_request",
        monotonicId: 2,
        requestId: "req-1",
      }),
    ).toMatchObject({ dialogStatus: "NeedsInput", hitlRequestId: "req-1" });

    expect(
      projectSupervisorEventToScratch({
        type: "session.crashed",
        monotonicId: 3,
      }),
    ).toMatchObject({ dialogStatus: "Crashed" });
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
        db,
        api,
      }),
    ).rejects.toThrow(/insert failed/);
    expect(cancelled).toEqual([{ sessionId: "sup-1", requestId: "req-1" }]);
  });
});

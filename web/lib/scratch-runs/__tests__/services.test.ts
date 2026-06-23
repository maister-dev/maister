import { describe, expect, it } from "vitest";

import {
  resolveScratchAttachmentPath,
  safeUploadFileName,
  uploadedFileMetadata,
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
  workModeToPlanMode,
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
    expect(workModeToPlanMode("plan_first")).toBe("plan-first");
    expect(workModeToPlanMode("manual_approval")).toBe("off");
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

  it("builds uploaded-file artifact metadata outside the git worktree", () => {
    const metadata = uploadedFileMetadata({
      file: {
        fileName: "notes.txt",
        mimeType: "text/plain",
        byteSize: 5,
        bytes: new TextEncoder().encode("hello"),
      },
      projectSlug: "demo",
      runId: "run-1",
      scope: "launch",
      runtimeRoot: "/runtime",
    });

    expect(metadata).toMatchObject({
      kind: "uploaded_file",
      fileName: "notes.txt",
      mimeType: "text/plain",
      byteSize: 5,
      value: ".maister/demo/runs/run-1/uploads/launch/notes.txt",
      storagePath: "/runtime/.maister/demo/runs/run-1/uploads/launch/notes.txt",
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

  it("assigns gap-free unique sequences to a burst of projected events", async () => {
    // Models the Postgres read-modify-write window: the sequence SELECT resolves
    // on a microtask, the INSERT commits on a later macrotask. Concurrent
    // projection then reads the same max before any insert lands and collides on
    // scratch_messages_run_sequence_uq. Sequential projection must not.
    const rows: Array<{ runId: string; sequence: number }> = [];
    const db = {
      select() {
        return {
          from() {
            return {
              async where() {
                await Promise.resolve();

                return rows.map((row) => ({ sequence: row.sequence }));
              },
            };
          },
        };
      },
      insert() {
        return {
          values(row: { runId: string; sequence: number }) {
            return new Promise<void>((resolve, reject) => {
              setTimeout(() => {
                if (
                  rows.some(
                    (existing) =>
                      existing.runId === row.runId &&
                      existing.sequence === row.sequence,
                  )
                ) {
                  reject(
                    new Error(
                      `duplicate key (run_id, sequence)=(${row.runId}, ${row.sequence})`,
                    ),
                  );

                  return;
                }
                rows.push({ runId: row.runId, sequence: row.sequence });
                resolve();
              }, 0);
            });
          },
        };
      },
      update() {
        return {
          set() {
            return { async where() {} };
          },
        };
      },
    };
    const toolCount = 6;
    const api = {
      async cancelPermission() {
        return { ok: true as const };
      },
      async sendPrompt() {
        return { stopReason: "end_turn" as const };
      },
      async *streamSession() {
        for (let i = 1; i <= toolCount; i += 1) {
          yield {
            type: "session.update" as const,
            sessionId: "sup-1",
            monotonicId: i,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `tc-${i}`,
              title: "Bash",
              kind: "execute",
              status: "pending",
              rawInput: { command: `cmd ${i}` },
              content: [],
            },
          };
        }
      },
    };

    await sendScratchPromptAndProjectEvents({
      runId: "run-1",
      sessionId: "sup-1",
      stepId: "dialog",
      prompt: "go",
      db,
      api,
    });

    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

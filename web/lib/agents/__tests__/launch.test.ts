import { describe, expect, it } from "vitest";

import {
  AgentLaunchError,
  agentWorktreeBranchName,
  buildAgentPrompt,
  hidesAgentExistenceForLaunch,
  publicAgentLaunchMessage,
} from "@/lib/agents/launch";

type PromptTaskRow = {
  number: number;
  title: string;
  prompt: string;
  taskKey: string;
};

type PromptCommentRow = {
  id: string;
  body: string;
  actorType: "user" | "agent" | "system";
  actorId: string | null;
  createdAt: Date;
};

function promptDb(input: {
  taskRows: PromptTaskRow[];
  triggerCommentRows: PromptCommentRow[];
  recentCommentRows: PromptCommentRow[];
}) {
  let commentSelectCount = 0;

  return {
    select(fields: Record<string, unknown>) {
      if ("number" in fields) {
        return {
          from: () => ({
            innerJoin: () => ({
              where: async () => input.taskRows,
            }),
          }),
        };
      }

      commentSelectCount += 1;

      const rows =
        commentSelectCount === 1
          ? input.triggerCommentRows
          : input.recentCommentRows;

      return {
        from: () => ({
          where: () => ({
            limit: async () => rows,
            orderBy: () => ({
              limit: async () => rows,
            }),
          }),
        }),
      };
    },
  };
}

describe("agentWorktreeBranchName", () => {
  it("sanitizes package-qualified agent ids for git branch names", () => {
    const branch = agentWorktreeBranchName({
      prefix: "maister/",
      agentId: "test-pkg:platform-helper",
      runId: "12345678-1234-4234-9234-123456789abc",
    });

    expect(branch).toBe("maister/agent-test-pkg-platform-helper-12345678");
    expect(branch).toMatch(/^[A-Za-z0-9_./-]+$/);
  });
});

describe("agent launch error classification", () => {
  it("hides missing and unattached agents from token-scoped callers", () => {
    expect(
      hidesAgentExistenceForLaunch(
        new AgentLaunchError(
          "not_registered",
          "PRECONDITION",
          "agent is not registered",
        ),
      ),
    ).toBe(true);
    expect(
      hidesAgentExistenceForLaunch(
        new AgentLaunchError(
          "not_attached",
          "PRECONDITION",
          "agent is not attached",
        ),
      ),
    ).toBe(true);
    expect(
      hidesAgentExistenceForLaunch(
        new AgentLaunchError("disabled", "PRECONDITION", "agent is disabled"),
      ),
    ).toBe(false);
  });

  it("redacts quarantine internals for public launch responses", () => {
    const err = new AgentLaunchError(
      "quarantined",
      "PRECONDITION",
      "agent is quarantined: /private/repo leaked detail",
    );

    expect(publicAgentLaunchMessage(err)).toBe(
      "agent is quarantined; admin review required",
    );
  });
});

describe("buildAgentPrompt", () => {
  const parsed = {
    prompt: "Classify the task.",
  } as Parameters<typeof buildAgentPrompt>[1];

  it("adds the triggering comment body and recent thread tail for task.comment_added", async () => {
    const prompt = await buildAgentPrompt(
      promptDb({
        taskRows: [
          {
            number: 7,
            title: "Routing question",
            prompt: "Pick the right Flow.",
            taskKey: "APP",
          },
        ],
        triggerCommentRows: [
          {
            id: "comment-2",
            body: "Please use the codex runner.",
            actorType: "user",
            actorId: "user-2",
            createdAt: new Date("2026-06-12T10:01:00.000Z"),
          },
        ],
        recentCommentRows: [
          {
            id: "comment-3",
            body: "One more detail.",
            actorType: "user",
            actorId: "user-3",
            createdAt: new Date("2026-06-12T10:02:00.000Z"),
          },
          {
            id: "comment-2",
            body: "Please use the codex runner.",
            actorType: "user",
            actorId: "user-2",
            createdAt: new Date("2026-06-12T10:01:00.000Z"),
          },
          {
            id: "comment-1",
            body: "What runner should I use?",
            actorType: "agent",
            actorId: "triager",
            createdAt: new Date("2026-06-12T10:00:00.000Z"),
          },
        ],
      }),
      parsed,
      {
        id: "run-1",
        taskId: "task-1",
        triggerSource: "domain_event",
        triggerEventId: 100,
        triggerPayload: {
          kind: "task.comment_added",
          payload: { taskKey: "APP-7", commentId: "comment-2" },
        },
      },
    );

    expect(prompt).toContain("## Triggering comment");
    expect(prompt).toContain("Please use the codex runner.");
    expect(prompt).toContain("## Recent task thread (last 6)");
    const recentThread = prompt.slice(
      prompt.indexOf("## Recent task thread (last 6)"),
    );

    expect(recentThread.indexOf("What runner should I use?")).toBeLessThan(
      recentThread.indexOf("Please use the codex runner."),
    );
    expect(recentThread.indexOf("Please use the codex runner.")).toBeLessThan(
      recentThread.indexOf("One more detail."),
    );
  });

  it("fails fast when task.comment_added references a missing comment row", async () => {
    await expect(
      buildAgentPrompt(
        promptDb({
          taskRows: [
            {
              number: 7,
              title: "Routing question",
              prompt: "Pick the right Flow.",
              taskKey: "APP",
            },
          ],
          triggerCommentRows: [],
          recentCommentRows: [],
        }),
        parsed,
        {
          id: "run-1",
          taskId: "task-1",
          triggerSource: "domain_event",
          triggerEventId: 100,
          triggerPayload: {
            kind: "task.comment_added",
            payload: { taskKey: "APP-7", commentId: "missing-comment" },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });
});

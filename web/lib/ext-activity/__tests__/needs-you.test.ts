import { beforeEach, describe, expect, it, vi } from "vitest";

const hitlQueryMocks = vi.hoisted(() => ({
  getHitlInbox: vi.fn(),
}));

vi.mock("@/lib/queries/hitl", () => ({
  getHitlInbox: hitlQueryMocks.getHitlInbox,
}));

import { listProjectNeedsYou } from "@/lib/ext-activity/needs-you";

describe("listProjectNeedsYou", () => {
  beforeEach(() => {
    hitlQueryMocks.getHitlInbox.mockReset();
  });

  it("maps project inbox items into the assistant-safe needs-you DTO and preserves order", async () => {
    const fakeDb = { name: "db" };

    hitlQueryMocks.getHitlInbox.mockResolvedValue({
      items: [
        {
          hitlRequestId: "hitl-1",
          runId: "run-1",
          kind: "permission",
          taskRef: "OPS-14",
          taskTitle: "Review deploy",
          prompt: "Allow the tool call",
          createdAt: "2026-07-26T10:00:00.000Z",
          criticality: "high",
        },
        {
          hitlRequestId: "hitl-2",
          runId: "run-2",
          kind: "agent_question",
          taskRef: "OPS-15",
          taskTitle: null,
          prompt: "Should we roll back first?",
          createdAt: "2026-07-26T10:05:00.000Z",
          criticality: "medium",
        },
      ],
      count: 2,
      oldest: "5m",
    });

    const items = await listProjectNeedsYou("proj-1", { db: fakeDb as never });

    expect(hitlQueryMocks.getHitlInbox).toHaveBeenCalledWith("proj-1", {
      db: fakeDb,
    });
    expect(items).toEqual([
      {
        runId: "run-1",
        taskId: null,
        taskKey: "OPS-14",
        taskTitle: "Review deploy",
        hitlRequestId: "hitl-1",
        kind: "permission",
        title: "Review deploy",
        summary: "Allow the tool call",
        requestedAt: new Date("2026-07-26T10:00:00.000Z"),
        criticality: "high",
      },
      {
        runId: "run-2",
        taskId: null,
        taskKey: "OPS-15",
        taskTitle: null,
        hitlRequestId: "hitl-2",
        kind: "agent_question",
        title: "Should we roll back first?",
        summary: "Should we roll back first?",
        requestedAt: new Date("2026-07-26T10:05:00.000Z"),
        criticality: "medium",
      },
    ]);
  });
});

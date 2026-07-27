import { beforeEach, describe, expect, it, vi } from "vitest";

import { encodeToolPayload } from "@/lib/run-transcript/transcript";

const needsYouMocks = vi.hoisted(() => ({
  listProjectNeedsYou: vi.fn(),
}));

const promotableMocks = vi.hoisted(() => ({
  listProjectPromotable: vi.fn(),
}));

const summonabilityMocks = vi.hoisted(() => ({
  listMentionCandidateAgents: vi.fn(),
}));

const transcriptMocks = vi.hoisted(() => ({
  projectRunTranscript: vi.fn(async () => ({
    status: "unchanged" as const,
    nodeAttempts: 0,
    rowsUpserted: 0,
  })),
  getWholeRunTranscriptMessages: vi.fn(async () => ({
    messages: [],
    lastEventAt: null,
  })),
}));

vi.mock("@/lib/ext-activity/needs-you", () => ({
  listProjectNeedsYou: needsYouMocks.listProjectNeedsYou,
}));

vi.mock("@/lib/ext-activity/promotable", () => ({
  listProjectPromotable: promotableMocks.listProjectPromotable,
}));

vi.mock("@/lib/agents/summonability", () => ({
  listMentionCandidateAgents: summonabilityMocks.listMentionCandidateAgents,
}));

vi.mock("@/lib/runs/run-transcript-projector", () => ({
  projectRunTranscript: transcriptMocks.projectRunTranscript,
  getWholeRunTranscriptMessages: transcriptMocks.getWholeRunTranscriptMessages,
}));

import {
  getActivityPulse,
  getRunActivityResponse,
} from "@/lib/ext-activity/service";

type QueryRows = Record<string, unknown>[];

class FakeSelectQuery implements PromiseLike<QueryRows> {
  constructor(private readonly rows: QueryRows) {}

  from(): this {
    return this;
  }

  where(): this {
    return this;
  }

  orderBy(): this {
    return this;
  }

  limit(): this {
    return this;
  }

  innerJoin(): this {
    return this;
  }

  leftJoin(): this {
    return this;
  }

  then<TResult1 = QueryRows, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryRows) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.rows).then(onfulfilled, onrejected);
  }
}

function makeClient(responses: QueryRows[]): {
  select: () => FakeSelectQuery;
} {
  const queue = [...responses];

  return {
    select() {
      const rows = queue.shift() ?? [];

      return new FakeSelectQuery(rows);
    },
  };
}

describe("assistant activity pulse service", () => {
  beforeEach(() => {
    needsYouMocks.listProjectNeedsYou.mockReset();
    promotableMocks.listProjectPromotable.mockReset();
    promotableMocks.listProjectPromotable.mockResolvedValue([]);
    summonabilityMocks.listMentionCandidateAgents.mockReset();
    summonabilityMocks.listMentionCandidateAgents.mockResolvedValue([]);
    transcriptMocks.projectRunTranscript.mockClear();
    transcriptMocks.getWholeRunTranscriptMessages.mockClear();
  });

  it("bootstraps at the current project tail while still returning now and needs-you snapshots", async () => {
    const client = makeClient([
      [{ id: 22 }],
      [
        {
          runId: "run-1",
          projectId: "proj-1",
          runKind: "flow",
          status: "NeedsInput",
          currentStepId: "implement",
          startedAt: new Date("2026-07-26T11:00:00.000Z"),
          taskId: "task-1",
          taskTitle: "Investigate flaky tests",
          projectTaskKey: "OPS",
          taskNumber: 7,
        },
      ],
      [
        {
          id: "message-1",
          role: "assistant",
          content: "Planning the next patch",
          supervisorEventId: "6",
          createdAt: new Date("2026-07-26T11:40:00.000Z"),
          nodeId: "implement",
        },
        {
          id: "tool-1",
          role: "tool",
          content: encodeToolPayload({
            name: "Edit",
            toolKind: "edit",
            status: "in_progress",
            arg: "web/lib/foo.ts",
            rawInput: { file_path: "web/lib/foo.ts" },
            result: "",
          }),
          supervisorEventId: "8",
          createdAt: new Date("2026-07-26T11:56:00.000Z"),
          nodeId: "implement",
        },
      ],
      [{ attempt: 2 }],
    ]);

    needsYouMocks.listProjectNeedsYou.mockResolvedValue([
      {
        runId: "run-1",
        taskId: null,
        taskKey: "OPS-7",
        taskTitle: "Investigate flaky tests",
        hitlRequestId: "hitl-1",
        kind: "permission",
        title: "Investigate flaky tests",
        summary: "Approve the file edit",
        requestedAt: new Date("2026-07-26T11:58:00.000Z"),
        criticality: "high",
      },
    ]);

    const response = await getActivityPulse("proj-1", {
      since: null,
      salience: "low",
      now: new Date("2026-07-26T12:00:00.000Z"),
      client: client as never,
    });

    expect(needsYouMocks.listProjectNeedsYou).toHaveBeenCalledWith("proj-1", {
      db: client,
    });
    expect(response.happened).toEqual({
      items: [],
      nextCursor: 22n,
      hasMore: false,
    });
    expect(response.now.runs).toHaveLength(1);
    expect(response.now.runs[0]).toMatchObject({
      runId: "run-1",
      taskId: "task-1",
      taskKey: "OPS-7",
      taskTitle: "Investigate flaky tests",
      status: "NeedsInput",
      currentStepId: "implement",
      currentAttemptNumber: 2,
      lastAction: {
        summary: "editing web/lib/foo.ts",
      },
    });
    expect(response.now.runs[0].liveness.state).toBe("waiting_on_human");
    expect(response.needsYou.items).toEqual([
      expect.objectContaining({
        runId: "run-1",
        summary: "Approve the file edit",
      }),
    ]);
    expect(transcriptMocks.projectRunTranscript).toHaveBeenCalledWith("run-1", {
      client,
    });
  });

  it("replays happened facts after the supplied cursor and keeps empty snapshots explicit", async () => {
    const client = makeClient([
      [{ id: 18 }],
      [
        {
          id: 15,
          kind: "task.comment_added",
          occurredAt: new Date("2026-07-26T09:00:00.000Z"),
          runId: null,
          taskId: "task-19",
          payload: { taskKey: "OPS-19" },
        },
        {
          id: 18,
          kind: "run.failed",
          occurredAt: new Date("2026-07-26T09:05:00.000Z"),
          runId: "run-19",
          taskId: "task-19",
          payload: {},
        },
      ],
      [],
    ]);

    needsYouMocks.listProjectNeedsYou.mockResolvedValue([]);

    const response = await getActivityPulse("proj-1", {
      since: 14n,
      salience: "high",
      now: new Date("2026-07-26T12:00:00.000Z"),
      client: client as never,
    });

    expect(response.happened.items).toEqual([
      expect.objectContaining({
        id: "15",
        kind: "task.comment_added",
      }),
      expect.objectContaining({
        id: "18",
        kind: "run.failed",
      }),
    ]);
    expect(response.happened.nextCursor).toBe(18n);
    expect(response.now.runs).toEqual([]);
    expect(response.needsYou.items).toEqual([]);
  });

  it("returns semantic history for a terminal run in the bound project", async () => {
    const client = makeClient([
      [
        {
          runId: "run-9",
          projectId: "proj-1",
          runKind: "flow",
          status: "Done",
          currentStepId: "implement",
          startedAt: new Date("2026-07-26T08:00:00.000Z"),
          taskId: "task-9",
          taskTitle: "Finalize rollout",
          projectTaskKey: "OPS",
          taskNumber: 27,
        },
      ],
      [
        {
          id: "message-1",
          role: "assistant",
          content: "Rollout finished cleanly",
          supervisorEventId: "4",
          createdAt: new Date("2026-07-26T08:20:00.000Z"),
          nodeId: "implement",
        },
      ],
      [{ attempt: 1 }],
    ]);

    needsYouMocks.listProjectNeedsYou.mockResolvedValue([]);

    const response = await getRunActivityResponse("proj-1", "run-9", {
      sinceId: null,
      limit: 100,
      salience: "low",
      now: new Date("2026-07-26T12:00:00.000Z"),
      client: client as never,
    });

    expect(needsYouMocks.listProjectNeedsYou).toHaveBeenCalledWith("proj-1", {
      db: client,
    });
    expect(response).not.toBeNull();
    expect(response?.items).toEqual([
      expect.objectContaining({
        runId: "run-9",
        kind: "message",
        summary: "Rollout finished cleanly",
      }),
    ]);
    expect(response?.now).toMatchObject({
      runId: "run-9",
      taskId: "task-9",
      taskKey: "OPS-27",
      status: "Done",
    });
  });

  it("REQ-A1 AC1 — emits needsYou.promotable as [] rather than omitting it when nothing qualifies", async () => {
    const client = makeClient([[{ id: 3 }], []]);

    needsYouMocks.listProjectNeedsYou.mockResolvedValue([]);

    const response = await getActivityPulse("proj-1", {
      since: null,
      salience: "low",
      now: new Date("2026-07-27T12:00:00.000Z"),
      client: client as never,
    });

    expect(promotableMocks.listProjectPromotable).toHaveBeenCalledWith(
      "proj-1",
      { db: client },
    );
    expect(response.needsYou.promotable).toEqual([]);
    expect(response.needsYou).toHaveProperty("promotable");
  });

  it("REQ-B1 AC1 — emits a top-level agents block with [] items when nothing is attached", async () => {
    const client = makeClient([[{ id: 3 }], []]);

    needsYouMocks.listProjectNeedsYou.mockResolvedValue([]);

    const response = await getActivityPulse("proj-1", {
      since: null,
      salience: "low",
      now: new Date("2026-07-27T12:00:00.000Z"),
      client: client as never,
    });

    expect(summonabilityMocks.listMentionCandidateAgents).toHaveBeenCalledWith(
      client,
      "proj-1",
    );
    expect(response.agents).toEqual({
      generatedAt: new Date("2026-07-27T12:00:00.000Z"),
      items: [],
    });
  });

  it("REQ-B2 AC1/AC2 — reports every attached agent, keeps non-summonable ones, and `enabled` is the ATTACHMENT axis", async () => {
    const client = makeClient([[{ id: 3 }], []]);

    needsYouMocks.listProjectNeedsYou.mockResolvedValue([]);
    // The pinning fixture: the LINK is enabled while the CATALOG row is
    // disabled. A naive implementation that reports `agents.enabled` would emit
    // `enabled: false` here and only accidentally agree elsewhere.
    summonabilityMocks.listMentionCandidateAgents.mockResolvedValue([
      {
        id: "core:triager",
        stem: "triager",
        name: "Triager",
        summonable: false,
        blockedReason: "agent_disabled",
        linkEnabled: true,
      },
      {
        id: "core:reviewer",
        stem: "reviewer",
        name: "Reviewer",
        summonable: true,
        blockedReason: null,
        linkEnabled: true,
      },
    ]);

    const response = await getActivityPulse("proj-1", {
      since: null,
      salience: "low",
      now: new Date("2026-07-27T12:00:00.000Z"),
      client: client as never,
    });

    expect(response.agents.items).toEqual([
      {
        agentId: "core:triager",
        stem: "triager",
        displayName: "Triager",
        enabled: true,
        summonable: false,
        summonBlockedReason: "agent_disabled",
      },
      {
        agentId: "core:reviewer",
        stem: "reviewer",
        displayName: "Reviewer",
        enabled: true,
        summonable: true,
        summonBlockedReason: null,
      },
    ]);
  });

  it("REQ-B2 AC2 — a disabled attachment reports `enabled: false` with the link_disabled reason", async () => {
    const client = makeClient([[{ id: 3 }], []]);

    needsYouMocks.listProjectNeedsYou.mockResolvedValue([]);
    summonabilityMocks.listMentionCandidateAgents.mockResolvedValue([
      {
        id: "core:paused",
        stem: "paused",
        name: "Paused",
        summonable: false,
        blockedReason: "link_disabled",
        linkEnabled: false,
      },
    ]);

    const response = await getActivityPulse("proj-1", {
      since: null,
      salience: "low",
      now: new Date("2026-07-27T12:00:00.000Z"),
      client: client as never,
    });

    expect(response.agents.items[0]).toMatchObject({
      enabled: false,
      summonBlockedReason: "link_disabled",
    });
  });

  it("REQ-A4 AC1/AC2 — a promotable run appears in neither now.runs nor needsYou.items", async () => {
    const client = makeClient([
      [{ id: 3 }],
      [
        {
          runId: "run-active",
          projectId: "proj-1",
          runKind: "flow",
          status: "Running",
          currentStepId: "implement",
          startedAt: new Date("2026-07-27T11:00:00.000Z"),
          taskId: "task-active",
          taskTitle: "Still working",
          projectTaskKey: "OPS",
          taskNumber: 3,
        },
      ],
      [],
      [{ attempt: 1 }],
    ]);

    needsYouMocks.listProjectNeedsYou.mockResolvedValue([]);
    promotableMocks.listProjectPromotable.mockResolvedValue([
      {
        runId: "run-promotable",
        taskId: "task-promotable",
        taskKey: "OPS-9",
        taskTitle: "Ready to ship",
        targetBranch: "main",
        readiness: "ready",
        inReviewSince: new Date("2026-07-27T10:00:00.000Z"),
      },
    ]);

    const response = await getActivityPulse("proj-1", {
      since: null,
      salience: "low",
      now: new Date("2026-07-27T12:00:00.000Z"),
      client: client as never,
    });

    expect(response.needsYou.promotable.map((item) => item.runId)).toEqual([
      "run-promotable",
    ]);
    expect(response.now.runs.map((run) => run.runId)).not.toContain(
      "run-promotable",
    );
    expect(response.needsYou.items.map((item) => item.runId)).not.toContain(
      "run-promotable",
    );
  });
});

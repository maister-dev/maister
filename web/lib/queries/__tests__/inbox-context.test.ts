import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDb,
  mockDiffChangeStats,
  mockDiffRunWorkspace,
  mockResolveBaseRef,
  mockPrepareDiffSummary,
  mockProjectRunTranscript,
  mockResolveManifest,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockDiffChangeStats: vi.fn(),
  mockDiffRunWorkspace: vi.fn(),
  mockResolveBaseRef: vi.fn(),
  mockPrepareDiffSummary: vi.fn(),
  mockProjectRunTranscript: vi.fn(),
  mockResolveManifest: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: mockGetDb,
}));

vi.mock("@/lib/worktree", () => ({
  diffChangeStats: mockDiffChangeStats,
  diffRunWorkspace: mockDiffRunWorkspace,
  resolveBaseRef: mockResolveBaseRef,
}));

vi.mock("@/lib/diff/prepare", () => ({
  prepareDiffSummary: mockPrepareDiffSummary,
}));

vi.mock("@/lib/runs/run-transcript-projector", () => ({
  projectRunTranscript: mockProjectRunTranscript,
}));

vi.mock("@/lib/flows/graph/current-node-kind", () => ({
  resolveManifest: mockResolveManifest,
}));

import * as schema from "@/lib/db/schema";
import {
  extractLastAgentMessage,
  getInboxCardContext,
} from "@/lib/queries/inbox-context";

function ev(
  sessionUpdate: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "session.update",
    update: { sessionUpdate, ...extra },
  });
}

function msg(text: string): string {
  return ev("agent_message_chunk", { content: { text } });
}

function toolCall(id: string): string {
  return ev("tool_call", {
    toolCallId: id,
    kind: "execute",
    status: "pending",
    rawInput: {},
  });
}

describe("extractLastAgentMessage", () => {
  it("returns null when there is no agent message", () => {
    expect(extractLastAgentMessage("")).toBeNull();
    expect(extractLastAgentMessage(toolCall("t1"))).toBeNull();
  });

  it("coalesces consecutive agent_message_chunk text", () => {
    const log = [msg("Hello "), msg("world")].join("\n");

    expect(extractLastAgentMessage(log)).toBe("Hello world");
  });

  it("returns only the trailing message after the last tool call", () => {
    const log = [msg("first answer"), toolCall("t1"), msg("final answer")].join(
      "\n",
    );

    expect(extractLastAgentMessage(log)).toBe("final answer");
  });

  it("ignores blank lines, malformed JSON, and non-update events", () => {
    const log = [
      "",
      "{ not json",
      JSON.stringify({ type: "session.exited" }),
      msg("ok"),
    ].join("\n");

    expect(extractLastAgentMessage(log)).toBe("ok");
  });

  it("caps an overly long message with an ellipsis", () => {
    const out = extractLastAgentMessage(msg("x".repeat(1500)));

    expect(out).toHaveLength(1001);
    expect(out?.endsWith("…")).toBe(true);
  });
});

function createMockDb(tables: Map<unknown, unknown[]>) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows = tables.get(table) ?? [];
        const query = {
          where: () => query,
          innerJoin: () => query,
          leftJoin: () => query,
          orderBy: () => query,
          limit: () => Promise.resolve(rows),
          then: (
            onFulfilled: (value: unknown[]) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => Promise.resolve(rows).then(onFulfilled, onRejected),
        };

        return query;
      },
    }),
  };
}

describe("getInboxCardContext diff summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectRunTranscript.mockResolvedValue(undefined);
    mockResolveManifest.mockResolvedValue(null);
  });

  it("uses diffChangeStats instead of diffRunWorkspace or prepareDiffSummary and sums multi-file + binary entries", async () => {
    const baseCommit = "a".repeat(40);

    mockGetDb.mockReturnValue(
      createMockDb(
        new Map<unknown, unknown[]>([
          [
            schema.workspaces,
            [
              {
                runId: "run-1",
                worktreePath: "/tmp/wt-1",
                branch: "maister/task-1",
                baseCommit,
                removedAt: null,
              },
            ],
          ],
          [schema.projects, [{ mainBranch: "main" }]],
          [schema.runMessages, []],
          [schema.hitlRequests, []],
        ]),
      ),
    );
    mockDiffChangeStats.mockResolvedValue([
      {
        path: "src/a.ts",
        status: "M",
        additions: 12,
        deletions: 4,
        binary: false,
      },
      {
        path: "src/b.ts",
        status: "A",
        additions: 30,
        deletions: 0,
        binary: false,
      },
      {
        path: "assets/logo.png",
        status: "A",
        additions: 0,
        deletions: 0,
        binary: true,
      },
    ]);

    const ctx = await getInboxCardContext({
      id: "run-1",
      projectId: "proj-1",
      currentStepId: null,
      flowRevisionId: null,
      flowId: null,
    });

    expect(ctx.diff).toEqual({ files: 3, additions: 42, deletions: 4 });
    expect(mockDiffChangeStats).toHaveBeenCalledTimes(1);
    expect(mockDiffChangeStats).toHaveBeenCalledWith({
      worktreePath: "/tmp/wt-1",
      baseRef: baseCommit,
      branch: "maister/task-1",
    });
    expect(mockDiffRunWorkspace).not.toHaveBeenCalled();
    expect(mockPrepareDiffSummary).not.toHaveBeenCalled();
  });

  it("falls back to resolveBaseRef when baseCommit is null and degrades to null on diffChangeStats error", async () => {
    mockGetDb.mockReturnValue(
      createMockDb(
        new Map<unknown, unknown[]>([
          [
            schema.workspaces,
            [
              {
                runId: "run-2",
                worktreePath: "/tmp/wt-2",
                branch: "maister/task-2",
                baseCommit: null,
                removedAt: null,
              },
            ],
          ],
          [schema.projects, [{ mainBranch: "main" }]],
          [schema.runMessages, []],
          [schema.hitlRequests, []],
        ]),
      ),
    );
    mockResolveBaseRef.mockResolvedValue("main");
    mockDiffChangeStats.mockResolvedValueOnce([
      {
        path: "README.md",
        status: "M",
        additions: 5,
        deletions: 2,
        binary: false,
      },
    ]);

    const okCtx = await getInboxCardContext({
      id: "run-2",
      projectId: "proj-1",
      currentStepId: null,
      flowRevisionId: null,
      flowId: null,
    });

    expect(okCtx.diff).toEqual({ files: 1, additions: 5, deletions: 2 });
    expect(mockDiffChangeStats).toHaveBeenCalledWith({
      worktreePath: "/tmp/wt-2",
      baseRef: "main",
      branch: "maister/task-2",
    });
    expect(mockDiffRunWorkspace).not.toHaveBeenCalled();
    expect(mockPrepareDiffSummary).not.toHaveBeenCalled();

    mockDiffChangeStats.mockRejectedValueOnce(new Error("git failed"));

    const failedCtx = await getInboxCardContext({
      id: "run-2",
      projectId: "proj-1",
      currentStepId: null,
      flowRevisionId: null,
      flowId: null,
    });

    expect(failedCtx.diff).toBeNull();
  });
});

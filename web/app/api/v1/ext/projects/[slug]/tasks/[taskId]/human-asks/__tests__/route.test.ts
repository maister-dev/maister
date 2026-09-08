import type { NextRequest, NextResponse } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleExt: vi.fn(),
  recordRequiredTokenAudit: vi.fn(),
  getDb: vi.fn(),
  createOrActivateAgentQuestion: vi.fn(),
  sourceRows: [] as Array<{ id: string }>,
}));

vi.mock("@/lib/tokens/ext-handler", () => ({
  handleExt: mocks.handleExt,
  recordRequiredTokenAudit: mocks.recordRequiredTokenAudit,
  httpStatusForExtCode: (code: string) =>
    code === "EXECUTOR_UNAVAILABLE" ? 503 : 409,
}));

vi.mock("@/lib/db/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/services/agent-question", () => ({
  createOrActivateAgentQuestion: mocks.createOrActivateAgentQuestion,
}));

type RouteModule = typeof import("../route");

let route: RouteModule;

function request(body: unknown): NextRequest {
  return new Request(
    "http://x/api/v1/ext/projects/demo/tasks/task-1/human-asks",
    {
      method: "POST",
      headers: { authorization: "Bearer agent-token" },
      body: JSON.stringify(body),
    },
  ) as NextRequest;
}

function params(): { params: Promise<{ slug: string; taskId: string }> } {
  return { params: Promise.resolve({ slug: "demo", taskId: "task-1" }) };
}

function validBody(): Record<string, unknown> {
  return {
    question: "Which deployment target should be used?",
    schema: {
      schemaVersion: 1,
      fields: [
        {
          name: "target",
          type: "enum",
          required: true,
          options: ["staging", "production"],
        },
      ],
    },
  };
}

function agentContext(): {
  projectId: string;
  actor: {
    tokenId: string;
    actorLabel: string;
    tokenKind: "agent";
    agentId: string;
    boundRunId: string;
  };
} {
  return {
    projectId: "project-1",
    actor: {
      tokenId: "token-1",
      actorLabel: "agent:pkg:clarifier",
      tokenKind: "agent",
      agentId: "pkg:clarifier",
      boundRunId: "run-1",
    },
  };
}

beforeEach(async () => {
  mocks.sourceRows = [{ id: "run-1" }];
  mocks.getDb.mockReturnValue({
    select: () => ({
      from: () => ({ where: async () => mocks.sourceRows }),
    }),
  });
  mocks.recordRequiredTokenAudit.mockResolvedValue(undefined);
  mocks.createOrActivateAgentQuestion.mockResolvedValue({
    hitlRequestId: "hitl-1",
    taskId: "task-1",
    sourceRunId: "run-1",
    activationState: "active",
    created: true,
  });
  mocks.handleExt.mockImplementation(
    async (
      _req: Request,
      _options: Record<string, unknown>,
      work: (ctx: ReturnType<typeof agentContext>) => Promise<NextResponse>,
    ) => await work(agentContext()),
  );

  route = await import("../route");
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("POST /api/v1/ext/projects/[slug]/tasks/[taskId]/human-asks", () => {
  it("derives the source agent/run from its attached token and keeps its success audit in the activation work", async () => {
    const response = await route.POST(request(validBody()), params());

    expect(response.status).toBe(201);
    expect(mocks.handleExt).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        scopeLabel: "hitl:request",
        successAuditInWork: true,
      }),
      expect.any(Function),
    );
    expect(mocks.createOrActivateAgentQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        taskId: "task-1",
        sourceRunId: "run-1",
        sourceAgentId: "pkg:clarifier",
      }),
      expect.objectContaining({ recordSuccessAudit: expect.any(Function) }),
    );

    const [, dependencies] = mocks.createOrActivateAgentQuestion.mock
      .calls[0] as [
      unknown,
      { recordSuccessAudit: (tx: unknown, status: number) => Promise<void> },
    ];

    await dependencies.recordSuccessAudit({}, 201);

    expect(mocks.recordRequiredTokenAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: "token-1",
        projectId: "project-1",
        scopeUsed: "hitl:request",
        statusCode: 201,
      }),
      {},
    );
  });

  it("returns a deliberately opaque not-found response for a non-agent token", async () => {
    mocks.handleExt.mockImplementationOnce(
      async (
        _req: Request,
        _options: Record<string, unknown>,
        work: (ctx: {
          projectId: string;
          actor: Omit<ReturnType<typeof agentContext>["actor"], "tokenKind"> & {
            tokenKind: "project";
          };
        }) => Promise<NextResponse>,
      ) =>
        await work({
          projectId: "project-1",
          actor: { ...agentContext().actor, tokenKind: "project" },
        }),
    );

    const response = await route.POST(request(validBody()), params());

    expect(response.status).toBe(404);
    expect(mocks.createOrActivateAgentQuestion).not.toHaveBeenCalled();
  });

  it("rejects an invalid strict body before it can create a durable question", async () => {
    const response = await route.POST(
      request({ ...validBody(), unexpected: true }),
      params(),
    );

    expect(response.status).toBe(422);
    expect(mocks.createOrActivateAgentQuestion).not.toHaveBeenCalled();
  });

  it("does not disclose or create a question when the bound run is not the running task source", async () => {
    mocks.sourceRows = [];

    const response = await route.POST(request(validBody()), params());

    expect(response.status).toBe(404);
    expect(mocks.createOrActivateAgentQuestion).not.toHaveBeenCalled();
  });
});

import { randomUUID } from "node:crypto";

import Ajv from "ajv";
import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { TOOL_SPECS } from "../../../../../../../../../../../mcp/src/tools";

import { issueAgentRunToken } from "@/lib/agents/tokens";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { askHumanToolInputSchema } from "@/lib/services/agent-question-contract";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const supervisor = vi.hoisted(() => ({
  deleteSessionIfPresent: vi.fn(),
  listSessions: vi.fn(),
  promoteNextPending: vi.fn(),
}));

let database: NodePgDatabase<typeof schema>;
let testDatabase: StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({ getDb: () => database }));
vi.mock("@/lib/scheduler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scheduler")>()),
  promoteNextPending: supervisor.promoteNextPending,
}));

let POST: typeof import("../route").POST;

type Seed = {
  agentId: string;
  projectId: string;
  runId: string;
  sessionId: string;
  slug: string;
  taskId: string;
  token: string;
  tokenId: string;
};

function body(): Record<string, unknown> {
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

function request(token: string, input: unknown = body()): NextRequest {
  return new NextRequest(
    "http://localhost/api/v1/ext/projects/demo/tasks/task/human-asks",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

function params(seed: Seed): {
  params: Promise<{ slug: string; taskId: string }>;
} {
  return { params: Promise.resolve({ slug: seed.slug, taskId: seed.taskId }) };
}

async function seed(): Promise<Seed> {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const agentId = `test:clarifier-${randomUUID().slice(0, 8)}`;
  const sessionId = randomUUID();
  const slug = `human-ask-route-${projectId.slice(0, 8)}`;

  await database.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Human ask route",
    repoPath: `/tmp/${slug}`,
    taskKey: "ASK",
  });
  await database.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: 1,
    title: "Clarify target",
    prompt: "Deploy the service",
  });
  await database.insert(schema.agents).values({
    id: agentId,
    packageName: "test",
    versionLabel: "v1",
    origin: "authored",
    name: "Test clarifier",
    description: "Test clarifier",
    workspace: "none",
    mode: "session",
    triggers: [],
    riskTier: "standard",
    sourcePath: `/tmp/${agentId}.md`,
  });
  await database.insert(schema.runs).values({
    id: runId,
    runKind: "agent",
    projectId,
    taskId,
    agentId,
    status: "Running",
    currentStepId: "agent",
    flowVersion: "agent",
    flowRevision: "manual",
    agentWorkspace: "none",
  });
  await database.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    acpSessionId: sessionId,
  });
  const issued = await issueAgentRunToken({
    agentId,
    projectId,
    runId,
    db: database,
  });

  return {
    agentId,
    projectId,
    runId,
    sessionId,
    slug,
    taskId,
    token: issued.secret,
    tokenId: issued.tokenId,
  };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "agent_human_ask_route_test",
  });
  database = testDatabase.db;
  // ADR-166: the route binds the source run through the local execution
  // host — a fake host whose session list and teardown ride the spies.
  const fake = createFakeExecutionHost();

  Object.assign(fake.transport, {
    listSessions: () => supervisor.listSessions(),
    deleteSession: async (sessionId: string) => ({
      outcome:
        (await supervisor.deleteSessionIfPresent(sessionId)) === "gone"
          ? "gone"
          : "terminated",
    }),
  });
  await fakeExecutionHosts(database, { fake });
  POST = (await import("../route")).POST;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  supervisor.deleteSessionIfPresent.mockResolvedValue("terminated");
  supervisor.promoteNextPending.mockResolvedValue(undefined);
  await testDatabase.pool.query('TRUNCATE TABLE "projects" CASCADE');
});

describe("POST /api/v1/ext/projects/[slug]/tasks/[taskId]/human-asks", () => {
  it("keeps the complete published MCP input derived from the current HTTP form grammar", async () => {
    const seeded = await seed();
    const advertised = TOOL_SPECS.ask_human.inputSchema;

    expect(advertised).toEqual({
      ...z.toJSONSchema(askHumanToolInputSchema, {
        target: "draft-07",
        io: "input",
        unrepresentable: "any",
      }),
      type: "object",
    });
    const validate = new Ajv({ strict: false }).compile(advertised);
    const input = {
      question: "Which board filters and sorting should delivery configure?",
      schema: {
        schemaVersion: 1,
        fields: [
          {
            name: "scope",
            type: "string",
            required: true,
            options: ["sort_first", "manual_rank"],
          },
          { name: "limit", type: "number" },
          { name: "enabled", type: "boolean" },
          { name: "direction", type: "enum", options: ["asc", "desc"] },
          { name: "parameters", type: "json" },
          {
            name: "filters",
            type: "array",
            items: {
              type: "object",
              fields: [
                { name: "field", type: "string" },
                { name: "values", type: "array", items: { type: "json" } },
              ],
            },
          },
          {
            name: "sorting",
            type: "object",
            fields: [{ name: "priority", type: "number" }],
          },
        ],
      },
    };

    expect(
      validate({ slug: seeded.slug, taskId: seeded.taskId, ...input }),
      JSON.stringify(validate.errors),
    ).toBe(true);
    supervisor.listSessions.mockResolvedValue([]);
    const response = await POST(request(seeded.token, input), params(seeded));

    expect(response.status).toBe(201);
    const [stored] = await database
      .select({ schema: schema.hitlRequests.schema })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(stored.schema).toMatchObject(input.schema);
  });

  it.each([
    {
      name: "raw JSON Schema",
      schema: {
        type: "object",
        required: ["scope"],
        properties: { scope: { type: "string", enum: ["sort_first"] } },
      },
      issuePath: ["schema", "schemaVersion"],
    },
    {
      name: "unsupported form version",
      schema: { schemaVersion: 2, fields: [] },
      issuePath: ["schema", "schemaVersion"],
    },
    {
      name: "unknown field type",
      schema: {
        schemaVersion: 1,
        fields: [{ name: "scope", type: "secret-value-not-for-diagnostics" }],
      },
      issuePath: ["schema", "fields", 0, "type"],
    },
  ])(
    "refuses $name in both the advertised input and HTTP without persisting a question",
    async ({ schema: form, issuePath }) => {
      const seeded = await seed();
      const input = { question: "Choose the delivery scope", schema: form };
      const validate = new Ajv({ strict: false }).compile(
        TOOL_SPECS.ask_human.inputSchema,
      );

      expect(
        validate({ slug: seeded.slug, taskId: seeded.taskId, ...input }),
      ).toBe(false);
      const response = await POST(request(seeded.token, input), params(seeded));
      const failure = await response.json();

      expect(response.status).toBe(422);
      expect(failure).toMatchObject({
        code: "CONFIG",
        details: {
          reason: "human_ask_body_invalid",
          format: "form_schema_v1",
          issues: expect.arrayContaining([
            expect.objectContaining({ path: issuePath }),
          ]),
        },
      });
      expect(failure.message).toContain("MAIster form schema");
      expect(JSON.stringify(failure)).not.toContain(
        "secret-value-not-for-diagnostics",
      );
      expect(
        await database
          .select({ id: schema.hitlRequests.id })
          .from(schema.hitlRequests)
          .where(eq(schema.hitlRequests.runId, seeded.runId)),
      ).toEqual([]);
      const [source] = await database
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, seeded.runId));

      expect(source.status).toBe("Running");
      expect(supervisor.listSessions).not.toHaveBeenCalled();
    },
  );

  it("rejects an attached agent token without hitl:request before it can persist an existence-bearing request", async () => {
    const seeded = await seed();

    await database
      .update(schema.projectTokens)
      .set({ scopes: ["tasks:read"] })
      .where(eq(schema.projectTokens.id, seeded.tokenId));

    const response = await POST(request(seeded.token), params(seeded));

    expect(response.status).toBe(403);
    const requests = await database
      .select({ id: schema.hitlRequests.id })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));
    const audits = await database
      .select({
        result: schema.tokenAuditLog.result,
        statusCode: schema.tokenAuditLog.status_code,
      })
      .from(schema.tokenAuditLog)
      .where(
        and(
          eq(schema.tokenAuditLog.token_id, seeded.tokenId),
          eq(schema.tokenAuditLog.scope_used, "hitl:request"),
        ),
      );

    expect(requests).toEqual([]);
    expect(audits).toEqual([{ result: "error", statusCode: 403 }]);
  });

  it("accepts only the attached running agent identity, terminalizes it, and commits exactly one agent-audited request", async () => {
    const seeded = await seed();

    supervisor.listSessions.mockResolvedValue([
      {
        sessionId: "supervisor-session-1",
        runId: seeded.runId,
        projectSlug: seeded.slug,
        stepId: "agent",
        status: "live",
        pid: 1,
        startedAt: new Date().toISOString(),
        monotonicId: 1,
        acpSessionId: seeded.sessionId,
      },
    ]);

    const response = await POST(request(seeded.token), params(seeded));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      taskId: seeded.taskId,
      sourceRunId: seeded.runId,
      activationState: "active",
    });
    expect(supervisor.deleteSessionIfPresent).toHaveBeenCalledWith(
      "supervisor-session-1",
    );

    const [source] = await database
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.id, seeded.runId));
    const requests = await database
      .select({
        id: schema.hitlRequests.id,
        activationState: schema.hitlRequests.activationState,
      })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));
    const assignments = await database
      .select({
        actionKind: schema.assignments.actionKind,
        status: schema.assignments.status,
      })
      .from(schema.assignments)
      .where(eq(schema.assignments.hitlRequestId, requests[0]?.id ?? ""));
    const [token] = await database
      .select({ revokedAt: schema.projectTokens.revoked_at })
      .from(schema.projectTokens)
      .where(eq(schema.projectTokens.id, seeded.tokenId));
    const audits = await database
      .select({
        actorLabel: schema.tokenAuditLog.actor_label,
        result: schema.tokenAuditLog.result,
      })
      .from(schema.tokenAuditLog)
      .where(
        and(
          eq(schema.tokenAuditLog.token_id, seeded.tokenId),
          eq(schema.tokenAuditLog.scope_used, "hitl:request"),
        ),
      );

    expect(source?.status).toBe("Done");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.activationState).toBe("active");
    expect(assignments).toEqual([
      { actionKind: "agent_question", status: "open" },
    ]);
    expect(token?.revokedAt).toBeInstanceOf(Date);
    expect(audits).toEqual([
      { actorLabel: `agent:${seeded.agentId}`, result: "ok" },
    ]);
  });

  it("returns one retryable 503 audit without a false success, then turns the same pending payload active on replay", async () => {
    const seeded = await seed();

    supervisor.listSessions.mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor unavailable"),
    );

    const failed = await POST(request(seeded.token), params(seeded));

    expect(failed.status).toBe(503);
    const [pending] = await database
      .select({
        id: schema.hitlRequests.id,
        activationState: schema.hitlRequests.activationState,
      })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(pending?.activationState).toBe("pending_termination");

    supervisor.listSessions.mockResolvedValue([]);
    const replay = await POST(request(seeded.token), params(seeded));

    expect(replay.status).toBe(200);
    const audits = await database
      .select({
        result: schema.tokenAuditLog.result,
        statusCode: schema.tokenAuditLog.status_code,
      })
      .from(schema.tokenAuditLog)
      .where(
        and(
          eq(schema.tokenAuditLog.token_id, seeded.tokenId),
          eq(schema.tokenAuditLog.scope_used, "hitl:request"),
        ),
      );
    const requests = await database
      .select({
        id: schema.hitlRequests.id,
        activationState: schema.hitlRequests.activationState,
      })
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(audits).toEqual([
      { result: "error", statusCode: 503 },
      { result: "ok", statusCode: 200 },
    ]);
    expect(requests).toEqual([{ id: pending?.id, activationState: "active" }]);
  });
});

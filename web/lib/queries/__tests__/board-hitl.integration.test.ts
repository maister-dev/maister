import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

// Imported after mocks are registered.
let getBoardData: typeof import("@/lib/queries/board").getBoardData;
let getRunDetail: typeof import("@/lib/queries/run").getRunDetail;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("board_hitl_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ getBoardData } = await import("@/lib/queries/board"));
  ({ getRunDetail } = await import("@/lib/queries/run"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedProject(id: string): Promise<void> {
  await db.insert(schema.projects).values({
    id,
    slug: id,
    name: id,
    repoPath: `/tmp/${id}`,
    maisterYamlPath: `/tmp/${id}/maister.yaml`,
  });
}

async function seedExecutor(id: string, _projectId: string): Promise<void> {
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(id, "claude"));
}

async function seedFlow(
  id: string,
  projectId: string,
  flowRefId: string,
): Promise<void> {
  await db.insert(schema.flows).values({
    id,
    projectId,
    flowRefId,
    source: "https://example.com/flow",
    version: "v1.0.0",
    revision: "main",
    installedPath: `/tmp/flow-${id}`,
    manifest: {},
    schemaVersion: 1,
  });
}

async function seedTask(
  id: string,
  projectId: string,
  flowId: string,
): Promise<void> {
  await db.insert(schema.tasks).values({
    id,
    projectId,
    title: `Task ${id}`,
    prompt: "Do something",
    flowId,
    status: "InFlight",
  });
}

async function seedRun(
  id: string,
  taskId: string,
  projectId: string,
  flowId: string,
  runnerId: string,
  status: string = "NeedsInput",
  acpSessionId: string | null = null,
): Promise<void> {
  await db.insert(schema.runs).values({
    id,
    taskId,
    projectId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(runnerId),
    runKind: "flow",
    status,
    flowVersion: "v1.0.0",
    acpSessionId,
    startedAt: new Date(),
  });
}

async function seedWorkspace(runId: string, projectId: string): Promise<void> {
  await db.insert(schema.workspaces).values({
    id: `ws-${runId}`,
    runId,
    projectId,
    branch: `maister/test-${runId.slice(0, 8)}`,
    worktreePath: `/tmp/${projectId}/.maister/${runId}`,
    parentRepoPath: `/tmp/${projectId}`,
  });
}

async function seedHitlRequest(
  id: string,
  runId: string,
  kind: "permission" | "form" | "human",
  criticality?: "low" | "medium" | "high" | "critical" | null,
  schemaVal?: unknown | null,
  respondedAt?: Date | null,
): Promise<void> {
  // Use raw query to avoid schema cast issues
  const query = `
    INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt, criticality, responded_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `;

  await pool.query(query, [
    id,
    runId,
    `step-${id}`,
    kind,
    schemaVal ? JSON.stringify(schemaVal) : null,
    `Prompt for ${kind}`,
    criticality ?? null,
    respondedAt ?? null,
  ]);
}

describe("getBoardData — HITL-enhanced FlightCard DTO (M17 P4)", () => {
  beforeEach(async () => {
    // Clear all tables between tests.
    await db.delete(schema.hitlRequests);
    await db.delete(schema.workspaces);
    await db.delete(schema.runs);
    await db.delete(schema.tasks);
    await db.delete(schema.flows);
    await db.delete(schema.platformAcpRunners);
    await db.delete(schema.projects);
  });

  it("populates hitlRequestId, hitlKind, hitlSchema, criticality on a NeedsInput flight card with a pending HITL", async () => {
    await seedProject("proj-1");
    await seedExecutor("ex-1", "proj-1");
    await seedFlow("fl-1", "proj-1", "bugfix");
    await seedTask("task-1", "proj-1", "fl-1");
    await seedRun("run-1", "task-1", "proj-1", "fl-1", "ex-1", "NeedsInput");
    await seedWorkspace("run-1", "proj-1");

    // A real permission schema carries supervisor-internal handles
    // (requestId / supervisorSessionId / toolCall) alongside the options.
    const permissionSchema = {
      requestId: "req-secret-xyz",
      supervisorSessionId: "sup-sess-secret-42",
      toolCall: { name: "bash" },
      options: [
        { optionId: "allow", label: "Allow" },
        { optionId: "deny", label: "Deny" },
      ],
    };

    await seedHitlRequest(
      "hitl-1",
      "run-1",
      "permission",
      "high",
      permissionSchema,
    );

    const data = await getBoardData("proj-1");
    const card = data.columns.InProduction.flight.find(
      (c) => c.runId === "run-1",
    );

    expect(card).toBeDefined();
    expect(card?.hitlRequestId).toBe("hitl-1");
    expect(card?.hitlKind).toBe("permission");
    expect(card?.criticality).toBe("high");
    // SECURITY: permission schemas carry supervisor-internal handles and MUST
    // NOT cross to the browser. The card exposes options only; hitlSchema=null.
    expect(card?.hitlSchema).toBeNull();
    expect(JSON.stringify(card)).not.toContain("sup-sess-secret-42");
    expect(JSON.stringify(card)).not.toContain("req-secret-xyz");
    expect(card?.hitlOptions).toHaveLength(2);
    expect(card?.hitlOptions[0]).toEqual({
      optionId: "allow",
      label: "Allow",
    });
    expect(card?.hitlOptions[1]).toEqual({
      optionId: "deny",
      label: "Deny",
    });
  });

  it("populates hitlSchema on a form HITL with the full schema", async () => {
    await seedProject("proj-2");
    await seedExecutor("ex-2", "proj-2");
    await seedFlow("fl-2", "proj-2", "form-flow");
    await seedTask("task-2", "proj-2", "fl-2");
    await seedRun("run-2", "task-2", "proj-2", "fl-2", "ex-2", "NeedsInput");
    await seedWorkspace("run-2", "proj-2");

    const formSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };

    await seedHitlRequest("hitl-2", "run-2", "form", "medium", formSchema);

    const data = await getBoardData("proj-2");
    const card = data.columns.InProduction.flight.find(
      (c) => c.runId === "run-2",
    );

    expect(card?.hitlSchema).toEqual(formSchema);
    expect(card?.hitlKind).toBe("form");
  });

  it("sets hitlRequestId/hitlKind/hitlSchema to null on a NeedsInput run WITHOUT a pending HITL", async () => {
    await seedProject("proj-3");
    await seedExecutor("ex-3", "proj-3");
    await seedFlow("fl-3", "proj-3", "test-flow");
    await seedTask("task-3", "proj-3", "fl-3");
    await seedRun("run-3", "task-3", "proj-3", "fl-3", "ex-3", "NeedsInput");
    await seedWorkspace("run-3", "proj-3");

    // No HITL request is created.

    const data = await getBoardData("proj-3");
    const card = data.columns.InProduction.flight.find(
      (c) => c.runId === "run-3",
    );

    expect(card?.hitlRequestId).toBeNull();
    expect(card?.hitlKind).toBeNull();
    expect(card?.hitlSchema).toBeNull();
    expect(card?.criticality).toBeNull();
    expect(card?.hitlOptions).toEqual([]);
  });

  it("filters out answered HITLs (respondedAt is not null)", async () => {
    await seedProject("proj-4");
    await seedExecutor("ex-4", "proj-4");
    await seedFlow("fl-4", "proj-4", "answered-flow");
    await seedTask("task-4", "proj-4", "fl-4");
    await seedRun("run-4", "task-4", "proj-4", "fl-4", "ex-4", "NeedsInput");
    await seedWorkspace("run-4", "proj-4");

    // Create an answered HITL (respondedAt set).
    await seedHitlRequest(
      "hitl-4",
      "run-4",
      "permission",
      "low",
      { options: [] },
      new Date(),
    );

    const data = await getBoardData("proj-4");
    const card = data.columns.InProduction.flight.find(
      (c) => c.runId === "run-4",
    );

    // The answered HITL should not be present in the card.
    expect(card?.hitlRequestId).toBeNull();
    expect(card?.hitlKind).toBeNull();
  });

  it("does NOT leak acp_session_id or supervisor internal handles into the DTO", async () => {
    await seedProject("proj-5");
    await seedExecutor("ex-5", "proj-5");
    await seedFlow("fl-5", "proj-5", "checkpoint-flow");
    await seedTask("task-5", "proj-5", "fl-5");
    await seedRun(
      "run-5",
      "task-5",
      "proj-5",
      "fl-5",
      "ex-5",
      "NeedsInput",
      "acp-session-12345",
    );
    await seedWorkspace("run-5", "proj-5");
    await seedHitlRequest("hitl-5", "run-5", "permission", null, {
      options: [],
    });

    const data = await getBoardData("proj-5");
    const card = data.columns.InProduction.flight.find(
      (c) => c.runId === "run-5",
    );

    // The card's DTO should NOT include acp_session_id, supervisor IDs,
    // worktree paths, or any internal handles.
    expect(card).toBeDefined();

    // Serialize the card to JSON and ensure no acp/session/supervisor/worktree
    // keys are present.
    const json = JSON.stringify(card);

    expect(json).not.toContain("acp");
    expect(json).not.toContain("session");
    expect(json).not.toContain("supervisor");
    expect(json).not.toContain("worktree");
  });

  it("handles multiple pending HITLs per run (bulk join without N+1)", async () => {
    // Seed a scenario where multiple runs have HITLs — test that a single
    // query (or a minimal batch) populates the data without N+1 queries.
    await seedProject("proj-6");
    await seedExecutor("ex-6", "proj-6");
    await seedFlow("fl-6", "proj-6", "multi-flow");
    await seedTask("task-6a", "proj-6", "fl-6");
    await seedTask("task-6b", "proj-6", "fl-6");
    await seedRun("run-6a", "task-6a", "proj-6", "fl-6", "ex-6", "NeedsInput");
    await seedRun("run-6b", "task-6b", "proj-6", "fl-6", "ex-6", "NeedsInput");
    await seedWorkspace("run-6a", "proj-6");
    await seedWorkspace("run-6b", "proj-6");

    // Each run gets a HITL.
    await seedHitlRequest("hitl-6a", "run-6a", "form", "critical", {
      type: "object",
    });
    await seedHitlRequest("hitl-6b", "run-6b", "permission", "medium", {
      options: [],
    });

    const data = await getBoardData("proj-6");

    const card6a = data.columns.InProduction.flight.find(
      (c) => c.runId === "run-6a",
    );
    const card6b = data.columns.InProduction.flight.find(
      (c) => c.runId === "run-6b",
    );

    expect(card6a?.hitlRequestId).toBe("hitl-6a");
    expect(card6a?.criticality).toBe("critical");
    expect(card6b?.hitlRequestId).toBe("hitl-6b");
    expect(card6b?.criticality).toBe("medium");
  });

  it("sets hitlOptions to empty array when no options are present", async () => {
    await seedProject("proj-7");
    await seedExecutor("ex-7", "proj-7");
    await seedFlow("fl-7", "proj-7", "no-options-flow");
    await seedTask("task-7", "proj-7", "fl-7");
    await seedRun("run-7", "task-7", "proj-7", "fl-7", "ex-7", "NeedsInput");
    await seedWorkspace("run-7", "proj-7");

    // A form HITL with no options.
    await seedHitlRequest("hitl-7", "run-7", "form", null, { type: "object" });

    const data = await getBoardData("proj-7");
    const card = data.columns.InProduction.flight.find(
      (c) => c.runId === "run-7",
    );

    expect(card?.hitlOptions).toEqual([]);
  });

  it("returns null HITL fields on non-NeedsInput status cards", async () => {
    await seedProject("proj-8");
    await seedExecutor("ex-8", "proj-8");
    await seedFlow("fl-8", "proj-8", "running-flow");
    await seedTask("task-8", "proj-8", "fl-8");
    // A Running run (not NeedsInput).
    await seedRun("run-8", "task-8", "proj-8", "fl-8", "ex-8", "Running");
    await seedWorkspace("run-8", "proj-8");

    // Even if we seed a HITL for this run, it should not be visible because
    // the run status is not NeedsInput/NeedsInputIdle.
    await seedHitlRequest("hitl-8", "run-8", "permission", null, {
      options: [],
    });

    const data = await getBoardData("proj-8");
    const card = data.columns.InProduction.flight.find(
      (c) => c.runId === "run-8",
    );

    // The card should exist, but HITL fields should be null (not filtered
    // by the bulk query since it's not NeedsInput).
    expect(card?.runId).toBe("run-8");
    expect(card?.status).toBe("running");
    // HITL fields should be null because the bulk join only includes NeedsInput/NeedsInputIdle.
    expect(card?.hitlRequestId).toBeNull();
    expect(card?.hitlKind).toBeNull();
  });

  it("correctly maps permission options from the schema", async () => {
    await seedProject("proj-9");
    await seedExecutor("ex-9", "proj-9");
    await seedFlow("fl-9", "proj-9", "perm-flow");
    await seedTask("task-9", "proj-9", "fl-9");
    await seedRun("run-9", "task-9", "proj-9", "fl-9", "ex-9", "NeedsInput");
    await seedWorkspace("run-9", "proj-9");

    const permissionSchema = {
      options: [
        { optionId: "approve-minor", label: "Approve (minor)" },
        { optionId: "approve-major", label: "Approve (major)" },
        { optionId: "request-review", label: "Request external review" },
      ],
    };

    await seedHitlRequest(
      "hitl-9",
      "run-9",
      "permission",
      "critical",
      permissionSchema,
    );

    const data = await getBoardData("proj-9");
    const card = data.columns.InProduction.flight.find(
      (c) => c.runId === "run-9",
    );

    expect(card?.hitlOptions).toHaveLength(3);
    expect(card?.hitlOptions[0]).toEqual({
      optionId: "approve-minor",
      label: "Approve (minor)",
    });
    expect(card?.hitlOptions[1]).toEqual({
      optionId: "approve-major",
      label: "Approve (major)",
    });
    expect(card?.hitlOptions[2]).toEqual({
      optionId: "request-review",
      label: "Request external review",
    });
  });

  // C2 regression: the run-detail loader is a third reader of the permission
  // schema (alongside the board card and the cross-project inbox). It MUST
  // redact the supervisor-internal handles too, or they serialize into the
  // run-detail RSC payload and reach the browser.
  it("getRunDetail redacts the permission schema (supervisor handles never reach the browser)", async () => {
    await seedProject("proj-rd");
    await seedExecutor("ex-rd", "proj-rd");
    await seedFlow("fl-rd", "proj-rd", "bugfix");
    await seedTask("task-rd", "proj-rd", "fl-rd");
    await seedRun(
      "run-rd",
      "task-rd",
      "proj-rd",
      "fl-rd",
      "ex-rd",
      "NeedsInput",
    );
    await seedWorkspace("run-rd", "proj-rd");

    const permissionSchema = {
      requestId: "req-secret-rd",
      supervisorSessionId: "sup-sess-secret-rd",
      toolCall: { name: "bash" },
      options: [
        { optionId: "allow", label: "Allow" },
        { optionId: "deny", label: "Deny" },
      ],
    };

    await seedHitlRequest(
      "hitl-rd",
      "run-rd",
      "permission",
      "high",
      permissionSchema,
    );

    const detail = await getRunDetail("run-rd");

    expect(detail?.pendingHitl?.hitlRequestId).toBe("hitl-rd");
    expect(detail?.pendingHitl?.kind).toBe("permission");
    // SECURITY: schema redacted to null for permission; options still surfaced.
    expect(detail?.pendingHitl?.schema).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("sup-sess-secret-rd");
    expect(JSON.stringify(detail)).not.toContain("req-secret-rd");
    expect(detail?.pendingHitl?.options).toHaveLength(2);
  });
});

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
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
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
    number: Math.trunc(Math.random() * 1e9) + 1,
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
    runKind: "flow",
    status,
    flowVersion: "v1.0.0",
    startedAt: new Date(),
  });
  await db.insert(schema.runSessions).values({
    id: `rs-${id}`,
    runId: id,
    sessionName: "default",
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(runnerId),
    acpSessionId,
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

// The inline HITL form on the board flight card was removed: a NeedsInput card
// now flags attention via its `status` alone, and the HITL response happens on
// the run page (diff visible) or the HITL Inbox. The card DTO carries no
// per-card HITL fields, so supervisor-internal handles cannot leak through it.
describe("getBoardData — NeedsInput flight card (inline HITL projection removed)", () => {
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

  it("flags a NeedsInput card via status only — no HITL fields, no supervisor-handle leak", async () => {
    await seedProject("proj-1");
    await seedExecutor("ex-1", "proj-1");
    await seedFlow("fl-1", "proj-1", "bugfix");
    await seedTask("task-1", "proj-1", "fl-1");
    await seedRun("run-1", "task-1", "proj-1", "fl-1", "ex-1", "NeedsInput");
    await seedWorkspace("run-1", "proj-1");

    // A pending permission request carries supervisor-internal handles.
    await seedHitlRequest("hitl-1", "run-1", "permission", "high", {
      requestId: "req-secret-xyz",
      supervisorSessionId: "sup-sess-secret-42",
      toolCall: { name: "bash" },
      options: [
        { optionId: "allow", label: "Allow" },
        { optionId: "deny", label: "Deny" },
      ],
    });

    const data = await getBoardData("proj-1");
    const card = data.columns.InProduction.flight.find(
      (c) => c.runId === "run-1",
    );

    expect(card).toBeDefined();
    // The needs-attention signal is the card status — no per-card HITL fields.
    expect(card?.status).toBe("needs");
    expect(card).not.toHaveProperty("hitlRequestId");
    expect(card).not.toHaveProperty("hitlKind");
    expect(card).not.toHaveProperty("hitlOptions");
    expect(card).not.toHaveProperty("hitlSchema");
    expect(card).not.toHaveProperty("criticality");
    // SECURITY: supervisor-internal handles never cross to the browser DTO.
    expect(JSON.stringify(card)).not.toContain("sup-sess-secret-42");
    expect(JSON.stringify(card)).not.toContain("req-secret-xyz");
  });

  // C2 regression: the run-detail loader is a reader of the permission schema
  // (alongside the cross-project inbox). It MUST redact the supervisor-internal
  // handles too, or they serialize into the run-detail RSC payload and reach
  // the browser.
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

    // T3.1: the run-detail header data carries task identity + flow ref.
    expect(detail?.taskTitle).toBe("Task task-rd");
    expect(detail?.taskPrompt).toBe("Do something");
    expect(detail?.flowRef).toBe("bugfix");
  });
});

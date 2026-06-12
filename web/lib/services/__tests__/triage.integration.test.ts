// M33 (ADR-088 D13) — the task.triage_requeued emitter (ONE transaction:
// stamp NULL + domain event + activity, M32 same-tx rule) and the web
// verdict PATCH semantics (SET/CLEAR, allow-list validation, no
// triage_status touch).

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { createTask } from "@/lib/services/tasks";
import {
  isValidGitBranchName,
  sendTaskToTriage,
  updateTaskVerdict,
} from "@/lib/services/triage";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const fx = { projectId: "", flowId: "", userId: "", taskId: "" };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("triage_service_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  fx.projectId = randomUUID();
  fx.flowId = randomUUID();
  fx.userId = randomUUID();

  await db.insert(schema.users).values({
    id: fx.userId,
    email: `u-${fx.userId.slice(0, 8)}@example.test`,
    name: "U",
    role: "member",
    accountStatus: "active",
  });
  await db.insert(schema.projects).values({
    id: fx.projectId,
    slug: "triage-svc",
    name: "Triage Svc",
    repoPath: "/tmp/triage-svc",
    maisterYamlPath: "/tmp/triage-svc/maister.yaml",
    taskKey: "TRS",
  });
  await db.insert(schema.flows).values({
    id: fx.flowId,
    projectId: fx.projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  const created = await createTask(
    { title: "t", prompt: "p" },
    { projectId: fx.projectId, actorUserId: fx.userId },
    db,
  );

  fx.taskId = created.taskId;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("updateTaskVerdict (web card PATCH semantics)", () => {
  it("sets fields, then clears them with explicit nulls — never touching triage_status", async () => {
    await pool.query(
      `UPDATE tasks SET triage_status = 'triaged' WHERE id = $1`,
      [fx.taskId],
    );

    await updateTaskVerdict(
      {
        taskId: fx.taskId,
        projectId: fx.projectId,
        patch: {
          flowId: fx.flowId,
          targetBranch: "main",
          promotionMode: "local_merge",
        },
      },
      db,
    );

    let row = (
      await pool.query(
        `SELECT flow_id, target_branch, promotion_mode, triage_status FROM tasks WHERE id = $1`,
        [fx.taskId],
      )
    ).rows[0];

    expect(row).toMatchObject({
      flow_id: fx.flowId,
      target_branch: "main",
      promotion_mode: "local_merge",
      triage_status: "triaged",
    });

    await updateTaskVerdict(
      {
        taskId: fx.taskId,
        projectId: fx.projectId,
        patch: { targetBranch: null, promotionMode: null },
      },
      db,
    );

    row = (
      await pool.query(
        `SELECT flow_id, target_branch, promotion_mode, triage_status FROM tasks WHERE id = $1`,
        [fx.taskId],
      )
    ).rows[0];

    expect(row).toMatchObject({
      flow_id: fx.flowId,
      target_branch: null,
      promotion_mode: null,
      triage_status: "triaged",
    });
  });

  it("rejects an empty patch and an unknown flow with CONFIG", async () => {
    await expect(
      updateTaskVerdict(
        { taskId: fx.taskId, projectId: fx.projectId, patch: {} },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    await expect(
      updateTaskVerdict(
        {
          taskId: fx.taskId,
          projectId: fx.projectId,
          patch: { flowId: randomUUID() },
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});

describe("sendTaskToTriage (the task.triage_requeued emitter, D13)", () => {
  it("clears the stamp, emits the domain event, and records the activity in one transaction", async () => {
    await sendTaskToTriage(
      {
        taskId: fx.taskId,
        projectId: fx.projectId,
        taskRef: "TRS-1",
        title: "t",
        actor: { type: "user", id: fx.userId },
      },
      db,
    );

    const task = await pool.query(
      `SELECT triage_status FROM tasks WHERE id = $1`,
      [fx.taskId],
    );

    expect(task.rows[0].triage_status).toBeNull();

    const events = await pool.query(
      `SELECT kind, actor_type, actor_id, payload FROM domain_events
       WHERE task_id = $1 AND kind = 'task.triage_requeued'`,
      [fx.taskId],
    );

    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      actor_type: "user",
      actor_id: fx.userId,
    });
    expect(events.rows[0].payload.taskKey).toBe("TRS-1");

    const activity = await pool.query(
      `SELECT actor_type FROM task_activity
       WHERE task_id = $1 AND event_kind = 'triage_requeued'`,
      [fx.taskId],
    );

    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0].actor_type).toBe("user");
  });
});

describe("isValidGitBranchName", () => {
  it("accepts normal branch shapes and rejects git-forbidden ones", () => {
    expect(isValidGitBranchName("main")).toBe(true);
    expect(isValidGitBranchName("maister/feature-x.y_z")).toBe(true);

    expect(isValidGitBranchName("")).toBe(false);
    expect(isValidGitBranchName("@")).toBe(false);
    expect(isValidGitBranchName("-leading-dash")).toBe(false);
    expect(isValidGitBranchName("has space")).toBe(false);
    expect(isValidGitBranchName("a..b")).toBe(false);
    expect(isValidGitBranchName("a@{b")).toBe(false);
    expect(isValidGitBranchName("a//b")).toBe(false);
    expect(isValidGitBranchName("/leading")).toBe(false);
    expect(isValidGitBranchName("trailing/")).toBe(false);
    expect(isValidGitBranchName("seg/.hidden")).toBe(false);
    expect(isValidGitBranchName("ref.lock")).toBe(false);
    expect(isValidGitBranchName("tilde~1")).toBe(false);
    expect(isValidGitBranchName("ends.")).toBe(false);
  });
});

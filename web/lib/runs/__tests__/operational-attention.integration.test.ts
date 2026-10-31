import type { Db } from "@/lib/execution-host/db";
import type {
  OperationalCleanup,
  OperationalTerminal,
} from "@/lib/run-results/operational-types";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { projects, runs, users, projectMembers } from "@/lib/db/schema";
import { operationalContractFixture } from "@/test-support/operational-agent";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;
const projectId = randomUUID();
const reader = randomUUID();
const other = randomUUID();
let currentUser = reader;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: currentUser } }),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "operational_attention",
  });
  db = database.db;
  await db.insert(projects).values({
    id: projectId,
    slug: "operational-attention",
    name: "Operations",
    taskKey: "OPAT",
    repoPath: "/tmp/operational-attention",
    maisterYamlPath: "/tmp/maister.yaml",
  });
  await db.insert(users).values([
    {
      id: reader,
      email: "op-reader@test.local",
      role: "member",
      accountStatus: "active",
    },
    {
      id: other,
      email: "op-other@test.local",
      role: "member",
      accountStatus: "active",
    },
  ]);
  await db.insert(projectMembers).values([
    { id: randomUUID(), projectId, userId: reader, role: "member" },
    { id: randomUUID(), projectId, userId: other, role: "viewer" },
  ]);
}, 180_000);
afterAll(async () => {
  await database?.stop();
});

async function seed(): Promise<string> {
  const id = randomUUID();
  const terminal: OperationalTerminal = {
    version: 1,
    status: "Failed",
    cause: "agent_exit",
    effectiveOutcome: "failed",
    successful: false,
    validation: "unchecked",
    integrity: "indeterminate",
    baselineGeneration: null,
    resultRevision: null,
    reasonCodes: ["result_missing"],
    evidenceIds: [],
  };
  const cleanup: OperationalCleanup = {
    version: 1,
    resourceKind: "plain_directory",
    workspace: "none",
    state: "exhausted",
    revision: 6,
    armedAt: new Date().toISOString(),
    attempts: 5,
    dueAt: null,
    errorCode: "operational_preservation_failed",
    evidenceIds: ["opaque-evidence"],
    removedAt: null,
    releasedAt: null,
    lease: null,
    rearmReceipt: null,
  };

  await db.insert(runs).values({
    id,
    projectId,
    runKind: "agent",
    agentKind: "operational",
    agentWorkspace: "none",
    flowVersion: "agent",
    status: "Failed",
    resultContract: operationalContractFixture("none"),
    operationalTerminal: terminal,
    operationalCleanup: cleanup,
    endedAt: new Date(),
  });

  return id;
}

describe("operational attention and cleanup mutation contracts", () => {
  it("IT-OPL-02 IT-EDGE-OPL-08 isolates reader acknowledgement and reopens a changed cleanup revision", async () => {
    const {
      listOperationalAttention,
      acknowledgeOperationalAttention,
      retryOperationalCleanup,
    } = await import("@/lib/runs/operational-attention");
    const runId = await seed();

    expect(
      await listOperationalAttention(db, reader, [projectId]),
    ).toHaveLength(2);
    await acknowledgeOperationalAttention(db, {
      runId,
      userId: reader,
      reason: "operation_failure",
      revision: 1,
    });
    await acknowledgeOperationalAttention(db, {
      runId,
      userId: reader,
      reason: "operation_failure",
      revision: 1,
    });
    await acknowledgeOperationalAttention(db, {
      runId,
      userId: reader,
      reason: "cleanup_failure",
      revision: 6,
    });
    expect(
      await listOperationalAttention(db, reader, [projectId]),
    ).toHaveLength(0);
    expect(await listOperationalAttention(db, other, [projectId])).toHaveLength(
      2,
    );
    await expect(
      acknowledgeOperationalAttention(db, {
        runId,
        userId: reader,
        reason: "cleanup_failure",
        revision: 5,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const armed = await retryOperationalCleanup(db, {
      runId,
      userId: reader,
      expectedRevision: 6,
    });

    expect(armed).toMatchObject({ state: "armed", revision: 7, attempts: 0 });
    expect(
      await retryOperationalCleanup(db, {
        runId,
        userId: reader,
        expectedRevision: 6,
      }),
    ).toEqual(armed);
    await expect(
      retryOperationalCleanup(db, {
        runId,
        userId: reader,
        expectedRevision: 5,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db
      .update(runs)
      .set({
        operationalCleanup: {
          ...armed,
          state: "exhausted",
          attempts: 5,
          dueAt: null,
          revision: 8,
          errorCode: "retry_failed",
        },
      })
      .where(eq(runs.id, runId));
    expect(
      await listOperationalAttention(db, reader, [projectId]),
    ).toMatchObject([{ reason: "cleanup_failure", revision: 8 }]);
    const { computeDecisionsQueue } = await import("@/lib/queries/decisions");
    const queue = await computeDecisionsQueue(reader, "member", { projectId });

    expect(queue.count).toBe(queue.items.length);
    expect(queue.items).toMatchObject([
      {
        kind: "operational",
        operational: { reason: "cleanup_failure", revision: 8 },
      },
    ]);
    expect(await computeDecisionsQueue(other, "member", { projectId })).toEqual(
      { items: [], count: 0 },
    );
  });

  it("IT-OPL-01 terminal operations leave portfolio, project and rail while default failed workspaces remain", async () => {
    const runId = await seed();
    const normal = randomUUID();

    await db.insert(runs).values({
      id: normal,
      projectId,
      runKind: "agent",
      agentWorkspace: "worktree",
      flowVersion: "agent",
      status: "Failed",
      endedAt: new Date(),
    });
    const { workspaces } = await import("@/lib/db/schema");

    await db.insert(workspaces).values(
      [runId, normal].map((id) => ({
        id: randomUUID(),
        projectId,
        runId: id,
        branch: `maister/${id}`,
        worktreePath: `/tmp/absent-${id}`,
        parentRepoPath: "/tmp/operational-attention",
        scheduledRemovalAt: new Date(Date.now() + 86400000),
      })),
    );
    const { getPortfolio, getRailWorkspaceGroups } =
      await import("@/lib/queries/portfolio");
    const { getProjectPageData } = await import("@/lib/queries/project");
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));
    const portfolio = await getPortfolio(reader, "member");
    const rail = await getRailWorkspaceGroups(reader, "member");
    const page = await getProjectPageData(project!);

    for (const rows of [
      portfolio.projects.flatMap((entry) => entry.activeWorkspaces),
      rail.flatMap((group) => group.workspaces),
      page.activeWorkspaces,
    ]) {
      expect(rows.some((row) => row.runId === runId)).toBe(false);
      expect(rows.some((row) => row.runId === normal)).toBe(true);
    }
    const { agents, agentProjectLinks, agentSchedules } =
      await import("@/lib/db/schema");
    const agentId = `fixture:${randomUUID()}`;

    await db.insert(agents).values({
      id: agentId,
      packageName: "fixture",
      versionLabel: "v1",
      origin: "git",
      name: "Operation",
      description: "Import",
      sourcePath: "/tmp/operation.md",
      riskTier: "standard",
      workspace: "none",
      mode: "session",
      triggers: ["cron"],
      kind: "operational",
      completionContract: { contract: "operational_v1" },
    });
    await db
      .insert(agentProjectLinks)
      .values({ id: randomUUID(), projectId, agentId });
    await db.insert(agentSchedules).values({
      id: randomUUID(),
      projectId,
      agentId,
      triggerType: "cron",
      cronExpr: "0 * * * *",
      timezone: "UTC",
      nextFireAt: new Date(Date.now() + 3600000),
      lastRunId: runId,
      lastOutcome: "launched",
    });
    const { listProjectAutomations } =
      await import("@/lib/scheduled-launches/queries");

    expect(
      (await listProjectAutomations({ projectId, limit: 50 })).rows,
    ).toMatchObject([
      {
        latestOutcome: "launched",
        resultingRun: { id: runId, status: "Failed" },
      },
    ]);
  });

  it("authorized wire mutations succeed, viewer mutations refuse and payloads expose no lease", async () => {
    const runId = await seed();
    const { acknowledgeOperationalRoute, retryOperationalRoute } =
      await import("@/lib/runs/operational-route");
    const request = (body: unknown) =>
      new NextRequest("http://localhost/api/runs/operational", {
        method: "POST",
        body: JSON.stringify(body),
      });

    currentUser = other;
    expect(
      (
        await acknowledgeOperationalRoute(
          request({ reason: "operation_failure", revision: 1 }),
          runId,
        )
      ).status,
    ).toBe(403);
    expect(
      (await retryOperationalRoute(request({ expectedRevision: 6 }), runId))
        .status,
    ).toBe(403);
    currentUser = reader;
    const ack = await acknowledgeOperationalRoute(
      request({ reason: "operation_failure", revision: 1 }),
      runId,
    );

    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ acknowledged: true, revision: 1 });
    const rearm = await retryOperationalRoute(
      request({ expectedRevision: 6 }),
      runId,
    );

    expect(rearm.status).toBe(202);
    expect(await rearm.json()).toEqual({
      state: "armed",
      revision: 7,
      attempts: 0,
      dueAt: expect.any(String),
      errorCode: null,
      evidenceIds: ["opaque-evidence"],
    });
  });
});

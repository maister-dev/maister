import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { createCompanyGrants } from "@/lib/company/grants";
import { seedNativeFindingsExecution } from "@/test-support/native-findings-seed";
import {
  operationalBlockedFixture,
  operationalContractFixture,
} from "@/test-support/operational-agent";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let sessionUserId: string | null = null;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/auth", () => ({
  auth: async () =>
    sessionUserId === null ? null : { user: { id: sessionUserId } },
}));

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "native_operational_history",
  });
}, 180000);
afterAll(async () => {
  await database?.stop();
});

it.each(["agent history", "automation list", "automation detail"] as const)(
  "IT-CBE-06 actual %s requires current source authority for governed operational diagnostics",
  async (kind) => {
    const contract = operationalContractFixture("none");
    const source = await seedNativeFindingsExecution(database, contract);
    const record = await getKnowledgeRecord(
      database.db,
      { kind: "token", tokenId: source.tokenId },
      { recordId: source.recordId },
    );
    const value = { ...operationalBlockedFixture(), summary: record.assertion };
    const { finalizeAgentRun } = await import("@/lib/agents/launch");

    expect(
      await finalizeAgentRun(source.runId, "Done", {
        db: database.db,
        finalOutput: { kind: "value", value },
      }),
    ).toMatchObject({ finalized: true, status: "Failed" });
    const retained = (
      await database.pool.query(
        "SELECT value,validity FROM run_results WHERE run_id=$1",
        [source.runId],
      )
    ).rows[0];

    expect(retained).toMatchObject({
      validity: "valid",
      value: { summary: record.assertion },
    });
    const project = (
      await database.pool.query<{ slug: string }>(
        "SELECT slug FROM projects WHERE id=$1",
        [source.projectId],
      )
    ).rows[0]!;
    const userId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [userId, `${userId}@example.test`],
    );
    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
      [randomUUID(), source.projectId, userId],
    );
    sessionUserId = userId;
    const automationId = randomUUID();

    await database.pool.query(
      "INSERT INTO agent_schedules(id,agent_id,project_id,trigger_type,cron_expr,timezone,next_fire_at,enabled,last_outcome,last_run_id) VALUES($1,$2,$3,'cron','0 * * * *','UTC',now()+interval '1 hour',true,'failed',$4)",
      [automationId, source.agentId, source.projectId, source.runId],
    );
    const read = async (): Promise<Response> => {
      if (kind === "agent history") {
        const { GET } =
          await import("@/app/api/projects/[slug]/agents/[agentId]/runs/route");

        return GET(
          new NextRequest(
            `http://localhost/api/projects/${project.slug}/agents/${encodeURIComponent(source.agentId)}/runs`,
          ),
          {
            params: Promise.resolve({
              slug: project.slug,
              agentId: encodeURIComponent(source.agentId),
            }),
          },
        );
      }
      if (kind === "automation list") {
        const { GET } =
          await import("@/app/api/projects/[slug]/automations/route");

        return GET(
          new NextRequest(
            `http://localhost/api/projects/${project.slug}/automations`,
          ),
          { params: Promise.resolve({ slug: project.slug }) },
        );
      }
      const { GET } =
        await import("@/app/api/projects/[slug]/automations/[kind]/[automationId]/route");

      return GET(
        new NextRequest(
          `http://localhost/api/projects/${project.slug}/automations/agent_cron/${automationId}`,
        ),
        {
          params: Promise.resolve({
            slug: project.slug,
            kind: "agent_cron",
            automationId,
          }),
        },
      );
    };
    const denied = await read();

    expect(denied.status).toBe(409);
    expect(await denied.text()).not.toContain(record.assertion);
    await createCompanyGrants(database.db, source.submitterId, {
      principalKind: "user",
      principalId: userId,
      actions: ["knowledge:read"],
      idempotencyKey: `history-reader:${source.runId}`,
    });
    const accepted = await read();

    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain(record.assertion);
  },
);

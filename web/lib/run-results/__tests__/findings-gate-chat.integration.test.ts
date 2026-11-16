import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import { gateChatMessages, hitlRequests } from "@/lib/db/schema";
import { buildAgentProfileContract } from "@/lib/run-results/contract";
import { sendGateChatTurn } from "@/lib/services/gate-chat";
import { seedNativeFindingsExecution } from "@/test-support/native-findings-seed";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let userId: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authz")>();

  return {
    ...actual,
    requireActiveSession: async () => ({
      id: userId,
      name: null,
      email: "reader@example.test",
      role: "member",
    }),
    requireProjectAction: async (
      projectId: string,
      action: Parameters<typeof actual.requireProjectActionForUser>[2],
    ) => actual.requireProjectActionForUser(userId, projectId, action),
  };
});

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "native_gate_chat_disclosure",
  });
}, 180000);
afterAll(async () => {
  await database?.stop();
});

it("IT-CBE-06 gate chat protects retained replies and refuses source-revoked execution before admitting a turn", async () => {
  const contract = buildAgentProfileContract({
    profileName: "findings",
    flowRefId: "native-chat",
    resolvedRevision: "a".repeat(40),
    sourceFlowRevisionId: "pinned-findings",
    schemaStem: "findings.v1",
    nativeContract: "evidence_findings_v1",
    schemaVersion: 1,
    schema: { schemaVersion: 1, fields: [] },
    sha256: "b".repeat(64),
  });
  const source = await seedNativeFindingsExecution(database, contract);
  const record = await getKnowledgeRecord(
    database.db,
    { kind: "token", tokenId: source.tokenId },
    { recordId: source.recordId },
  );

  userId = randomUUID();
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), source.projectId, userId],
  );
  await database.pool.query("UPDATE runs SET status='NeedsInput' WHERE id=$1", [
    source.runId,
  ]);
  const hitlRequestId = randomUUID();

  await database.db.insert(hitlRequests).values({
    id: hitlRequestId,
    runId: source.runId,
    stepId: "review",
    kind: "human",
    prompt: "Review native result",
    schema: { review: true },
  });
  await database.db.insert(gateChatMessages).values({
    id: randomUUID(),
    runId: source.runId,
    hitlRequestId,
    nodeId: "review",
    gateAttempt: 1,
    role: "agent",
    authorLabel: "Researcher",
    body: record.assertion,
    seq: 1,
  });
  const { GET, POST } =
    await import("@/app/api/runs/[runId]/hitl/[hitlRequestId]/chat/route");
  const route = {
    params: Promise.resolve({ runId: source.runId, hitlRequestId }),
  };
  const request = (): NextRequest =>
    new NextRequest(
      `http://localhost/api/runs/${source.runId}/hitl/${hitlRequestId}/chat`,
    );
  const denied = await GET(request(), route);

  expect(denied.status).toBe(409);
  expect(JSON.stringify(await denied.json())).not.toContain(record.assertion);
  const refused = await POST(
    new NextRequest(request().url, {
      method: "POST",
      body: JSON.stringify({ message: "Explain the finding" }),
      headers: { "Content-Type": "application/json" },
    }),
    route,
  );

  expect(refused.status).toBe(409);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM gate_chat_messages WHERE run_id=$1",
        [source.runId],
      )
    ).rows,
  ).toHaveLength(1);
  const grant = await createCompanyGrants(database.db, source.submitterId, {
    principalKind: "user",
    principalId: userId,
    actions: ["knowledge:read"],
    idempotencyKey: `chat-reader:${source.runId}`,
  });
  const allowed = await GET(request(), route);

  expect(allowed.status).toBe(200);
  expect(JSON.stringify(await allowed.json())).toContain(record.assertion);
  await database.pool.query(
    "DELETE FROM company_grants WHERE principal_type='agent' AND principal_id=$1 AND action='knowledge:read'",
    [source.agentId],
  );
  await expect(
    sendGateChatTurn({
      runId: source.runId,
      hitlRequestId,
      message: "Explain the finding",
      actorUserId: userId,
      db: database.db,
    }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_reference_unavailable" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT id FROM gate_chat_turns WHERE run_id=$1",
        [source.runId],
      )
    ).rows,
  ).toHaveLength(0);
  await revokeCompanyGrant(
    database.db,
    source.submitterId,
    grant.page.items[0]!.id,
    {
      expectedRevision: grant.page.items[0]!.revision,
      reason: "Gate chat source permission revoked",
      idempotencyKey: `revoke-chat:${source.runId}`,
    },
  );
  expect((await GET(request(), route)).status).toBe(409);
});

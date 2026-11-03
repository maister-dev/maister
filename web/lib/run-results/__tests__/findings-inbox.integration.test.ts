import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import { hitlRequests } from "@/lib/db/schema";
import { getHitlInbox } from "@/lib/queries/hitl";
import { getCrossProjectHitlInbox } from "@/lib/queries/portfolio";
import { issueUserAccessToken } from "@/lib/tokens/issue";
import { seedRun } from "@/test-support/execution-host-seed";
import { buildAgentProfileContract } from "@/lib/run-results/contract";
import { seedNativeFindingsExecution } from "@/test-support/native-findings-seed";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "native_inbox_disclosure",
  });
}, 180000);
afterAll(async () => {
  await database?.stop();
});

it.each(["project", "cross-project", "external"] as const)(
  "IT-CBE-06 %s HITL includes only currently authorized source content",
  async (surface) => {
    const contract = buildAgentProfileContract({
      profileName: "findings",
      flowRefId: "native-inbox",
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
    const userId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [userId, `${userId}@example.test`],
    );
    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
      [randomUUID(), source.projectId, userId],
    );
    await database.pool.query(
      "UPDATE runs SET status='NeedsInput' WHERE id=$1",
      [source.runId],
    );
    await database.db.insert(hitlRequests).values({
      id: randomUUID(),
      runId: source.runId,
      stepId: "review",
      kind: "human",
      prompt: record.assertion,
      schema: { review: true },
    });
    const legacyRunId = await seedRun(database.db, {
      projectId: source.projectId,
      status: "NeedsInput",
    });

    await database.db.insert(hitlRequests).values({
      id: randomUUID(),
      runId: legacyRunId,
      stepId: "review",
      kind: "human",
      prompt: "Independent project review",
      schema: { review: true },
    });
    const token = await issueUserAccessToken(
      {
        ownerUserId: userId,
        name: "Inbox source reader",
        scopes: ["hitl:inbox:read", "knowledge:read"],
      },
      database.db,
    );
    const read = async (): Promise<unknown> => {
      if (surface === "project")
        return getHitlInbox(source.projectId, {
          db: database.db,
          recipient: { kind: "user", userId },
        });
      if (surface === "cross-project")
        return getCrossProjectHitlInbox(
          userId,
          "member",
          { projectIds: [source.projectId] },
          database.db,
        );
      const { GET } = await import("@/app/api/v1/ext/hitl/route");
      const response = await GET(
        new NextRequest("http://localhost/api/v1/ext/hitl", {
          headers: { Authorization: `Bearer ${token.secret}` },
        }),
      );

      expect(response.status).toBe(200);

      return response.json();
    };

    const denied = await read();

    expect(JSON.stringify(denied)).not.toContain(record.assertion);
    expect(denied).toMatchObject({ count: 1 });
    expect(JSON.stringify(denied)).toContain("Independent project review");
    const grant = await createCompanyGrants(database.db, source.submitterId, {
      principalKind: "user",
      principalId: userId,
      actions: ["knowledge:read"],
      idempotencyKey: `inbox-reader:${source.runId}`,
    });
    const allowed = await read();

    expect(allowed).toMatchObject({ count: 2 });
    expect(JSON.stringify(allowed)).toContain(record.assertion);
    await revokeCompanyGrant(
      database.db,
      source.submitterId,
      grant.page.items[0]!.id,
      {
        expectedRevision: grant.page.items[0]!.revision,
        reason: "Inbox source permission revoked",
        idempotencyKey: `inbox-revoke:${source.runId}`,
      },
    );
    const revoked = await read();

    expect(revoked).toMatchObject({ count: 1 });
    expect(JSON.stringify(revoked)).not.toContain(record.assertion);
  },
);

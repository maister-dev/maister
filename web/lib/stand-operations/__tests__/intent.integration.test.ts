import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { captureKnowledgeSource } from "@/lib/brain/knowledge-source-capture";
import {
  createKnowledgeProposal,
  reviewKnowledgeProposal,
} from "@/lib/brain/knowledge-proposals";
import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import { requireActiveUserById, type SessionUser } from "@/lib/authz";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
const browser = vi.hoisted(() => ({ user: null as SessionUser | null }));

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => browser.user,
}));

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", "stand-intent-registry-cursor-fixture");
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "stand_intent",
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
  vi.unstubAllEnvs();
});

it("IT-CBO-01 registers a versioned company target with a runbook and canonical unit, rejecting invalid or unauthorized configuration", async () => {
  const administratorId = randomUUID();
  const userId = randomUUID();
  const { rows: companies } = await database.pool.query<{ id: string }>(
    "SELECT id FROM companies",
  );
  const owner = { kind: "company" as const, companyId: companies[0]!.id };

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active'),($3,$4,'member','active')",
    [
      administratorId,
      `${administratorId}@example.test`,
      userId,
      `${userId}@example.test`,
    ],
  );
  const authority = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: [
      "knowledge:read",
      "knowledge:propose",
      "knowledge:review",
      "targets:read",
      "targets:manage",
    ],
    idempotencyKey: randomUUID(),
  });
  const principal = { kind: "user" as const, userId };
  const source = await captureKnowledgeSource(database.db, principal, {
    owner,
    title: "Disposable stand runbook",
    content: "Inspect the fixture unit and verify its health after restart.",
    idempotencyKey: randomUUID(),
  });
  const proposal = await createKnowledgeProposal(database.db, {
    owner,
    principal,
    kind: "knowledge_add",
    idempotencyKey: randomUUID(),
    draft: {
      title: "Disposable stand runbook",
      kind: "procedure",
      assertion:
        "Inspect the fixture unit and verify its health after restart.",
      basis: "observed",
      evidence: [
        {
          relation: "supports",
          reference: {
            kind: "witness",
            id: source.witness.id,
            sha256: source.witness.sha256!,
            version: source.witness.sourceVersion!,
          },
        },
      ],
      missingEvidence: [],
      limitations: [],
    },
  });
  const accepted = await reviewKnowledgeProposal(database.db, {
    principal,
    proposalId: proposal.id,
    expectedRevision: 1,
    decision: "accept",
    reason: "Retain the reviewed test runbook",
    idempotencyKey: randomUUID(),
  });
  const component = {
    id: "api",
    serviceManager: "systemd",
    scope: "system",
    user: null,
    unit: "fixture-api.service",
    actions: ["inspect", "logs", "restart", "verify"],
    runbook: {
      recordId: accepted.acceptedRecordId,
      revision: accepted.acceptedRecordRevision,
      witnessId: source.witness.id,
    },
    healthProbe: { kind: "systemd", expectedState: "active" },
  };
  const input = {
    owner,
    incarnationId: randomUUID(),
    endpoint: "https://stand.example.test:7443",
    serverIdentity: "stand.example.test",
    caEnv: "env:STAND_TEST_CA",
    certificateEnv: "env:STAND_TEST_CERT",
    keyEnv: "env:STAND_TEST_KEY",
    platformCredentialEnv: "env:STAND_TEST_PLATFORM_TOKEN",
    helperCredentialEnv: "env:STAND_TEST_HELPER_TOKEN",
    enabled: true,
    components: [component, { ...component, id: "api-alias" }],
  };
  const request = (body: unknown, key = randomUUID()) =>
    new NextRequest("http://localhost/api/stands", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
  const { GET, POST } = await import("@/app/api/stands/route");
  const { GET: getTarget, PATCH } =
    await import("@/app/api/stands/[targetId]/route");

  browser.user = await requireActiveUserById(userId);
  const key = randomUUID();
  const response = await POST(request(input, key));

  expect(response.status).toBe(201);
  const target = await response.json();

  expect(target).toEqual({
    id: expect.any(String),
    owner,
    incarnationId: input.incarnationId,
    configRevision: 1,
    enabled: true,
    componentIds: ["api", "api-alias"],
  });
  const replay = await POST(request(input, key));

  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(target);
  expect((await POST(request({ ...input, enabled: false }, key))).status).toBe(
    409,
  );
  const {
    rows: [resources],
  } = await database.pool.query(
    "SELECT count(*)::int AS aliases,count(DISTINCT canonical_resource_key)::int AS resources FROM stand_components WHERE target_id=$1 AND config_revision=1",
    [target.id],
  );

  expect(resources).toEqual({ aliases: 2, resources: 1 });
  await expect(
    database.pool.query(
      "UPDATE stand_components SET canonical_resource_key=repeat('a',64) WHERE target_id=$1 AND config_revision=1 AND component_id='api'",
      [target.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database.pool.query(
      "UPDATE stand_targets SET config_revision=2 WHERE id=$1",
      [target.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database.pool.query(
      `INSERT INTO stand_components(target_id,config_revision,component_id,canonical_resource_key,config,runbook_sha256)
     SELECT target_id,config_revision,'unreviewed',canonical_resource_key,jsonb_set(config,'{id}','"unreviewed"'),runbook_sha256
     FROM stand_components WHERE target_id=$1 AND config_revision=1 AND component_id='api'`,
      [target.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  for (const invalid of [
    { ...input, endpoint: "https://stand.example.test:7443/extra" },
    { ...input, components: [{ ...component, scope: "user" }] },
    { ...input, components: [{ ...component, unit: "--fixture.service" }] },
    { ...input, components: [{ ...component, serviceManager: "launchd" }] },
    { ...input, components: [{ ...component, actions: ["upgrade"] }] },
  ])
    expect((await POST(request(invalid))).status).toBe(400);
  expect(
    (
      await POST(
        request({
          ...input,
          incarnationId: randomUUID(),
          components: [
            {
              ...component,
              runbook: { ...component.runbook, witnessId: randomUUID() },
            },
          ],
        }),
      )
    ).status,
  ).toBe(404);
  const targetContext = {
    params: Promise.resolve({ targetId: target.id as string }),
  };
  const patchRequest = (body: unknown, key = randomUUID()) =>
    new NextRequest(`http://localhost/api/stands/${target.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
  const update = { ...input, enabled: false, expectedRevision: 1 };
  const updateKey = randomUUID();
  const updated = await PATCH(patchRequest(update, updateKey), targetContext);

  expect(updated.status).toBe(200);
  expect(await updated.json()).toEqual({
    ...target,
    configRevision: 2,
    enabled: false,
  });
  const stale = await PATCH(patchRequest(update), targetContext);

  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ details: { currentRevision: 2 } });
  expect(await (await POST(request(input, key))).json()).toEqual(target);
  expect(
    await (
      await getTarget(
        new NextRequest(`http://localhost/api/stands/${target.id}`),
        targetContext,
      )
    ).json(),
  ).toMatchObject({ id: target.id, configRevision: 2 });
  const second = await POST(request({ ...input, incarnationId: randomUUID() }));

  expect(second.status).toBe(201);
  const secondTarget = await second.json();
  const firstPage = await GET(
    new NextRequest("http://localhost/api/stands?limit=1"),
  );
  const page = await firstPage.json();

  expect(page).toMatchObject({
    items: [{ id: target.id }],
    nextCursor: expect.any(String),
  });
  const lastPage = await GET(
    new NextRequest(
      `http://localhost/api/stands?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
    ),
  );

  expect(await lastPage.json()).toEqual({
    items: [secondTarget],
    nextCursor: null,
  });
  const manage = authority.page.items.find(
    (item) => item.action === "targets:manage",
  )!;

  await revokeCompanyGrant(database.db, administratorId, manage.id, {
    expectedRevision: manage.revision,
    reason: "End target configuration authority",
    idempotencyKey: randomUUID(),
  });
  expect((await POST(request(input, key))).status).toBe(403);
  expect(await database.pool.query("SELECT id FROM projects")).toMatchObject({
    rowCount: 0,
  });
  browser.user = null;
});

import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { Db } from "@/lib/execution-host/db";

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { captureKnowledgeSource } from "@/lib/brain/knowledge-source-capture";
import {
  createKnowledgeProposal,
  reviewKnowledgeProposal,
} from "@/lib/brain/knowledge-proposals";
import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import { requireActiveUserById, type SessionUser } from "@/lib/authz";
import {
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import { resolveInstalledAgentDefinition } from "@/lib/agents/effective";
import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import {
  appendSpecialistAssignmentInput,
  cancelSpecialistAssignment,
  createSpecialistAssignment,
} from "@/lib/specialist-assignments/store";
import { MaisterError } from "@/lib/errors";
import {
  applyMainMigration,
  startMainAndBrainPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let fixtureRoot: string;
const browser = vi.hoisted(() => ({ user: null as SessionUser | null }));

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => {
    if (!browser.user)
      throw new MaisterError("UNAUTHENTICATED", "A fixture user is required");

    return browser.user;
  },
}));

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", "stand-intent-registry-cursor-fixture");
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "stand_intent",
  });
  fixtureRoot = await mkdtemp(join(os.tmpdir(), "stand-intent-"));
  vi.spyOn(os, "homedir").mockReturnValue(fixtureRoot);
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createRegistryFixture() {
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
      "targets:logs",
      "targets:restart",
      "assignments:read",
      "assignments:submit",
      "assignments:update",
      "assignments:cancel",
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
    helperCertificateSha256: randomBytes(32).toString("hex"),
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

  return {
    administratorId,
    userId,
    owner,
    authority,
    component,
    input,
    request,
  };
}

it("IT-CBO-01 registers a versioned company target with a runbook and canonical unit, rejecting invalid or unauthorized configuration", async () => {
  const {
    administratorId,
    userId,
    owner,
    authority,
    component,
    input,
    request,
  } = await createRegistryFixture();
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
    { ...input, helperCertificateSha256: "invalid" },
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

it("IT-CBO-02 IT-CBO-03 retains one restart intent across aliases and approves only its exact digest", async () => {
  const { administratorId, userId, owner, authority, input, request } =
    await createRegistryFixture();
  const { POST: createTarget } = await import("@/app/api/stands/route");

  browser.user = await requireActiveUserById(userId);
  const targetResponse = await createTarget(request(input));

  expect(targetResponse.status).toBe(201);
  const target: { id: string } = await targetResponse.json();
  const installed = await installPackageRevision({
    source: resolve("test-fixtures/rah-native"),
    version: "rah/stand-intent",
    db: database.db,
  });

  await trustPackageRevision({
    packageInstallId: installed.id,
    db: database.db,
  });
  const agentId = "rah:evidence-researcher";
  const role = await resolveInstalledAgentDefinition(database.db, {
    agentId,
    packageInstallId: installed.id,
  });
  const newAssignment = (targetIds: string[]) =>
    createSpecialistAssignment(database.db, userId, {
      owner,
      specialistBindingId: randomUUID(),
      responsibleAgentId: agentId,
      objectiveInput: {
        objective: "Inspect the configured stand",
        expectedOutcome: "An evidence-linked stand observation",
        input: "Inspect the configured API component.",
        targetIds,
        inputRefs: [],
        constraints: [],
        expectedResult: {
          schemaRef: "fixture:stand.v1",
          schemaVersion: 1,
          sha256: "a".repeat(64),
          required: true,
        },
        verification: [],
      },
      standingDefinition: {
        schemaVersion: 1,
        agentId,
        packageInstallId: installed.id,
        packageName: installed.name,
        packageRevision: installed.resolvedRevision,
        definitionSha256: agentDefinitionSha256(role.parsed),
        definition: role.parsed,
        configuration: null,
      },
      scheduledRequest: null,
      sourceRestrictions: [],
      executionPolicy: { preset: "supervised" },
      origin: { kind: "manual", interactionId: randomUUID() },
      destination: { kind: "inbox", userId },
    });
  const first = await newAssignment([target.id]);
  const second = await newAssignment([target.id]);
  const { POST } =
    await import("@/app/api/specialist-assignments/[assignmentId]/operations/route");
  const createOperation = (
    assignment: typeof first,
    componentId: string,
    idempotencyKey = randomUUID(),
    action = "restart",
  ) =>
    POST(
      new NextRequest(
        `http://localhost/api/specialist-assignments/${assignment.id}/operations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost",
          },
          body: JSON.stringify({
            expectedRevision: assignment.revision,
            inputRevision: assignment.inputRevision,
            componentId,
            action,
            idempotencyKey,
          }),
        },
      ),
      { params: Promise.resolve({ assignmentId: assignment.id }) },
    );
  const key = randomUUID();
  const secondKey = randomUUID();
  const padded = JSON.stringify({
    expectedRevision: first.revision,
    inputRevision: first.inputRevision,
    componentId: "api",
    action: "restart",
    idempotencyKey: key,
  }).padEnd(65_537);
  const oversized = await POST(
    new NextRequest(
      `http://localhost/api/specialist-assignments/${first.id}/operations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: padded,
      },
    ),
    { params: Promise.resolve({ assignmentId: first.id }) },
  );

  expect(oversized.status).toBe(413);
  const [a, b] = await Promise.all([
    createOperation(first, "api", key),
    createOperation(second, "api-alias", secondKey),
  ]);

  expect([a.status, b.status].sort()).toEqual([202, 409]);
  const winner = a.status === 202 ? first : second;
  const accepted = await (a.status === 202 ? a : b).json();

  expect(accepted).toMatchObject({
    assignmentId: winner.id,
    targetIncarnation: input.incarnationId,
    effectState: "not_dispatched",
    verificationState: "not_checked",
    disposition: "pending",
  });
  const { authenticateStandOperationPeer } = await import("../authority-peer");
  const { authorizeStandCallback } = await import("../authority-permit");

  await expect(
    database.pool.query(
      `INSERT INTO stand_authorization_permits(operation_id,nonce,purpose,owner_epoch,issued_at,expires_at)
       VALUES($1,$2,'dispatch',1,clock_timestamp(),clock_timestamp()+interval '4 seconds')`,
      [accepted.id, randomUUID()],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database.pool.query(
      `INSERT INTO stand_authorization_permits(operation_id,nonce,purpose,owner_epoch,issued_at,expires_at)
       VALUES($1,$2,'reconcile',1,clock_timestamp(),clock_timestamp()+interval '4 seconds')`,
      [accepted.id, randomUUID()],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const peerToken = randomBytes(32).toString("base64url");
  const peerFingerprint = input.helperCertificateSha256
    .match(/../g)!
    .join(":")
    .toUpperCase();

  const previousPeerToken = process.env.STAND_TEST_HELPER_TOKEN;

  process.env.STAND_TEST_HELPER_TOKEN = peerToken;
  try {
    const permitRequest = {
      operationId: accepted.id,
      peerFingerprint,
      helperToken: peerToken,
      body: {
        targetIncarnation: input.incarnationId,
        resourceKey: "a".repeat(64),
        requestDigest: accepted.requestDigest,
        ownerEpoch: 1,
        nonce: randomUUID(),
        purpose: "dispatch",
      },
    };

    await expect(
      authorizeStandCallback(database.db as Db, permitRequest),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const [resource] = (
      await database.pool.query<{ resource_key: string }>(
        "SELECT resource_key FROM stand_operations WHERE id=$1",
        [accepted.id],
      )
    ).rows;

    await expect(
      authorizeStandCallback(database.db as Db, {
        ...permitRequest,
        body: { ...permitRequest.body, resourceKey: resource!.resource_key },
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "assignment_fenced" },
    });
    const authenticate = (fingerprint: string, token: string) =>
      database.db.transaction((tx) =>
        authenticateStandOperationPeer(tx, accepted.id, fingerprint, token),
      );

    await expect(authenticate(peerFingerprint, peerToken)).resolves.toEqual({
      targetId: target.id,
      companyId: owner.companyId,
      configRevision: 1,
      incarnationId: input.incarnationId,
    });
    await expect(authenticate("00:00", peerToken)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(
      authenticate(peerFingerprint, "invalid"),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const probeRollback = new Error("Discard temporary disabled target");

    await expect(
      database.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE stand_targets SET enabled=false,config_revision=config_revision+1 WHERE id=${target.id}`,
        );
        await expect(
          authenticateStandOperationPeer(
            tx,
            accepted.id,
            peerFingerprint,
            peerToken,
          ),
        ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
        throw probeRollback;
      }),
    ).rejects.toBe(probeRollback);
  } finally {
    if (previousPeerToken === undefined)
      delete process.env.STAND_TEST_HELPER_TOKEN;
    else process.env.STAND_TEST_HELPER_TOKEN = previousPeerToken;
  }
  const winnerKey = a.status === 202 ? key : secondKey;
  const componentId = a.status === 202 ? "api" : "api-alias";
  const duplicate = await createOperation(winner, componentId, winnerKey);

  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toEqual(accepted);
  expect(
    (await createOperation(winner, componentId, winnerKey, "inspect")).status,
  ).toBe(409);
  const { rows } = await database.pool.query(
    "SELECT claim.operation_id, operation.effect_state FROM stand_resource_claims claim JOIN stand_operations operation ON operation.id=claim.operation_id",
  );

  expect(rows).toEqual([
    { operation_id: accepted.id, effect_state: "not_dispatched" },
  ]);
  const loser = a.status === 202 ? second : first;
  const loserComponent = a.status === 202 ? "api-alias" : "api";

  await database.pool.query(
    "UPDATE stand_resource_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",
    [accepted.id],
  );
  expect((await createOperation(loser, loserComponent)).status).toBe(409);
  await expect(
    database.pool.query(
      "UPDATE stand_operations SET request_digest=repeat('b',64) WHERE id=$1",
      [accepted.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database.pool.query(
      "DELETE FROM stand_resource_claims WHERE operation_id=$1",
      [accepted.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const { GET } =
    await import("@/app/api/stand-operations/[operationId]/route");
  const read = await GET(
    new NextRequest(`http://localhost/api/stand-operations/${accepted.id}`),
    { params: Promise.resolve({ operationId: accepted.id }) },
  );

  expect(read.status).toBe(200);
  expect(await read.json()).toEqual(accepted);
  const { POST: approve } =
    await import("@/app/api/stand-operations/[operationId]/approval/route");
  const approvalKey = randomUUID();
  const approveIntent = (requestDigest: string) =>
    approve(
      new NextRequest(
        `http://localhost/api/stand-operations/${accepted.id}/approval`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost",
          },
          body: JSON.stringify({
            expectedRevision: accepted.revision,
            requestDigest,
            reason: "The configured fixture restart is approved.",
            idempotencyKey: approvalKey,
          }),
        },
      ),
      { params: Promise.resolve({ operationId: accepted.id }) },
    );

  expect((await approveIntent("f".repeat(64))).status).toBe(409);
  // Native clarification/HITL can park the assignment without changing its input.
  await database.pool.query(
    "UPDATE specialist_assignments SET status='waiting_input',revision=revision+1 WHERE id=$1",
    [winner.id],
  );
  const approved = await approveIntent(accepted.requestDigest);

  expect(approved.status).toBe(201);
  const approval = await approved.json();

  expect(approval).toMatchObject({
    operationId: accepted.id,
    approvedBy: userId,
    requestDigest: accepted.requestDigest,
  });
  const replayedApproval = await approveIntent(accepted.requestDigest);

  expect(replayedApproval.status).toBe(200);
  expect(await replayedApproval.json()).toEqual(approval);

  const knowledgeGrant = authority.page.items.find(
    (item) => item.action === "knowledge:read",
  )!;

  await revokeCompanyGrant(database.db, administratorId, knowledgeGrant.id, {
    expectedRevision: knowledgeGrant.revision,
    reason: "Revoke current runbook access",
    idempotencyKey: randomUUID(),
  });
  expect((await approveIntent(accepted.requestDigest)).status).toBe(404);
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["knowledge:read"],
    idempotencyKey: randomUUID(),
  });
  const clarified = await appendSpecialistAssignmentInput(
    database.db,
    userId,
    winner.id,
    {
      expectedRevision: winner.revision + 1,
      input: "Clarification supersedes the original input.",
      references: [],
    },
  );

  expect(clarified.inputRevision).toBe(winner.inputRevision + 1);
  expect((await approveIntent(accepted.requestDigest)).status).toBe(409);
  await expect(
    database.pool.query(
      "UPDATE stand_restart_approvals SET request_digest=repeat('f',64) WHERE operation_id=$1",
      [accepted.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const restartGrant = authority.page.items.find(
    (item) => item.action === "targets:restart",
  )!;

  await revokeCompanyGrant(database.db, administratorId, restartGrant.id, {
    expectedRevision: restartGrant.revision,
    reason: "Revoke restart authority",
    idempotencyKey: randomUUID(),
  });
  expect((await approveIntent(accepted.requestDigest)).status).toBe(403);
  await cancelSpecialistAssignment(
    database.db,
    userId,
    winner.id,
    clarified.revision,
    "Retire the interrupted stand assignment",
  );
  expect((await createOperation(loser, loserComponent)).status).toBe(403);
  const retained = await GET(
    new NextRequest(`http://localhost/api/stand-operations/${accepted.id}`),
    { params: Promise.resolve({ operationId: accepted.id }) },
  );

  expect(await retained.json()).toEqual(accepted);
  const retainedState = () =>
    database.pool.query(
      `SELECT to_jsonb(operation) AS operation,to_jsonb(claim) AS claim
       FROM stand_operations operation JOIN stand_resource_claims claim ON claim.operation_id=operation.id
       WHERE operation.id=$1`,
      [accepted.id],
    );
  const beforeUpgrade = (await retainedState()).rows;

  // Reinstall the migration at its real populated boundary, with older rows intact.
  await database.db.transaction(async (tx) => {
    await tx.execute(
      sql`DROP TRIGGER stand_effect_transition_guard ON stand_operations`,
    );
    await tx.execute(sql`DROP FUNCTION guard_stand_effect_transition()`);
    await applyMainMigration(tx, "0305_stand_effect_transition_guards");
  });
  expect((await retainedState()).rows).toEqual(beforeUpgrade);

  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["targets:restart"],
    idempotencyKey: randomUUID(),
  });
  await expect(
    database.pool.query(
      "UPDATE stand_operations SET effect_state='confirmed_applied',disposition='proved_applied',revision=revision+1 WHERE id=$1",
      [accepted.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  // The connector qualification owns creation of the actual target receipt.
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE stand_operations SET effect_state='dispatching',revision=revision+1 WHERE id=${accepted.id}
    `);
    await tx.execute(sql`
      UPDATE stand_operations SET effect_state='unknown',disposition='unresolved_hold',
        revision=revision+1 WHERE id=${accepted.id}
    `);
  });
  await expect(
    database.pool.query(
      "UPDATE stand_resource_claims SET unresolved=false WHERE operation_id=$1",
      [accepted.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database.pool.query(
      "UPDATE stand_operations SET disposition='proved_applied',revision=revision+1 WHERE id=$1",
      [accepted.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE stand_operations SET effect_state='confirmed_not_applied',
        disposition='proved_not_applied',revision=revision+1 WHERE id=${accepted.id}
    `);
    await tx.execute(sql`
      UPDATE stand_resource_claims SET unresolved=false WHERE operation_id=${accepted.id}
    `);
  });
  await expect(
    database.pool.query(
      "UPDATE stand_operations SET effect_state='confirmed_applied',disposition='proved_applied',revision=revision+1 WHERE id=$1",
      [accepted.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const next = await createOperation(loser, loserComponent);

  expect(next.status).toBe(202);
  const newOperation = await next.json();

  expect(newOperation).toMatchObject({
    assignmentId: loser.id,
    predecessorId: null,
    effectState: "not_dispatched",
  });
  expect(newOperation.id).not.toBe(accepted.id);
  expect(
    (
      await database.pool.query(
        "SELECT operation_id,owner_epoch,unresolved FROM stand_resource_claims",
      )
    ).rows,
  ).toEqual([
    { operation_id: newOperation.id, owner_epoch: "2", unresolved: true },
  ]);
  browser.user = null;
});

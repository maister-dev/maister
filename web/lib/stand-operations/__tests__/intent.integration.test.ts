import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { Db } from "@/lib/execution-host/db";

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

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
import { createCompanySpecialistBinding } from "@/lib/agents/company-bindings";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import {
  defaultTransport,
  setDefaultTransportForTests,
} from "@/lib/execution-host/default-transport";
import { platformAcpRunners, runs } from "@/lib/db/schema";
import { tryStartRun } from "@/lib/scheduler";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
} from "@/test-support/fake-execution-host";
import { reserveCompanyManualAssignment } from "@/lib/specialist-assignments/company-manual-intake";
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

it("IT-CBO-02 IT-CBO-03 IT-CBO-07 retains one restart intent across aliases and approves only its exact digest", async () => {
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

  await expect(
    database.pool.query(
      `INSERT INTO stand_operation_observations(
        operation_id, target_incarnation, resource_key, request_digest,
        target_sequence, invocation_id, observed_state, captured_at
      )
      SELECT id, target_incarnation, repeat('f',64), request_digest,
        1, 'fixture-invocation', 'active', now()
      FROM stand_operations WHERE id=$1`,
      [accepted.id],
    ),
  ).rejects.toMatchObject({ code: "23503" });
  const observed = await database.pool.query<{ id: string }>(
    `INSERT INTO stand_operation_observations(
      operation_id, target_incarnation, resource_key, request_digest,
      target_sequence, invocation_id, observed_state, captured_at
    )
    SELECT id, target_incarnation, resource_key, request_digest,
      1, 'fixture-invocation', 'active', now()
    FROM stand_operations WHERE id=$1 RETURNING id`,
    [accepted.id],
  );

  await expect(
    database.pool.query(
      "UPDATE stand_operation_observations SET observed_state='unknown' WHERE id=$1",
      [observed.rows[0]!.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
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
  const { prepareStandRestartDispatch } = await import("../restart-dispatch");

  await expect(
    prepareStandRestartDispatch(database.db as Db, {
      operationId: accepted.id,
      runId: randomUUID(),
      nodeAttemptId: null,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

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
      UPDATE stand_operations SET effect_state='unknown',
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
  await expect(
    database.pool.query(
      "UPDATE stand_operations SET disposition='unresolved_hold',revision=revision+1 WHERE id=$1",
      [accepted.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const { POST: decideRecovery } =
    await import("@/app/api/stand-operations/[operationId]/recovery-decisions/route");

  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["targets:recover"],
    idempotencyKey: randomUUID(),
  });
  const holdInput = {
    expectedRevision: accepted.revision + 2,
    decision: "hold",
    inspectionIds: [],
    reason: "Keep this resource excluded until the helper can be contacted.",
    idempotencyKey: randomUUID(),
  };
  const decide = (body: typeof holdInput) =>
    decideRecovery(
      new NextRequest(
        `http://localhost/api/stand-operations/${accepted.id}/recovery-decisions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost",
          },
          body: JSON.stringify(body),
        },
      ),
      { params: Promise.resolve({ operationId: accepted.id }) },
    );
  const hold = await decide(holdInput);

  expect(hold.status).toBe(202);
  const held = await hold.json();

  expect(held).toMatchObject({
    effectState: "unknown",
    disposition: "unresolved_hold",
  });
  const replay = await decide(holdInput);

  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(held);
  expect(
    (await decide({ ...holdInput, reason: "Different decision" })).status,
  ).toBe(409);
  expect(
    (
      await decide({
        ...holdInput,
        idempotencyKey: randomUUID(),
        expectedRevision: held.revision,
        decision: "authorize_successor",
      })
    ).status,
  ).toBe(400);
  await expect(
    database.pool.query(
      "DELETE FROM stand_recovery_decisions WHERE operation_id=$1",
      [accepted.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  expect((await createOperation(loser, loserComponent)).status).toBe(409);
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

  // Transfer a separate unknown operation to an explicitly appointed open assignment.
  const { inspectStandRecovery } = await import("../observe");
  const recoveryToken = randomBytes(32).toString("base64url");

  vi.stubEnv("STAND_TEST_HELPER_TOKEN", recoveryToken);
  try {
    await database.db.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE stand_operations SET effect_state='dispatching',revision=revision+1 WHERE id=${newOperation.id}`,
      );
      await tx.execute(
        sql`UPDATE stand_operations SET effect_state='unknown',revision=revision+1 WHERE id=${newOperation.id}`,
      );
      await tx.execute(
        sql`UPDATE stand_resource_claims SET expires_at=clock_timestamp()-interval '6 seconds' WHERE operation_id=${newOperation.id}`,
      );
    });
    const sequence = 7;

    setDefaultTransportForTests({
      ...defaultTransport(),
      observeStandOperation: async (selector) => {
        await authorizeStandCallback(database.db, {
          operationId: selector.operationId,
          peerFingerprint: input.helperCertificateSha256,
          helperToken: recoveryToken,
          body: {
            targetIncarnation: selector.targetIncarnation,
            resourceKey: selector.resourceKey,
            requestDigest: selector.requestDigest,
            ownerEpoch: selector.ownerEpoch,
            nonce: randomUUID(),
            purpose: "reconcile",
          },
        });

        return {
          sequence,
          invocationId: "a".repeat(32),
          state: "active",
          operationId: selector.operationId,
          targetIncarnation: selector.targetIncarnation,
          requestDigest: selector.requestDigest,
          resourceKey: selector.resourceKey,
          capturedAt: new Date().toISOString(),
        };
      },
    });
    const inspected = await inspectStandRecovery(
      database.db,
      userId,
      newOperation.id,
      newOperation.revision + 2,
    );
    const decideSuccessor = (inspectionId: string, idempotencyKey: string) =>
      decideRecovery(
        new NextRequest(
          `http://localhost/api/stand-operations/${newOperation.id}/recovery-decisions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
            },
            body: JSON.stringify({
              expectedRevision: newOperation.revision + 2,
              decision: "authorize_successor",
              inspectionIds: [inspectionId],
              successor: {
                assignmentId: loser.id,
                expectedRevision: loser.revision,
                inputRevision: loser.inputRevision,
              },
              reason: "Proceed after inspecting current service state.",
              idempotencyKey,
            }),
          },
        ),
        { params: Promise.resolve({ operationId: newOperation.id }) },
      );
    const forgedInspection = await decideSuccessor(randomUUID(), randomUUID());

    expect(forgedInspection.status).toBe(409);
    const deliveryKey = randomUUID();
    const [authorized, duplicateSuccessor] = await Promise.all([
      decideSuccessor(inspected.id, deliveryKey),
      decideSuccessor(inspected.id, deliveryKey),
    ]);

    expect([authorized.status, duplicateSuccessor.status].sort()).toEqual([
      200, 202,
    ]);
    const original = await authorized.json();

    expect(original).toMatchObject({
      effectState: "unknown",
      disposition: "authorized_successor",
      successorId: expect.any(String),
    });
    expect(await duplicateSuccessor.json()).toEqual(original);
    const successor = await GET(
      new NextRequest(
        `http://localhost/api/stand-operations/${original.successorId}`,
      ),
      {
        params: Promise.resolve({ operationId: original.successorId }),
      },
    );

    expect(await successor.json()).toMatchObject({
      predecessorId: newOperation.id,
      effectState: "not_dispatched",
      verificationState: "not_checked",
    });
    expect(
      (
        await database.pool.query(
          "SELECT operation_id,owner_epoch,unresolved FROM stand_resource_claims",
        )
      ).rows,
    ).toEqual([
      {
        operation_id: original.successorId,
        owner_epoch: "3",
        unresolved: true,
      },
    ]);
  } finally {
    setDefaultTransportForTests(null);
    vi.unstubAllEnvs();
  }
  browser.user = null;
});

it("IT-CBO-02 IT-CBO-04 IT-CBO-05 recovers the original native restart under exact authority and independent verification", async () => {
  const { administratorId, userId, owner, input, request } =
    await createRegistryFixture();
  const db = database.db as Db;
  const { approveStandRestart } = await import("../restart-approval");
  const { prepareStandRestartDispatch } = await import("../restart-dispatch");
  const { authorizeStandCallback } = await import("../authority-permit");
  const { POST } = await import("@/app/api/stands/route");

  browser.user = await requireActiveUserById(userId);
  try {
    const targetResponse = await POST(request(input));

    expect(targetResponse.status).toBe(201);
    const target: { id: string } = await targetResponse.json();
    const source = join(fixtureRoot, "stand-permit-package");

    await mkdir(join(source, "maister-agents"), { recursive: true });
    await writeFile(
      join(source, "maister-package.yaml"),
      'schemaVersion: 1\nname: stand-permit-fixture\ncompat: {engine_min: "3.12.0"}\nflows: []\n',
    );
    await writeFile(
      join(source, "maister-agents/operator.md"),
      "---\nname: Stand permit fixture\ndescription: Exercise scoped restart authority.\nkind: operational\ncompletion: {contract: operational_evidence_v2}\nspecialist: {responsibilities: [Verify stand operation authority], targetClasses: [stand]}\nmode: session\nworkspace: none\ntriggers: [manual]\nrisk_tier: standard\n---\nReturn the fixture observation.\n",
    );
    const installed = await installPackageRevision({
      source,
      version: "stand-permit-fixture/v1.0.0",
      db,
    });

    await trustPackageRevision({ packageInstallId: installed.id, db });
    const agentId = "stand-permit-fixture:operator";
    const role = await resolveInstalledAgentDefinition(db, {
      agentId,
      packageInstallId: installed.id,
    });
    const runnerId = randomUUID();

    await db.insert(platformAcpRunners).values({
      id: runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "stand-permit-fixture",
      provider: { kind: "anthropic" },
      readinessStatus: "Ready",
    });
    await createCompanyGrants(db, administratorId, {
      principalKind: "user",
      principalId: userId,
      actions: ["specialists:read", "specialists:manage"],
      idempotencyKey: randomUUID(),
    });
    const professional = await createCompanyGrants(db, administratorId, {
      principalKind: "agent",
      principalId: agentId,
      actions: [
        "assignments:read",
        "targets:read",
        "targets:logs",
        "targets:restart",
      ],
      idempotencyKey: randomUUID(),
    });
    const binding = await createCompanySpecialistBinding(db, userId, agentId, {
      owner,
      packageInstallId: installed.id,
      packageRevision: installed.resolvedRevision,
      definitionSha256: agentDefinitionSha256(role.parsed),
      configuration: {},
      enabled: true,
      grantActions: [
        "assignments:read",
        "targets:read",
        "targets:logs",
        "targets:restart",
      ],
      runnerId,
      idempotencyKey: randomUUID(),
    });
    const { hosts, fake } = await fakeExecutionHosts(db, {
      fake: createFakeExecutionHost(),
    });
    const { assignment } = await reserveCompanyManualAssignment(
      db,
      userId,
      {
        owner,
        specialistBindingId: binding.specialist.bindingId,
        objective: "Verify controlled restart authorization",
        expectedOutcome: "One bound authorization",
        input: "Only the registered fixture resource.",
        targetIds: [target.id],
        inputRefs: [],
        constraints: [],
        verification: [
          { kind: "effect", referenceId: target.id, required: true },
          { kind: "health", referenceId: target.id, required: true },
        ],
        idempotencyKey: randomUUID(),
      },
      hosts,
    );
    const runId = assignment.runIds[0]!;

    expect(await tryStartRun(runId, { db })).toEqual({ started: true });
    const { issueCompanyAgentRunToken } = await import("@/lib/agents/tokens");
    const credential = await issueCompanyAgentRunToken({ db, runId });
    const { POST: requestOperation } =
      await import("@/app/api/v1/ext/specialist-assignments/[assignmentId]/operations/route");
    const intent = {
      expectedRevision: assignment.revision,
      inputRevision: assignment.inputRevision,
      componentId: "api",
      action: "restart",
      idempotencyKey: randomUUID(),
    };
    const submit = (selectedAssignmentId: string, body: unknown = intent) =>
      requestOperation(
        new NextRequest(
          `http://localhost/api/v1/ext/specialist-assignments/${selectedAssignmentId}/operations`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${credential.secret}`,
            },
            body: JSON.stringify(body),
          },
        ),
        { params: Promise.resolve({ assignmentId: selectedAssignmentId }) },
      );

    expect((await submit(randomUUID())).status).toBe(403);
    expect(
      (await submit(assignment.id, { ...intent, runId: randomUUID() })).status,
    ).toBe(422);
    const submission = await submit(assignment.id);

    const operation = await submission.json();

    expect(submission.status, JSON.stringify(operation)).toBe(202);
    expect((await submit(assignment.id)).status).toBe(200);
    expect(
      (
        await database.pool.query(
          "SELECT initiating_execution FROM stand_operations WHERE id=$1",
          [operation.id],
        )
      ).rows,
    ).toEqual([
      { initiating_execution: { agentId, runId, nodeAttemptId: null } },
    ]);

    await approveStandRestart(db, userId, operation.id, {
      expectedRevision: operation.revision,
      requestDigest: operation.requestDigest,
      reason: "Approve the fixture intent.",
      idempotencyKey: randomUUID(),
    });
    const { POST: specialistAction } =
      await import("@/app/api/v1/ext/stand-operations/[operationId]/[action]/route");
    const act = (action: string) =>
      specialistAction(
        new NextRequest(
          `http://localhost/api/v1/ext/stand-operations/${operation.id}/${action}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${credential.secret}` },
          },
        ),
        { params: Promise.resolve({ operationId: operation.id, action }) },
      );

    expect((await act("dispatch")).status).toBe(409);
    const observeTarget = vi.fn(
      async (
        selector: Parameters<typeof fake.transport.observeStandOperation>[0],
      ) => ({
        operationId: selector.operationId,
        targetIncarnation: selector.targetIncarnation,
        resourceKey: selector.resourceKey,
        requestDigest: selector.requestDigest,
        sequence: 1,
        invocationId: "a".repeat(32),
        state: "active",
        capturedAt: new Date().toISOString(),
      }),
    );

    setDefaultTransportForTests({
      ...fake.transport,
      observeStandOperation: observeTarget,
      readStandLogs: async (selector) => ({
        operationId: selector.operationId,
        targetIncarnation: selector.targetIncarnation,
        text: "The fixture service is ready.",
        truncated: false,
        sanitized: true,
        capturedAt: new Date().toISOString(),
      }),
    });
    try {
      expect((await act("observe")).status).toBe(200);
      expect(observeTarget).toHaveBeenCalledOnce();
      const logResult = await act("logs");

      expect(logResult.status).toBe(200);
      expect(await logResult.json()).toMatchObject({
        sanitized: true,
        text: "The fixture service is ready.",
      });
      const logsGrant = professional.page.items.find(
        ({ action }) => action === "targets:logs",
      )!;

      await revokeCompanyGrant(db, administratorId, logsGrant.id, {
        expectedRevision: logsGrant.revision,
        reason: "Revoke fixture log authority.",
        idempotencyKey: randomUUID(),
      });
      expect((await act("logs")).status).toBe(403);
    } finally {
      setDefaultTransportForTests(null);
    }
    const identity = { operationId: operation.id, tokenId: credential.tokenId };
    const preparations = await Promise.allSettled([
      prepareStandRestartDispatch(db, identity),
      prepareStandRestartDispatch(db, identity),
    ]);
    const admitted = preparations.find(
      (result) => result.status === "fulfilled",
    );

    expect(preparations.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    if (!admitted) throw new Error("The native command was not retained");
    const command = admitted.value;

    expect(command.envelope.payload.before).toEqual({
      invocationId: "a".repeat(32),
      state: "active",
    });
    expect(command.row.payload.before).toEqual(command.envelope.payload.before);
    const helperToken = randomBytes(32).toString("base64url");
    const previousToken = process.env.STAND_TEST_HELPER_TOKEN;

    process.env.STAND_TEST_HELPER_TOKEN = helperToken;
    try {
      const body = {
        targetIncarnation: input.incarnationId,
        resourceKey: command.envelope.payload.resourceKey,
        requestDigest: operation.requestDigest,
        ownerEpoch: command.envelope.payload.ownerEpoch,
        purpose: "dispatch",
        nonce: randomUUID(),
      };
      const authorize = (value: typeof body) =>
        authorizeStandCallback(db, {
          operationId: operation.id,
          peerFingerprint: input.helperCertificateSha256,
          helperToken,
          body: value,
        });

      const { deliverStandRestartCommand } =
        await import("../restart-dispatch");
      const { adoptStandTargetReceipt } = await import("../receipt-adoption");
      let issuedPermit: string | undefined;
      const sendRestart = vi.fn(async () => {
        await expect(
          authorize({ ...body, ownerEpoch: body.ownerEpoch - 1 }),
        ).rejects.toMatchObject({
          code: "CONFLICT",
        });
        const permits = await Promise.allSettled([
          authorize(body),
          authorize({ ...body, nonce: randomUUID() }),
        ]);

        expect(
          permits.filter((permit) => permit.status === "fulfilled"),
        ).toMatchObject([
          {
            value: {
              operationId: operation.id,
              allowed: true,
              ownerEpoch: body.ownerEpoch,
              purpose: "dispatch",
            },
          },
        ]);
        expect(
          permits.filter((permit) => permit.status === "rejected"),
        ).toMatchObject([{ reason: { code: "CONFLICT" } }]);
        const grant = professional.page.items.find(
          (entry) => entry.action === "targets:restart",
        )!;

        await revokeCompanyGrant(db, administratorId, grant.id, {
          expectedRevision: grant.revision,
          reason: "Revoke fixture restart authority.",
          idempotencyKey: randomUUID(),
        });
        await expect(
          authorize({ ...body, nonce: randomUUID() }),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        const issued = permits.find((permit) => permit.status === "fulfilled");

        if (!issued) throw new Error("The dispatch permit was not retained");
        issuedPermit = issued.value.permitId;
        throw new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "Lost fixture restart response",
          {
            details: { transport: "unknown_outcome" },
          },
        );
      });

      setDefaultTransportForTests({
        ...fake.transport,
        dispatchStandRestart: sendRestart,
      });
      await expect(
        deliverStandRestartCommand(db, command),
      ).rejects.toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
        details: { reason: "delivery_budget_exhausted" },
      });
      expect(sendRestart).toHaveBeenCalledOnce();
      if (!issuedPermit)
        throw new Error("The dispatch permit was not observed");
      const result = {
        operationId: operation.id,
        targetIncarnation: input.incarnationId,
        requestDigest: operation.requestDigest,
        receiptRevision: 3,
        sequence: 4,
        effectState: "confirmed_applied",
        permitId: issuedPermit,
        beforeInvocation: "a".repeat(32),
        afterInvocation: "b".repeat(32),
        observedState: "active",
        capturedAt: new Date().toISOString(),
        reason: null,
      };

      await expect(
        adoptStandTargetReceipt(db, operation.id, {
          ...result,
          permitId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const { getStandOperation } = await import("../operation-intake");

      await expect(
        getStandOperation(db, userId, operation.id),
      ).resolves.toMatchObject({
        effectState: "unknown",
        verificationState: "not_checked",
      });
      const read = await createCompanyGrants(db, administratorId, {
        principalKind: "user",
        principalId: userId,
        actions: ["targets:recover"],
        idempotencyKey: randomUUID(),
      });
      const { POST: reconcile } =
        await import("@/app/api/stand-operations/[operationId]/reconcile/route");
      const recover = (expectedRevision: number) =>
        reconcile(
          new NextRequest(
            `http://localhost/api/stand-operations/${operation.id}/reconcile`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: "http://localhost",
              },
              body: JSON.stringify({ expectedRevision }),
            },
          ),
          { params: Promise.resolve({ operationId: operation.id }) },
        );
      const readTarget = vi.fn(
        async (selector: {
          ownerEpoch: number;
        }): Promise<typeof result | null> => {
          await authorize({
            ...body,
            ownerEpoch: selector.ownerEpoch,
            purpose: "reconcile",
            nonce: randomUUID(),
          });

          return result;
        },
      );

      setDefaultTransportForTests({
        ...fake.transport,
        readStandReceipt: readTarget,
      });
      const { recoverInterruptedStandOperations } =
        await import("../recovery-sweep");

      await expect(recoverInterruptedStandOperations(db)).resolves.toEqual({
        scanned: 0,
        settled: 0,
        pending: 0,
      });
      await database.pool.query(
        "UPDATE stand_resource_claims SET expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",
        [operation.id],
      );
      await database.pool.query(
        "UPDATE stand_read_claims SET expires_at=clock_timestamp()-interval '31 seconds' WHERE operation_id=$1 AND purpose='reconcile'",
        [operation.id],
      );
      readTarget.mockImplementationOnce(async ({ ownerEpoch }) => {
        await authorize({
          ...body,
          ownerEpoch,
          purpose: "reconcile",
          nonce: randomUUID(),
        });

        return null;
      });
      await expect(recoverInterruptedStandOperations(db)).resolves.toEqual({
        scanned: 1,
        settled: 0,
        pending: 1,
      });
      await expect(
        getStandOperation(db, userId, operation.id),
      ).resolves.toMatchObject({
        effectState: "unknown",
        disposition: "pending",
      });
      readTarget.mockRejectedValueOnce(
        new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "Fixture target is unavailable",
        ),
      );
      expect((await recover(operation.revision + 2)).status).toBe(503);
      await expect(
        getStandOperation(db, userId, operation.id),
      ).resolves.toMatchObject({
        effectState: "unknown",
        disposition: "pending",
      });
      expect(sendRestart).toHaveBeenCalledOnce();
      await expect(recoverInterruptedStandOperations(db)).resolves.toEqual({
        scanned: 0,
        settled: 0,
        pending: 0,
      });
      const { POST: inspectRecovery } =
        await import("@/app/api/stand-operations/[operationId]/recovery-inspections/route");
      const inspect = (expectedRevision: number) =>
        inspectRecovery(
          new NextRequest(
            `http://localhost/api/stand-operations/${operation.id}/recovery-inspections`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: "http://localhost",
              },
              body: JSON.stringify({ expectedRevision }),
            },
          ),
          { params: Promise.resolve({ operationId: operation.id }) },
        );
      const inspectTarget = vi.fn(
        async (
          selector: Parameters<typeof fake.transport.observeStandOperation>[0],
        ) => {
          await authorize({
            ...body,
            ownerEpoch: selector.ownerEpoch,
            purpose: "reconcile",
            nonce: randomUUID(),
          });

          return {
            operationId: selector.operationId,
            targetIncarnation: selector.targetIncarnation,
            resourceKey: selector.resourceKey,
            requestDigest: selector.requestDigest,
            sequence: 3,
            invocationId: "b".repeat(32),
            state: "active",
            capturedAt: new Date().toISOString(),
          };
        },
      );

      setDefaultTransportForTests({
        ...fake.transport,
        readStandReceipt: readTarget,
        observeStandOperation: inspectTarget,
      });
      expect((await inspect(operation.revision + 1)).status).toBe(409);
      expect(inspectTarget).not.toHaveBeenCalled();
      const inspection = await inspect(operation.revision + 2);

      expect(inspection.status).toBe(201);
      expect(await inspection.json()).toMatchObject({
        id: expect.any(String),
        operationId: operation.id,
        operationRevision: operation.revision + 2,
        invocationId: "b".repeat(32),
        observedState: "active",
      });
      await expect(
        getStandOperation(db, userId, operation.id),
      ).resolves.toMatchObject({
        effectState: "unknown",
        verificationState: "not_checked",
      });
      await database.pool.query(
        `CREATE FUNCTION fail_fixture_stand_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'Injected receipt persistence failure';
          END;
        $$`,
      );

      try {
        await database.pool.query(
          "CREATE TRIGGER fail_fixture_stand_receipt BEFORE INSERT ON stand_operation_receipts FOR EACH ROW EXECUTE FUNCTION fail_fixture_stand_receipt()",
        );
        expect((await recover(operation.revision + 2)).status).toBe(500);
        await expect(
          getStandOperation(db, userId, operation.id),
        ).resolves.toMatchObject({
          effectState: "unknown",
          receiptIds: [],
        });
        expect(sendRestart).toHaveBeenCalledOnce();
      } finally {
        await database.pool.query(
          "DROP TRIGGER IF EXISTS fail_fixture_stand_receipt ON stand_operation_receipts",
        );
        await database.pool.query("DROP FUNCTION fail_fixture_stand_receipt()");
      }
      const reconciled = await recover(operation.revision + 2);

      expect(reconciled.status).toBe(200);
      const adoptedEffect = await reconciled.json();

      expect(readTarget).toHaveBeenCalledTimes(4);
      expect((await recover(operation.revision + 2)).status).toBe(409);
      expect((await recover(adoptedEffect.revision)).status).toBe(200);
      expect(readTarget).toHaveBeenCalledTimes(4);

      expect(adoptedEffect).toMatchObject({
        effectState: "confirmed_applied",
        verificationState: "not_checked",
        disposition: "proved_applied",
        receiptIds: [expect.any(String)],
      });
      const { POST: verify } =
        await import("@/app/api/stand-operations/[operationId]/verification/route");
      const verifyHealth = () =>
        verify(
          new NextRequest(
            `http://localhost/api/stand-operations/${operation.id}/verification`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: "http://localhost",
              },
              body: JSON.stringify({
                expectedRevision: adoptedEffect.revision,
              }),
            },
          ),
          { params: Promise.resolve({ operationId: operation.id }) },
        );
      const verifyTarget = vi.fn(
        async (selector: {
          operationId: string;
          targetIncarnation: string;
          verificationNonce: string;
          issuedAt: string;
          ownerEpoch: number;
        }) => {
          await authorize({
            ...body,
            ownerEpoch: selector.ownerEpoch,
            purpose: "verify",
            nonce: randomUUID(),
          });

          return {
            id: randomUUID(),
            operationId: selector.operationId,
            targetIncarnation: selector.targetIncarnation,
            nonce: selector.verificationNonce,
            state: "healthy",
            issuedAt: selector.issuedAt,
            observedAt: new Date().toISOString(),
            targetSequence:
              verifyTarget.mock.calls.length === 1
                ? result.sequence
                : result.sequence + 1,
            evidenceIds: [],
            reason: null,
          };
        },
      );

      setDefaultTransportForTests({
        ...fake.transport,
        readStandReceipt: readTarget,
        verifyStandOperation: verifyTarget,
      });
      expect((await verifyHealth()).status).toBe(409);
      const verifiedResponse = await verifyHealth();

      expect(verifiedResponse.status).toBe(200);
      const verified = await verifiedResponse.json();

      expect(verified).toMatchObject({
        effectState: "confirmed_applied",
        verificationState: "healthy",
        receiptIds: adoptedEffect.receiptIds,
        verificationIds: [expect.any(String)],
      });
      await expect(
        database.pool.query(
          "DELETE FROM stand_verifications WHERE operation_id=$1",
          [operation.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      expect(verifyTarget).toHaveBeenCalledTimes(2);
      const { validateOperationalEvidenceReferences } =
        await import("@/lib/run-results/operational-evidence");
      const [run] = await db
        .select({ contract: runs.resultContract })
        .from(runs)
        .where(eq(runs.id, runId));
      const contract = run?.contract;

      expect(contract).toMatchObject({
        contractName: "operational_evidence_v2",
      });
      if (!contract)
        throw new Error("The installed evidence contract is unavailable");
      const decision = {
        kind: "valid" as const,
        valueBytes: 0,
        value: {
          schemaVersion: 2,
          outcome: "success",
          summary: "The configured service is healthy.",
          coverage: { state: "complete", remainingKnown: 0 },
          counts: {
            scanned: 1,
            attempted: 1,
            completed: 1,
            failed: 0,
            skipped: 0,
            created: 0,
          },
          references: [],
          diagnostics: [],
          findings: {
            schemaVersion: 1,
            findings: [],
            selection: [],
            knowledgeProposals: [],
          },
          operationIds: [operation.id],
          verificationIds: verified.verificationIds,
        },
      };

      await expect(
        validateOperationalEvidenceReferences(db, runId, contract, decision),
      ).resolves.toEqual(decision);
      await expect(
        validateOperationalEvidenceReferences(db, runId, contract, {
          ...decision,
          value: { ...decision.value, verificationIds: [randomUUID()] },
        }),
      ).resolves.toMatchObject({
        kind: "invalid",
        reason: "reference_invalid",
      });
      expect(await adoptStandTargetReceipt(db, operation.id, result)).toEqual(
        verified,
      );
      await expect(
        database.pool.query(
          "DELETE FROM stand_operation_receipts WHERE operation_id=$1",
          [operation.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        adoptStandTargetReceipt(db, operation.id, {
          ...result,
          afterInvocation: "c".repeat(32),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const { claimStandReadAuthority } = await import("../read-authority");

      expect(
        await releaseAssignmentForRun(db, runId, "test_stand_recovery"),
      ).toMatchObject({ state: "released" });
      const recovery = await claimStandReadAuthority(
        db,
        userId,
        operation.id,
        "reconcile",
      );
      const adopted = await claimStandReadAuthority(
        db,
        userId,
        operation.id,
        "reconcile",
      );

      expect(adopted.ownerEpoch).toBe(recovery.ownerEpoch + 1);
      await expect(
        authorize({
          ...body,
          ownerEpoch: recovery.ownerEpoch,
          purpose: "reconcile",
          nonce: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      await expect(
        authorize({
          ...body,
          ownerEpoch: recovery.ownerEpoch,
          purpose: "logs",
          nonce: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const reconciliation = {
        ...body,
        ownerEpoch: adopted.ownerEpoch,
        purpose: "reconcile",
        nonce: randomUUID(),
      };

      await expect(authorize(reconciliation)).resolves.toMatchObject({
        operationId: operation.id,
        purpose: "reconcile",
        ownerEpoch: adopted.ownerEpoch,
      });
      const recoveryGrant = read.page.items.find(
        ({ action }) => action === "targets:recover",
      )!;

      await revokeCompanyGrant(db, administratorId, recoveryGrant.id, {
        expectedRevision: recoveryGrant.revision,
        reason: "Revoke fixture recovery authority.",
        idempotencyKey: randomUUID(),
      });
      await expect(
        authorize({ ...reconciliation, nonce: randomUUID() }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await createCompanyGrants(db, administratorId, {
        principalKind: "user",
        principalId: userId,
        actions: ["assignments:accept"],
        idempotencyKey: randomUUID(),
      });
      const { publishRunResult } = await import("@/lib/run-results/ledger");
      const { emitDomainEvent } = await import("@/lib/domain-events/outbox");
      const { dispatchDomainEvents } =
        await import("@/lib/domain-events/dispatch");
      const { specialistAssignmentDeliveryConsumer } =
        await import("@/lib/specialist-assignments/delivery-capture");
      const { acceptSpecialistAssignment } =
        await import("@/lib/specialist-assignments/final-acceptance");
      const { getSpecialistAssignment } =
        await import("@/lib/specialist-assignments/store");
      const published = await db.transaction(async (tx) => {
        const row = await publishRunResult(tx, {
          runId,
          contract,
          value: decision.value,
          valueBytes: Buffer.byteLength(JSON.stringify(decision.value)),
          producerKind: "agent_session",
          producerRef: "default",
        });

        await tx
          .update(runs)
          .set({
            status: "Done",
            endedAt: new Date(),
            operationalTerminal: {
              version: 1,
              status: "Done",
              cause: "completed",
              effectiveOutcome: "success",
              successful: true,
              validation: "valid",
              integrity: "clean",
              baselineGeneration: null,
              resultRevision: row.revision,
              reasonCodes: [],
              evidenceIds: [],
            },
          })
          .where(eq(runs.id, runId));
        await emitDomainEvent({
          db: tx,
          kind: "run.done",
          companyId: owner.companyId,
          runId,
          parentRunId: null,
          actor: { type: "system", id: null },
          payload: { runId, resultStatus: "valid", cause: "completed" },
        });

        return row;
      });

      await dispatchDomainEvents({
        db,
        consumers: [specialistAssignmentDeliveryConsumer],
      });
      const ready = await getSpecialistAssignment(db, userId, assignment.id);

      expect(ready.status).toBe("awaiting_acceptance");
      const accept = (verificationIds: readonly string[]) =>
        acceptSpecialistAssignment(db, {
          userId,
          assignmentId: assignment.id,
          value: {
            expectedRevision: ready.revision,
            inputRevision: ready.inputRevision,
            contextRevision: ready.contextRevision,
            result: { runId, revision: published.revision },
            verificationIds,
            reason: "The operation and independent health are verified.",
            idempotencyKey: randomUUID(),
          },
        });

      await expect(accept([])).rejects.toMatchObject({ code: "PRECONDITION" });
      await expect(accept(verified.verificationIds)).resolves.toMatchObject({
        status: "completed",
      });
    } finally {
      setDefaultTransportForTests(null);
      if (previousToken === undefined)
        delete process.env.STAND_TEST_HELPER_TOKEN;
      else process.env.STAND_TEST_HELPER_TOKEN = previousToken;
    }
  } finally {
    browser.user = null;
  }
});

import type { Logger } from "pino";
import type { KnowledgeAccessCapture } from "@/lib/company/types";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type {
  PreparedSpecialistAssignment,
  AssignmentDestination,
} from "../types";
import type { RunResultContract } from "@/lib/run-results/types";

import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import { join, resolve } from "node:path";

import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  createSpecialistAssignment,
  activateInitialSpecialistAssignmentRunInTransaction,
  getSpecialistAssignmentInput,
  getSpecialistAssignment,
  cancelSpecialistAssignment,
  recoverSpecialistAssignment,
  appendSpecialistAssignmentInput,
  linkSpecialistAssignmentRun,
} from "../store";
import { specialistAssignmentDeliveryConsumer } from "../delivery-capture";
import { assignmentDeliveryViewSchema } from "../delivery-read-types";
import {
  getSpecialistAssignmentDelivery,
  replaySpecialistAssignmentDelivery,
} from "../delivery-read";

import { GET as admissionGet } from "@/app/api/specialist-assignments/[assignmentId]/admission/route";
import { POST as acceptAssignment } from "@/app/api/specialist-assignments/[assignmentId]/acceptance/route";
import { POST as acceptExternalAssignment } from "@/app/api/v1/ext/specialist-assignments/[assignmentId]/acceptance/route";
import { GET as externalAdmissionGet } from "@/app/api/v1/ext/specialist-assignments/[assignmentId]/admission/route";
import { GET as deliveryGet } from "@/app/api/specialist-assignments/[assignmentId]/delivery/route";
import { POST as deliveryReplay } from "@/app/api/specialist-assignments/[assignmentId]/delivery/[deliveryId]/replay/route";
import { GET as externalDeliveryGet } from "@/app/api/v1/ext/specialist-assignments/[assignmentId]/delivery/route";
import { POST as externalDeliveryReplay } from "@/app/api/v1/ext/specialist-assignments/[assignmentId]/delivery/[deliveryId]/replay/route";
import { MaisterError } from "@/lib/errors";
import { issueUserAccessToken, issueToken } from "@/lib/tokens/issue";
import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { parseAgentDefinition } from "@/lib/agents/definition";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { readFormSchemaDocWithBytes } from "@/lib/config";
import { platformAcpRunners, platformRuntimeSettings } from "@/lib/db/schema";
import { dispatchDomainEvents } from "@/lib/domain-events/dispatch";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import {
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import {
  getInboxItems,
  getUnreadInboxCount,
  getUnreadInboxCountsByProject,
} from "@/lib/queries/inbox";
import { buildFlowExportContract } from "@/lib/run-results/contract";
import { publishRunResult } from "@/lib/run-results/ledger";
import { OPERATIONAL_EVIDENCE_FORM_SCHEMA } from "@/lib/run-results/operational-schema";
import { runWebhookDeliveryJob } from "@/lib/scheduler/handlers/webhook-delivery";
import { markInboxItemRead } from "@/lib/social/inbox";
import { replayDelivery } from "@/lib/webhooks/replay";
import {
  createSubscription,
  updateSubscription,
} from "@/lib/webhooks/subscriptions";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import { seedProjectRow } from "@/test-support/execution-host-seed";

let database: StartedPostgresTestDb;
let root: string;
let server: Server;
let endpoint: string;
let contract: RunResultContract;
let scheduledStand: {
  contract: RunResultContract;
  standingDefinition: PreparedSpecialistAssignment["standingDefinition"];
  value: Record<string, unknown>;
};
let preparedBase: Omit<
  PreparedSpecialistAssignment,
  "owner" | "destination" | "origin"
>;
const administratorId = randomUUID();
const requests: { path: string; key: string; body: unknown }[] = [];
const receivedBodySchema = z
  .object({
    apiVersion: z.literal(1),
    id: z.string(),
    type: z.literal("assignment.result_available"),
    occurredAt: z.string(),
    project: z.null(),
    run: z.null(),
    deliveryId: z.string(),
    attempt: z.number().int().positive(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
let dropNextResponse = false;
const output = {
  schemaVersion: 1,
  findings: [],
  knowledgeProposals: [],
  selection: [],
};
const observerDefinition = `---
name: Stand observation fixture
description: Returns the recorded coverage of a scheduled stand check.
specialist: {responsibilities: [Inspect an appointed stand], targetClasses: [stand]}
workspace: none
mode: session
triggers: [cron]
risk_tier: read_only
---
Report a bounded observation without changing the service.
`;

const deliveryLogObserver = vi.hoisted(() => ({
  records: [] as { fields: unknown; message: unknown }[],
}));

vi.mock("pino", async (original) => {
  const actual = await original<typeof import("pino")>();

  return {
    ...actual,
    default: new Proxy(actual.default, {
      apply(target, receiver, args: unknown[]) {
        const logger = Reflect.apply(target, receiver, args) as Logger;
        const warn = logger.warn;

        vi.spyOn(logger, "warn").mockImplementation((...values: unknown[]) => {
          deliveryLogObserver.records.push({
            fields: values[0],
            message: values[1],
          });
          Reflect.apply(warn, logger, values);
        });

        return logger;
      },
    }),
  };
});
const deliverySession = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/authz", async (original) => {
  const actual = await original<typeof import("@/lib/authz")>();

  return {
    ...actual,
    requireActiveSession: async () => {
      if (deliverySession.userId === null)
        throw new MaisterError(
          "UNAUTHENTICATED",
          "An authenticated delivery operator is required",
        );

      return actual.requireActiveUserById(deliverySession.userId);
    },
  };
});
vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "specialist_delivery",
  });
  root = await mkdtemp(join(os.tmpdir(), "specialist-delivery-"));
  vi.spyOn(os, "homedir").mockReturnValue(root);
  vi.stubEnv("MAISTER_WEBHOOK_ALLOW_HOSTS", "127.0.0.1");
  vi.stubEnv("ASSIGNMENT_DELIVERY_TEST_SECRET", "local-test-signing-secret");
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active')",
    [administratorId, `${administratorId}@example.test`],
  );
  const runnerId = randomUUID();

  await database.db
    .insert(platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId));
  await database.db.insert(platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: runnerId,
    webhooksEnabled: true,
  });
  const source = join(root, "source");

  await cp(resolve("test-fixtures/rah-native"), source, { recursive: true });
  await writeFile(
    join(source, "maister-agents/stand-observer.md"),
    observerDefinition,
  );
  const installed = await installPackageRevision({
    source,
    version: "rah/delivery-fixture",
    db: database.db,
  });

  await trustPackageRevision({
    packageInstallId: installed.id,
    db: database.db,
  });
  const pin = (
    await database.pool.query<{
      installed_path: string;
      resolved_revision: string;
    }>(
      "SELECT installed_path,resolved_revision FROM package_installs WHERE id=$1",
      [installed.id],
    )
  ).rows[0]!;
  const agentId = "rah:evidence-researcher";
  const definition = parseAgentDefinition(
    agentId,
    await readFile(
      join(pin.installed_path, "maister-agents/evidence-researcher.md"),
      "utf8",
    ),
  );
  const flow = (
    await database.pool.query<{ id: string; installed_path: string }>(
      "SELECT id,installed_path FROM flow_revisions WHERE resolved_revision=$1 AND flow_ref_id='rah-control'",
      [pin.resolved_revision],
    )
  ).rows[0]!;
  const { schema, bytes } = await readFormSchemaDocWithBytes(
    flow.installed_path,
    "./schemas/evidence-findings.v1.json",
  );

  contract = buildFlowExportContract({
    flowRefId: "rah-control",
    resolvedRevision: pin.resolved_revision,
    flowRevisionId: flow.id,
    schemaPath: "./schemas/evidence-findings.v1.json",
    schema,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    required: true,
    producerNodeIds: ["research"],
    nativeContract: "evidence_findings_v1",
  });
  preparedBase = {
    specialistBindingId: randomUUID(),
    responsibleAgentId: agentId,
    objectiveInput: {
      objective: "Deliver a bounded research result",
      expectedOutcome:
        "Retain exact result availability without claiming acceptance",
      input: "Research only",
      targetIds: [],
      inputRefs: [],
      constraints: [],
      expectedResult: {
        schemaRef: contract.schemaRef,
        schemaVersion: contract.schemaVersion,
        sha256: contract.sha256,
        required: true,
      },
      verification: [],
    },
    standingDefinition: {
      schemaVersion: 1,
      agentId,
      packageInstallId: installed.id,
      packageName: installed.name,
      packageRevision: pin.resolved_revision,
      definitionSha256: agentDefinitionSha256(definition),
      definition,
      configuration: null,
    },
    sourceRestrictions: [],
    scheduledRequest: null,
    executionPolicy: { preset: "supervised" },
  };
  const observer = parseAgentDefinition(
    "rah:stand-observer",
    observerDefinition,
  );
  const standSchema = OPERATIONAL_EVIDENCE_FORM_SCHEMA;

  scheduledStand = {
    standingDefinition: {
      ...preparedBase.standingDefinition,
      agentId: "rah:stand-observer",
      definition: observer,
      definitionSha256: agentDefinitionSha256(observer),
    },
    contract: buildFlowExportContract({
      flowRefId: "rah-control",
      resolvedRevision: pin.resolved_revision,
      flowRevisionId: flow.id,
      schemaPath: "./schemas/operational-evidence.v2.json",
      schema: standSchema,
      sha256: createHash("sha256")
        .update(JSON.stringify(standSchema))
        .digest("hex"),
      required: true,
      producerNodeIds: ["research"],
      nativeContract: "operational_evidence_v2",
    }),
    value: {
      schemaVersion: 2,
      outcome: "success",
      summary: "The scheduled check found no actionable change.",
      coverage: { state: "complete", remainingKnown: 0 },
      counts: {
        scanned: 1,
        attempted: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        created: 0,
      },
      references: [],
      diagnostics: [],
      findings: output,
      operationIds: [],
      verificationIds: [],
    },
  };
  server = createServer(async (request, response) => {
    const parts: Buffer[] = [];

    for await (const part of request)
      parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    requests.push({
      path: request.url ?? "",
      key: String(request.headers["x-maister-idempotency-key"]),
      body: JSON.parse(Buffer.concat(parts).toString("utf8")),
    });
    if (dropNextResponse) {
      dropNextResponse = false;
      response.destroy();

      return;
    }
    response.writeHead(200);
    response.end("accepted");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || typeof address === "string")
    throw new Error("The local delivery peer has no TCP address");
  endpoint = `http://127.0.0.1:${address.port}`;
}, 180000);

afterAll(async () => {
  try {
    if (server?.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  } finally {
    await database?.stop();
    if (root) await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

async function recipient(): Promise<{
  userId: string;
  projectId: string;
  taskId: string;
  commentId: string;
}> {
  const userId = randomUUID();
  const project = await seedProjectRow(database.db);
  const taskId = randomUUID();
  const commentId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), project.id, userId],
  );
  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES($1,$2,1,'Native delivery target','Research')",
    [taskId, project.id],
  );
  await database.pool.query(
    "INSERT INTO task_comments(id,project_id,task_id,actor_type,actor_id,body) VALUES($1,$2,$3,'user',$4,'Research request')",
    [commentId, project.id, taskId, userId],
  );

  return { userId, projectId: project.id, taskId, commentId };
}

async function publishResultFixture(
  target: Awaited<ReturnType<typeof recipient>>,
  destination: AssignmentDestination,
  verification = preparedBase.objectiveInput.verification,
  source: {
    contract: RunResultContract;
    value: Record<string, unknown>;
    standingDefinition: PreparedSpecialistAssignment["standingDefinition"];
    scheduledRequest: PreparedSpecialistAssignment["scheduledRequest"];
  } = {
    contract,
    value: output,
    standingDefinition: preparedBase.standingDefinition,
    scheduledRequest: null,
  },
): Promise<{ assignmentId: string; runId: string }> {
  const { contract, value, standingDefinition, scheduledRequest } = source;
  const work = await createSpecialistAssignment(database.db, target.userId, {
    ...preparedBase,
    responsibleAgentId: standingDefinition.agentId,
    standingDefinition,
    scheduledRequest,
    objectiveInput: {
      ...preparedBase.objectiveInput,
      verification,
      expectedResult: {
        schemaRef: contract.schemaRef,
        schemaVersion: contract.schemaVersion,
        sha256: contract.sha256,
        required: true,
      },
    },
    sourceRestrictions: [
      { kind: "project_context", projectId: target.projectId },
    ],
    owner: { kind: "project", projectId: target.projectId },
    origin: scheduledRequest
      ? {
          kind: "schedule",
          scheduleId: scheduledRequest.scheduleId,
          triggerAttemptId: scheduledRequest.triggerAttemptId,
        }
      : { kind: "manual", interactionId: randomUUID() },
    destination,
  });
  const input = await getSpecialistAssignmentInput(
    database.db,
    target.userId,
    work.id,
    1,
  );
  const runId = randomUUID();
  const capture: KnowledgeAccessCapture = {
    schemaVersion: 1,
    generation: 1,
    state: "complete",
    restrictions: [
      {
        kind: "assignment_input",
        assignmentId: work.id,
        inputRevision: 1,
        inputSha256: input.digest,
      },
    ],
  };

  await database.pool.query(
    "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision_id,result_contract,workspace_mode,knowledge_access) VALUES($1,$2,'flow','Running','delivery-fixture',$3,$4::jsonb,'none',$5::jsonb)",
    [
      runId,
      target.projectId,
      contract.kind === "flow_export" ? contract.flowRevisionId : null,
      JSON.stringify(contract),
      JSON.stringify(capture),
    ],
  );
  await database.db.transaction(async (tx) => {
    await activateInitialSpecialistAssignmentRunInTransaction(
      tx,
      target.userId,
      work.id,
      { expectedRevision: 1, inputRevision: 1, runId, role: "coordinator" },
    );
    await publishRunResult(tx, {
      runId,
      contract,
      value,
      valueBytes: Buffer.byteLength(JSON.stringify(value)),
      producerKind: "flow_node",
      producerRef: "research",
    });
    await tx.execute(sql`UPDATE runs SET status='Review' WHERE id=${runId}`);
    await emitDomainEvent({
      db: tx,
      kind: "run.review_opened",
      projectId: target.projectId,
      runId,
      actor: { type: "system", id: null },
      payload: { runId, resultStatus: "valid", cause: "completed" },
    });
  });

  return { assignmentId: work.id, runId };
}

async function capturePublishedResults(maxBatches?: number): Promise<void> {
  expect(
    await dispatchDomainEvents({
      db: database.db,
      consumers: [specialistAssignmentDeliveryConsumer],
      maxBatches,
    }),
  ).toMatchObject({ failures: 0 });
}

async function readyResult(
  ...args: Parameters<typeof publishResultFixture>
): Promise<{ assignmentId: string; runId: string; deliveryId: string }> {
  const work = await publishResultFixture(...args);

  await capturePublishedResults();
  const rows = (
    await database.pool.query<{ id: string }>(
      "SELECT id FROM specialist_delivery_receipts WHERE run_id=$1",
      [work.runId],
    )
  ).rows;

  expect(rows).toHaveLength(1);

  return { ...work, deliveryId: rows[0]!.id };
}

async function finishRootResult(
  projectId: string,
  runId: string,
): Promise<void> {
  await database.db.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE runs SET status='Done',ended_at=clock_timestamp() WHERE id=${runId}`,
    );
    await emitDomainEvent({
      db: tx,
      kind: "run.done",
      projectId,
      runId,
      parentRunId: null,
      actor: { type: "system", id: null },
      payload: { runId, resultStatus: "valid", cause: "completed" },
    });
  });
  expect(
    await dispatchDomainEvents({
      db: database.db,
      consumers: [specialistAssignmentDeliveryConsumer],
    }),
  ).toMatchObject({ failures: 0 });
}

it("IT-CBA-07 completes only after the exact expected root result is ready and accepted", async () => {
  const target = await recipient();
  const { assignmentId, runId } = await readyResult(target, {
    kind: "inbox",
    userId: target.userId,
  });

  expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
    delivered: 1,
  });
  const acceptanceRequest = (
    head: Awaited<ReturnType<typeof getSpecialistAssignment>>,
    verificationIds: string[] = [],
    bearer?: string,
  ) =>
    new NextRequest(
      `http://localhost/api/${bearer ? "v1/ext/" : ""}specialist-assignments/${assignmentId}/acceptance`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({
          expectedRevision: head.revision,
          inputRevision: head.inputRevision,
          contextRevision: head.contextRevision,
          result: { runId, revision: 1 },
          verificationIds,
          reason: "The expected bounded result is complete.",
          idempotencyKey: "accept-bounded-assignment",
        }),
      },
    );
  const params = { params: Promise.resolve({ assignmentId }) };

  deliverySession.userId = target.userId;
  try {
    const review = await getSpecialistAssignment(
      database.db,
      target.userId,
      assignmentId,
    );

    expect(
      (await acceptAssignment(acceptanceRequest(review), params)).status,
    ).toBe(409);
    await finishRootResult(target.projectId, runId);
    const ready = await getSpecialistAssignment(
      database.db,
      target.userId,
      assignmentId,
    );

    expect(ready.status).toBe("awaiting_acceptance");
    expect(
      (await acceptAssignment(acceptanceRequest(ready, [randomUUID()]), params))
        .status,
    ).toBe(409);
    const accepted = await acceptAssignment(acceptanceRequest(ready), params);

    expect(accepted.status).toBe(200);
    const receipt: { id: string } = await accepted.json();
    const credential = await issueUserAccessToken(
      {
        ownerUserId: target.userId,
        name: "assignment-acceptance-reviewer",
        scopes: ["assignments:accept"],
      },
      database.db,
    );
    const replay = await acceptExternalAssignment(
      acceptanceRequest(ready, [], credential.secret),
      params,
    );

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      id: receipt.id,
      duplicate: true,
    });
    expect(
      await getSpecialistAssignment(database.db, target.userId, assignmentId),
    ).toMatchObject({
      status: "completed",
    });
    expect(
      (
        await database.pool.query(
          "SELECT acceptance_id FROM specialist_assignments WHERE id=$1",
          [assignmentId],
        )
      ).rows,
    ).toEqual([{ acceptance_id: receipt.id }]);
    await expect(
      database.pool.query(
        "UPDATE specialist_acceptances SET reason='replace accepted outcome' WHERE id=$1",
        [receipt.id],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "specialist_acceptances_immutable",
    });
  } finally {
    deliverySession.userId = null;
  }
});

it("IT-CBA-07 keeps a result with a required independent health check out of final acceptance", async () => {
  const target = await recipient();
  const { assignmentId, runId } = await readyResult(
    target,
    { kind: "inbox", userId: target.userId },
    [
      {
        kind: "health",
        referenceId: "configured-health-check",
        required: true,
      },
    ],
  );

  expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
    delivered: 1,
  });
  await finishRootResult(target.projectId, runId);
  expect(
    await getSpecialistAssignment(database.db, target.userId, assignmentId),
  ).toMatchObject({ status: "active" });
});

it("IT-CBC-03 retains a superseded root result without letting it ready or complete the assignment", async () => {
  const target = await recipient();
  const { assignmentId, runId, deliveryId } = await readyResult(target, {
    kind: "inbox",
    userId: target.userId,
  });
  const replacementRunId = randomUUID();
  const head = await getSpecialistAssignment(
    database.db,
    target.userId,
    assignmentId,
  );

  await database.pool.query("UPDATE runs SET status='Done' WHERE id=$1", [
    runId,
  ]);
  await database.pool.query(
    "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision_id,result_contract,workspace_mode,knowledge_access) SELECT $2,project_id,run_kind,'Running',flow_version,flow_revision_id,result_contract,workspace_mode,knowledge_access FROM runs WHERE id=$1",
    [runId, replacementRunId],
  );
  await linkSpecialistAssignmentRun(database.db, target.userId, assignmentId, {
    expectedRevision: head.revision,
    inputRevision: head.inputRevision,
    runId: replacementRunId,
    role: "continuation",
    work: null,
  });

  await finishRootResult(target.projectId, runId);
  expect(
    await getSpecialistAssignment(database.db, target.userId, assignmentId),
  ).toMatchObject({ status: "active", runIds: [runId, replacementRunId] });
  expect(
    await database.pool.query(
      "SELECT id FROM specialist_delivery_receipts WHERE run_id=$1",
      [runId],
    ),
  ).toMatchObject({ rows: [{ id: deliveryId }] });

  await database.db.transaction((tx) =>
    publishRunResult(tx, {
      runId: replacementRunId,
      contract,
      value: output,
      valueBytes: Buffer.byteLength(JSON.stringify(output)),
      producerKind: "flow_node",
      producerRef: "research",
    }),
  );
  await finishRootResult(target.projectId, replacementRunId);
  const ready = await getSpecialistAssignment(
    database.db,
    target.userId,
    assignmentId,
  );

  expect(ready.status).toBe("awaiting_acceptance");
  expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
    delivered: 2,
  });
  const accept = (selectedRunId: string) =>
    acceptAssignment(
      new NextRequest(
        `http://localhost/api/specialist-assignments/${assignmentId}/acceptance`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedRevision: ready.revision,
            inputRevision: ready.inputRevision,
            contextRevision: ready.contextRevision,
            result: { runId: selectedRunId, revision: 1 },
            verificationIds: [],
            reason: "Review the current appointment's result.",
            idempotencyKey: "accept-current-root-appointment",
          }),
        },
      ),
      { params: Promise.resolve({ assignmentId }) },
    );

  deliverySession.userId = target.userId;
  try {
    expect((await accept(runId)).status).toBe(409);
    expect((await accept(replacementRunId)).status).toBe(200);
  } finally {
    deliverySession.userId = null;
  }
});

it("IT-CBA-06 delivers one private native Inbox item, hides revoked source access and preserves recipient read state through replay", async () => {
  const target = await recipient();
  const work = await readyResult(target, {
    kind: "inbox",
    userId: target.userId,
  });
  const outcomes = await Promise.all([
    runWebhookDeliveryJob({ db: database.db }),
    runWebhookDeliveryJob({ db: database.db }),
  ]);

  expect(outcomes.reduce((sum, row) => sum + row.delivered, 0)).toBe(1);
  expect(await getUnreadInboxCount(target.userId, "member")).toBe(1);
  await database.pool.query(
    "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
    [target.projectId, target.userId],
  );
  expect(await getInboxItems(target.userId, "member")).toEqual([]);
  expect(await getUnreadInboxCount(target.userId, "member")).toBe(0);
  expect(
    (
      await database.pool.query("SELECT read_at FROM inbox_items WHERE id=$1", [
        work.deliveryId,
      ])
    ).rows,
  ).toEqual([{ read_at: null }]);
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), target.projectId, target.userId],
  );
  expect(
    await markInboxItemRead(
      { itemId: work.deliveryId, userId: administratorId },
      database.db,
    ),
  ).toBe(false);
  expect(
    await markInboxItemRead(
      { itemId: work.deliveryId, userId: target.userId },
      database.db,
    ),
  ).toBe(true);
  const readAt = (
    await database.pool.query("SELECT read_at FROM inbox_items WHERE id=$1", [
      work.deliveryId,
    ])
  ).rows;
  const transport = (
    await database.pool.query<{ id: string }>(
      "SELECT id FROM webhook_deliveries WHERE specialist_delivery_id=$1",
      [work.deliveryId],
    )
  ).rows[0]!;

  await replayDelivery(transport.id, database.db);
  expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
    delivered: 1,
    dead: 0,
  });
  expect(
    (
      await database.pool.query("SELECT read_at FROM inbox_items WHERE id=$1", [
        work.deliveryId,
      ])
    ).rows,
  ).toEqual(readAt);
  expect(await getUnreadInboxCount(target.userId, "member")).toBe(0);
  expect(
    await getInboxItems(target.userId, "member", { includeRead: true }),
  ).toHaveLength(1);
});

it("IT-CBA-06 concurrently appends one control-only task reply and refuses a revoked comment authority before its effect", async () => {
  const target = await recipient();
  const work = await readyResult(target, {
    kind: "task_comment",
    projectId: target.projectId,
    taskId: target.taskId,
    threadCommentId: target.commentId,
  });

  await database.pool.query(
    "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
    [target.projectId, target.userId],
  );
  expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
    delivered: 0,
    dead: 1,
  });
  expect(
    (
      await database.pool.query(
        "SELECT id FROM task_comments WHERE via_operation_id=$1",
        [work.deliveryId],
      )
    ).rows,
  ).toEqual([]);
  await database.pool.query(
    "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
    [target.projectId, target.userId],
  );
  const transport = (
    await database.pool.query<{ id: string }>(
      "SELECT id FROM webhook_deliveries WHERE specialist_delivery_id=$1",
      [work.deliveryId],
    )
  ).rows[0]!;

  await replayDelivery(transport.id, database.db);
  const outcomes = await Promise.all([
    runWebhookDeliveryJob({ db: database.db }),
    runWebhookDeliveryJob({ db: database.db }),
  ]);

  expect(outcomes.reduce((sum, row) => sum + row.delivered, 0)).toBe(1);
  expect(
    (
      await database.pool.query(
        "SELECT body,actor_type,actor_id FROM task_comments WHERE via_operation_id=$1",
        [work.deliveryId],
      )
    ).rows,
  ).toEqual([
    {
      body: `Result available / Результат доступен: [Run / Запуск](/runs/${work.runId}).`,
      actor_type: "system",
      actor_id: null,
    },
  ]);
  await replayDelivery(transport.id, database.db);
  expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
    delivered: 1,
  });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM task_comments WHERE via_operation_id=$1",
        [work.deliveryId],
      )
    ).rows,
  ).toEqual([{ count: 1 }]);
});

it("IT-CBA-06 sends a frozen result only to its configured peer and retries a lost ACK without repeating execution", async () => {
  const target = await recipient();
  const subscription = await createSubscription(
    { projectId: null, ownerUserId: target.userId },
    {
      name: "Exact reply",
      url: `${endpoint}/target`,
      event_types: ["assignment.result_available"],
      signing_secret_ref: "env:ASSIGNMENT_DELIVERY_TEST_SECRET",
    },
    database.db,
  );

  await createSubscription(
    { projectId: null, ownerUserId: target.userId },
    {
      name: "Sibling",
      url: `${endpoint}/sibling`,
      event_types: ["*"],
      signing_secret_ref: "env:ASSIGNMENT_DELIVERY_TEST_SECRET",
    },
    database.db,
  );
  await createSubscription(
    { projectId: null },
    {
      name: "Platform",
      url: `${endpoint}/platform`,
      event_types: ["*"],
      signing_secret_ref: "env:ASSIGNMENT_DELIVERY_TEST_SECRET",
    },
    database.db,
  );
  const correlationId = randomUUID();
  const work = await readyResult(target, {
    kind: "outbound_subscription",
    subscriptionId: subscription.id,
    correlationId,
  });
  const before = requests.length;
  const allocations = (
    await database.pool.query(
      "SELECT (SELECT count(*)::int FROM runs) AS runs,(SELECT count(*)::int FROM specialist_assignments) AS assignments",
    )
  ).rows;

  dropNextResponse = true;
  expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
    delivered: 0,
    failed: 1,
    dead: 0,
  });
  await database.pool.query(
    "UPDATE webhook_deliveries SET next_attempt_at=now() WHERE specialist_delivery_id=$1",
    [work.deliveryId],
  );
  expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
    delivered: 1,
    dead: 0,
  });
  const delivered = requests.slice(before).map((request) => ({
    ...request,
    body: receivedBodySchema.parse(request.body),
  }));
  const document = z
    .object({
      components: z.object({ schemas: z.record(z.string(), z.unknown()) }),
    })
    .parse(
      parseYaml(
        await readFile(
          resolve("../docs/api/async/outbound-webhooks.asyncapi.yaml"),
          "utf8",
        ),
      ),
    );
  const publicSchema = z
    .record(z.string(), z.unknown())
    .parse(document.components.schemas.DataAssignmentResultAvailable);
  const validate = new Ajv({
    strict: false,
    formats: { uuid: (value: string) => z.uuid().safeParse(value).success },
  }).compile(publicSchema);

  for (const request of delivered)
    expect(validate(request.body.data), JSON.stringify(validate.errors)).toBe(
      true,
    );
  expect(delivered[0]!.body.data.correlationId).toBe(correlationId);
  expect(delivered[0]!.body.data.result).toMatchObject({
    schemaSha256: contract.sha256,
  });

  expect(delivered.map((request) => request.path)).toEqual([
    "/target",
    "/target",
  ]);
  expect(delivered[0]!.body.id).toBe(delivered[1]!.body.id);
  expect(delivered[0]!.body.deliveryId).toBe(delivered[1]!.body.deliveryId);
  expect(delivered[0]!.key).toBe(delivered[1]!.key);
  expect(delivered.map((request) => request.body.attempt)).toEqual([1, 2]);
  expect(delivered[0]!.body.data.assignmentId).toBe(work.assignmentId);
  expect(
    (
      await database.pool.query(
        "SELECT (SELECT count(*)::int FROM runs) AS runs,(SELECT count(*)::int FROM specialist_assignments) AS assignments",
      )
    ).rows,
  ).toEqual(allocations);
  expect(
    (
      await database.pool.query(
        "SELECT status,acceptance_id FROM specialist_assignments WHERE id=$1",
        [work.assignmentId],
      )
    ).rows,
  ).toEqual([{ status: "active", acceptance_id: null }]);
});

it("IT-CBA-06 reads a large authorized native Inbox without combining independent source budgets and still rejects one oversized root", async () => {
  const target = await recipient();
  const work: Awaited<ReturnType<typeof publishResultFixture>>[] = [];

  // Publish independent roots in bounded batches. Capture their outbox events
  // once the fixtures exist, as the real consumer does on a scheduler tick.
  for (let offset = 0; offset < 260; offset += 8) {
    work.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(8, 260 - offset) }, () =>
          publishResultFixture(target, { kind: "inbox", userId: target.userId }),
        ),
      )),
    );
  }
  // A root publishes several domain events, so 260 roots exceed one tick's
  // default 1,000-event allowance.
  await capturePublishedResults(20);
  const previousBatchSize = process.env.MAISTER_WEBHOOK_DELIVERY_BATCH;

  try {
    vi.stubEnv("MAISTER_WEBHOOK_DELIVERY_BATCH", "100");
    for (let batch = 0; batch < 3; batch++)
      await runWebhookDeliveryJob({ db: database.db });
  } finally {
    vi.stubEnv("MAISTER_WEBHOOK_DELIVERY_BATCH", previousBatchSize);
  }
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM inbox_items WHERE recipient_id=$1 AND event_kind='assignment_result_available'",
        [target.userId],
      )
    ).rows,
  ).toEqual([{ count: 260 }]);
  expect(await getUnreadInboxCount(target.userId, "member")).toBe(260);
  expect(
    await getInboxItems(target.userId, "member", { limit: 100 }),
  ).toHaveLength(100);
  expect(
    (
      await getUnreadInboxCountsByProject(target.userId, "member", [
        target.projectId,
      ])
    ).get(target.projectId),
  ).toBe(260);
  const inputs = (
    await database.pool.query<{
      assignment_id: string;
      revision: number;
      digest: string;
    }>(
      "SELECT assignment_id,revision,digest FROM specialist_input_revisions WHERE assignment_id=ANY($1::text[]) AND revision=1",
      [work.slice(0, 256).map((row) => row.assignmentId)],
    )
  ).rows;

  expect(inputs).toHaveLength(256);
  const overBudget: KnowledgeAccessCapture = {
    schemaVersion: 1,
    generation: 2,
    state: "complete",
    restrictions: inputs.map((input) => ({
      kind: "assignment_input",
      assignmentId: input.assignment_id,
      inputRevision: input.revision,
      inputSha256: input.digest,
    })),
  };

  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [work[0].runId, JSON.stringify(overBudget)],
  );
  await expect(
    getUnreadInboxCount(target.userId, "member"),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_reference_budget_exceeded" },
  });
}, 120000);

it("IT-CBA-06 inspects an actual retained result before and after transport dispatch", async () => {
  const target = await recipient();
  const work = await readyResult(target, {
    kind: "inbox",
    userId: target.userId,
  });
  const pending = await getSpecialistAssignmentDelivery(
    database.db,
    target.userId,
    work.assignmentId,
    { runId: work.runId },
  );

  expect(pending).toMatchObject({
    schemaVersion: 1,
    assignmentId: work.assignmentId,
    deliveryId: work.deliveryId,
    runId: work.runId,
    inputRevision: 1,
    resultRevision: 1,
    destination: { kind: "inbox", userId: target.userId },
    transport: {
      state: "awaiting_dispatch",
      id: null,
      stateSha256: null,
      attemptCount: 0,
      lastAttemptNo: 0,
    },
  });
  await runWebhookDeliveryJob({ db: database.db });
  const delivered = await getSpecialistAssignmentDelivery(
    database.db,
    target.userId,
    work.assignmentId,
    { runId: work.runId },
  );

  expect(delivered.transport).toMatchObject({
    state: "delivered",
    attemptCount: 1,
    lastAttemptNo: 1,
    nextAttemptAt: null,
  });
  expect(delivered.transport.stateSha256).toMatch(/^[a-f0-9]{64}$/);
  const differentDatabaseTimezone = await database.db.transaction(
    async (tx) => {
      await tx.execute(sql`SET LOCAL TIME ZONE 'Asia/Tokyo'`);

      return getSpecialistAssignmentDelivery(
        tx,
        target.userId,
        work.assignmentId,
        { runId: work.runId },
      );
    },
  );

  expect(differentDatabaseTimezone.transport.stateSha256).toBe(
    delivered.transport.stateSha256,
  );
  expect(delivered).not.toHaveProperty("sourceRestrictions");
  expect(delivered).not.toHaveProperty("requesterUserId");
  expect(delivered.transport).not.toHaveProperty("lastErrorMessage");
});

it("delivers a claimed no-change result without an authentic scheduled stand probe", async () => {
  const target = await recipient();
  const work = await readyResult(
    target,
    { kind: "inbox", userId: target.userId },
    [],
    {
      ...scheduledStand,
      scheduledRequest: {
        version: 1,
        scheduleId: randomUUID(),
        triggerAttemptId: randomUUID(),
        requestAtLaunch:
          "Inspect the appointed service without making changes.",
      },
    },
  );
  const readDelivery = () =>
    getSpecialistAssignmentDelivery(
      database.db,
      target.userId,
      work.assignmentId,
      {
        runId: work.runId,
      },
    );

  expect((await readDelivery()).transport.state).toBe("awaiting_dispatch");
  await runWebhookDeliveryJob({ db: database.db });
  expect(await getUnreadInboxCount(target.userId, "member")).toBe(1);
  expect((await readDelivery()).transport).toMatchObject({
    state: "delivered",
    attemptCount: 1,
  });
});

it("IT-CBA-06 replays one inspected transport cycle and rejects concurrent and delayed duplicate witnesses", async () => {
  const target = await recipient();
  const work = await readyResult(target, {
    kind: "inbox",
    userId: target.userId,
  });

  await runWebhookDeliveryJob({ db: database.db });
  await markInboxItemRead(
    { itemId: work.deliveryId, userId: target.userId },
    database.db,
  );
  const inspection = await getSpecialistAssignmentDelivery(
    database.db,
    administratorId,
    work.assignmentId,
    { runId: work.runId },
  );
  const expectedStateSha256 = z
    .string()
    .parse(inspection.transport.stateSha256);
  const counts = (
    await database.pool.query(
      "SELECT (SELECT count(*)::int FROM runs) AS runs,(SELECT count(*)::int FROM specialist_assignments) AS assignments",
    )
  ).rows;
  const readAt = (
    await database.pool.query("SELECT read_at FROM inbox_items WHERE id=$1", [
      work.deliveryId,
    ])
  ).rows;
  const replay = () =>
    replaySpecialistAssignmentDelivery(
      database.db,
      administratorId,
      work.assignmentId,
      work.deliveryId,
      { schemaVersion: 1, expectedStateSha256 },
    );
  const concurrent = await Promise.allSettled([replay(), replay()]);

  expect(concurrent.filter((item) => item.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(concurrent.filter((item) => item.status === "rejected")).toMatchObject(
    [
      {
        reason: {
          code: "CONFLICT",
          details: { reason: "assignment_delivery_state_conflict" },
        },
      },
    ],
  );
  expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
    delivered: 1,
  });
  const after = await getSpecialistAssignmentDelivery(
    database.db,
    administratorId,
    work.assignmentId,
    { runId: work.runId },
  );

  expect(after.transport).toMatchObject({
    state: "delivered",
    attemptCount: 1,
    lastAttemptNo: 2,
  });
  expect(after.transport.stateSha256).not.toBe(expectedStateSha256);
  await expect(replay()).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    (
      await database.pool.query("SELECT read_at FROM inbox_items WHERE id=$1", [
        work.deliveryId,
      ])
    ).rows,
  ).toEqual(readAt);
  expect(
    (
      await database.pool.query(
        "SELECT (SELECT count(*)::int FROM runs) AS runs,(SELECT count(*)::int FROM specialist_assignments) AS assignments",
      )
    ).rows,
  ).toEqual(counts);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM inbox_items WHERE assignment_delivery_id=$1",
        [work.deliveryId],
      )
    ).rows,
  ).toEqual([{ count: 1 }]);
});

it("IT-CBA-06 keeps authorized delivery history after recipient revocation and cancellation while refusing replay", async () => {
  const target = await recipient();
  const work = await readyResult(target, {
    kind: "inbox",
    userId: target.userId,
  });

  await runWebhookDeliveryJob({ db: database.db });
  const inspect = () =>
    getSpecialistAssignmentDelivery(
      database.db,
      administratorId,
      work.assignmentId,
      { runId: work.runId },
    );
  const original = await inspect();
  const replay = () =>
    replaySpecialistAssignmentDelivery(
      database.db,
      administratorId,
      work.assignmentId,
      work.deliveryId,
      {
        schemaVersion: 1,
        expectedStateSha256: z.string().parse(original.transport.stateSha256),
      },
    );

  await database.pool.query(
    "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
    [target.projectId, target.userId],
  );
  expect(await inspect()).toEqual(original);
  await expect(replay()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    getSpecialistAssignmentDelivery(
      database.db,
      target.userId,
      work.assignmentId,
      { runId: work.runId },
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), target.projectId, target.userId],
  );
  await database.pool.query("UPDATE runs SET status='Done' WHERE id=$1", [
    work.runId,
  ]);
  const assignment = await getSpecialistAssignment(
    database.db,
    administratorId,
    work.assignmentId,
  );

  await cancelSpecialistAssignment(
    database.db,
    administratorId,
    work.assignmentId,
    assignment.revision,
    "Requested work cancelled",
  );
  expect(await inspect()).toEqual(original);
  await expect(replay()).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "assignment_delivery_superseded" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT status,attempt_count FROM webhook_deliveries WHERE specialist_delivery_id=$1",
        [work.deliveryId],
      )
    ).rows,
  ).toEqual([{ status: "delivered", attempt_count: 1 }]);
  await expect(
    getSpecialistAssignmentDelivery(
      database.db,
      administratorId,
      work.assignmentId,
      { runId: randomUUID() },
    ),
  ).rejects.toMatchObject({
    details: { reason: "assignment_delivery_reference_unavailable" },
  });
});

it("IT-CBA-06 enforces session origin, closed bounded contracts and personal-token audit at delivery HTTP boundaries", async () => {
  const target = await recipient();
  const work = await readyResult(target, {
    kind: "inbox",
    userId: target.userId,
  });

  await runWebhookDeliveryJob({ db: database.db });
  const url = `http://localhost/api/specialist-assignments/${work.assignmentId}/delivery`;
  const params = {
    params: Promise.resolve({
      assignmentId: work.assignmentId,
      deliveryId: work.deliveryId,
    }),
  };

  deliverySession.userId = null;
  expect(
    (await deliveryGet(new NextRequest(url + `?runId=${work.runId}`), params))
      .status,
  ).toBe(401);
  deliverySession.userId = administratorId;
  try {
    const response = await deliveryGet(
      new NextRequest(url + `?runId=${work.runId}`),
      params,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const inspection = assignmentDeliveryViewSchema.parse(
      await response.json(),
    );
    const body = {
      schemaVersion: 1,
      expectedStateSha256: inspection.transport.stateSha256,
    };
    const post = (value: unknown, origin = "http://localhost") =>
      deliveryReplay(
        new NextRequest(url + `/${work.deliveryId}/replay`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            origin,
            host: "localhost",
          },
          body: typeof value === "string" ? value : JSON.stringify(value),
        }),
        params,
      );

    expect((await post(body, "http://foreign.test")).status).toBe(403);
    expect(
      (await post({ ...body, requesterUserId: target.userId })).status,
    ).toBe(400);
    expect((await post(JSON.stringify(body) + " ".repeat(4096))).status).toBe(
      413,
    );
    for (const query of [
      `?runId=${work.runId}&runId=${work.runId}`,
      `?runId=${work.runId}&actorId=x`,
      `?runId=${work.runId}&resultRevision=2147483648`,
      `?runId=${work.runId}&resultRevision=1e0`,
    ])
      expect(
        (await deliveryGet(new NextRequest(url + query), params)).status,
      ).toBe(400);
    expect(
      (
        await deliveryGet(
          new NextRequest(url + `?runId=${randomUUID()}`),
          params,
        )
      ).status,
    ).toBe(404);
    const foreign = await recipient();
    const foreignWork = await readyResult(foreign, {
      kind: "inbox",
      userId: foreign.userId,
    });

    expect(
      (
        await deliveryReplay(
          new NextRequest(url + `/${foreignWork.deliveryId}/replay`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              origin: "http://localhost",
              host: "localhost",
            },
            body: JSON.stringify(body),
          }),
          {
            params: Promise.resolve({
              assignmentId: work.assignmentId,
              deliveryId: foreignWork.deliveryId,
            }),
          },
        )
      ).status,
    ).toBe(404);
    const readOnly = await issueUserAccessToken(
      {
        ownerUserId: administratorId,
        name: "delivery-read",
        scopes: ["assignments:read"],
      },
      database.db,
    );
    const recover = await issueUserAccessToken(
      {
        ownerUserId: administratorId,
        name: "delivery-recovery",
        scopes: ["assignments:read", "assignments:recover"],
      },
      database.db,
    );
    const extUrl = url.replace("/api/", "/api/v1/ext/");
    const extPost = (secret: string, value: unknown) =>
      externalDeliveryReplay(
        new NextRequest(extUrl + `/${work.deliveryId}/replay`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify(value),
        }),
        params,
      );

    expect(
      (
        await externalDeliveryGet(
          new NextRequest(extUrl + `?runId=${work.runId}`, {
            headers: { authorization: `Bearer ${readOnly.secret}` },
          }),
          params,
        )
      ).status,
    ).toBe(200);
    expect((await extPost(readOnly.secret, body)).status).toBe(403);
    const projectToken = await issueToken(
      {
        projectId: target.projectId,
        name: "delivery-project-refusal",
        scopes: ["assignments:recover"],
      },
      database.db,
    );

    expect((await extPost(projectToken.secret, body)).status).toBe(403);
    expect(
      (
        await extPost(recover.secret, {
          ...body,
          destination: { kind: "inbox", userId: administratorId },
        })
      ).status,
    ).toBe(422);
    expect((await extPost(recover.secret, body)).status).toBe(200);
    expect((await extPost(recover.secret, body)).status).toBe(409);
    expect(
      (
        await database.pool.query(
          "SELECT method,status_code,scope_used FROM token_audit_log WHERE token_id=$1 ORDER BY created_at,id",
          [recover.tokenId],
        )
      ).rows,
    ).toEqual([
      { method: "POST", status_code: 422, scope_used: "assignments:recover" },
      { method: "POST", status_code: 200, scope_used: "assignments:recover" },
      { method: "POST", status_code: 409, scope_used: "assignments:recover" },
    ]);
    await runWebhookDeliveryJob({ db: database.db });
    const current = await getSpecialistAssignmentDelivery(
      database.db,
      administratorId,
      work.assignmentId,
      { runId: work.runId },
    );

    expect(
      (
        await post({
          schemaVersion: 1,
          expectedStateSha256: current.transport.stateSha256,
        })
      ).status,
    ).toBe(200);
    await runWebhookDeliveryJob({ db: database.db });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM inbox_items WHERE assignment_delivery_id=$1",
          [work.deliveryId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  } finally {
    deliverySession.userId = null;
  }
});

it("IT-CBA-06 selects retained result revisions and refuses replay after actual result supersession", async () => {
  const target = await recipient();
  const work = await readyResult(target, {
    kind: "inbox",
    userId: target.userId,
  });

  await runWebhookDeliveryJob({ db: database.db });
  const original = await getSpecialistAssignmentDelivery(
    database.db,
    administratorId,
    work.assignmentId,
    { runId: work.runId },
  );

  await database.db.transaction(async (tx) => {
    await publishRunResult(tx, {
      runId: work.runId,
      contract,
      value: output,
      valueBytes: Buffer.byteLength(JSON.stringify(output)),
      producerKind: "flow_node",
      producerRef: "research",
    });
    await emitDomainEvent({
      db: tx,
      kind: "run.review_opened",
      projectId: target.projectId,
      runId: work.runId,
      actor: { type: "system", id: null },
      payload: { runId: work.runId, resultStatus: "valid", cause: "completed" },
    });
  });
  expect(
    await dispatchDomainEvents({
      db: database.db,
      consumers: [specialistAssignmentDeliveryConsumer],
    }),
  ).toMatchObject({ failures: 0 });
  expect(
    await getSpecialistAssignmentDelivery(
      database.db,
      administratorId,
      work.assignmentId,
      { runId: work.runId, resultRevision: 1 },
    ),
  ).toEqual(original);
  expect(
    await getSpecialistAssignmentDelivery(
      database.db,
      administratorId,
      work.assignmentId,
      { runId: work.runId },
    ),
  ).toMatchObject({
    resultRevision: 2,
    transport: { state: "awaiting_dispatch" },
  });
  await expect(
    replaySpecialistAssignmentDelivery(
      database.db,
      administratorId,
      work.assignmentId,
      work.deliveryId,
      {
        schemaVersion: 1,
        expectedStateSha256: z.string().parse(original.transport.stateSha256),
      },
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "assignment_delivery_result_unavailable" },
  });
});

it.each(["inbox", "task_comment"] as const)(
  "IT-CBA-06 rolls back the %s effect with a failed acknowledgement and rechecks the recipient before reclaimed delivery",
  async (kind) => {
    await runWebhookDeliveryJob({ db: database.db });
    const target = await recipient();
    const destination: AssignmentDestination =
      kind === "inbox"
        ? { kind, userId: target.userId }
        : {
            kind,
            projectId: target.projectId,
            taskId: target.taskId,
            threadCommentId: target.commentId,
          };
    const work = await readyResult(target, destination);

    await database.pool.query(
      "CREATE TABLE test_native_delivery_ack_fault(id text PRIMARY KEY)",
    );
    await database.pool.query(
      "INSERT INTO test_native_delivery_ack_fault(id) VALUES($1)",
      [work.deliveryId],
    );
    await database.pool
      .query(`CREATE FUNCTION test_fail_native_delivery_ack() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status='delivered' AND EXISTS(SELECT 1 FROM test_native_delivery_ack_fault WHERE id=NEW.specialist_delivery_id) THEN
        RAISE EXCEPTION 'PRIVATE_DELIVERY_ACK_FAULT' USING ERRCODE='P0001';
      END IF;
      RETURN NEW;
    END $$`);
    await database.pool.query(
      "CREATE TRIGGER test_native_ack_failure BEFORE UPDATE ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION test_fail_native_delivery_ack()",
    );
    const priorWarnings = deliveryLogObserver.records.length;

    try {
      expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
        delivered: 0,
        dead: 0,
      });
      const warnings = deliveryLogObserver.records
        .slice(priorWarnings)
        .filter(
          (record) =>
            record.message ===
            "[scheduler.webhook_delivery] delivery aborted unexpectedly",
        );

      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.fields).toMatchObject({
        deliveryId: expect.any(String),
        sqlState: "P0001",
      });
      expect(JSON.stringify(warnings)).not.toContain("Failed query:");
      expect(JSON.stringify(warnings)).not.toContain(
        "PRIVATE_DELIVERY_ACK_FAULT",
      );
      expect(
        (
          await database.pool.query(
            "SELECT status,attempt_count,lease_expires_at IS NOT NULL AS leased FROM webhook_deliveries WHERE specialist_delivery_id=$1",
            [work.deliveryId],
          )
        ).rows,
      ).toEqual([{ status: "pending", attempt_count: 0, leased: true }]);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM webhook_delivery_attempts attempt JOIN webhook_deliveries delivery ON delivery.id=attempt.delivery_id WHERE delivery.specialist_delivery_id=$1",
            [work.deliveryId],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        (
          await database.pool.query(
            "SELECT (SELECT count(*)::int FROM inbox_items WHERE assignment_delivery_id=$1) AS inbox,(SELECT count(*)::int FROM task_comments WHERE via_operation_id=$1) AS comments",
            [work.deliveryId],
          )
        ).rows,
      ).toEqual([{ inbox: 0, comments: 0 }]);
      await database.pool.query("DELETE FROM test_native_delivery_ack_fault");
      await database.pool.query(
        "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
        [target.projectId, target.userId],
      );
      await database.pool.query(
        "UPDATE webhook_deliveries SET lease_expires_at=now()-interval '1 second' WHERE specialist_delivery_id=$1",
        [work.deliveryId],
      );
      expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
        delivered: 0,
        dead: 1,
      });
      expect(
        (
          await database.pool.query(
            "SELECT (SELECT count(*)::int FROM inbox_items WHERE assignment_delivery_id=$1) AS inbox,(SELECT count(*)::int FROM task_comments WHERE via_operation_id=$1) AS comments",
            [work.deliveryId],
          )
        ).rows,
      ).toEqual([{ inbox: 0, comments: 0 }]);
      const dead = await getSpecialistAssignmentDelivery(
        database.db,
        administratorId,
        work.assignmentId,
        { runId: work.runId },
      );

      expect(dead.transport).toMatchObject({ state: "dead", lastAttemptNo: 1 });
      await database.pool.query(
        "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
        [randomUUID(), target.projectId, target.userId],
      );
      await replaySpecialistAssignmentDelivery(
        database.db,
        administratorId,
        work.assignmentId,
        work.deliveryId,
        {
          schemaVersion: 1,
          expectedStateSha256: z.string().parse(dead.transport.stateSha256),
        },
      );
      expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
        delivered: 1,
        dead: 0,
      });
      expect(
        (
          await database.pool.query(
            "SELECT (SELECT count(*)::int FROM inbox_items WHERE assignment_delivery_id=$1) AS inbox,(SELECT count(*)::int FROM task_comments WHERE via_operation_id=$1) AS comments",
            [work.deliveryId],
          )
        ).rows,
      ).toEqual([
        {
          inbox: kind === "inbox" ? 1 : 0,
          comments: kind === "task_comment" ? 1 : 0,
        },
      ]);
    } finally {
      await database.pool.query(
        "DROP TRIGGER test_native_ack_failure ON webhook_deliveries",
      );
      await database.pool.query(
        "DROP FUNCTION test_fail_native_delivery_ack()",
      );
      await database.pool.query("DROP TABLE test_native_delivery_ack_fault");
    }
  },
);

it("IT-CBA-06 retains delivery history after an attributed input update and refuses the superseded result cycle", async () => {
  await runWebhookDeliveryJob({ db: database.db });
  const target = await recipient();
  const work = await readyResult(target, {
    kind: "inbox",
    userId: target.userId,
  });

  await runWebhookDeliveryJob({ db: database.db });
  const retained = await getSpecialistAssignmentDelivery(
    database.db,
    administratorId,
    work.assignmentId,
    { runId: work.runId },
  );

  await database.pool.query("UPDATE runs SET status='Done' WHERE id=$1", [
    work.runId,
  ]);
  const current = await getSpecialistAssignment(
    database.db,
    administratorId,
    work.assignmentId,
  );
  const cancelled = await cancelSpecialistAssignment(
    database.db,
    administratorId,
    work.assignmentId,
    current.revision,
    "Revise the requested work",
  );
  const reopened = await recoverSpecialistAssignment(
    database.db,
    administratorId,
    work.assignmentId,
    cancelled.revision,
  );
  const changed = await appendSpecialistAssignmentInput(
    database.db,
    administratorId,
    work.assignmentId,
    {
      expectedRevision: reopened.revision,
      input: "Use the corrected target observation",
      references: [],
    },
  );

  expect(changed).toMatchObject({
    inputRevision: 2,
    status: "queued",
    runIds: [work.runId],
  });
  expect(
    await getSpecialistAssignmentDelivery(
      database.db,
      administratorId,
      work.assignmentId,
      { runId: work.runId },
    ),
  ).toEqual(retained);
  await expect(
    replaySpecialistAssignmentDelivery(
      database.db,
      administratorId,
      work.assignmentId,
      work.deliveryId,
      {
        schemaVersion: 1,
        expectedStateSha256: z.string().parse(retained.transport.stateSha256),
      },
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "assignment_delivery_superseded" },
  });
  expect(
    (
      await getSpecialistAssignmentInput(
        database.db,
        administratorId,
        work.assignmentId,
        2,
      )
    ).actor,
  ).toMatchObject({ kind: "user", id: administratorId });
});

it("IT-CBA-06 keeps outbound history visible while disabled target authority refuses replay and queued sends", async () => {
  await runWebhookDeliveryJob({ db: database.db });
  const target = await recipient();
  const scope = { projectId: null, ownerUserId: target.userId };
  const subscription = await createSubscription(
    scope,
    {
      name: "Guarded reply",
      url: `${endpoint}/guarded-replay`,
      event_types: ["assignment.result_available"],
      signing_secret_ref: "env:ASSIGNMENT_DELIVERY_TEST_SECRET",
    },
    database.db,
  );
  const work = await readyResult(target, {
    kind: "outbound_subscription",
    subscriptionId: subscription.id,
    correlationId: randomUUID(),
  });

  await runWebhookDeliveryJob({ db: database.db });
  const inspect = () =>
    getSpecialistAssignmentDelivery(
      database.db,
      administratorId,
      work.assignmentId,
      { runId: work.runId },
    );
  const original = await inspect();
  const replay = (expectedStateSha256: string) =>
    replaySpecialistAssignmentDelivery(
      database.db,
      administratorId,
      work.assignmentId,
      work.deliveryId,
      { schemaVersion: 1, expectedStateSha256 },
    );
  const received = requests.filter(
    (request) => request.path === "/guarded-replay",
  ).length;

  expect(received).toBe(1);
  await updateSubscription(
    scope,
    subscription.id,
    { enabled: false },
    database.db,
  );
  expect(await inspect()).toEqual(original);
  await expect(
    replay(z.string().parse(original.transport.stateSha256)),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "assignment_destination_unavailable" },
  });
  await updateSubscription(
    scope,
    subscription.id,
    { enabled: true },
    database.db,
  );
  await replay(z.string().parse(original.transport.stateSha256));
  await updateSubscription(
    scope,
    subscription.id,
    { enabled: false },
    database.db,
  );
  expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
    delivered: 0,
    dead: 1,
  });
  expect(
    requests.filter((request) => request.path === "/guarded-replay"),
  ).toHaveLength(received);
  const dead = await inspect();

  expect(dead.transport).toMatchObject({
    state: "dead",
    lastErrorKind: "config",
    lastAttemptNo: 2,
  });
  await updateSubscription(
    scope,
    subscription.id,
    { enabled: true },
    database.db,
  );
  await replay(z.string().parse(dead.transport.stateSha256));
  expect(await runWebhookDeliveryJob({ db: database.db })).toMatchObject({
    delivered: 1,
    dead: 0,
  });
  const responses = requests.filter(
    (request) => request.path === "/guarded-replay",
  );

  expect(responses).toHaveLength(received + 1);
  expect(responses[0]!.key).toBe(responses[1]!.key);
});

it("IT-CBA-02 inspects standalone admission through current session and personal bearer authority without allocating work", async () => {
  const target = await recipient();
  const work = await readyResult(target, {
    kind: "inbox",
    userId: target.userId,
  });
  const url = `http://localhost/api/specialist-assignments/${work.assignmentId}/admission`;
  const params = {
    params: Promise.resolve({ assignmentId: work.assignmentId }),
  };
  const counts = (
    await database.pool.query(
      "SELECT (SELECT count(*)::int FROM runs) AS runs,(SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM task_qualifications) AS qualifications,(SELECT count(*)::int FROM task_launch_intents) AS intents,(SELECT count(*)::int FROM domain_events) AS events",
    )
  ).rows;

  deliverySession.userId = null;
  expect((await admissionGet(new NextRequest(url), params)).status).toBe(401);
  deliverySession.userId = target.userId;
  try {
    const response = await admissionGet(new NextRequest(url), params);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      assignmentId: work.assignmentId,
      kind: "project_agent",
      carrier: null,
      limitations: [],
    });
    expect(
      (await admissionGet(new NextRequest(url + "?actorId=forged"), params))
        .status,
    ).toBe(400);
    expect(
      (
        await admissionGet(new NextRequest(url), {
          params: Promise.resolve({ assignmentId: randomUUID() }),
        })
      ).status,
    ).toBe(404);
    const personal = await issueUserAccessToken(
      {
        ownerUserId: target.userId,
        name: "admission-read",
        scopes: ["assignments:read"],
      },
      database.db,
    );
    const project = await issueToken(
      {
        projectId: target.projectId,
        name: "admission-project-refusal",
        scopes: ["assignments:read"],
      },
      database.db,
    );
    const extUrl = url.replace("/api/", "/api/v1/ext/");
    const inspect = (secret: string, query = "") =>
      externalAdmissionGet(
        new NextRequest(extUrl + query, {
          headers: { authorization: `Bearer ${secret}` },
        }),
        params,
      );

    expect((await inspect(project.secret)).status).toBe(403);
    expect((await inspect(personal.secret)).status).toBe(200);
    expect((await inspect(personal.secret, "?revision=1")).status).toBe(422);
    await database.pool.query(
      "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
      [target.projectId, target.userId],
    );
    expect((await admissionGet(new NextRequest(url), params)).status).toBe(403);
    expect((await inspect(personal.secret)).status).toBe(403);
    expect(
      (
        await database.pool.query(
          "SELECT status_code,scope_used FROM token_audit_log WHERE token_id=$1 ORDER BY created_at,id",
          [personal.tokenId],
        )
      ).rows,
    ).toEqual([
      { status_code: 200, scope_used: "assignments:read" },
      { status_code: 422, scope_used: "assignments:read" },
      { status_code: 403, scope_used: "assignments:read" },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT (SELECT count(*)::int FROM runs) AS runs,(SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM task_qualifications) AS qualifications,(SELECT count(*)::int FROM task_launch_intents) AS intents,(SELECT count(*)::int FROM domain_events) AS events",
        )
      ).rows,
    ).toEqual(counts);
  } finally {
    deliverySession.userId = null;
  }
});

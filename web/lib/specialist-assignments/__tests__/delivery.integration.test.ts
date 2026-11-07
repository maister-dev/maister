import type { KnowledgeAccessCapture } from "@/lib/company/types";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type {
  PreparedSpecialistAssignment,
  AssignmentDestination,
} from "../types";
import type { RunResultContract } from "@/lib/run-results/types";

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import { join, resolve } from "node:path";

import { sql } from "drizzle-orm";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  createSpecialistAssignment,
  activateInitialSpecialistAssignmentRunInTransaction,
  getSpecialistAssignmentInput,
} from "../store";
import { specialistAssignmentDeliveryConsumer } from "../delivery-capture";

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
import { runWebhookDeliveryJob } from "@/lib/scheduler/handlers/webhook-delivery";
import { markInboxItemRead } from "@/lib/social/inbox";
import { replayDelivery } from "@/lib/webhooks/replay";
import { createSubscription } from "@/lib/webhooks/subscriptions";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import { seedProjectRow } from "@/test-support/execution-host-seed";

let database: StartedPostgresTestDb;
let root: string;
let server: Server;
let endpoint: string;
let contract: RunResultContract;
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
  const installed = await installPackageRevision({
    source: resolve("test-fixtures/rah-native"),
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

async function readyResult(
  target: Awaited<ReturnType<typeof recipient>>,
  destination: AssignmentDestination,
): Promise<{ assignmentId: string; runId: string; deliveryId: string }> {
  const work = await createSpecialistAssignment(database.db, target.userId, {
    ...preparedBase,
    sourceRestrictions: [
      { kind: "project_context", projectId: target.projectId },
    ],
    owner: { kind: "project", projectId: target.projectId },
    origin: { kind: "manual", interactionId: randomUUID() },
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
      value: output,
      valueBytes: Buffer.byteLength(JSON.stringify(output)),
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
  expect(
    await dispatchDomainEvents({
      db: database.db,
      consumers: [specialistAssignmentDeliveryConsumer],
    }),
  ).toMatchObject({ failures: 0 });
  const rows = (
    await database.pool.query<{ id: string }>(
      "SELECT id FROM specialist_delivery_receipts WHERE run_id=$1",
      [runId],
    )
  ).rows;

  expect(rows).toHaveLength(1);

  return { assignmentId: work.id, runId, deliveryId: rows[0]!.id };
}

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
  const work: Awaited<ReturnType<typeof readyResult>>[] = [];

  vi.stubEnv("MAISTER_WEBHOOK_DELIVERY_BATCH", "100");
  for (let index = 0; index < 260; index++)
    work.push(
      await readyResult(target, { kind: "inbox", userId: target.userId }),
    );
  for (let batch = 0; batch < 3; batch++)
    await runWebhookDeliveryJob({ db: database.db });
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

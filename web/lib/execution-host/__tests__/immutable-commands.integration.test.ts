import type { Db } from "../db";
import type { PromptOwner } from "../prompt-owner-contract";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { rearmPromptAdmission } from "../commands";
import { normalizeCommandReceiptV2 } from "../command-receipt";
import { depositPromptReceipt } from "../prompt-evidence";
import { ingestRuntimeEvent } from "../events/ingest";
import { projectCanonicalPromptCommands } from "../events/prompt-projector";
import { releaseAssignmentForRun } from "../assignments";
import { mintAssignment } from "../assignments";
import { issueOwnedPrompt } from "../ledger";
import { classifyCommandRequest, readPromptRequest } from "../command-request";

import {
  executionHosts,
  executionCommands,
  runs,
  runSessions,
  runSessionIncarnations,
} from "@/lib/db/schema";
import {
  seedLocalHost,
  seedProject,
  seedRun,
} from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  startMainPostgresTestDb,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;
let runId: string;
let hostId: string;
let assignmentId: string;
let assignment: ExecutionAssignment;
let host: ExecutionHost;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "immutable_commands",
  });
  db = database.db;
  const projectId = await seedProject(database.db);

  runId = await seedRun(database.db, { projectId, runKind: "agent" });
  hostId = (await seedLocalHost(database.db)).id;
  assignment = await db.transaction((tx) =>
    mintAssignment(tx, { runId, hostId, reason: "launch" }),
  );
  assignmentId = assignment.id;
  [host] = await db
    .select()
    .from(executionHosts)
    .where(eq(executionHosts.id, hostId));
  await db
    .update(runs)
    .set({ executionAssignmentId: assignmentId })
    .where(eq(runs.id, runId));
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

async function admissionFixture(): Promise<{
  targetSessionId: string;
  owner: PromptOwner;
  logicalOperationKey: string;
}> {
  const runSessionId = randomUUID();
  const incarnationId = randomUUID();
  const targetSessionId = randomUUID();
  const turnId = randomUUID();

  await db.insert(runSessions).values({
    id: runSessionId,
    runId,
    sessionName: runSessionId,
    executionAssignmentId: assignmentId,
    hostSessionId: targetSessionId,
  });
  await db.insert(runSessionIncarnations).values({
    id: incarnationId,
    runSessionId,
    runId,
    executionAssignmentId: assignmentId,
    assignmentEpoch: 1,
    executionHostId: hostId,
    hostSessionId: targetSessionId,
    state: "active",
    origin: "native",
  });

  return {
    targetSessionId,
    logicalOperationKey: `agent_turn:initial:${turnId}:0`,
    owner: {
      kind: "agent_turn",
      ref: {
        version: 1,
        variant: "initial",
        runId,
        runSessionId,
        incarnationId,
        assignmentId,
        assignmentEpoch: 1,
        turnId,
        promptOrdinal: 0,
      },
    },
  };
}

it("concurrent same-key admission keeps one command and the original request bytes", async () => {
  const fixture = await admissionFixture();
  const payload = {
    stepId: "agent",
    prompt: "private prompt — €😀",
    readOnlyTurn: false,
    contentBlocks: [{ type: "text" as const, text: "original frozen input" }],
  };
  const firstTime = new Date("2026-09-06T01:00:00.000Z");
  const results = await Promise.all(
    [firstTime, new Date(firstTime.getTime() + 60_000)].map((now) =>
      issueOwnedPrompt(db, {
        assignment,
        host,
        targetSessionId: fixture.targetSessionId,
        payload,
        maxAttempts: 3,
        now,
        admitOwner: async (tx) => {
          await tx.select().from(runs).where(eq(runs.id, runId)).for("update");

          return fixture;
        },
      }),
    ),
  );

  expect(new Set(results.map((result) => result.row.id)).size).toBe(1);
  expect(results[0].envelope).toEqual(results[1].envelope);
  expect(
    new Set(results.map((result) => result.row.requestCanonicalJson)).size,
  ).toBe(1);
  expect(results[0].row.payload).not.toHaveProperty("prompt");
  const stored = readPromptRequest(results[0].row, host.hostKey);

  expect(stored.payload).toEqual(payload);
  expect(stored.command.issuedAt).toBe(results[0].row.createdAt.toISOString());
  expect(classifyCommandRequest(results[0].row)).toBe("v2_snapshot");
  await expect(
    issueOwnedPrompt(db, {
      assignment,
      host,
      targetSessionId: fixture.targetSessionId,
      payload: { ...payload, prompt: "different operation under the same key" },
      maxAttempts: 3,
      admitOwner: async () => fixture,
    }),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "command_invariant_conflict" },
  });
});

it.each([
  "requestSha256",
  "hostKey",
  "assignmentId",
  "hostSessionId",
  "legacy",
] as const)(
  "v2 admission quarantines receipt with mismatched %s before changing command state",
  async (field) => {
    const fixture = await admissionFixture();
    const admitted = await issueOwnedPrompt(db, {
      assignment,
      host,
      targetSessionId: fixture.targetSessionId,
      payload: { stepId: "agent", prompt: "private immutable input" },
      maxAttempts: 3,
      admitOwner: async () => fixture,
    });
    const valid = normalizeCommandReceiptV2({
      receiptVersion: 2,
      commandId: admitted.row.id,
      kind: "session.prompt",
      hostKey: host.hostKey,
      runId,
      assignmentId,
      assignmentEpoch: assignment.epoch,
      hostSessionId: fixture.targetSessionId,
      requestSchema: admitted.row.requestSchema,
      requestSha256: admitted.row.requestSha256,
      phase: "accepted",
      httpStatus: 202,
      receivedAt: new Date().toISOString(),
      terminal: null,
    });
    const { evidenceV2, ...legacy } = valid;
    const corrupted =
      field === "legacy"
        ? legacy
        : normalizeCommandReceiptV2({
            ...evidenceV2,
            [field]:
              field === "requestSha256"
                ? "a".repeat(64)
                : field === "hostKey"
                  ? "eh_different_host"
                  : randomUUID(),
          });
    const result = await depositPromptReceipt(db, admitted.row.id, corrupted);

    expect(result).toMatchObject({
      disposition: "quarantined",
      command: {
        state: "queued",
        receiptEvidence: null,
        terminalEvidenceSha256: null,
        applicationState: "poisoned",
        applicationError: { causeCode: "receipt_binding" },
      },
    });
  },
);

it("refused request rolls back owner admission writes and persists no command", async () => {
  const fixture = await admissionFixture();
  const payload = {
    stepId: "agent",
    prompt: "private input",
    env: { API_KEY: "unsupported-secret" },
  };

  await expect(
    issueOwnedPrompt(db, {
      assignment,
      host,
      targetSessionId: fixture.targetSessionId,
      payload,
      maxAttempts: 3,
      admitOwner: async (tx) => {
        await tx
          .update(runSessions)
          .set({ acpSessionId: "must-roll-back" })
          .where(eq(runSessions.id, fixture.owner.ref.runSessionId));

        return fixture;
      },
    }),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { invariant: "request_shape" },
  });
  const session = await db
    .select({ acpSessionId: runSessions.acpSessionId })
    .from(runSessions)
    .where(eq(runSessions.id, fixture.owner.ref.runSessionId));

  expect(session[0].acpSessionId).toBeNull();
  expect(
    (
      await database.pool.query(
        "SELECT id FROM execution_commands WHERE logical_operation_key = $1",
        [fixture.logicalOperationKey],
      )
    ).rows,
  ).toHaveLength(0);
});

it("rearms one additional budget under request and observed-attempt CAS without resetting history", async () => {
  const fixture = await admissionFixture();
  const admitted = await issueOwnedPrompt(db, {
    assignment,
    host,
    targetSessionId: fixture.targetSessionId,
    payload: {
      stepId: "agent",
      prompt: "same operation after authorized repair",
    },
    maxAttempts: 3,
    admitOwner: async () => fixture,
  });

  await db
    .update(executionCommands)
    .set({ attempts: 3, transportState: "reconciliation_required" })
    .where(eq(executionCommands.id, admitted.row.id));
  const input = {
    commandId: admitted.row.id,
    requestSha256: admitted.row.requestSha256!,
    expectedAttempts: 3,
    expectedMaxAttempts: 3,
  };

  expect(
    (
      await rearmPromptAdmission(db, {
        ...input,
        requestSha256: "0".repeat(64),
      })
    ).changed,
  ).toBe(false);
  const results = await Promise.all([
    rearmPromptAdmission(db, input),
    rearmPromptAdmission(db, input),
  ]);

  expect(results.filter((result) => result.changed)).toHaveLength(1);
  expect(results.find((result) => result.changed)?.row).toMatchObject({
    id: admitted.row.id,
    attempts: 3,
    maxAttempts: 6,
    state: "queued",
    transportState: "unknown",
    requestCanonicalJson: admitted.row.requestCanonicalJson,
    requestSha256: admitted.row.requestSha256,
  });
  expect((await rearmPromptAdmission(db, input)).changed).toBe(false);
});

it("database refuses request, owner and routing mutation after v2 admission", async () => {
  const fixture = await admissionFixture();
  const result = await issueOwnedPrompt(db, {
    assignment,
    host,
    targetSessionId: fixture.targetSessionId,
    payload: { stepId: "agent", prompt: "immutable input" },
    maxAttempts: 3,
    admitOwner: async () => fixture,
  });

  for (const statement of [
    "UPDATE execution_commands SET target_session_id = 'different' WHERE id = $1",
    'UPDATE execution_commands SET owner_ref = owner_ref || \'{"turnId":"different"}\'::jsonb WHERE id = $1',
    "UPDATE execution_commands SET request_canonical_json = '{}' WHERE id = $1",
    "UPDATE execution_commands SET request_schema = NULL, request_sha256 = NULL, request_canonical_json = NULL, owner_kind = NULL, owner_ref = NULL, logical_operation_key = NULL WHERE id = $1",
  ]) {
    await expect(
      database.pool.query(statement, [result.row.id]),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "execution_commands_immutable_request",
    });
  }
  await database.pool.query(
    "UPDATE execution_commands SET transport_state = 'unknown' WHERE id = $1",
    [result.row.id],
  );
  await expect(
    database.pool.query(
      "UPDATE execution_commands SET application_state = 'applied' WHERE id = $1",
      [result.row.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "execution_commands_application_shape_check",
  });
});

it("upgrades legacy commands without fabricating requests or losing an applied marker", async () => {
  const legacy = await startMainPostgresTestDbUpTo(
    { databaseName: "immutable_commands_upgrade" },
    "0139_incremental_cost_sessions",
  );

  try {
    const legacyDb: Db = legacy.db;
    const projectId = await seedProject(legacy.db);
    const legacyRunId = await seedRun(legacy.db, { projectId });
    const legacyHostId = (await seedLocalHost(legacy.db)).id;
    const legacyAssignment = await legacyDb.transaction((tx) =>
      mintAssignment(tx, {
        runId: legacyRunId,
        hostId: legacyHostId,
        reason: "launch",
      }),
    );
    const commandId = randomUUID();

    await legacy.pool.query(
      `INSERT INTO execution_commands
      (id, run_id, execution_assignment_id, execution_host_id, assignment_epoch,
       kind, max_attempts, state, completed_at, completion_applied_at, owner_kind,
       owner_ref, logical_operation_key, request_schema, request_sha256, payload)
      VALUES ($1, $2, $3, $4, 1, 'session.prompt', 3, 'succeeded', now(), now(),
        'agent_turn', '{"legacyTurn":"original"}', 'legacy:original',
        'maister.command.request.v1', repeat('a', 64), '{"stepId":"original"}')`,
      [commandId, legacyRunId, legacyAssignment.id, legacyHostId],
    );
    await applyMainMigration(legacy.db, "0140_immutable_command_requests");
    const result = await legacy.pool.query(
      `SELECT request_schema, request_sha256,
      request_canonical_json, application_state, completion_applied_at IS NOT NULL AS applied,
      owner_ref, payload FROM execution_commands WHERE id = $1`,
      [commandId],
    );

    expect(result.rows).toEqual([
      {
        request_schema: "maister.command.request.v1",
        request_sha256: "a".repeat(64),
        request_canonical_json: null,
        application_state: "applied",
        applied: true,
        owner_ref: { legacyTurn: "original" },
        payload: { stepId: "original" },
      },
    ]);
    expect(
      classifyCommandRequest({
        requestSchema: result.rows[0].request_schema,
        requestSha256: result.rows[0].request_sha256,
        requestCanonicalJson: result.rows[0].request_canonical_json,
      }),
    ).toBe("legacy_digest_only");
  } finally {
    await legacy.stop();
  }
}, 120_000);

it("refuses a v2 prompt with a hash and owner but no immutable request", async () => {
  const ownerRef = {
    version: 1,
    variant: "initial",
    runId,
    runSessionId: randomUUID(),
    incarnationId: randomUUID(),
    assignmentId,
    assignmentEpoch: 1,
    turnId: randomUUID(),
    promptOrdinal: 0,
  };

  await expect(
    database.pool.query(
      `INSERT INTO execution_commands
      (id, run_id, execution_assignment_id, execution_host_id, assignment_epoch,
       kind, target_session_id, max_attempts, owner_kind, owner_ref,
       logical_operation_key, request_schema, request_sha256)
     VALUES ($1, $2, $3, $4, 1, 'session.prompt', $5, 3, 'agent_turn', $6,
       $7, 'maister.command.request.v2', $8)`,
      [
        randomUUID(),
        runId,
        assignmentId,
        hostId,
        randomUUID(),
        ownerRef,
        `agent:initial:${randomUUID()}`,
        "a".repeat(64),
      ],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

it("v2 receipt-first late evidence settles only its exact historical request and target", async () => {
  const isolatedProjectId = await seedProject(database.db);
  const isolatedRunId = await seedRun(database.db, {
    projectId: isolatedProjectId,
    runKind: "agent",
    status: "Running",
  });
  const original = await db.transaction((tx) =>
    mintAssignment(tx, { runId: isolatedRunId, hostId, reason: "launch" }),
  );

  await db
    .update(runs)
    .set({ executionAssignmentId: original.id })
    .where(eq(runs.id, isolatedRunId));
  const runSessionId = randomUUID();
  const incarnationId = randomUUID();
  const hostSessionId = randomUUID();
  const turnId = randomUUID();

  await db.insert(runSessions).values({
    id: runSessionId,
    runId: isolatedRunId,
    sessionName: "default",
    executionAssignmentId: original.id,
    hostSessionId,
  });
  await db.insert(runSessionIncarnations).values({
    id: incarnationId,
    runSessionId,
    runId: isolatedRunId,
    executionAssignmentId: original.id,
    assignmentEpoch: original.epoch,
    executionHostId: hostId,
    hostSessionId,
    state: "active",
    origin: "native",
  });
  const admitted = await issueOwnedPrompt(db, {
    assignment: original,
    host,
    targetSessionId: hostSessionId,
    payload: { stepId: "agent", prompt: "historical immutable request" },
    maxAttempts: 3,
    admitOwner: async () => ({
      logicalOperationKey: `agent_turn:initial:${turnId}:0`,
      owner: {
        kind: "agent_turn",
        ref: {
          version: 1,
          variant: "initial",
          runId: isolatedRunId,
          runSessionId,
          incarnationId,
          assignmentId: original.id,
          assignmentEpoch: original.epoch,
          turnId,
          promptOrdinal: 0,
        },
      },
    }),
  });

  await releaseAssignmentForRun(db, isolatedRunId, "historical-evidence-test");
  const successor = await db.transaction((tx) =>
    mintAssignment(tx, { runId: isolatedRunId, hostId, reason: "recover" }),
  );

  await db
    .update(runs)
    .set({ executionAssignmentId: successor.id })
    .where(eq(runs.id, isolatedRunId));
  const streamId = randomUUID();
  const eventId = randomUUID();
  const terminal = {
    outcomeVersion: 2,
    eventId,
    streamId,
    sequence: "3",
    status: "failed",
    result: null,
    error: {
      code: "PRECONDITION",
      message: "original refusal",
      details: { reason: "turn_lost", original: { generation: 1 } },
    },
  };
  const receipt = normalizeCommandReceiptV2({
    receiptVersion: 2,
    commandId: admitted.row.id,
    kind: "session.prompt",
    hostKey: host.hostKey,
    runId: isolatedRunId,
    assignmentId: original.id,
    assignmentEpoch: original.epoch,
    hostSessionId,
    requestSchema: admitted.row.requestSchema,
    requestSha256: admitted.row.requestSha256,
    phase: "rejected",
    httpStatus: 409,
    receivedAt: new Date().toISOString(),
    terminal,
  });
  const pending = await depositPromptReceipt(db, admitted.row.id, receipt);

  expect(pending).toMatchObject({
    disposition: "waiting",
    command: { state: "queued", terminalEvidenceSha256: null },
  });
  const base = {
    envelopeVersion: 1,
    hostKey: host.hostKey,
    hostBootId: randomUUID(),
    streamId,
    runId: isolatedRunId,
    assignmentId: original.id,
    assignmentEpoch: original.epoch,
    hostSessionId,
    eventType: "session.command",
    occurredAt: new Date().toISOString(),
    payloadSchema: "maister.session.command.v2",
  };
  const payload = {
    commandId: admitted.row.id,
    kind: "session.prompt",
    phase: "rejected",
    sourceCommandId: admitted.row.id,
    requestSchema: admitted.row.requestSchema,
    requestSha256: admitted.row.requestSha256,
    terminal,
  };

  expect(
    await ingestRuntimeEvent({
      db,
      executionHostId: hostId,
      envelope: {
        ...base,
        eventId: randomUUID(),
        sequence: "0",
        payload: { ...payload, phase: "accepted", terminal: null },
      },
    }),
  ).toMatchObject({ disposition: "accepted" });
  for (const [sequence, change] of [
    ["1", { requestSha256: "f".repeat(64) }],
    ["2", {}],
  ] as const) {
    const mismatchId = randomUUID();

    expect(
      await ingestRuntimeEvent({
        db,
        executionHostId: hostId,
        envelope: {
          ...base,
          eventId: mismatchId,
          sequence,
          ...(sequence === "2" ? { hostSessionId: randomUUID() } : {}),
          payload: {
            ...payload,
            ...change,
            terminal: { ...terminal, eventId: mismatchId, sequence },
          },
        },
      }),
    ).toMatchObject({ disposition: "stale_epoch" });
  }
  expect(
    await ingestRuntimeEvent({
      db,
      executionHostId: hostId,
      envelope: { ...base, eventId, sequence: "3", payload },
    }),
  ).toMatchObject({ disposition: "accepted" });
  await projectCanonicalPromptCommands({ db, runId: isolatedRunId });
  const [command] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, admitted.row.id));
  const [current] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, isolatedRunId));

  expect(command).toMatchObject({
    state: "failed",
    lastError: terminal.error,
    applicationState: "pending",
    completionAppliedAt: null,
  });
  expect(command.terminalEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(current.executionAssignmentId).toBe(successor.id);
});

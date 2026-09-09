import type { Db } from "../db";
import type {
  ExecutionHostTransport,
  RuntimeObjectMetadata,
} from "../contracts";
import type { ExecutionHost } from "@/lib/db/schema";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mintAssignment, releaseAssignmentForRun } from "../assignments";
import { createExecutionHosts } from "../client";
import { claimDelivering, getCommand, insertCommand } from "../commands";
import { defaultTransport } from "../default-transport";
import { ingestRuntimeEvent } from "../events/ingest";
import {
  projectCanonicalRuntimeObjects,
  projectRuntimeObject,
} from "../events/runtime-object-projector";
import { buildEnvelope } from "../ledger";
import { UNKNOWN_OUTCOME_DETAIL } from "../contracts";
import { recoverExecutionCommands } from "../recovery";
import {
  ensureLocalExecutionHost,
  resetRegistrarStateForTests,
} from "../registrar";
import { primeResolverForTests, resetResolverForTests } from "../resolver";
import { reduceRuntimeObjectEvidence } from "../runtime-object-evidence";
import { readRuntimeObjectContent } from "../runtime-objects";

import {
  executionAssignments,
  executionCommands,
  executionEvents,
  executionRuntimeObjects,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

let database: StartedPostgresTestDb;
let db: Db;
let supervisor: RealSupervisor;
let host: ExecutionHost;
let transport: ExecutionHostTransport;
let restoreUrl: (() => void) | undefined;
let sequence: string | undefined;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "runtime_object_lifecycle",
  });
  db = database.db as unknown as Db;
  supervisor = await startRealSupervisor({
    runtimeRoot: await mkdtemp(
      "/private/tmp/maister-ab-implementation/s31-host-",
    ),
  });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  transport = defaultTransport();
  const registration = await ensureLocalExecutionHost({ db, transport });

  expect(registration.status).toBe("registered");
  if (registration.status !== "registered")
    throw new Error("fixture host registration failed");
  host = registration.host;
  // Deliver the real outbox through production ingestion at explicit barriers.
  // Memoizing registration prevents the autonomous consumer from racing them.
  primeResolverForTests(host);
}, 180_000);

afterAll(async () => {
  restoreUrl?.();
  resetResolverForTests();
  resetRegistrarStateForTests();
  await supervisor?.kill();
  await database?.stop();
});

async function fixture(overrides: Partial<ExecutionHostTransport> = {}) {
  const project = await seedProjectRow(database.db);
  const runId = await seedRun(database.db, { projectId: project.id });
  const assignment = await db.transaction((tx) =>
    mintAssignment(tx, {
      runId,
      hostId: host.id,
      reason: "launch",
    }),
  );
  const client = await createExecutionHosts({
    db,
    transport: { ...transport, ...overrides },
  }).forAssignment(assignment);
  const bytes = new TextEncoder().encode("sealed fixture bytes");
  const objectId = randomUUID();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const reservation = {
    objectId,
    kind: "generated_artifact" as const,
    logicalName: "fixture.txt",
    mimeType: "text/plain",
    sizeBytes: bytes.byteLength,
    sha256,
    generation: 1,
    retentionClass: "run" as const,
  };

  await client.reserveRuntimeObject(reservation);

  return {
    client,
    runId,
    assignment,
    reservation,
    input: { objectId, generation: 1, sha256, bytes },
  };
}

async function catalogue(objectId: string) {
  const [row] = await db
    .select()
    .from(executionRuntimeObjects)
    .where(eq(executionRuntimeObjects.id, objectId));

  return row;
}

async function deliverAvailable(objectId: string): Promise<void> {
  const signal = AbortSignal.timeout(10_000);

  for await (const envelope of transport.streamRuntimeEvents({
    afterSequence: sequence,
    signal,
  })) {
    await ingestRuntimeEvent({ db, executionHostId: host.id, envelope });
    sequence = envelope.sequence;
    const summary = await projectCanonicalRuntimeObjects({
      db,
      runId: envelope.runId,
    });

    expect(summary.poisoned).toBe(false);
    if (
      envelope.eventType === "runtime_object.available" &&
      envelope.payload.objectId === objectId
    )
      return;
  }
  throw new Error("fixture outbox closed before object availability");
}

describe("runtime object intent and seal reconciliation through a real host", () => {
  it.each([undefined, { start: 2, end: 4 }])(
    "verifies actual response bytes against the catalogue for range %j",
    async (range) => {
      const { client, runId, input } = await fixture();

      await client.uploadRuntimeObject(input);
      await deliverAvailable(input.objectId);
      const { content } = await readRuntimeObjectContent({
        db,
        runId,
        objectId: input.objectId,
        range,
      });
      const expected = range
        ? input.bytes.subarray(range.start, range.end + 1)
        : input.bytes;

      expect(content.bytes).toEqual(expected);
      expect(content).toMatchObject({
        contentDigest: `sha-256=:${createHash("sha256").update(expected).digest("base64")}:`,
        reprDigest: `sha-256=:${createHash("sha256").update(input.bytes).digest("base64")}:`,
        etag: `"1-${input.sha256}"`,
      });
    },
  );

  it.each(["generation", "representation"] as const)(
    "refuses a conflicting peer %s and cancels the unconsumed body",
    async (fault) => {
      const { client, runId, input } = await fixture();
      let cancelled = false;

      await client.uploadRuntimeObject(input);
      await deliverAvailable(input.objectId);
      await expect(
        readRuntimeObjectContent({
          db,
          runId,
          objectId: input.objectId,
          transportForHost: async () => ({
            ...transport,
            async openRuntimeObjectContent(objectId, opts) {
              const opened = await transport.openRuntimeObjectContent(
                objectId,
                opts,
              );

              return {
                ...opened,
                ...(fault === "generation"
                  ? { etag: `"2-${input.sha256}"` }
                  : {
                      reprDigest: `sha-256=:${Buffer.alloc(32).toString("base64")}:`,
                    }),
                body: new ReadableStream<Uint8Array>(
                  {
                    async cancel() {
                      cancelled = true;
                      await opened.body.cancel();
                    },
                  },
                  { highWaterMark: 0 },
                ),
              };
            },
          }),
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "runtime_object_integrity_mismatch", runId },
      });
      expect(cancelled).toBe(true);
      expect(await catalogue(input.objectId)).toMatchObject({
        state: "available",
        sha256: input.sha256,
      });
    },
  );

  it("refuses changed peer bytes before exposing a successful catalogue read", async () => {
    const { client, runId, input } = await fixture();

    await client.uploadRuntimeObject(input);
    await deliverAvailable(input.objectId);
    await expect(
      readRuntimeObjectContent({
        db,
        runId,
        objectId: input.objectId,
        transportForHost: async () => ({
          ...transport,
          async openRuntimeObjectContent(objectId, opts) {
            const content = await transport.openRuntimeObjectContent(
              objectId,
              opts,
            );
            const changed = new Uint8Array(
              await new Response(content.body).arrayBuffer(),
            );

            changed[0] ^= 1;

            return {
              ...content,
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(changed);
                  controller.close();
                },
              }),
            };
          },
        }),
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "runtime_object_integrity_mismatch", runId },
    });
  });

  it("persists ACK evidence without availability until the canonical event arrives", async () => {
    const { client, input } = await fixture();
    const metadata = await client.uploadRuntimeObject(input);
    const beforeEvent = await catalogue(input.objectId);

    expect(metadata.state).toBe("available");
    expect(beforeEvent).toMatchObject({
      state: "pending",
      sourceEventId: null,
    });
    await deliverAvailable(input.objectId);
    expect(await catalogue(input.objectId)).toMatchObject({
      state: "available",
      sizeBytes: BigInt(input.bytes.byteLength),
      sha256: input.sha256,
      sealedAt: new Date(metadata.sealedAt!),
    });
  });

  it("reconciles an event before ACK without replacing established seal metadata", async () => {
    let beforeAck: Awaited<ReturnType<typeof catalogue>> | undefined;
    const { client, input } = await fixture({
      async uploadRuntimeObject(request) {
        const metadata = await transport.uploadRuntimeObject(request);

        await deliverAvailable(request.objectId);
        beforeAck = await catalogue(request.objectId);

        return metadata;
      },
    });

    await client.uploadRuntimeObject(input);
    expect(beforeAck?.state).toBe("available");
    expect(await catalogue(input.objectId)).toEqual(beforeAck);
  });

  it("rejects a changed pending declaration before issuing another host command", async () => {
    const { client, reservation } = await fixture();

    await expect(
      client.reserveRuntimeObject({ ...reservation, sha256: "a".repeat(64) }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "command_invariant_conflict" },
    });
    const commands = await db
      .select({ id: executionCommands.id })
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.targetSessionId, reservation.objectId),
          eq(executionCommands.kind, "runtime_object.reserve"),
        ),
      );

    expect(commands).toHaveLength(1);
  });

  it("replays the same upload after a lost ACK and waits for canonical availability", async () => {
    const commandIds: string[] = [];
    const seals: RuntimeObjectMetadata[] = [];
    const { client, input } = await fixture({
      async uploadRuntimeObject(request) {
        commandIds.push(request.envelope.command.id);
        const metadata = await transport.uploadRuntimeObject(request);

        seals.push(metadata);
        if (commandIds.length === 1)
          throw new MaisterError(
            "EXECUTOR_UNAVAILABLE",
            "fixture upload response lost",
            {
              details: { transport: UNKNOWN_OUTCOME_DETAIL },
            },
          );

        return metadata;
      },
    });

    await client.uploadRuntimeObject(input);
    expect(commandIds).toHaveLength(2);
    expect(new Set(commandIds).size).toBe(1);
    expect(seals[1]).toEqual(seals[0]);
    expect((await catalogue(input.objectId)).state).toBe("pending");
    await deliverAvailable(input.objectId);
    expect(await catalogue(input.objectId)).toMatchObject({
      state: "available",
      sha256: input.sha256,
    });
  });

  it("refuses another run's object ID with a typed conflict", async () => {
    const original = await fixture();
    const other = await fixture();
    const before = await catalogue(original.input.objectId);

    await expect(
      other.client.reserveRuntimeObject(original.reservation),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await catalogue(original.input.objectId)).toEqual(before);
  });

  it("refuses an invalid declaration before converting or storing its size", async () => {
    const { client, reservation } = await fixture();
    const objectId = randomUUID();

    await expect(
      client.reserveRuntimeObject({ ...reservation, objectId, sizeBytes: 1.5 }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(await catalogue(objectId)).toBeUndefined();
  });

  it("folds a real upload receipt into seal evidence without inventing availability", async () => {
    const { runId, assignment, input } = await fixture();
    const payload = {
      generation: input.generation,
      sizeBytes: input.bytes.byteLength,
      sha256: input.sha256,
    };
    const command = await insertCommand(db, {
      runId,
      assignmentId: assignment.id,
      hostId: host.id,
      assignmentEpoch: assignment.epoch,
      kind: "runtime_object.upload",
      targetSessionId: input.objectId,
      payload,
      maxAttempts: 3,
      driverless: false,
    });

    await claimDelivering(db, command.id, 0);
    const metadata = await transport.uploadRuntimeObject({
      objectId: input.objectId,
      bytes: input.bytes,
      envelope: buildEnvelope({
        commandId: command.id,
        kind: "runtime_object.upload",
        runId,
        hostKey: host.hostKey,
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
        payload,
      }),
    });
    const summary = await recoverExecutionCommands({
      db,
      transport,
      graceMs: 0,
    });

    expect(summary.errors).toEqual([]);
    expect(await getCommand(db, command.id)).toMatchObject({
      state: "succeeded",
    });
    expect(await catalogue(input.objectId)).toMatchObject({
      state: "pending",
      sourceEventId: null,
      sizeBytes: BigInt(input.bytes.byteLength),
      sha256: input.sha256,
      sealedAt: new Date(metadata.sealedAt!),
    });
    await deliverAvailable(input.objectId);
    expect((await catalogue(input.objectId)).state).toBe("available");
  });

  it.each(["released", "superseded"] as const)(
    "accepts exact old intent after assignment is %s without changing its successor",
    async (state) => {
      const { client, input, runId, assignment } = await fixture();

      await client.uploadRuntimeObject(input);
      if (state === "released")
        await releaseAssignmentForRun(db, runId, "fixture-complete");
      const successor = await db.transaction((tx) =>
        mintAssignment(tx, { runId, hostId: host.id, reason: "resume" }),
      );

      await deliverAvailable(input.objectId);
      const object = await catalogue(input.objectId);
      const [unchanged] = await db
        .select()
        .from(executionAssignments)
        .where(eq(executionAssignments.id, successor.id));

      expect(object).toMatchObject({
        state: "available",
        executionAssignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
      });
      expect(object.sourceEventId).not.toBeNull();
      expect(unchanged).toEqual(successor);
    },
  );

  it("cannot resurrect a deleted object when an older upload ACK arrives", async () => {
    let delayed: RuntimeObjectMetadata | undefined;
    const uploadAck = Promise.withResolvers<void>();
    const uploaded = Promise.withResolvers<void>();
    const { client, input } = await fixture({
      async uploadRuntimeObject(request) {
        delayed = await transport.uploadRuntimeObject(request);
        uploaded.resolve();
        await uploadAck.promise;

        return delayed;
      },
    });
    const upload = client.uploadRuntimeObject(input);

    try {
      await uploaded.promise;
      await deliverAvailable(input.objectId);
      await client.deleteRuntimeObject({
        objectId: input.objectId,
        generation: input.generation,
      });
      expect((await catalogue(input.objectId)).state).toBe("deleted");
    } finally {
      uploadAck.resolve();
      await upload;
    }
    expect((await catalogue(input.objectId)).state).toBe("deleted");
    const [available] = await db
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.runId, client.assignment.runId),
          eq(executionEvents.eventType, "runtime_object.available"),
        ),
      );
    const tombstone = await catalogue(input.objectId);

    await db.transaction((tx) => projectRuntimeObject(tx, available));
    expect(await catalogue(input.objectId)).toEqual(tombstone);
  });

  it.each(["sha256", "generation"] as const)(
    "rejects a conflicting %s in an ACK without overwriting the pending intent",
    async (field) => {
      const { client, input } = await fixture({
        async uploadRuntimeObject(request) {
          const metadata = await transport.uploadRuntimeObject(request);

          return field === "sha256"
            ? { ...metadata, sha256: "b".repeat(64) }
            : { ...metadata, generation: metadata.generation + 1 };
        },
      });
      const before = await catalogue(input.objectId);

      await expect(client.uploadRuntimeObject(input)).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "command_invariant_conflict" },
      });
      expect(await catalogue(input.objectId)).toEqual(before);
      await deliverAvailable(input.objectId);
      expect(await catalogue(input.objectId)).toMatchObject({
        state: "available",
        sha256: input.sha256,
        generation: input.generation,
      });
    },
  );

  it.each([
    ["deleted", "runtime_object_deleted"],
    ["corrupt", "runtime_object_integrity_mismatch"],
    ["missing", "runtime_object_missing"],
  ] as const)(
    "reads a catalogued %s object as a typed %s refusal",
    async (state, reason) => {
      const { client, runId, input } = await fixture();

      await client.uploadRuntimeObject(input);
      await deliverAvailable(input.objectId);
      // The catalogue state is the manager's own evidence; the host is not
      // consulted for a read the catalogue already refuses.
      await db
        .update(executionRuntimeObjects)
        .set({
          state,
          ...(state === "deleted" ? { deletedAt: new Date() } : {}),
        })
        .where(eq(executionRuntimeObjects.id, input.objectId));
      await expect(
        readRuntimeObjectContent({ db, runId, objectId: input.objectId }),
      ).rejects.toMatchObject({
        code: "PRECONDITION",
        details: { reason },
      });
    },
  );

  it("quarantines an unsolicited host object without allocating manager identity", async () => {
    const { runId, assignment, reservation, input } = await fixture();
    const objectId = randomUUID();
    const binding = {
      hostKey: host.hostKey,
      runId,
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
    };

    await transport.reserveRuntimeObject(
      buildEnvelope({
        ...binding,
        commandId: randomUUID(),
        kind: "runtime_object.reserve",
        payload: { ...reservation, objectId },
      }),
    );
    await transport.uploadRuntimeObject({
      objectId,
      bytes: input.bytes,
      envelope: buildEnvelope({
        ...binding,
        commandId: randomUUID(),
        kind: "runtime_object.upload",
        payload: {
          generation: 1,
          sizeBytes: input.bytes.byteLength,
          sha256: input.sha256,
        },
      }),
    });
    for await (const envelope of transport.streamRuntimeEvents({
      afterSequence: sequence,
      signal: AbortSignal.timeout(10_000),
    })) {
      await ingestRuntimeEvent({ db, executionHostId: host.id, envelope });
      sequence = envelope.sequence;
      if (
        envelope.eventType === "runtime_object.available" &&
        envelope.payload.objectId === objectId
      )
        break;
    }
    const summary = await projectCanonicalRuntimeObjects({ db, runId });

    expect(summary.poisoned).toBe(true);
    expect(await catalogue(objectId)).toBeUndefined();
    expect((await catalogue(reservation.objectId)).state).toBe("pending");
  });
});

describe("runtime object crash-gap recovery through a real host restart", () => {
  function binding(input: {
    runId: string;
    assignment: { id: string; epoch: number };
    objectId: string;
    generation: number;
  }) {
    return {
      objectId: input.objectId,
      runId: input.runId,
      executionHostId: host.id,
      executionAssignmentId: input.assignment.id,
      assignmentEpoch: input.assignment.epoch,
      generation: input.generation,
    };
  }

  async function seededDelete(input: {
    runId: string;
    assignment: { id: string; epoch: number };
    objectId: string;
    generation: number;
  }) {
    const command = await insertCommand(db, {
      runId: input.runId,
      assignmentId: input.assignment.id,
      hostId: host.id,
      assignmentEpoch: input.assignment.epoch,
      kind: "runtime_object.delete",
      targetSessionId: input.objectId,
      payload: { generation: input.generation },
      maxAttempts: 3,
      driverless: true,
    });

    await db.transaction((tx) =>
      reduceRuntimeObjectEvidence(tx, binding(input), {
        kind: "state",
        source: "delete_intent",
        state: "deleting",
        deletedAt: null,
      }),
    );
    await claimDelivering(db, command.id, 0);

    return {
      command,
      envelope: buildEnvelope({
        commandId: command.id,
        kind: "runtime_object.delete",
        runId: input.runId,
        hostKey: host.hostKey,
        assignmentId: input.assignment.id,
        assignmentEpoch: input.assignment.epoch,
        payload: { generation: input.generation },
      }),
    };
  }

  it("recovers an upload whose acknowledgement was lost across a host restart", async () => {
    const { runId, assignment, input } = await fixture();
    const payload = {
      generation: input.generation,
      sizeBytes: input.bytes.byteLength,
      sha256: input.sha256,
    };
    const command = await insertCommand(db, {
      runId,
      assignmentId: assignment.id,
      hostId: host.id,
      assignmentEpoch: assignment.epoch,
      kind: "runtime_object.upload",
      targetSessionId: input.objectId,
      payload,
      maxAttempts: 3,
      driverless: false,
    });

    await claimDelivering(db, command.id, 0);
    const metadata = await transport.uploadRuntimeObject({
      objectId: input.objectId,
      bytes: input.bytes,
      envelope: buildEnvelope({
        commandId: command.id,
        kind: "runtime_object.upload",
        runId,
        hostKey: host.hostKey,
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
        payload,
      }),
    });

    supervisor = await supervisor.restart();
    const summary = await recoverExecutionCommands({
      db,
      transport,
      graceMs: 0,
    });

    expect(summary.errors).toEqual([]);
    expect(await getCommand(db, command.id)).toMatchObject({
      state: "succeeded",
    });
    expect(await catalogue(input.objectId)).toMatchObject({
      state: "pending",
      sha256: input.sha256,
      sealedAt: new Date(metadata.sealedAt!),
    });
    await deliverAvailable(input.objectId);
    expect((await catalogue(input.objectId)).state).toBe("available");
    const { content } = await readRuntimeObjectContent({
      db,
      runId,
      objectId: input.objectId,
    });

    expect(content.bytes).toEqual(input.bytes);
  });

  it("recovers a delete whose acknowledgement was lost across a host restart without resurrecting the object", async () => {
    const { client, runId, assignment, input } = await fixture();

    await client.uploadRuntimeObject(input);
    await deliverAvailable(input.objectId);
    const [available] = await db
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.runId, runId),
          eq(executionEvents.eventType, "runtime_object.available"),
        ),
      );
    const { command, envelope } = await seededDelete({
      runId,
      assignment,
      objectId: input.objectId,
      generation: input.generation,
    });

    await transport.deleteRuntimeObject(input.objectId, envelope);
    supervisor = await supervisor.restart();
    const summary = await recoverExecutionCommands({
      db,
      transport,
      graceMs: 0,
    });

    expect(summary.errors).toEqual([]);
    expect(await getCommand(db, command.id)).toMatchObject({
      state: "succeeded",
    });
    const tombstone = await catalogue(input.objectId);

    expect(tombstone.state).toBe("deleted");
    expect(tombstone.deletedAt).not.toBeNull();
    // A late canonical availability for the exact old intent is historical
    // evidence: it neither resurrects the tombstone nor poisons the consumer.
    await db.transaction((tx) => projectRuntimeObject(tx, available));
    expect(await catalogue(input.objectId)).toEqual(tombstone);
    const projection = await projectCanonicalRuntimeObjects({ db, runId });

    expect(projection.poisoned).toBe(false);
    expect(await catalogue(input.objectId)).toMatchObject({
      state: "deleted",
    });
  });

  it("redelivers a delete the host accepted but never tombstoned instead of losing the turn", async () => {
    const { client, runId, assignment, input } = await fixture();

    await client.uploadRuntimeObject(input);
    await deliverAvailable(input.objectId);
    const { command } = await seededDelete({
      runId,
      assignment,
      objectId: input.objectId,
      generation: input.generation,
    });

    // The host accepted the command and then died before its tombstone: the
    // only durable trace is an accepted receipt naming the object.
    await supervisor.kill();
    const state = new DatabaseSync(join(supervisor.stateDir, "state.sqlite"));

    try {
      state
        .prepare(
          `INSERT INTO command_receipts
             (command_id, run_id, kind, assignment_id, epoch, host_session_id, request_digest, request_schema, request_version, host_key, phase, http_status, body_json, received_at, completed_at)
           VALUES (?, ?, 'runtime_object.delete', ?, ?, ?, NULL, NULL, 1, NULL, 'accepted', 202, '{}', ?, NULL)`,
        )
        .run(
          command.id,
          runId,
          assignment.id,
          assignment.epoch,
          input.objectId,
          new Date().toISOString(),
        );
    } finally {
      state.close();
    }
    supervisor = await supervisor.restart();
    const summary = await recoverExecutionCommands({
      db,
      transport,
      graceMs: 0,
    });

    expect(summary.errors).toEqual([]);
    expect(await getCommand(db, command.id)).toMatchObject({
      state: "succeeded",
    });
    expect(await catalogue(input.objectId)).toMatchObject({
      state: "deleted",
    });
    expect(await transport.getCommandReceipt(command.id)).toMatchObject({
      phase: "completed",
    });
    const hostRow = await fetch(
      `${supervisor.url}/runtime-objects/${input.objectId}`,
    );

    expect(hostRow.status).toBe(200);
    expect(await hostRow.json()).toMatchObject({ state: "deleted" });
  });
});

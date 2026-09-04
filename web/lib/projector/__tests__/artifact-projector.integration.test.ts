import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { projectRunEvents } from "@/lib/projector/artifact-projector";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "canonical_artifact_projector_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

type SeededRun = {
  runId: string;
  nodeAttemptId: string;
  hostId: string;
  assignmentId: string;
  streamId: string;
};

async function seedRun(): Promise<SeededRun> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const hostId = randomUUID();
  const assignmentId = randomUUID();
  const streamId = randomUUID();
  const nodeAttemptId = randomUUID();
  const slug = `artifact-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${projectId.slice(0, 8)}`.toUpperCase(),
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "flow",
    status: "Running",
    executionDataPlaneMode: "canonical_events_v1",
    flowVersion: "v1",
    flowRevision: "test",
  });
  await db.insert(schema.nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
  });
  await db.insert(schema.executionHosts).values({
    id: hostId,
    hostKey: `eh_${randomUUID().replace(/-/g, "")}`,
    kind: "local_direct",
    displayName: "artifact test host",
    transport: { kind: "local_direct" },
  });
  await db.insert(schema.executionAssignments).values({
    id: assignmentId,
    runId,
    executionHostId: hostId,
    epoch: 1,
    state: "active",
    placementReason: "launch",
  });
  await db.insert(schema.executionEventStreams).values({
    id: streamId,
    executionHostId: hostId,
    streamId: randomUUID(),
    state: "active",
    lastContiguousSequence: 0n,
    lastReceivedSequence: 0n,
  });

  return { runId, nodeAttemptId, hostId, assignmentId, streamId };
}

async function recordHostToolEvent(
  seeded: SeededRun,
  input: { sequence: bigint; title: string; url?: string },
): Promise<string> {
  const eventId = randomUUID();
  const content = input.url
    ? [{ type: "resource_link", uri: input.url, name: "preview" }]
    : [];

  await db.insert(schema.executionEvents).values({
    id: eventId,
    source: "host",
    runId: seeded.runId,
    executionHostId: seeded.hostId,
    eventStreamId: seeded.streamId,
    hostSequence: input.sequence,
    executionAssignmentId: seeded.assignmentId,
    assignmentEpoch: 1,
    hostBootId: randomUUID(),
    hostSessionId: randomUUID(),
    envelopeVersion: 1,
    eventType: "session.update",
    payloadSchema: "maister.session.update.v1",
    payload: {
      nodeAttemptId: seeded.nodeAttemptId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `tool-${input.sequence.toString()}`,
        title: input.title,
        status: "completed",
        content,
      },
    },
    payloadSha256: "a".repeat(64),
    payloadBytes: 256,
    occurredAt: new Date(),
    receivedAt: new Date(),
    runSequence: input.sequence,
    ingestDisposition: "accepted",
  });

  return eventId;
}

describe("projectRunEvents", () => {
  it("derives typed artifacts only from canonical host events and is idempotent", async () => {
    const seeded = await seedRun();
    const logEventId = await recordHostToolEvent(seeded, {
      sequence: 0n,
      title: "Run check",
    });
    const previewEventId = await recordHostToolEvent(seeded, {
      sequence: 1n,
      title: "Open preview",
      url: "https://preview.example.test/result",
    });

    const first = await projectRunEvents(seeded.runId, { db });
    const second = await projectRunEvents(seeded.runId, { db });
    const artifacts = await db
      .select()
      .from(schema.artifactInstances)
      .where(eq(schema.artifactInstances.runId, seeded.runId));

    expect(first.projected).toBe(2);
    expect(second.projected).toBe(0);
    expect(artifacts).toEqual([
      expect.objectContaining({
        id: `proj:${seeded.runId}:event:${logEventId}`,
        kind: "log",
        nodeAttemptId: seeded.nodeAttemptId,
        monotonicId: null,
      }),
      expect.objectContaining({
        id: `proj:${seeded.runId}:event:${previewEventId}`,
        kind: "preview",
        uri: "https://preview.example.test/result",
        nodeAttemptId: seeded.nodeAttemptId,
        monotonicId: null,
      }),
    ]);
  });
});

import { createHash, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { getCurrentArtifact } from "@/lib/flows/graph/artifact-store";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import { prepareSessionContent } from "@/lib/execution-host/events/session-content";
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

afterEach(() => {
  setDefaultTransportForTests(null);
});

type SeededRun = {
  runId: string;
  nodeAttemptId: string;
  hostId: string;
  assignmentId: string;
  streamId: string;
  hostSessionId: string;
};

// E-EH-01 admits at most ONE non-retired local host per database, so the host
// and its event stream are shared by every seeded run rather than re-created.
let sharedHost: { hostId: string; streamId: string } | null = null;

async function seedLocalHost(): Promise<{ hostId: string; streamId: string }> {
  if (sharedHost) return sharedHost;
  const hostId = randomUUID();
  const streamId = randomUUID();

  await db.insert(schema.executionHosts).values({
    id: hostId,
    hostKey: `eh_${randomUUID().replace(/-/g, "")}`,
    kind: "local_direct",
    displayName: "artifact test host",
    transport: { kind: "local_direct" },
  });
  await db.insert(schema.executionEventStreams).values({
    id: streamId,
    executionHostId: hostId,
    streamId: randomUUID(),
    state: "active",
    lastContiguousSequence: 0n,
    lastReceivedSequence: 0n,
  });
  sharedHost = { hostId, streamId };

  return sharedHost;
}

// `execution_events_host_position_uq` is keyed on (stream, host_sequence) and
// the stream is shared, so host positions are allocated globally while each
// run keeps its own `run_sequence`.
let nextHostSequence = 0n;

function allocateHostSequence(): bigint {
  nextHostSequence += 1n;

  return nextHostSequence;
}

async function seedRun(): Promise<SeededRun> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const { hostId, streamId } = await seedLocalHost();
  const assignmentId = randomUUID();
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
  await db.insert(schema.executionAssignments).values({
    id: assignmentId,
    runId,
    executionHostId: hostId,
    epoch: 1,
    state: "active",
    placementReason: "launch",
  });

  return {
    runId,
    nodeAttemptId,
    hostId,
    assignmentId,
    streamId,
    hostSessionId: `sess-${randomUUID()}`,
  };
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
    hostSequence: allocateHostSequence(),
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

// EDGE-TRC-02 fixture. Everything here is REAL: the runtime-object row, the
// command fence, the sha256 and the byte length are all checked by the
// production `prepareSessionContent`. The single double is the byte transport,
// and it serves the exact recorded bytes — it clamps nothing, which the
// tampered-digest case below proves by showing the real code still refuses.
async function recordOffloadedPreviewEvent(
  seeded: SeededRun,
  input: { sequence: bigint; url: string; sha256?: string },
): Promise<{ eventId: string; bytes: Uint8Array }> {
  const eventId = randomUUID();
  const objectId = randomUUID();
  const commandId = randomUUID();
  const sourceMonotonicId = Number(input.sequence);
  const inner = {
    nodeAttemptId: seeded.nodeAttemptId,
    sourceMonotonicId,
    sourceCommandId: null,
    sessionName: null,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: `tool-${input.sequence.toString()}`,
      title: "Publish preview",
      status: "completed",
      content: [{ type: "resource_link", uri: input.url, name: "preview" }],
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(inner));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const sealedAt = new Date();

  await db.insert(schema.executionCommands).values({
    id: commandId,
    runId: seeded.runId,
    executionAssignmentId: seeded.assignmentId,
    executionHostId: seeded.hostId,
    assignmentEpoch: 1,
    // `session.create` is the source command here on purpose: it satisfies the
    // native-output fence without a durable prompt owner, which
    // `execution_commands_prompt_owner_required` demands of `session.prompt`.
    kind: "session.create",
    targetSessionId: seeded.hostSessionId,
    maxAttempts: 1,
  });

  const contentRef = {
    schema: "maister.session-content.v2",
    commandId,
    hostSessionId: seeded.hostSessionId,
    source: "session_update",
    firstFrame: sourceMonotonicId,
    frameCount: 1,
    objectId,
    kind: "raw_transcript",
    logicalName: "session-content.json",
    mimeType: "application/json",
    generation: 1,
    sizeBytes: bytes.byteLength,
    sha256: input.sha256 ?? digest,
    retentionClass: "run",
    state: "available",
    sealedAt: sealedAt.toISOString(),
    expiresAt: null,
  };

  await db.insert(schema.executionEvents).values({
    id: eventId,
    source: "host",
    runId: seeded.runId,
    executionHostId: seeded.hostId,
    eventStreamId: seeded.streamId,
    hostSequence: allocateHostSequence(),
    executionAssignmentId: seeded.assignmentId,
    assignmentEpoch: 1,
    hostBootId: randomUUID(),
    hostSessionId: seeded.hostSessionId,
    envelopeVersion: 1,
    eventType: "session.update",
    payloadSchema: "maister.session.content.v2",
    payload: {
      nodeAttemptId: seeded.nodeAttemptId,
      sourceMonotonicId,
      sourceCommandId: null,
      sessionName: null,
      contentRef,
    },
    payloadSha256: "b".repeat(64),
    payloadBytes: bytes.byteLength,
    occurredAt: sealedAt,
    receivedAt: sealedAt,
    runSequence: input.sequence,
    ingestDisposition: "accepted",
  });

  return { eventId, bytes };
}

function serveBytes(objectId: string, bytes: Uint8Array): void {
  setDefaultTransportForTests({
    openRuntimeObjectContent: async (requested: string) => {
      if (requested !== objectId)
        throw new Error(`unknown object ${requested}`);

      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        contentLength: bytes.byteLength,
        contentRange: null,
        contentDigest: null,
        reprDigest: null,
        etag: null,
      };
    },
  } as never);
}

async function loadEvent(eventId: string) {
  const [row] = await db
    .select()
    .from(schema.executionEvents)
    .where(eq(schema.executionEvents.id, eventId));

  return row;
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

  // IT-TRC-02. A projector row is EVIDENCE-INERT by construction: it carries no
  // `artifact_def_id`, and every gate / `input.requires` / `output.produces`
  // resolution keys on that column. So no amount of projector output can
  // satisfy, or accidentally fail, a declared artifact requirement.
  it("IT-TRC-02: writes projector rows with a null artifact_def_id, unreachable by a gate", async () => {
    const seeded = await seedRun();

    await recordHostToolEvent(seeded, {
      sequence: 0n,
      title: "Open preview",
      url: "https://preview.example.test/gate",
    });
    await projectRunEvents(seeded.runId, { db });

    const artifacts = await db
      .select()
      .from(schema.artifactInstances)
      .where(eq(schema.artifactInstances.runId, seeded.runId));

    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(artifact.producer).toBe("projector");
      expect(artifact.artifactDefId).toBeNull();
    }

    // The resolution a gate actually performs finds nothing, for the def a
    // manifest would declare AND for the kind the projector just wrote.
    for (const defId of ["default:preview", "preview", "log"]) {
      await expect(
        getCurrentArtifact(seeded.runId, defId, db as never),
      ).resolves.toBeUndefined();
    }
  });

  // IT-EDGE-TRC-02. `assertRuntimeEventPayloadSafe` offloads nearly every
  // tool_call whole, so the row the projector reads holds only `{contentRef}` —
  // the preview URL lives in host-private bytes. Derivation therefore MUST run
  // after rehydration; dropping the fetch to save a round-trip would silently
  // stop deriving previews while every test on the inline shape stayed green.
  it("IT-EDGE-TRC-02: derives a preview from an offloaded payload", async () => {
    const seeded = await seedRun();
    const url = "https://preview.example.test/offloaded";
    const { eventId, bytes } = await recordOffloadedPreviewEvent(seeded, {
      sequence: 0n,
      url,
    });
    const event = await loadEvent(eventId);

    serveBytes(event.payload.contentRef.objectId, bytes);

    await projectRunEvents(seeded.runId, { db });

    const artifacts = await db
      .select()
      .from(schema.artifactInstances)
      .where(eq(schema.artifactInstances.runId, seeded.runId));

    expect(artifacts).toEqual([
      expect.objectContaining({
        id: `proj:${seeded.runId}:event:${eventId}`,
        kind: "preview",
        uri: url,
        producer: "projector",
        artifactDefId: null,
        nodeAttemptId: seeded.nodeAttemptId,
      }),
    ]);
  });

  // The double above is only trustworthy if the production integrity checks it
  // feeds still REFUSE a bad reference (memory:lenient-test-doubles-hide-
  // contract-bugs). A digest that disagrees with the bytes must be corrupt, not
  // clamped — otherwise the test above would certify a path that never verifies.
  it("IT-EDGE-TRC-02: still refuses an offloaded payload whose digest disagrees", async () => {
    const seeded = await seedRun();
    const { eventId, bytes } = await recordOffloadedPreviewEvent(seeded, {
      sequence: 0n,
      url: "https://preview.example.test/tampered",
      sha256: "c".repeat(64),
    });
    const event = await loadEvent(eventId);

    serveBytes(event.payload.contentRef.objectId, bytes);

    await expect(
      prepareSessionContent(
        db as never,
        event as never,
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toThrow(/identity or byte integrity/);
  });
});

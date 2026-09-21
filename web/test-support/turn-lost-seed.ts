import type { Db } from "@/lib/execution-host/db";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import * as fullSchema from "@/lib/db/schema";
import { mintAssignment } from "@/lib/execution-host/assignments";

// FIXME(any): dual drizzle-orm peer-dep variants — same cast as graph-run-seed.
const schema = fullSchema as unknown as Record<string, any>;

// ADR-177. A `Running` (or `Crashed`) flow run parked on an `ai_coding` node
// whose owned `session.prompt` carries the evidence shape under test. Shared by
// the Recover-decline suite and the boundary suite so the two never drift on
// what "a lost turn" looks like on disk.
//
// `terminal_evidence_sha256` is set because that is the ONE pointer
// `reconcileStoredPromptEvidence` settles on without a host read — without it
// the recover path answers `waiting` and every case measures nothing.

export const TURN_LOST_NESTED_ERROR = {
  code: "PRECONDITION",
  details: { reason: "turn_lost" },
} as const;

// `foldReceipt`'s accepted-with-no-terminal fallback FLATTENS the reason, so a
// matcher keyed only on `details.reason` never fires on this shape.
export const TURN_LOST_FLAT_ERROR = {
  code: "ACP_PROTOCOL",
  reason: "turn_lost",
} as const;

export const TURN_LOST_MANIFEST = {
  schemaVersion: 1,
  name: "tlb",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/work" },
      transitions: {},
    },
  ],
};

export type SeededFlowGraph = { flowId: string; flowRevisionId: string };

export async function seedTurnLostFlow(
  db: NodePgDatabase,
  projectId: string,
): Promise<SeededFlowGraph> {
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();

  await db.insert(schema.flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "tlb",
    source: "github.com/x/tlb",
    versionLabel: "v1.0.0",
    resolvedRevision: randomUUID().replace(/-/g, ""),
    manifestDigest: "sha256:tlb",
    manifest: TURN_LOST_MANIFEST,
    schemaVersion: 1,
    installedPath: "/tmp/flows/tlb",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "tlb",
    source: "github.com/x/tlb",
    version: "v1.0.0",
    installedPath: "/tmp/flows/tlb",
    manifest: TURN_LOST_MANIFEST,
    schemaVersion: 1,
  });

  return { flowId, flowRevisionId };
}

export type SeededLostTurn = {
  runId: string;
  nodeAttemptId: string;
  commandId: string;
  assignmentId: string;
  assignmentEpoch: number;
};

export type SeedLostTurnInput = {
  db: NodePgDatabase;
  projectId: string;
  repoPath: string;
  hostId: string;
  flow: SeededFlowGraph;
  status?: string;
  runKind?: "flow" | "scratch" | "agent";
  attemptStatus?: string;
  lastError?: Record<string, unknown>;
  applicationState?: string;
  completionAppliedAt?: Date | null;
  commandState?: string;
  terminalEvidence?: boolean;
  /** `lost` is the ONLY bound on the `evidence-pending` skip arm (ADR-177). */
  streamState?: "observed" | "active" | "closed" | "lost";
};

export async function seedLostTurn(
  input: SeedLostTurnInput,
): Promise<SeededLostTurn> {
  const { db, projectId, hostId, flow } = input;
  const { seedRun } = await import("@/test-support/execution-host-seed");
  const status = input.status ?? "Running";
  const runId = await seedRun(db, {
    projectId,
    status,
    runKind: input.runKind ?? "flow",
  });

  await db
    .update(schema.runs)
    .set({
      flowId: flow.flowId,
      flowRevisionId: flow.flowRevisionId,
      currentStepId: status === "Crashed" ? null : "implement",
      ...(status === "Crashed" ? { resumeTargetStepId: "implement" } : {}),
    })
    .where(eq(schema.runs.id, runId));
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/${runId.slice(0, 8)}`,
    worktreePath: `/worktrees/${runId.slice(0, 8)}`,
    parentRepoPath: input.repoPath,
  });
  const assignment = await db.transaction(async (tx) =>
    mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
  );
  const nodeAttemptId = randomUUID();

  await db.insert(schema.nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: input.attemptStatus ?? "Running",
    executionAssignmentId: assignment.id,
    actionPromptOrdinal: 0,
    // Definitively OUTSIDE the 90 s grace: a skip can only be an evidence arm.
    startedAt: new Date(Date.now() - 600_000),
  });
  const commandId = randomUUID();
  const commandState = input.commandState ?? "failed";
  const terminal = input.terminalEvidence ?? true;
  let terminalEventId: string | null = null;

  if (terminal) {
    // `execution_commands_terminal_evidence_check` demands the whole triple:
    // the digest, a real `execution_events` row, and a receipt whose identity
    // fields match the command. Seeding one leg is refused by the database, so
    // the fixture cannot drift into a shape production never writes.
    terminalEventId = randomUUID();
    // `execution_events_source_shape_check`: a `host` event must belong to a
    // stream and carry a position in it.
    const eventStreamId = randomUUID();

    await db.insert(schema.executionEventStreams).values({
      id: eventStreamId,
      executionHostId: hostId,
      streamId: `tlb-${eventStreamId.slice(0, 8)}`,
      // `execution_event_streams_active_host_uq` admits ONE `active` stream per
      // host, so the default is the column default; a case that needs `lost`
      // (the only bound on the skip arm) asks for it.
      state: input.streamState ?? "observed",
    });
    await db.insert(schema.executionEvents).values({
      id: terminalEventId,
      source: "host",
      runId,
      eventStreamId,
      hostSequence: 1n,
      executionHostId: hostId,
      executionAssignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      // `execution_events_protocol_bounds_check`: a `host` event must name its
      // boot and envelope version.
      hostBootId: randomUUID(),
      envelopeVersion: 1,
      eventType: "session.command",
      payloadSchema: "maister.session.command.v2",
      payload: {
        commandId,
        status: commandState,
        error: input.lastError ?? TURN_LOST_NESTED_ERROR,
      },
      occurredAt: new Date(Date.now() - 120_000),
      ingestDisposition: "accepted",
    });
  }

  await db.insert(schema.executionCommands).values({
    id: commandId,
    runId,
    executionAssignmentId: assignment.id,
    executionHostId: hostId,
    assignmentEpoch: assignment.epoch,
    kind: "session.prompt",
    targetSessionId: `sess-${runId.slice(0, 8)}`,
    payload: {},
    maxAttempts: 3,
    ownerKind: "flow_node_attempt",
    ownerRef: {
      version: 1,
      variant: "node",
      nodeAttemptId,
      promptOrdinal: 0,
      runId,
      runSessionId: randomUUID(),
      incarnationId: randomUUID(),
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
    },
    logicalOperationKey: `flow_node_attempt:node:${nodeAttemptId}:0`,
    // v1 keeps `execution_commands_request_v2_check` on its short branch —
    // these suites assert CLASSIFICATION, not canonical request identity.
    requestSchema: "maister.command.request.v1",
    requestSha256: "b".repeat(64),
    state: commandState,
    acceptedAt: new Date(Date.now() - 300_000),
    ...(commandState === "failed" || commandState === "succeeded"
      ? { completedAt: new Date(Date.now() - 120_000) }
      : {}),
    ...(terminal
      ? {
          terminalEvidenceSha256: "c".repeat(64),
          terminalEventId,
          receiptEvidence: {
            commandId,
            runId,
            kind: "session.prompt",
            assignmentEpoch: assignment.epoch,
            phase: commandState === "succeeded" ? "completed" : "rejected",
            httpStatus: commandState === "succeeded" ? 200 : 409,
            body: { details: { reason: "turn_lost" } },
            receivedAt: new Date(Date.now() - 120_000).toISOString(),
            completedAt: new Date(Date.now() - 120_000).toISOString(),
            eventId: terminalEventId,
            inflight: false,
          },
        }
      : {}),
    lastError: input.lastError ?? TURN_LOST_NESTED_ERROR,
    applicationState: input.applicationState ?? "pending",
    completionAppliedAt: input.completionAppliedAt ?? null,
  });

  return {
    runId,
    nodeAttemptId,
    commandId,
    assignmentId: assignment.id,
    assignmentEpoch: assignment.epoch,
  };
}

/** The shape `classifyCommandRetirement` reads, with every non-owner gate
 * already satisfied, so a case measures the owner disposition and nothing else. */
export function retirementRow(
  command: Record<string, unknown>,
  runStatus: string,
): Record<string, unknown> {
  return {
    ...command,
    runStatus,
    terminalEventId: "evt-1",
    terminalHostSequence: 1n,
    ackConfirmedSequence: 1n,
  };
}

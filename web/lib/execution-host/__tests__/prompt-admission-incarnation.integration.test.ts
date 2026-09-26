// ADR-167 D5 amendment (2026-09-23) — prompt admission never waits for the
// lifecycle projector. The create ACK writes the exact incarnation as
// `created` under the assignment lock; the projector later activates it. Every
// case holds the canonical lifecycle projector for its run so the ACK path is
// the only writer that could have produced what is asserted.

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { applyCreateAck } from "@/lib/execution-host/create-ack";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { CANONICAL_PROJECTION_CONSUMERS } from "@/lib/execution-host/events/projection-consumers";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { waitForPromptIncarnation } from "@/lib/execution-host/prompt-incarnation";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import {
  seedProjectRow,
  seedRun,
  seedWorkspace,
} from "@/test-support/execution-host-seed";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { holdProjection } from "@/test-support/projection-hold";
import { seedNodePromptOwner } from "@/test-support/prompt-owner-fixture";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let projectionWorker: ProjectionWorker;
let db: Db;
let sup: RealSupervisor;
let restoreUrl: () => void = () => {};
let hosts: ExecutionHosts;
let project: { id: string; slug: string; repoPath: string };

const CREATE_PAYLOAD = {
  stepId: "s1",
  executor: { agent: "claude" as const, model: "mock" },
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_prompt_admission_test",
  });
  db = testDatabase.db as unknown as Db;
  sup = await startRealSupervisor();
  restoreUrl = useRealSupervisorUrl(sup.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  project = await seedProjectRow(testDatabase.db, {
    repoPath: await initRepo(`${sup.runtimeRoot}/repo`),
  });
  hosts = createExecutionHosts({ db });
  projectionWorker = startProjectionWorker({
    db,
    projectors: canonicalProjectors,
  });
}, 240_000);

afterAll(async () => {
  restoreUrl();
  await stopRuntimeEventConsumers();
  await projectionWorker?.stop();
  await sup?.stop();
  await testDatabase?.stop();
});

async function seedFlowRun(name: string): Promise<string> {
  const runId = await seedRun(testDatabase.db, {
    projectId: project.id,
    status: "Running",
    runKind: "flow",
  });
  const worktreePath = await addWorktree(
    project.repoPath,
    `${sup.runtimeRoot}/wt-${name}-${randomUUID().slice(0, 6)}`,
    `maister/${name}-${randomUUID().slice(0, 6)}`,
  );

  await seedWorkspace(testDatabase.db, {
    runId,
    projectId: project.id,
    worktreePath,
    parentRepoPath: project.repoPath,
  });

  return runId;
}

type IncarnationRow = {
  id: string;
  state: string;
  hostBootId: string | null;
  activatedAt: Date | null;
  terminalReason: Record<string, unknown> | null;
};

async function incarnation(hostSessionId: string): Promise<IncarnationRow> {
  const [row] = (await db
    .select()
    .from(schema.runSessionIncarnations)
    .where(
      eq(schema.runSessionIncarnations.hostSessionId, hostSessionId),
    )) as IncarnationRow[];

  if (!row) throw new Error(`no incarnation for ${hostSessionId}`);

  return row;
}

async function lifecycleConsumerState(runId: string): Promise<string | null> {
  const { rows } = await testDatabase.pool.query<{ state: string }>(
    "SELECT state FROM execution_event_consumers WHERE consumer_name = $1 AND run_id = $2",
    [CANONICAL_PROJECTION_CONSUMERS.lifecycle, runId],
  );

  return rows[0]?.state ?? null;
}

async function lifecycleClaimOwner(runId: string): Promise<string | null> {
  const { rows } = await testDatabase.pool.query<{
    claim_owner: string | null;
  }>(
    "SELECT claim_owner FROM execution_event_consumers WHERE consumer_name = $1 AND run_id = $2",
    [CANONICAL_PROJECTION_CONSUMERS.lifecycle, runId],
  );

  return rows[0]?.claim_owner ?? null;
}

describe("prompt admission on the ACK-authored incarnation", () => {
  it("A1: admits a node prompt while lifecycle projection is held, then activates the same row", async () => {
    const runId = await seedFlowRun("a1");
    const client = await hosts.forRun(runId, { reason: "launch" });
    const release = await holdProjection(testDatabase.pool, {
      consumerName: CANONICAL_PROJECTION_CONSUMERS.lifecycle,
      runId,
    });
    let hostSessionId: string;
    let createdId: string;

    try {
      const session = await client.createSession(CREATE_PAYLOAD);

      hostSessionId = session.hostSessionId;
      const created = await incarnation(hostSessionId);

      createdId = created.id;
      expect(created).toMatchObject({
        state: "created",
        hostBootId: null,
        activatedAt: null,
      });

      const admitOwner = await seedNodePromptOwner(db, client, hostSessionId);

      // Admission returned while the lifecycle projector is still held and the
      // row it admitted is still the unactivated ACK row: it did not wait for
      // projection, which could not have run yet.
      expect(await incarnation(hostSessionId)).toMatchObject({
        id: createdId,
        state: "created",
        activatedAt: null,
      });
      expect(await lifecycleClaimOwner(runId)).toMatch(/^test-hold:/);

      const handle = await client.prompt(
        hostSessionId,
        { stepId: "s1", prompt: "hello" },
        { admitOwner },
      );

      expect(
        (
          await client.waitForPrompt(handle, {
            signal: AbortSignal.timeout(60_000),
          })
        ).stopReason,
      ).toBe("end_turn");
    } finally {
      await release();
    }

    // The released projector drains `session.created` before the session's
    // later exit, so activation is observed by its stamp, not by the state
    // the drained batch ends in.
    await expect
      .poll(async () => (await incarnation(hostSessionId)).activatedAt, {
        timeout: 60_000,
      })
      .toBeInstanceOf(Date);
    const activated = await incarnation(hostSessionId);

    expect(activated.id).toBe(createdId);
    expect(["active", "exited"]).toContain(activated.state);
    expect(activated.activatedAt).toBeInstanceOf(Date);
    expect(activated.hostBootId).not.toBeNull();
  }, 180_000);

  it("A3: a delayed create ACK for a superseded assignment is refused and inserts no incarnation", async () => {
    const runId = await seedFlowRun("a3-stale-ack");
    const first = await hosts.forRun(runId, { reason: "launch" });
    const hostSessionId = `stale-${randomUUID()}`;

    // A newer placement supersedes the assignment the ACK was issued under.
    await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, {
        runId,
        hostId: first.host.id,
        reason: "resume",
      }),
    );
    const disposition = await db.transaction((tx) =>
      applyCreateAck(tx as unknown as Db, {
        runId,
        sessionName: "default",
        assignmentId: first.assignment.id,
        nodeAttemptId: null,
        result: {
          sessionId: hostSessionId,
          acpSessionId: null,
          steeringSupported: null,
        },
      }),
    );

    expect(disposition).toBe("stale");
    expect(
      await db
        .select()
        .from(schema.runSessionIncarnations)
        .where(eq(schema.runSessionIncarnations.hostSessionId, hostSessionId)),
    ).toEqual([]);
  }, 120_000);

  it("A3: a checkpointed incarnation is outside the admissible set and is fenced", async () => {
    const runId = await seedFlowRun("a3-checkpointed");
    const client = await hosts.forRun(runId, { reason: "launch" });
    const session = await client.createSession(CREATE_PAYLOAD);

    await client.checkpoint(session.hostSessionId);
    await expect
      .poll(async () => (await incarnation(session.hostSessionId)).state, {
        timeout: 60_000,
      })
      .toBe("checkpointed");
    await expect(
      waitForPromptIncarnation(db, client, session.hostSessionId),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) && err.details?.reason === "assignment_fenced",
    );
  }, 180_000);

  it("A5: consecutive sessions on one assignment supersede by host session, and the late exit never re-opens the old row", async () => {
    const runId = await seedFlowRun("a5");
    const client = await hosts.forRun(runId, { reason: "launch" });
    const release = await holdProjection(testDatabase.pool, {
      consumerName: CANONICAL_PROJECTION_CONSUMERS.lifecycle,
      runId,
    });
    let firstId: string;
    let secondId: string;

    try {
      const first = await client.createSession(CREATE_PAYLOAD);

      firstId = first.hostSessionId;
      await client.deleteSession(firstId);
      // The next node reuses the `default` session on the SAME assignment,
      // while the first session's exit is still unprojected.
      const second = await client.createSession(CREATE_PAYLOAD);

      secondId = second.hostSessionId;
      expect(await incarnation(firstId)).toMatchObject({
        state: "lost",
        terminalReason: { reason: "session_superseded" },
      });
      expect((await incarnation(secondId)).state).toBe("created");
    } finally {
      await release();
    }

    await expect
      .poll(
        async () => [
          (await incarnation(firstId)).state,
          (await incarnation(secondId)).state,
        ],
        { timeout: 60_000 },
      )
      .toEqual(["exited", "active"]);
    expect(await lifecycleConsumerState(runId)).not.toBe("poisoned");
  }, 180_000);

  it("A5: a superseded row refuses its late checkpoint exit — it stays lost and the lifecycle cursor is not poisoned", async () => {
    const runId = await seedFlowRun("a5-checkpoint");
    const client = await hosts.forRun(runId, { reason: "launch" });
    const release = await holdProjection(testDatabase.pool, {
      consumerName: CANONICAL_PROJECTION_CONSUMERS.lifecycle,
      runId,
    });
    let firstId: string;
    let secondId: string;

    try {
      const first = await client.createSession(CREATE_PAYLOAD);

      firstId = first.hostSessionId;
      // `session.exited{reason:"checkpoint"}` stays unprojected while the
      // replacement session (the flow's `sessionFallback`) binds.
      await client.checkpoint(firstId);
      secondId = (await client.createSession(CREATE_PAYLOAD)).hostSessionId;
    } finally {
      await release();
    }

    await expect
      .poll(async () => (await incarnation(secondId)).state, {
        timeout: 60_000,
      })
      .toBe("active");
    // Moving the superseded row back into `checkpointed` would re-enter the
    // partial unique set beside the live replacement: a permanent poison.
    expect((await incarnation(firstId)).state).toBe("lost");
    expect(await lifecycleConsumerState(runId)).not.toBe("poisoned");
  }, 180_000);

  it("A3-paused: an owner paused for input still owns its session — session.created activates the row instead of losing it", async () => {
    // Review finding: the projector re-asked the CREATE question ("may this
    // owner open a session now?"), which a permission pause answers no, and
    // marked a live, admitted session `lost`. An acknowledgement asks whether
    // the session is still the owner's.
    const runId = await seedFlowRun("a3-paused");
    const client = await hosts.forRun(runId, { reason: "launch" });
    const [attempt] = (await db
      .insert(schema.nodeAttempts)
      .values({
        id: randomUUID(),
        runId,
        nodeId: "s1",
        nodeType: "ai_coding",
        attempt: 1,
        status: "Running",
        executionAssignmentId: client.assignment.id,
        actionPromptOrdinal: 0,
        startedAt: new Date(),
      })
      .returning({ id: schema.nodeAttempts.id })) as Array<{ id: string }>;

    await db
      .update(schema.runs)
      .set({ currentStepId: "s1" })
      .where(eq(schema.runs.id, runId));
    const release = await holdProjection(testDatabase.pool, {
      consumerName: CANONICAL_PROJECTION_CONSUMERS.lifecycle,
      runId,
    });
    let hostSessionId: string;

    try {
      const session = await client.createOwnedSession(
        { variant: "node", nodeAttemptId: attempt.id, promptOrdinal: 0 },
        async () => ({ ...CREATE_PAYLOAD, nodeAttemptId: attempt.id }),
      );

      hostSessionId = session.hostSessionId;
      expect((await incarnation(hostSessionId)).state).toBe("created");
      // The agent asked for permission before the projector reached the
      // session's canonical `session.created`: run and attempt both park.
      await db
        .update(schema.runs)
        .set({ status: "NeedsInput" })
        .where(eq(schema.runs.id, runId));
      await db
        .update(schema.nodeAttempts)
        .set({ status: "NeedsInput" })
        .where(eq(schema.nodeAttempts.id, attempt.id));
    } finally {
      await release();
    }

    await expect
      .poll(async () => (await incarnation(hostSessionId)).state, {
        timeout: 60_000,
      })
      .toBe("active");
    expect((await incarnation(hostSessionId)).terminalReason).toBeNull();
    expect(await lifecycleConsumerState(runId)).not.toBe("poisoned");
  }, 180_000);

  it("A3: a stale session.created moves the ACK-authored row created → lost, and a prompt against it is fenced", async () => {
    const runId = await seedFlowRun("a3-stale-create");
    const client = await hosts.forRun(runId, { reason: "launch" });
    const [attempt] = (await db
      .insert(schema.nodeAttempts)
      .values({
        id: randomUUID(),
        runId,
        nodeId: "s1",
        nodeType: "ai_coding",
        attempt: 1,
        status: "Running",
        executionAssignmentId: client.assignment.id,
        actionPromptOrdinal: 0,
        startedAt: new Date(),
      })
      .returning({ id: schema.nodeAttempts.id })) as Array<{ id: string }>;

    await db
      .update(schema.runs)
      .set({ currentStepId: "s1" })
      .where(eq(schema.runs.id, runId));
    const release = await holdProjection(testDatabase.pool, {
      consumerName: CANONICAL_PROJECTION_CONSUMERS.lifecycle,
      runId,
    });
    let hostSessionId: string;

    try {
      const session = await client.createOwnedSession(
        { variant: "node", nodeAttemptId: attempt.id, promptOrdinal: 0 },
        async () => ({ ...CREATE_PAYLOAD, nodeAttemptId: attempt.id }),
      );

      hostSessionId = session.hostSessionId;
      expect((await incarnation(hostSessionId)).state).toBe("created");
      // The create's owner stops being current before its canonical event is
      // projected, so the projector's own ACK application answers `stale`.
      await db
        .update(schema.nodeAttempts)
        .set({ status: "Failed", endedAt: new Date() })
        .where(eq(schema.nodeAttempts.id, attempt.id));
    } finally {
      await release();
    }

    await expect
      .poll(async () => (await incarnation(hostSessionId)).state, {
        timeout: 60_000,
      })
      .toBe("lost");
    expect((await incarnation(hostSessionId)).terminalReason).toEqual({
      reason: "create_owner_superseded",
    });
    expect(
      await db
        .select()
        .from(schema.runSessionIncarnations)
        .where(eq(schema.runSessionIncarnations.hostSessionId, hostSessionId)),
    ).toHaveLength(1);
    await expect(
      waitForPromptIncarnation(db, client, hostSessionId),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) && err.details?.reason === "assignment_fenced",
    );
  }, 180_000);
});

// ADR-184 end to end: the REAL host prunes the ACKed prefix of an open
// prompt's span under retained pressure while the manager keeps up, then the
// turn's terminal frame is held (the manager falls behind for the tail only)
// and the stream is declared lost. Before ADR-184 the host kept the whole span
// (the span stop), and the manager read every span from `accepted − 1`, so
// pruning inside it would have turned this turn into a `stream-lost` crash.
// The stream-lost resolver must settle it from the pager instead: the prefix
// canonically, the tail from the host.
import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { SupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  executionCommands,
  executionEvents,
  executionEventStreams,
  runs,
} from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { resolvePromptEvidence } from "@/lib/reconcile-evidence-db";
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
import { seedNodePromptOwner } from "@/test-support/prompt-owner-fixture";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";
import { startSupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

let database: StartedPostgresTestDb;
let db: Db;
let supervisor: RealSupervisor;
let proxy: SupervisorFaultProxy;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "eh_prompt_span_prune",
  });
  db = database.db as unknown as Db;
  // Tiny row budgets: the turn's own output crosses soft, so the host runs
  // retained-pressure passes over its ACKed rows while the turn is open.
  supervisor = await startRealSupervisor({
    fixtureArgs: ["--hang"],
    env: {
      MAISTER_EVENT_OUTBOX_LOW_ROWS: "50",
      MAISTER_EVENT_OUTBOX_SOFT_ROWS: "100",
      MAISTER_EVENT_OUTBOX_HARD_ROWS: "5000",
    },
  });
  proxy = await startSupervisorFaultProxy(supervisor.url);
  restoreUrl = useRealSupervisorUrl(proxy.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  worker = startProjectionWorker({ db, projectors: canonicalProjectors });
}, 180_000);

afterAll(async () => {
  await stopRuntimeEventConsumers();
  restoreUrl();
  await worker?.stop();
  await proxy?.close();
  await supervisor?.kill();
  await database?.stop();
});

/** The host's replay floor, read from its own store. */
function hostFloor(): bigint | null {
  const state = new DatabaseSync(
    path.join(supervisor.stateDir, "state.sqlite"),
    { readOnly: true },
  );

  try {
    state.exec("PRAGMA busy_timeout = 5000");
    const row = state
      .prepare("SELECT replay_floor_sequence FROM runtime_event_streams")
      .get() as { replay_floor_sequence: string | null } | undefined;

    return row?.replay_floor_sequence == null
      ? null
      : BigInt(row.replay_floor_sequence);
  } finally {
    state.close();
  }
}

/** The canonical accepted row of a prompt, once ingested. */
async function acceptedSequence(
  runId: string,
  commandId: string,
): Promise<bigint | null> {
  const [row] = await db
    .select({ sequence: executionEvents.hostSequence })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.runId, runId),
        eq(executionEvents.eventType, "session.command"),
        sql`${executionEvents.payload}->>'commandId' = ${commandId}`,
        sql`${executionEvents.payload}->>'phase' = 'accepted'`,
      ),
    );

  return row?.sequence ?? null;
}

async function command(commandId: string) {
  const [row] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, commandId));

  if (!row) throw new Error(`command ${commandId} is gone`);

  return row;
}

describe("a span whose ACKed prefix the real host pruned (ADR-184)", () => {
  it("the stream-lost resolver settles the turn from the pager: prefix canonical, tail from the host", async () => {
    const repoPath = await initRepo(
      `${supervisor.runtimeRoot}/repo-${randomUUID()}`,
    );
    const project = await seedProjectRow(database.db, { repoPath });
    const runId = await seedRun(database.db, {
      projectId: project.id,
      status: "Running",
      runKind: "flow",
    });

    await seedWorkspace(database.db, {
      runId,
      projectId: project.id,
      worktreePath: await addWorktree(
        repoPath,
        `${supervisor.runtimeRoot}/wt-${randomUUID()}`,
        `maister/prune-${randomUUID().slice(0, 6)}`,
      ),
      parentRepoPath: repoPath,
    });
    await db
      .update(runs)
      .set({ currentStepId: "s1" })
      .where(eq(runs.id, runId));
    const transport = createLocalDirectTransport();
    const hosts = createExecutionHosts({ db });
    const { client } = await hosts.executionFor(runId, { reason: "launch" });
    const session = await client.createSession({
      stepId: "s1",
      executor: { agent: "claude", model: "mock" },
    });
    // 400 one-byte chunks — several times the soft budget — then a pause long
    // enough to watch the prune pass the accepted row before the terminal.
    const handle = await client.prompt(
      session.hostSessionId,
      {
        stepId: "s1",
        prompt:
          'fixture-output:{"bytes":400,"chunkSize":1,"terminalDelayMs":6000}',
      },
      {
        admitOwner: await seedNodePromptOwner(
          db,
          client,
          session.hostSessionId,
        ),
      },
    );

    await expect
      .poll(() => acceptedSequence(runId, handle.commandId), {
        timeout: 30_000,
        interval: 50,
      })
      .not.toBeNull();
    const accepted = (await acceptedSequence(runId, handle.commandId))!;
    // From here the terminal frame is held: the manager falls behind for the
    // tail of the turn only.
    const held = proxy.arm(
      {
        caseId: "prune-open-span",
        method: "GET",
        path: /^\/runtime-events$/,
        eventType: "session.command",
      },
      "hold-events",
    );

    try {
      // The host prunes past the open prompt's accepted row.
      await expect
        .poll(() => hostFloor() ?? -1n, { timeout: 30_000, interval: 100 })
        .toBeGreaterThanOrEqual(accepted);
      await expect
        .poll(
          async () =>
            (await transport.getCommandReceipt(handle.commandId))?.phase,
          { timeout: 30_000, interval: 100 },
        )
        .toBe("completed");
      const terminal = BigInt(
        (await transport.getCommandReceipt(handle.commandId))!.evidenceV2!
          .terminal!.sequence,
      );
      const [stream] = await db
        .select()
        .from(executionEventStreams)
        .where(
          eq(
            executionEventStreams.executionHostId,
            (await command(handle.commandId)).executionHostId,
          ),
        );

      // The shape before ADR-184 could not read: a floor inside the span, a
      // frontier inside it too, the terminal only on the host.
      expect(stream!.lastContiguousSequence).not.toBeNull();
      expect(stream!.lastContiguousSequence!).toBeGreaterThanOrEqual(accepted);
      expect(stream!.lastContiguousSequence!).toBeLessThan(terminal);
      expect(hostFloor()!).toBeLessThanOrEqual(stream!.lastContiguousSequence!);

      await db
        .update(executionEventStreams)
        .set({ state: "lost" })
        .where(eq(executionEventStreams.id, stream!.id));
      expect(
        await resolvePromptEvidence(db, transport, { runId, nodeId: "s1" }),
      ).toMatchObject({
        evidence: "pending_application",
        streamLost: true,
        commandId: handle.commandId,
      });
      expect(await command(handle.commandId)).toMatchObject({
        state: "succeeded",
        settledFrom: "host_span",
        terminalEventId: null,
        hostSpanVerdict: null,
      });
    } finally {
      try {
        held.release();
      } catch {
        // Never reached, or already released.
      }
    }
  }, 240_000);
});

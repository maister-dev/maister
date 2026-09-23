// ADR-167 D5 amendment (2026-09-23) — B.5: a finished turn settles from the
// host's own verified event span while the manager has not ingested it. The
// lag is real: a fault proxy between the manager and a real supervisor holds
// the command's `session.command` frames on the shared event stream, so the
// accepted and terminal events are neither ingested nor bindable, and the
// contiguous frontier stays behind the turn.
import type { Db } from "@/lib/execution-host/db";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { SupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  executionCommands,
  executionEventConsumers,
  executionEvents,
  runs,
} from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { CANONICAL_PROJECTION_CONSUMERS } from "@/lib/execution-host/events/projection-consumers";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { runFlow } from "@/lib/flows/runner";
import {
  seedProjectRow,
  seedRun,
  seedWorkspace,
} from "@/test-support/execution-host-seed";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import { seedGraphRun } from "@/test-support/graph-run-seed";
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
import { startSupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

let database: StartedPostgresTestDb;
let db: Db;
let supervisor: RealSupervisor;
let proxy: SupervisorFaultProxy;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "eh_prompt_host_span",
  });
  db = database.db as unknown as Db;
  // A real adapter outlives its turn (see prompt-host-settlement).
  supervisor = await startRealSupervisor({ fixtureArgs: ["--hang"] });
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

/** Hold every `session.command` frame of the shared stream until released. */
function holdCommandFrames(caseId: string) {
  return proxy.arm(
    {
      caseId,
      method: "GET",
      path: /^\/runtime-events$/,
      eventType: "session.command",
    },
    "hold-events",
  );
}

/** A barrier refuses a second release, or one it never reached; cleanup
 * must not mask the case's own verdict. */
function settle(barrier: { release(): void }): void {
  try {
    barrier.release();
  } catch {
    // Already released, or never reached.
  }
}

function dropSpanReads(caseId: string) {
  return proxy.arm(
    // The witness path is the raw request URL, query string included.
    { caseId, method: "GET", path: /^\/runtime-events\/span\?/ },
    "drop-responses",
  );
}

function holdPrompts(runId: string) {
  return holdProjection(database.pool, {
    consumerName: CANONICAL_PROJECTION_CONSUMERS.prompt,
    runId,
  });
}

async function promptCursor(runId: string): Promise<bigint | null> {
  const [row] = await db
    .select({ last: executionEventConsumers.lastRunSequence })
    .from(executionEventConsumers)
    .where(
      and(
        eq(
          executionEventConsumers.consumerName,
          CANONICAL_PROJECTION_CONSUMERS.prompt,
        ),
        eq(executionEventConsumers.runId, runId),
      ),
    );

  return row?.last ?? null;
}

async function terminalRunSequence(eventId: string): Promise<bigint> {
  const [event] = await db
    .select({ runSequence: executionEvents.runSequence })
    .from(executionEvents)
    .where(eq(executionEvents.id, eventId));

  if (event?.runSequence == null)
    throw new Error(`terminal event ${eventId} is not ingested`);

  return event.runSequence;
}

async function promptCommand(runId: string) {
  const [command] = await db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, runId),
        eq(executionCommands.kind, "session.prompt"),
      ),
    );

  if (!command) throw new Error(`no prompt command for run ${runId}`);

  return command;
}

async function runStatus(runId: string) {
  return (
    await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
  )[0]?.status;
}

async function seedSingleNodeFlow(prompt: string) {
  const name = randomUUID();
  const repoPath = await initRepo(`${supervisor.runtimeRoot}/repo-${name}`);
  const worktreePath = await addWorktree(
    repoPath,
    `${supervisor.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );

  return seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "host-span",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "ai_coding",
          action: { prompt },
          transitions: { success: "done" },
        },
      ] as FlowYamlV1["nodes"],
    },
    {
      repoPath,
      flowRevision: true,
      workspace: {
        worktreePath,
        parentRepoPath: repoPath,
        branch: `maister/${name}`,
      },
    },
  );
}

describe("direct terminal binding (B.4) on the real supervisor", () => {
  it("B1: a completed turn settles from its ingested terminal event while the prompt projector is held, and the projector later confirms idempotently", async () => {
    const { runId } = await seedSingleNodeFlow(
      'fixture-output:{"bytes":0,"text":"bound directly"}',
    );
    // Only the direct binding may settle: the host span is unreadable and the
    // prompt projector is held while ingest keeps running.
    const noSpan = dropSpanReads("B1");
    const release = await holdPrompts(runId);
    let flow: Promise<void> | null = null;

    try {
      flow = runFlow(runId, {
        db: database.db,
        runtimeRoot: supervisor.runtimeRoot,
        executionHosts: createExecutionHosts({ db }),
      });
      await expect
        .poll(
          async () =>
            (
              await db
                .select({ status: runs.status })
                .from(runs)
                .where(eq(runs.id, runId))
            )[0]?.status,
          { timeout: 90_000, interval: 250 },
        )
        .toBe("Review");
      await flow;

      const settled = await promptCommand(runId);
      const receiptEventId = settled.receiptEvidence?.eventId;

      expect(receiptEventId).toBeTruthy();
      expect(settled).toMatchObject({
        terminalEventId: receiptEventId,
        settledFrom: "canonical",
        applicationState: "applied",
        applicationError: null,
      });
      expect(settled.completionAppliedAt).toBeInstanceOf(Date);
      // The held projector never reached the terminal event.
      const terminal = await terminalRunSequence(receiptEventId!);
      const cursor = await promptCursor(runId);

      expect(cursor === null || cursor < terminal).toBe(true);

      await release();
      await expect
        .poll(async () => (await promptCursor(runId)) ?? -1n, {
          timeout: 60_000,
        })
        .toBeGreaterThanOrEqual(terminal);
      expect(await promptCommand(runId)).toMatchObject({
        terminalEventId: receiptEventId,
        terminalEvidenceSha256: settled.terminalEvidenceSha256,
        settledFrom: "canonical",
        applicationState: "applied",
        applicationError: null,
        completionAppliedAt: settled.completionAppliedAt,
      });
    } finally {
      // The direct binding may win before any span read; reach the rule so
      // the proxy drains either way.
      if (noSpan.observations.length === 0)
        await fetch(
          `${proxy.url}/runtime-events/span?streamId=${randomUUID()}&after=0&through=1`,
        ).catch(() => undefined);
      settle(noSpan);
      await release();
      await flow?.catch(() => undefined);
    }
  }, 240_000);

  it("B1-signal: a turn whose span carries a permission request is left to the prompt projector", async () => {
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
        `maister/signal-${randomUUID().slice(0, 6)}`,
      ),
      parentRepoPath: repoPath,
    });
    const hosts = createExecutionHosts({ db });
    const { client, admin } = await hosts.executionFor(runId, {
      reason: "launch",
    });
    const release = await holdPrompts(runId);

    try {
      const session = await client.createSession({
        stepId: "s1",
        executor: { agent: "claude", model: "mock" },
      });
      const handle = await client.prompt(
        session.hostSessionId,
        {
          stepId: "s1",
          prompt:
            'fixture-output:{"bytes":0,"permission":true,"text":"answered"}',
        },
        {
          admitOwner: await seedNodePromptOwner(
            db,
            client,
            session.hostSessionId,
          ),
        },
      );
      const watch = new AbortController();

      // Answer the live permission the way an operator's response would.
      for await (const event of admin.streamSession(session.hostSessionId, {
        signal: watch.signal,
      })) {
        if (event.type !== "session.permission_request") continue;
        await client.deliverInput(session.hostSessionId, {
          kind: "permission",
          action: "select",
          requestId: event.requestId,
          optionId: "allow",
        });
        watch.abort();
        break;
      }

      // The turn completes and its terminal event is ingested, yet only the
      // (held) projector may settle a span that carries a consumer signal.
      await expect(
        client.waitForPrompt(handle, { signal: AbortSignal.timeout(15_000) }),
      ).rejects.toThrow();
      const waiting = await promptCommand(runId);

      expect(waiting.receiptEvidence?.phase).toBe("completed");
      await terminalRunSequence(waiting.receiptEvidence!.eventId!);
      expect(waiting).toMatchObject({
        terminalEventId: null,
        terminalEvidenceSha256: null,
        settledFrom: null,
      });

      await release();
      expect(
        (
          await client.waitForPrompt(handle, {
            signal: AbortSignal.timeout(60_000),
          })
        ).stopReason,
      ).toBe("end_turn");
      expect(await promptCommand(runId)).toMatchObject({
        terminalEventId: waiting.receiptEvidence!.eventId,
        settledFrom: "canonical",
      });
    } finally {
      await release();
    }
  }, 240_000);
});

describe("host-span settlement (B.5) on the real supervisor", () => {
  it("B2: a completed turn settles from the host span while its events are held, the node advances, and the canonical event later confirms without a second application", async () => {
    const { runId } = await seedSingleNodeFlow(
      'fixture-output:{"bytes":0,"text":"from the host span"}',
    );
    const held = holdCommandFrames("B2");
    let flow: Promise<void> | null = null;

    try {
      flow = runFlow(runId, {
        db: database.db,
        runtimeRoot: supervisor.runtimeRoot,
        executionHosts: createExecutionHosts({ db }),
      });
      await expect
        .poll(() => runStatus(runId), { timeout: 90_000, interval: 250 })
        .toBe("Review");
      await flow;
      const settled = await promptCommand(runId);

      // Nothing of the turn's command frames reached the manager.
      expect(held.observations.length).toBeGreaterThanOrEqual(2);
      expect(settled).toMatchObject({
        state: "succeeded",
        settledFrom: "host_span",
        terminalEventId: null,
        applicationState: "applied",
        applicationError: null,
      });
      expect(settled.completionAppliedAt).toBeInstanceOf(Date);

      held.release();
      await expect
        .poll(async () => (await promptCommand(runId)).terminalEventId, {
          timeout: 60_000,
        })
        .toBe(settled.receiptEvidence?.eventId);
      expect(await promptCommand(runId)).toMatchObject({
        terminalEvidenceSha256: settled.terminalEvidenceSha256,
        settledFrom: "host_span",
        applicationState: "applied",
        applicationError: null,
        completionAppliedAt: settled.completionAppliedAt,
      });
    } finally {
      settle(held);
      await flow?.catch(() => undefined);
    }
  }, 240_000);

  it("B7: a span carrying a permission request is never settled from the host; it settles canonically once the frames arrive", async () => {
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
        `maister/b7-${randomUUID().slice(0, 6)}`,
      ),
      parentRepoPath: repoPath,
    });
    const client = await createExecutionHosts({ db }).forRun(runId, {
      reason: "launch",
    });
    const session = await client.createSession({
      stepId: "s1",
      executor: { agent: "claude", model: "mock" },
    });
    const held = holdCommandFrames("B7");

    try {
      const handle = await client.prompt(
        session.hostSessionId,
        {
          stepId: "s1",
          prompt:
            'fixture-output:{"bytes":0,"permission":true,"text":"answered"}',
        },
        {
          admitOwner: await seedNodePromptOwner(
            db,
            client,
            session.hostSessionId,
          ),
        },
      );
      // The request is stored behind the held accepted frame (`pending_gap`),
      // so no canonical stream yields it; answer it from the stored row.
      let requestId: string | undefined;

      await expect
        .poll(
          async () => {
            const [row] = await db
              .select({ payload: executionEvents.payload })
              .from(executionEvents)
              .where(
                and(
                  eq(executionEvents.runId, runId),
                  eq(executionEvents.eventType, "session.permission_request"),
                ),
              );

            requestId = row?.payload?.requestId as string | undefined;

            return requestId;
          },
          { timeout: 30_000 },
        )
        .toBeTruthy();
      await client.deliverInput(session.hostSessionId, {
        kind: "permission",
        action: "select",
        requestId: requestId!,
        optionId: "allow",
      });
      await expect(
        client.waitForPrompt(handle, { signal: AbortSignal.timeout(15_000) }),
      ).rejects.toThrow();
      expect(await promptCommand(runId)).toMatchObject({
        terminalEvidenceSha256: null,
        settledFrom: null,
      });
      expect(
        (await promptCommand(runId)).receiptEvidence?.evidenceV2?.phase,
      ).toBe("completed");

      held.release();
      expect(
        (
          await client.waitForPrompt(handle, {
            signal: AbortSignal.timeout(60_000),
          })
        ).stopReason,
      ).toBe("end_turn");
      expect(await promptCommand(runId)).toMatchObject({
        settledFrom: "canonical",
      });
    } finally {
      settle(held);
    }
  }, 240_000);
});

// ADR-167 D5 amendment (2026-09-23) — a finished turn settles on host evidence
// instead of waiting behind the prompt projector. Every case holds the canonical
// PROMPT projector for its run while ingest keeps running, so the projector
// cannot be the writer of what is asserted before the release.
import type { Db } from "@/lib/execution-host/db";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { RealSupervisor } from "@/test-support/real-supervisor";

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

let database: StartedPostgresTestDb;
let db: Db;
let supervisor: RealSupervisor;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "eh_prompt_host_settlement",
  });
  db = database.db as unknown as Db;
  // A real adapter outlives its turn; the default fixture exits 10 ms after
  // each one, and that `session.exited` can land inside the turn's own span —
  // a consumer signal that correctly keeps the turn on the canonical path.
  supervisor = await startRealSupervisor({ fixtureArgs: ["--hang"] });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  worker = startProjectionWorker({ db, projectors: canonicalProjectors });
}, 180_000);

afterAll(async () => {
  await stopRuntimeEventConsumers();
  restoreUrl();
  await worker?.stop();
  await supervisor?.kill();
  await database?.stop();
});

function holdPrompts(runId: string) {
  return holdProjection(database.pool, {
    consumerName: CANONICAL_PROJECTION_CONSUMERS.prompt,
    runId,
  });
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

async function seedSingleNodeFlow() {
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
      name: "host-settlement",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "ai_coding",
          action: { prompt: "hello" },
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

describe("direct terminal binding (B.4)", () => {
  it("B1: a completed turn settles from its ingested terminal event while the prompt projector is held, and the projector later confirms idempotently", async () => {
    const { runId } = await seedSingleNodeFlow();
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

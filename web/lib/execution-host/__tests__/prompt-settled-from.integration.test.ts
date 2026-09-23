// ADR-167 D5 amendment (2026-09-23), migration 0176. `settled_from` records the
// evidence feed that first settled a prompt, and a `host_span` settlement may
// hold its digest before the canonical terminal event is bound. Each case names
// the database guard that must accept or refuse the shape. One real settled
// prompt supplies a row every CHECK and FK already accepts; shapes that no code
// path can produce yet (a pre-0176 row, a host-span row) are seeded with
// triggers suspended, because the row guards under test are CHECKs and those
// still run. The trigger cases run with triggers on.

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executionCommands } from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
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
import { seedNodePromptOwner } from "@/test-support/prompt-owner-fixture";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

let testDatabase: StartedPostgresTestDb;
let projectionWorker: ProjectionWorker;
let db: Db;
let sup: RealSupervisor;
let restoreUrl: () => void = () => {};
let hosts: ExecutionHosts;
let createId: string;
let promptId: string;
let terminalEventId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_prompt_settled_from_test",
  });
  db = testDatabase.db as unknown as Db;
  sup = await startRealSupervisor();
  restoreUrl = useRealSupervisorUrl(sup.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  hosts = createExecutionHosts({ db });
  projectionWorker = startProjectionWorker({
    db,
    projectors: canonicalProjectors,
  });

  const project = await seedProjectRow(testDatabase.db, {
    repoPath: await initRepo(`${sup.runtimeRoot}/repo`),
  });
  const runId = await seedRun(testDatabase.db, {
    projectId: project.id,
    status: "Running",
    runKind: "flow",
  });

  await seedWorkspace(testDatabase.db, {
    runId,
    projectId: project.id,
    worktreePath: await addWorktree(
      project.repoPath,
      `${sup.runtimeRoot}/wt`,
      `maister/settled-from-${randomUUID().slice(0, 6)}`,
    ),
    parentRepoPath: project.repoPath,
  });
  const client = await hosts.forRun(runId, { reason: "launch" });
  const session = await client.createSession({
    stepId: "s1",
    executor: { agent: "claude", model: "mock" },
  });
  const handle = await client.prompt(
    session.hostSessionId,
    { stepId: "s1", prompt: "hello" },
    {
      admitOwner: await seedNodePromptOwner(db, client, session.hostSessionId),
    },
  );

  await client.waitForPrompt(handle, { signal: AbortSignal.timeout(60_000) });
  const [prompt] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, handle.commandId));
  const [create] = await db
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, runId),
        eq(executionCommands.kind, "session.create"),
      ),
    );

  if (!prompt?.terminalEvidenceSha256 || !prompt.terminalEventId || !create)
    throw new Error("the fixture prompt did not settle canonically");
  promptId = prompt.id;
  terminalEventId = prompt.terminalEventId;
  createId = create.id;
}, 240_000);

afterAll(async () => {
  restoreUrl();
  await stopRuntimeEventConsumers();
  await projectionWorker?.stop();
  await sup?.stop();
  await testDatabase?.stop();
});

/** The constraint that refused the UPDATE, or null when it was accepted. */
async function refusedBy(
  set: string,
  id: string,
  opts: { suspendTriggers?: boolean } = {},
): Promise<string | null> {
  const client = await testDatabase.pool.connect();

  try {
    await client.query("BEGIN");
    if (opts.suspendTriggers)
      await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`UPDATE execution_commands SET ${set} WHERE id = $1`, [
      id,
    ]);
    await client.query("COMMIT");

    return null;
  } catch (error) {
    await client.query("ROLLBACK");

    return (error as { constraint?: string }).constraint ?? String(error);
  } finally {
    client.release();
  }
}

describe("execution_commands.settled_from guards (migration 0176)", () => {
  it("records the feed only on a settled prompt, and only a known feed", async () => {
    expect(await refusedBy("settled_from = 'host_span'", createId)).toBe(
      "execution_commands_settled_from_check",
    );
    // Pre-0176 history: a settled row with no recorded feed stays valid.
    expect(
      await refusedBy("settled_from = NULL", promptId, {
        suspendTriggers: true,
      }),
    ).toBeNull();
    expect(await refusedBy("settled_from = 'bogus'", promptId)).toBe(
      "execution_commands_settled_from_check",
    );
  });

  it("lets only a host-span settlement hold its digest before the terminal event is bound", async () => {
    for (const feed of ["NULL", "'canonical'"])
      expect(
        await refusedBy(
          `settled_from = ${feed}, terminal_event_id = NULL`,
          promptId,
          { suspendTriggers: true },
        ),
      ).toBe("execution_commands_terminal_evidence_check");
    expect(
      await refusedBy(
        "settled_from = 'host_span', terminal_event_id = NULL",
        promptId,
        { suspendTriggers: true },
      ),
    ).toBeNull();
    // The canonical confirmation binds the event with every frozen column equal.
    expect(
      await refusedBy(`terminal_event_id = '${terminalEventId}'`, promptId),
    ).toBeNull();
  });

  it("keeps the recorded feed and the settled outcome immutable", async () => {
    const [row] = await db
      .select({ settledFrom: executionCommands.settledFrom })
      .from(executionCommands)
      .where(eq(executionCommands.id, promptId));

    expect(row?.settledFrom).toBe("host_span");
    for (const set of [
      "settled_from = 'canonical'",
      "settled_from = NULL",
      `result = '{"stopReason":"cancelled"}'::jsonb`,
    ])
      expect(await refusedBy(set, promptId)).toBe(
        "execution_commands_immutable_terminal_evidence",
      );
  });
});

import type { ExecutionCommand } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { FakeExecutionHost } from "@/test-support/fake-execution-host";
import type { PromptResult } from "@/lib/supervisor-client";

import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { startAgentSession } from "@/lib/agents/launch";
import { assertAgentExecutionQuiescent } from "@/lib/agents/execution-quiescence";
import { stopAgentPromptSession } from "@/lib/agents/prompt-owner";
import {
  executionAssignments,
  executionCommands,
  runSessionIncarnations,
  runs,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { PromptOwnerSchema } from "@/lib/execution-host/prompt-owner-contract";
import { countLiveRuns } from "@/lib/scheduler";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { mkdtempReal } from "@/test-support/worktree-test-root";

let database: StartedPostgresTestDb;
let db: Db;
let runtimeRoot: string;
let fake: FakeExecutionHost;
let hosts: ExecutionHosts;
const previousWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
const previousRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const definition = `---\nname: Researcher\ndescription: d\nworkspace: none\nmode: session\nplatform_mcp: false\ntriggers:\n  - manual\nrisk_tier: read_only\n---\nResearch the repository\n`;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_application_quiescence",
  });
  db = database.db as unknown as Db;
  runtimeRoot = await mkdtempReal("agent-application-quiescence-");
  process.env.MAISTER_WORKTREES_ROOT = join(runtimeRoot, "worktrees");
  process.env.MAISTER_RUNTIME_ROOT = join(runtimeRoot, "manager");
}, 180_000);

beforeEach(async () => {
  fake = createFakeExecutionHost();
  fake.setPromptBehavior(() => new Promise(() => {}));
  ({ hosts } = await fakeExecutionHosts(db, { fake }));
});

afterEach(async () => {
  await fake.releaseIngest();
  await fake.waitForCanonicalEvents();
  await stopRuntimeEventConsumers();
});

afterAll(async () => {
  if (previousWorktreesRoot === undefined)
    delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = previousWorktreesRoot;
  if (previousRuntimeRoot === undefined)
    delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = previousRuntimeRoot;
  await database?.stop();
});

async function detachedPrompt(): Promise<ExecutionCommand> {
  const runId = await seedAgentRun(db, {
    runtimeRoot,
    definition,
    workspace: "none",
    resultContract: null,
  });
  const controller = new AbortController();
  const driving = startAgentSession(runId, {
    db,
    executionHosts: hosts,
    signal: controller.signal,
  });

  await expect
    .poll(
      async () => {
        const [command] = await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );

        return command?.state;
      },
      { timeout: 30_000, interval: 25 },
    )
    .toBe("accepted");
  controller.abort();
  await driving;
  const [command] = await db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, runId),
        eq(executionCommands.kind, "session.prompt"),
      ),
    );

  return command;
}

async function completedDetachedPrompt(): Promise<ExecutionCommand> {
  let complete: ((result: PromptResult) => void) | undefined;

  fake.setPromptBehavior(
    () =>
      new Promise<PromptResult>((resolve) => {
        complete = resolve;
      }),
  );
  const command = await detachedPrompt();

  expect(complete).toBeDefined();
  complete!({ stopReason: "end_turn", meta: null });
  await fake.waitForCanonicalEvents();
  const [completed] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, command.id));

  expect(completed).toMatchObject({
    state: "succeeded",
    completionAppliedAt: null,
  });

  return completed;
}

function stopOriginalSession(command: ExecutionCommand): Promise<void> {
  const owner = PromptOwnerSchema.parse({
    kind: command.ownerKind,
    ref: command.ownerRef,
  });

  if (owner.kind !== "agent_turn" || owner.ref.variant !== "initial")
    throw new Error("fixture requires an initial agent prompt");

  return stopAgentPromptSession(
    db,
    owner.ref,
    command.targetSessionId,
    command.id,
    AbortSignal.timeout(5_000),
  );
}

async function expectSlotRetained(
  command: ExecutionCommand,
  occupied: number,
): Promise<void> {
  expect(
    await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, command.runId)),
  ).toEqual([{ status: "Running" }]);
  expect(
    await db
      .select({ state: executionAssignments.state })
      .from(executionAssignments)
      .where(eq(executionAssignments.id, command.executionAssignmentId)),
  ).toEqual([{ state: "active" }]);
  expect(await countLiveRuns(db as never, "agent")).toBe(occupied);
}

describe("agent application quiescence", () => {
  it("reuses a successful delete while canonical teardown is delayed, then catches up", async () => {
    const command = await completedDetachedPrompt();
    const occupied = await countLiveRuns(db as never, "agent");

    fake.holdIngest();
    await expect(stopOriginalSession(command)).rejects.toMatchObject({
      details: { causeCode: "agent_session_teardown_pending" },
    });
    await expect(stopOriginalSession(command)).rejects.toMatchObject({
      details: { causeCode: "agent_session_teardown_pending" },
    });
    expect(fake.callsOf("deleteSession")).toHaveLength(1);
    expect(
      await db
        .select({ state: executionCommands.state })
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, command.runId),
            eq(executionCommands.kind, "session.delete"),
          ),
        ),
    ).toEqual([{ state: "succeeded" }]);
    await expectSlotRetained(command, occupied);
    await fake.releaseIngest();
    await expect(stopOriginalSession(command)).resolves.toBeUndefined();
    expect(fake.callsOf("deleteSession")).toHaveLength(1);
    expect(
      await db
        .select({ state: runSessionIncarnations.state })
        .from(runSessionIncarnations)
        .where(eq(runSessionIncarnations.runId, command.runId)),
    ).toEqual([{ state: "exited" }]);
  });

  it("an absent host session and successful delete do not release an unconfirmed execution", async () => {
    const command = await detachedPrompt();
    const occupied = await countLiveRuns(db as never, "agent");
    const session = fake.sessions.get(command.targetSessionId!);

    expect(session).toBeDefined();
    try {
      fake.sessions.delete(command.targetSessionId!);
      await expect(stopOriginalSession(command)).rejects.toMatchObject({
        details: { causeCode: "agent_session_teardown_pending" },
      });
      await expect(
        assertAgentExecutionQuiescent(db, {
          id: command.runId,
          executionAssignmentId: command.executionAssignmentId,
        }),
      ).rejects.toMatchObject({
        details: { reason: "agent_execution_quiescence_unproven" },
      });
      await expectSlotRetained(command, occupied);
    } finally {
      // Restore the host fixture so its pending promise can be stopped and
      // drained; the assertions above deliberately observed no exit event.
      fake.sessions.set(command.targetSessionId!, session!);
      const client = await hosts.forAssignment({
        id: command.executionAssignmentId,
      });

      await client.deleteSession(command.targetSessionId!);
    }
  });

  it("failed teardown keeps the run and assignment live until a safe retry", async () => {
    const command = await detachedPrompt();
    const occupied = await countLiveRuns(db as never, "agent");

    fake.failOnce(
      "deleteSession",
      new MaisterError("EXECUTOR_UNAVAILABLE", "fixture teardown unavailable", {
        details: { reason: "fixture_teardown_unavailable" },
      }),
    );
    await expect(stopOriginalSession(command)).rejects.toMatchObject({
      details: { reason: "fixture_teardown_unavailable" },
    });
    await expectSlotRetained(command, occupied);
    await expect(
      assertAgentExecutionQuiescent(db, {
        id: command.runId,
        executionAssignmentId: command.executionAssignmentId,
      }),
    ).rejects.toMatchObject({
      details: { reason: "agent_execution_quiescence_unproven" },
    });
    await expect(stopOriginalSession(command)).resolves.toBeUndefined();
  });
});

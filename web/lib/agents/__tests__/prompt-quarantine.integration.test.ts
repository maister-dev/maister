// ADR-184 amendment 2026-09-28 — an agent turn whose prompt is quarantined
// while still `accepted` (no terminal evidence: its terminal was a
// `payload_unstorable` skip, or its receipt disagreed) has no writer left: no
// feed will ever settle it, and the owner application never runs. The agent
// driver that meets the quarantine ends the run `Crashed`, reason
// `owner_poisoned`, and stops its session — whether it is the driver that
// issued the prompt or one that re-drives it after a restart.
//
// The quarantine is seeded as the reducer leaves it (the reducer's own
// quarantine is proven in `commands` and `prompt-host-span-fake`): a real
// host-span race would decide the ordering here instead of the owner.
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { FakeExecutionHost } from "@/test-support/fake-execution-host";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import {
  agentTurns,
  domainEvents,
  executionCommands,
  runs,
} from "@/lib/db/schema";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: Db;
let runtimeRoot: string;
let fake: FakeExecutionHost;
let hosts: ExecutionHosts;
const previousWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
const previousRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const AGENT_DEFINITION = `---\nname: Researcher\ndescription: d\nworkspace: none\nmode: session\nplatform_mcp: false\ntriggers:\n  - manual\nrisk_tier: read_only\n---\nResearch the repository\n`;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "agent_prompt_quarantine",
  });
  db = testDatabase.db as unknown as Db;
  runtimeRoot = await mkdtemp(join(tmpdir(), "agent-quarantine-"));
  process.env.MAISTER_WORKTREES_ROOT = join(runtimeRoot, "worktrees");
  process.env.MAISTER_RUNTIME_ROOT = join(runtimeRoot, "manager");
}, 180_000);

beforeEach(async () => {
  fake = createFakeExecutionHost();
  // The turn never ends on its own: only the quarantine can end it.
  fake.setPromptBehavior(() => new Promise(() => {}));
  ({ hosts } = await fakeExecutionHosts(db, { fake }));
});

afterEach(async () => {
  await fake.waitForCanonicalEvents();
});

afterAll(async () => {
  if (previousWorktreesRoot === undefined)
    delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = previousWorktreesRoot;
  if (previousRuntimeRoot === undefined)
    delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = previousRuntimeRoot;
  await testDatabase?.stop();
});

async function acceptedPrompt(runId: string) {
  const deadline = Date.now() + 30_000;

  for (;;) {
    const [command] = await db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, runId),
          eq(executionCommands.kind, "session.prompt"),
        ),
      );

    if (command?.state === "accepted") return command;
    if (Date.now() > deadline)
      throw new Error("timed out waiting for the prompt to be accepted");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// What the reducer writes when a terminal lands in the skip ledger.
async function quarantineUnsettled(commandId: string): Promise<void> {
  await db
    .update(executionCommands)
    .set({
      applicationState: "poisoned",
      applicationError: {
        reason: "prompt_terminal_conflict",
        phase: "prepare",
        causeCode: "terminal_unstorable",
      },
    })
    .where(eq(executionCommands.id, commandId));
}

async function expectCrashedOwnerPoisoned(
  runId: string,
  sessionId: string | null,
): Promise<void> {
  const [run] = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId));

  expect(run?.status).toBe("Crashed");
  const [crashed] = await db
    .select({ kind: domainEvents.kind, payload: domainEvents.payload })
    .from(domainEvents)
    .where(
      and(eq(domainEvents.runId, runId), eq(domainEvents.kind, "run.crashed")),
    );

  expect(crashed?.payload).toMatchObject({
    reason: "owner_poisoned",
    cause: { code: "CRASH", reason: "owner_poisoned", source: "agent" },
  });
  expect(fake.callsOf("deleteSession").map((call) => call.args[0])).toContain(
    sessionId,
  );
  // The turn closes with its run: nothing will ever apply it.
  expect(
    await db
      .select({ state: agentTurns.state })
      .from(agentTurns)
      .where(eq(agentTurns.runId, runId)),
  ).toEqual([{ state: "superseded" }]);
}

describe("ADR-184 amendment — an unsettled quarantined agent prompt ends its run", () => {
  it("the driver waiting on the prompt crashes the run owner_poisoned and stops its session", async () => {
    const runId = await seedAgentRun(db, {
      runtimeRoot,
      definition: AGENT_DEFINITION,
      workspace: "none",
      resultContract: null,
    });
    const driving = startAgentSession(runId, { db, executionHosts: hosts });
    const command = await acceptedPrompt(runId);

    await quarantineUnsettled(command.id);
    await driving;

    await expectCrashedOwnerPoisoned(runId, command.targetSessionId);
  });

  it("a re-driven turn whose prompt was quarantined meanwhile crashes the run owner_poisoned", async () => {
    const runId = await seedAgentRun(db, {
      runtimeRoot,
      definition: AGENT_DEFINITION,
      workspace: "none",
      resultContract: null,
    });
    const first = new AbortController();
    const yielded = startAgentSession(runId, {
      db,
      executionHosts: hosts,
      signal: first.signal,
    }).catch(() => undefined);
    const command = await acceptedPrompt(runId);

    first.abort();
    await yielded;
    const [running] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));

    // The first driver yielded without a verdict: the prompt is still open.
    expect(running?.status).toBe("Running");
    expect(
      await db
        .select({ state: agentTurns.state, commandId: agentTurns.commandId })
        .from(agentTurns)
        .where(eq(agentTurns.runId, runId)),
    ).toEqual([{ state: "dispatched", commandId: command.id }]);

    await quarantineUnsettled(command.id);
    await startAgentSession(runId, { db, executionHosts: hosts });

    await expectCrashedOwnerPoisoned(runId, command.targetSessionId);
  });
});

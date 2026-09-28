import type { Db } from "@/lib/execution-host/db";
import type { RunResultContract } from "@/lib/run-results/types";

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prepareAgentRunFinalization } from "@/lib/agents/finalization";
import { agentWorkdirPath } from "@/lib/agents/workspace-paths";
import {
  agentTurns,
  domainEvents,
  projects,
  runResults,
  runSessions,
  runs,
} from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";

let database: StartedPostgresTestDb;
let db: Db;
let directory: string;
const originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;

const contract: RunResultContract = {
  kind: "agent_profile",
  profileName: "research",
  schemaRef: "fixture@abcdef123456:research-result.v1",
  schemaVersion: 1,
  sha256: "f".repeat(64),
  required: true,
  schema: {
    schemaVersion: 1,
    fields: [{ name: "summary", type: "string", required: true }],
  },
  sourceFlowRevisionId: "rev-1",
};
const finalText = '```json maister:output\n{"summary":"original result"}\n```';

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_finalization_transaction",
  });
  db = database.db as unknown as Db;
  directory = await mkdtempReal("agent-finalization-");
  process.env.MAISTER_WORKTREES_ROOT = directory;
}, 180_000);

afterAll(async () => {
  if (originalWorktreesRoot === undefined)
    delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = originalWorktreesRoot;
  await database?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function seedRun(): Promise<{ runId: string; marker: string }> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const slug = `p-${projectId.slice(0, 8)}`;
  const repoPath = path.join(directory, `repo-${projectId}`);

  await mkdir(repoPath);
  await db.insert(projects).values({
    id: projectId,
    slug,
    name: "Finalization fixture",
    taskKey: `T${projectId.replaceAll("-", "").slice(0, 7)}`.toUpperCase(),
    repoPath,
    maisterYamlPath: path.join(repoPath, "maister.yaml"),
  });
  await db.insert(runs).values({
    id: runId,
    runKind: "agent",
    projectId,
    status: "Running",
    flowVersion: "agent",
    flowRevision: "manual",
    agentWorkspace: "none",
    resultContract: contract,
  });
  const cwd = agentWorkdirPath(slug, runId);
  const marker = path.join(cwd, "KEEP");

  await mkdir(cwd, { recursive: true });
  await writeFile(marker, "uncommitted work");

  return { runId, marker };
}

async function readOutcome(runId: string): Promise<{
  status: string;
  results: number;
  events: number;
}> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const results = await db
    .select()
    .from(runResults)
    .where(eq(runResults.runId, runId));
  const events = await db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.runId, runId));

  return { status: run.status, results: results.length, events: events.length };
}

describe("Agent terminal application transaction", () => {
  it("refuses a transaction connection as the preparation and cleanup connection", async () => {
    const { runId, marker } = await seedRun();

    await db.transaction(async (tx) => {
      await expect(
        prepareAgentRunFinalization(runId, "Done", { db: tx, finalText }),
      ).rejects.toMatchObject({
        code: "PRECONDITION",
        details: { reason: "agent_finalization_requires_pooled_db" },
      });
    });
    expect(await readOutcome(runId)).toEqual({
      status: "Running",
      results: 0,
      events: 0,
    });
    expect(await readFile(marker, "utf8")).toBe("uncommitted work");
  });

  it("outer rollback reverts the result and events and preserves the directory", async () => {
    const { runId, marker } = await seedRun();
    const prepared = await prepareAgentRunFinalization(runId, "Done", {
      db,
      finalText,
    });
    const rollback = new Error("rollback the outer command application");

    await expect(
      db.transaction(async (tx) => {
        const result = await prepared.apply(tx);

        expect(result).toMatchObject({ finalized: true, status: "Done" });
        await expect(prepared.afterCommit(result)).rejects.toMatchObject({
          code: "PRECONDITION",
          details: { reason: "agent_finalization_commit_unconfirmed" },
        });
        expect(await readFile(marker, "utf8")).toBe("uncommitted work");
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await readOutcome(runId)).toEqual({
      status: "Running",
      results: 0,
      events: 0,
    });
    expect(await readFile(marker, "utf8")).toBe("uncommitted work");

    const committed = await db.transaction(prepared.apply);

    expect(await readFile(marker, "utf8")).toBe("uncommitted work");
    await prepared.afterCommit(committed);
    expect(await readOutcome(runId)).toEqual({
      status: "Done",
      results: 1,
      events: 1,
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // A turn bound to the run's generation, as a claim leaves it (the state
  // check refuses a claimed turn without its assignment and session).
  async function claimedTurn(
    runId: string,
    input: { ordinal: number; variant: "live_message" },
  ): Promise<string> {
    const { hostId } = await fakeExecutionHosts(db);
    const assignment = await db.transaction((tx) =>
      mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
    );
    const runSessionId = randomUUID();
    const id = randomUUID();

    await db.insert(runSessions).values({
      id: runSessionId,
      runId,
      sessionName: `s-${input.ordinal}`,
      executionAssignmentId: assignment.id,
    });
    await db.insert(agentTurns).values({
      id,
      runId,
      ordinal: input.ordinal,
      variant: input.variant,
      logicalKey: `${input.variant}:${id}`,
      prompt: "work",
      state: "claimed",
      executionAssignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
      runSessionId,
    });

    return id;
  }

  async function turnStates(runId: string) {
    return Object.fromEntries(
      (
        await db
          .select({ id: agentTurns.id, state: agentTurns.state })
          .from(agentTurns)
          .where(eq(agentTurns.runId, runId))
      ).map((row) => [row.id, row.state]),
    );
  }

  // D-M1 (ADR-182): a message behind the ending turn can never be dispatched
  // once the run is terminal, so the finalization closes it in its OWN
  // transaction — a rollback must leave it queued, a commit superseded. A
  // message claimed as the run's active turn but never dispatched is closed
  // too: its admission refuses a superseded turn.
  it("a Crashed finalization supersedes undispatched messages atomically with the status flip", async () => {
    const { runId } = await seedRun();
    const claimed = await claimedTurn(runId, {
      ordinal: 1,
      variant: "live_message",
    });
    const queued = randomUUID();

    await db.insert(agentTurns).values({
      id: queued,
      runId,
      ordinal: 2,
      variant: "live_message",
      logicalKey: `message:auto:${queued}`,
      prompt: "also this",
      state: "queued",
    });
    const prepared = await prepareAgentRunFinalization(runId, "Crashed", {
      db,
      reason: "agent_turn_lost",
    });
    const rollback = new Error("rollback");

    await expect(
      db.transaction(async (tx) => {
        await prepared.apply(tx);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await turnStates(runId)).toEqual({
      [claimed]: "claimed",
      [queued]: "queued",
    });

    const committed = await db.transaction(prepared.apply);

    expect(committed).toMatchObject({ finalized: true, status: "Crashed" });
    const [crashed] = await db
      .select({ payload: domainEvents.payload })
      .from(domainEvents)
      .where(eq(domainEvents.runId, runId));

    // B6: a token reason is the cause's reason; an agent crash is CRASH.
    expect(crashed.payload.cause).toEqual({
      code: "CRASH",
      reason: "agent_turn_lost",
      source: "agent",
    });
    expect(await turnStates(runId)).toEqual({
      [claimed]: "superseded",
      [queued]: "superseded",
    });
  });

  // `CLOSES_MESSAGE_TURNS` marks `Done` too: a finished run dispatches
  // nothing either.
  it("a Done finalization supersedes a queued message as well", async () => {
    const { runId } = await seedRun();
    const queued = randomUUID();

    await db.insert(agentTurns).values({
      id: queued,
      runId,
      ordinal: 1,
      variant: "live_message",
      logicalKey: `message:auto:${queued}`,
      prompt: "one more thing",
      state: "queued",
    });
    const prepared = await prepareAgentRunFinalization(runId, "Done", {
      db,
      finalText,
    });

    await expect(db.transaction(prepared.apply)).resolves.toMatchObject({
      finalized: true,
      status: "Done",
    });
    expect(await turnStates(runId)).toEqual({ [queued]: "superseded" });
  });

  it("refuses a result contract changed after preparation", async () => {
    const { runId, marker } = await seedRun();
    const prepared = await prepareAgentRunFinalization(runId, "Done", {
      db,
      finalText,
    });

    await db
      .update(runs)
      .set({ resultContract: { ...contract, sha256: "a".repeat(64) } })
      .where(eq(runs.id, runId));
    await expect(db.transaction(prepared.apply)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "agent_finalization_provenance_changed" },
    });
    expect(await readOutcome(runId)).toEqual({
      status: "Running",
      results: 0,
      events: 0,
    });
    expect(await readFile(marker, "utf8")).toBe("uncommitted work");
  });

  it("competing applications publish one result and one terminal wake", async () => {
    const { runId, marker } = await seedRun();
    const first = await prepareAgentRunFinalization(runId, "Done", {
      db,
      finalText,
    });
    const second = await prepareAgentRunFinalization(runId, "Done", {
      db,
      finalText,
    });
    const results = await Promise.all([
      db.transaction(first.apply),
      db.transaction(second.apply),
    ]);

    expect(results.filter((result) => result.finalized)).toHaveLength(1);
    expect(await readOutcome(runId)).toEqual({
      status: "Done",
      results: 1,
      events: 1,
    });
    await first.afterCommit(results[0]);
    await second.afterCommit(results[1]);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

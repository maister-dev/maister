import type { Db } from "@/lib/execution-host/db";
import type { RunResultContract } from "@/lib/run-results/types";

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prepareAgentRunFinalization } from "@/lib/agents/finalization";
import { agentWorkdirPath } from "@/lib/agents/workspace-paths";
import { domainEvents, projects, runResults, runs } from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { mkdtempReal } from "@/test-support/worktree-test-root";

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

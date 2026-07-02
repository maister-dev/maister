import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  fakeEmbeddingClient,
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  type BrainTestDb,
} from "./helpers";

import {
  getAmbientBrainProjection,
  resetAmbientCache,
} from "@/lib/brain/ambient";
import { retain } from "@/lib/brain/retain";
import { writeRunContext } from "@/lib/flows/graph/run-context";

// T4.3 — ambient P7 (flow runs). Real pgvector; the embedding client is injected.

let ctx: BrainTestDb;
let projectId: string;
let runId: string;
const client = fakeEmbeddingClient();

async function seedRun(pid: string): Promise<string> {
  const id = randomUUID();

  await ctx.db.execute(sql`
    INSERT INTO runs (id, project_id, run_kind, status, flow_version)
    VALUES (${id}, ${pid}, 'flow', 'Running', 'v1')
  `);

  return id;
}

async function ambientSnapshotCount(): Promise<number> {
  const r = await ctx.db.execute(
    sql`SELECT count(*)::int AS n FROM brain_snapshots WHERE project_id = ${projectId} AND trigger = 'ambient'`,
  );

  return Number(r.rows[0]?.n);
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(async () => {
  resetAmbientCache();
  projectId = await seedBrainProject(ctx.db);
  runId = await seedRun(projectId);
  await retain(
    projectId,
    { kind: "lesson", content: "ambient-worthy lesson" },
    {},
    { db: ctx.db, client },
  );
});

describe("getAmbientBrainProjection (T4.3)", () => {
  it("returns top-K and writes an ambient snapshot when brain_context = true", async () => {
    const brain = await getAmbientBrainProjection({
      db: ctx.db,
      projectId,
      brainContext: true,
      taskTitle: "Fix",
      taskPrompt: "resolve the failing gate",
      runId,
      client,
    });

    expect(brain).toBeDefined();
    expect(brain?.length).toBeGreaterThanOrEqual(1);
    expect(brain?.[0]).toMatchObject({ kind: "lesson" });
    expect(await ambientSnapshotCount()).toBe(1);

    const snap = await ctx.db.execute(
      sql`SELECT run_id, trigger FROM brain_snapshots WHERE project_id = ${projectId}`,
    );

    expect(snap.rows[0]?.run_id).toBe(runId);
    expect(snap.rows[0]?.trigger).toBe("ambient");
  });

  it("returns undefined and writes NO snapshot when brain_context = false", async () => {
    const brain = await getAmbientBrainProjection({
      db: ctx.db,
      projectId,
      brainContext: false,
      taskTitle: "Fix",
      taskPrompt: "x",
      runId,
      client,
    });

    expect(brain).toBeUndefined();
    expect(await ambientSnapshotCount()).toBe(0);
  });

  it("treats null brain_context as opt-in OFF (no ambient)", async () => {
    const brain = await getAmbientBrainProjection({
      db: ctx.db,
      projectId,
      brainContext: null,
      taskTitle: "Fix",
      taskPrompt: "x",
      runId,
      client,
    });

    expect(brain).toBeUndefined();
    expect(await ambientSnapshotCount()).toBe(0);
  });

  it("memoizes the query embedding across repeated calls (no re-embed)", async () => {
    let embedCalls = 0;
    const countingClient = fakeEmbeddingClient();
    const origEmbed = countingClient.embed.bind(countingClient);

    countingClient.embed = async (texts: string[]) => {
      embedCalls++;

      return origEmbed(texts);
    };

    const argsBase = {
      db: ctx.db,
      projectId,
      brainContext: true as const,
      taskTitle: "Fix",
      taskPrompt: "same query",
      runId,
      client: countingClient,
    };

    await getAmbientBrainProjection(argsBase);
    await getAmbientBrainProjection(argsBase);

    expect(embedCalls).toBe(1); // second call reused the memoized embedding
  });
});

describe("writeRunContext brain injection (T4.3)", () => {
  it("writes the brain projection into .maister/run.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-run-ctx-"));

    await mkdir(join(dir, ".maister"), { recursive: true });

    const brain = await getAmbientBrainProjection({
      db: ctx.db,
      projectId,
      brainContext: true,
      taskTitle: "Fix",
      taskPrompt: "resolve",
      runId,
      client,
    });

    await writeRunContext({
      runId,
      worktreePath: dir,
      taskPrompt: "resolve",
      db: ctx.db,
      brain,
    });

    const raw = await readFile(join(dir, ".maister", "run.json"), "utf8");
    const parsed = JSON.parse(raw);

    expect(Array.isArray(parsed.brain)).toBe(true);
    expect(parsed.brain[0]).toMatchObject({ kind: "lesson" });
  });
});

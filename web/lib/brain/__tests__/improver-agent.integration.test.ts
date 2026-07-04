import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { listMemoryClusters } from "@/lib/brain/clusters";
import { createBrainProposal } from "@/lib/brain/proposals";
import { retain } from "@/lib/brain/retain";
import {
  fakeEmbeddingClient,
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  TEST_EMBEDDING_DIMENSIONS,
  type BrainTestDb,
} from "@/lib/brain/__tests__/helpers";
import { registerPackageAgents } from "@/lib/agents/registry";
import { loadMaisterPackageManifest } from "@/lib/packages/manifest";

const CORE_FIXTURE_ROOT = path.join(
  __dirname,
  "../../agents/__tests__/fixtures/core-package",
);
const IMPROVER_ID = "core:improver";

let ctx: BrainTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  ctx = await startBrainTestDb();
  db = ctx.db;
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(async () => {
  await ctx.pool.query(`DELETE FROM brain_proposals`);
  await ctx.pool.query(`DELETE FROM brain_edges`);
  await ctx.pool.query(`DELETE FROM brain_embeddings`);
  await ctx.pool.query(`DELETE FROM brain_items`);
  await ctx.pool.query(`DELETE FROM "agent_project_links"`);
  await ctx.pool.query(`DELETE FROM "agent_schedules"`);
  await ctx.pool.query(`DELETE FROM "agents"`);
  await ctx.pool.query(`DELETE FROM "package_installs"`);
  await ctx.pool.query(`DELETE FROM "projects"`);
});

async function installCoreFixture(): Promise<string> {
  const installId = randomUUID();
  const manifest = {
    spec: { name: "core", flows: [] },
    inventory: {
      skills: [],
      agents: [],
      platformAgents: ["triager", "improver"],
    },
  };

  await db.execute(sql`
    INSERT INTO "package_installs"
      ("id", "source_url", "name", "version_label", "resolved_revision",
       "manifest", "manifest_digest", "installed_path", "package_status",
       "trust_status")
    VALUES
      (${installId}, 'github.com/maisterhq/maister-plugins', 'core', 'v1.1.0',
       'rev-core-improver', ${JSON.stringify(manifest)}::jsonb, 'digest',
       ${CORE_FIXTURE_ROOT}, 'Installed', 'trusted')
  `);

  return installId;
}

function nearVector(text: string): number[] {
  const v = new Array(TEST_EMBEDDING_DIMENSIONS).fill(0);

  v[0] = 1;
  v[1] = text.length * 0.0001;

  return v;
}

async function proposalCount(projectId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM brain_proposals
    WHERE project_id = ${projectId}
  `);

  return Number(rows.rows[0]?.n ?? 0);
}

describe("core Brain Improver package path (T10.2)", () => {
  it("registers the improver as a flow-less core package agent with ADR-111 config", async () => {
    const manifest = await loadMaisterPackageManifest(CORE_FIXTURE_ROOT);

    expect(manifest.name).toBe("core");
    expect(manifest.flows).toEqual([]);

    const installId = await installCoreFixture();
    const summary = await registerPackageAgents(installId, db);

    expect(summary.invalid).toEqual([]);
    expect(summary.registered).toContain(IMPROVER_ID);

    const rows = await db.execute(sql`
      SELECT name, workspace, mode, risk_tier, triggers, recommended,
             config_schema, source_path
      FROM agents
      WHERE id = ${IMPROVER_ID}
    `);
    const row = rows.rows[0];

    expect(row).toMatchObject({
      name: "Brain Improver",
      workspace: "none",
      mode: "session",
      risk_tier: "read_only",
    });
    expect(row?.triggers).toEqual(["cron", "manual"]);
    expect(row?.recommended).toEqual({
      cron: { expr: "0 9 * * 1", timezone: "UTC" },
    });
    expect(row?.config_schema).toEqual([
      expect.objectContaining({
        key: "min_recurrence",
        type: "number",
        default: 3,
      }),
      expect.objectContaining({
        key: "kinds",
        type: "string",
        default: "lesson,observation,state_fact",
      }),
      expect.objectContaining({
        key: "max_proposals_per_run",
        type: "number",
        default: 3,
      }),
    ]);

    const source = await readFile(String(row?.source_path), "utf8");

    expect(source).toContain("memory_clusters");
    expect(source).toContain("memory_propose");
  });

  it("runs the scripted cluster-to-proposal path idempotently by clusterHash", async () => {
    const installId = await installCoreFixture();

    await registerPackageAgents(installId, db);

    const projectId = await seedBrainProject(db);
    const client = fakeEmbeddingClient({ vectorFor: nearVector });

    for (const content of [
      "SIM: command check keeps failing on lint",
      "SIM: generated files break lint again",
      "SIM: recurring lint failure in generated files",
    ]) {
      await retain(
        projectId,
        { kind: "lesson", content },
        { sourceGateKind: "command_check" },
        { db, client },
      );
    }

    const clusters = await listMemoryClusters(db, {
      projectId,
      client,
      kinds: ["lesson"],
      minRecurrence: 3,
      limit: 3,
    });

    expect(clusters).toHaveLength(1);

    const cluster = clusters[0]!;
    const draft = {
      title: "Add a lint-generated-files rule",
      body: "Capture the recurring command_check lesson as a reviewable rule.",
      target: "rule",
    };
    const first = await createBrainProposal(db, {
      projectId,
      kind: "rule",
      evidenceItemIds: cluster.evidenceItemIds,
      draft,
      blastRadius: "low",
      autonomyDecision: "manual",
      clusterHash: cluster.clusterHash,
      actor: { type: "agent", id: IMPROVER_ID },
    });
    const second = await createBrainProposal(db, {
      projectId,
      kind: "rule",
      evidenceItemIds: cluster.evidenceItemIds,
      draft,
      blastRadius: "low",
      autonomyDecision: "manual",
      clusterHash: cluster.clusterHash,
      actor: { type: "agent", id: IMPROVER_ID },
    });

    expect(first.idempotent).toBe(false);
    expect(second).toMatchObject({ id: first.id, idempotent: true });
    expect(await proposalCount(projectId)).toBe(1);
  });
});

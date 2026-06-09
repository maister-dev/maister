/**
 * Integration test for T-A5: the authored-flow-draft validation HARD-GATE.
 *
 * RED (pre-impl): updateAuthoredDraft persists ANY manifest for a flow cap, so
 * the "invalid manifest is refused with CONFIG and the row is unchanged"
 * assertions fail (the invalid save succeeds + bumps draft_version).
 *
 * GREEN: updateAuthoredDraft runs validateGraphManifest + compileManifest on a
 * flow-kind draft BEFORE the CAS write; an invalid manifest throws
 * MaisterError("CONFIG") and never mutates the row.
 */
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAuthoredCapability,
  updateAuthoredDraft,
} from "@/lib/catalog/authored-service";
import { isMaisterError } from "@/lib/errors";
import * as schemaModule from "@/lib/db/schema";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;

const VALID_MANIFEST = {
  schemaVersion: 1,
  name: "hardgate-flow",
  compat: { engine_min: "1.2.0" },
  nodes: [
    {
      id: "work",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
    },
  ],
};

// transition target "ghost" is not a declared node → validateGraphManifest rejects.
const INVALID_MANIFEST = {
  schemaVersion: 1,
  name: "hardgate-flow",
  compat: { engine_min: "1.2.0" },
  nodes: [
    {
      id: "work",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "ghost" },
    },
  ],
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("authored_hardgate_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedFlowCap(
  slugPrefix: string,
): Promise<{ projectSlug: string; capId: string }> {
  const projectSlug = `${slugPrefix}-${randomUUID()}`;

  await db.insert(schemaModule.projects).values({
    id: randomUUID(),
    slug: projectSlug,
    name: projectSlug,
    repoPath: `/tmp/${projectSlug}`,
    maisterYamlPath: `/tmp/${projectSlug}/maister.yaml`,
  });

  const { capability } = await createAuthoredCapability({
    projectSlug,
    input: {
      kind: "flow",
      slug: "editable-flow",
      title: "Editable Flow",
      manifest: VALID_MANIFEST,
    },
    db,
  });

  return { projectSlug, capId: capability.id };
}

async function readDraftVersion(capId: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT draft_version FROM authored_capabilities WHERE id = ${capId} LIMIT 1
  `);
  const row = (res.rows ?? [])[0] as { draft_version: number } | undefined;

  return Number(row?.draft_version);
}

describe("authored flow draft hard-gate (T-A5)", () => {
  it("accepts a valid flow manifest and bumps draft_version", async () => {
    const { projectSlug, capId } = await seedFlowCap("hardgate-ok");

    const before = await readDraftVersion(capId);
    const revision = await updateAuthoredDraft({
      projectSlug,
      capId,
      input: { manifest: VALID_MANIFEST, expectedDraftVersion: before },
      db,
    });

    expect(revision).toBeDefined();
    expect(await readDraftVersion(capId)).toBe(before + 1);
  });

  it("rejects an invalid flow manifest with CONFIG and leaves the row unchanged", async () => {
    const { projectSlug, capId } = await seedFlowCap("hardgate-bad");
    const before = await readDraftVersion(capId);

    let thrown: unknown;

    try {
      await updateAuthoredDraft({
        projectSlug,
        capId,
        input: { manifest: INVALID_MANIFEST, expectedDraftVersion: before },
        db,
      });
    } catch (err) {
      thrown = err;
    }

    expect(isMaisterError(thrown)).toBe(true);
    expect((thrown as { code?: string }).code).toBe("CONFIG");
    // The hard-gate runs BEFORE the CAS write → draft_version untouched.
    expect(await readDraftVersion(capId)).toBe(before);
  });

  it("still enforces optimistic concurrency (stale expectedDraftVersion → CONFLICT)", async () => {
    const { projectSlug, capId } = await seedFlowCap("hardgate-stale");

    let thrown: unknown;

    try {
      await updateAuthoredDraft({
        projectSlug,
        capId,
        input: { manifest: VALID_MANIFEST, expectedDraftVersion: 999 },
        db,
      });
    } catch (err) {
      thrown = err;
    }

    expect(isMaisterError(thrown)).toBe(true);
    expect((thrown as { code?: string }).code).toBe("CONFLICT");
  });
});

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION_PATH = path.resolve(
  "lib/db/migrations/0062_package_attachment_skills.sql",
);

let container: StartedPostgreSqlContainer;
let pool: Pool;

async function createLegacyPackageTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE "projects" (
      "id" text PRIMARY KEY
    )
  `);
  await pool.query(`
    CREATE TABLE "package_installs" (
      "id" text PRIMARY KEY,
      "version_label" text NOT NULL,
      "resolved_revision" text NOT NULL,
      "manifest" jsonb NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE "project_package_attachments" (
      "id" text PRIMARY KEY,
      "project_id" text NOT NULL,
      "package_install_id" text NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE "capability_records" (
      "id" text PRIMARY KEY,
      "project_id" text NOT NULL,
      "capability_ref_id" text NOT NULL,
      "kind" text NOT NULL,
      "label" text NOT NULL,
      "source" text NOT NULL,
      "version" text,
      "revision" text,
      "agents" jsonb NOT NULL,
      "enforceability" text NOT NULL,
      "selected_by_default" boolean NOT NULL,
      "selectable" boolean NOT NULL,
      "material" jsonb NOT NULL,
      "disabled_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL,
      "updated_at" timestamp with time zone NOT NULL,
      CONSTRAINT "capability_records_project_ref_uq"
        UNIQUE ("project_id", "source", "kind", "capability_ref_id")
    )
  `);
}

async function seedAttachedPackage(): Promise<{
  installId: string;
  projectId: string;
}> {
  const projectId = randomUUID();
  const installId = randomUUID();
  const attachmentId = randomUUID();

  await pool.query(`INSERT INTO "projects" ("id") VALUES ($1)`, [projectId]);
  await pool.query(
    `INSERT INTO "package_installs" (
       "id",
       "version_label",
       "resolved_revision",
       "manifest"
     )
     VALUES ($1, 'aif/v2.0.0', 'rev-aif', $2::jsonb)`,
    [
      installId,
      JSON.stringify({
        spec: { name: "aif" },
        inventory: { skills: ["aif", "aif-plan"] },
      }),
    ],
  );
  await pool.query(
    `INSERT INTO "project_package_attachments" (
       "id",
       "project_id",
       "package_install_id"
     )
     VALUES ($1, $2, $3)`,
    [attachmentId, projectId, installId],
  );

  return { installId, projectId };
}

async function applyMigration0062(): Promise<void> {
  await pool.query(readFileSync(MIGRATION_PATH, "utf8"));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("migration 0062 — package attachment skill catalog backfill", () => {
  it("materializes attached package inventory skills as selectable capability records", async () => {
    await createLegacyPackageTables();
    const { installId, projectId } = await seedAttachedPackage();

    await applyMigration0062();
    await applyMigration0062();

    const rows = await pool.query<{
      capability_ref_id: string;
      kind: string;
      label: string;
      version: string;
      revision: string;
      agents: string[];
      material: {
        origin: string;
        packageInstallId: string;
        hasContent: boolean;
      };
    }>(
      `SELECT
         "capability_ref_id",
         "kind",
         "label",
         "version",
         "revision",
         "agents",
         "material"
       FROM "capability_records"
       WHERE "project_id" = $1
       ORDER BY "capability_ref_id"`,
      [projectId],
    );

    expect(rows.rows).toEqual([
      expect.objectContaining({
        capability_ref_id: "aif",
        kind: "skill",
        label: "aif",
        version: "aif/v2.0.0",
        revision: "rev-aif",
        agents: ["claude", "codex", "gemini", "opencode", "mimo"],
        material: {
          origin: "package-attachment",
          packageInstallId: installId,
          hasContent: true,
        },
      }),
      expect.objectContaining({
        capability_ref_id: "aif-plan",
        kind: "skill",
        label: "aif-plan",
        version: "aif/v2.0.0",
        revision: "rev-aif",
        agents: ["claude", "codex", "gemini", "opencode", "mimo"],
        material: {
          origin: "package-attachment",
          packageInstallId: installId,
          hasContent: true,
        },
      }),
    ]);
  });
});

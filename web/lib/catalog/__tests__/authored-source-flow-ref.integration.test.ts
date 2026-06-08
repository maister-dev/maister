/**
 * Integration test for T-A5.1: authored_capabilities.source_flow_ref_id column.
 *
 * RED state: this test fails because the column does not exist yet (migration
 * 0031+ has not been added and schema.ts has no sourceFlowRefId field).
 *
 * The first assertion is a raw-SQL probe:
 *   SELECT source_flow_ref_id FROM authored_capabilities LIMIT 0
 * which throws "column source_flow_ref_id does not exist" on the unpatched DB,
 * making the failure unmistakably about the missing column rather than a service
 * assertion.
 *
 * Service-level assertions follow:
 * - createAuthoredCapability with sourceFlowRefId → reads back as the supplied value.
 * - createAuthoredCapability without sourceFlowRefId → reads back as null/undefined.
 *
 * TypeScript note: `sourceFlowRefId` is not yet on CreateAuthoredCapabilityInput,
 * so passing it causes a compile-level type error.  The test uses a cast
 * `as unknown as CreateAuthoredCapabilityInput` to let the test file compile so
 * the RUNTIME "column does not exist" failure is the primary RED signal.
 * Once the implementor adds the field to the type, the cast can be removed.
 */

import type { CreateAuthoredCapabilityInput } from "@/lib/catalog/authored-types";

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

import { createAuthoredCapability } from "@/lib/catalog/authored-service";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("authored_source_flow_ref_test")
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

async function insertProject(
  slugPrefix: string,
): Promise<{ projectSlug: string }> {
  const projectSlug = `${slugPrefix}-${randomUUID()}`;

  await db.insert(schema.projects).values({
    id: randomUUID(),
    slug: projectSlug,
    name: projectSlug,
    repoPath: `/tmp/${projectSlug}`,
    maisterYamlPath: `/tmp/${projectSlug}/maister.yaml`,
  });

  return { projectSlug };
}

describe("authored_capabilities.source_flow_ref_id (T-A5.1)", () => {
  it("column exists in the DB schema (raw-SQL probe)", async () => {
    // This query selects zero rows but still parses the column name.
    // Pre-impl this throws: ERROR: column "source_flow_ref_id" does not exist
    await db.execute(sql`
      SELECT source_flow_ref_id
      FROM authored_capabilities
      LIMIT 0
    `);
  });

  it("stores source_flow_ref_id when creating an authored cap for an installed flow", async () => {
    const { projectSlug } = await insertProject("src-flow-ref-set");

    // Cast required because CreateAuthoredCapabilityInput does not yet declare
    // sourceFlowRefId.  Once the implementor adds it, remove the cast.
    const input = {
      kind: "flow",
      slug: "edit-bugfix",
      title: "Edit Bugfix Flow",
      body: { manifest: { schemaVersion: 1, nodes: [] } },
      sourceFlowRefId: "bugfix",
    } as unknown as CreateAuthoredCapabilityInput;

    await createAuthoredCapability({ projectSlug, input, db });

    const result = await db.execute(sql`
      SELECT source_flow_ref_id
      FROM authored_capabilities
      WHERE slug = 'edit-bugfix'
        AND project_id = (SELECT id FROM projects WHERE slug = ${projectSlug})
      LIMIT 1
    `);
    const row = (result.rows ?? [])[0] as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row?.source_flow_ref_id).toBe("bugfix");
  });

  it("stores null source_flow_ref_id for a net-new authored flow", async () => {
    const { projectSlug } = await insertProject("src-flow-ref-null");

    await createAuthoredCapability({
      projectSlug,
      input: {
        kind: "flow",
        slug: "net-new-flow",
        title: "Net New Flow",
        body: { manifest: { schemaVersion: 1, nodes: [] } },
      },
      db,
    });

    const result = await db.execute(sql`
      SELECT source_flow_ref_id
      FROM authored_capabilities
      WHERE slug = 'net-new-flow'
        AND project_id = (SELECT id FROM projects WHERE slug = ${projectSlug})
      LIMIT 1
    `);
    const row = (result.rows ?? [])[0] as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    // Column is NULL when no source flow ref is supplied.
    expect(row?.source_flow_ref_id).toBeNull();
  });
});

import type { MaisterCapabilitiesConfig } from "@/lib/config.schema";
import type { AuthoredCapabilityRevision } from "@/lib/catalog/authored-types";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upsertCapabilitiesFromConfig } from "@/lib/capabilities/catalog";
import {
  archiveAuthoredCapability,
  canonicalAuthoredContentHash,
  createAuthoredCapability,
  publishAuthoredCapabilityLocal,
  updateAuthoredDraft,
} from "@/lib/catalog/authored-service";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule;

type CapabilityRecordRow = typeof schema.capabilityRecords.$inferSelect;
type AuthoredRevisionRow =
  typeof schema.authoredCapabilityRevisions.$inferSelect;
type CountTableName = "flows" | "flow_revisions" | "capability_records";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("authored_catalog_test")
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

function emptyCapabilities(): MaisterCapabilitiesConfig {
  return {
    mcps: [],
    skills: [],
    rules: [],
    restrictions: [],
    settings: [],
    tools: [],
    agent_definitions: [],
    env_profiles: [],
  };
}

async function insertProject(slugPrefix: string): Promise<{
  projectId: string;
  projectSlug: string;
}> {
  const projectId = randomUUID();
  const projectSlug = `${slugPrefix}-${randomUUID()}`;

  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: projectSlug,
    name: projectSlug,
    repoPath: `/tmp/${projectSlug}`,
    maisterYamlPath: `/tmp/${projectSlug}/maister.yaml`,
  });

  return { projectId, projectSlug };
}

async function selectCapabilityRecord(args: {
  projectId: string;
  kind: "rule" | "skill";
  slug: string;
}): Promise<CapabilityRecordRow> {
  const rows = await db
    .select()
    .from(schema.capabilityRecords)
    .where(
      and(
        eq(schema.capabilityRecords.projectId, args.projectId),
        eq(schema.capabilityRecords.source, "project"),
        eq(schema.capabilityRecords.kind, args.kind),
        eq(schema.capabilityRecords.capabilityRefId, args.slug),
      ),
    );

  expect(rows).toHaveLength(1);

  return rows[0];
}

async function countRows(tableName: CountTableName): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS value
    FROM ${sql.raw(tableName)}
  `);
  const row = (result.rows ?? [])[0] as { value: number | string } | undefined;

  return Number(row?.value ?? 0);
}

describe("authored catalog service integration", () => {
  it.each(["rule", "skill"] as const)(
    "publishes authored %s into capability_records",
    async (kind) => {
      const { projectId, projectSlug } = await insertProject(
        `authored-${kind}`,
      );
      const slug = `${kind}-review`;
      const body = { content: `Use this ${kind}` };
      const created = await createAuthoredCapability({
        projectSlug,
        input: {
          kind,
          slug,
          title: `${kind} review`,
          body,
        },
        db,
      });

      const result = await publishAuthoredCapabilityLocal({
        projectSlug,
        capId: created.capability.id,
        db,
      });
      const record = await selectCapabilityRecord({ projectId, kind, slug });

      expect(result.materializedRecordId).toEqual(expect.any(String));
      expect(record).toMatchObject({
        projectId,
        capabilityRefId: slug,
        kind,
        source: "project",
        version: "local",
        selectable: true,
        disabledAt: null,
        enforceability: "instructed",
      });
      expect(record.revision).toBe(
        canonicalAuthoredContentHash({
          kind,
          body,
          manifest: null,
          schemaVersion: 1,
        }),
      );
      expect(record.material).toMatchObject({
        origin: "authored",
        authoredCapabilityId: created.capability.id,
        authoredRevisionId: result.revision.id,
        body,
        manifest: null,
        schemaVersion: 1,
      });
    },
  );

  it("does not disable authored-origin rows during capability config CLEAR", async () => {
    const { projectId, projectSlug } = await insertProject("authored-clear");
    const created = await createAuthoredCapability({
      projectSlug,
      input: {
        kind: "rule",
        slug: "clear-safe",
        title: "Clear Safe",
        body: { content: "Keep me selectable" },
      },
      db,
    });

    await publishAuthoredCapabilityLocal({
      projectSlug,
      capId: created.capability.id,
      db,
    });
    const before = await selectCapabilityRecord({
      projectId,
      kind: "rule",
      slug: "clear-safe",
    });

    await upsertCapabilitiesFromConfig({
      projectId,
      config: emptyCapabilities(),
      db,
    });
    const after = await selectCapabilityRecord({
      projectId,
      kind: "rule",
      slug: "clear-safe",
    });

    expect(after.selectable).toBe(true);
    expect(after.disabledAt).toBeNull();
    expect(after.material).toMatchObject({ origin: "authored" });
    expect(after.revision).toBe(before.revision);
  });

  it("opens a new draft from a published authored capability", async () => {
    const { projectSlug } = await insertProject("authored-edit-published");
    const created = await createAuthoredCapability({
      projectSlug,
      input: {
        kind: "rule",
        slug: "published-edit",
        title: "Published Edit",
        body: { content: "Published text" },
      },
      db,
    });
    const published = await publishAuthoredCapabilityLocal({
      projectSlug,
      capId: created.capability.id,
      db,
    });

    const draft = await updateAuthoredDraft({
      projectSlug,
      capId: created.capability.id,
      input: {
        title: "Draft Edit",
        expectedDraftVersion: 1,
      },
      db,
    });
    const caps = await db
      .select()
      .from(schema.authoredCapabilities)
      .where(eq(schema.authoredCapabilities.id, created.capability.id));
    const revisions = await db
      .select()
      .from(schema.authoredCapabilityRevisions)
      .where(
        eq(
          schema.authoredCapabilityRevisions.capabilityId,
          created.capability.id,
        ),
      );

    expect(draft).toMatchObject({
      lifecycle: "DRAFT",
      draftVersion: 2,
      revisionNumber: 2,
      title: "Draft Edit",
      body: { content: "Published text" },
    });
    expect(caps[0]).toMatchObject({
      lifecycle: "DRAFT",
      draftVersion: 2,
      currentDraftRevisionId: draft.id,
      currentPublishedRevisionId: published.revision.id,
    });
    expect(
      revisions.filter((revision: AuthoredRevisionRow) => {
        return revision.lifecycle === "PUBLISHED";
      }),
    ).toHaveLength(1);
    expect(
      revisions.filter((revision: AuthoredRevisionRow) => {
        return revision.lifecycle === "DRAFT";
      }),
    ).toHaveLength(1);
  });

  it("rolls back stale draft updates without archiving the active draft", async () => {
    const { projectSlug } = await insertProject("authored-stale-draft");
    const created = await createAuthoredCapability({
      projectSlug,
      input: {
        kind: "rule",
        slug: "stale-safe",
        title: "Stale Safe",
        body: { content: "Original draft" },
      },
      db,
    });

    await expect(
      updateAuthoredDraft({
        projectSlug,
        capId: created.capability.id,
        input: {
          title: "Should Roll Back",
          expectedDraftVersion: 2,
        },
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const caps = await db
      .select()
      .from(schema.authoredCapabilities)
      .where(eq(schema.authoredCapabilities.id, created.capability.id));
    const revisions = await db
      .select()
      .from(schema.authoredCapabilityRevisions)
      .where(
        eq(
          schema.authoredCapabilityRevisions.capabilityId,
          created.capability.id,
        ),
      );

    expect(caps[0]).toMatchObject({
      lifecycle: "DRAFT",
      draftVersion: 1,
      currentDraftRevisionId: created.draft.id,
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      id: created.draft.id,
      lifecycle: "DRAFT",
      title: "Stale Safe",
      body: { content: "Original draft" },
    });
  });

  it("returns one typed conflict for concurrent same-version draft updates", async () => {
    const { projectSlug } = await insertProject("authored-concurrent-draft");
    const created = await createAuthoredCapability({
      projectSlug,
      input: {
        kind: "rule",
        slug: "concurrent-safe",
        title: "Concurrent Safe",
        body: { content: "Original draft" },
      },
      db,
    });

    const results = await Promise.allSettled([
      updateAuthoredDraft({
        projectSlug,
        capId: created.capability.id,
        input: {
          title: "Concurrent Winner A",
          expectedDraftVersion: 1,
        },
        db,
      }),
      updateAuthoredDraft({
        projectSlug,
        capId: created.capability.id,
        input: {
          title: "Concurrent Winner B",
          expectedDraftVersion: 1,
        },
        db,
      }),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<AuthoredCapabilityRevision> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "CONFLICT" },
    });

    const caps = await db
      .select()
      .from(schema.authoredCapabilities)
      .where(eq(schema.authoredCapabilities.id, created.capability.id));
    const revisions = await db
      .select()
      .from(schema.authoredCapabilityRevisions)
      .where(
        eq(
          schema.authoredCapabilityRevisions.capabilityId,
          created.capability.id,
        ),
      );

    expect(caps[0]).toMatchObject({
      lifecycle: "DRAFT",
      draftVersion: 2,
    });
    expect(
      revisions.filter((revision: AuthoredRevisionRow) => {
        return revision.lifecycle === "DRAFT";
      }),
    ).toHaveLength(1);
    expect(revisions).toHaveLength(2);
  });

  it("refuses a same-slug non-authored project capability collision", async () => {
    const { projectId, projectSlug } =
      await insertProject("authored-collision");
    const created = await createAuthoredCapability({
      projectSlug,
      input: {
        kind: "rule",
        slug: "same-slug",
        title: "Same Slug",
        body: { content: "Draft remains draft" },
      },
      db,
    });

    await db.insert(schema.capabilityRecords).values({
      id: randomUUID(),
      projectId,
      capabilityRefId: "same-slug",
      kind: "rule",
      label: "Git-installed rule",
      source: "project",
      version: "v1",
      revision: "git-revision",
      agents: ["claude", "codex"],
      enforceability: "instructed",
      selectedByDefault: true,
      selectable: true,
      material: {},
    });

    await expect(
      publishAuthoredCapabilityLocal({
        projectSlug,
        capId: created.capability.id,
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const caps = await db
      .select()
      .from(schema.authoredCapabilities)
      .where(eq(schema.authoredCapabilities.id, created.capability.id));
    const publishedRevisions = await db
      .select()
      .from(schema.authoredCapabilityRevisions)
      .where(
        and(
          eq(
            schema.authoredCapabilityRevisions.capabilityId,
            created.capability.id,
          ),
          eq(schema.authoredCapabilityRevisions.lifecycle, "PUBLISHED"),
        ),
      );
    const records = await db
      .select()
      .from(schema.capabilityRecords)
      .where(
        and(
          eq(schema.capabilityRecords.projectId, projectId),
          eq(schema.capabilityRecords.source, "project"),
          eq(schema.capabilityRecords.kind, "rule"),
          eq(schema.capabilityRecords.capabilityRefId, "same-slug"),
        ),
      );

    expect(caps[0]).toMatchObject({
      lifecycle: "DRAFT",
      currentPublishedRevisionId: null,
    });
    expect(publishedRevisions).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      selectable: true,
      material: {},
    });
  });

  it("refuses config resync that would overwrite an authored projection", async () => {
    const { projectId, projectSlug } = await insertProject(
      "authored-config-overwrite",
    );
    const created = await createAuthoredCapability({
      projectSlug,
      input: {
        kind: "rule",
        slug: "config-overwrite",
        title: "Config Overwrite",
        body: { content: "Authored projection owns this slug" },
      },
      db,
    });
    const published = await publishAuthoredCapabilityLocal({
      projectSlug,
      capId: created.capability.id,
      db,
    });

    await expect(
      upsertCapabilitiesFromConfig({
        projectId,
        config: {
          ...emptyCapabilities(),
          rules: [
            {
              id: "config-overwrite",
              kind: "rule",
              label: "Config Rule",
              source: "project",
              version: "local",
              agents: ["claude", "codex"],
              enforceability: "instructed",
              selected_by_default: true,
              path: ".maister/rules/config-overwrite.md",
            },
          ],
        },
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const record = await selectCapabilityRecord({
      projectId,
      kind: "rule",
      slug: "config-overwrite",
    });

    expect(record.selectable).toBe(true);
    expect(record.revision).toBe(published.revision.contentHash);
    expect(record.material).toMatchObject({
      origin: "authored",
      authoredCapabilityId: created.capability.id,
      authoredRevisionId: published.revision.id,
    });
  });

  it("archives only the authored-origin capability projection", async () => {
    const { projectId, projectSlug } = await insertProject("authored-archive");
    const created = await createAuthoredCapability({
      projectSlug,
      input: {
        kind: "rule",
        slug: "archive-authored",
        title: "Archive Authored",
        body: { content: "Disable only this projection" },
      },
      db,
    });

    await publishAuthoredCapabilityLocal({
      projectSlug,
      capId: created.capability.id,
      db,
    });
    await db.insert(schema.capabilityRecords).values({
      id: randomUUID(),
      projectId,
      capabilityRefId: "external-rule",
      kind: "rule",
      label: "External Rule",
      source: "project",
      version: "v1",
      revision: "external-revision",
      agents: ["claude", "codex"],
      enforceability: "instructed",
      selectedByDefault: true,
      selectable: true,
      material: {},
    });

    const archived = await archiveAuthoredCapability({
      projectSlug,
      capId: created.capability.id,
      db,
    });
    const authoredRecord = await selectCapabilityRecord({
      projectId,
      kind: "rule",
      slug: "archive-authored",
    });
    const externalRecord = await selectCapabilityRecord({
      projectId,
      kind: "rule",
      slug: "external-rule",
    });

    expect(archived.lifecycle).toBe("ARCHIVED");
    expect(authoredRecord.selectable).toBe(false);
    expect(authoredRecord.disabledAt).toEqual(expect.any(Date));
    expect(authoredRecord.material).toMatchObject({ origin: "authored" });
    expect(externalRecord.selectable).toBe(true);
    expect(externalRecord.disabledAt).toBeNull();
    expect(externalRecord.material).toEqual({});
  });

  it("publishes authored flow without mutating Flow package tables", async () => {
    const { projectSlug } = await insertProject("authored-flow");
    const flowsBefore = await countRows("flows");
    const flowRevisionsBefore = await countRows("flow_revisions");
    const capabilityRecordsBefore = await countRows("capability_records");
    const created = await createAuthoredCapability({
      projectSlug,
      input: {
        kind: "flow",
        slug: "local-flow",
        title: "Local Flow",
        body: { manifest: { schemaVersion: 1, nodes: [] } },
      },
      db,
    });

    const result = await publishAuthoredCapabilityLocal({
      projectSlug,
      capId: created.capability.id,
      db,
    });
    const caps = await db
      .select()
      .from(schema.authoredCapabilities)
      .where(eq(schema.authoredCapabilities.id, created.capability.id));

    expect(result.materializedRecordId).toBeNull();
    expect(result.revision).toMatchObject({
      kind: "flow",
      lifecycle: "PUBLISHED",
    });
    expect(caps[0]).toMatchObject({
      lifecycle: "PUBLISHED",
      currentPublishedRevisionId: result.revision.id,
    });
    expect(await countRows("flows")).toBe(flowsBefore);
    expect(await countRows("flow_revisions")).toBe(flowRevisionsBefore);
    expect(await countRows("capability_records")).toBe(capabilityRecordsBefore);
  });
});

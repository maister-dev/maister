import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  type BrainTestDb,
} from "./helpers";

import {
  loadProjectBrainPanelData,
  type BrainUiDb,
} from "@/lib/brain/ui-queries";

let ctx: BrainTestDb;

async function seedIndexedSearchChunk(args: {
  projectId: string;
  sourceKind: "markdown" | "openapi";
  chunkKind: string;
  path: string;
  title: string;
  content: string;
  updatedAt: string;
}): Promise<void> {
  const sourceId = randomUUID();
  const chunkId = randomUUID();
  const stableId = `${args.path}#${args.title}`;

  await ctx.db.execute(sql`
    INSERT INTO brain_sources
      (id, project_id, kind, path, chunker_id, chunker_version, updated_at)
    VALUES
      (${sourceId}, ${args.projectId}, ${args.sourceKind}, ${args.path},
       ${args.sourceKind}, '1', ${args.updatedAt})
  `);
  await ctx.db.execute(sql`
    INSERT INTO brain_chunks
      (id, source_id, project_id, stable_id, kind, title, path, symbol,
       content, metadata, source_range, content_hash, updated_at)
    VALUES
      (${chunkId}, ${sourceId}, ${args.projectId}, ${stableId},
       ${args.chunkKind}, ${args.title}, ${args.path}, ${args.title},
       ${args.content}, '{}'::jsonb, '{"startLine":1,"endLine":4}'::jsonb,
       md5(${args.content}), ${args.updatedAt})
  `);
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

describe("Project Brain UI queries", () => {
  it("ranks exact indexed OpenAPI operation matches above newer markdown references", async () => {
    const projectId = await seedBrainProject(ctx.db);

    await seedIndexedSearchChunk({
      projectId,
      sourceKind: "markdown",
      chunkKind: "markdown_section",
      path: "docs/system-analytics/acp-runners.md",
      title: "Linked artifacts",
      content:
        "Linked artifacts mention `getAdminAcpRunners` alongside postAdminAcpRunner.",
      updatedAt: "2026-07-05T17:25:14.000Z",
    });
    await seedIndexedSearchChunk({
      projectId,
      sourceKind: "openapi",
      chunkKind: "openapi_operation",
      path: "docs/api/web.openapi.yaml",
      title: "getAdminAcpRunners",
      content:
        'GET /api/admin/acp-runners {"operationId":"getAdminAcpRunners","summary":"List platform ACP runners"}',
      updatedAt: "2026-07-04T17:25:14.000Z",
    });

    const data = await loadProjectBrainPanelData(
      ctx.db as unknown as BrainUiDb,
      projectId,
      "getAdminAcpRunners",
    );

    expect(data.memory[0]).toMatchObject({
      kind: "openapi_operation",
      title: "getAdminAcpRunners",
    });
  });
});

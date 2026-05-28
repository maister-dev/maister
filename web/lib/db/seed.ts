import "dotenv/config";

import type { MaisterYamlV2 } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import pino from "pino";

import * as schemaModule from "./schema";

import { upsertExecutorsFromConfig } from "@/lib/executors";

// FIXME(any): dual drizzle-orm peer-dep variants (see schema.integration.test.ts).
const { flows, projects } = schemaModule as unknown as Record<string, any>;

const log = pino({ name: "db:seed" });

const DEV_PROJECT_SLUG = "maister-dev";

async function main() {
  const url = process.env.DB_URL;

  if (!url || !url.startsWith("postgres")) {
    log.error({ url }, "DB_URL must point at Postgres for seed");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    const existing = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, DEV_PROJECT_SLUG));

    if (existing.length > 0) {
      log.info(
        { slug: DEV_PROJECT_SLUG, id: existing[0].id },
        "seed skipped (project already exists)",
      );

      return;
    }

    const projectId = randomUUID();
    const flowId = randomUUID();

    const seedConfig: MaisterYamlV2 = {
      schemaVersion: 2,
      project: {
        name: "MAIster Dev",
        repo_path: "/repos/maister-dev",
        main_branch: "main",
        branch_prefix: "maister/",
      },
      executors: [
        { id: "claude-sonnet", agent: "claude", model: "claude-sonnet-4-6" },
        { id: "codex-default", agent: "codex", model: "gpt-5-codex" },
      ],
      default_executor: "claude-sonnet",
      flows: [
        {
          id: "bugfix",
          source: "github.com/maister/maister-flow-bugfix",
          version: "v0.0.1",
        },
      ],
    };

    await db.insert(projects).values({
      id: projectId,
      slug: DEV_PROJECT_SLUG,
      name: seedConfig.project.name,
      repoPath: seedConfig.project.repo_path,
      maisterYamlPath: "/repos/maister-dev/maister.yaml",
    });
    log.info(
      { table: "projects", id: projectId, slug: DEV_PROJECT_SLUG },
      "inserted",
    );

    await db.insert(flows).values({
      id: flowId,
      projectId,
      flowRefId: "bugfix",
      source: "github.com/maister/maister-flow-bugfix",
      version: "v0.0.1",
      installedPath: "/home/maister/.maister/flows/bugfix@v0.0.1",
      manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
      schemaVersion: 1,
    });
    log.info({ table: "flows", id: flowId, refId: "bugfix" }, "inserted");

    const { defaultExecutorId } = await upsertExecutorsFromConfig({
      projectId,
      config: seedConfig,
      db,
    });

    await db
      .update(projects)
      .set({ defaultExecutorId })
      .where(eq(projects.id, projectId));
    log.info(
      { table: "projects", id: projectId, defaultExecutorId },
      "updated default_executor_id",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  log.error({ err }, "seed failed");
  process.exit(1);
});

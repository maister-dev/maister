import "@/lib/load-env";

import { randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import pino from "pino";

import * as schemaModule from "./schema";

import { syncProjectFlowRolesFromConfig } from "@/lib/assignments/service";
import { routerSidecarPresetRows } from "@/lib/acp-runners/presets";

// FIXME(any): dual drizzle-orm peer-dep variants (see schema.integration.test.ts).
const { flows, platformRouterSidecars, projectMembers, projects, users } =
  schemaModule as unknown as Record<string, any>;

const log = pino({ name: "db:seed" });

const DEV_PROJECT_SLUG = "maister-dev";
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@maister.local";
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "maister-admin";

async function ensureAdminUser(
  db: ReturnType<typeof drizzle>,
): Promise<string> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, SEED_ADMIN_EMAIL));

  if (existing.length > 0) {
    log.info({ email: SEED_ADMIN_EMAIL, id: existing[0].id }, "admin exists");

    return existing[0].id;
  }

  const id = randomUUID();
  const passwordHash = await bcrypt.hash(SEED_ADMIN_PASSWORD, 12);

  await db.insert(users).values({
    id,
    name: "Admin",
    email: SEED_ADMIN_EMAIL,
    passwordHash,
    role: "admin",
    mustChangePassword: true,
  });
  log.info({ table: "users", id, email: SEED_ADMIN_EMAIL }, "inserted admin");

  return id;
}

async function ensurePlatformRuntimeDefaults(
  db: ReturnType<typeof drizzle>,
): Promise<void> {
  await db
    .insert(platformRouterSidecars)
    .values(routerSidecarPresetRows())
    .onConflictDoNothing();

  // ADR-094: the preset catalog is no longer seeded into platform_acp_runners,
  // and the platform_runtime_settings singleton is no longer seeded either —
  // both the default runners and the singleton (`default_runner_id` is NOT NULL)
  // are materialized by reconcilePlatformRunners at the first admin /settings
  // load, once a Ready native default exists.
  log.info(
    { sidecarId: "ccr-default" },
    "platform runtime defaults ensured (runners + default materialize on settings load)",
  );
}

async function main() {
  const url = process.env.DB_URL;

  if (!url || !url.startsWith("postgres")) {
    log.error({ url }, "DB_URL must point at Postgres for seed");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    const adminUserId = await ensureAdminUser(db);

    await ensurePlatformRuntimeDefaults(db);

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

    const seedConfig = {
      project: {
        name: "MAIster Dev",
        repo_path: "/repos/maister-dev",
        main_branch: "main",
        branch_prefix: "maister/",
        default_runner: "claude-code",
      },
      flow_roles: [{ ref: "maintainer", label: "Maintainer" }],
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
      defaultRunnerId: seedConfig.project.default_runner,
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

    await syncProjectFlowRolesFromConfig({
      db,
      projectId,
      roles: seedConfig.flow_roles,
    });
    log.info(
      {
        table: "project_flow_roles",
        projectId,
        roleCount: seedConfig.flow_roles.length,
      },
      "synced flow roles",
    );

    await db.insert(projectMembers).values({
      id: randomUUID(),
      projectId,
      userId: adminUserId,
      role: "owner",
    });
    log.info(
      { table: "project_members", projectId, userId: adminUserId },
      "inserted owner membership",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  log.error({ err }, "seed failed");
  process.exit(1);
});

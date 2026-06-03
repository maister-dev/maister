/**
 * T2.4 — installAndIngestCapabilityImports: register installs + upserts + R-SYM.
 *
 * Exercises the project-register phase-(d) capability path against a real DB:
 *  - each capability_imports[] entry is installed (capability_imports row)
 *  - the resolved import is ingested into capability_records as an
 *    `agent_definition` (source `flow-package`), alongside the capabilities block
 *  - R-SYM: removing the import on a re-run disables its capability_records row
 *    while the unrelated capabilities-block row stays selectable
 */
import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { installAndIngestCapabilityImports } from "@/lib/capabilities/import";
import { maisterYamlV2Schema } from "@/lib/config.schema";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;
const execFile = promisify(execFileCb);

async function gitRun(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

async function buildCapabilityFixture(
  parentDir: string,
  name: string,
): Promise<string> {
  const repoDir = join(parentDir, name);

  await mkdir(repoDir, { recursive: true });
  await gitRun(repoDir, ["init", "-q"]);
  await gitRun(repoDir, ["checkout", "-q", "-b", "main"]);
  await writeFile(join(repoDir, "README.md"), `# ${name}\n`);
  await gitRun(repoDir, ["add", "."]);
  await gitRun(repoDir, ["commit", "-q", "-m", "init v1.0.0"]);
  await gitRun(repoDir, ["tag", "v1.0.0"]);

  return repoDir;
}

function buildConfig(opts: {
  imports: Array<{ id: string; source: string; version: string }>;
}) {
  return maisterYamlV2Schema.parse({
    schemaVersion: 2,
    project: { name: "cap-ingest" },
    executors: [
      { id: "claude-sonnet", agent: "claude", model: "claude-sonnet-4-6" },
    ],
    default_executor: "claude-sonnet",
    capabilities: { skills: [{ id: "block-skill" }] },
    capability_imports: opts.imports,
    flows: [],
  });
}

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: any;
let homeDir: string;
let fixturesDir: string;
let originalHome: string | undefined;
let repoNoSetup: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("cap_ingest_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = join(tmpdir(), `cap-ingest-home-${randomUUID()}`);
  fixturesDir = join(tmpdir(), `cap-ingest-fixtures-${randomUUID()}`);
  await mkdir(homeDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });

  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  repoNoSetup = await buildCapabilityFixture(fixturesDir, "cap-no-setup");
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(fixturesDir, { recursive: true, force: true });
});

let projectId: string;

beforeEach(async () => {
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `cap-ingest-${projectId.slice(0, 8)}`,
    name: "Cap Ingest",
    repoPath: join(fixturesDir, projectId),
    maisterYamlPath: join(fixturesDir, projectId, "maister.yaml"),
  });
});

async function records(): Promise<
  Array<{
    capabilityRefId: string;
    kind: string;
    source: string;
    selectable: boolean;
    disabledAt: Date | null;
    revision: string | null;
  }>
> {
  return db
    .select({
      capabilityRefId: schema.capabilityRecords.capabilityRefId,
      kind: schema.capabilityRecords.kind,
      source: schema.capabilityRecords.source,
      selectable: schema.capabilityRecords.selectable,
      disabledAt: schema.capabilityRecords.disabledAt,
      revision: schema.capabilityRecords.revision,
    })
    .from(schema.capabilityRecords)
    .where(eq(schema.capabilityRecords.projectId, projectId));
}

describe("installAndIngestCapabilityImports", () => {
  it("installs each import and ingests it as a flow-package agent_definition record", async () => {
    await installAndIngestCapabilityImports({
      config: buildConfig({
        imports: [{ id: "aif-skills", source: repoNoSetup, version: "v1.0.0" }],
      }),
      projectId,
      db,
    });

    // capability_imports row recorded + installed.
    const imports = await db
      .select()
      .from(schema.capabilityImports)
      .where(
        and(
          eq(schema.capabilityImports.projectId, projectId),
          eq(schema.capabilityImports.capabilityRefId, "aif-skills"),
        ),
      );

    expect(imports).toHaveLength(1);
    expect(imports[0].packageStatus).toBe("Installed");
    expect(imports[0].resolvedRevision).toMatch(/^[0-9a-f]{40}$/);

    const rows = await records();
    const imported = rows.find((r) => r.capabilityRefId === "aif-skills");

    expect(imported).toMatchObject({
      kind: "agent_definition",
      source: "flow-package",
      selectable: true,
      disabledAt: null,
    });
    expect(imported!.revision).toBe(imports[0].resolvedRevision);

    // the capabilities-block skill is ingested alongside the import.
    const blockSkill = rows.find((r) => r.capabilityRefId === "block-skill");

    expect(blockSkill).toMatchObject({
      kind: "skill",
      source: "project",
      selectable: true,
    });
  });

  it("R-SYM: removing an import on a re-run disables its record but keeps block records", async () => {
    // First run: with the import.
    await installAndIngestCapabilityImports({
      config: buildConfig({
        imports: [{ id: "aif-skills", source: repoNoSetup, version: "v1.0.0" }],
      }),
      projectId,
      db,
    });

    // Second run: import removed, block kept.
    await installAndIngestCapabilityImports({
      config: buildConfig({ imports: [] }),
      projectId,
      db,
    });

    const rows = await records();
    const imported = rows.find((r) => r.capabilityRefId === "aif-skills");

    // The stale import record is disabled (CLEAR), not deleted.
    expect(imported).toMatchObject({ selectable: false });
    expect(imported!.disabledAt).not.toBeNull();

    // The unrelated block skill stays selectable.
    const blockSkill = rows.find((r) => r.capabilityRefId === "block-skill");

    expect(blockSkill).toMatchObject({ selectable: true, disabledAt: null });
  });
});

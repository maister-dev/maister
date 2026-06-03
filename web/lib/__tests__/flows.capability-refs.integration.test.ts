/**
 * T1.4 — install/register-gate capability ref validation (M14).
 *
 * installFlowPlugin forwards the project capability registry to the manifest
 * loader, so a graph node settings ref absent from the registry is rejected at
 * install time (the register flow surfaces it as FLOW_INSTALL). Mirrors the
 * launch-gate rejection (route.capability-refs.integration.test.ts).
 */
import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { installFlowPlugin } from "@/lib/flows";

const schema = schemaModule as unknown as Record<string, any>;
const execFile = promisify(execFileCb);

const GRAPH_FLOW_YAML = `schemaVersion: 1
name: Cap Ref Flow
compat:
  engine_min: "1.1.0"
nodes:
  - id: implement
    type: ai_coding
    action:
      prompt: "/aif-implement"
    settings:
      skills:
        - needed-skill
    transitions:
      success: done
`;

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

async function buildGraphFlowFixture(parentDir: string): Promise<string> {
  const repoDir = join(parentDir, "cap-ref-flow");

  await mkdir(repoDir, { recursive: true });
  await gitRun(repoDir, ["init", "-q"]);
  await gitRun(repoDir, ["checkout", "-q", "-b", "main"]);
  await writeFile(join(repoDir, "flow.yaml"), GRAPH_FLOW_YAML);
  await gitRun(repoDir, ["add", "."]);
  await gitRun(repoDir, ["commit", "-q", "-m", "init v1.0.0"]);
  await gitRun(repoDir, ["tag", "v1.0.0"]);

  return repoDir;
}

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: any;
let homeDir: string;
let workspaceRoot: string;
let fixturesDir: string;
let flowRepo: string;
let projectId: string;
let originalHome: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("flows_capref_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "flows-capref-home-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "flows-capref-ws-"));
  fixturesDir = await mkdtemp(join(tmpdir(), "flows-capref-fixtures-"));

  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  flowRepo = await buildGraphFlowFixture(fixturesDir);

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    slug: "capref-app",
    name: "CapRef App",
    repoPath: workspaceRoot,
    maisterYamlPath: join(workspaceRoot, "maister.yaml"),
  });
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(fixturesDir, { recursive: true, force: true });
});

describe("installFlowPlugin — capability ref validation (M14 T1.4)", () => {
  it("rejects a graph node ref absent from the supplied capabilityRefIds", async () => {
    let caught: unknown;

    try {
      await installFlowPlugin({
        source: flowRepo,
        version: "v1.0.0",
        projectId,
        projectSlug: "capref-app",
        flowId: "unknown-ref-flow",
        workspaceRoot,
        capabilityRefIds: {
          mcp: [],
          skill: [], // "needed-skill" absent → reject
          restriction: [],
          setting: [],
        },
        db,
      });
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { message: string }).message).toContain("needed-skill");
  });

  it("installs when the ref is present in the supplied capabilityRefIds", async () => {
    const result = await installFlowPlugin({
      source: flowRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "capref-app",
      flowId: "known-ref-flow",
      workspaceRoot,
      capabilityRefIds: {
        mcp: [],
        skill: ["needed-skill"],
        restriction: [],
        setting: [],
      },
      db,
    });

    expect(result.manifest.name).toBe("Cap Ref Flow");
  });

  it("installs with no capabilityRefIds supplied (back-compat: no ref check)", async () => {
    const result = await installFlowPlugin({
      source: flowRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "capref-app",
      flowId: "no-check-flow",
      workspaceRoot,
      db,
    });

    expect(result.manifest.name).toBe("Cap Ref Flow");
  });
});

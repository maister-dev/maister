import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { atomicWriteJson } from "@/lib/atomic";
import { loadProjectConfig, validateFormSchemaVersion } from "@/lib/config";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { upsertExecutorsFromConfig } from "@/lib/executors";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let workDir: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("foundation_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  workDir = await mkdtemp(join(tmpdir(), "foundation-test-"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  await rm(workDir, { recursive: true, force: true });
});

describe("foundation cross-module", () => {
  it("loads project config, persists via Drizzle, writes/reads HITL artifact atomically, version-checks form schema", async () => {
    const maisterYamlPath = join(workDir, "maister.yaml");
    const yamlContent = `
schemaVersion: 2
project:
  name: foundation-app
  repo_path: /repos/foundation-app
  main_branch: main
  branch_prefix: maister/
executors:
  - id: claude-sonnet
    agent: claude
    model: claude-sonnet-4-6
  - id: codex-default
    agent: codex
    model: gpt-5-codex
default_executor: claude-sonnet
flows:
  - id: bugfix
    source: github.com/x/y
    version: v1.0.0
`;

    await writeFile(maisterYamlPath, yamlContent, "utf8");

    const cfg = await loadProjectConfig(maisterYamlPath);

    expect(cfg.project.name).toBe("foundation-app");
    expect(cfg.executors).toHaveLength(2);

    const projectId = randomUUID();
    const flowId = randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      slug: "foundation-app",
      name: cfg.project.name,
      repoPath: cfg.project.repo_path,
      mainBranch: cfg.project.main_branch,
      branchPrefix: cfg.project.branch_prefix,
      maisterYamlPath,
    });

    const { executorIdByRef } = await upsertExecutorsFromConfig({
      projectId,
      config: cfg,
      db,
    });

    expect(executorIdByRef["claude-sonnet"]).toBeDefined();
    expect(executorIdByRef["codex-default"]).toBeDefined();

    await db.insert(schema.flows).values({
      id: flowId,
      projectId,
      flowRefId: "bugfix",
      source: "github.com/x/y",
      version: "v1.0.0",
      installedPath: "/tmp/flows/bugfix",
      manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
      schemaVersion: 1,
    });

    const runId = randomUUID();
    const needsInputPath = join(
      workDir,
      ".maister",
      "foundation-app",
      "runs",
      runId,
      "needs-input.json",
    );
    const formPayload = {
      schemaVersion: 1,
      fields: [
        { name: "comment", type: "string", required: true },
        { name: "confirm", type: "boolean", default: false },
      ],
    };

    await atomicWriteJson(needsInputPath, formPayload);

    const raw = await readFile(needsInputPath, "utf8");
    const readBack = JSON.parse(raw);

    expect(() => validateFormSchemaVersion(readBack, 1)).not.toThrow();

    let caught: unknown;

    try {
      validateFormSchemaVersion(readBack, 2);
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect(caught instanceof Error ? caught.message : "").toContain(
      "version mismatch",
    );
  });
});

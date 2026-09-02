import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFlowFixture } from "./_fixtures/build-flow-plugin";

import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { installFlowPlugin } from "@/lib/flows";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;

let db: any;
let homeDir: string;
let workspaceRoot: string;
let fixturesDir: string;
let validRepo: string;
let invalidRepo: string;
let setupFailRepo: string;
let projectId: string;
let originalHome: string | undefined;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "flows_test",
  });
  db = testDatabase.db;

  homeDir = await mkdtemp(join(tmpdir(), "flows-test-home-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "flows-test-ws-"));
  fixturesDir = await mkdtemp(join(tmpdir(), "flows-test-fixtures-"));

  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  validRepo = await buildFlowFixture(fixturesDir, "valid");
  invalidRepo = await buildFlowFixture(fixturesDir, "invalid-manifest");
  setupFailRepo = await buildFlowFixture(fixturesDir, "with-setup-fail");

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "demo-app",
    name: "Demo App",
    repoPath: workspaceRoot,
    maisterYamlPath: join(workspaceRoot, "maister.yaml"),
  });
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  await testDatabase?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(fixturesDir, { recursive: true, force: true });
});

describe("installFlowPlugin (integration)", () => {
  it("installs a valid flow plugin end-to-end: clone, manifest, symlink, db upsert", async () => {
    const result = await installFlowPlugin({
      source: validRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "valid-flow",
      workspaceRoot,
      db,
    });

    // Cache key is now the resolved git SHA (12-char prefix), not the
    // tag — tag movement on the upstream repo doesn't affect in-flight
    // runs because each install lands at a content-addressed directory.
    expect(result.installedPath).toMatch(
      new RegExp(`^${homeDir}/\\.maister/flows/valid-flow@[0-9a-f]{12}$`),
    );
    expect(result.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(result.symlinkPath).toBe(
      `${workspaceRoot}/.maister/demo-app/flows/valid-flow`,
    );
    expect(result.manifest.name).toBe("Test Flow");

    const flowYamlStat = await stat(`${result.installedPath}/flow.yaml`);

    expect(flowYamlStat.isFile()).toBe(true);

    const linkTarget = await readlink(result.symlinkPath);

    expect(linkTarget).toBe(result.installedPath);

    const [row] = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.id, result.flowRowId));

    expect(row.flowRefId).toBe("valid-flow");
    expect(row.version).toBe("v1.0.0");
    expect(row.revision).toBe(result.revision);
    expect(row.installedPath).toBe(result.installedPath);
    expect(row.manifest.runner_profiles).toHaveProperty("claude-default");
  });

  it("ADR-088: local-source install honors resolvedRevisionOverride (cache key + row revision)", async () => {
    const localDir = join(fixturesDir, "local-override-pkg");

    await mkdir(localDir, { recursive: true });
    await writeFile(
      join(localDir, "flow.yaml"),
      "schemaVersion: 1\nname: Local Override Flow\ncompat:\n  engine_min: 1.1.0\nnodes:\n  - id: step1\n    type: cli\n    action:\n      command: echo hi\n    transitions:\n      success: done\n",
      "utf8",
    );

    const override = "abcdef0123456789abcdef0123456789abcdef01";
    const result = await installFlowPlugin({
      source: localDir,
      version: "local-dev",
      projectId,
      projectSlug: "demo-app",
      flowId: "override-flow",
      workspaceRoot,
      db,
      resolvedRevisionOverride: override,
    });

    expect(result.revision).toBe(override);
    expect(result.installedPath).toBe(
      `${homeDir}/.maister/flows/override-flow@abcdef012345`,
    );

    const [revRow] = await db
      .select()
      .from(schema.flowRevisions)
      .where(eq(schema.flowRevisions.resolvedRevision, override));

    expect(revRow.flowRefId).toBe("override-flow");

    // No-override regression: a second local install WITHOUT the override
    // falls back to the content digest (different revision, same content).
    const plain = await installFlowPlugin({
      source: localDir,
      version: "local-dev2",
      projectId,
      projectSlug: "demo-app",
      flowId: "override-flow-plain",
      workspaceRoot,
      db,
    });

    expect(plain.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(plain.revision).not.toBe(override);
  });

  it("idempotent reinstall: same flowId@version skips clone, row id stable", async () => {
    const first = await installFlowPlugin({
      source: validRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "stable-id",
      workspaceRoot,
      db,
    });
    const mtimeBefore = (await stat(first.installedPath)).mtimeMs;

    await new Promise((r) => setTimeout(r, 50));

    const second = await installFlowPlugin({
      source: validRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "stable-id",
      workspaceRoot,
      db,
    });
    const mtimeAfter = (await stat(first.installedPath)).mtimeMs;

    expect(second.flowRowId).toBe(first.flowRowId);
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("rejects an invalid flow.yaml with FLOW_INSTALL", async () => {
    try {
      await installFlowPlugin({
        source: invalidRepo,
        version: "v1.0.0",
        projectId,
        projectSlug: "demo-app",
        flowId: "bad-manifest",
        workspaceRoot,
        db,
      });
      throw new Error("expected installFlowPlugin to throw");
    } catch (err) {
      if (!isMaisterError(err)) throw err;
      expect(err.code).toBe("FLOW_INSTALL");
      expect(err.message.toLowerCase()).toMatch(/schemaversion|invalid/);
    }
  });

  it("rejects a non-root form schema reference on the direct install path", async () => {
    const directFlowDir = join(fixturesDir, "direct-schema-root-only");

    await mkdir(directFlowDir, { recursive: true });
    // Graph-only since ADR-131: a legacy `steps[]` manifest is refused during
    // classification, well before the form-schema root check this case is about.
    await writeFile(
      join(directFlowDir, "flow.yaml"),
      `schemaVersion: 1
name: Direct Schema Root Only
compat:
  engine_min: 1.1.0
nodes:
  - id: review
    type: form
    settings:
      form_schema: README.json
    transitions:
      success: finish
  - id: finish
    type: cli
    action:
      command: "echo done"
    transitions:
      success: done
`,
      "utf8",
    );
    await writeFile(
      join(directFlowDir, "README.json"),
      JSON.stringify({
        schemaVersion: 1,
        fields: [{ name: "approved", type: "boolean" }],
      }),
      "utf8",
    );

    await expect(
      installFlowPlugin({
        source: directFlowDir,
        version: "local-dev",
        projectId,
        projectSlug: "demo-app",
        flowId: "direct-schema-root-only",
        workspaceRoot,
        db,
      }),
    ).rejects.toMatchObject({
      code: "FLOW_INSTALL",
      message:
        "package form schema reference must resolve to root schemas/<name>.json: README.json",
    });
  });

  // ADR-162 (AC-13): a schema document using the `json` field type or typed
  // array `items` needs compat.engine_min >= 3.6.0. The manifest and the
  // document only meet at install, so that is where the refusal lives.
  async function writeJsonTypeFlow(
    name: string,
    engineMin: string,
  ): Promise<string> {
    const dir = join(fixturesDir, name);

    await mkdir(join(dir, "schemas"), { recursive: true });
    await writeFile(
      join(dir, "flow.yaml"),
      `schemaVersion: 1
name: ${name}
compat:
  engine_min: "${engineMin}"
nodes:
  - id: plan
    type: ai_coding
    action:
      prompt: "plan"
    output:
      result:
        schema: ./schemas/out.json
    transitions:
      success: done
`,
      "utf8",
    );
    await writeFile(
      join(dir, "schemas", "out.json"),
      JSON.stringify({
        schemaVersion: 1,
        fields: [{ name: "payload", type: "json", required: true }],
      }),
      "utf8",
    );

    return dir;
  }

  it("rejects a json/items schema document below the 3.6.0 floor with FLOW_INSTALL", async () => {
    const dir = await writeJsonTypeFlow("json-schema-old-engine", "3.5.0");

    await expect(
      installFlowPlugin({
        source: dir,
        version: "local-dev",
        projectId,
        projectSlug: "demo-app",
        flowId: "json-schema-old-engine",
        workspaceRoot,
        db,
      }),
    ).rejects.toMatchObject({
      code: "FLOW_INSTALL",
      message: expect.stringContaining("3.6.0"),
    });
  });

  it("installs the same json schema document at engine_min 3.6.0", async () => {
    const dir = await writeJsonTypeFlow("json-schema-new-engine", "3.6.0");

    const installed = await installFlowPlugin({
      source: dir,
      version: "local-dev",
      projectId,
      projectSlug: "demo-app",
      flowId: "json-schema-new-engine",
      workspaceRoot,
      db,
    });

    expect(installed).toBeTruthy();
  });

  // ADR-165 AC-02 / spec C-5.2. The package's `result_profiles` are resolved at
  // INSTALL and written to `flow_revisions.result_profiles` for every member
  // flow, in the SAME statement that finalizes the revision (W7). A bad profile
  // fails the install and leaves NO partial map.
  describe("result_profiles materialization (ADR-165)", () => {
    async function writeProfileFlow(args: {
      name: string;
      engineMin?: string;
      schemaBody?: unknown;
      /** Omit to skip writing the schema file entirely (the ENOENT arm). */
      writeSchema?: boolean;
    }): Promise<string> {
      const dir = join(fixturesDir, args.name);

      await mkdir(join(dir, "schemas"), { recursive: true });
      await writeFile(
        join(dir, "flow.yaml"),
        `schemaVersion: 1
name: ${args.name}
compat:
  engine_min: "${args.engineMin ?? "3.7.0"}"
nodes:
  - id: plan
    type: ai_coding
    action:
      prompt: "plan"
    transitions:
      success: done
`,
        "utf8",
      );
      if (args.writeSchema !== false) {
        await writeFile(
          join(dir, "schemas", "research-result.v1.json"),
          typeof args.schemaBody === "string"
            ? args.schemaBody
            : JSON.stringify(
                args.schemaBody ?? {
                  schemaVersion: 3,
                  fields: [{ name: "summary", type: "string", required: true }],
                },
              ),
          "utf8",
        );
      }

      return dir;
    }

    async function installWithProfiles(args: {
      dir: string;
      flowId: string;
      profiles: Record<string, { schema: string }>;
    }) {
      return installFlowPlugin({
        source: args.dir,
        version: "local-dev",
        projectId,
        projectSlug: "demo-app",
        flowId: args.flowId,
        workspaceRoot,
        resultProfiles: args.profiles,
        db,
      });
    }

    async function revisionProfiles(flowRefId: string): Promise<unknown> {
      const rows = await db
        .select({ p: schema.flowRevisions.resultProfiles })
        .from(schema.flowRevisions)
        .where(eq(schema.flowRevisions.flowRefId, flowRefId));

      return rows[0]?.p ?? null;
    }

    it("writes the resolved map on the revision row", async () => {
      const dir = await writeProfileFlow({ name: "rp-ok" });

      await installWithProfiles({
        dir,
        flowId: "rp-ok",
        profiles: { research: { schema: "./schemas/research-result.v1.json" } },
      });

      expect(await revisionProfiles("rp-ok")).toEqual({
        research: {
          schemaPath: "./schemas/research-result.v1.json",
          schemaStem: "research-result.v1",
          // Read from the document, not from the declaration.
          schemaVersion: 3,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          schema: {
            schemaVersion: 3,
            fields: [{ name: "summary", type: "string", required: true }],
          },
        },
      });
    });

    it("leaves the column NULL when the package declares none", async () => {
      const dir = await writeProfileFlow({ name: "rp-none" });

      await installFlowPlugin({
        source: dir,
        version: "local-dev",
        projectId,
        projectSlug: "demo-app",
        flowId: "rp-none",
        workspaceRoot,
        db,
      });

      expect(await revisionProfiles("rp-none")).toBeNull();
    });

    const BAD: Array<{
      label: string;
      flowId: string;
      profiles: Record<string, { schema: string }>;
      contains: string;
      write?: Partial<Parameters<typeof writeProfileFlow>[0]>;
    }> = [
      {
        label: "a missing file",
        flowId: "rp-missing",
        profiles: { research: { schema: "./schemas/research-result.v1.json" } },
        contains: "research",
        write: { writeSchema: false },
      },
      {
        label: "a malformed document",
        flowId: "rp-malformed",
        profiles: { research: { schema: "./schemas/research-result.v1.json" } },
        contains: "research",
        write: { schemaBody: "{ not json" },
      },
      {
        label: "a document failing the form_schema grammar",
        flowId: "rp-badshape",
        profiles: { research: { schema: "./schemas/research-result.v1.json" } },
        contains: "research",
        write: { schemaBody: { schemaVersion: 1, fields: "nope" } },
      },
      {
        label: "an escaping path",
        flowId: "rp-escape",
        profiles: { research: { schema: "./schemas/../flow.yaml" } },
        contains: "package-root",
      },
      {
        label: "a non-root path",
        flowId: "rp-nonroot",
        profiles: { research: { schema: "./nested/schemas/x.json" } },
        contains: "package-root",
      },
    ];

    it.each(BAD)(
      "fails the install on $label, leaving NO partial map",
      async ({ flowId, profiles, contains, write }) => {
        const dir = await writeProfileFlow({ name: flowId, ...(write ?? {}) });

        await expect(
          installWithProfiles({ dir, flowId, profiles }),
        ).rejects.toMatchObject({
          code: "FLOW_INSTALL",
          message: expect.stringContaining(contains),
        });

        // The revision exists (the intent row is written first) but is Failed,
        // and its profile map was never partially populated.
        const rows = await db
          .select({
            p: schema.flowRevisions.resultProfiles,
            status: schema.flowRevisions.packageStatus,
          })
          .from(schema.flowRevisions)
          .where(eq(schema.flowRevisions.flowRefId, flowId));

        expect(rows[0]?.p ?? null).toBeNull();
        expect(rows[0]?.status).toBe("Failed");
      },
    );

    it("fails the install when a profile document uses json/items below the member flow's floor", async () => {
      const dir = await writeProfileFlow({
        name: "rp-floor",
        engineMin: "3.5.0",
        schemaBody: {
          schemaVersion: 1,
          fields: [{ name: "payload", type: "json", required: true }],
        },
      });

      await expect(
        installWithProfiles({
          dir,
          flowId: "rp-floor",
          profiles: {
            research: { schema: "./schemas/research-result.v1.json" },
          },
        }),
      ).rejects.toMatchObject({
        code: "FLOW_INSTALL",
        message: expect.stringContaining("3.6.0"),
      });
    });
  });

  it("rejects a non-existent tag with FLOW_INSTALL carrying git stderr", async () => {
    try {
      await installFlowPlugin({
        source: validRepo,
        version: "v99.0.0",
        projectId,
        projectSlug: "demo-app",
        flowId: "no-such-tag",
        workspaceRoot,
        db,
      });
      throw new Error("expected installFlowPlugin to throw");
    } catch (err) {
      if (!isMaisterError(err)) throw err;
      expect(err.code).toBe("FLOW_INSTALL");
      // M10 (ADR-021): structured stage-tagged FLOW_INSTALL message that still
      // carries the underlying git stderr after the command/exitStatus prefix.
      expect(err.message).toMatch(/flow install failed \[stage=clone\]/);
    }
  });

  it("upgrade install (v1.0.0 -> v1.1.0): same row id, updated fields, repointed symlink, createdAt preserved", async () => {
    const before = await installFlowPlugin({
      source: validRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "upgradable",
      workspaceRoot,
      db,
    });

    expect(before.manifest.runner_profiles).toHaveProperty("claude-default");

    const [beforeRow] = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.id, before.flowRowId));

    await new Promise((r) => setTimeout(r, 50));

    const after = await installFlowPlugin({
      source: validRepo,
      version: "v1.1.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "upgradable",
      workspaceRoot,
      db,
    });

    expect(after.flowRowId).toBe(before.flowRowId);
    expect(after.installedPath).toMatch(
      new RegExp(`^${homeDir}/\\.maister/flows/upgradable@[0-9a-f]{12}$`),
    );
    // Upgrade lands at a different SHA-keyed directory; the old
    // bundle is untouched on disk so in-flight runs pinned to the
    // prior revision keep reading their original bytes.
    expect(after.installedPath).not.toBe(before.installedPath);
    expect(after.revision).not.toBe(before.revision);
    expect(after.manifest.runner_profiles).toHaveProperty("claude-glm");

    const linkTarget = await readlink(after.symlinkPath);

    expect(linkTarget).toBe(after.installedPath);

    const [afterRow] = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.id, after.flowRowId));

    expect(afterRow.createdAt.getTime()).toBe(beforeRow.createdAt.getTime());
  });

  it("setup.sh exit 0: install completes, sentinel written, second install skips setup.sh (sentinel mtime unchanged)", async () => {
    const setupOkRepo = await buildFlowFixture(fixturesDir, "with-setup-ok");
    const result1 = await installFlowPlugin({
      source: setupOkRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "setup-ok-once",
      workspaceRoot,
      db,
    });

    const sentinelPath = `${result1.installedPath}/.maister-setup-done`;
    const sentinelStat = await stat(sentinelPath);

    expect(sentinelStat.isFile()).toBe(true);
    const mtimeBefore = sentinelStat.mtimeMs;

    await new Promise((r) => setTimeout(r, 50));

    const result2 = await installFlowPlugin({
      source: setupOkRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "setup-ok-once",
      workspaceRoot,
      db,
    });
    const mtimeAfter = (await stat(sentinelPath)).mtimeMs;

    expect(result2.flowRowId).toBe(result1.flowRowId);
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("setup.sh non-zero exit (trusted_by_policy): revision installed but not enabled", async () => {
    const result = await installFlowPlugin({
      source: setupFailRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "setup-fails",
      workspaceRoot,
      db,
    });

    expect(result.flowRowId).toBeTruthy();
    expect(result.installedPath).toMatch(
      new RegExp(`^${homeDir}/\\.maister/flows/setup-fails@[0-9a-f]{12}$`),
    );
    // M10 (ADR-021): setup.sh runs after trust (trusted_by_policy for a local
    // absolute source). A non-zero exit marks the revision Failed and leaves
    // the project enablement at "Installed" — it is NOT auto-enabled.
    expect(result.enablementState).toBe("Installed");

    const linkTarget = await readlink(result.symlinkPath);

    expect(linkTarget).toBe(result.installedPath);
  });

  it("concurrent installs (same project+flow+version) share one clone via dedup map", async () => {
    const args = {
      source: validRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "concurrent-flow",
      workspaceRoot,
      db,
    };
    const [r1, r2] = await Promise.all([
      installFlowPlugin(args),
      installFlowPlugin(args),
    ]);

    expect(r1.installedPath).toBe(r2.installedPath);
    expect(r1.flowRowId).toBe(r2.flowRowId);
  });
});

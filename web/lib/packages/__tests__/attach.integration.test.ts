import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { and, eq, sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { assertProjectFlowCapabilities } from "@/lib/flows/project-capability-refs";
import { resolveAgentProfileMcpServers } from "@/lib/agents/launch";
import {
  availableAgentMcpCatalog,
  captureProjectAgentProfile,
} from "@/lib/agents/project-instance-profile";
import { resolveEffectiveAgentDefinition } from "@/lib/agents/effective";
import { resolveCurrentPackageSessionCatalog } from "@/lib/capabilities/session-package-catalog";
import { resolveTaskLaunchCapabilities } from "@/lib/tasks/launch-capabilities";
import { capturePackageDelivery } from "@/lib/capabilities/capture-package-delivery";
import {
  resolvePackageSession,
  sessionNameForPackageNode,
} from "@/lib/capabilities/package-delivery";
import { materializeProjectBundlesIntoWorktree } from "@/lib/capabilities/materialize-bundle";
import {
  materializePackageSessionSkills,
  workspacePackageSkillsPrompt,
  witnessPackageSkillView,
} from "@/lib/capabilities/package-skills";
import { readAndValidateFormSchemaDoc } from "@/lib/config";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { classifyFlowForCut } from "@/lib/flows/manifest-parser";
import { LEGACY_STEPS_REFUSAL_MESSAGE } from "@/lib/flows/manifest-shape";
import {
  attachPackage,
  detachPackage,
  installPackageRevision,
  trustPackageRevision,
  upgradeAttachment,
} from "@/lib/packages/attach";
import {
  readPackageMcpScopes,
  setPackageMcpScope,
} from "@/lib/packages/mcp-scope";
import { connectPlatform, resolveBindTarget } from "@/lib/mcp/binding-service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let homeDir: string;
let workspaceRoot: string;
let pkgV1: string;
let pkgV2: string;
let projectId: string;
let originalHome: string | undefined;

const FLOW_YAML = (name: string): string =>
  `schemaVersion: 1\nname: ${name}\ncompat:\n  engine_min: 3.0.0\nnodes:\n  - id: s1\n    type: cli\n    action:\n      command: echo hi\n    transitions:\n      success: done\n`;

async function buildPackage(
  root: string,
  flows: string[],
  opts?: { mcps?: boolean },
): Promise<void> {
  for (const f of flows) {
    await mkdir(join(root, `flows/${f}`), { recursive: true });
    await writeFile(join(root, `flows/${f}/flow.yaml`), FLOW_YAML(f));
  }
  await mkdir(join(root, "capability/skills/skill-one"), { recursive: true });
  await mkdir(join(root, "capability/agents"), { recursive: true });
  await writeFile(join(root, "capability/skills/skill-one/SKILL.md"), "s\n");
  await writeFile(join(root, "capability/agents/agent-one.md"), "a\n");
  // Package-root maister-agents/ → inventory.platformAgents (distinct from the
  // capability subagents above).
  await mkdir(join(root, "maister-agents"), { recursive: true });
  await writeFile(join(root, "maister-agents/triager.md"), "t\n");
  await writeFile(
    join(root, "maister-package.yaml"),
    `schemaVersion: 1
name: attpkg
flows:
${flows.map((f) => `  - { id: ${f}, path: flows/${f} }`).join("\n")}
capabilities:
  - { id: att-bundle, path: capability }
${
  opts?.mcps === false
    ? ""
    : `mcps:
  - { id: att-mcp, transport: http, url: "https://mcp.example.com", env: ["env:ATT_TOKEN"] }
restrictions:
  - { id: att-protect, paths: ["docs/**"] }
`
}`,
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "attach_test",
  });
  db = testDatabase.db;

  homeDir = await mkdtemp(join(tmpdir(), "attach-int-home-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "attach-int-ws-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  pkgV1 = await mkdtemp(join(tmpdir(), "attach-int-v1-"));
  await buildPackage(pkgV1, ["flow-a", "flow-b"]);
  pkgV2 = await mkdtemp(join(tmpdir(), "attach-int-v2-"));
  await buildPackage(pkgV2, ["flow-a"]);

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "attach-int",
    name: "Attach Int",
    repoPath: workspaceRoot,
    maisterYamlPath: join(workspaceRoot, "maister.yaml"),
  });
}, 180_000);

// Temp package roots created by individual cases; removed with the shared ones.
const dirsToClean: string[] = [];

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await testDatabase?.stop();
  for (const dir of [homeDir, workspaceRoot, pkgV1, pkgV2, ...dirsToClean]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("package attach lifecycle (integration)", () => {
  let installV1: string;
  let installV2: string;
  let attachmentId: string;

  it("refuses a legacy member as CONFIG before creating an install row", async () => {
    const legacyPackage = await mkdtemp(join(tmpdir(), "attach-int-legacy-"));

    try {
      await buildPackage(legacyPackage, ["legacy-flow"]);
      await writeFile(
        join(legacyPackage, "flows/legacy-flow/flow.yaml"),
        "schemaVersion: 1\nname: legacy-flow\nsteps: []\n",
      );
      const before = await db.select().from(schema.packageInstalls);

      await expect(
        installPackageRevision({
          source: legacyPackage,
          version: "attpkg/v0.9.0",
          db,
        }),
      ).rejects.toMatchObject({
        code: "CONFIG",
        message: LEGACY_STEPS_REFUSAL_MESSAGE,
      });

      const after = await db.select().from(schema.packageInstalls);

      expect(after).toHaveLength(before.length);
    } finally {
      await rm(legacyPackage, { recursive: true, force: true });
    }
  });

  it("accepts published node-skill declarations through install, attach and rollback without rewriting the cut", async () => {
    const projectId = await seedProject("retired-node-skills");
    const roots = await Promise.all([
      mkdtemp(join(workspaceRoot, "retired-node-skills-old-")),
      mkdtemp(join(workspaceRoot, "retired-node-skills-new-")),
    ]);
    const flowId = "retired-node-skills";
    const memberPath = `flows/${flowId}/flow.yaml`;
    const legacyYaml = `schemaVersion: 1
name: ${flowId}
compat: {engine_min: '3.0.0'}
nodes:
  - id: s1
    type: ai_coding
    action: {prompt: legacy skill}
    settings: {skills: [skill-one], enforcement: {skills: strict}}
    transitions: {success: done}
`;

    await Promise.all(roots.map((root) => buildPackage(root, [flowId])));
    await writeFile(join(roots[0], memberPath), legacyYaml);
    expect(classifyFlowForCut(parseYaml(legacyYaml)).compatible).toBe(false);
    const [previous, current] = await Promise.all(
      roots.map((source, index) =>
        installPackageRevision({
          source,
          version: `attpkg/node-skills-v${index + 1}`,
          trustStatus: "trusted_by_policy",
          db,
        }),
      ),
    );
    const args = {
      db,
      projectId,
      projectSlug: "retired-node-skills",
      workspaceRoot,
    };
    const attached = await attachPackage({
      ...args,
      packageInstallId: previous.id,
    });

    if (!attached) throw new Error("Legacy attachment was not created");
    for (const packageInstallId of [current.id, previous.id]) {
      expect(
        await upgradeAttachment({
          ...args,
          attachmentId: attached.attachmentId,
          packageInstallId,
        }),
      ).toEqual({ upgraded: true });
    }
    const [flow] = await db
      .select()
      .from(schema.flows)
      .where(
        and(
          eq(schema.flows.projectId, projectId),
          eq(schema.flows.flowRefId, flowId),
        ),
      );

    expect(flow).toMatchObject({
      packageInstallId: previous.id,
      revision: previous.resolvedRevision,
      manifest: {
        nodes: [
          {
            settings: {
              skills: ["skill-one"],
              enforcement: { skills: "strict" },
            },
          },
        ],
      },
    });
    expect(await readFile(join(flow.installedPath, "flow.yaml"), "utf8")).toBe(
      legacyYaml,
    );
  });

  it("installPackageRevision: two-phase install + idempotent reuse", async () => {
    const first = await installPackageRevision({
      source: pkgV1,
      version: "attpkg/v1.0.0",
      trustStatus: "trusted_by_policy",
      db,
    });

    expect(first.reused).toBe(false);
    installV1 = first.id;
    await db
      .update(schemaModule.packageInstalls)
      .set({ manifest: sql`manifest #- '{inventory,skillsByCapability}'` })
      .where(eq(schemaModule.packageInstalls.id, installV1));

    const again = await installPackageRevision({
      source: pkgV1,
      version: "attpkg/v1.0.0",
      db,
    });

    expect(again.reused).toBe(true);
    expect(again.id).toBe(installV1);

    const [row] = await db
      .select()
      .from(schema.packageInstalls)
      .where(eq(schema.packageInstalls.id, installV1));

    expect(row.packageStatus).toBe("Installed");
    expect(row.manifest.inventory).toEqual({
      skills: ["skill-one"],
      skillsByCapability: { "att-bundle": ["skill-one"] },
      agents: ["agent-one"],
      platformAgents: ["triager"],
    });

    const second = await installPackageRevision({
      source: pkgV2,
      version: "attpkg/v2.0.0",
      trustStatus: "trusted_by_policy",
      db,
    });

    installV2 = second.id;
    expect(installV2).not.toBe(installV1);
  });

  it("copies package-root schemas into every member revision and heals a reused revision", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "attach-int-schemas-"));
    const flowIds = ["schema-review", "schema-publish"];

    try {
      await buildPackage(packageRoot, flowIds);
      await mkdir(join(packageRoot, "schemas"), { recursive: true });
      const schemaContent = JSON.stringify({
        schemaVersion: 1,
        fields: [{ name: "summary", type: "string", required: true }],
      });

      await writeFile(join(packageRoot, "schemas/review.json"), schemaContent);

      for (const flowId of flowIds) {
        await writeFile(
          join(packageRoot, `flows/${flowId}/flow.yaml`),
          `schemaVersion: 1
name: ${flowId}
compat:
  engine_min: 3.0.0
nodes:
  - id: collect
    type: form
    settings:
      form_schema: schemas/review.json
    transitions:
      success: done
`,
        );
      }

      const installed = await installPackageRevision({
        source: packageRoot,
        version: "attpkg/schema-v1.0.0",
        trustStatus: "trusted_by_policy",
        db,
      });
      const revisions = (await db
        .select()
        .from(schema.flowRevisions)
        .where(
          eq(schema.flowRevisions.resolvedRevision, installed.resolvedRevision),
        )) as Array<{
        flowRefId: string;
        installedPath: string;
      }>;
      const memberRevisions = revisions.filter((revision) =>
        flowIds.includes(revision.flowRefId),
      );
      const revisionToHeal = memberRevisions[0];

      expect(memberRevisions).toHaveLength(flowIds.length);
      if (!revisionToHeal) {
        throw new Error(
          "schema package did not install a member flow revision",
        );
      }
      const [cachedPackage] = (await db
        .select({ installedPath: schema.packageInstalls.installedPath })
        .from(schema.packageInstalls)
        .where(eq(schema.packageInstalls.id, installed.id))) as Array<{
        installedPath: string;
      }>;

      if (!cachedPackage) {
        throw new Error("schema package cache row is missing");
      }
      for (const revision of memberRevisions) {
        await expect(
          readAndValidateFormSchemaDoc(
            revision.installedPath,
            "./schemas/review.json",
          ),
        ).resolves.toMatchObject({ schemaVersion: 1 });
      }

      await rm(join(revisionToHeal.installedPath, "schemas/review.json"), {
        force: true,
      });
      await writeFile(
        join(cachedPackage.installedPath, "schemas/review.json"),
        JSON.stringify({ schemaVersion: 1, fields: [] }),
      );

      await expect(
        installPackageRevision({
          source: packageRoot,
          version: "attpkg/schema-v1.0.0",
          db,
        }),
      ).resolves.toMatchObject({ id: installed.id, reused: true });
      await expect(
        stat(join(revisionToHeal.installedPath, "schemas/review.json")),
      ).resolves.toBeDefined();
      await expect(
        readFile(
          join(cachedPackage.installedPath, "schemas/review.json"),
          "utf8",
        ),
      ).resolves.toBe(schemaContent);
      await expect(
        readAndValidateFormSchemaDoc(
          revisionToHeal.installedPath,
          "./schemas/review.json",
        ),
      ).resolves.toMatchObject({
        fields: [{ name: "summary", type: "string", required: true }],
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("preserves a member schema when its package has no root schema artifacts", async () => {
    const packageRoot = await mkdtemp(
      join(tmpdir(), "attach-int-legacy-schema-"),
    );

    try {
      await buildPackage(packageRoot, ["legacy-schema"]);
      await mkdir(join(packageRoot, "flows/legacy-schema/schemas"), {
        recursive: true,
      });
      await writeFile(
        join(packageRoot, "flows/legacy-schema/schemas/intake.json"),
        JSON.stringify({
          schemaVersion: 1,
          fields: [{ name: "summary", type: "string", required: true }],
        }),
      );
      await writeFile(
        join(packageRoot, "flows/legacy-schema/flow.yaml"),
        `schemaVersion: 1
name: legacy-schema
compat:
  engine_min: 3.0.0
nodes:
  - id: collect
    type: form
    settings:
      form_schema: ./schemas/intake.json
    transitions:
      success: done
`,
      );

      const installed = await installPackageRevision({
        source: packageRoot,
        version: "attpkg/legacy-schema-v1.0.0",
        trustStatus: "trusted_by_policy",
        db,
      });
      const [memberRevision] = (await db
        .select({ installedPath: schema.flowRevisions.installedPath })
        .from(schema.flowRevisions)
        .where(
          and(
            eq(
              schema.flowRevisions.resolvedRevision,
              installed.resolvedRevision,
            ),
            eq(schema.flowRevisions.flowRefId, "legacy-schema"),
          ),
        )) as Array<{ installedPath: string }>;

      expect(memberRevision).toBeDefined();
      if (!memberRevision) {
        throw new Error("legacy-schema member revision is missing");
      }
      const [cachedPackage] = (await db
        .select({ installedPath: schema.packageInstalls.installedPath })
        .from(schema.packageInstalls)
        .where(eq(schema.packageInstalls.id, installed.id))) as Array<{
        installedPath: string;
      }>;

      if (!cachedPackage) {
        throw new Error("legacy-schema package cache row is missing");
      }

      await expect(
        stat(join(cachedPackage.installedPath, "schemas/intake.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readAndValidateFormSchemaDoc(
          memberRevision.installedPath,
          "./schemas/intake.json",
        ),
      ).resolves.toMatchObject({
        fields: [{ name: "summary", type: "string", required: true }],
      });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("rejects a package member that bypasses the root schema reference contract", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "attach-int-nonroot-"));

    try {
      await buildPackage(packageRoot, ["nonroot-schema"]);
      await writeFile(
        join(packageRoot, "flows/nonroot-schema/flow.yaml"),
        `schemaVersion: 1
name: nonroot-schema
compat:
  engine_min: 3.0.0
nodes:
  - id: collect
    type: form
    settings:
      form_schema: README.json
    transitions:
      success: done
`,
      );
      await writeFile(
        join(packageRoot, "flows/nonroot-schema/README.json"),
        JSON.stringify({
          schemaVersion: 1,
          fields: [{ name: "summary", type: "string", required: true }],
        }),
      );

      await expect(
        installPackageRevision({
          source: packageRoot,
          version: "attpkg/nonroot-v1.0.0",
          trustStatus: "trusted_by_policy",
          db,
        }),
      ).rejects.toMatchObject({ code: "FLOW_INSTALL" });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("attachPackage: ONE tx writes flows + imports + ingestion + attachment (SET)", async () => {
    await db.insert(schema.projectDependencyDeclarations).values({
      projectId,
      kind: "package",
      logicalId: "project-alias",
      ordinal: 0,
      desired: { source: pkgV1, version: "attpkg/v1.0.0" },
    });
    const result = await attachPackage({
      projectId,
      projectSlug: "attach-int",
      packageInstallId: installV1,
      workspaceRoot,
      db,
    });

    expect(result).not.toBeNull();
    attachmentId = result!.attachmentId;

    const flowRows = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.projectId, projectId));

    expect(flowRows.map((f: any) => f.flowRefId).sort()).toEqual([
      "flow-a",
      "flow-b",
    ]);
    for (const row of flowRows) {
      expect(row.packageInstallId).toBe(installV1);
      expect(row.trustStatus).toBe("trusted_by_policy");
    }

    const imports = await db
      .select()
      .from(schema.capabilityImports)
      .where(eq(schema.capabilityImports.projectId, projectId));

    expect(imports).toHaveLength(1);
    expect(imports[0].packageInstallId).toBe(installV1);
    expect(imports[0].setupStatus).toMatch(/done|not_required/);

    const records = await db
      .select()
      .from(schema.capabilityRecords)
      .where(
        and(
          eq(schema.capabilityRecords.projectId, projectId),
          eq(schema.capabilityRecords.source, "flow-package"),
        ),
      );
    const byRef = new Map(records.map((r: any) => [r.capabilityRefId, r]));

    expect(byRef.get("skill-one")?.kind).toBe("skill");
    expect(byRef.get("skill-one")?.material).toMatchObject({
      origin: "package-attachment",
      packageInstallId: installV1,
    });
    expect(byRef.get("att-mcp")?.kind).toBe("mcp");
    expect(byRef.get("att-mcp")?.material).toMatchObject({
      origin: "package-attachment",
      transport: "http",
      url: "https://mcp.example.com",
      env: { ATT_TOKEN: "env:ATT_TOKEN" },
    });
    expect(byRef.get("att-protect")?.kind).toBe("restriction");
    expect(byRef.get("att-protect")?.material).toMatchObject({
      paths: ["docs/**"],
    });
  });

  it("re-attach refuses with CONFLICT (already attached)", async () => {
    await expect(
      attachPackage({
        projectId,
        projectSlug: "attach-int",
        packageInstallId: installV1,
        workspaceRoot,
        db,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFLICT",
    );
  });

  it("detach refuses with PRECONDITION while a member revision is run-pinned", async () => {
    const [memberFlow] = await db
      .select()
      .from(schema.flows)
      .where(
        and(
          eq(schema.flows.projectId, projectId),
          eq(schema.flows.flowRefId, "flow-a"),
        ),
      );
    const runId = randomUUID();

    await db.insert(schema.runs).values({
      id: runId,
      projectId,
      flowId: memberFlow.id,
      status: "Running",
      flowVersion: "attpkg-v1.0.0",
      flowRevisionId: memberFlow.enabledRevisionId,
    });

    await db
      .update(schema.projectDependencyDeclarations)
      .set({
        desired: { source: pkgV2, version: "replacement-pending" },
        generation: 2,
      })
      .where(
        eq(
          schema.projectDependencyDeclarations.effectiveAttachmentId,
          attachmentId,
        ),
      );
    await expect(
      detachPackage({ projectId, attachmentId, db }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "PRECONDITION",
    );

    const [pending] = await db
      .select()
      .from(schema.projectDependencyDeclarations)
      .where(
        eq(
          schema.projectDependencyDeclarations.effectiveAttachmentId,
          attachmentId,
        ),
      );
    expect(pending).toMatchObject({
      logicalId: "project-alias",
      generation: 2,
      effectiveGeneration: 1,
      desired: { version: "replacement-pending" },
    });

    await db.delete(schema.runs).where(eq(schema.runs.id, runId));
  });

  it.each([
    {
      name: "archived ended quiescent Crashed",
      status: "Crashed",
      change: "none",
      blocked: false,
    },
    {
      name: "upgrade preserves removed member history",
      status: "Crashed",
      change: "upgrade",
      blocked: false,
    },
    {
      name: "legacy archived evidence",
      status: "Crashed",
      change: "legacy",
      blocked: false,
    },
    {
      name: "snapshot missing its commit",
      status: "Crashed",
      change: "missing_commit",
      blocked: true,
    },
    {
      name: "shared reuser with archived allocator tree",
      status: "Crashed",
      change: "shared_reuser",
      blocked: false,
    },
    {
      name: "non-archived Crashed",
      status: "Crashed",
      change: "unarchived",
      blocked: true,
    },
    {
      name: "recoverable crash on an older package revision",
      status: "Crashed",
      change: "old_revision",
      blocked: true,
    },
    {
      name: "incomplete archival",
      status: "Crashed",
      change: "not_removed",
      blocked: true,
    },
    {
      name: "clean completed archive without Git refs",
      status: "Crashed",
      change: "clean",
      blocked: false,
    },
    {
      name: "legacy crash without an immutable revision",
      status: "Crashed",
      change: "unpinned",
      blocked: true,
    },
    {
      name: "missing run end",
      status: "Crashed",
      change: "not_ended",
      blocked: true,
    },
    {
      name: "another unarchived workspace",
      status: "Crashed",
      change: "extra_workspace",
      blocked: true,
    },
    {
      name: "archive in progress",
      status: "Crashed",
      change: "claiming",
      blocked: true,
    },
    {
      name: "failed archive claim",
      status: "Crashed",
      change: "failed",
      blocked: true,
    },
    {
      name: "concurrent recovery assignment",
      status: "Crashed",
      change: "assignment",
      blocked: true,
    },
    {
      name: "recovery commits while detach waits for the run lock",
      status: "Crashed",
      change: "concurrent",
      blocked: true,
    },
    {
      name: "live session without an active assignment",
      status: "Crashed",
      change: "session",
      blocked: true,
    },
    {
      name: "shared workspace has an active sibling",
      status: "Crashed",
      change: "shared",
      blocked: true,
    },
    {
      name: "Running with archive metadata",
      status: "Running",
      change: "none",
      blocked: true,
    },
    {
      name: "historical Failed",
      status: "Failed",
      change: "none",
      blocked: false,
    },
    {
      name: "historical Abandoned",
      status: "Abandoned",
      change: "none",
      blocked: false,
    },
    { name: "historical Done", status: "Done", change: "none", blocked: false },
  ])("package pins: $name", async ({ status, change, blocked }) => {
    const historicalProjectId = randomUUID();
    const root = await mkdtemp(join(tmpdir(), "attach-history-"));

    dirsToClean.push(root);
    const slug = `history-${historicalProjectId}`;

    await db.insert(schema.projects).values({
      id: historicalProjectId,
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      slug,
      name: "Package archive history",
      repoPath: root,
      maisterYamlPath: join(root, "maister.yaml"),
    });
    const installed = await installPackageRevision({
      source: pkgV1,
      version: "attpkg/history-v1.0.0",
      trustStatus: "trusted_by_policy",
      db,
    });
    const attached = await attachPackage({
      projectId: historicalProjectId,
      projectSlug: slug,
      packageInstallId: installed.id,
      workspaceRoot: root,
      db,
    });

    expect(attached).not.toBeNull();
    const [flow] = await db
      .select()
      .from(schema.flows)
      .where(
        and(
          eq(schema.flows.projectId, historicalProjectId),
          eq(
            schema.flows.flowRefId,
            change === "upgrade" ? "flow-b" : "flow-a",
          ),
        ),
      );
    const runId = randomUUID();
    const workspaceId = randomUUID();
    const taskId = randomUUID();
    const nodeAttemptId = randomUUID();
    const archivedAt = new Date("2026-01-01T00:00:00Z");

    await db.insert(schema.tasks).values({
      id: taskId,
      projectId: historicalProjectId,
      number: 1,
      title: "Historical package execution",
      prompt: "Preserve execution evidence",
      flowId: flow.id,
    });
    await db.insert(schema.runs).values({
      id: runId,
      projectId: historicalProjectId,
      taskId,
      flowId: flow.id,
      flowRevisionId: change === "unpinned" ? null : flow.enabledRevisionId,
      flowVersion: "attpkg-history-v1.0.0",
      status,
      endedAt: change === "not_ended" ? null : archivedAt,
      ...(change === "shared" || change === "shared_reuser"
        ? {
            runKind: "agent",
            rootRunId: runId,
            workspaceMode: "shared",
            agentWorkspace: "worktree",
          }
        : {}),
    });
    await db.insert(schema.nodeAttempts).values({
      id: nodeAttemptId,
      runId,
      nodeId: "s1",
      nodeType: "cli",
      attempt: 1,
      status: "Failed",
      stdout: "Historical execution output",
      checkpointRef: `refs/maister/checkpoints/${runId}/${nodeAttemptId}`,
    });
    if (change === "shared") {
      await db.insert(schema.runs).values({
        id: randomUUID(),
        projectId: historicalProjectId,
        runKind: "agent",
        rootRunId: runId,
        workspaceMode: "shared",
        agentWorkspace: "worktree",
        status: "Running",
        flowVersion: "shared-sibling",
      });
    }
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      runId,
      projectId: historicalProjectId,
      branch: "run/history",
      worktreePath: join(root, "archived-worktree"),
      parentRepoPath: root,
      removedAt:
        change === "not_removed" || change === "unarchived" ? null : archivedAt,
      archivedAt: change === "unarchived" ? null : archivedAt,
      archivedBranch: change === "clean" ? null : "archive/history",
      archivedCommit:
        change === "missing_commit" || change === "clean"
          ? null
          : "a".repeat(40),
      removalKind: change === "legacy" ? "legacy" : "archive",
      preservationOutcome:
        change === "legacy"
          ? null
          : change === "clean"
            ? "not_needed"
            : "snapshot_created",
      ...(change === "claiming" || change === "failed"
        ? {
            lifecycleOperationState: change,
            lifecycleOperationAttemptId: randomUUID(),
            lifecycleOperationName: "archive",
            lifecycleOperationExpectedRunStatus: status,
            lifecycleOperationLeaseExpiresAt:
              change === "claiming" ? new Date(Date.now() + 60_000) : null,
          }
        : {}),
    });
    if (change === "shared_reuser") {
      const allocatorId = randomUUID();

      await db.insert(schema.runs).values({
        id: allocatorId,
        projectId: historicalProjectId,
        runKind: "agent",
        rootRunId: runId,
        workspaceMode: "shared",
        agentWorkspace: "worktree",
        status: "Done",
        endedAt: archivedAt,
        flowVersion: "allocator",
      });
      await db
        .update(schema.workspaces)
        .set({ runId: allocatorId })
        .where(eq(schema.workspaces.id, workspaceId));
    }
    if (change === "old_revision") {
      const replacement = await installPackageRevision({
        source: pkgV2,
        version: "attpkg/history-v2.0.0",
        trustStatus: "trusted_by_policy",
        db,
      });

      await upgradeAttachment({
        projectId: historicalProjectId,
        projectSlug: slug,
        attachmentId: attached!.attachmentId,
        packageInstallId: replacement.id,
        workspaceRoot: root,
        db,
      });
      await db
        .update(schema.workspaces)
        .set({ removedAt: null, archivedAt: null })
        .where(eq(schema.workspaces.id, workspaceId));
    }
    if (change === "extra_workspace") {
      await db.insert(schema.workspaces).values({
        id: randomUUID(),
        runId,
        projectId: historicalProjectId,
        branch: "run/other",
        worktreePath: join(root, "other"),
        parentRepoPath: root,
      });
    }
    if (
      change === "assignment" ||
      change === "concurrent" ||
      change === "session"
    ) {
      const hostId = randomUUID();

      await db.insert(schema.executionHosts).values({
        id: hostId,
        hostKey: hostId,
        kind: "local_direct",
        displayName: "Recovery fixture",
        transport: { kind: "local_direct" },
        retiredAt: archivedAt,
      });
      if (change === "session") {
        const runSessionId = randomUUID();

        await db
          .insert(schema.runSessions)
          .values({ id: runSessionId, runId, sessionName: "default" });
        await db.insert(schema.runSessionIncarnations).values({
          id: randomUUID(),
          runId,
          runSessionId,
          executionHostId: hostId,
          hostSessionId: randomUUID(),
          state: "active",
          origin: "native",
        });
      }
      const assignment = {
        id: randomUUID(),
        runId,
        executionHostId: hostId,
        epoch: 1,
        state: "active",
        placementReason: "recover",
      };

      if (change === "concurrent") {
        let releaseRecovery: (() => void) | undefined;
        let recoveryLocked: ((pid: number) => void) | undefined;
        const locked = new Promise<number>((resolve) => {
          recoveryLocked = resolve;
        });
        const release = new Promise<void>((resolve) => {
          releaseRecovery = resolve;
        });
        const recovery = db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`,
          );
          await tx.insert(schema.executionAssignments).values(assignment);
          const pid = await tx.execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          );

          recoveryLocked!(pid.rows[0]!.pid);
          await release;
        });
        const recoveryPid = await Promise.race([
          locked,
          recovery.then(() => {
            throw new Error("Recovery ended before locking the run");
          }),
        ]);

        try {
          let settled = false;
          const detachment = detachPackage({
            projectId: historicalProjectId,
            attachmentId: attached!.attachmentId,
            db,
          }).then(
            (value) => {
              settled = true;

              return { value, error: undefined };
            },
            (error: unknown) => {
              settled = true;

              return { value: undefined, error };
            },
          );
          const deadline = Date.now() + 2_000;
          let waiting = false;

          while (!settled && Date.now() < deadline) {
            const observation = await db.execute<{ waiting: boolean }>(sql`
              SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                WHERE ${recoveryPid} = ANY(pg_blocking_pids(pid))
              ) AS waiting
            `);

            waiting = observation.rows[0]!.waiting;
            if (waiting) break;
            await setTimeout(10);
          }
          expect(
            waiting,
            "detach must wait for concurrent recovery's run lock",
          ).toBe(true);
          releaseRecovery!();
          await recovery;
          const result = await detachment;

          expect(result.error).toMatchObject({ code: "PRECONDITION" });
        } finally {
          releaseRecovery!();
          await recovery;
        }

        return;
      }
      if (change !== "session")
        await db.insert(schema.executionAssignments).values(assignment);
    }
    if (blocked) {
      await expect(
        detachPackage({
          projectId: historicalProjectId,
          attachmentId: attached!.attachmentId,
          db,
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION",
        details: {
          reason: "package_run_pinned",
          blockers: [
            expect.objectContaining({
              runId,
              status,
              reasons: expect.any(Array),
            }),
          ],
        },
      });

      return;
    }

    if (change === "upgrade") {
      const replacement = await installPackageRevision({
        source: pkgV2,
        version: "attpkg/history-v2.0.0",
        trustStatus: "trusted_by_policy",
        db,
      });

      await expect(
        upgradeAttachment({
          projectId: historicalProjectId,
          projectSlug: slug,
          attachmentId: attached!.attachmentId,
          packageInstallId: replacement.id,
          workspaceRoot: root,
          db,
        }),
      ).resolves.toEqual({ upgraded: true });
    } else {
      await expect(
        detachPackage({
          projectId: historicalProjectId,
          attachmentId: attached!.attachmentId,
          db,
        }),
      ).resolves.toEqual({ detached: true });
    }

    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));

    expect(run).toMatchObject({
      status,
      taskId,
      flowId: null,
      endedAt: archivedAt,
      flowRevisionId: flow.enabledRevisionId,
    });
    const [task] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));

    expect(task).toMatchObject({
      title: "Historical package execution",
      flowId: null,
    });
    const [nodeAttempt] = await db
      .select()
      .from(schema.nodeAttempts)
      .where(eq(schema.nodeAttempts.id, nodeAttemptId));

    expect(nodeAttempt).toMatchObject({
      runId,
      status: "Failed",
      stdout: "Historical execution output",
      checkpointRef: `refs/maister/checkpoints/${runId}/${nodeAttemptId}`,
    });
    const [workspace] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));

    expect(workspace).toMatchObject({
      archivedAt,
      removedAt: archivedAt,
      archivedBranch: change === "clean" ? null : "archive/history",
      archivedCommit: change === "clean" ? null : "a".repeat(40),
    });
    const [revision] = await db
      .select()
      .from(schema.flowRevisions)
      .where(eq(schema.flowRevisions.id, flow.enabledRevisionId));

    expect(revision).toBeDefined();
  });

  it("upgrade flips the group to v2: repoint, drop removed flow, keep pins", async () => {
    const result = await upgradeAttachment({
      projectId,
      projectSlug: "attach-int",
      attachmentId,
      packageInstallId: installV2,
      workspaceRoot,
      db,
    });

    expect(result).toEqual({ upgraded: true });

    const flowRows = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.projectId, projectId));

    expect(flowRows.map((f: any) => f.flowRefId)).toEqual(["flow-a"]);
    expect(flowRows[0].packageInstallId).toBe(installV2);

    const [att] = await db
      .select()
      .from(schema.projectPackageAttachments)
      .where(eq(schema.projectPackageAttachments.id, attachmentId));

    expect(att.packageInstallId).toBe(installV2);
    const heads = await db
      .select()
      .from(schema.projectDependencyDeclarations)
      .where(eq(schema.projectDependencyDeclarations.projectId, projectId));
    expect(heads).toMatchObject([
      {
        logicalId: "project-alias",
        generation: 3,
        effectiveGeneration: 3,
        effectiveAttachmentId: attachmentId,
        desired: { source: pkgV2, version: "attpkg/v2.0.0" },
      },
    ]);

    // v1 member revisions survive for pinned history.
    const v1Revisions = await db
      .select()
      .from(schema.flowRevisions)
      .where(eq(schema.flowRevisions.flowRefId, "flow-b"));

    expect(v1Revisions.length).toBeGreaterThan(0);
  });

  it("upgrade to a different package name refuses with PRECONDITION", async () => {
    const otherPkg = await mkdtemp(join(tmpdir(), "attach-int-other-"));

    await buildPackage(otherPkg, ["other-flow"], { mcps: false });
    const other = await installPackageRevision({
      source: otherPkg,
      version: "local-dev",
      db,
    });

    // Different name guard fires before anything else.
    await db
      .update(schema.packageInstalls)
      .set({ name: "otherpkg" })
      .where(eq(schema.packageInstalls.id, other.id));

    await expect(
      upgradeAttachment({
        projectId,
        projectSlug: "attach-int",
        attachmentId,
        packageInstallId: other.id,
        db,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "PRECONDITION",
    );
    await rm(otherPkg, { recursive: true, force: true });
  });

  it("trustPackageRevision fans trust to every member row in one tx", async () => {
    const result = await trustPackageRevision({
      packageInstallId: installV2,
      db,
    });

    expect(result).toEqual({ trusted: true });

    const [install] = await db
      .select()
      .from(schema.packageInstalls)
      .where(eq(schema.packageInstalls.id, installV2));

    expect(install.trustStatus).toBe("trusted");

    const flowRows = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.packageInstallId, installV2));

    for (const row of flowRows) expect(row.trustStatus).toBe("trusted");

    const revisions = await db
      .select()
      .from(schema.flowRevisions)
      .where(
        eq(schema.flowRevisions.resolvedRevision, install.resolvedRevision),
      );

    for (const rev of revisions) expect(rev.execTrust).toBe("trusted");

    const imports = await db
      .select()
      .from(schema.capabilityImports)
      .where(eq(schema.capabilityImports.packageInstallId, installV2));

    for (const imp of imports) expect(imp.trustStatus).toBe("trusted");
  });

  it("trustPackageRevision enables ready member Flows", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "attach-int-trust-"));

    try {
      await buildMinimalPackage(packageRoot, {
        name: "trustpkg",
        flowId: "trust-flow",
      });
      const installed = await installPackageRevision({
        source: packageRoot,
        version: "trustpkg/v1.0.0",
        db,
      });
      const attached = await attachPackage({
        projectId,
        projectSlug: "attach-int",
        packageInstallId: installed.id,
        workspaceRoot,
        db,
      });

      expect(attached).not.toBeNull();
      if (!attached) throw new Error("trusted package attachment is missing");
      const memberFlowId = attached.memberFlows[0]?.flowRowId;

      if (!memberFlowId) throw new Error("trusted package Flow is missing");

      const [before] = await db
        .select()
        .from(schema.flows)
        .where(eq(schema.flows.id, memberFlowId));

      expect(before).toMatchObject({
        enablementState: "Installed",
        trustStatus: "untrusted",
      });

      // The per-project binding remains unresolved while the global revision
      // is trusted. A second fan-out after resolving the slot can enable it.
      const pendingRemap = randomUUID();
      await db.insert(schema.flowRunnerRemaps).values({
        id: pendingRemap,
        projectId,
        flowRevisionId: before.enabledRevisionId,
        slotKey: "pending-slot",
        status: "Pending",
      });
      await trustPackageRevision({ packageInstallId: installed.id, db });
      const [blocked] = await db
        .select()
        .from(schema.flows)
        .where(eq(schema.flows.id, memberFlowId));
      expect(blocked).toMatchObject({
        trustStatus: "trusted",
        enablementState: "Installed",
      });
      await db
        .delete(schema.flowRunnerRemaps)
        .where(eq(schema.flowRunnerRemaps.id, pendingRemap));

      await trustPackageRevision({ packageInstallId: installed.id, db });

      const [after] = await db
        .select()
        .from(schema.flows)
        .where(eq(schema.flows.id, memberFlowId));

      expect(after).toMatchObject({
        enablementState: "Enabled",
        trustStatus: "trusted",
      });
      await expect(
        detachPackage({
          projectId,
          attachmentId: attached.attachmentId,
          db,
        }),
      ).resolves.toEqual({ detached: true });
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });

  it("detach removes the group (CLEAR) and re-attach restores it (re-SET)", async () => {
    const result = await detachPackage({ projectId, attachmentId, db });

    expect(result).toEqual({ detached: true });

    expect(
      await db
        .select()
        .from(schema.flows)
        .where(eq(schema.flows.projectId, projectId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.capabilityImports)
        .where(eq(schema.capabilityImports.projectId, projectId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.capabilityRecords)
        .where(
          and(
            eq(schema.capabilityRecords.projectId, projectId),
            eq(schema.capabilityRecords.source, "flow-package"),
            eq(schema.capabilityRecords.selectable, true),
          ),
        ),
    ).toHaveLength(0);

    expect(
      await db
        .select()
        .from(schema.projectDependencyDeclarations)
        .where(eq(schema.projectDependencyDeclarations.projectId, projectId)),
    ).toHaveLength(0);

    // re-SET: attach v2 again — ingestion records come back.
    const again = await attachPackage({
      projectId,
      projectSlug: "attach-int",
      packageInstallId: installV2,
      workspaceRoot,
      db,
    });

    expect(again).not.toBeNull();
    const records = await db
      .select()
      .from(schema.capabilityRecords)
      .where(
        and(
          eq(schema.capabilityRecords.projectId, projectId),
          eq(schema.capabilityRecords.source, "flow-package"),
          eq(schema.capabilityRecords.selectable, true),
        ),
      );

    expect(records.map((r: any) => r.capabilityRefId).sort()).toEqual([
      "att-bundle",
      "att-mcp",
      "att-protect",
      "skill-one",
    ]);
  });
});

it("allows a package to take a cleared legacy import name without reviving the old revision on detach", async () => {
  const id = randomUUID(),
    slug = "cleared-" + id.slice(0, 8);
  const repo = await mkdtemp(join(tmpdir(), "cleared-import-"));
  dirsToClean.push(repo);
  await db.insert(schema.projects).values({
    id,
    taskKey: slug.toUpperCase(),
    slug,
    name: slug,
    repoPath: repo,
  });
  const old = randomUUID();
  await db.insert(schema.capabilityImports).values({
    id: old,
    projectId: id,
    capabilityRefId: "att-bundle",
    source: "https://example.invalid/old",
    versionTag: "legacy",
    resolvedRevision: "legacy",
    manifestDigest: "digest",
    manifest: {},
    installedPath: "/old",
    packageStatus: "Installed",
    trustStatus: "trusted",
    setupStatus: "done",
  });
  await db.insert(schema.capabilityRecords).values({
    id: randomUUID(),
    projectId: id,
    capabilityRefId: "att-bundle",
    source: "flow-package",
    kind: "agent_definition",
    label: "old",
    agents: [],
    version: "legacy",
    revision: "legacy",
    material: {},
    disabledAt: new Date(),
    selectable: false,
  });
  const install = await installPackageRevision({
    db,
    source: pkgV1,
    trustStatus: "trusted",
    version: "attpkg/cleared",
  });
  const result = await attachPackage({
    db,
    projectId: id,
    projectSlug: slug,
    workspaceRoot: repo,
    packageInstallId: install.id,
  });
  expect(result).toBeTruthy();
  const eligible = () =>
    testDatabase.pool.query(
      "SELECT id FROM project_ready_capability_imports($1) WHERE catalog_enabled",
      [id],
    );
  expect((await eligible()).rows).toHaveLength(1);
  await detachPackage({
    db,
    projectId: id,
    attachmentId: result!.attachmentId,
  });
  expect((await eligible()).rows).toHaveLength(0);
  expect(
    (
      await testDatabase.pool.query(
        "SELECT id FROM capability_imports WHERE id=$1",
        [old],
      )
    ).rows,
  ).toEqual([{ id: old }]);
});

it("operator CLI attaches explicit coordinates beside a repaired platform pin despite stale repository YAML", async () => {
  const repo = await mkdtemp(join(tmpdir(), "cli-attach-project-"));
  const root = await mkdtemp(join(tmpdir(), "cli-attach-package-"));
  dirsToClean.push(repo, root);
  const id = randomUUID();
  const slug = `cli-${id.slice(0, 8)}`;
  const manifestPath = join(repo, "maister.yaml");
  await writeFile(
    manifestPath,
    "schemaVersion: 2\nproject:\n  name: CLI\nflows: []\npackages:\n  - {id: attpkg, source: file:///old, version: stale}\ncapability_imports:\n  - id: stale\n    source: file:///missing-from-old-yaml\n    version: v1\n",
  );
  await db.insert(schema.projects).values({
    id,
    taskKey: slug.toUpperCase(),
    slug,
    name: "CLI",
    repoPath: repo,
    maisterYamlPath: manifestPath,
  });
  const sibling = await installPackageRevision({
    source: pkgV2,
    version: "catalog-version",
    db,
  });
  const attached = await attachPackage({
    projectId: id,
    projectSlug: slug,
    packageInstallId: sibling.id,
    workspaceRoot: repo,
    db,
  });
  await db
    .update(schema.projectDependencyDeclarations)
    .set({
      desired: { source: pkgV2, version: "repaired" },
      generation: 2,
    })
    .where(
      eq(
        schema.projectDependencyDeclarations.effectiveAttachmentId,
        attached!.attachmentId,
      ),
    );
  const [selection] = await db
    .update(schema.capabilityRecords)
    .set({ selectedByDefault: false })
    .where(
      and(
        eq(schema.capabilityRecords.projectId, id),
        eq(schema.capabilityRecords.capabilityRefId, "att-bundle"),
      ),
    )
    .returning({ id: schema.capabilityRecords.id });
  await mkdir(join(root, "flows/cli-flow"), { recursive: true });
  await writeFile(
    join(root, "flows/cli-flow/flow.yaml"),
    FLOW_YAML("cli-flow"),
  );
  await writeFile(
    join(root, "maister-package.yaml"),
    "schemaVersion: 1\nname: cli-package\nflows:\n  - { id: cli-flow, path: flows/cli-flow }\n",
  );
  await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./scripts/_register-shim.mjs",
      "scripts/install-package.ts",
      "--project",
      slug,
      "--source",
      root,
      "--version",
      "cli-version",
    ],
    { env: { ...process.env, DB_URL: testDatabase.databaseUrl } },
  ).catch((error: Error & { stdout: string }) => {
    throw new Error(error.stdout, { cause: error });
  });
  const actual = await db
    .select()
    .from(schema.projectPackageAttachments)
    .where(eq(schema.projectPackageAttachments.projectId, id));
  const [retained] = await db
    .select()
    .from(schema.capabilityRecords)
    .where(eq(schema.capabilityRecords.id, selection.id));
  expect(retained).toMatchObject({
    selectedByDefault: false,
    selectable: true,
    disabledAt: null,
  });
  expect(actual).toHaveLength(2);
  expect(actual).toContainEqual(
    expect.objectContaining({
      id: attached?.attachmentId,
      packageInstallId: sibling.id,
    }),
  );
  const { rows } = await db.execute(
    sql`select logical_id, desired->>'version' as version from project_dependency_declarations where project_id = ${id} order by logical_id`,
  );
  expect(rows).toEqual([
    { logical_id: "attpkg", version: "repaired" },
    { logical_id: "cli-package", version: "cli-version" },
  ]);
});

// ADR-179 (D27/D34/D18): the manifest value model at the ingestion seam.
describe("package mcps[] value model (ADR-179)", () => {
  async function attachWithMcp(
    slug: string,
    mcpYaml: string,
    version: string,
  ): Promise<{ projectId: string; installId: string }> {
    const root = await mkdtemp(join(tmpdir(), `attach-mcpv-${slug}-`));

    dirsToClean.push(root);
    await mkdir(join(root, "flows/f"), { recursive: true });
    await writeFile(join(root, "flows/f/flow.yaml"), FLOW_YAML("f"));
    await writeFile(
      join(root, "maister-package.yaml"),
      `schemaVersion: 1\nname: mcpv-${slug}\nflows:\n  - { id: f, path: flows/f }\nmcps:\n${mcpYaml}`,
    );

    const install = await installPackageRevision({
      source: root,
      version,
      trustStatus: "trusted_by_policy",
      db,
    });
    const projectId = await seedProject(`mcpv-${slug}`);

    await attachPackage({
      projectId,
      projectSlug: `mcpv-${slug}`,
      packageInstallId: install.id,
      workspaceRoot,
      db,
    });

    return { projectId, installId: install.id };
  }

  async function mcpMaterial(
    projectId: string,
    refId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await db
      .select()
      .from(schema.capabilityRecords)
      .where(
        and(
          eq(schema.capabilityRecords.projectId, projectId),
          eq(schema.capabilityRecords.capabilityRefId, refId),
        ),
      );

    return rows[0]!.material as Record<string, unknown>;
  }

  it("produces IDENTICAL material from the legacy list and the map form", async () => {
    const listPkg = await attachWithMcp(
      "list",
      `  - { id: m, transport: stdio, command: npx, env: ["env:ATT_TOKEN"] }\n`,
      "mcpv-list/v1.0.0",
    );
    const mapPkg = await attachWithMcp(
      "map",
      `  - id: m\n    transport: stdio\n    command: npx\n    env:\n      ATT_TOKEN: env:ATT_TOKEN\n`,
      "mcpv-map/v1.0.0",
    );

    const fromList = await mcpMaterial(listPkg.projectId, "m");
    const fromMap = await mcpMaterial(mapPkg.projectId, "m");

    expect(fromList.env).toEqual({ ATT_TOKEN: "env:ATT_TOKEN" });
    expect(fromList.env).toEqual(fromMap.env);
  });

  it("lands headers + bearerTokenEnv in material, and caches readiness", async () => {
    const { projectId } = await attachWithMcp(
      "http",
      `  - id: m\n    transport: http\n    url: "https://mcp.example.com"\n    headers:\n      X-Tenant: acme\n    bearerTokenEnv: env:MCPV_ABSENT_SENTINEL\n`,
      "mcpv-http/v1.0.0",
    );
    const material = await mcpMaterial(projectId, "m");

    expect(material.headers).toEqual({ "X-Tenant": "acme" });
    expect(material.bearerTokenEnv).toBe("env:MCPV_ABSENT_SENTINEL");
    // D18: the write-time cache exists on a package row too. The host is not
    // reachable in this suite, so the honest verdict is Unknown — what matters
    // is that the field is WRITTEN and readable, not which value it holds.
    expect(material.readiness).toBeDefined();
    expect((material.readiness as { status: string }).status).toMatch(
      /Unknown|NotReady|Ready/,
    );
  });

  it("gives a package TEMPLATE its slots — the C10 defect closes by construction", async () => {
    const { projectId } = await attachWithMcp(
      "slots",
      `  - id: m\n    transport: stdio\n    command: npx\n    env:\n      ATT_TOKEN: env:ATT_TOKEN\n      GH_HOST: github.com\n`,
      "mcpv-slots/v1.0.0",
    );
    const rows = await db
      .select()
      .from(schema.capabilityRecords)
      .where(
        and(
          eq(schema.capabilityRecords.projectId, projectId),
          eq(schema.capabilityRecords.capabilityRefId, "m"),
        ),
      );
    const target = await resolveBindTarget(
      { execute: (q: never) => db.execute(q) } as never,
      projectId,
      "package",
      rows[0]!.id,
    );

    // Before ADR-179 this read the name-list field a template never wrote, so
    // an overlay against a template could name no slot at all.
    expect(target?.slots.env.sort()).toEqual(["ATT_TOKEN", "GH_HOST"]);
  });

  it("IT-CAP-02 preserves explicit scope per attachment through adoption, reset and rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "scope-upgrade-"));

    dirsToClean.push(root);
    const release = async (version: string, declarations: string) => {
      await writeFile(
        join(root, "maister-package.yaml"),
        `schemaVersion: 1\nname: scope-pkg\n${declarations}\n`,
      );

      return installPackageRevision({
        source: root,
        version,
        trustStatus: "trusted_by_policy",
        db,
      });
    };
    const legacy = await release("scope-pkg/v1", "mcps: [{ id: design }]");
    const next = await release(
      "scope-pkg/v2",
      "delivery: {version: 1}\nmcps: [{id: design}, {id: shared, scope: project}]",
    );
    const dropped = await release(
      "scope-pkg/v3",
      "delivery: {version: 1}\nmcps: [{id: replacement}]",
    );
    const first = await seedProject("scope-first");
    const second = await seedProject("scope-second");
    const attach = (projectId: string, projectSlug: string) =>
      attachPackage({
        projectId,
        projectSlug,
        packageInstallId: legacy.id,
        workspaceRoot,
        db,
      });
    const att = (await attach(first, "scope-first"))!;

    await attach(second, "scope-second");
    const base = {
      projectId: first,
      projectSlug: "scope-first",
      attachmentId: att.attachmentId,
      workspaceRoot,
      db,
    };
    const mutate = (
      scope: "package" | "project" | null,
      revision: number,
      pin: string,
    ) =>
      setPackageMcpScope(
        {
          ...base,
          refId: "design",
          mutation: {
            scope,
            expectedInstallId: pin,
            expectedRevision: revision,
          },
        },
        db as unknown as Parameters<typeof setPackageMcpScope>[1],
      );
    const states = () => readPackageMcpScopes(db, first);

    expect(await states()).toMatchObject([
      { effective: "project", revision: 1 },
    ]);
    const written = await Promise.allSettled([
      mutate("package", 1, legacy.id),
      mutate("package", 1, legacy.id),
    ]);

    expect(written.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(written.filter((x) => x.status === "rejected")).toMatchObject([
      { reason: { code: "CONFLICT" } },
    ]);
    await upgradeAttachment({ ...base, packageInstallId: next.id });
    expect(await states()).toMatchObject([
      {
        refId: "design",
        declared: "package",
        effective: "package",
        origin: "override",
        revision: 3,
      },
      { refId: "shared", effective: "project" },
    ]);
    expect(await readPackageMcpScopes(db, second)).toMatchObject([
      { effective: "project", revision: 1 },
    ]);
    await expect(mutate("project", 3, legacy.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await mutate("project", 3, next.id)).toMatchObject({
      effective: "project",
    });
    expect(await mutate(null, 4, next.id)).toMatchObject({
      effective: "package",
      origin: "package",
    });
    await mutate("project", 5, next.id);
    await upgradeAttachment({ ...base, packageInstallId: dropped.id });
    await upgradeAttachment({ ...base, packageInstallId: next.id });
    expect(await states()).toMatchObject([
      { refId: "design", effective: "package", origin: "package" },
      { refId: "shared", effective: "project" },
    ]);
    await detachPackage(base);
    expect(await states()).toEqual([]);
    await attach(first, "scope-first");
    expect(await states()).toMatchObject([
      { refId: "design", effective: "project", origin: "package", revision: 1 },
    ]);
  });

  it("rebuilds material on upgrade — a dropped headers block leaves nothing behind (SET/CLEAR/re-SET)", async () => {
    const root = await mkdtemp(join(tmpdir(), "attach-mcpv-upg-"));

    dirsToClean.push(root);
    await mkdir(join(root, "flows/f"), { recursive: true });
    await writeFile(join(root, "flows/f/flow.yaml"), FLOW_YAML("f"));

    const manifest = (headers: boolean) =>
      `schemaVersion: 1\nname: mcpv-upg\nflows:\n  - { id: f, path: flows/f }\nmcps:\n  - id: m\n    transport: http\n    url: "https://mcp.example.com"\n${
        headers ? `    headers:\n      X-Tenant: acme\n` : ""
      }`;

    // SET
    await writeFile(join(root, "maister-package.yaml"), manifest(true));
    const v1 = await installPackageRevision({
      source: root,
      version: "mcpv-upg/v1.0.0",
      trustStatus: "trusted_by_policy",
      db,
    });
    const projectId = await seedProject("mcpv-upg");
    const attached = await attachPackage({
      projectId,
      projectSlug: "mcpv-upg",
      packageInstallId: v1.id,
      workspaceRoot,
      db,
    });

    expect(attached).not.toBeNull();
    expect((await mcpMaterial(projectId, "m")).headers).toEqual({
      "X-Tenant": "acme",
    });

    // CLEAR — the next version drops the block.
    await writeFile(join(root, "maister-package.yaml"), manifest(false));
    const v2 = await installPackageRevision({
      source: root,
      version: "mcpv-upg/v2.0.0",
      trustStatus: "trusted_by_policy",
      db,
    });

    // `upgradeAttachment` keys on the ATTACHMENT; without it, it returns null
    // and does nothing — assert the result so a silent no-op cannot pass.
    expect(
      await upgradeAttachment({
        projectId,
        projectSlug: "mcpv-upg",
        attachmentId: attached!.attachmentId,
        packageInstallId: v2.id,
        workspaceRoot,
        db,
      }),
    ).toMatchObject({ upgraded: true });
    // A write loop that skipped absent fields would leave the v1 header here.
    expect((await mcpMaterial(projectId, "m")).headers).toEqual({});

    // re-SET
    await writeFile(join(root, "maister-package.yaml"), manifest(true));
    const v3 = await installPackageRevision({
      source: root,
      version: "mcpv-upg/v3.0.0",
      trustStatus: "trusted_by_policy",
      db,
    });

    expect(
      await upgradeAttachment({
        projectId,
        projectSlug: "mcpv-upg",
        attachmentId: attached!.attachmentId,
        packageInstallId: v3.id,
        workspaceRoot,
        db,
      }),
    ).toMatchObject({ upgraded: true });
    expect((await mcpMaterial(projectId, "m")).headers).toEqual({
      "X-Tenant": "acme",
    });
  });
});

async function buildMinimalPackage(
  root: string,
  opts: {
    name: string;
    flowId: string;
    mcpId?: string;
    restrictionId?: string;
  },
): Promise<void> {
  await mkdir(join(root, `flows/${opts.flowId}`), { recursive: true });
  await writeFile(
    join(root, `flows/${opts.flowId}/flow.yaml`),
    FLOW_YAML(opts.flowId),
  );
  const mcps = opts.mcpId
    ? `mcps:\n  - { id: ${opts.mcpId}, transport: http, url: "https://mcp.example.com" }\n`
    : "";
  const restrictions = opts.restrictionId
    ? `restrictions:\n  - { id: ${opts.restrictionId}, paths: ["docs/**"] }\n`
    : "";

  await writeFile(
    join(root, "maister-package.yaml"),
    `schemaVersion: 1\nname: ${opts.name}\nflows:\n  - { id: ${opts.flowId}, path: flows/${opts.flowId} }\n${mcps}${restrictions}`,
  );
}

async function seedProject(slug: string): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id,
    slug,
    name: slug,
    repoPath: join(workspaceRoot, slug),
    maisterYamlPath: join(workspaceRoot, slug, "maister.yaml"),
  });

  return id;
}

describe("capability-record ownership across packages (integration)", () => {
  let projectId2: string;
  const dirs: string[] = [];
  let installP1: string;
  let installP2: string;
  let installP3: string;
  let att1: string;

  async function installFixture(opts: {
    name: string;
    flowId: string;
    mcpId?: string;
    restrictionId?: string;
  }): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `attach-coll-${opts.name}-`));

    dirs.push(dir);
    await buildMinimalPackage(dir, opts);
    const installed = await installPackageRevision({
      source: dir,
      version: `${opts.name}/v1.0.0`,
      trustStatus: "trusted_by_policy",
      db,
    });

    return installed.id;
  }

  beforeAll(async () => {
    projectId2 = await seedProject("attach-coll");
    installP1 = await installFixture({
      name: "collpkg1",
      flowId: "coll-flow-1",
      mcpId: "shared-cap",
    });
    installP2 = await installFixture({
      name: "collpkg2",
      flowId: "coll-flow-2",
      mcpId: "shared-cap",
    });
    installP3 = await installFixture({
      name: "collpkg3",
      flowId: "coll-flow-3",
      restrictionId: "shared-cap",
    });
  }, 120_000);

  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it("attach refuses CONFLICT when another package owns the same (kind, id) record", async () => {
    const first = await attachPackage({
      projectId: projectId2,
      projectSlug: "attach-coll",
      packageInstallId: installP1,
      workspaceRoot,
      db,
    });

    att1 = first!.attachmentId;

    await expect(
      attachPackage({
        projectId: projectId2,
        projectSlug: "attach-coll",
        packageInstallId: installP2,
        workspaceRoot,
        db,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFLICT",
    );

    // First package's record untouched; the refused attach left no group.
    const [record] = await db
      .select()
      .from(schema.capabilityRecords)
      .where(
        and(
          eq(schema.capabilityRecords.projectId, projectId2),
          eq(schema.capabilityRecords.capabilityRefId, "shared-cap"),
        ),
      );

    expect(record.material.packageInstallId).toBe(installP1);

    const attachments = await db
      .select()
      .from(schema.projectPackageAttachments)
      .where(eq(schema.projectPackageAttachments.packageInstallId, installP2));

    expect(attachments).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.flows)
        .where(
          and(
            eq(schema.flows.projectId, projectId2),
            eq(schema.flows.flowRefId, "coll-flow-2"),
          ),
        ),
    ).toHaveLength(0);
  });

  it("same id with a different kind coexists; detach removes only the owner's record", async () => {
    const third = await attachPackage({
      projectId: projectId2,
      projectSlug: "attach-coll",
      packageInstallId: installP3,
      workspaceRoot,
      db,
    });

    expect(third).not.toBeNull();

    const records = await db
      .select()
      .from(schema.capabilityRecords)
      .where(
        and(
          eq(schema.capabilityRecords.projectId, projectId2),
          eq(schema.capabilityRecords.capabilityRefId, "shared-cap"),
        ),
      );

    expect(records.map((r: any) => r.kind).sort()).toEqual([
      "mcp",
      "restriction",
    ]);

    // Detaching collpkg1 must NOT take collpkg3's same-id restriction along.
    await detachPackage({ projectId: projectId2, attachmentId: att1, db });

    const survivors = await db
      .select()
      .from(schema.capabilityRecords)
      .where(
        and(
          eq(schema.capabilityRecords.projectId, projectId2),
          eq(schema.capabilityRecords.capabilityRefId, "shared-cap"),
        ),
      );

    expect(survivors).toHaveLength(1);
    expect(survivors[0].kind).toBe("restriction");
    expect(survivors[0].material.packageInstallId).toBe(installP3);
  });
});

describe("package trust fan-out across projects (integration)", () => {
  it("trusting a revision fans to EVERY attached project (platform-wide by design, ADR-088)", async () => {
    const fanDir = await mkdtemp(join(tmpdir(), "attach-fan-"));

    await buildMinimalPackage(fanDir, {
      name: "fanpkg",
      flowId: "fan-flow",
      mcpId: "fan-mcp",
    });
    const p1 = await seedProject("fan-p1");
    const p2 = await seedProject("fan-p2");
    const installed = await installPackageRevision({
      source: fanDir,
      version: "fanpkg/v1.0.0",
      db,
    });

    await attachPackage({
      projectId: p1,
      projectSlug: "fan-p1",
      packageInstallId: installed.id,
      workspaceRoot,
      db,
    });
    await attachPackage({
      projectId: p2,
      projectSlug: "fan-p2",
      packageInstallId: installed.id,
      workspaceRoot,
      db,
    });

    const visible = async () =>
      (
        await testDatabase.pool.query(
          "SELECT project_id FROM capability_records WHERE project_id=ANY($1) AND capability_ref_id='fan-mcp' AND selectable AND disabled_at IS NULL ORDER BY project_id",
          [[p1, p2]],
        )
      ).rows.map((row) => row.project_id);

    expect(await visible()).toEqual([]);
    const consumingFlow = {
      ...parseYaml(FLOW_YAML("fan-consumer")),
      mcps: ["fan-mcp"],
    };

    await expect(
      assertProjectFlowCapabilities(testDatabase.db, p1, consumingFlow),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "flow_capability_unavailable", ref: "fan-mcp" },
    });
    await trustPackageRevision({ packageInstallId: installed.id, db });
    expect(await visible()).toEqual([p1, p2].sort());
    await expect(
      assertProjectFlowCapabilities(testDatabase.db, p1, consumingFlow),
    ).resolves.toBeUndefined();

    for (const projectIdN of [p1, p2]) {
      const rows = await db
        .select()
        .from(schema.flows)
        .where(
          and(
            eq(schema.flows.projectId, projectIdN),
            eq(schema.flows.packageInstallId, installed.id),
          ),
        );

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.trustStatus).toBe("trusted");
        expect(row.enablementState).toBe("Enabled");
      }
    }

    await rm(fanDir, { recursive: true, force: true });
  });
});

it("IT-UX-19 refuses an active attachment upgrade to a qualifier until the project explicitly enables required qualification", async () => {
  const qualifiedRoot = await mkdtemp(join(tmpdir(), "qualification-project-"));

  dirsToClean.push(qualifiedRoot);
  const nextProjectId = randomUUID();
  const slug = `qualified-${nextProjectId.slice(0, 8)}`;
  const packageName = `qualpkg-${nextProjectId.slice(0, 8)}`;
  const versions = await Promise.all([
    mkdtemp(join(tmpdir(), "qualification-package-v1-")),
    mkdtemp(join(tmpdir(), "qualification-package-v2-")),
  ]);

  dirsToClean.push(...versions);
  for (const [index, directory] of versions.entries()) {
    await buildPackage(directory, ["qualification-flow"], { mcps: false });
    const manifest = await readFile(
      join(directory, "maister-package.yaml"),
      "utf8",
    );

    await writeFile(
      join(directory, "maister-package.yaml"),
      manifest.replace(
        "name: attpkg",
        `name: ${packageName}\ncompat: {engine_min: '3.10.0'}`,
      ),
    );
    await writeFile(
      join(directory, "maister-agents/triager.md"),
      `---\nname: Qualifier\ndescription: Qualification fixture\nkind: operational\ncompletion: {contract: operational_v1}\nworkspace: ${index === 0 ? "none" : "repo_read"}\n${index === 0 ? "" : "workspace_ref: task_target\ntask_qualification: {contract: v1, role: qualifier}\n"}mode: session\ntriggers: [manual]\nrisk_tier: read_only\n---\nInspect current input.`,
    );
  }
  await db.insert(schema.projects).values({
    id: nextProjectId,
    slug,
    name: "Qualification upgrade",
    repoPath: qualifiedRoot,
    maisterYamlPath: join(qualifiedRoot, "maister.yaml"),
    taskKey: `Q${nextProjectId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
  });
  const oldInstall: { id: string } = await installPackageRevision({
    source: versions[0],
    version: `${packageName}/v1`,
    db,
  });

  await trustPackageRevision({
    packageInstallId: oldInstall.id,
    db,
  });
  const attached = await attachPackage({
    projectId: nextProjectId,
    projectSlug: slug,
    packageInstallId: oldInstall.id,
    workspaceRoot: qualifiedRoot,
    db,
  });

  if (!attached) throw new Error("Fixture package attachment is missing");
  await db.insert(schema.agentProjectLinks).values({
    id: randomUUID(),
    projectId: nextProjectId,
    agentId: `${packageName}:triager`,
    enabled: true,
  });
  const nextInstall: { id: string } = await installPackageRevision({
    source: versions[1],
    version: `${packageName}/v2`,
    db,
  });

  await trustPackageRevision({
    packageInstallId: nextInstall.id,
    db,
  });
  const upgrade = {
    projectId: nextProjectId,
    projectSlug: slug,
    attachmentId: attached.attachmentId,
    packageInstallId: nextInstall.id,
    workspaceRoot: qualifiedRoot,
    db,
  };

  await expect(upgradeAttachment(upgrade)).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "qualification_policy_required" },
  });
  const [unchanged] = await db
    .select()
    .from(schema.projectPackageAttachments)
    .where(eq(schema.projectPackageAttachments.id, attached.attachmentId));

  expect(unchanged.packageInstallId).toBe(oldInstall.id);
  await db
    .update(schema.projects)
    .set({ taskQualificationOverride: "required" })
    .where(eq(schema.projects.id, nextProjectId));
  await upgradeAttachment(upgrade);
  const [changed] = await db
    .select()
    .from(schema.projectPackageAttachments)
    .where(eq(schema.projectPackageAttachments.id, attached.attachmentId));

  expect(changed.packageInstallId).toBe(nextInstall.id);
});
it("IT-CAP-03/04 captures attached packages and prepares different bound, unbound and child native discovery views", async () => {
  const projectId = await seedProject("delivery");
  const releases: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const attachments: Record<string, string> = {};

  for (const [name, share, skills] of [
    ["tool-core", true, ["shared", "collide"]],
    ["tool-design", false, ["private", "collide"]],
    ["tool-dev", false, ["build"]],
  ] as const) {
    const root = await mkdtemp(join(workspaceRoot, "delivery-"));

    sources[name] = root;
    for (const slug of skills) {
      const directory = join(root, "bundle", "skills", slug);

      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "SKILL.md"), "Read companion.md");
      if (name === "tool-design" && slug === "collide") {
        await writeFile(join(root, "bundle", "reference.md"), name);
        await symlink("../../reference.md", join(directory, "companion.md"));
      } else await writeFile(join(directory, "companion.md"), name);
    }
    await writeFile(
      join(root, "maister-package.yaml"),
      `schemaVersion: 1\nname: ${name}\ndelivery: {version: 1, shareSkills: ${share}}\ncapabilities: [{id: ${name}-lib, path: bundle}]\nmcps: [{id: ${name}-mcp, transport: http, url: "https://mcp.example.com", scope: ${share ? "project" : "package"}}]\n`,
    );
    if (name === "tool-design") {
      await mkdir(join(root, "maister-agents"));
      await writeFile(
        join(root, "maister-agents", "artist.md"),
        `---\nname: artist\ndescription: Art\nworkspace: repo_read\nworkspace_ref: trigger\nmode: session\ntriggers: [flow]\nrisk_tier: read_only\ncapability_profile: {skills: [collide], mcps: [tool-design-mcp]}\n---\nDesign`,
      );
    }
    const install = await installPackageRevision({
      source: root,
      version: name + "/v1",
      trustStatus: "trusted_by_policy",
      db,
    });
    const attached = await attachPackage({
      projectId,
      projectSlug: "delivery",
      packageInstallId: install.id,
      workspaceRoot,
      db,
    });

    releases[name] = install.id;
    attachments[name] = attached!.attachmentId;
  }
  const graph = {
    nodes: [
      { id: "build", type: "ai_coding" },
      {
        id: "sketch",
        type: "ai_coding",
        settings: { agent: "tool-design:artist" },
      },
    ],
  };
  const delivery = (await capturePackageDelivery(db, {
    projectId,
    flowPackageInstallId: releases["tool-dev"]!,
    flowManifest: graph,
    nonPackageMcpRefs: [],
  }))!;
  const child = (await capturePackageDelivery(db, {
    projectId,
    flowPackageInstallId: releases["tool-design"]!,
    flowManifest: graph,
    nonPackageMcpRefs: [],
  }))!;
  const build = resolvePackageSession(delivery, "build"),
    sketch = resolvePackageSession(delivery, "sketch");

  expect(build.mcps).toEqual(["tool-core-mcp", "tool-dev-mcp"]);
  expect(sketch.mcps).toEqual(["tool-core-mcp", "tool-design-mcp"]);
  expect(
    resolvePackageSession(child, "build").skills.map((s) => s.slug),
  ).toContain("private");
  expect(sessionNameForPackageNode(delivery, "sketch", "default")).not.toEqual(
    "default",
  );
  const cwd = await mkdtemp(join(workspaceRoot, "delivery-run-"));
  const runId = randomUUID();

  await materializeProjectBundlesIntoWorktree({
    db,
    runId,
    projectId,
    worktreePath: cwd,
    baseBranch: "main",
    delivery,
  });
  await Promise.all(
    (
      [
        ["attempt-a", build.skills],
        ["attempt-b", sketch.skills],
      ] as const
    ).map(async ([id, selected]) => {
      await materializePackageSessionSkills({
        cwd,
        runId,
        nodeAttemptId: id,
        delivery,
        skills: selected,
      });
    }),
  );
  expect(
    await workspacePackageSkillsPrompt(cwd, runId, "attempt-a"),
  ).not.toContain("private");
  expect(await workspacePackageSkillsPrompt(cwd, runId, "attempt-b")).toContain(
    "collide",
  );
  const root = join(cwd, ".maister", "capabilities", runId);

  expect(
    await readFile(
      join(root, "attempt-a", "package-skills", "collide", "companion.md"),
      "utf8",
    ),
  ).toBe("tool-core");
  expect(
    await readFile(
      join(root, "attempt-b", "package-skills", "collide", "companion.md"),
      "utf8",
    ),
  ).toBe("tool-design");
  expect(
    (await witnessPackageSkillView(cwd, runId, "attempt-a", null)).skillsDigest,
  ).not.toBe(
    (await witnessPackageSkillView(cwd, runId, "attempt-b", null)).skillsDigest,
  );
  const captured = await resolveTaskLaunchCapabilities(
    db as unknown as Parameters<typeof resolveTaskLaunchCapabilities>[0],
    {
      projectId,
      flowRevisionId: "accepted",
      flowSource: "/studio",
      flowPackageInstallId: releases["tool-dev"]!,
      flowManifest: graph,
    },
  );
  const action = {
    projectId,
    snapshot: captured.resolvedCapabilitySet,
    delivery,
    skills: sketch.skills,
    selected: sketch.mcps,
    required: ["tool-design-mcp"],
    bindings: [],
  };

  expect((await resolveCurrentPackageSessionCatalog(db, action)).mcps).toEqual(
    sketch.mcps,
  );
  const refId = "tool-design-mcp";

  await db.insert(schema.platformMcpServers).values({
    id: refId,
    transport: "http",
    url: "https://platform.example.test/mcp",
    enabled: true,
    trustStatus: "trusted",
  });
  const binding = await connectPlatform(projectId, refId, undefined, null, db);
  const bound = await resolveTaskLaunchCapabilities(
    db as unknown as Parameters<typeof resolveTaskLaunchCapabilities>[0],
    {
      projectId,
      flowRevisionId: "accepted",
      flowSource: "/studio",
      flowPackageInstallId: releases["tool-dev"]!,
      flowManifest: graph,
    },
  );
  const boundAction = {
    ...action,
    snapshot: bound.resolvedCapabilitySet,
    delivery: bound.resolvedCapabilitySet.delivery!,
    bindings: [binding],
  };

  expect(
    (await resolveCurrentPackageSessionCatalog(db, boundAction)).catalog,
  ).toContainEqual(
    expect.objectContaining({
      capabilityRefId: refId,
      source: "platform",
      material: expect.objectContaining({
        url: "https://platform.example.test/mcp",
      }),
    }),
  );
  await db
    .delete(schema.projectMcpBindings)
    .where(eq(schema.projectMcpBindings.id, binding.id));
  await db
    .delete(schema.platformMcpServers)
    .where(eq(schema.platformMcpServers.id, refId));
  const agentId = "tool-design:artist";

  await db.insert(schema.agentProjectLinks).values({
    id: randomUUID(),
    projectId,
    agentId,
    enabled: true,
  });
  const effective = await resolveEffectiveAgentDefinition(
    { projectId, agentId },
    db,
  );
  const profile = await db.transaction((tx) =>
    captureProjectAgentProfile(tx, {
      projectId,
      agentId,
      packageName: effective.packageName,
      packageInstallId: effective.packageInstallId,
      definition: effective.parsed,
    }),
  );
  const standalone = {
    db,
    projectId,
    capabilityProfile: { mcps: profile.packageMcpRefs },
    frozenTargets: profile.mcpTargets,
    requiredMcpRefs: profile.packageMcpRefs,
    capabilityAgent: "claude",
    execTrust: "trusted" as const,
    runId: randomUUID(),
  };
  const designRoot = sources["tool-design"]!;
  const manifestPath = join(designRoot, "maister-package.yaml");

  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace(
      "https://mcp.example.com",
      "https://v2.example.com",
    ),
  );
  await writeFile(
    join(designRoot, "bundle", "skills", "collide", "companion.md"),
    "new-design",
  );
  const upgraded = await installPackageRevision({
    source: designRoot,
    version: "tool-design/v2",
    trustStatus: "trusted_by_policy",
    db,
  });

  await upgradeAttachment({
    projectId,
    projectSlug: "delivery",
    attachmentId: attachments["tool-design"]!,
    packageInstallId: upgraded.id,
    workspaceRoot,
    db,
  });
  const afterAdoption = await resolveCurrentPackageSessionCatalog(db, action);

  expect(
    afterAdoption.catalog.find((c) => c.capabilityRefId === "tool-design-mcp")
      ?.material.url,
  ).toBe("https://mcp.example.com");
  expect(await resolveAgentProfileMcpServers(standalone)).toEqual([
    expect.objectContaining({ name: refId, url: "https://mcp.example.com" }),
  ]);
  expect(await availableAgentMcpCatalog(db, projectId)).toContainEqual(
    expect.objectContaining({
      capabilityRefId: refId,
      material: expect.objectContaining({ url: "https://v2.example.com" }),
    }),
  );
  await db
    .update(schema.packageInstalls)
    .set({ trustStatus: "untrusted" })
    .where(eq(schema.packageInstalls.id, effective.packageInstallId));
  try {
    await expect(
      resolveAgentProfileMcpServers(standalone),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "agent_mcp_target_unavailable", refId },
    });
  } finally {
    await db
      .update(schema.packageInstalls)
      .set({ trustStatus: "trusted_by_policy" })
      .where(eq(schema.packageInstalls.id, effective.packageInstallId));
  }
  expect(
    (
      await capturePackageDelivery(db, {
        projectId,
        flowPackageInstallId: releases["tool-dev"]!,
        flowManifest: graph,
        nonPackageMcpRefs: [],
      })
    )?.packages.find((p) => p.name === "tool-design")?.installId,
  ).toBe(upgraded.id);
  await materializePackageSessionSkills({
    cwd,
    runId,
    nodeAttemptId: "later-sketch",
    delivery,
    skills: sketch.skills,
  });
  expect(
    await readFile(
      join(root, "later-sketch", "package-skills", "collide", "companion.md"),
      "utf8",
    ),
  ).toBe("tool-design");
  await db
    .update(schema.capabilityRecords)
    .set({ disabledAt: new Date() })
    .where(
      and(
        eq(schema.capabilityRecords.projectId, projectId),
        eq(schema.capabilityRecords.capabilityRefId, "tool-design-mcp"),
      ),
    );
  await expect(resolveCurrentPackageSessionCatalog(db, action)).rejects.toThrow(
    "tool-design-mcp",
  );
  expect(
    (await resolveCurrentPackageSessionCatalog(db, { ...action, required: [] }))
      .withheld,
  ).toEqual(["tool-design-mcp"]);
  await expect(resolveAgentProfileMcpServers(standalone)).rejects.toMatchObject(
    {
      code: "PRECONDITION",
      details: { reason: "agent_mcp_target_unavailable", refId },
    },
  );
  await writeFile(
    join(root, "attempt-a", "package-skills", "collide", "companion.md"),
    "changed",
  );
  await expect(
    materializePackageSessionSkills({
      cwd,
      runId,
      nodeAttemptId: "attempt-a",
      delivery,
      skills: build.skills,
    }),
  ).rejects.toThrow("Pinned skill bytes changed");
  const [activeBundle] = await db
    .select({ root: schema.capabilityImports.installedPath })
    .from(schema.capabilityImports)
    .where(eq(schema.capabilityImports.packageInstallId, upgraded.id));
  const companion = join(
    activeBundle!.root,
    "skills",
    "collide",
    "companion.md",
  );
  const captureCurrent = () =>
    capturePackageDelivery(db, {
      projectId,
      flowPackageInstallId: upgraded.id,
      flowManifest: graph,
      nonPackageMcpRefs: [],
    });

  await rm(companion);
  await symlink(designRoot, companion);
  await expect(captureCurrent()).rejects.toThrow("outside its pin");
  await rm(companion);
  await symlink(".", companion);
  await expect(captureCurrent()).rejects.toThrow("directory cycle");
  await expect(stat(join(cwd, ".claude", "skills"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

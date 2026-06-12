import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  attachPackage,
  detachPackage,
  installPackageRevision,
  trustPackageRevision,
  upgradeAttachment,
} from "@/lib/packages/attach";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let homeDir: string;
let workspaceRoot: string;
let pkgV1: string;
let pkgV2: string;
let projectId: string;
let originalHome: string | undefined;

const FLOW_YAML = (name: string): string =>
  `schemaVersion: 1\nname: ${name}\nsteps:\n  - id: s1\n    type: cli\n    command: echo hi\n`;

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
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("attach_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

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

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await pool?.end();
  await container?.stop();
  for (const dir of [homeDir, workspaceRoot, pkgV1, pkgV2]) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("package attach lifecycle (integration)", () => {
  let installV1: string;
  let installV2: string;
  let attachmentId: string;

  it("installPackageRevision: two-phase install + idempotent reuse", async () => {
    const first = await installPackageRevision({
      source: pkgV1,
      version: "attpkg/v1.0.0",
      trustStatus: "trusted_by_policy",
      db,
    });

    expect(first.reused).toBe(false);
    installV1 = first.id;

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
      agents: ["agent-one"],
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

  it("attachPackage: ONE tx writes flows + imports + ingestion + attachment (SET)", async () => {
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

    await expect(
      detachPackage({ projectId, attachmentId, db }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "PRECONDITION",
    );

    await db.delete(schema.runs).where(eq(schema.runs.id, runId));
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
          ),
        ),
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
        ),
      );

    expect(records.map((r: any) => r.capabilityRefId).sort()).toEqual([
      "att-mcp",
      "att-protect",
    ]);
  });
});

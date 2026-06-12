import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let homeDir: string;
let projectDir: string;
let pkgDir: string;
let originalHome: string | undefined;

const SLUG = "reg-pkg-proj";

// The seeded bootstrap admin (migration 0005) is the FK target for the owner
// membership; authz is mocked to avoid @/auth → next-auth in the module graph.
const ADMIN_ID = "usr_bootstrap_admin";

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: vi.fn(async () => ({
    id: ADMIN_ID,
    role: "admin",
    mustChangePassword: false,
  })),
  requireActiveSession: vi.fn(async () => ({ id: ADMIN_ID, role: "admin" })),
  requireProjectAction: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

// Source resolution is covered elsewhere; here it must hand the route a real
// on-disk project dir without running git. Other graph modules import
// redactUrl/detectProvider/readRemoteOrigin — provide them all.
vi.mock("@/lib/repo-source", () => ({
  gitInit: vi.fn(async () => undefined),
  redactUrl: (url: string) => url,
  detectProvider: vi.fn(() => null),
  readRemoteOrigin: vi.fn(async () => null),
  resolveProjectSource: vi.fn(async () => ({
    dir: projectDir,
    repoUrl: null,
    provider: null,
    gitStatus: "no-remote",
    clonedByUs: false,
  })),
}));

let POST: typeof import("@/app/api/projects/route").POST;
let packagesGET: typeof import("@/app/api/projects/[slug]/packages/route").GET;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("reg_pkg_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "reg-pkg-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  pkgDir = await mkdtemp(join(tmpdir(), "reg-pkg-fixture-"));
  await mkdir(join(pkgDir, "flows/reg-flow"), { recursive: true });
  await writeFile(
    join(pkgDir, "flows/reg-flow/flow.yaml"),
    "schemaVersion: 1\nname: reg-flow\nsteps:\n  - id: s1\n    type: cli\n    command: echo hi\n",
  );
  await mkdir(join(pkgDir, "capability/skills/skill-one"), { recursive: true });
  await mkdir(join(pkgDir, "capability/agents"), { recursive: true });
  await writeFile(join(pkgDir, "capability/skills/skill-one/SKILL.md"), "s\n");
  await writeFile(join(pkgDir, "capability/agents/agent-one.md"), "a\n");
  await writeFile(
    join(pkgDir, "maister-package.yaml"),
    `schemaVersion: 1
name: regpkg
flows:
  - { id: reg-flow, path: flows/reg-flow }
capabilities:
  - { id: reg-bundle, path: capability }
mcps:
  - { id: reg-mcp, transport: http, url: "https://mcp.example.com", env: ["env:REG_TOKEN"] }
restrictions:
  - { id: reg-protect, paths: ["docs/**"] }
`,
  );

  projectDir = await mkdtemp(join(tmpdir(), "reg-pkg-proj-"));
  await writeFile(
    join(projectDir, "maister.yaml"),
    `schemaVersion: 2
project:
  name: Reg Pkg Proj
flows: []
packages:
  - { id: regpkg, source: ${pkgDir}, version: local }
`,
  );

  ({ POST } = await import("@/app/api/projects/route"));
  ({ GET: packagesGET } = await import(
    "@/app/api/projects/[slug]/packages/route"
  ));
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await pool?.end();
  await container?.stop();
  for (const dir of [homeDir, projectDir, pkgDir]) {
    await rm(dir, { recursive: true, force: true });
  }
  // Member-flow symlinks land under the route's default workspace root (cwd).
  await rm(path.join(process.cwd(), ".maister", SLUG), {
    recursive: true,
    force: true,
  });
});

describe("POST /api/projects — packages[] bootstrap materializes the attachment model (real fixture)", () => {
  it("registers with packages[] and produces install + attachment + FK-wired members + ingestion", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: projectDir }),
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.slug).toBe(SLUG);

    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.slug, SLUG));

    // Platform install row: local source → trusted_by_policy, Installed.
    const installs = await db.select().from(schema.packageInstalls);

    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({
      name: "regpkg",
      packageStatus: "Installed",
      trustStatus: "trusted_by_policy",
    });

    // Attachment row — the packages tab / project APIs read THIS, so the
    // bootstrapped package is manageable after registration.
    const attachments = await db
      .select()
      .from(schema.projectPackageAttachments)
      .where(eq(schema.projectPackageAttachments.projectId, project.id));

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      packageName: "regpkg",
      packageInstallId: installs[0].id,
    });

    // Member rows joined to the group via package_install_id.
    const flowRows = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.projectId, project.id));

    expect(flowRows.map((f: any) => f.flowRefId)).toEqual(["reg-flow"]);
    expect(flowRows[0].packageInstallId).toBe(installs[0].id);
    expect(flowRows[0].trustStatus).toBe("trusted_by_policy");

    const imports = await db
      .select()
      .from(schema.capabilityImports)
      .where(eq(schema.capabilityImports.projectId, project.id));

    expect(imports).toHaveLength(1);
    expect(imports[0].packageInstallId).toBe(installs[0].id);
    expect(imports[0].setupStatus).toMatch(/done|not_required/);

    // Typed ingestion (mcps[] / restrictions[]) — previously silently dropped
    // on the registration path — plus the bundle agent_definition record.
    const records = await db
      .select()
      .from(schema.capabilityRecords)
      .where(
        and(
          eq(schema.capabilityRecords.projectId, project.id),
          eq(schema.capabilityRecords.source, "flow-package"),
        ),
      );
    const byRef = new Map(records.map((r: any) => [r.capabilityRefId, r]));

    expect(byRef.get("reg-mcp")?.kind).toBe("mcp");
    expect(byRef.get("reg-mcp")?.material).toMatchObject({
      packageInstallId: installs[0].id,
    });
    expect(byRef.get("reg-protect")?.kind).toBe("restriction");
    expect(byRef.get("reg-bundle")?.kind).toBe("agent_definition");
  });

  it("exposes the bootstrapped package through GET /api/projects/{slug}/packages", async () => {
    const res = await packagesGET(
      new NextRequest(`http://localhost/api/projects/${SLUG}/packages`),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({
      packageName: "regpkg",
      flows: ["reg-flow"],
    });
  });
});

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let homeDir: string;
let workspaceRoot: string;
let pkgDir: string;
let projectId: string;
let originalHome: string | undefined;

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({ id: "usr_bootstrap_admin" })),
  requireProjectAction: vi.fn(async () => undefined),
  requireGlobalRole: vi.fn(async () => ({ id: "usr_bootstrap_admin" })),
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

let attachPOST: typeof import("@/app/api/projects/[slug]/packages/route").POST;
let attachGET: typeof import("@/app/api/projects/[slug]/packages/route").GET;
let detachDELETE: typeof import("@/app/api/projects/[slug]/packages/[attachmentId]/route").DELETE;

function jsonRequest(url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("pkg_routes_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "pkg-routes-home-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "pkg-routes-ws-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  await writeFile(
    join(workspaceRoot, "maister.yaml"),
    "schemaVersion: 2\n# keep this comment\nflows: []\n",
    "utf8",
  );

  pkgDir = await mkdtemp(join(tmpdir(), "pkg-routes-fixture-"));
  await mkdir(join(pkgDir, "flows/route-flow"), { recursive: true });
  await writeFile(
    join(pkgDir, "flows/route-flow/flow.yaml"),
    "schemaVersion: 1\nname: route-flow\nsteps:\n  - id: s1\n    type: cli\n    command: echo hi\n",
  );
  await writeFile(
    join(pkgDir, "maister-package.yaml"),
    "schemaVersion: 1\nname: routepkg\nflows:\n  - { id: route-flow, path: flows/route-flow }\n",
  );

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "pkg-routes",
    name: "Pkg Routes",
    repoPath: workspaceRoot,
    maisterYamlPath: join(workspaceRoot, "maister.yaml"),
  });

  ({ POST: attachPOST, GET: attachGET } = await import(
    "@/app/api/projects/[slug]/packages/route"
  ));
  ({ DELETE: detachDELETE } = await import(
    "@/app/api/projects/[slug]/packages/[attachmentId]/route"
  ));
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await pool?.end();
  await container?.stop();
  for (const dir of [homeDir, workspaceRoot, pkgDir]) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("project packages routes (integration)", () => {
  let installId: string;
  let attachmentId: string;

  it("attach 404s for an unknown package install", async () => {
    const res = await attachPOST(
      jsonRequest("/api/projects/pkg-routes/packages", {
        packageInstallId: randomUUID(),
      }),
      { params: Promise.resolve({ slug: "pkg-routes" }) },
    );

    expect(res.status).toBe(404);
  });

  it("attach 422s on a bad body", async () => {
    const res = await attachPOST(
      jsonRequest("/api/projects/pkg-routes/packages", { nope: true }),
      { params: Promise.resolve({ slug: "pkg-routes" }) },
    );

    expect(res.status).toBe(422);
  });

  it("attach happy path: 201 + write-back pins packages[] in maister.yaml", async () => {
    const { installPackageRevision } = await import("@/lib/packages/attach");
    const installed = await installPackageRevision({
      source: pkgDir,
      version: "routepkg/v1.0.0",
      trustStatus: "trusted_by_policy",
      db,
    });

    installId = installed.id;

    const res = await attachPOST(
      jsonRequest("/api/projects/pkg-routes/packages", {
        packageInstallId: installId,
      }),
      { params: Promise.resolve({ slug: "pkg-routes" }) },
    );

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.writeBack).toBe("ok");
    attachmentId = body.attachmentId;

    const yamlText = await readFile(join(workspaceRoot, "maister.yaml"), "utf8");

    expect(yamlText).toContain("# keep this comment");
    const parsed = parseYaml(yamlText);

    expect(parsed.packages).toEqual([
      { id: "routepkg", source: pkgDir, version: "routepkg/v1.0.0" },
    ]);

    const listRes = await attachGET(
      jsonRequest("/api/projects/pkg-routes/packages"),
      { params: Promise.resolve({ slug: "pkg-routes" }) },
    );
    const list = await listRes.json();

    expect(list.attachments).toHaveLength(1);
    expect(list.attachments[0]).toMatchObject({
      packageName: "routepkg",
      versionLabel: "routepkg/v1.0.0",
      updateAvailable: false,
      flows: ["route-flow"],
    });
  });

  it("detach: 200 + write-back removes the pin", async () => {
    const res = await detachDELETE(
      jsonRequest("/api/projects/pkg-routes/packages/x"),
      {
        params: Promise.resolve({
          slug: "pkg-routes",
          attachmentId,
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.writeBack).toBe("ok");

    const parsed = parseYaml(
      await readFile(join(workspaceRoot, "maister.yaml"), "utf8"),
    );

    expect(parsed.packages).toEqual([]);
  });
});

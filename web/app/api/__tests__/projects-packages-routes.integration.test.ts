import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { requireGlobalRole } from "@/lib/authz";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schemaModule>;
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
let trustPOST: typeof import("@/app/api/projects/[slug]/packages/[attachmentId]/trust/route").POST;

function jsonRequest(url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "pkg_routes_test",
  });
  db = testDatabase.db;

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
    "schemaVersion: 1\nname: route-flow\ncompat:\n  engine_min: 1.1.0\nnodes:\n  - id: s1\n    type: cli\n    action:\n      command: echo hi\n    transitions:\n      success: done\n",
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
  ({ POST: trustPOST } = await import(
    "@/app/api/projects/[slug]/packages/[attachmentId]/trust/route"
  ));
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await testDatabase?.stop();
  for (const dir of [homeDir, workspaceRoot, pkgDir]) {
    await rm(dir, { recursive: true, force: true });
  }
});

// Shared across describes: the fork-beside-upstream block below forks the
// upstream install the first block attached.
let installId: string;
let attachmentId: string;

describe("project packages routes (integration)", () => {
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

    const yamlText = await readFile(
      join(workspaceRoot, "maister.yaml"),
      "utf8",
    );

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

  it("trust requires the GLOBAL admin role — project-scoped managePackages is not sufficient", async () => {
    vi.mocked(requireGlobalRole).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "Requires global role: admin"),
    );

    const res = await trustPOST(
      jsonRequest("/api/projects/pkg-routes/packages/any/trust", {}),
      {
        params: Promise.resolve({ slug: "pkg-routes", attachmentId: "any" }),
      },
    );

    expect(res.status).toBe(403);
    expect(requireGlobalRole).toHaveBeenCalledWith("admin");
  });

  it("trust as global admin: 200 + revision trust applied", async () => {
    const attachRes = await attachPOST(
      jsonRequest("/api/projects/pkg-routes/packages", {
        packageInstallId: installId,
      }),
      { params: Promise.resolve({ slug: "pkg-routes" }) },
    );

    expect(attachRes.status).toBe(201);
    const attBody = await attachRes.json();

    const res = await trustPOST(
      jsonRequest(
        `/api/projects/pkg-routes/packages/${attBody.attachmentId}/trust`,
        {},
      ),
      {
        params: Promise.resolve({
          slug: "pkg-routes",
          attachmentId: attBody.attachmentId,
        }),
      },
    );

    expect(res.status).toBe(200);

    const [install] = await db
      .select()
      .from(schema.packageInstalls)
      .where(eq(schema.packageInstalls.id, installId));

    expect(install.trustStatus).toBe("trusted");
  });
});

// ADR-132 §c (T15): a fork's cut shares its upstream's package name — the
// (projectId, packageName) unique surfaces as a TYPED 409 naming the
// collision and the rename path, never an opaque DB error or the downstream
// flow-id message. After the Studio rename journey (manifest name + flow id
// → cut) the fork attaches beside the upstream.
describe("fork-beside-upstream name uniqueness (integration)", () => {
  let localPackageId: string;

  it("attaching a fork cut with the upstream's name → 409 package_name_taken (pre-flow-guard)", async () => {
    const { forkPackageToLocal } = await import("@/lib/local-packages/fork");
    const { getLocalPackage } = await import("@/lib/local-packages/service");
    const { cutLocalPackageVersion } = await import(
      "@/lib/local-packages/versions"
    );

    const userId = randomUUID();

    await db.insert(schema.users).values({
      id: userId,
      email: `u-${userId}@x.test`,
      name: "Fork Author",
    });

    // installId (routepkg upstream) is attached to the project by the trust
    // test above — the fork below collides with it by name AND flow id.
    ({ localPackageId } = await forkPackageToLocal({
      sourceInstallId: installId,
      sourceRef: "routepkg",
      createdBy: userId,
      forceNew: true,
      db,
    }));
    const pkg = await getLocalPackage(localPackageId, db);
    const cut = await cutLocalPackageVersion(pkg!, { db });

    const res = await attachPOST(
      jsonRequest("/api/projects/pkg-routes/packages", {
        packageInstallId: cut.installId,
      }),
      { params: Promise.resolve({ slug: "pkg-routes" }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();

    expect(body.code).toBe("CONFLICT");
    expect(body.details).toEqual({
      reason: "package_name_taken",
      packageName: "routepkg",
    });
  });

  it("after manifest rename (name + flow id) + re-cut, the fork attaches beside the upstream", async () => {
    const { getLocalPackage, writeWorkingDirFile } = await import(
      "@/lib/local-packages/service"
    );
    const { cutLocalPackageVersion } = await import(
      "@/lib/local-packages/versions"
    );

    const pkg = await getLocalPackage(localPackageId, db);

    await writeWorkingDirFile(
      pkg!,
      "maister-package.yaml",
      "schemaVersion: 1\nname: routepkg-fork\nflows:\n  - { id: route-flow-fork, path: flows/route-flow }\n",
    );
    const renamedCut = await cutLocalPackageVersion(pkg!, { db });

    const res = await attachPOST(
      jsonRequest("/api/projects/pkg-routes/packages", {
        packageInstallId: renamedCut.installId,
      }),
      { params: Promise.resolve({ slug: "pkg-routes" }) },
    );

    expect(res.status).toBe(201);

    const listRes = await attachGET(
      jsonRequest("/api/projects/pkg-routes/packages"),
      { params: Promise.resolve({ slug: "pkg-routes" }) },
    );
    const list = await listRes.json();
    const names = list.attachments
      .map((a: { packageName: string }) => a.packageName)
      .sort();

    expect(names).toEqual(["routepkg", "routepkg-fork"]);
  });
});

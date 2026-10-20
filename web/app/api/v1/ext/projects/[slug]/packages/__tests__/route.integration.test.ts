import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { parse as parseYaml } from "yaml";

import * as schemaModule from "@/lib/db/schema";
import { attachPackage, installPackageRevision } from "@/lib/packages/attach";
import { issueToken } from "@/lib/tokens/issue";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schemaModule>;
let originalHome: string | undefined;
let homeDir: string;
let packageV1Dir: string;
let packageV2Dir: string;
let otherPackageDir: string;
let installV1Id: string;
let installV2Id: string;
let otherInstallId: string;
const tempDirs: string[] = [];

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let listPackages: typeof import("@/app/api/v1/ext/projects/[slug]/packages/route").GET;
let attachPackageRoute: typeof import("@/app/api/v1/ext/projects/[slug]/packages/route").POST;
let updatePackageRoute: typeof import("@/app/api/v1/ext/projects/[slug]/packages/[attachmentId]/route").PATCH;
let detachPackageRoute: typeof import("@/app/api/v1/ext/projects/[slug]/packages/[attachmentId]/route").DELETE;

async function createPackageFixture(args: {
  name: string;
  flowId: string;
  command: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ext-packages-${args.name}-`));

  tempDirs.push(root);
  await mkdir(join(root, "flows", args.flowId), { recursive: true });
  await writeFile(
    join(root, "flows", args.flowId, "flow.yaml"),
    `schemaVersion: 1\nname: ${args.flowId}\ncompat:\n  engine_min: 1.1.0\nnodes:\n  - id: run\n    type: cli\n    action:\n      command: ${args.command}\n    transitions:\n      success: done\n`,
    "utf8",
  );
  await writeFile(
    join(root, "maister-package.yaml"),
    `schemaVersion: 1\nname: ${args.name}\nflows:\n  - { id: ${args.flowId}, path: flows/${args.flowId} }\n`,
    "utf8",
  );

  return root;
}

async function seedProject(slug: string): Promise<{
  projectId: string;
  workspaceRoot: string;
}> {
  const projectId = randomUUID();
  const workspaceRoot = await mkdtemp(join(tmpdir(), `ext-pkg-${slug}-`));

  tempDirs.push(workspaceRoot);
  await writeFile(
    join(workspaceRoot, "maister.yaml"),
    "schemaVersion: 2\n# preserved\nflows: []\n",
    "utf8",
  );
  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug,
    name: `Project ${slug}`,
    repoPath: workspaceRoot,
    maisterYamlPath: join(workspaceRoot, "maister.yaml"),
  });

  return { projectId, workspaceRoot };
}

function request(args: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  token?: string;
  body?: unknown;
  rawBody?: string;
}): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });

  if (args.token) headers.set("authorization", `Bearer ${args.token}`);

  return new NextRequest(`http://localhost${args.url}`, {
    method: args.method,
    headers,
    ...(args.body === undefined && args.rawBody === undefined
      ? {}
      : {
          body:
            args.rawBody === undefined
              ? JSON.stringify(args.body)
              : args.rawBody,
        }),
  });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_packages_route_test",
  });
  db = testDatabase.db;

  originalHome = process.env.HOME;
  homeDir = await mkdtemp(join(tmpdir(), "ext-packages-home-"));
  tempDirs.push(homeDir);
  process.env.HOME = homeDir;

  packageV1Dir = await createPackageFixture({
    name: "ext-routepkg",
    flowId: "ext-route-flow",
    command: "echo-v1",
  });
  packageV2Dir = await createPackageFixture({
    name: "ext-routepkg",
    flowId: "ext-route-flow",
    command: "echo-v2",
  });
  otherPackageDir = await createPackageFixture({
    name: "ext-otherpkg",
    flowId: "ext-other-flow",
    command: "echo-other",
  });

  installV1Id = (
    await installPackageRevision({
      source: packageV1Dir,
      version: "ext-routepkg/v1.0.0",
      trustStatus: "trusted_by_policy",
      db,
    })
  ).id;
  installV2Id = (
    await installPackageRevision({
      source: packageV2Dir,
      version: "ext-routepkg/v1.1.0",
      trustStatus: "trusted_by_policy",
      db,
    })
  ).id;
  otherInstallId = (
    await installPackageRevision({
      source: otherPackageDir,
      version: "ext-otherpkg/v1.0.0",
      trustStatus: "trusted_by_policy",
      db,
    })
  ).id;

  ({ GET: listPackages, POST: attachPackageRoute } = await import(
    "@/app/api/v1/ext/projects/[slug]/packages/route"
  ));
  ({ PATCH: updatePackageRoute, DELETE: detachPackageRoute } = await import(
    "@/app/api/v1/ext/projects/[slug]/packages/[attachmentId]/route"
  ));
}, 180_000);

beforeEach(async () => {
  await db.delete(schema.tokenAuditLog as any);
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await testDatabase?.stop();
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("external project package routes", () => {
  it("invalid token returns 401 without an audit row", async () => {
    const slug = `ext-pkg-auth-${randomUUID().slice(0, 8)}`;

    await seedProject(slug);
    const res = await listPackages(
      request({
        method: "GET",
        url: `/api/v1/ext/projects/${slug}/packages`,
        token: "invalid",
      }),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(401);
    expect(await db.select().from(schema.tokenAuditLog as any)).toHaveLength(0);
  });

  it("requires the explicit packages:manage scope", async () => {
    const slug = `ext-pkg-scope-${randomUUID().slice(0, 8)}`;
    const { projectId } = await seedProject(slug);
    const token = await issueToken(
      { projectId, name: "No package scope", scopes: ["tasks:read"] },
      db,
    );
    const res = await listPackages(
      request({
        method: "GET",
        url: `/api/v1/ext/projects/${slug}/packages`,
        token: token.secret,
      }),
      { params: Promise.resolve({ slug }) },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      details: { requiredScope: "packages:manage" },
    });
    const auditRows = await db.select().from(schema.tokenAuditLog as any);

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "error",
      status_code: 403,
      scope_used: "packages:manage",
    });
  });

  it("attaches an installed package, lists it, and writes the manifest pin", async () => {
    const slug = `ext-pkg-attach-${randomUUID().slice(0, 8)}`;
    const { projectId, workspaceRoot } = await seedProject(slug);
    const token = await issueToken(
      { projectId, name: "Package manager", scopes: ["packages:manage"] },
      db,
    );
    const attachRes = await attachPackageRoute(
      request({
        method: "POST",
        url: `/api/v1/ext/projects/${slug}/packages`,
        token: token.secret,
        body: { packageInstallId: installV1Id },
      }),
      { params: Promise.resolve({ slug }) },
    );

    expect(attachRes.status).toBe(201);
    expect(await attachRes.json()).toMatchObject({ ok: true, writeBack: "ok" });

    const listRes = await listPackages(
      request({
        method: "GET",
        url: `/api/v1/ext/projects/${slug}/packages`,
        token: token.secret,
      }),
      { params: Promise.resolve({ slug }) },
    );
    const listed = await listRes.json();

    expect(listRes.status).toBe(200);
    expect(listed.attachments).toHaveLength(1);
    expect(listed.attachments[0]).toMatchObject({
      packageInstallId: installV1Id,
      packageName: "ext-routepkg",
      versionLabel: "ext-routepkg/v1.0.0",
      trustStatus: "trusted_by_policy",
      flows: ["ext-route-flow"],
    });
    expect(
      listed.availableInstalls.map((install: { id: string }) => install.id),
    ).toEqual(expect.arrayContaining([installV1Id, installV2Id]));

    const manifest = parseYaml(
      await readFile(join(workspaceRoot, "maister.yaml"), "utf8"),
    );

    expect(manifest.packages).toEqual([
      {
        id: "ext-routepkg",
        source: packageV1Dir,
        version: "ext-routepkg/v1.0.0",
      },
    ]);
    const audits = await db.select().from(schema.tokenAuditLog as any);

    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: "ok",
          scope_used: "packages:manage",
          endpoint: "POST /api/v1/ext/projects/[slug]/packages",
        }),
        expect.objectContaining({
          result: "ok",
          scope_used: "packages:manage",
          endpoint: "GET /api/v1/ext/projects/[slug]/packages",
        }),
      ]),
    );
  });

  it("upgrades only the same package with compare-and-swap protection", async () => {
    const slug = `ext-pkg-upgrade-${randomUUID().slice(0, 8)}`;
    const { projectId, workspaceRoot } = await seedProject(slug);
    const token = await issueToken(
      { projectId, name: "Package manager", scopes: ["packages:manage"] },
      db,
    );
    const attachRes = await attachPackageRoute(
      request({
        method: "POST",
        url: `/api/v1/ext/projects/${slug}/packages`,
        token: token.secret,
        body: { packageInstallId: installV1Id },
      }),
      { params: Promise.resolve({ slug }) },
    );
    const { attachmentId } = await attachRes.json();

    const staleRes = await updatePackageRoute(
      request({
        method: "PATCH",
        url: `/api/v1/ext/projects/${slug}/packages/${attachmentId}`,
        token: token.secret,
        body: {
          packageInstallId: installV2Id,
          expectedPackageInstallId: randomUUID(),
        },
      }),
      { params: Promise.resolve({ slug, attachmentId }) },
    );

    expect(staleRes.status).toBe(409);
    expect(await staleRes.json()).toMatchObject({
      code: "CONFLICT",
      details: { reason: "stale_attachment_revision" },
    });

    const wrongPackageRes = await updatePackageRoute(
      request({
        method: "PATCH",
        url: `/api/v1/ext/projects/${slug}/packages/${attachmentId}`,
        token: token.secret,
        body: {
          packageInstallId: otherInstallId,
          expectedPackageInstallId: installV1Id,
        },
      }),
      { params: Promise.resolve({ slug, attachmentId }) },
    );

    expect(wrongPackageRes.status).toBe(409);

    const upgradeRes = await updatePackageRoute(
      request({
        method: "PATCH",
        url: `/api/v1/ext/projects/${slug}/packages/${attachmentId}`,
        token: token.secret,
        body: {
          packageInstallId: installV2Id,
          expectedPackageInstallId: installV1Id,
        },
      }),
      { params: Promise.resolve({ slug, attachmentId }) },
    );

    expect(upgradeRes.status).toBe(200);
    expect(await upgradeRes.json()).toMatchObject({
      ok: true,
      writeBack: "ok",
    });
    const [attachment] = await db
      .select()
      .from(schema.projectPackageAttachments)
      .where(eq(schema.projectPackageAttachments.id, attachmentId));

    expect(attachment.packageInstallId).toBe(installV2Id);
    const manifest = parseYaml(
      await readFile(join(workspaceRoot, "maister.yaml"), "utf8"),
    );

    expect(manifest.packages[0].version).toBe("ext-routepkg/v1.1.0");
  });

  it("hides an attachment owned by another project", async () => {
    const visibleSlug = `ext-pkg-visible-${randomUUID().slice(0, 8)}`;
    const hiddenSlug = `ext-pkg-hidden-${randomUUID().slice(0, 8)}`;
    const visible = await seedProject(visibleSlug);
    const hidden = await seedProject(hiddenSlug);
    const token = await issueToken(
      {
        projectId: visible.projectId,
        name: "Visible package manager",
        scopes: ["packages:manage"],
      },
      db,
    );
    const hiddenAttachment = await attachPackage({
      projectId: hidden.projectId,
      projectSlug: hiddenSlug,
      packageInstallId: installV1Id,
      workspaceRoot: hidden.workspaceRoot,
      db,
    });

    const res = await detachPackageRoute(
      request({
        method: "DELETE",
        url: `/api/v1/ext/projects/${visibleSlug}/packages/${hiddenAttachment!.attachmentId}`,
        token: token.secret,
      }),
      {
        params: Promise.resolve({
          slug: visibleSlug,
          attachmentId: hiddenAttachment!.attachmentId,
        }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("detaches the package and removes its manifest pin", async () => {
    const slug = `ext-pkg-detach-${randomUUID().slice(0, 8)}`;
    const { projectId, workspaceRoot } = await seedProject(slug);
    const token = await issueToken(
      { projectId, name: "Package manager", scopes: ["packages:manage"] },
      db,
    );
    const attachRes = await attachPackageRoute(
      request({
        method: "POST",
        url: `/api/v1/ext/projects/${slug}/packages`,
        token: token.secret,
        body: { packageInstallId: installV1Id },
      }),
      { params: Promise.resolve({ slug }) },
    );
    const { attachmentId } = await attachRes.json();
    const detachRes = await detachPackageRoute(
      request({
        method: "DELETE",
        url: `/api/v1/ext/projects/${slug}/packages/${attachmentId}`,
        token: token.secret,
      }),
      { params: Promise.resolve({ slug, attachmentId }) },
    );

    expect(detachRes.status).toBe(200);
    expect(await detachRes.json()).toMatchObject({ ok: true, writeBack: "ok" });
    const manifest = parseYaml(
      await readFile(join(workspaceRoot, "maister.yaml"), "utf8"),
    );

    expect(manifest.packages).toEqual([]);
  });

  it("rejects malformed JSON and unknown package installs", async () => {
    const slug = `ext-pkg-invalid-${randomUUID().slice(0, 8)}`;
    const { projectId } = await seedProject(slug);
    const token = await issueToken(
      { projectId, name: "Package manager", scopes: ["packages:manage"] },
      db,
    );
    const malformed = await attachPackageRoute(
      request({
        method: "POST",
        url: `/api/v1/ext/projects/${slug}/packages`,
        token: token.secret,
        rawBody: "{",
      }),
      { params: Promise.resolve({ slug }) },
    );

    expect(malformed.status).toBe(422);

    const unknown = await attachPackageRoute(
      request({
        method: "POST",
        url: `/api/v1/ext/projects/${slug}/packages`,
        token: token.secret,
        body: { packageInstallId: randomUUID() },
      }),
      { params: Promise.resolve({ slug }) },
    );

    expect(unknown.status).toBe(404);
  });
});

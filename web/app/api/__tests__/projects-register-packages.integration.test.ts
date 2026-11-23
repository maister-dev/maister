import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let root: string;
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

let POST: typeof import("@/app/api/projects/route").POST;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "reg_pkg_test",
  });
  db = testDatabase.db;
  root = await mkdtemp(join(tmpdir(), "reg-pkg-proj-"));
  ({ POST } = await import("@/app/api/projects/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function register(name: string, body: string) {
  const target = join(root, name);

  await mkdir(target);
  await writeFile(
    join(target, "maister.yaml"),
    `schemaVersion: 2
project: { name: ${name} }
${body}`,
  );

  return POST(
    new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify({ target }),
    }),
  );
}

describe("POST /api/projects — register dependencies before installation", () => {
  it("accepts a project before reading a package with an unsupported member", async () => {
    const pkg = join(root, "legacy-pkg");

    await mkdir(join(pkg, "legacy"), { recursive: true });
    await writeFile(
      join(pkg, "maister-package.yaml"),
      "schemaVersion: 1\nname: legacy\nflows: [{ id: legacy, path: legacy }]\n",
    );
    await writeFile(
      join(pkg, "legacy/flow.yaml"),
      "schemaVersion: 1\nname: legacy\nsteps: []\n",
    );

    const response = await register(
      "legacy-registration",
      `flows: []
packages:
  - { id: legacy, source: ${pkg}, version: local }`,
    );

    expect(response.status).toBe(201);
    const { projectId } = await response.json();

    expect(await db.select().from(schemaModule.packageInstalls)).toHaveLength(
      0,
    );
    expect(
      await db.select().from(schemaModule.projectPackageAttachments),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schemaModule.projectDependencyAttempts)
        .where(eq(schemaModule.projectDependencyAttempts.projectId, projectId)),
    ).toMatchObject([{ status: "pending", actorUserId: ADMIN_ID }]);
  });

  it("atomically registers owner, role and immutable inputs for all three kinds, including same-name Flow/import", async () => {
    const missing = join(root, "absent");
    const res = await register(
      "mixed",
      `flow_roles: [{ ref: reviewer }]
flows:
  - { id: common, source: ${missing}, version: v1, runner: requested }
packages:
  - { id: alias, source: ${missing}, version: rel/v1, path: subtree }
capability_imports:
  - { id: common, source: ${missing}, version: v1, trust: explicit }
capabilities:
  skills: [{ id: shown }]`,
    );

    expect(res.status).toBe(201);
    const { projectId, slug, gitStatus } = await res.json();

    expect([slug, gitStatus]).toEqual(["mixed", "initialized"]);
    const {
      projectMembers,
      projectDependencyDeclarations: heads,
      projectDependencyAttempts: attempts,
    } = schemaModule;

    expect(
      await db
        .select()
        .from(projectMembers)
        .where(eq(projectMembers.projectId, projectId)),
    ).toMatchObject([{ userId: ADMIN_ID, role: "owner" }]);
    const items = await db
      .select()
      .from(heads)
      .where(eq(heads.projectId, projectId))
      .orderBy(heads.kind);

    expect(items).toMatchObject([
      {
        kind: "capability_import",
        logicalId: "common",
        desired: { source: missing, version: "v1", trust: "explicit" },
      },
      {
        kind: "flow",
        logicalId: "common",
        desired: {
          source: missing,
          version: "v1",
          runner: "requested",
          roleRefs: ["reviewer"],
          capabilityRefIds: { skill: ["shown", "common"] },
        },
      },
      {
        kind: "package",
        logicalId: "alias",
        desired: { source: missing, version: "rel/v1", path: "subtree" },
      },
    ]);
    const work = await db
      .select()
      .from(attempts)
      .where(eq(attempts.projectId, projectId));

    expect(work).toHaveLength(items.length);
    for (const item of items) {
      expect(work.find((a) => a.declarationId === item.id)).toMatchObject({
        actorUserId: ADMIN_ID,
        status: "pending",
        attemptNo: 1,
        generation: 1,
        desired: item.desired,
      });
    }
    expect(await db.select().from(schemaModule.flows)).toHaveLength(0);
    expect(await db.select().from(schemaModule.capabilityImports)).toHaveLength(
      0,
    );
  });

  it("projects inline capabilities when there are no dependencies", async () => {
    const res = await register(
      "inline",
      "flows: []\ncapabilities:\n  restrictions: [{ id: protect, paths: ['docs/**'] }]",
    );

    expect(res.status).toBe(201);
    const { projectId } = await res.json();
    const { capabilityRecords, projectDependencyDeclarations } = schemaModule;

    expect(
      await db
        .select()
        .from(projectDependencyDeclarations)
        .where(eq(projectDependencyDeclarations.projectId, projectId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(capabilityRecords)
        .where(eq(capabilityRecords.projectId, projectId)),
    ).toMatchObject([{ kind: "restriction", capabilityRefId: "protect" }]);
  });

  it.each([
    [
      "credentials",
      "flows: []\npackages: [{ id: deps, source: 'https://user:do-not-echo@example.org/pkg', version: v1 }]",
    ],
    [
      "bad-scheme",
      "flows: []\ncapability_imports: [{id: one, source: 'unsupported://example.org/repo', version: v1}]",
    ],
    [
      "shared-package-id",
      "flows: [{ id: deps, source: /existing, version: v1 }]\npackages: [{ id: deps, source: /existing, version: v1 }]",
    ],
  ])(
    "rejects %s prior to initializing a caller-owned directory",
    async (name, body) => {
      const response = await register(name, body);

      expect(response.status).toBe(422);
      expect(await response.text()).not.toContain("do-not-echo");
      await expect(stat(join(root, name, ".git"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await db
          .select()
          .from(schemaModule.projects)
          .where(eq(schemaModule.projects.slug, name)),
      ).toHaveLength(0);
    },
  );
});

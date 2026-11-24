import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  requireGlobalRole,
  requireActiveSession,
  requireProjectAction,
} from "@/lib/authz";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { gitCommitWorkingDir } from "@/lib/local-packages/git";
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

vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  requireActiveSession: vi.fn(async () => ({
    id: "usr_bootstrap_admin",
    role: "admin",
  })),
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
  await db
    .update(schemaModule.users)
    .set({ mustChangePassword: false })
    .where(eq(schemaModule.users.id, "usr_bootstrap_admin"));

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

  await exec("git", ["-C", workspaceRoot, "init", "-b", "main"]);
  await exec("git", ["-C", workspaceRoot, "add", "maister.yaml"]);
  await exec("git", [
    "-C",
    workspaceRoot,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "initial manifest",
  ]);
  initialRepository = await repositoryFingerprint();
  ({ POST: upgradePOST } =
    await import("@/app/api/projects/[slug]/packages/[attachmentId]/upgrade/route"));
  projectId = randomUUID();
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "pkg-routes",
    name: "Pkg Routes",
    repoPath: workspaceRoot,
    maisterYamlPath: join(workspaceRoot, "maister.yaml"),
  });

  ({ POST: attachPOST, GET: attachGET } =
    await import("@/app/api/projects/[slug]/packages/route"));
  ({ DELETE: detachDELETE } =
    await import("@/app/api/projects/[slug]/packages/[attachmentId]/route"));
  ({ POST: trustPOST } =
    await import("@/app/api/projects/[slug]/packages/[attachmentId]/trust/route"));
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
const exec = promisify(execFile);

async function repositoryFingerprint(): Promise<string[]> {
  return Promise.all([
    readFile(join(workspaceRoot, "maister.yaml"), "utf8"),
    ...[
      ["rev-parse", "HEAD"],
      ["ls-files", "--stage", "-v"],
      ["status", "--porcelain=v1", "--untracked-files=all"],
    ].map(
      async (args) =>
        (await exec("git", ["-C", workspaceRoot, ...args])).stdout,
    ),
  ]);
}
let initialRepository: string[];
let upgradePOST: typeof import("@/app/api/projects/[slug]/packages/[attachmentId]/upgrade/route").POST;
let installId: string;
let attachmentId: string;

describe("project dependency declaration commands (AC06)", () => {
  const actorUserId = "usr_bootstrap_admin";
  const source = "https://example.org/packages";
  const desired = {
    source,
    version: "v1",
    path: "old",
    roleRefs: ["reviewer"],
  };
  const slug = "pkg-routes";

  async function failedDeclaration(kind: "package" | "flow" = "package") {
    const [head] = await db
      .insert(schemaModule.projectDependencyDeclarations)
      .values({
        projectId,
        kind,
        logicalId: randomUUID(),
        ordinal: 0,
        desired,
      })
      .returning();
    const [attempt] = await db
      .insert(schemaModule.projectDependencyAttempts)
      .values({
        projectId,
        declarationId: head!.id,
        generation: 1,
        attemptNo: 1,
        actorUserId,
        desired,
        status: "failed",
        stage: "resolve",
        reason: "source_unavailable",
      })
      .returning();

    return { head: head!, attempt: attempt! };
  }
  async function read(id: string) {
    const response = await attachGET(
      jsonRequest("/api/projects/pkg-routes/packages"),
      { params: Promise.resolve({ slug }) },
    );

    expect(response.status).toBe(200);

    return (await response.json()).declarations.find(
      (d: { id: string }) => d.id === id,
    );
  }

  it("exposes unresolved items, compares generation before edit replay and preserves request context", async () => {
    const { PATCH } =
      await import("@/app/api/projects/[slug]/dependency-declarations/[declarationId]/route");
    const { head } = await failedDeclaration();
    const row = await read(head.id);

    expect(row).toMatchObject({
      source,
      attempt: 1,
      generation: 1,
      effectiveRevision: null,
      state: "failed",
      actions: { edit: true, retry: true, recoverSetup: false },
    });
    const ctx = { params: Promise.resolve({ slug, declarationId: head.id }) };

    vi.mocked(requireActiveSession).mockResolvedValueOnce({
      id: "project-admin",
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    });
    expect((await read(head.id)).actions).toEqual({
      edit: false,
      retry: false,
      recoverSetup: false,
    });
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "Requires managePackages"),
    );
    expect(
      (
        await attachGET(jsonRequest("/packages"), {
          params: Promise.resolve({ slug }),
        })
      ).status,
    ).toBe(403);
    const input = {
      expectedGeneration: row.generation,
      source: row.source,
      version: "v2",
    };
    const edit = () => PATCH(jsonRequest("/edit", input), ctx);
    const response = await edit();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      generation: 2,
      attempt: 1,
      state: "pending",
      version: "v2",
      path: null,
    });
    const stale = await edit();

    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      details: { reason: "stale_generation" },
    });
    expect(
      (
        await PATCH(
          jsonRequest("/edit", { ...input, expectedGeneration: 2 }),
          ctx,
        )
      ).status,
    ).toBe(200);
    expect(await read(head.id)).toMatchObject({ generation: 2, attempt: 1 });
    const history = await db
      .select()
      .from(schemaModule.projectDependencyAttempts)
      .where(eq(schemaModule.projectDependencyAttempts.declarationId, head.id));

    expect(history).toHaveLength(2);
    expect(history.find((a) => a.generation === 2)?.desired).toEqual({
      source,
      version: "v2",
      roleRefs: ["reviewer"],
    });
    for (const [field, value] of [
      ["source", "https://admin:token@example.org/x"],
      ["source", "https://example.org/my repo"],
      ["source", "https://example.org:65536/x"],
      ["version", "release candidate"],
      ["path", "../bundle"],
    ] as const) {
      const refused = await PATCH(
        jsonRequest("/edit", {
          ...input,
          expectedGeneration: 2,
          [field]: value,
        }),
        ctx,
      );

      expect(refused.status).toBe(422);
      const body = await refused.json();

      expect(body).toMatchObject({ code: "CONFIG", details: { field } });
      expect(JSON.stringify(body)).not.toContain(value);
    }
    const { head: flow } = await failedDeclaration("flow");

    expect(
      (
        await PATCH(jsonRequest("/edit", input), {
          params: Promise.resolve({ slug, declarationId: flow.id }),
        })
      ).status,
    ).toBe(422);
  });

  it("replays the same retry after completion, scopes identifiers and authorizes before parsing or replay", async () => {
    const { POST } =
      await import("@/app/api/projects/[slug]/dependency-declarations/[declarationId]/retry/route");
    const { head, attempt: original } = await failedDeclaration("flow");
    const row = await read(head.id);
    const data = {
      expectedAttempt: row.attempt,
      expectedGeneration: row.generation,
    };
    const submit = (body: unknown = data, projectSlug = slug) =>
      POST(jsonRequest("/retry", body), {
        params: Promise.resolve({ slug: projectSlug, declarationId: head.id }),
      });
    const responses = await Promise.all([submit(), submit()]);

    for (const response of responses) {
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        declarationId: head.id,
        generation: 1,
        attempt: 2,
      });
    }
    const created = await db
      .update(schemaModule.projectDependencyAttempts)
      .set({ status: "succeeded" })
      .where(
        eq(
          schemaModule.projectDependencyAttempts.retryOfAttemptId,
          original.id,
        ),
      )
      .returning();

    expect(created).toHaveLength(1);
    expect(await (await submit()).json()).toEqual({
      declarationId: head.id,
      generation: 1,
      attempt: 2,
    });
    const other = "another-project";

    await db.insert(schemaModule.projects).values({
      id: randomUUID(),
      slug: other,
      name: other,
      repoPath: join(workspaceRoot, other),
      taskKey: "OTHZ",
    });
    expect((await submit(data, other)).status).toBe(404);
    await db
      .update(schemaModule.projects)
      .set({ archivedAt: new Date() })
      .where(eq(schemaModule.projects.slug, other));
    for (const unavailable of [other, "missing-project"]) {
      const guard = await submit(data, unavailable);

      expect(guard.status).toBe(409);
      expect(await guard.json()).toEqual({
        code: "PRECONDITION",
        message: `project not found: ${unavailable}`,
      });
      const readGuard = await attachGET(jsonRequest("/packages"), {
        params: Promise.resolve({ slug: unavailable }),
      });

      expect(readGuard.status).toBe(409);
      expect(await readGuard.json()).toMatchObject({ code: "PRECONDITION" });
    }
    vi.mocked(requireGlobalRole).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "Requires global role"),
    );
    expect((await submit()).status).toBe(403);
    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "Requires managePackages"),
    );
    expect((await submit({})).status).toBe(403);
    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "Sign in"),
    );
    expect((await submit({})).status).toBe(401);
    expect((await submit({})).status).toBe(422);
    expect((await submit({ ...data, expectedAttempt: 2 })).status).toBe(409);
  });

  it("requires exact setup recovery confirmation and replays its receipt after a lost response", async () => {
    const { POST: recover } =
      await import("@/app/api/projects/[slug]/dependency-declarations/[declarationId]/recover-setup/route");
    const { POST: retry } =
      await import("@/app/api/projects/[slug]/dependency-declarations/[declarationId]/retry/route");
    const { head, attempt } = await failedDeclaration();
    const materialKey = randomUUID();

    await db.insert(schemaModule.projectDependencySetupReceipts).values({
      materialKey,
      status: "running",
      claimToken: randomUUID(),
      ownerHost: "another-host",
      ownerPid: 1,
    });
    await db
      .update(schemaModule.projectDependencyAttempts)
      .set({
        status: "recovery_required",
        stage: "setup",
        reason: "setup_uncertain",
        memberRef: "capability:tool",
        resolvedRevision: "abcd",
        checkpoint: { setupMaterialKey: materialKey },
      })
      .where(eq(schemaModule.projectDependencyAttempts.id, attempt.id));
    const row = await read(head.id);

    expect(row.actions).toEqual({
      edit: true,
      retry: false,
      recoverSetup: true,
    });
    const ctx = { params: Promise.resolve({ slug, declarationId: row.id }) };
    const identity = {
      expectedGeneration: row.generation,
      expectedAttempt: row.attempt,
    };
    const input = {
      ...identity,
      memberRef: row.memberRef,
      resolvedRevision: row.resolvedRevision,
      action: "rerun_setup",
    };

    expect((await retry(jsonRequest("/retry", identity), ctx)).status).toBe(
      409,
    );
    expect(
      (
        await recover(
          jsonRequest("/recover", { ...input, memberRef: "flow:tool" }),
          ctx,
        )
      ).status,
    ).toBe(409);
    expect((await recover(jsonRequest("/recover", input), ctx)).status).toBe(
      409,
    );
    await db
      .update(schemaModule.projectDependencySetupReceipts)
      .set({ status: "succeeded" })
      .where(
        eq(
          schemaModule.projectDependencySetupReceipts.materialKey,
          materialKey,
        ),
      );
    for (let i = 0; i < 2; i++) {
      const result = await recover(jsonRequest("/recover", input), ctx);

      expect(result.status).toBe(202);
      expect(await result.json()).toEqual({
        declarationId: row.id,
        generation: 1,
        attempt: 2,
      });
    }
  });
});

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

  it("IT-CPC-01: attach applies runtime configuration and leaves the committed repository untouched", async () => {
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
    expect(body).not.toHaveProperty("writeBack");
    attachmentId = body.attachmentId;

    expect(await repositoryFingerprint()).toEqual(initialRepository);

    const listRes = await attachGET(
      jsonRequest("/api/projects/pkg-routes/packages"),
      { params: Promise.resolve({ slug: "pkg-routes" }) },
    );
    const list = await listRes.json();

    expect(list.declarations).toContainEqual(
      expect.objectContaining({
        ref: "routepkg",
        attempt: null,
        state: null,
        effectiveAttachmentId: attachmentId,
        effectiveRevision: installed.resolvedRevision,
        readiness: "installed",
      }),
    );
    expect(list.attachments).toHaveLength(1);
    expect(list.attachments[0]).toMatchObject({
      packageName: "routepkg",
      versionLabel: "routepkg/v1.0.0",
      updateAvailable: false,
      flows: ["route-flow"],
    });
  });

  it("reports a catalog attachment member's failed setup even without a historical registration attempt", async () => {
    const [member] = await db
      .select()
      .from(schemaModule.flowRevisions)
      .where(eq(schemaModule.flowRevisions.flowRefId, "route-flow"));

    await db
      .update(schemaModule.flowRevisions)
      .set({ setupStatus: "failed" })
      .where(eq(schemaModule.flowRevisions.id, member!.id));
    try {
      const response = await attachGET(
        jsonRequest("/api/projects/pkg-routes/packages"),
        { params: Promise.resolve({ slug: "pkg-routes" }) },
      );

      expect((await response.json()).declarations).toContainEqual(
        expect.objectContaining({
          ref: "routepkg",
          attempt: null,
          readiness: "setup_failed",
        }),
      );
    } finally {
      await db
        .update(schemaModule.flowRevisions)
        .set({ setupStatus: member!.setupStatus })
        .where(eq(schemaModule.flowRevisions.id, member!.id));
    }
  });

  it("IT-CPC-01: upgrade and downgrade change the installed runtime pin without touching Git", async () => {
    const { installPackageRevision } = await import("@/lib/packages/attach");
    const next = await installPackageRevision({
      source: pkgDir,
      version: "routepkg/v2.0.0",
      trustStatus: "trusted_by_policy",
      db,
    });

    for (const target of [next.id, installId]) {
      const res = await upgradePOST(
        jsonRequest("/api/projects/pkg-routes/packages/x/upgrade", {
          packageInstallId: target,
        }),
        { params: Promise.resolve({ slug: "pkg-routes", attachmentId }) },
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const [attachment] = await db
        .select()
        .from(schema.projectPackageAttachments)
        .where(eq(schema.projectPackageAttachments.id, attachmentId));

      expect(attachment.packageInstallId).toBe(target);
      expect(await repositoryFingerprint()).toEqual(initialRepository);
    }
  });

  it("IT-CPC-01: detach removes runtime configuration and leaves Git untouched", async () => {
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

    expect(body).toEqual({ ok: true });
    expect(await repositoryFingerprint()).toEqual(initialRepository);
  });

  it("IT-CPC-11: the install-package CLI refuses a DB-only project before any package or capability effects", async () => {
    const cliId = randomUUID();
    const cliRepo = join(homeDir, "cli-project");

    await mkdir(cliRepo);
    await db.insert(schema.projects).values({
      id: cliId,
      slug: "config-cli-no-manifest",
      name: "CLI no manifest",
      repoPath: cliRepo,
      maisterYamlPath: null,
      taskKey: `K${cliId.slice(0, 8).toUpperCase()}`,
    });
    const installsBefore = await db.select().from(schema.packageInstalls);
    const attachmentsBefore = await db
      .select()
      .from(schema.projectPackageAttachments);
    const flowsBefore = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.projectId, cliId));
    const revisionsBefore = await db.select().from(schema.flowRevisions);
    const capabilitiesBefore = await db
      .select()
      .from(schema.capabilityImports)
      .where(eq(schema.capabilityImports.projectId, cliId));
    const failure = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./scripts/_register-shim.mjs",
        "scripts/install-package.ts",
        "--project",
        "config-cli-no-manifest",
        "--source",
        pkgDir,
        "--version",
        "routepkg/v1.0.0",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DB_URL: testDatabase.databaseUrl,
          NODE_ENV: "test",
        },
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stdout: string }).stdout).toContain(
      "has no repository manifest",
    );
    expect(await db.select().from(schema.packageInstalls)).toEqual(
      installsBefore,
    );
    expect(await db.select().from(schema.projectPackageAttachments)).toEqual(
      attachmentsBefore,
    );
    expect(
      await db
        .select()
        .from(schema.flows)
        .where(eq(schema.flows.projectId, cliId)),
    ).toEqual(flowsBefore);
    expect(await db.select().from(schema.flowRevisions)).toEqual(
      revisionsBefore,
    );
    expect(
      await db
        .select()
        .from(schema.capabilityImports)
        .where(eq(schema.capabilityImports.projectId, cliId)),
    ).toEqual(capabilitiesBefore);
    expect(await repositoryFingerprint()).toEqual(initialRepository);
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

  it("AC06 refuses source fetch and trust grants with only project-level permission", async () => {
    const cap =
      await import("@/app/api/projects/[slug]/capabilities/[capabilityRefId]/trust/route");
    const flow =
      await import("@/app/api/projects/[slug]/flow-packages/[flowRefId]/trust/route");
    const install =
      await import("@/app/api/projects/[slug]/flow-packages/install/route");
    const upgrade =
      await import("@/app/api/projects/[slug]/flow-packages/[flowRefId]/upgrade/route");
    const url = "/api/projects/pkg-routes/";
    const slug = "pkg-routes";
    const params = Promise.resolve({
      slug,
      flowRefId: "blocked",
      capabilityRefId: "blocked",
    });

    for (const operation of [
      () =>
        cap.POST(
          jsonRequest(url + "capabilities/blocked/trust", { confirm: true }),
          { params },
        ),
      () =>
        flow.POST(
          jsonRequest(url + "flow-packages/blocked/trust", { trusted: true }),
          { params },
        ),
      () =>
        install.POST(
          jsonRequest(url + "flow-packages/install", {
            flowRefId: "blocked",
            source: "file:///absent",
            version: "v1",
          }),
          { params },
        ),
      () =>
        upgrade.POST(
          jsonRequest(url + "flow-packages/blocked/upgrade", {
            source: "file:///absent",
            version: "v1",
          }),
          { params },
        ),
    ]) {
      vi.mocked(requireGlobalRole).mockRejectedValueOnce(
        new MaisterError("UNAUTHORIZED", "Global administrator required"),
      );
      expect((await operation()).status).toBe(403);
    }
  });

  it("rechecks durable actor authority for trust and detach after HTTP admission", async () => {
    const attachRes = await attachPOST(
      jsonRequest("/api/projects/pkg-routes/packages", {
        packageInstallId: installId,
      }),
      { params: Promise.resolve({ slug: "pkg-routes" }) },
    );

    expect(attachRes.status).toBe(201);
    const attBody = await attachRes.json();

    const params = {
      params: Promise.resolve({
        slug: "pkg-routes",
        attachmentId: attBody.attachmentId,
      }),
    };
    const route = `/api/projects/pkg-routes/packages/${attBody.attachmentId}`;
    // The HTTP session still says admin. Revoke its persistent authority before either write.
    const previous = await db
      .select()
      .from(schemaModule.packageInstalls)
      .where(eq(schemaModule.packageInstalls.id, installId));
    await db
      .update(schemaModule.users)
      .set({ accountStatus: "disabled" })
      .where(eq(schemaModule.users.id, "usr_bootstrap_admin"));
    try {
      for (const response of [
        await trustPOST(jsonRequest(route + "/trust", {}), params),
        await detachDELETE(jsonRequest(route), params),
      ]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          details: { reason: "authority_revoked" },
        });
      }
      expect(
        await db
          .select()
          .from(schemaModule.packageInstalls)
          .where(eq(schemaModule.packageInstalls.id, installId)),
      ).toEqual(previous);
      expect(
        await db
          .select()
          .from(schemaModule.projectPackageAttachments)
          .where(
            eq(schemaModule.projectPackageAttachments.id, attBody.attachmentId),
          ),
      ).toHaveLength(1);
    } finally {
      await db
        .update(schemaModule.users)
        .set({ accountStatus: "active" })
        .where(eq(schemaModule.users.id, "usr_bootstrap_admin"));
    }
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
    const { cutLocalPackageVersion } =
      await import("@/lib/local-packages/versions");

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
    const { getLocalPackage, writeWorkingDirFile } =
      await import("@/lib/local-packages/service");
    const { cutLocalPackageVersion } =
      await import("@/lib/local-packages/versions");

    const pkg = await getLocalPackage(localPackageId, db);

    await writeWorkingDirFile(
      pkg!,
      "maister-package.yaml",
      "schemaVersion: 1\nname: routepkg-fork\nflows:\n  - { id: route-flow-fork, path: flows/route-flow }\n",
    );
    await gitCommitWorkingDir(pkg!.workingDir, "rename forked package");
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

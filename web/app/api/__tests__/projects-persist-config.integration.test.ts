import type { AnySchema } from "ajv";
import type {
  ConfigPreview,
  ConfigReceipt,
  ConfigStatus,
} from "@/lib/project-config-persistence/contracts";

import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv from "ajv";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { POST } from "@/app/api/projects/[slug]/persist-config/route";
import { requireActiveSession } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { projectMembers, projects, users } from "@/lib/db/schema";
import { git } from "@/lib/project-config-persistence/git";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
const actorUserId = randomUUID();
let actingUserId = actorUserId;
let schemas: Record<string, AnySchema>;
const ajv = new Ajv({ strict: false, validateFormats: false });
const priorWorktrees = process.env.MAISTER_WORKTREES_ROOT;

vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  getDb: () => database.db,
}));
vi.mock("@/lib/authz", async (original) => {
  const actual = await original<typeof import("@/lib/authz")>();

  return {
    ...actual,
    requireActiveSession: vi.fn(async () => ({
      id: actingUserId,
      role: "admin",
      mustChangePassword: false,
    })),
    requireProjectAction: (
      projectId: string,
      action: Parameters<typeof actual.requireProjectAction>[1],
    ) => actual.requireProjectActionForUser(actingUserId, projectId, action),
  };
});

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "config_http" });
  root = await mkdtemp(join(tmpdir(), "config-http-"));
  process.env.MAISTER_WORKTREES_ROOT = join(root, "private");
  await database.db.insert(users).values({
    id: actorUserId,
    email: `${actorUserId}@example.invalid`,
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  });
  const api = await SwaggerParser.dereference(
    resolve("../docs/api/web.openapi.yaml"),
  );

  schemas = (
    api as unknown as { components: { schemas: Record<string, AnySchema> } }
  ).components.schemas;
}, 180_000);

afterAll(async () => {
  if (priorWorktrees === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = priorWorktrees;
  await database?.stop();
  await rm(root, { recursive: true, force: true });
});

async function seed(): Promise<{ id: string; slug: string; repo: string }> {
  const id = randomUUID();
  const slug = `config-${id}`;
  const repo = join(root, id);

  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "HTTP Config"]);
  await git(repo, ["config", "user.email", "http@example.invalid"]);
  await database.db.insert(projects).values({
    id,
    slug,
    name: "Runtime",
    repoPath: repo,
    taskKey: `HC${id.slice(0, 8).toUpperCase()}`,
  });

  return { id, slug, repo };
}

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/projects/p/persist-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function contract<T>(name: string, value: unknown): T {
  const validate = ajv.compile(schemas[name]!);

  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);

  return value as T;
}

it("IT-CPC-09: authenticates before diagnostics and rejects the legacy unreviewed save body without effects", async () => {
  const project = await seed();

  vi.mocked(requireActiveSession).mockRejectedValueOnce(
    new MaisterError("UNAUTHENTICATED", "Sign in"),
  );
  const unauthorized = await POST(request({ push: true }), {
    params: Promise.resolve({ slug: project.slug }),
  });

  expect(unauthorized.status).toBe(401);
  const refused = await POST(request({ push: false }), {
    params: Promise.resolve({ slug: project.slug }),
  });

  expect(refused.status).toBe(422);
  contract("MaisterErrorBody", await refused.json());
  expect(await git(project.repo, ["status", "--porcelain=v1"])).toBe("");
  await expect(
    readFile(join(project.repo, "maister.yaml")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("IT-CPC-02/04/09: real API review, dedicated commit, scalar status, repeat, no-op and actor-bound receipts match OpenAPI", async () => {
  const { GET } =
    await import("@/app/api/projects/[slug]/persist-config/route");
  const { POST: previewPost } =
    await import("@/app/api/projects/[slug]/persist-config/preview/route");
  const { GET: receiptGet } =
    await import("@/app/api/projects/[slug]/persist-config/[operationId]/route");
  const project = await seed();
  const params = { params: Promise.resolve({ slug: project.slug }) };
  const statusResponse = await GET(
    new NextRequest("http://localhost/"),
    params,
  );

  expect(statusResponse.status).toBe(200);
  contract<ConfigStatus>(
    "ConfigPersistenceStatus",
    await statusResponse.json(),
  );
  const previewResponse = await previewPost(request({}), params);

  expect(previewResponse.status).toBe(200);
  const preview = contract<ConfigPreview>(
    "ConfigPersistencePreview",
    await previewResponse.json(),
  );

  expect(preview.kind).toBe("ready");
  if (preview.kind !== "ready") throw new Error("Expected ready review");
  expect(preview.diff).toContain("+++ b/maister.yaml");
  expect(await git(project.repo, ["status", "--porcelain=v1"])).toBe("");
  const committed = await POST(
    request({ previewId: preview.previewId }),
    params,
  );

  expect(committed.status).toBe(200);
  const receipt = contract<ConfigReceipt>(
    "PersistConfigResponse",
    await committed.json(),
  );

  expect(receipt).toMatchObject({
    state: "committed",
    pushState: "not_requested",
    cleanupState: "complete",
  });
  const readParams = {
    params: Promise.resolve({
      slug: project.slug,
      operationId: preview.previewId,
    }),
  };
  const read = await receiptGet(
    new NextRequest("http://localhost/"),
    readParams,
  );

  expect(read.headers.get("cache-control")).toBe("no-store");
  expect(
    contract<ConfigReceipt>("PersistConfigResponse", await read.json()),
  ).toEqual(receipt);
  expect(
    contract<ConfigReceipt>(
      "PersistConfigResponse",
      await (
        await POST(request({ previewId: preview.previewId }), params)
      ).json(),
    ).commitSha,
  ).toBe(receipt.commitSha);
  await database.db
    .update(projects)
    .set({ name: "Repeated" })
    .where(eq(projects.id, project.id));
  const repeated = contract<ConfigPreview>(
    "ConfigPersistencePreview",
    await (await previewPost(request({}), params)).json(),
  );

  if (repeated.kind !== "ready") throw new Error("Expected repeat review");
  expect(
    (await POST(request({ previewId: repeated.previewId }), params)).status,
  ).toBe(200);
  expect(
    contract<ConfigPreview>(
      "ConfigPersistencePreview",
      await (await previewPost(request({}), params)).json(),
    ).kind,
  ).toBe("noop");
  expect(
    (await git(project.repo, ["rev-list", "--count", "HEAD"])).trim(),
  ).toBe("2");
  expect(await git(project.repo, ["status", "--porcelain=v1"])).toBe("");
  const foreignId = randomUUID();

  await database.db.insert(users).values({
    id: foreignId,
    email: `${foreignId}@example.invalid`,
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  });
  actingUserId = foreignId;
  try {
    expect(
      (await receiptGet(new NextRequest("http://localhost/"), readParams))
        .status,
    ).toBe(404);
  } finally {
    actingUserId = actorUserId;
  }
});

it("IT-CPC-09: owner access, viewer scalar status, strict bodies and revoked confirmation enforce the real authorization boundary", async () => {
  const { GET } =
    await import("@/app/api/projects/[slug]/persist-config/route");
  const { POST: previewPost } =
    await import("@/app/api/projects/[slug]/persist-config/preview/route");
  const { POST: recoverPost } =
    await import("@/app/api/projects/[slug]/persist-config/[operationId]/recover/route");
  const project = await seed();
  const owner = randomUUID();

  await database.db.insert(users).values({
    id: owner,
    email: `${owner}@example.invalid`,
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  });
  await database.db
    .insert(projectMembers)
    .values({ projectId: project.id, userId: owner, role: "owner" });
  actingUserId = owner;
  const params = { params: Promise.resolve({ slug: project.slug }) };

  try {
    for (const invalid of [
      {},
      null,
      [],
      { previewId: randomUUID(), push: false },
      { previewId: "invalid" },
      { huge: "x".repeat(4096) },
    ]) {
      const response = await POST(request(invalid), params);

      expect(response.status).toBe(422);
      contract("MaisterErrorBody", await response.json());
    }
    const reviewResponse = await previewPost(request({}), params);

    expect(reviewResponse.status).toBe(200);
    const review = contract<ConfigPreview>(
      "ConfigPersistencePreview",
      await reviewResponse.json(),
    );

    if (review.kind !== "ready") throw new Error("Expected owner review");
    const recoverParams = {
      params: Promise.resolve({
        slug: project.slug,
        operationId: review.previewId,
      }),
    };

    expect((await recoverPost(request({}), recoverParams)).status).toBe(409);
    await database.db
      .update(projectMembers)
      .set({ role: "viewer" })
      .where(eq(projectMembers.userId, owner));
    expect(
      (await GET(new NextRequest("http://localhost/"), params)).status,
    ).toBe(200);
    expect(
      (await POST(request({ previewId: review.previewId }), params)).status,
    ).toBe(403);
    expect(
      (await previewPost(request({ malformed: true }), params)).status,
    ).toBe(403);
    expect(await git(project.repo, ["status", "--porcelain=v1"])).toBe("");
    await expect(
      readFile(join(project.repo, "maister.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await database.db
      .update(projectMembers)
      .set({ role: "owner" })
      .where(eq(projectMembers.userId, owner));
    expect(
      (await POST(request({ previewId: review.previewId }), params)).status,
    ).toBe(200);
    const other = await seed();
    const foreign = await POST(request({ previewId: review.previewId }), {
      params: Promise.resolve({ slug: other.slug }),
    });

    expect(foreign.status).toBe(403);
  } finally {
    actingUserId = actorUserId;
  }
});

it("IT-CPC-05: separate HTTP push review and confirmation project actual results through OpenAPI", async () => {
  const { POST: previewPost } =
    await import("@/app/api/projects/[slug]/persist-config/preview/route");
  const { POST: pushPreview } =
    await import("@/app/api/projects/[slug]/persist-config/[operationId]/push/preview/route");
  const { POST: pushPost } =
    await import("@/app/api/projects/[slug]/persist-config/[operationId]/push/route");
  const project = await seed();
  const remote = join(root, `${project.id}.git`);

  await mkdir(remote);
  await git(remote, ["init", "--bare", "-b", "main"]);
  await git(project.repo, ["remote", "add", "origin", `file://${remote}`]);
  const params = { params: Promise.resolve({ slug: project.slug }) };
  const review = contract<ConfigPreview>(
    "ConfigPersistencePreview",
    await (await previewPost(request({}), params)).json(),
  );

  if (review.kind !== "ready") throw new Error("Expected ready review");
  const receipt = contract<ConfigReceipt>(
    "PersistConfigResponse",
    await (await POST(request({ previewId: review.previewId }), params)).json(),
  );
  const pushParams = {
    params: Promise.resolve({
      slug: project.slug,
      operationId: review.previewId,
    }),
  };

  expect((await pushPost(request({}), pushParams)).status).toBe(422);
  const pushReviewResponse = await pushPreview(request({}), pushParams);

  expect(pushReviewResponse.status).toBe(200);
  const pushReview = contract<
    import("@/lib/project-config-persistence/contracts").ConfigPushReview
  >("ConfigPersistencePushPreview", await pushReviewResponse.json());
  const pushedResponse = await pushPost(
    request({ pushPreviewId: pushReview.pushPreviewId }),
    pushParams,
  );

  expect(pushedResponse.status).toBe(200);
  expect(
    contract("ConfigPersistencePushResult", await pushedResponse.json()),
  ).toMatchObject({
    state: "succeeded",
    commitSha: receipt.commitSha,
    cleanupState: "complete",
  });
  expect((await git(remote, ["rev-parse", "main"])).trim()).toBe(
    receipt.commitSha,
  );
  const retryReview = contract<
    import("@/lib/project-config-persistence/contracts").ConfigPushReview
  >(
    "ConfigPersistencePushPreview",
    await (await pushPreview(request({}), pushParams)).json(),
  );

  await database.pool.query(
    `CREATE FUNCTION config_http_ack_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${retryReview.pushPreviewId}' AND NEW.state='succeeded' THEN RAISE EXCEPTION 'injected receipt outage' USING ERRCODE='40001'; END IF; RETURN NEW; END; $$`,
  );
  await database.pool.query(
    "CREATE TRIGGER config_http_ack_fault BEFORE UPDATE ON project_config_push_intents FOR EACH ROW EXECUTE FUNCTION config_http_ack_fault()",
  );
  try {
    const unavailable = await pushPost(
      request({ pushPreviewId: retryReview.pushPreviewId }),
      pushParams,
    );

    expect(unavailable.status).toBe(503);
    const error = await unavailable.json();

    contract("MaisterErrorBody", error);
    expect(error).toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "recovery_required" },
    });
    const noop = await previewPost(request({}), params);

    expect(
      contract<ConfigPreview>("ConfigPersistencePreview", await noop.json())
        .kind,
    ).toBe("noop");
    const { GET: statusGet } =
      await import("@/app/api/projects/[slug]/persist-config/route");
    const status = contract<ConfigStatus>(
      "ConfigPersistenceStatus",
      await (
        await statusGet(new NextRequest("http://localhost/"), params)
      ).json(),
    );

    expect(status.operationId).toBe(review.previewId);
  } finally {
    await database.pool.query(
      "DROP TRIGGER config_http_ack_fault ON project_config_push_intents",
    );
    await database.pool.query("DROP FUNCTION config_http_ack_fault()");
  }
  const { POST: recoverPost } =
    await import("@/app/api/projects/[slug]/persist-config/[operationId]/recover/route");
  const recovered = await recoverPost(request({}), pushParams);

  expect(recovered.status).toBe(200);
  expect(
    contract<ConfigReceipt>("PersistConfigResponse", await recovered.json()),
  ).toMatchObject({ state: "committed", pushState: "succeeded" });
});

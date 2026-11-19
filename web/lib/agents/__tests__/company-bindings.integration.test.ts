import type { SessionUser } from "@/lib/authz";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { CompanyBindingCreate } from "../company-binding-types";

import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve, sep } from "node:path";

import { NextRequest } from "next/server";
import { Ajv } from "ajv";
import { parse } from "yaml";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { agentDefinitionSha256 } from "../activity-snapshot";
import { parseAgentDefinition } from "../definition";
import {
  createCompanySpecialistBinding,
  getCompanySpecialistBinding,
  getCompanySpecialistBindingRevision,
} from "../company-bindings";
import {
  updateCompanySpecialistBinding,
  detachCompanySpecialistBinding,
} from "../company-binding-mutations";
import { listCompanySpecialists } from "../company-binding-list";

import { runRevisionGcSweep } from "@/lib/gc/revision-gc";
import { removeRevision } from "@/lib/flows/lifecycle";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { git, initRepo } from "@/test-support/git-fixture";
import {
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import { MaisterError } from "@/lib/errors";

let createRoute: typeof import("@/app/api/specialists/[specialistId]/bindings/route");
let bindingRoute: typeof import("@/app/api/specialists/[specialistId]/bindings/[bindingId]/route");
let listRoute: typeof import("@/app/api/specialists/route");
let session: SessionUser | null = null;
const contracts = new Ajv({
  strict: false,
  allErrors: true,
  validateFormats: false,
});

vi.mock("@/lib/authz", async (original) => {
  const actual = await original<typeof import("@/lib/authz")>();

  return {
    ...actual,
    requireActiveSession: async (): Promise<SessionUser> => {
      if (!session) throw new MaisterError("UNAUTHENTICATED", "Login required");

      return session;
    },
  };
});

let database: StartedPostgresTestDb;
let root: string;
let input: CompanyBindingCreate;
const administratorId = randomUUID();
const requesterId = randomUUID();
const agentId = "rah:evidence-researcher";

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

beforeAll(async () => {
  createRoute =
    await import("@/app/api/specialists/[specialistId]/bindings/route");
  bindingRoute =
    await import("@/app/api/specialists/[specialistId]/bindings/[bindingId]/route");
  listRoute = await import("@/app/api/specialists/route");
  contracts.addSchema(
    parse(await readFile("../docs/api/web.openapi.yaml", "utf8")),
    "web",
  );
  vi.stubEnv("AUTH_SECRET", "company-specialist-binding-test-secret");
  database = await startMainPostgresTestDb({
    databaseName: "company_specialist_bindings",
  });
  root = await mkdtemp(join(os.tmpdir(), "company-specialist-binding-"));
  vi.spyOn(os, "homedir").mockReturnValue(root);
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active'),($3,$4,'member','active')",
    [
      administratorId,
      `${administratorId}@example.test`,
      requesterId,
      `${requesterId}@example.test`,
    ],
  );
  const grants = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: requesterId,
    actions: ["specialists:read", "specialists:manage"],
    idempotencyKey: randomUUID(),
  });
  const source = join(root, "source");

  await cp(resolve("test-fixtures/rah-native"), source, {
    recursive: true,
    filter: (path) => !path.split(sep).includes(".git"),
  });
  const definitionFile = join(source, "maister-agents/evidence-researcher.md");
  const definition = (await readFile(definitionFile, "utf8")).replace(
    "workspace: none",
    "specialist:\n  responsibilities: [Inspect authorized stand evidence]\n  targetClasses: [stand]\nconfig:\n  - key: stand_id\n    type: string\n    default: demo-stand\n  - key: log_lines\n    type: number\n    default: 40\nworkspace: none",
  );

  await writeFile(definitionFile, definition);
  await writeFile(
    join(source, "maister-agents/stand-coordinator.md"),
    definition.replace("workspace: none", "flow: rah-control\nworkspace: none"),
  );
  await initRepo(source);
  await git(
    source,
    "tag",
    "-a",
    "rah/binding-fixture-v1",
    "-m",
    "Synthetic company binding qualification package",
  );
  const installed = await installPackageRevision({
    source,
    version: "rah/binding-fixture-v1",
    db: database.db,
  });

  await trustPackageRevision({
    packageInstallId: installed.id,
    db: database.db,
  });
  const pin = (
    await database.pool.query<{
      installed_path: string;
      resolved_revision: string;
    }>(
      "SELECT installed_path,resolved_revision FROM package_installs WHERE id=$1",
      [installed.id],
    )
  ).rows[0]!;
  const parsed = parseAgentDefinition(
    agentId,
    await readFile(
      join(pin.installed_path, "maister-agents/evidence-researcher.md"),
      "utf8",
    ),
  );

  input = {
    owner: { kind: "company", companyId: grants.page.companyId },
    packageInstallId: installed.id,
    packageRevision: pin.resolved_revision,
    definitionSha256: agentDefinitionSha256(parsed),
    configuration: { stand_id: "qualified-stand" },
    grantActions: ["knowledge:read"],
    idempotencyKey: randomUUID(),
  };
}, 180000);

afterAll(async () => {
  try {
    await database?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it("IT-CBS-01 persists an explicitly authorized company binding to a real installed specialist without a project or implicit action grant", async () => {
  const before = (
    await database.pool.query(
      "SELECT count(*)::int AS count FROM company_grants",
    )
  ).rows[0]!.count;
  const result = await createCompanySpecialistBinding(
    database.db,
    requesterId,
    agentId,
    input,
  );

  expect(result).toMatchObject({
    duplicate: false,
    specialist: {
      id: agentId,
      owner: input.owner,
      responsibilities: ["Inspect authorized stand evidence"],
      targetClasses: ["stand"],
      packageInstallId: input.packageInstallId,
      packageRevision: input.packageRevision,
      definitionSha256: input.definitionSha256,
      enabled: false,
      detachedAt: null,
      configRevision: 1,
      configuration: { stand_id: "qualified-stand" },
      effectiveConfiguration: { stand_id: "qualified-stand", log_lines: 40 },
      grantActions: ["knowledge:read"],
      runnerId: null,
      executionPolicy: { preset: "supervised" },
      coordinatorFlowRevisionId: null,
    },
  });
  expect(
    await getCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      result.specialist.bindingId,
    ),
  ).toEqual(result.specialist);
  expect((await database.pool.query("SELECT id FROM projects")).rows).toEqual(
    [],
  );
  expect((await database.pool.query("SELECT id FROM runs")).rows).toEqual([]);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM company_grants",
      )
    ).rows[0]!.count,
  ).toBe(before);
  const revisions = (
    await database.pool.query(
      "SELECT revision,actor,request_key,request_digest,snapshot FROM company_specialist_binding_revisions WHERE binding_id=$1",
      [result.specialist.bindingId],
    )
  ).rows;

  expect(revisions).toHaveLength(1);
  expect(revisions[0]).toMatchObject({
    revision: 1,
    actor: { kind: "user", id: requesterId, runId: null, attemptId: null },
    request_key: input.idempotencyKey,
    snapshot: {
      schemaVersion: 1,
      agentId,
      packageInstallId: input.packageInstallId,
      packageRevision: input.packageRevision,
      configuration: input.configuration,
      grantActions: ["knowledge:read"],
      enabled: false,
    },
  });
  expect(revisions[0]!.request_digest).toMatch(/^[a-f0-9]{64}$/);
  await expect(
    database.pool.query("DELETE FROM package_installs WHERE id=$1", [
      input.packageInstallId,
    ]),
  ).rejects.toMatchObject({ code: "23503" });
});

it("retains full replacement and original replay receipts, arbitrates real CAS races, and detaches without deleting accepted history", async () => {
  const created = await createCompanySpecialistBinding(
    database.db,
    requesterId,
    agentId,
    input,
  );
  const original = created.specialist;
  const replacement = {
    ...input,
    enabled: true,
    configuration: {},
    grantActions: [] as CompanyBindingCreate["grantActions"],
    runnerId: null,
    executionPolicy: { preset: "supervised" as const },
    coordinatorFlowRevisionId: null,
    expectedRevision: original.configRevision,
    idempotencyKey: randomUUID(),
  };
  const changed = await updateCompanySpecialistBinding(
    database.db,
    requesterId,
    agentId,
    original.bindingId,
    replacement,
  );

  expect(changed).toMatchObject({
    duplicate: false,
    specialist: {
      configRevision: 2,
      enabled: true,
      configuration: {},
      effectiveConfiguration: { stand_id: "demo-stand", log_lines: 40 },
      grantActions: [],
      runnerId: null,
      coordinatorFlowRevisionId: null,
    },
  });
  expect(
    await createCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      input,
    ),
  ).toEqual({ duplicate: true, specialist: original });
  expect(
    await updateCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      original.bindingId,
      replacement,
    ),
  ).toEqual({ ...changed, duplicate: true });
  await expect(
    updateCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      original.bindingId,
      { ...replacement, configuration: { stand_id: "changed-replay" } },
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const raced = await Promise.allSettled(
    ["first", "second"].map((value) =>
      updateCompanySpecialistBinding(
        database.db,
        requesterId,
        agentId,
        original.bindingId,
        {
          ...replacement,
          configuration: { stand_id: value },
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
        },
      ),
    ),
  );

  expect(raced.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(raced.filter((item) => item.status === "rejected")).toMatchObject([
    { reason: { code: "CONFLICT" } },
  ]);
  const current = await getCompanySpecialistBinding(
    database.db,
    requesterId,
    agentId,
    original.bindingId,
  );

  expect(current).toMatchObject({
    configRevision: 3,
    configuration: { stand_id: expect.stringMatching(/^(first|second)$/) },
    effectiveConfiguration: { log_lines: 40 },
  });
  const history = await getCompanySpecialistBindingRevision(
    database.db,
    requesterId,
    agentId,
    original.bindingId,
    1,
  );

  expect(history.snapshot.configuration).toEqual({
    stand_id: "qualified-stand",
  });
  expect(history.authoritySnapshot.witness).toMatchObject({
    action: "specialists:manage",
    owner: input.owner,
  });
  await expect(
    database.pool.query(
      "UPDATE company_specialist_binding_revisions SET snapshot_digest=repeat('a',64) WHERE binding_id=$1",
      [original.bindingId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database.pool.query(
      "UPDATE company_specialist_bindings SET revision=revision+1 WHERE id=$1",
      [original.bindingId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const detachInput = {
    expectedRevision: 3,
    reason: "Retire the qualification specialist",
    idempotencyKey: randomUUID(),
  };
  const detached = await detachCompanySpecialistBinding(
    database.db,
    requesterId,
    agentId,
    original.bindingId,
    detachInput,
  );

  expect(detached).toEqual({
    id: original.bindingId,
    revision: 4,
    status: "detached",
    duplicate: false,
  });
  expect(
    await detachCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      original.bindingId,
      detachInput,
    ),
  ).toEqual({ ...detached, duplicate: true });
  expect(
    await getCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      original.bindingId,
    ),
  ).toMatchObject({
    enabled: false,
    detachedAt: expect.any(String),
    configRevision: 4,
    packageInstallId: input.packageInstallId,
  });
  expect(
    (
      await database.pool.query(
        "SELECT package_install_id FROM company_specialist_bindings WHERE id=$1",
        [original.bindingId],
      )
    ).rows[0],
  ).toEqual({ package_install_id: null });
  expect(
    (
      await database.pool.query(
        "SELECT revision FROM company_specialist_binding_revisions WHERE binding_id=$1 ORDER BY revision",
        [original.bindingId],
      )
    ).rows.map((row) => row.revision),
  ).toEqual([1, 2, 3, 4]);
  await expect(
    updateCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      original.bindingId,
      { ...replacement, expectedRevision: 4, idempotencyKey: randomUUID() },
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

it("lists retained and current bindings with actor-bound pagination and current explicit access, while revoked managers retain no replay authority", async () => {
  const current = await createCompanySpecialistBinding(
    database.db,
    requesterId,
    agentId,
    { ...input, idempotencyKey: randomUUID() },
  );
  const page = await listCompanySpecialists(database.db, requesterId, {
    limit: 1,
  });

  expect(page.items).toHaveLength(1);
  expect(page.nextCursor).toEqual(expect.any(String));
  const next = await listCompanySpecialists(database.db, requesterId, {
    limit: 1,
    cursor: page.nextCursor!,
  });

  expect(next.items).toHaveLength(1);
  expect(next.items[0]!.bindingId).not.toBe(page.items[0]!.bindingId);
  expect(next.nextCursor).toBeNull();
  await expect(
    listCompanySpecialists(database.db, administratorId, { limit: 1 }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: administratorId,
    actions: ["specialists:read"],
    idempotencyKey: randomUUID(),
  });
  await expect(
    listCompanySpecialists(database.db, administratorId, {
      limit: 1,
      cursor: page.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  const grants = (
    await database.pool.query(
      "SELECT id,revision,action FROM company_grants WHERE principal_id=$1 AND revoked_at IS NULL",
      [requesterId],
    )
  ).rows;
  const read = grants.find((grant) => grant.action === "specialists:read")!;

  await revokeCompanyGrant(database.db, administratorId, read.id, {
    expectedRevision: read.revision,
    reason: "Revoke binding content access",
    idempotencyKey: randomUUID(),
  });
  await expect(
    getCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      current.specialist.bindingId,
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    getCompanySpecialistBindingRevision(
      database.db,
      requesterId,
      agentId,
      current.specialist.bindingId,
      1,
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const detach = {
    expectedRevision: 1,
    reason: "Retire without content read access",
    idempotencyKey: randomUUID(),
  };

  expect(
    await detachCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      current.specialist.bindingId,
      detach,
    ),
  ).toMatchObject({ status: "detached", revision: 2 });
  const manage = grants.find((grant) => grant.action === "specialists:manage")!;

  await revokeCompanyGrant(database.db, administratorId, manage.id, {
    expectedRevision: manage.revision,
    reason: "Revoke binding mutation access",
    idempotencyKey: randomUUID(),
  });
  await expect(
    detachCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      current.specialist.bindingId,
      detach,
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: requesterId,
    actions: ["specialists:read", "specialists:manage"],
    idempotencyKey: randomUUID(),
  });
  await expect(
    listCompanySpecialists(database.db, requesterId, {
      limit: 1,
      cursor: page.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
});

it("refuses mismatched pins, untrusted or disabled providers, undeclared roles and invalid configuration before persisting a binding", async () => {
  const count = async (): Promise<number> =>
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM company_specialist_bindings",
      )
    ).rows[0]!.count;
  const before = await count();
  const candidate = { ...input, idempotencyKey: randomUUID() };

  await expect(
    createCompanySpecialistBinding(database.db, requesterId, agentId, {
      ...candidate,
      configuration: { stand_id: "x".repeat(2097152) },
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });

  await expect(
    createCompanySpecialistBinding(database.db, requesterId, agentId, {
      ...candidate,
      definitionSha256: "0".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    createCompanySpecialistBinding(database.db, requesterId, agentId, {
      ...candidate,
      packageRevision: "wrong-revision",
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    createCompanySpecialistBinding(database.db, requesterId, agentId, {
      ...candidate,
      configuration: { undeclared: "value" },
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await expect(
    createCompanySpecialistBinding(database.db, requesterId, agentId, {
      ...candidate,
      configuration: { log_lines: "not-a-number" },
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await expect(
    createCompanySpecialistBinding(database.db, requesterId, agentId, {
      ...candidate,
      runnerId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await expect(
    createCompanySpecialistBinding(database.db, requesterId, agentId, {
      ...candidate,
      coordinatorFlowRevisionId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await expect(
    createCompanySpecialistBinding(
      database.db,
      requesterId,
      "rah:coordinator",
      candidate,
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await expect(
    createCompanySpecialistBinding(
      database.db,
      requesterId,
      "other:evidence-researcher",
      candidate,
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await database.pool.query(
    "UPDATE package_installs SET trust_status='untrusted' WHERE id=$1",
    [input.packageInstallId],
  );
  try {
    await expect(
      createCompanySpecialistBinding(
        database.db,
        requesterId,
        agentId,
        candidate,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  } finally {
    await trustPackageRevision({
      packageInstallId: input.packageInstallId,
      db: database.db,
    });
  }
  await database.pool.query("UPDATE agents SET enabled=false WHERE id=$1", [
    agentId,
  ]);
  try {
    await expect(
      createCompanySpecialistBinding(
        database.db,
        requesterId,
        agentId,
        candidate,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  } finally {
    await database.pool.query("UPDATE agents SET enabled=true WHERE id=$1", [
      agentId,
    ]);
  }
  expect(await count()).toBe(before);
});

it("exposes authenticated native routes with contract-valid replies, strict input, replay and required replacement CAS", async () => {
  session = {
    id: requesterId,
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  };
  const body = { ...input, idempotencyKey: randomUUID() };
  const request = (method: string, value: unknown): NextRequest =>
    new NextRequest("http://localhost/api/specialists", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  const roleParams = { params: Promise.resolve({ specialistId: agentId }) };
  const created = await createRoute.POST(request("POST", body), roleParams);

  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toBe("private, no-store");
  const specialist = (await created.json()) as { bindingId: string };
  const assertContract = (name: string, value: unknown): void => {
    const validate = contracts.getSchema(`web#/components/schemas/${name}`)!;

    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  };

  assertContract("CBSpecialist", specialist);
  expect(
    (await createRoute.POST(request("POST", body), roleParams)).status,
  ).toBe(200);
  expect(
    (
      await createRoute.POST(
        request("POST", { ...body, createdBy: administratorId }),
        roleParams,
      )
    ).status,
  ).toBe(400);
  const params = {
    params: Promise.resolve({
      specialistId: agentId,
      bindingId: specialist.bindingId,
    }),
  };
  const read = await bindingRoute.GET(
    new NextRequest("http://localhost/api/specialists/binding"),
    params,
  );

  expect(read.status).toBe(200);
  expect(await read.json()).toEqual(specialist);
  const page = await listRoute.GET(
    new NextRequest("http://localhost/api/specialists?limit=1"),
  );

  expect(page.status).toBe(200);
  assertContract("CBSpecialistPage", await page.json());
  expect(
    (
      await listRoute.GET(
        new NextRequest("http://localhost/api/specialists?limit=0"),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await listRoute.GET(
        new NextRequest("http://localhost/api/specialists?companyId=forged"),
      )
    ).status,
  ).toBe(400);
  const update = {
    ...body,
    enabled: true,
    configuration: {},
    grantActions: [],
    runnerId: null,
    executionPolicy: { preset: "supervised" },
    coordinatorFlowRevisionId: null,
    idempotencyKey: randomUUID(),
  };

  expect(
    (await bindingRoute.PATCH(request("PATCH", update), params)).status,
  ).toBe(400);
  const changed = await bindingRoute.PATCH(
    request("PATCH", { ...update, expectedRevision: 1 }),
    params,
  );

  expect(changed.status).toBe(200);
  assertContract("CBSpecialist", await changed.json());
  const detached = await bindingRoute.DELETE(
    request("DELETE", {
      expectedRevision: 2,
      reason: "Retire HTTP qualification binding",
      idempotencyKey: randomUUID(),
    }),
    params,
  );

  expect(detached.status).toBe(200);
  assertContract("CBBindingReceipt", await detached.json());
  expect(
    (
      await bindingRoute.GET(
        new NextRequest("http://localhost/api/specialists/missing"),
        {
          params: Promise.resolve({
            specialistId: agentId,
            bindingId: randomUUID(),
          }),
        },
      )
    ).status,
  ).toBe(404);
  session = null;
  expect(
    (await listRoute.GET(new NextRequest("http://localhost/api/specialists")))
      .status,
  ).toBe(401);
});

it("protects a reviewed coordinator Flow pin from removal and GC until the specialist is detached", async () => {
  const pin = (
    await database.pool.query<{ installed_path: string }>(
      "SELECT installed_path FROM package_installs WHERE id=$1",
      [input.packageInstallId],
    )
  ).rows[0]!;
  const roleId = "rah:stand-coordinator";
  const definition = parseAgentDefinition(
    roleId,
    await readFile(
      join(pin.installed_path, "maister-agents/stand-coordinator.md"),
      "utf8",
    ),
  );
  const flow = (
    await database.pool.query<{
      id: string;
      source: string;
      installed_path: string;
    }>(
      "SELECT id,source,installed_path FROM flow_revisions WHERE resolved_revision=$1 AND flow_ref_id='rah-control'",
      [input.packageRevision],
    )
  ).rows[0]!;
  const created = await createCompanySpecialistBinding(
    database.db,
    requesterId,
    roleId,
    {
      ...input,
      coordinatorFlowRevisionId: flow.id,
      definitionSha256: agentDefinitionSha256(definition),
      idempotencyKey: randomUUID(),
    },
  );

  await expect(
    removeRevision({
      flowRefId: "rah-control",
      revisionId: flow.id,
      expectedSource: flow.source,
      db: database.db,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await database.pool.query(
    "UPDATE flow_revisions SET package_status='Removed',installed_at=now()-interval '90 days' WHERE id=$1",
    [flow.id],
  );
  expect(await runRevisionGcSweep({ db: database.db })).toMatchObject({
    scanned: 1,
    deleted: 0,
    skippedReferenced: 1,
    failed: 0,
  });
  expect(
    await readFile(join(flow.installed_path, "flow.yaml"), "utf8"),
  ).toContain("rah-control");
  await detachCompanySpecialistBinding(
    database.db,
    requesterId,
    roleId,
    created.specialist.bindingId,
    {
      expectedRevision: 1,
      reason: "Release the retired coordinator Flow pin",
      idempotencyKey: randomUUID(),
    },
  );
  expect(await runRevisionGcSweep({ db: database.db })).toMatchObject({
    scanned: 1,
    deleted: 1,
    skippedReferenced: 0,
    failed: 0,
  });
  expect(
    (
      await getCompanySpecialistBindingRevision(
        database.db,
        requesterId,
        roleId,
        created.specialist.bindingId,
        1,
      )
    ).snapshot.coordinatorFlowRevisionId,
  ).toBe(flow.id);
});

it("AV-06 requires an explicit admin installation grant and revokes it by exact binding revision", async () => {
  const installationAdminId = randomUUID();
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active')",
    [installationAdminId, `${installationAdminId}@example.test`],
  );
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: installationAdminId,
    actions: ["specialists:read", "specialists:manage"],
    idempotencyKey: randomUUID(),
  });
  const installationGrant = {
    schemaVersion: 1,
    reach: "active_projects",
    scopes: ["projects:read", "agent_memory:read", "agent_memory:propose"],
    memoryEnabled: true,
  } as const;
  const request: CompanyBindingCreate = {
    ...input,
    installationGrant: {
      ...installationGrant,
      scopes: [...installationGrant.scopes],
    },
    idempotencyKey: randomUUID(),
  };

  await expect(
    createCompanySpecialistBinding(database.db, requesterId, agentId, request),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const created = (
    await createCompanySpecialistBinding(
      database.db,
      installationAdminId,
      agentId,
      request,
    )
  ).specialist;

  expect(created.installationGrant).toEqual(installationGrant);
  const patch = {
    ...request,
    enabled: false,
    runnerId: null,
    executionPolicy: { preset: "supervised" as const },
    coordinatorFlowRevisionId: null,
    expectedRevision: created.configRevision,
    installationGrant: null,
    idempotencyKey: randomUUID(),
  };

  await expect(
    updateCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      created.bindingId,
      patch,
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const revoked = (
    await updateCompanySpecialistBinding(
      database.db,
      installationAdminId,
      agentId,
      created.bindingId,
      patch,
    )
  ).specialist;

  expect(revoked.installationGrant).toBeUndefined();
  expect(
    (
      await getCompanySpecialistBindingRevision(
        database.db,
        installationAdminId,
        agentId,
        created.bindingId,
        1,
      )
    ).snapshot.installationGrant,
  ).toEqual(installationGrant);
  await detachCompanySpecialistBinding(
    database.db,
    installationAdminId,
    agentId,
    created.bindingId,
    {
      expectedRevision: revoked.configRevision,
      reason: "End installation grant fixture",
      idempotencyKey: randomUUID(),
    },
  );
});

it("deduplicates simultaneous creation and preserves self-contained role history after explicit retirement and provider removal", async () => {
  const candidate = { ...input, idempotencyKey: randomUUID() };
  const results = await Promise.all([
    createCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      candidate,
    ),
    createCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      candidate,
    ),
  ]);

  expect(results.map((result) => result.duplicate).sort()).toEqual([
    false,
    true,
  ]);
  expect(results[0]!.specialist).toEqual(results[1]!.specialist);
  const original = results[0]!.specialist;

  await expect(
    createCompanySpecialistBinding(database.db, requesterId, agentId, {
      ...candidate,
      configuration: {},
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    createCompanySpecialistBinding(database.db, requesterId, agentId, {
      ...candidate,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await database.pool.query("UPDATE agents SET specialist=NULL WHERE id=$1", [
    agentId,
  ]);
  expect(
    await getCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      original.bindingId,
    ),
  ).toEqual(original);
  await detachCompanySpecialistBinding(
    database.db,
    requesterId,
    agentId,
    original.bindingId,
    {
      expectedRevision: 1,
      reason: "Retire before provider removal",
      idempotencyKey: randomUUID(),
    },
  );
  const pin = (
    await database.pool.query<{ installed_path: string }>(
      "SELECT installed_path FROM package_installs WHERE id=$1",
      [input.packageInstallId],
    )
  ).rows[0]!;

  expect(pin.installed_path.startsWith(`${root}${sep}`)).toBe(true);
  await database.pool.query("DELETE FROM package_installs WHERE id=$1", [
    input.packageInstallId,
  ]);
  await rm(pin.installed_path, { recursive: true });
  expect(
    (
      await getCompanySpecialistBindingRevision(
        database.db,
        requesterId,
        agentId,
        original.bindingId,
        1,
      )
    ).snapshot.definition.specialist,
  ).toEqual({
    responsibilities: original.responsibilities,
    targetClasses: original.targetClasses,
  });
  expect(
    await createCompanySpecialistBinding(
      database.db,
      requesterId,
      agentId,
      candidate,
    ),
  ).toEqual({ specialist: original, duplicate: true });
  expect((await database.pool.query("SELECT id FROM runs")).rows).toEqual([]);
});

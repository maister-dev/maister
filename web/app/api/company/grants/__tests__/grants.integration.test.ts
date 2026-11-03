import type { SqlDatabase } from "@/lib/db/sql-types";
import type { SessionUser } from "@/lib/authz";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { Ajv } from "ajv";
import { parse } from "yaml";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  knowledgeOwnerChoices,
  knowledgeOwnerActions,
  knowledgeRecordActions,
} from "@/lib/brain/knowledge-ui";
import { listCompanyPrincipalOptions } from "@/lib/company/principal-options";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { createCompanyGrants } from "@/lib/company/grants";
import { GET as listAuthority } from "@/app/api/company/grants/route";
import { DELETE as revokeAuthority } from "@/app/api/company/grants/[grantId]/route";
import { POST as grantAuthority } from "@/app/api/company/grants/route";
import { GET as getRecord } from "@/app/api/knowledge/[recordId]/route";
import { MaisterError } from "@/lib/errors";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let session: SessionUser | null = null;
const contracts = new Ajv({
  strict: false,
  allErrors: true,
  validateFormats: false,
});

function assertContract(name: string, value: unknown): void {
  const validate = contracts.getSchema(`web#/components/schemas/${name}`);

  if (!validate) throw new Error(`Missing native company contract ${name}`);
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}
function request(method: string, body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/company/grants", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
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

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", "company-authority-test-secret");
  contracts.addSchema(
    parse(await readFile("../docs/api/web.openapi.yaml", "utf8")),
    "web",
  );
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "native_company_grants",
  });
}, 180000);
afterAll(async () => {
  await database?.stop();
  vi.unstubAllEnvs();
});

it("IT-CBK-01 an installation administrator grants explicit company access without a repository or implicit content access", async () => {
  const administratorId = randomUUID();
  const companyId = String(
    (await database.pool.query("SELECT id FROM companies")).rows[0].id,
  );
  const recordId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active')",
    [administratorId, `${administratorId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO brain_items(id,company_id,kind,title,content,content_hash,confidence) VALUES($1,$2,'assertion','Private company knowledge','Requires an explicit content grant',$3,0.3)",
    [recordId, companyId, randomUUID()],
  );
  session = {
    id: administratorId,
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  };
  const read = (): Promise<Response> =>
    getRecord(new NextRequest(`http://localhost/api/knowledge/${recordId}`), {
      params: Promise.resolve({ recordId }),
    });

  expect((await read()).status).toBe(404);
  const body = {
    principalKind: "user",
    principalId: administratorId,
    actions: ["knowledge:read"],
    idempotencyKey: `${administratorId}_grant_read`,
  };
  const granted = await grantAuthority(
    new NextRequest("http://localhost/api/company/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  expect(granted.status).toBe(201);
  const page = (await granted.json()) as {
    companyId: string;
    items: { id: string; revokedAt: string | null }[];
  };

  assertContract("CBCompanyGrantPage", page);
  expect(page.items).toEqual([
    expect.objectContaining({
      principalKind: "user",
      principalId: administratorId,
      action: "knowledge:read",
      revision: 1,
      revokedAt: null,
      createdBy: administratorId,
      confirmationClasses: [],
    }),
  ]);
  expect((await read()).status).toBe(200);
  expect((await database.pool.query("SELECT id FROM projects")).rows).toEqual(
    [],
  );
  const repeated = await grantAuthority(request("POST", body));

  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual(page);
  expect(
    (
      await grantAuthority(
        request("POST", { ...body, actions: ["knowledge:propose"] }),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await grantAuthority(
        request("POST", {
          ...body,
          idempotencyKey: `${administratorId}_different_key`,
        }),
      )
    ).status,
  ).toBe(409);
  const grantId = page.items[0].id;
  const revoke = {
    expectedRevision: 1,
    reason: "Remove the explicitly granted read action",
    idempotencyKey: `${administratorId}_revoke_read`,
  };
  const context = { params: Promise.resolve({ grantId }) };
  const stale = await revokeAuthority(
    request("DELETE", { ...revoke, expectedRevision: 2 }),
    context,
  );

  expect(stale.status).toBe(409);
  const staleBody = await stale.json();

  assertContract("CBError", staleBody);
  expect(staleBody).toMatchObject({
    code: "CONFLICT",
    details: { currentRevision: 1 },
  });
  const revoked = await revokeAuthority(request("DELETE", revoke), context);

  expect(revoked.status).toBe(200);
  const receipt = await revoked.json();

  assertContract("CBReceipt", receipt);
  expect(receipt).toMatchObject({
    id: grantId,
    revision: 2,
    status: "revoked",
    duplicate: false,
  });
  expect((await read()).status).toBe(404);
  expect(
    await (await revokeAuthority(request("DELETE", revoke), context)).json(),
  ).toMatchObject({ duplicate: true });
  expect(
    (
      await revokeAuthority(
        request("DELETE", { ...revoke, reason: "Changed delivery content" }),
        context,
      )
    ).status,
  ).toBe(409);
  const oldDelivery = await grantAuthority(request("POST", body));

  expect(oldDelivery.status).toBe(200);
  expect((await oldDelivery.json()).items[0].revokedAt).not.toBeNull();
  expect((await read()).status).toBe(404);
  const renewed = await grantAuthority(
    request("POST", {
      ...body,
      idempotencyKey: `${administratorId}_new_authority`,
    }),
  );

  expect(renewed.status).toBe(201);
  const newGrant = (await renewed.json()).items[0] as { id: string };

  expect(newGrant.id).not.toBe(grantId);
  expect((await read()).status).toBe(200);
  await expect(
    database.pool.query("DELETE FROM company_grants WHERE id=$1", [
      newGrant.id,
    ]),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "company_grants_history_immutable",
  });
  await expect(
    database.pool.query(
      "UPDATE company_grants SET principal_id='forged' WHERE id=$1",
      [newGrant.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "company_grants_history_immutable",
  });
  const listed = await listAuthority(
    new NextRequest("http://localhost/api/company/grants?limit=1"),
  );

  expect(listed.status).toBe(200);
  const listedBody = await listed.json();

  assertContract("CBCompanyGrantPage", listedBody);
  expect(listedBody.items).toHaveLength(1);
  expect(listedBody.nextCursor).not.toBeNull();
  await database.pool.query("UPDATE users SET role='member' WHERE id=$1", [
    administratorId,
  ]);
  expect(
    (
      await listAuthority(
        new NextRequest(
          `http://localhost/api/company/grants?limit=1&cursor=${listedBody.nextCursor}`,
        ),
      )
    ).status,
  ).toBe(403);
  expect((await grantAuthority(request("POST", body))).status).toBe(403);
});

it("IT-CBK-01 company policy uses current administrator state and rejects fabricated principals, actors and unsupported confirmation policy", async () => {
  const userId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  session = {
    id: userId,
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  };
  const body = {
    principalKind: "user",
    principalId: userId,
    actions: ["knowledge:read"],
    idempotencyKey: `${userId}_refuse_forgery`,
  };

  expect((await grantAuthority(request("POST", body))).status).toBe(403);
  expect(
    (
      await listAuthority(
        new NextRequest("http://localhost/api/company/grants"),
      )
    ).status,
  ).toBe(403);
  await database.pool.query("UPDATE users SET role='admin' WHERE id=$1", [
    userId,
  ]);
  for (const invalid of [
    { ...body, createdBy: "forged" },
    { ...body, companyId: "forged" },
    { ...body, principalKind: "system" },
    { ...body, actions: ["knowledge:read", "knowledge:read"] },
    { ...body, confirmationClasses: ["observation"] },
    { ...body, principalKind: "agent", actions: ["knowledge:confirm"] },
  ])
    expect((await grantAuthority(request("POST", invalid))).status).toBe(400);
  const unavailable = await grantAuthority(
    request("POST", { ...body, principalId: randomUUID() }),
  );

  expect(unavailable.status).toBe(409);
  expect(await unavailable.json()).toMatchObject({
    details: { reason: "company_principal_unavailable" },
  });
  await database.pool.query(
    "UPDATE users SET account_status='disabled' WHERE id=$1",
    [userId],
  );
  expect((await grantAuthority(request("POST", body))).status).toBe(403);
  session = null;
  expect(
    (
      await listAuthority(
        new NextRequest("http://localhost/api/company/grants"),
      )
    ).status,
  ).toBe(401);
});

it("IT-CBK-06 company policy pages keep exact large revocation reasons within a bounded response and credential-scoped continuation", async () => {
  const userId = randomUUID();
  const companyId = String(
    (await database.pool.query("SELECT id FROM companies")).rows[0].id,
  );

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active')",
    [userId, `${userId}@example.test`],
  );
  session = {
    id: userId,
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  };
  const reason = "\u001f".repeat(2000);
  const ids: string[] = Array.from({ length: 30 }, () => randomUUID());

  await database.pool.query(
    "INSERT INTO company_grants(id,company_id,principal_type,principal_id,action,created_by,revoked_at,revision,revoked_by,revocation_reason,revocation_key,revocation_digest) SELECT x.id,$1,'user',$2,'knowledge:read',$2,clock_timestamp(),2,$2,$3,'receipt_'||x.id,repeat('a',64) FROM jsonb_to_recordset($4::jsonb) x(id text)",
    [companyId, userId, reason, JSON.stringify(ids.map((id) => ({ id })))],
  );
  let cursor: string | null = null;
  const found: string[] = [];
  let pages = 0;

  do {
    const response = await listAuthority(
      new NextRequest(
        `http://localhost/api/company/grants?limit=50${cursor === null ? "" : `&cursor=${cursor}`}`,
      ),
    );

    expect(response.status).toBe(200);
    const text = await response.text();

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(131072);
    const page = JSON.parse(text) as {
      items: { id: string; revocationReason: string | null }[];
      nextCursor: string | null;
    };

    assertContract("CBCompanyGrantPage", JSON.parse(text));
    for (const item of page.items.filter((item) => ids.includes(item.id))) {
      expect(item.revocationReason).toBe(reason);
      found.push(item.id);
    }
    cursor = page.nextCursor;
    pages++;
    if (pages > 10)
      throw new Error("Bounded authority pages failed to advance");
  } while (cursor !== null);
  expect(found.sort()).toEqual([...ids].sort());
  expect(pages).toBeGreaterThan(1);
});

it("IT-CBK-03 concurrent administrators serialize conflicting grants before publication and retain one actionable policy winner", async () => {
  const firstAdmin = randomUUID();
  const secondAdmin = randomUUID();
  const principalId = randomUUID();

  for (const id of [firstAdmin, secondAdmin, principalId])
    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active')",
      [id, `${id}@example.test`],
    );
  const published = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<number>();
  const firstDatabase: SqlDatabase = {
    execute: (query) => database.db.execute(query),
    transaction: (action) =>
      database.db.transaction(async (tx) => {
        const result = await action(tx);

        published.resolve();
        await release.promise;

        return result;
      }),
  };
  const secondDatabase: SqlDatabase = {
    execute: (query) => database.db.execute(query),
    transaction: (action) =>
      database.db.transaction(async (tx) => {
        const row = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`))
          .rows[0];

        secondStarted.resolve(Number(row.pid));

        return action(tx);
      }),
  };
  const input = {
    principalKind: "user" as const,
    principalId,
    actions: ["knowledge:read" as const],
    idempotencyKey: `${firstAdmin}_concurrent`,
  };
  const first = createCompanyGrants(firstDatabase, firstAdmin, input);
  const firstOutcome = first.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

  await published.promise;
  const second = createCompanyGrants(secondDatabase, secondAdmin, {
    ...input,
    idempotencyKey: `${secondAdmin}_concurrent`,
  });
  const secondOutcome = second.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

  try {
    const pid = await secondStarted.promise;

    await expect
      .poll(
        async () =>
          (
            await database.pool.query(
              "SELECT wait_event FROM pg_stat_activity WHERE pid=$1",
              [pid],
            )
          ).rows[0]?.wait_event,
        { timeout: 3000 },
      )
      .toBe("advisory");
  } finally {
    release.resolve();
    await Promise.all([firstOutcome, secondOutcome]);
  }
  expect(await firstOutcome).toMatchObject({ value: { duplicate: false } });
  expect(await secondOutcome).toMatchObject({ error: { code: "CONFLICT" } });
  expect(
    (
      await database.pool.query(
        "SELECT created_by,creation_key FROM company_grants WHERE principal_id=$1 AND revoked_at IS NULL",
        [principalId],
      )
    ).rows,
  ).toEqual([{ created_by: firstAdmin, creation_key: input.idempotencyKey }]);
});

it("IT-CBK-01 native UI owner choices and recipient search use current authority without widening a narrow record", async () => {
  const userId = randomUUID();
  const principal = { kind: "user" as const, userId };
  const companyId = String(
    (await database.pool.query("SELECT id FROM companies")).rows[0].id,
  );
  const owner = { kind: "company" as const, companyId };

  await database.pool.query(
    "INSERT INTO users(id,email,name,role,account_status) VALUES($1,$2,'Literal 100% policy recipient','member','active')",
    [userId, `${userId}@example.test`],
  );
  const visible = await seedProjectRow(database.db);
  const hidden = await seedProjectRow(database.db);

  await database.pool.query(
    "UPDATE projects SET brain_enabled=true WHERE id=ANY($1::text[])",
    [[visible.id, hidden.id]],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'viewer')",
    [randomUUID(), visible.id, userId],
  );
  expect(
    await knowledgeOwnerChoices(database.db, principal, "knowledge:read"),
  ).toEqual([]);
  await database.pool.query(
    "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
    [visible.id, userId],
  );
  expect(
    (await knowledgeOwnerChoices(database.db, principal, "knowledge:read")).map(
      (choice) => choice.owner,
    ),
  ).toEqual([{ kind: "project", projectId: visible.id }]);
  expect(
    await knowledgeOwnerChoices(database.db, principal, "knowledge:review"),
  ).toEqual([]);
  expect(await knowledgeOwnerActions(database.db, principal, owner)).toEqual({
    propose: false,
    review: false,
    confirm: false,
  });
  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) SELECT $1,'user',$2,action,$2 FROM unnest(ARRAY['knowledge:read','knowledge:propose','knowledge:review','knowledge:confirm']) action",
    [companyId, userId],
  );
  const recordId = randomUUID();

  await database.pool.query(
    "INSERT INTO brain_items(id,company_id,kind,title,content,content_hash,confidence) VALUES($1,$2,'assertion','Narrow UI record','Native action gates remain authoritative',$3,0.3)",
    [recordId, companyId, randomUUID()],
  );
  await database.pool.query(
    "INSERT INTO brain_record_grants(record_id,principal_type,principal_id,action,created_by) SELECT $1,'user',$2,action,jsonb_build_object('kind','user','id',$2::text,'runId',NULL,'attemptId',NULL) FROM unnest(ARRAY['knowledge:read','knowledge:review']) action",
    [recordId, userId],
  );
  expect(
    await knowledgeRecordActions(database.db, principal, owner, recordId),
  ).toEqual({ propose: false, review: true, confirm: false });
  await database.pool.query(
    "UPDATE brain_record_grants SET revoked_at=now() WHERE record_id=$1 AND action='knowledge:review'",
    [recordId],
  );
  expect(
    await knowledgeRecordActions(database.db, principal, owner, recordId),
  ).toEqual({ propose: false, review: false, confirm: false });
  await expect(
    listCompanyPrincipalOptions(database.db, userId, "%"),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await database.pool.query("UPDATE users SET role='admin' WHERE id=$1", [
    userId,
  ]);
  expect(await listCompanyPrincipalOptions(database.db, userId, "%")).toEqual([
    {
      kind: "user",
      id: userId,
      value: `user:${userId}`,
      label: "Literal 100% policy recipient",
    },
  ]);
  await expect(
    listCompanyPrincipalOptions(database.db, userId, "invalid\0query"),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await database.pool.query("UPDATE users SET role='member' WHERE id=$1", [
    userId,
  ]);
  await expect(
    listCompanyPrincipalOptions(database.db, userId, userId),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

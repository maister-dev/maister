import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { requireCompanyActionForUser } from "@/lib/authz";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  startMainAndBrainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "company_records",
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("IT-CBK-01 installation company exists without a repository or implicit grants", async () => {
  const tables = await database.pool.query<{ present: boolean }>(
    "SELECT to_regclass('public.companies') IS NOT NULL AS present",
  );

  expect(tables.rows[0]?.present).toBe(true);
  const company = await database.pool.query<{ id: string }>(
    "SELECT id FROM companies",
  );

  expect(company.rows).toHaveLength(1);
  expect(await database.pool.query("SELECT id FROM projects")).toMatchObject({
    rowCount: 0,
  });
  expect(
    await database.pool.query("SELECT id FROM company_grants"),
  ).toMatchObject({ rowCount: 0 });
  await expect(
    database.pool.query("INSERT INTO companies DEFAULT VALUES"),
  ).rejects.toMatchObject({ code: "23505" });
  await expect(
    database.pool.query(
      "INSERT INTO companies(installation_singleton) VALUES(false)",
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

it("IT-CBK-01 explicit action grants are isolated from ownership, global admin and revocation", async () => {
  const companyId = (
    await database.pool.query<{ id: string }>("SELECT id FROM companies")
  ).rows[0]!.id;

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES('company-admin','company-admin@example.test','admin','active'),('reader','reader@example.test','viewer','active')",
  );
  await expect(
    requireCompanyActionForUser("company-admin", companyId, "knowledge:read"),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const grant = await database.pool.query<{ id: string }>(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'user','reader','knowledge:read','company-admin') RETURNING id",
    [companyId],
  );
  const access = await requireCompanyActionForUser(
    "reader",
    companyId,
    "knowledge:read",
  );

  expect(access).toMatchObject({
    companyId,
    grantId: grant.rows[0]!.id,
    policyRevision: 1,
    confirmationClasses: [],
  });
  await expect(
    requireCompanyActionForUser("reader", companyId, "knowledge:confirm"),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    requireCompanyActionForUser("reader", companyId, "targets:restart"),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    requireCompanyActionForUser("reader", "unknown-company", "knowledge:read"),
  ).rejects.toMatchObject({
    code: "UNAUTHORIZED",
    details: { reason: "company_grant_required" },
  });
  await expect(
    database.pool.query(
      "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'user','reader','knowledge:read','company-admin')",
      [companyId],
    ),
  ).rejects.toMatchObject({ code: "23505" });
  await database.pool.query(
    "UPDATE company_grants SET revoked_at=now(),revision=revision+1 WHERE id=$1",
    [grant.rows[0]!.id],
  );
  await expect(
    requireCompanyActionForUser("reader", companyId, "knowledge:read"),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'user','reader','knowledge:read','company-admin')",
    [companyId],
  );
  await expect(
    requireCompanyActionForUser("reader", companyId, "knowledge:read"),
  ).resolves.toMatchObject({ companyId });
  await database.pool.query(
    "UPDATE users SET account_status='disabled' WHERE id='reader'",
  );
  await expect(
    requireCompanyActionForUser("reader", companyId, "knowledge:read"),
  ).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
  await database.pool.query(
    "UPDATE users SET account_status='active',must_change_password=true WHERE id='reader'",
  );
  await expect(
    requireCompanyActionForUser("reader", companyId, "knowledge:read"),
  ).rejects.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
  await expect(
    requireCompanyActionForUser("missing-user", companyId, "knowledge:read"),
  ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
});

it("IT-CBK-05 company records keep explicit ownership and unknown legacy metadata", async () => {
  const shape = await database.pool.query<{ present: boolean }>(
    "SELECT to_regclass('public.brain_record_revisions') IS NOT NULL AS present",
  );

  expect(shape.rows[0]?.present).toBe(true);
  const companyId = (
    await database.pool.query<{ id: string }>("SELECT id FROM companies")
  ).rows[0]!.id;
  const row = await database.pool.query<{ id: string }>(
    "INSERT INTO brain_items(id,company_id,kind,title,content,confidence,content_hash) VALUES(gen_random_uuid()::text,$1,'procedure','Runbook','Inspect the configured component',0.99,'legacy-unverified-hash') RETURNING id",
    [companyId],
  );
  const revision = await database.pool.query<{
    basis: string;
    attribution: unknown;
    provenance: string;
    freshness: unknown;
  }>(
    "SELECT basis,attribution,provenance,freshness FROM brain_record_revisions WHERE record_id=$1 AND revision=1",
    [row.rows[0]!.id],
  );

  expect(revision.rows[0]).toMatchObject({
    basis: "unknown",
    attribution: { kind: "legacy_unknown", id: null },
    provenance: "legacy_writer",
    freshness: { applicability: "unknown", observedAt: null, sourceAt: null },
  });
  await expect(
    database.pool.query(
      "INSERT INTO brain_items(id,kind,title,content,confidence,content_hash) VALUES(gen_random_uuid()::text,'assertion','No owner','Unsupported',0.3,'ownerless')",
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const project = await seedProjectRow(database.db);

  await expect(
    database.pool.query(
      "INSERT INTO brain_items(id,project_id,company_id,kind,title,content,confidence,content_hash) VALUES(gen_random_uuid()::text,$1,$2,'assertion','Two owners','Ambiguous',0.3,'two-owner')",
      [project.id, companyId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "brain_items_owner_check",
  });
  await expect(
    database.pool.query(
      "UPDATE brain_items SET company_id=null,project_id=$1 WHERE id=$2",
      [project.id, row.rows[0]!.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "brain_record_owner_immutable",
  });
  const source = await database.pool.query<{ id: string }>(
    "INSERT INTO brain_sources(id,company_id,kind,path,title,submitted_content,source_hash,chunker_id,chunker_version) VALUES(gen_random_uuid()::text,$1,'text','submitted:example','Runbook','Inspect configured component','current-content-hash','native_submission','1') RETURNING id",
    [companyId],
  );

  expect(source.rows).toHaveLength(1);
  await expect(
    database.pool.query(
      "INSERT INTO brain_index_jobs(id,project_id,source_id,reason) VALUES(gen_random_uuid()::text,null,$1,'manual')",
      [source.rows[0]!.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "brain_source_owner_check",
  });
  await expect(
    database.pool.query("DELETE FROM brain_items WHERE id=$1", [
      row.rows[0]!.id,
    ]),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "brain_record_delete_requires_project_cascade",
  });
  await expect(
    database.pool.query(
      "UPDATE brain_record_revisions SET assertion='silently replaced' WHERE record_id=$1",
      [row.rows[0]!.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "brain_record_revision_immutable",
  });
});

it("IT-CBK-02 native record head cannot diverge from its immutable assertion revision", async () => {
  const row = await database.pool.query<{ id: string }>(
    "INSERT INTO brain_items(id,company_id,kind,title,content,confidence,content_hash) SELECT gen_random_uuid()::text,id,'assertion','Consistent','Original assertion',0.3,'consistent-example' FROM companies RETURNING id",
  );
  const client = await database.pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('maister.knowledge_writer','native_v1',true)",
    );
    await client.query(
      "UPDATE brain_items SET content='Unrecorded replacement' WHERE id=$1",
      [row.rows[0]!.id],
    );
    await expect(client.query("COMMIT")).rejects.toMatchObject({
      code: "23514",
      constraint: "brain_record_head_matches_revision",
    });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

it("IT-CBK-01 narrower grants cannot leave or restore a broadly readable projection", async () => {
  const row = await database.pool.query<{ id: string }>(
    "INSERT INTO brain_items(id,company_id,kind,title,content,confidence,content_hash) SELECT gen_random_uuid()::text,id,'assertion','Restricted','Restricted assertion',0.3,'restricted-example' FROM companies RETURNING id",
  );

  await database.pool.query(
    "INSERT INTO brain_record_grants(record_id,principal_type,principal_id,action,created_by) VALUES($1,'user','reader','knowledge:read',$2::jsonb)",
    [
      row.rows[0]!.id,
      JSON.stringify({
        kind: "user",
        id: "company-admin",
        runId: null,
        attemptId: null,
      }),
    ],
  );
  expect(
    (
      await database.pool.query<{ visibility: string }>(
        "SELECT visibility FROM brain_items WHERE id=$1",
        [row.rows[0]!.id],
      )
    ).rows[0]?.visibility,
  ).toBe("restricted");
  await expect(
    database.pool.query(
      "UPDATE brain_items SET visibility='owner_grants' WHERE id=$1",
      [row.rows[0]!.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "brain_record_grants_require_restriction",
  });
  await database.pool.query(
    "UPDATE brain_record_grants SET revoked_at=now() WHERE record_id=$1",
    [row.rows[0]!.id],
  );
  expect(
    (
      await database.pool.query<{ visibility: string }>(
        "SELECT visibility FROM brain_items WHERE id=$1",
        [row.rows[0]!.id],
      )
    ).rows[0]?.visibility,
  ).toBe("restricted");
});

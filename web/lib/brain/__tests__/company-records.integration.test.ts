import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { requireCompanyActionForUser } from "@/lib/authz";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import {
  resolveKnowledgePrincipal,
  resolveNativeTokenPrincipal,
} from "@/lib/brain/knowledge-access";
import { knowledgeReadPolicyCte } from "@/lib/brain/knowledge-query-policy";
import { authorizeKnowledgeRecordRead } from "@/lib/brain/knowledge-restrictions";
import { loadProjectBrainPanelData } from "@/lib/brain/ui-queries";
import {
  issueOrchestratorRunToken,
  revokeOrchestratorRunTokensForRun,
} from "@/lib/agents/tokens";
import { pgErrorOf } from "@/lib/db/pg-error";
import { isMaisterError } from "@/lib/errors";
import {
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "@/lib/brain/knowledge-disclosure";
import { captureKnowledgeSource } from "@/lib/brain/knowledge-source-capture";
import { inspectKnowledgeWitness } from "@/lib/brain/knowledge-witnesses";
import { listBrainSources } from "@/lib/brain/sources";
import { sha256 } from "@/lib/brain/codec";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
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

it("IT-CBE-06 inherited source restrictions are immutable, partition deduplication and never block project deletion", async () => {
  const columns = await database.pool.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name='brain_record_revisions' AND column_name='source_restrictions'",
  );

  expect(columns.rows).toEqual([{ column_name: "source_restrictions" }]);
  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "UPDATE projects SET brain_enabled=true WHERE id=$1",
    [project.id],
  );
  const companyId = (
    await database.pool.query<{ id: string }>("SELECT id FROM companies")
  ).rows[0]!.id;
  const derivedId = randomUUID();
  const ordinaryId = randomUUID();
  const projectRecordId = randomUUID();
  const sourceRestrictions = [{ kind: "project", projectId: project.id }];
  const connection = await database.pool.connect();

  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT set_config('maister.knowledge_writer','native_v1',true)",
    );
    for (const [id, restrictions] of [
      [derivedId, sourceRestrictions],
      [ordinaryId, []],
    ] as const) {
      await connection.query(
        "INSERT INTO brain_items(id,company_id,kind,title,content,content_hash,confidence,source_restrictions) VALUES($1,$2,'procedure','Procedure','Same assertion in different access domains','scoped-duplicate',0.3,$3::jsonb)",
        [id, companyId, JSON.stringify(restrictions)],
      );
      await connection.query(
        "INSERT INTO brain_record_revisions(record_id,revision,assertion,title,kind,basis,content_sha256,attribution,freshness,provenance,source_restrictions) SELECT id,1,content,title,kind,'inferred',encode(sha256(convert_to(content,'UTF8')),'hex'),$2::jsonb,$3::jsonb,'submitted',source_restrictions FROM brain_items WHERE id=$1",
        [
          id,
          JSON.stringify({
            kind: "system",
            id: "test",
            runId: null,
            attemptId: null,
          }),
          JSON.stringify({ state: "unknown" }),
        ],
      );
    }
    await connection.query("COMMIT");
  } finally {
    connection.release();
  }
  expect(
    (
      await database.pool.query(
        "SELECT count(DISTINCT source_acl_key)::int AS n FROM brain_items WHERE id=ANY($1::text[])",
        [[derivedId, ordinaryId]],
      )
    ).rows,
  ).toEqual([{ n: 2 }]);
  await expect(
    database.pool.query(
      "UPDATE brain_items SET source_restrictions=$2::jsonb WHERE id=$1",
      [derivedId, JSON.stringify([{ kind: "company", companyId }])],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "brain_record_head_matches_revision",
  });
  await expect(
    database.pool.query(
      "UPDATE brain_record_revisions SET source_restrictions='[]' WHERE record_id=$1",
      [derivedId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "brain_record_revision_immutable",
  });
  await database.pool.query(
    "INSERT INTO brain_items(id,project_id,kind,title,content,content_hash,confidence,source_restrictions) VALUES($1,$2,'lesson','Restricted projection','source-classification-canary','source-classification-canary',0.3,$3::jsonb)",
    [
      projectRecordId,
      project.id,
      JSON.stringify([{ kind: "company", companyId }]),
    ],
  );
  expect(
    (
      await loadProjectBrainPanelData(
        database.db,
        project.id,
        "source-classification-canary",
      )
    ).memory,
  ).toEqual([]);
  const readerId = randomUUID();
  const principal = { kind: "user" as const, userId: readerId };

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [readerId, `${readerId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), project.id, readerId],
  );
  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'user',$2,'knowledge:read',$2)",
    [companyId, readerId],
  );
  expect(
    (
      await database.db.transaction((tx) =>
        authorizeKnowledgeRecordRead(tx, principal, derivedId),
      )
    ).record.id,
  ).toBe(derivedId);
  const visible = () =>
    database.db.transaction(async (tx) => {
      const identity = await resolveKnowledgePrincipal(
        tx,
        principal,
        "knowledge:read",
      );
      const policy = knowledgeReadPolicyCte(
        identity,
        sql`i.id IN (${derivedId},${ordinaryId})`,
      );

      return (
        await tx.execute(
          sql`${policy} SELECT id FROM knowledge_readable_records ORDER BY id`,
        )
      ).rows;
    });

  expect(await visible()).toHaveLength(2);
  await database.pool.query(
    "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
    [project.id, readerId],
  );
  await expect(
    database.db.transaction((tx) =>
      authorizeKnowledgeRecordRead(tx, principal, derivedId),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_reference_unavailable" },
  });
  expect(
    (
      await database.db.transaction((tx) =>
        authorizeKnowledgeRecordRead(tx, principal, ordinaryId),
      )
    ).record.id,
  ).toBe(ordinaryId);
  expect(await visible()).toEqual([{ id: ordinaryId }]);
  await database.pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
  expect(
    (
      await database.pool.query(
        "SELECT source_restrictions FROM brain_items WHERE id=$1",
        [derivedId],
      )
    ).rows,
  ).toEqual([{ source_restrictions: sourceRestrictions }]);
  expect(
    (
      await database.pool.query("SELECT id FROM brain_items WHERE id=$1", [
        projectRecordId,
      ])
    ).rows,
  ).toEqual([]);
});

it("IT-CBE-06 run-bound disclosure captures are durable, serialized and refuse unknown historical input", async () => {
  const project = await seedProjectRow(database.db);
  const companyId = (
    await database.pool.query<{ id: string }>("SELECT id FROM companies")
  ).rows[0]!.id;
  const runId = await seedRun(database.db, {
    projectId: project.id,
    status: "Running",
    runKind: "flow",
  });
  const issued = await issueOrchestratorRunToken({
    projectId: project.id,
    runId,
    db: database.db,
  });
  const principal = { kind: "token" as const, tokenId: issued.tokenId };

  await expect(
    database.db.transaction((tx) => lockKnowledgeReadConsumer(tx, principal)),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_capture_profile_required" },
  });
  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [],
      }),
    ],
  );
  let releaseFirst: () => void = () => {
    throw new Error("first disclosure transaction has not started");
  };
  let firstLocked: (backendId: number) => void = () => {
    throw new Error("first disclosure barrier is not initialized");
  };
  const release = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const locked = new Promise<number>((resolve) => {
    firstLocked = resolve;
  });
  const first = database.db.transaction(async (tx) => {
    const consumer = await lockKnowledgeReadConsumer(tx, principal);

    await recordKnowledgeDisclosure(tx, consumer, [
      { kind: "company", companyId },
    ]);
    const backend = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);

    firstLocked(Number(backend.rows[0]!.pid));
    await release;
  });

  const backendId = await locked;
  const second = database.db.transaction(async (tx) => {
    const consumer = await lockKnowledgeReadConsumer(tx, principal);

    await recordKnowledgeDisclosure(tx, consumer, [
      { kind: "project", projectId: project.id },
    ]);
  });

  try {
    await expect
      .poll(
        async () =>
          Number(
            (
              await database.pool.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))",
                [backendId],
              )
            ).rows[0]!.n,
          ),
        { timeout: 5000 },
      )
      .toBe(1);
  } finally {
    releaseFirst();
    await Promise.all([first, second]);
  }
  const capture = (
    await database.pool.query("SELECT knowledge_access FROM runs WHERE id=$1", [
      runId,
    ])
  ).rows[0]!.knowledge_access;

  expect(capture).toMatchObject({
    schemaVersion: 1,
    state: "complete",
    generation: 3,
    restrictions: expect.arrayContaining([
      { kind: "company", companyId },
      { kind: "project", projectId: project.id },
    ]),
  });
  expect(capture.restrictions).toHaveLength(2);
  await database.pool.query(
    "UPDATE project_tokens SET revoked_at=now() WHERE id=$1",
    [issued.tokenId],
  );
  await expect(
    database.db.transaction((tx) => lockKnowledgeReadConsumer(tx, principal)),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

it("IT-CBE-01 repository-free source capture retains exact bounded evidence and content-guarded receipts across project deletion", async () => {
  const companyId = (
    await database.pool.query<{ id: string }>("SELECT id FROM companies")
  ).rows[0]!.id;
  const userId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) SELECT $1,'user',$2,action,$2 FROM unnest(ARRAY['knowledge:read','knowledge:propose']) action",
    [companyId, userId],
  );
  const principal = { kind: "user" as const, userId };
  const input = {
    owner: { kind: "company" as const, companyId },
    title: "Versioned submitted runbook",
    content: "Проверить 🧠service\n".repeat(700),
    reportedSourceVersion: "operator-upload-v1",
    idempotencyKey: "source_capture_delivery_001",
  };
  const first = await captureKnowledgeSource(database.db, principal, input);

  expect(first).toMatchObject({
    duplicate: false,
    witness: {
      availability: "available",
      sourceVersion: `sha256:${sha256(input.content)}`,
      sha256: sha256(input.content),
      excerptTruncated: true,
      observedAt: null,
      sourceAt: null,
      independenceGroupId: null,
      attribution: { kind: "user", id: userId, runId: null, attemptId: null },
    },
  });
  await expect(
    database.pool.query(
      "UPDATE brain_sources SET submitted_content='overwritten' WHERE id=$1",
      [first.witness.sourceId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "brain_native_capture_immutable",
  });
  await expect(
    database.pool.query("DELETE FROM brain_sources WHERE id=$1", [
      first.witness.sourceId,
    ]),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "brain_native_capture_immutable",
  });
  expect(Buffer.byteLength(first.witness.excerpt!, "utf8")).toBeLessThanOrEqual(
    8192,
  );
  expect(first.witness.excerpt).not.toContain("�");
  expect(input.content.startsWith(first.witness.excerpt!)).toBe(true);
  expect(
    await captureKnowledgeSource(database.db, principal, input),
  ).toMatchObject({ duplicate: true, witness: { id: first.witness.id } });
  await expect(
    captureKnowledgeSource(database.db, principal, {
      ...input,
      content: `${input.content} changed`,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    await captureKnowledgeSource(database.db, principal, {
      ...input,
      idempotencyKey: "source_capture_delivery_alias",
    }),
  ).toMatchObject({ duplicate: true, witness: { id: first.witness.id } });
  expect(
    (
      await database.pool.query(
        "SELECT id FROM brain_evidence_observations WHERE source_id=$1",
        [first.witness.sourceId],
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM brain_source_submissions WHERE source_id=$1",
        [first.witness.sourceId],
      )
    ).rows,
  ).toHaveLength(2);
  expect(
    (
      await database.pool.query(
        "SELECT project_id,submitted_content FROM brain_sources WHERE id=$1",
        [first.witness.sourceId],
      )
    ).rows,
  ).toEqual([{ project_id: null, submitted_content: input.content }]);
  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "UPDATE projects SET brain_enabled=true WHERE id=$1",
    [project.id],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), project.id, userId],
  );
  const local = await captureKnowledgeSource(database.db, principal, {
    ...input,
    owner: { kind: "project", projectId: project.id },
    content: "Project-local submitted runbook",
    idempotencyKey: "source_capture_project_001",
  });

  expect(await listBrainSources(database.db, project.id)).toEqual([]);
  await database.pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM brain_source_submissions WHERE source_id=$1",
        [local.witness.sourceId],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM brain_evidence_witnesses WHERE id=$1",
        [local.witness.id],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await database.db.transaction((tx) =>
        inspectKnowledgeWitness(tx, principal, first.witness.id),
      )
    ).witness,
  ).toEqual(first.witness);
  await database.pool.query(
    "UPDATE company_grants SET revoked_at=now() WHERE company_id=$1 AND principal_id=$2 AND action='knowledge:read'",
    [companyId, userId],
  );
  await expect(
    captureKnowledgeSource(database.db, principal, input),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    database.db.transaction((tx) =>
      inspectKnowledgeWitness(tx, principal, first.witness.id),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_reference_unavailable" },
  });
});

it("IT-CBK-05 native reads keep oversized legacy assertions usable without inventing authorship or confirmation", async () => {
  const project = await seedProjectRow(database.db);
  const userId = randomUUID();
  const recordId = randomUUID();
  const original = `${"Ж".repeat(31999)}🧠${"?".repeat(1000)}`;

  await database.pool.query(
    "UPDATE projects SET brain_enabled=true WHERE id=$1",
    [project.id],
  );
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), project.id, userId],
  );
  await database.pool.query(
    "INSERT INTO brain_items(id,project_id,kind,title,content,content_hash,confidence) VALUES($1,$2,'state_fact','Legacy retained finding',$3,$4,0.99)",
    [recordId, project.id, original, randomUUID()],
  );
  const result = await getKnowledgeRecord(
    database.db,
    { kind: "user", userId },
    { recordId },
  );

  expect(result).toMatchObject({
    id: recordId,
    revision: 1,
    assertionTruncated: true,
    basis: "unknown",
    confirmation: { state: "unconfirmed" },
    attribution: {
      kind: "legacy_unknown",
      id: null,
      runId: null,
      attemptId: null,
    },
    freshness: {
      state: "unknown",
      applicability: "unknown",
      observedAt: null,
      sourceAt: null,
    },
  });
  expect(result.assertion).toBe("Ж".repeat(31999));
  expect(result.limitations).toEqual([]);
  expect(result.diagnostics).toEqual([
    "legacy_writer_metadata_unknown",
    "historical_source_classification_unknown",
    "assertion_truncated",
  ]);
  expect(
    (
      await database.pool.query("SELECT content FROM brain_items WHERE id=$1", [
        recordId,
      ])
    ).rows,
  ).toEqual([{ content: original }]);
  expect(
    (
      await database.pool.query(
        "SELECT limitations FROM brain_record_revisions WHERE record_id=$1 AND revision=1",
        [recordId],
      )
    ).rows,
  ).toEqual([
    {
      limitations: [
        "Legacy writer metadata does not establish submitting identity, observation time or confirmation.",
      ],
    },
  ]);
  await database.pool.query(
    "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
    [project.id, userId],
  );
  await expect(
    getKnowledgeRecord(database.db, { kind: "user", userId }, { recordId }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_reference_unavailable" },
  });
});

async function nativeDisclosureCredentialFixture() {
  const project = await seedProjectRow(database.db);
  const runId = await seedRun(database.db, {
    projectId: project.id,
    status: "Running",
    runKind: "flow",
  });

  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [],
      }),
    ],
  );
  const issued = await issueOrchestratorRunToken({
    projectId: project.id,
    runId,
    db: database.db,
  });

  return { projectId: project.id, runId, tokenId: issued.tokenId };
}

it("IT-CBE-06 native disclosure and the actual token issuer serialize without a Run/token lock cycle", async () => {
  const fixture = await nativeDisclosureCredentialFixture();
  const tokenLocked = Promise.withResolvers<number>();
  const releaseReader = Promise.withResolvers<void>();
  const dialect = new PgDialect();
  let intercepted = false;
  const reader = database.db
    .transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='8s'`);
      const consumer = await lockKnowledgeReadConsumer(
        {
          execute: async (query) => {
            const result = await tx.execute(query);
            const text = dialect.sqlToQuery(query).sql;

            if (
              !intercepted &&
              /project_tokens/i.test(text) &&
              /FOR SHARE/i.test(text)
            ) {
              intercepted = true;
              const backend = await tx.execute(
                sql`SELECT pg_backend_pid() AS pid`,
              );

              tokenLocked.resolve(Number(backend.rows[0]!.pid));
              await releaseReader.promise;
            }

            return result;
          },
        },
        { kind: "token", tokenId: fixture.tokenId },
      );

      await recordKnowledgeDisclosure(tx, consumer, [
        { kind: "project", projectId: fixture.projectId },
      ]);
    })
    .then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({
        status: "rejected" as const,
        sqlState: pgErrorOf(error)?.code,
      }),
    );
  const backendId = await tokenLocked.promise;
  const issuer = issueOrchestratorRunToken({
    projectId: fixture.projectId,
    runId: fixture.runId,
    db: database.db,
  }).then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({
      status: "rejected" as const,
      sqlState: pgErrorOf(error)?.code,
    }),
  );

  try {
    await expect
      .poll(async () =>
        Number(
          (
            await database.pool.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))",
              [backendId],
            )
          ).rows[0]!.count,
        ),
      )
      .toBe(1);
  } finally {
    releaseReader.resolve();
  }
  expect(await Promise.all([reader, issuer])).toEqual([
    { status: "fulfilled" },
    { status: "fulfilled" },
  ]);
  expect(
    (
      await database.pool.query(
        "SELECT knowledge_access FROM runs WHERE id=$1",
        [fixture.runId],
      )
    ).rows[0]!.knowledge_access,
  ).toMatchObject({
    generation: 2,
    restrictions: [{ kind: "project", projectId: fixture.projectId }],
  });
  expect(
    (
      await database.pool.query(
        "SELECT revoked_at IS NOT NULL AS revoked FROM project_tokens WHERE id=$1",
        [fixture.tokenId],
      )
    ).rows[0]!.revoked,
  ).toBe(true);
});

it.each(["disclosure", "native_identity"] as const)(
  "IT-CBE-06 current token revocation wins while %s waits for its Run and discloses no data",
  async (mode) => {
    const fixture = await nativeDisclosureCredentialFixture();
    const runLocked = Promise.withResolvers<number>();
    const revokeNow = Promise.withResolvers<void>();
    const revoker = database.db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout='8s'`);
        await tx.execute(
          sql`SELECT id FROM runs WHERE id=${fixture.runId} FOR UPDATE`,
        );
        runLocked.resolve(
          Number(
            (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!
              .pid,
          ),
        );
        await revokeNow.promise;
        await revokeOrchestratorRunTokensForRun(fixture.runId, tx);
      })
      .then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({
          status: "rejected" as const,
          sqlState: pgErrorOf(error)?.code,
        }),
      );
    const backendId = await runLocked.promise;
    const reader = database.db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout='8s'`);
        if (mode === "native_identity")
          await resolveNativeTokenPrincipal(
            tx,
            fixture.tokenId,
            "knowledge:read",
          );
        else {
          const consumer = await lockKnowledgeReadConsumer(tx, {
            kind: "token",
            tokenId: fixture.tokenId,
          });

          await recordKnowledgeDisclosure(tx, consumer, [
            { kind: "project", projectId: fixture.projectId },
          ]);
        }
      })
      .then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({
          status: "rejected" as const,
          domainCode: isMaisterError(error) ? error.code : undefined,
          sqlState: pgErrorOf(error)?.code,
        }),
      );

    try {
      await expect
        .poll(async () =>
          Number(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))",
                [backendId],
              )
            ).rows[0]!.count,
          ),
        )
        .toBe(1);
    } finally {
      revokeNow.resolve();
    }
    const [revocationOutcome, readOutcome] = await Promise.all([
      revoker,
      reader,
    ]);

    expect(revocationOutcome).toEqual({ status: "fulfilled" });
    expect(readOutcome).toMatchObject({
      status: "rejected",
      domainCode: "UNAUTHORIZED",
      sqlState: undefined,
    });
    expect(
      (
        await database.pool.query(
          "SELECT knowledge_access FROM runs WHERE id=$1",
          [fixture.runId],
        )
      ).rows[0]!.knowledge_access,
    ).toMatchObject({ generation: 1, restrictions: [] });
    expect(
      (
        await database.pool.query(
          "SELECT revoked_at IS NOT NULL AS revoked FROM project_tokens WHERE id=$1",
          [fixture.tokenId],
        )
      ).rows[0]!.revoked,
    ).toBe(true);
  },
);

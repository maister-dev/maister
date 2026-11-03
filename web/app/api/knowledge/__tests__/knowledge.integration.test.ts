import type { KnowledgeDatabase } from "@/lib/brain/knowledge-access";
import type { SessionUser } from "@/lib/authz";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { KnowledgeWitnessDto } from "@/lib/brain/knowledge-read-types";
import type { CreateKnowledgeProposalInput } from "@/lib/brain/knowledge-types";
import type { KnowledgeProposalReceipt } from "@/lib/brain/knowledge-proposals";

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { Ajv } from "ajv";
import { NextRequest } from "next/server";
import { parse } from "yaml";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import knowledgeToolSchemas from "../../../../../runtime/knowledge-tool-input.schema.json";

import { MaisterError } from "@/lib/errors";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import {
  createBrainProposal,
  reviewKnowledgeProposal,
  confirmKnowledgeRecord,
} from "@/lib/brain/proposals";
import { GET as readEvidence } from "@/app/api/knowledge/[recordId]/evidence/route";
import { GET as searchRecords } from "@/app/api/knowledge/route";
import { GET as getRecord } from "@/app/api/knowledge/[recordId]/route";
import {
  createInvocation,
  invocationFromEnvironment,
  fixtureProcessEnvironment,
  registerSpawnedProcess,
  signalInvocationGroup,
  assertInvocationGroupEmpty,
} from "@/test-support/process-invocation";
import { GET as extEvidence } from "@/app/api/v1/ext/knowledge/[recordId]/evidence/route";
import { GET as extConflicts } from "@/app/api/v1/ext/knowledge/[recordId]/conflicts/route";
import { GET as extSearch } from "@/app/api/v1/ext/knowledge/route";
import { GET as extRecord } from "@/app/api/v1/ext/knowledge/[recordId]/route";
import { GET as extWitness } from "@/app/api/v1/ext/knowledge/witnesses/[witnessId]/route";
import { GET as extProposal } from "@/app/api/v1/ext/knowledge/proposals/[proposalId]/route";
import {
  GET as extProposals,
  POST as extPropose,
} from "@/app/api/v1/ext/knowledge/proposals/route";
import { POST as extDecide } from "@/app/api/v1/ext/knowledge/proposals/[proposalId]/decision/route";
import { POST as extConfirm } from "@/app/api/v1/ext/knowledge/[recordId]/confirmations/route";
import { POST as extCapture } from "@/app/api/v1/ext/knowledge/sources/route";
import { issueToken, issueUserAccessToken } from "@/lib/tokens/issue";
import { normalizeTokenScopes } from "@/lib/tokens/scopes";
import { GET as readConflicts } from "@/app/api/knowledge/[recordId]/conflicts/route";
import { getKnowledgeConflictsPage } from "@/lib/brain/knowledge-conflicts";
import { getKnowledgeEvidencePage } from "@/lib/brain/knowledge-evidence-page";
import { sha256 } from "@/lib/brain/codec";
import { captureKnowledgeSource } from "@/lib/brain/knowledge-source-capture";
import { searchKnowledge } from "@/lib/brain/knowledge-search";
import { listKnowledgeProposals } from "@/lib/brain/knowledge-proposal-read";
import { knowledgeSearchSchema } from "@/lib/brain/knowledge-read-types";
import { issueAgentRunToken } from "@/lib/agents/tokens";
import { seedRun } from "@/test-support/execution-host-seed";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { GET as listProposals } from "@/app/api/knowledge/proposals/route";
import { GET as getProposal } from "@/app/api/knowledge/proposals/[proposalId]/route";
import { POST as proposeKnowledge } from "@/app/api/knowledge/proposals/route";
import { POST as decideKnowledge } from "@/app/api/knowledge/proposals/[proposalId]/decision/route";
import { POST as confirmKnowledge } from "@/app/api/knowledge/[recordId]/confirmations/route";
import { POST as captureSource } from "@/app/api/knowledge/sources/route";

let database: StartedPostgresTestDb;
let session: SessionUser | null = null;
let companyId: string;
let readerId: string;
const contracts = new Ajv({
  strict: false,
  allErrors: true,
  validateFormats: false,
});

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

function assertContract(name: string, body: unknown): void {
  const validate = contracts.getSchema(`web#/components/schemas/${name}`);

  if (!validate) throw new Error(`Native contract ${name} is missing`);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}

function jsonRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readRecord(id: string, query = ""): Promise<Response> {
  return getRecord(
    new NextRequest(`http://localhost/api/knowledge/${id}${query}`),
    { params: Promise.resolve({ recordId: id }) },
  );
}

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "native_knowledge_http",
  });
  contracts.addSchema(
    parse(await readFile("../docs/api/web.openapi.yaml", "utf8")),
    "web",
  );
  companyId = (
    await database.pool.query<{ id: string }>("SELECT id FROM companies")
  ).rows[0]!.id;
}, 180000);

afterAll(async () => {
  await database?.stop();
});

beforeEach(async () => {
  readerId = randomUUID();
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [readerId, `${readerId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) SELECT $1,'user',$2,action,$2 FROM unnest(ARRAY['knowledge:read','knowledge:propose','knowledge:review']) action",
    [companyId, readerId],
  );
  session = {
    id: readerId,
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  };
});

it("IT-CBK-06 session HTTP capture/get preserve native evidence, honest confirmation and current owner visibility", async () => {
  const sourceBody = {
    owner: { kind: "company", companyId },
    title: "Configured runbook",
    content:
      "Restart only the configured component and verify health separately.",
    idempotencyKey: `http_source_${readerId}`,
  };
  const captured = await captureSource(
    jsonRequest("/api/knowledge/sources", sourceBody),
  );
  const witness = (await captured.json()) as KnowledgeWitnessDto;

  expect(captured.status).toBe(201);
  expect(captured.headers.get("cache-control")).toBe("private, no-store");
  assertContract("CBEvidenceWitness", witness);
  expect(witness.attribution).toEqual({
    kind: "user",
    id: readerId,
    runId: null,
    attemptId: null,
  });
  expect(witness.excerpt).toBe(sourceBody.content);
  const replay = await captureSource(
    jsonRequest("/api/knowledge/sources", sourceBody),
  );

  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(witness);
  const principal = { kind: "user" as const, userId: readerId };
  const proposal = await createBrainProposal(database.db, {
    kind: "knowledge_add",
    owner: { kind: "company", companyId },
    principal,
    idempotencyKey: `http_proposal_${readerId}`,
    draft: {
      title: "Configured maintenance procedure",
      kind: "procedure",
      assertion: sourceBody.content,
      basis: "inferred",
      evidence: [
        {
          relation: "supports",
          reference: {
            kind: "witness",
            id: witness.id,
            version: witness.sourceVersion!,
            sha256: witness.sha256!,
          },
        },
      ],
      missingEvidence: [],
      limitations: ["This procedure is not a health observation."],
    },
  });
  const accepted = await reviewKnowledgeProposal(database.db, {
    proposalId: proposal.id,
    principal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Publish the reviewed runbook",
    idempotencyKey: `http_review_${readerId}`,
  });
  const recordId = accepted.acceptedRecordId!;

  await database.pool.query(
    "UPDATE brain_items SET confidence=0.99 WHERE id=$1",
    [recordId],
  );
  const response = await readRecord(recordId, "?revision=1");
  const body = await response.json();

  expect(response.status).toBe(200);
  assertContract("CBKnowledgeRecord", body);
  expect(body).toMatchObject({
    id: recordId,
    owner: sourceBody.owner,
    revision: 1,
    assertion: sourceBody.content,
    assertionTruncated: false,
    basis: "inferred",
    confirmation: { state: "unconfirmed" },
    freshness: { state: "unknown", observedAt: null, sourceAt: null },
    attribution: { kind: "user", id: readerId },
  });
  expect(body.evidence[0]).toMatchObject({
    relation: "supports",
    witness: {
      id: witness.id,
      sha256: witness.sha256,
      availability: "available",
    },
  });
  expect(body.evidence[0].witness).not.toHaveProperty("excerpt");
  expect((await readRecord(recordId, "?revision=2147483648")).status).toBe(400);
  expect((await readRecord(recordId, "?revision=1&revision=2")).status).toBe(
    400,
  );
  const adminId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active')",
    [adminId, `${adminId}@example.test`],
  );
  session = {
    id: adminId,
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  };
  const denied = await readRecord(recordId);
  const absent = await readRecord(randomUUID());

  expect(denied.status).toBe(404);
  expect(absent.status).toBe(404);
  expect(await denied.json()).toEqual(await absent.json());
  session = {
    id: readerId,
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  };
  await database.pool.query(
    "UPDATE company_grants SET revoked_at=now() WHERE company_id=$1 AND principal_id=$2 AND action='knowledge:read'",
    [companyId, readerId],
  );
  expect((await readRecord(recordId)).status).toBe(404);
});

it("IT-CBK-06 native writes reject model attribution and bound streamed JSON independently of content-length", async () => {
  const input = {
    owner: { kind: "company", companyId },
    title: "Untrusted source",
    content: "Source bytes",
    idempotencyKey: `invalid_source_${readerId}`,
  };
  const forged = await captureSource(
    jsonRequest("/api/knowledge/sources", {
      ...input,
      attribution: { kind: "user", id: "forged-author" },
    }),
  );

  expect(forged.status).toBe(400);
  assertContract("CBError", await forged.json());
  expect(
    (
      await database.pool.query(
        "SELECT id FROM brain_source_submissions WHERE principal_key=$1",
        [`user:${readerId}`],
      )
    ).rows,
  ).toEqual([]);
  for (const content of ["invalid\0text", "invalid\ud800text"]) {
    const rejected = await captureSource(
      jsonRequest("/api/knowledge/sources", { ...input, content }),
    );

    expect(rejected.status).toBe(400);
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(262145).fill(32));
    },
    cancel() {
      cancelled = true;
    },
  });
  const requestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    duplex: "half" as const,
  };
  const request = new NextRequest(
    "http://localhost/api/knowledge/sources",
    requestInit,
  );
  const oversized = await captureSource(request);

  expect(oversized.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(await oversized.json()).toMatchObject({
    code: "CONFIG",
    details: { reason: "knowledge_body_too_large" },
  });
  const invalidEncoding = new NextRequest(
    "http://localhost/api/knowledge/sources",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new Uint8Array([255, 254]),
    },
  );

  expect((await captureSource(invalidEncoding)).status).toBe(400);
  session = null;
  expect((await readRecord(randomUUID())).status).toBe(401);
});

it("IT-CBK-06 search applies current source access before keyset limits and binds visible cursors to credential and filters", async () => {
  vi.stubEnv("AUTH_SECRET", "native-knowledge-pagination-test-secret");
  const project = await seedProjectRow(database.db);
  const tag = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const principal = { kind: "user" as const, userId: readerId };

  for (let index = 0; index < ids.length; index++) {
    await database.pool.query(
      "INSERT INTO brain_items(id,company_id,kind,title,content,content_hash,confidence,source_restrictions,created_at) VALUES($1,$2,'assertion',$3,$4,$5,0.99,$6::jsonb,$7)",
      [
        ids[index],
        companyId,
        `${tag} ${index}`,
        `assertion ${index}`,
        randomUUID(),
        JSON.stringify(
          index === 0 ? [{ kind: "project", projectId: project.id }] : [],
        ),
        `2026-01-0${index + 1}T00:00:00.000000Z`,
      ],
    );
  }
  const input = knowledgeSearchSchema.parse({ q: tag, limit: 1 });
  const firstResponse = await searchRecords(
    new NextRequest(`http://localhost/api/knowledge?q=${tag}&limit=1`),
  );

  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as Awaited<
    ReturnType<typeof searchKnowledge>
  >;

  assertContract("CBKnowledgePage", first);
  expect(first.items.map((item) => item.id)).toEqual([ids[3]]);
  expect(first.items[0]).toMatchObject({
    confirmationState: "unconfirmed",
    freshnessState: "unknown",
    assertionPreview: "assertion 3",
  });
  expect(first.nextCursor).not.toBeNull();
  const filtered = await searchKnowledge(database.db, principal, {
    ...input,
    kind: "assertion",
    confirmation: "unconfirmed",
    freshness: "unknown",
    limit: 50,
  });

  expect(filtered.items.map((item) => item.id)).toEqual([
    ids[3],
    ids[2],
    ids[1],
  ]);
  expect(
    (
      await searchKnowledge(database.db, principal, {
        ...input,
        conflict: "unresolved",
      })
    ).items,
  ).toEqual([]);
  for (const query of [
    "limit=1&limit=2",
    "ownerKind=company",
    "limit=1.0",
    "unknown=value",
    "q=%00",
  ]) {
    expect(
      (
        await searchRecords(
          new NextRequest(`http://localhost/api/knowledge?${query}`),
        )
      ).status,
    ).toBe(400);
  }
  expect(
    Buffer.from(first.nextCursor!.split(".")[0], "base64url").toString(),
  ).not.toContain(ids[0]);
  await database.pool.query(
    "UPDATE brain_items SET updated_at=now() WHERE id=$1",
    [ids[1]],
  );
  const second = await searchKnowledge(database.db, principal, {
    ...input,
    cursor: first.nextCursor!,
  });

  expect(second.items.map((item) => item.id)).toEqual([ids[2]]);
  const third = await searchKnowledge(database.db, principal, {
    ...input,
    cursor: second.nextCursor!,
  });

  expect(third.items.map((item) => item.id)).toEqual([ids[1]]);
  expect(third.nextCursor).toBeNull();
  for (const cursor of [
    first.nextCursor!.slice(0, -1) + "!",
    first.nextCursor!,
  ]) {
    await expect(
      searchKnowledge(database.db, principal, {
        ...input,
        q: "different-filter",
        cursor,
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
  }
  await database.pool.query(
    "UPDATE company_grants SET revoked_at=now(),revision=revision+1 WHERE company_id=$1 AND principal_id=$2 AND action='knowledge:read'",
    [companyId, readerId],
  );
  await expect(
    searchKnowledge(database.db, principal, {
      ...input,
      cursor: first.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  expect((await searchKnowledge(database.db, principal, input)).items).toEqual(
    [],
  );
  vi.unstubAllEnvs();
});

it("IT-CBE-01 evidence pagination retains captured Unicode bytes, enforces response bounds and pins the exact accepted revision", async () => {
  vi.stubEnv("AUTH_SECRET", "native-knowledge-evidence-test-secret");
  const principal = { kind: "user" as const, userId: readerId };
  const owner = { kind: "company" as const, companyId };
  const captures: KnowledgeWitnessDto[] = [];

  for (let index = 0; index < 18; index++) {
    const captured = await captureKnowledgeSource(database.db, principal, {
      owner,
      title: `Capture ${index}`,
      content: `source-${index} ` + "🧠Ж".repeat(2000),
      idempotencyKey: `${readerId}_evidence_${index}`,
    });

    expect(
      Buffer.byteLength(captured.witness.excerpt!, "utf8"),
    ).toBeLessThanOrEqual(8192);
    expect(captured.witness.excerptTruncated).toBe(true);
    expect(captured.witness.excerpt!.isWellFormed()).toBe(true);
    captures.push(captured.witness);
  }
  const proposal = await createBrainProposal(database.db, {
    kind: "knowledge_add",
    owner,
    principal,
    idempotencyKey: `${readerId}_many_proofs`,
    draft: {
      title: "Many bounded sources",
      kind: "assertion",
      assertion: "Retain all original supporting captures",
      basis: "inferred",
      evidence: captures.map((witness) => ({
        relation: "supports" as const,
        reference: {
          kind: "witness" as const,
          id: witness.id,
          sha256: witness.sha256!,
          version: witness.sourceVersion!,
        },
      })),
      missingEvidence: [],
      limitations: [],
    },
  });
  const accepted = await reviewKnowledgeProposal(database.db, {
    proposalId: proposal.id,
    principal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Inspect bounded proof",
    idempotencyKey: `${readerId}_accept_proofs`,
  });
  const selector = { recordId: accepted.acceptedRecordId! };
  const firstResponse = await readEvidence(
    new NextRequest(
      `http://localhost/api/knowledge/${selector.recordId}/evidence?limit=50`,
    ),
    { params: Promise.resolve(selector) },
  );

  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as Awaited<
    ReturnType<typeof getKnowledgeEvidencePage>
  >;

  assertContract("CBRecordEvidencePage", first);
  expect(first.items.length).toBeGreaterThan(0);
  expect(first.items.length).toBeLessThan(18);
  expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(
    131072,
  );
  expect(first.nextCursor).not.toBeNull();
  const second = await getKnowledgeEvidencePage(
    database.db,
    principal,
    selector,
    { limit: 50, cursor: first.nextCursor! },
  );

  assertContract("CBRecordEvidencePage", second);
  const retained = [...first.items, ...second.items].flatMap((item) =>
    "witness" in item ? [item.witness.id] : [],
  );

  expect(retained.sort()).toEqual(captures.map((witness) => witness.id).sort());
  expect(second.nextCursor).toBeNull();
  await expect(
    getKnowledgeEvidencePage(
      database.db,
      principal,
      { ...selector, revision: 2 },
      { limit: 50, cursor: first.nextCursor! },
    ),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await expect(
    getKnowledgeEvidencePage(database.db, principal, selector, {
      limit: 1,
      cursor: first.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  vi.unstubAllEnvs();
});

it("IT-CBE-03 accessible conflicts remain discoverable beyond inaccessible edges and the detail display bound", async () => {
  vi.stubEnv("AUTH_SECRET", "native-knowledge-conflict-test-secret");
  const project = await seedProjectRow(database.db);
  const root = randomUUID();
  const tag = randomUUID();
  const principal = { kind: "user" as const, userId: readerId };

  await database.pool.query(
    "INSERT INTO brain_items(id,company_id,kind,title,content,content_hash,confidence) VALUES($1,$2,'assertion','Root claim',$3,$4,0.9)",
    [root, companyId, tag, randomUUID()],
  );
  const records = Array.from({ length: 145 }, (_, index) => ({
    id: `${tag}_${index.toString().padStart(3, "0")}`,
    restrictions:
      index < 65 ? [{ kind: "project", projectId: project.id }] : [],
  }));

  await database.pool.query(
    "INSERT INTO brain_items(id,company_id,kind,title,content,content_hash,confidence,source_restrictions) SELECT x.id,$1,'assertion','Separate conflicting claim',x.id,x.id,0.3,x.restrictions FROM jsonb_to_recordset($2::jsonb) x(id text,restrictions jsonb)",
    [companyId, JSON.stringify(records)],
  );
  await database.pool.query(
    "INSERT INTO brain_edges(id,company_id,from_ref,to_ref,relation,confidence,claim_state,from_revision,to_revision,claim_actor) SELECT x.id,$1,jsonb_build_object('type','item','id',$2::text),jsonb_build_object('type','item','id',x.id),'contradicts',0.3,'declared_conflict',1,1,jsonb_build_object('kind','user','id',$3::text) FROM jsonb_to_recordset($4::jsonb) x(id text)",
    [companyId, root, readerId, JSON.stringify(records)],
  );
  const response = await readRecord(root);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.conflict).toMatchObject({ state: "limited", incomplete: true });
  expect(body.conflict.accessibleRecordIds).toHaveLength(64);
  expect(
    body.conflict.accessibleRecordIds.every((id: string) =>
      records.slice(65).some((record) => record.id === id),
    ),
  ).toBe(true);
  const firstResponse = await readConflicts(
    new NextRequest(
      `http://localhost/api/knowledge/${root}/conflicts?limit=50`,
    ),
    { params: Promise.resolve({ recordId: root }) },
  );

  expect(firstResponse.status).toBe(200);
  const first = (await firstResponse.json()) as Awaited<
    ReturnType<typeof getKnowledgeConflictsPage>
  >;

  assertContract("CBKnowledgeConflictPage", first);
  const second = await getKnowledgeConflictsPage(
    database.db,
    principal,
    { recordId: root },
    { limit: 50, cursor: first.nextCursor! },
  );

  expect(first.items).toHaveLength(50);
  expect(second.items).toHaveLength(30);
  expect(second.nextCursor).toBeNull();
  expect(
    [...first.items, ...second.items].map((item) => item.reference.id).sort(),
  ).toEqual(
    records
      .slice(65)
      .map((record) => record.id)
      .sort(),
  );
  expect(first.items[0]).toMatchObject({
    classification: "declared_conflict",
    reference: { kind: "knowledge", revision: 1 },
  });
  vi.unstubAllEnvs();
});

it("IT-CBK-06 owner-aware bearer requests use real token verification and audit company operations without a fabricated project", async () => {
  const issued = await issueUserAccessToken(
    {
      ownerUserId: readerId,
      name: "Knowledge facade",
      scopes: normalizeTokenScopes(["knowledge:read", "knowledge:propose"]),
    },
    database.db,
  );
  const headers = {
    Authorization: `Bearer ${issued.secret}`,
    "Content-Type": "application/json",
  };
  const content = "Проверить настроенный компонент 🧠";
  const captured = await extCapture(
    new NextRequest("http://localhost/api/v1/ext/knowledge/sources", {
      method: "POST",
      headers,
      body: JSON.stringify({
        owner: { kind: "company", companyId },
        title: "Authorized company capture",
        content,
        idempotencyKey: `${readerId}_bearer_source`,
      }),
    }),
  );

  expect(captured.status).toBe(201);
  const witness = await captured.json();

  assertContract("CBEvidenceWitness", witness);
  expect(witness).toMatchObject({
    excerpt: content,
    attribution: { kind: "user", id: readerId, runId: null, attemptId: null },
  });
  const tag = randomUUID();
  const recordId = randomUUID();

  await database.pool.query(
    "INSERT INTO brain_items(id,company_id,kind,title,content,content_hash,confidence) VALUES($1,$2,'assertion','Company assertion',$3,$4,0.3)",
    [recordId, companyId, tag, randomUUID()],
  );
  const found = await extSearch(
    new NextRequest(`http://localhost/api/v1/ext/knowledge?q=${tag}`, {
      headers,
    }),
  );

  expect(found.status).toBe(200);
  expect(
    (await found.json()).items.map((item: { id: string }) => item.id),
  ).toEqual([recordId]);
  const detail = await extRecord(
    new NextRequest(`http://localhost/api/v1/ext/knowledge/${recordId}`, {
      headers,
    }),
    { params: Promise.resolve({ recordId }) },
  );

  expect(detail.status).toBe(200);
  assertContract("CBKnowledgeRecord", await detail.json());
  const audits = (
    await database.pool.query(
      "SELECT project_id,result,status_code FROM token_audit_log WHERE token_id=$1 ORDER BY created_at",
      [issued.tokenId],
    )
  ).rows;

  expect(audits).toHaveLength(3);
  expect(
    audits.every((row) => row.project_id === null && row.result === "ok"),
  ).toBe(true);
  const tokenProject = await seedProjectRow(database.db);
  const projectCredential = await issueToken(
    {
      tokenKind: "user",
      ownerUserId: readerId,
      projectId: tokenProject.id,
      name: "Project-limited knowledge",
      scopes: normalizeTokenScopes(["knowledge:read"]),
    },
    database.db,
  );
  const outsideTokenOwner = await extRecord(
    new NextRequest(`http://localhost/api/v1/ext/knowledge/${recordId}`, {
      headers: { Authorization: `Bearer ${projectCredential.secret}` },
    }),
    { params: Promise.resolve({ recordId }) },
  );

  expect(outsideTokenOwner.status).toBe(404);
  const secondCredential = await issueUserAccessToken(
    {
      ownerUserId: readerId,
      name: "Read only",
      scopes: normalizeTokenScopes(["knowledge:read"]),
    },
    database.db,
  );
  const refused = await extCapture(
    new NextRequest("http://localhost/api/v1/ext/knowledge/sources", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secondCredential.secret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  );

  expect(refused.status).toBe(403);
  await database.pool.query(
    "UPDATE project_tokens SET revoked_at=now() WHERE id=$1",
    [issued.tokenId],
  );
  expect(
    (
      await extSearch(
        new NextRequest("http://localhost/api/v1/ext/knowledge", { headers }),
      )
    ).status,
  ).toBe(401);
  expect(
    (await extSearch(new NextRequest("http://localhost/api/v1/ext/knowledge")))
      .status,
  ).toBe(401);
});

it("IT-CBX-02 the built MCP publishes nested native schemas and calls the real HTTP and PostgreSQL services", async () => {
  const issued = await issueUserAccessToken(
    {
      ownerUserId: readerId,
      name: "Built MCP qualification",
      scopes: normalizeTokenScopes([
        "knowledge:read",
        "knowledge:propose",
        "knowledge:review",
        "knowledge:confirm",
      ]),
    },
    database.db,
  );

  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'user',$2,'knowledge:confirm',$2)",
    [companyId, readerId],
  );
  const recordId = randomUUID();
  const query = randomUUID();

  await database.pool.query(
    "INSERT INTO brain_items(id,company_id,kind,title,content,content_hash,confidence) VALUES($1,$2,'assertion','MCP retained record',$3,$4,0.3)",
    [recordId, companyId, query, randomUUID()],
  );
  const received: string[] = [];
  const failures: unknown[] = [];
  const http = createServer((incoming, outgoing) => {
    void (async () => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const chunks: Buffer[] = [];

      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = new NextRequest(url, {
        method: incoming.method,
        headers: {
          Authorization: incoming.headers.authorization ?? "",
          "Content-Type":
            incoming.headers["content-type"] ?? "application/json",
        },
        ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      });

      received.push(`${incoming.method} ${url.pathname}`);
      const segments = url.pathname.split("/");
      const selectedId = segments[5];
      let response: Response;

      if (url.pathname === "/api/v1/ext/knowledge/sources")
        response = await extCapture(request);
      else if (url.pathname === "/api/v1/ext/knowledge")
        response = await extSearch(request);
      else if (url.pathname === "/api/v1/ext/knowledge/proposals")
        response =
          incoming.method === "POST"
            ? await extPropose(request)
            : await extProposals(request);
      else if (selectedId === "proposals") {
        const params = { params: Promise.resolve({ proposalId: segments[6] }) };

        response =
          segments[7] === "decision"
            ? await extDecide(request, params)
            : await extProposal(request, params);
      } else if (selectedId === "witnesses")
        response = await extWitness(request, {
          params: Promise.resolve({ witnessId: segments[6] }),
        });
      else {
        const params = { params: Promise.resolve({ recordId: selectedId }) };

        if (segments[6] === "evidence")
          response = await extEvidence(request, params);
        else if (segments[6] === "conflicts")
          response = await extConflicts(request, params);
        else if (segments[6] === "confirmations") {
          response = await extConfirm(request, params);
          if (response.ok)
            await database.pool.query(
              "UPDATE company_grants SET revoked_at=now(),revision=revision+1 WHERE company_id=$1 AND principal_id=$2 AND action='knowledge:confirm' AND revoked_at IS NULL",
              [companyId, readerId],
            );
          else
            await database.pool.query(
              "UPDATE company_grants SET revoked_at=now(),revision=revision+1 WHERE company_id=$1 AND principal_id=$2 AND action='knowledge:read' AND revoked_at IS NULL",
              [companyId, readerId],
            );
        } else response = await extRecord(request, params);
      }

      outgoing.writeHead(
        response.status,
        Object.fromEntries(response.headers.entries()),
      );
      outgoing.end(await response.text());
    })().catch((error: unknown) => {
      failures.push(error);
      outgoing.writeHead(500);
      outgoing.end("Qualification route failed");
    });
  });

  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();

  if (address === null || typeof address === "string")
    throw new Error("Native MCP qualification requires an owned TCP listener");
  const directory = await mkdtemp(path.join(tmpdir(), "maister-native-mcp-"));
  const invocation =
    invocationFromEnvironment() ?? (await createInvocation(directory));
  const child = spawn(
    process.execPath,
    ["test/fixtures/knowledge-client.mjs"],
    {
      cwd: path.resolve("../mcp"),
      detached: true,
      env: {
        ...process.env,
        ...(await fixtureProcessEnvironment(invocation)),
        NODE_ENV: "production",
        LOG_LEVEL: "silent",
        MAISTER_API_BASE_URL: `http://127.0.0.1:${address.port}`,
        MAISTER_ACCESS_TOKEN: issued.secret,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const closed = once(child, "close");
  let output = "";
  let diagnostics = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    diagnostics = (diagnostics + chunk).slice(-8192);
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(
      () =>
        reject(
          new Error(
            "Built native MCP qualification exceeded its process deadline",
          ),
        ),
      20000,
    );
  });

  try {
    await registerSpawnedProcess(
      invocation,
      {
        role: "fixture",
        caseName: "IT-CBX-02 built native MCP",
        rootRole: "test-support",
        root: null,
        bootId: invocation.id,
        logFile: null,
      },
      child,
    );
    const content = "Проверить здоровье компонента 🧠";

    child.stdin.end(
      JSON.stringify({
        companyId,
        recordId,
        query,
        content,
        key: `${readerId}_built_wire`,
      }),
    );
    const [code] = await Promise.race([closed, timedOut]);

    expect(code, diagnostics).toBe(0);
    const result = JSON.parse(output) as {
      workflow: Record<
        string,
        { isError?: boolean; content: { text: string }[] }
      >;
      tools: { name: string; inputSchema: unknown }[];
      capture: { isError?: boolean; content: { text: string }[] };
      record: { isError?: boolean; content: { text: string }[] };
      search: { isError?: boolean; content: { text: string }[] };
      evidence: { isError?: boolean; content: { text: string }[] };
      conflicts: { isError?: boolean; content: { text: string }[] };
      malformed: { isError?: boolean; content: { text: string }[] }[];
    };

    expect(result.tools.map((tool) => tool.name).sort()).toEqual(
      Object.keys(knowledgeToolSchemas).sort(),
    );
    for (const tool of result.tools)
      expect(tool.inputSchema).toEqual(
        knowledgeToolSchemas[tool.name as keyof typeof knowledgeToolSchemas],
      );
    expect(result.capture.isError).not.toBe(true);
    expect(JSON.parse(result.capture.content[0].text)).toMatchObject({
      excerpt: content,
      attribution: { kind: "user", id: readerId },
    });
    expect(JSON.parse(result.record.content[0].text)).toMatchObject({
      id: recordId,
      basis: "unknown",
      confirmation: { state: "unconfirmed" },
    });
    expect(
      JSON.parse(result.search.content[0].text).items.map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual([recordId]);
    expect(JSON.parse(result.evidence.content[0].text)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(JSON.parse(result.conflicts.content[0].text)).toEqual({
      items: [],
      nextCursor: null,
    });
    const workflow = Object.fromEntries(
      Object.entries(result.workflow).map(([name, response]) => [
        name,
        JSON.parse(response.content[0].text),
      ]),
    );

    for (const [name, response] of Object.entries(result.workflow)) {
      if (!["revokedReplay", "revokedRecord", "revokedWitness"].includes(name))
        expect(response.isError, JSON.stringify({ name, response })).not.toBe(
          true,
        );
    }
    assertContract("CBEvidenceWitness", workflow.witness);
    assertContract("CBKnowledgeProposal", workflow.pending);
    assertContract("CBKnowledgeProposalPage", workflow.queue);
    assertContract("CBKnowledgeProposal", workflow.published);
    expect(workflow.pending).toMatchObject({
      status: "pending",
      attribution: { kind: "user", id: readerId },
    });
    expect(
      workflow.queue.items.map((item: { id: string }) => item.id),
    ).toContain(workflow.pending.id);
    expect(workflow.accepted).toMatchObject({
      status: "accepted",
      revision: 2,
      duplicate: false,
    });
    expect(workflow.replayed).toMatchObject({
      id: workflow.pending.id,
      duplicate: true,
    });
    expect(workflow.unconfirmed).toMatchObject({
      confirmation: { state: "unconfirmed" },
    });
    expect(workflow.confirmation).toMatchObject({ status: "confirmed" });
    expect(workflow.confirmed).toMatchObject({
      confirmation: { state: "confirmed", witnessIds: [workflow.witness.id] },
    });
    expect(result.workflow.revokedReplay.isError).toBe(true);
    expect(workflow.revokedReplay).toMatchObject({ code: "UNAUTHORIZED" });
    for (const name of ["revokedRecord", "revokedWitness"]) {
      expect(result.workflow[name].isError).toBe(true);
      expect(workflow[name]).toMatchObject({
        code: "PRECONDITION",
        details: { reason: "knowledge_reference_unavailable" },
      });
    }
    assertContract("CBKnowledgePage", workflow.revokedSearch);
    expect(workflow.revokedSearch).toEqual({ items: [], nextCursor: null });
    expect(result.malformed).toHaveLength(8);
    for (const invalid of result.malformed) {
      expect(invalid.isError).toBe(true);
      expect(JSON.parse(invalid.content[0].text)).toMatchObject({
        code: "CONFIG",
        details: { reason: "knowledge_tool_input_invalid" },
      });
    }
    expect(received).toHaveLength(19);
    expect(failures).toEqual([]);
  } finally {
    clearTimeout(deadline);
    if (child.pid !== undefined)
      await signalInvocationGroup(invocation, child.pid, "SIGKILL");
    await closed;
    if (child.pid !== undefined)
      await assertInvocationGroupEmpty(invocation, child.pid);
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("IT-CBE-06 run-bound native reads bind current grants to the immutable role/package identity and retain disclosure restrictions", async () => {
  const project = await seedProjectRow(database.db);
  const installationId = randomUUID();
  const packageName = `native-${installationId}`;
  const agentId = `${packageName}:researcher`;
  const otherAgentId = `${packageName}:other`;

  await database.pool.query(
    "UPDATE projects SET brain_enabled=true WHERE id=$1",
    [project.id],
  );
  await database.pool.query(
    "INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status) VALUES($1,'github.com/fixture/native',$2,'v1.0.0','pinned-revision','{}','digest','/tmp/native-role-policy','Installed','trusted')",
    [installationId, packageName],
  );
  await database.pool.query(
    "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) VALUES($1,$2,$3,$4)",
    [randomUUID(), project.id, installationId, packageName],
  );
  for (const role of [agentId, otherAgentId]) {
    await database.pool.query(
      "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) VALUES($1,$2,'v1.0.0','git','Researcher','Native policy fixture','none','session','[\"manual\"]','read_only','/tmp/native-role-policy/maister-agents/researcher.md')",
      [role, packageName],
    );
    await database.pool.query(
      "INSERT INTO agent_project_links(id,project_id,agent_id,enabled,can_read_brain) VALUES($1,$2,$3,true,true)",
      [randomUUID(), project.id, role],
    );
    await database.pool.query(
      "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'agent',$2,'knowledge:read',$3)",
      [companyId, role, readerId],
    );
  }
  const runId = await seedRun(database.db, {
    projectId: project.id,
    status: "Running",
  });
  const snapshot = {
    version: 1,
    agentId,
    displayName: "Researcher",
    definitionSha256: "a".repeat(64),
    packageInstallId: installationId,
    packageName,
    packageVersion: "v1.0.0",
    packageRevision: "pinned-revision",
  };

  await database.pool.query(
    "UPDATE runs SET run_kind='agent',agent_id=$2,source_agent_id=$2,launched_at=now(),activity_sort_at=now(),activity_timestamp_provenance='launch',agent_activity_snapshot=$3::jsonb,knowledge_access=$4::jsonb WHERE id=$1",
    [
      runId,
      agentId,
      JSON.stringify(snapshot),
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [],
      }),
    ],
  );
  const token = await issueAgentRunToken({
    agentId,
    projectId: project.id,
    runId,
    db: database.db,
  });
  const recordId = randomUUID();

  await database.pool.query(
    "INSERT INTO brain_items(id,company_id,kind,title,content,content_hash,confidence) VALUES($1,$2,'assertion','Granted company claim','Company-owned source content',$3,0.3)",
    [recordId, companyId, randomUUID()],
  );
  const read = (): Promise<Response> =>
    extRecord(
      new NextRequest(`http://localhost/api/v1/ext/knowledge/${recordId}`, {
        headers: { Authorization: `Bearer ${token.secret}` },
      }),
      { params: Promise.resolve({ recordId }) },
    );

  expect((await read()).status).toBe(200);
  const capture = (
    await database.pool.query("SELECT knowledge_access FROM runs WHERE id=$1", [
      runId,
    ])
  ).rows[0].knowledge_access;

  expect(capture).toMatchObject({
    state: "complete",
    generation: 2,
    restrictions: expect.arrayContaining([
      { kind: "record", recordId },
      { kind: "company", companyId },
    ]),
  });
  const projectFindingId = randomUUID();

  await database.pool.query(
    "INSERT INTO brain_items(id,project_id,kind,title,content,content_hash,confidence) VALUES($1,$2,'observation','Project-restricted diagnostic','A private diagnostic detail',$3,0.3)",
    [projectFindingId, project.id, randomUUID()],
  );
  const projectRead = await extRecord(
    new NextRequest(
      `http://localhost/api/v1/ext/knowledge/${projectFindingId}`,
      { headers: { Authorization: `Bearer ${token.secret}` } },
    ),
    { params: Promise.resolve({ recordId: projectFindingId }) },
  );

  expect(projectRead.status).toBe(200);
  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'agent',$2,'knowledge:propose',$3)",
    [companyId, agentId, readerId],
  );
  const proposed = await createBrainProposal(database.db, {
    kind: "knowledge_add",
    owner: { kind: "company", companyId },
    principal: { kind: "token", tokenId: token.tokenId },
    idempotencyKey: `${runId}_without_citations`,
    draft: {
      title: "Derived diagnostic without quoted citations",
      kind: "observation",
      assertion: "A conclusion made after private project reads",
      basis: "inferred",
      evidence: [],
      missingEvidence: [
        {
          state: "absent",
          reason: "The submitted finding supplies no explicit source citation.",
        },
      ],
      limitations: [],
    },
  });
  const inherited = (
    await database.pool.query(
      "SELECT source_restrictions,knowledge_attribution FROM brain_proposals WHERE id=$1",
      [proposed.id],
    )
  ).rows[0];

  expect(inherited.source_restrictions).toEqual(
    expect.arrayContaining([
      { kind: "project", projectId: project.id },
      { kind: "record", recordId: projectFindingId },
    ]),
  );
  expect(inherited.knowledge_attribution).toMatchObject({
    kind: "agent",
    id: agentId,
    runId,
  });
  await expect(
    reviewKnowledgeProposal(database.db, {
      proposalId: proposed.id,
      principal: { kind: "user", userId: readerId },
      expectedRevision: 1,
      decision: "accept",
      reason: "Cannot widen private diagnostic visibility",
      idempotencyKey: `${runId}_withheld_review`,
    }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_reference_unavailable" },
  });
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'owner')",
    [randomUUID(), project.id, readerId],
  );
  const publication = await reviewKnowledgeProposal(database.db, {
    proposalId: proposed.id,
    principal: { kind: "user", userId: readerId },
    expectedRevision: 1,
    decision: "accept",
    reason: "Publish with the retained private-source restrictions",
    idempotencyKey: `${runId}_authorized_review`,
  });

  expect(
    (
      await database.pool.query(
        "SELECT source_restrictions FROM brain_items WHERE id=$1",
        [publication.acceptedRecordId],
      )
    ).rows[0].source_restrictions,
  ).toEqual(inherited.source_restrictions);
  await database.pool.query(
    "UPDATE project_tokens SET agent_id=$2 WHERE id=$1",
    [token.tokenId, otherAgentId],
  );
  expect((await read()).status).toBe(403);
  await database.pool.query(
    "UPDATE project_tokens SET agent_id=$2 WHERE id=$1",
    [token.tokenId, agentId],
  );
  await database.pool.query(
    "UPDATE package_installs SET trust_status='untrusted' WHERE id=$1",
    [installationId],
  );
  expect((await read()).status).toBe(403);
  await database.pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
  expect(
    (
      await database.pool.query("SELECT id FROM brain_items WHERE id=$1", [
        publication.acceptedRecordId,
      ])
    ).rows,
  ).toEqual([{ id: publication.acceptedRecordId }]);
  expect(
    (
      await database.pool.query(
        "SELECT run_id,knowledge_attribution FROM brain_proposals WHERE id=$1",
        [proposed.id],
      )
    ).rows[0],
  ).toMatchObject({
    run_id: null,
    knowledge_attribution: { kind: "agent", id: agentId, runId },
  });
});

it("IT-CBE-01 record references pin exact evidence, reuse one capture and retain declared opposition across corrections", async () => {
  vi.stubEnv("AUTH_SECRET", "native-record-proposal-cursor-test-secret");
  const principal = { kind: "user" as const, userId: readerId };
  const owner = { kind: "company" as const, companyId };
  const draft = {
    title: "Referenced assertion",
    kind: "assertion" as const,
    assertion: `Configured component ${readerId} requires a separate health check`,
    basis: "inferred" as const,
    evidence: [],
    missingEvidence: [
      { state: "absent" as const, reason: "No live stand observation" },
    ],
    limitations: [],
  };

  async function publish(
    input: CreateKnowledgeProposalInput,
  ): Promise<KnowledgeProposalReceipt> {
    const proposal = await createBrainProposal(database.db, input);

    return reviewKnowledgeProposal(database.db, {
      proposalId: proposal.id,
      principal,
      expectedRevision: 1,
      decision: "accept",
      reason: "Publish reviewed evidence relationship",
      idempotencyKey: `${proposal.id}_review`,
    });
  }
  const original = await publish({
    owner,
    principal,
    kind: "knowledge_add",
    draft,
    idempotencyKey: `${readerId}_original`,
  });
  const reference = {
    kind: "knowledge" as const,
    id: original.acceptedRecordId!,
    revision: 1,
    version: "1",
    sha256: sha256(draft.assertion),
  };
  const derivedInput = {
    owner,
    principal,
    kind: "knowledge_add" as const,
    draft: {
      ...draft,
      title: "Derived assertion",
      assertion: `Derived ${readerId}`,
      evidence: [{ relation: "derived_from" as const, reference }],
    },
    idempotencyKey: `${readerId}_derived`,
  };

  for (const invalid of [
    { ...reference, revision: undefined },
    { ...reference, revision: 999 },
    { ...reference, version: "2" },
    { ...reference, sha256: "f".repeat(64) },
  ]) {
    await expect(
      createBrainProposal(database.db, {
        ...derivedInput,
        idempotencyKey: randomUUID(),
        draft: {
          ...derivedInput.draft,
          evidence: [{ relation: "derived_from", reference: invalid }],
        },
      }),
    ).rejects.toMatchObject({
      code:
        invalid.revision === undefined
          ? "CONFIG"
          : invalid.revision === 999
            ? "PRECONDITION"
            : "CONFLICT",
    });
  }
  const proposals = await Promise.all(
    [0, 1].map((index) =>
      createBrainProposal(database.db, {
        ...derivedInput,
        idempotencyKey: `${readerId}_copy_${index}`,
      }),
    ),
  );

  expect(proposals[0]!.id).toBe(proposals[1]!.id);
  const capturesBefore = await database.pool.query(
    "SELECT count(*)::int AS n FROM brain_evidence_witnesses",
  );
  const pending = await getProposal(
    new NextRequest(
      `http://localhost/api/knowledge/proposals/${proposals[0]!.id}`,
    ),
    {
      params: Promise.resolve({ proposalId: proposals[0]!.id }),
    },
  );

  expect(pending.status).toBe(200);
  assertContract("CBKnowledgeProposal", await pending.json());
  const page = await listKnowledgeProposals(database.db, principal, {
    owner,
    status: "pending",
    limit: 50,
  });

  expect(page.items.some((item) => item.id === proposals[0]!.id)).toBe(true);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM brain_evidence_witnesses",
      )
    ).rows,
  ).toEqual(capturesBefore.rows);

  const derived = await publish(derivedInput);
  const proof = await getKnowledgeEvidencePage(
    database.db,
    principal,
    { recordId: derived.acceptedRecordId!, revision: 1 },
    { limit: 10 },
  );
  const item = proof.items[0]!;

  expect(proof.items).toHaveLength(1);
  if (!("witness" in item)) throw new Error("Expected exact record witness");
  expect(item.witness).toMatchObject({
    sourceVersion: "1",
    sha256: reference.sha256,
    excerpt: draft.assertion,
    availability: "available",
    independenceGroupId: null,
    observedAt: null,
    sourceAt: null,
    attribution: { kind: "user", id: readerId },
  });
  const otherId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [otherId, `${otherId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) SELECT $1,'user',$2,action,$3 FROM unnest(ARRAY['knowledge:read','knowledge:propose']) action",
    [companyId, otherId, readerId],
  );
  const opposingInput: CreateKnowledgeProposalInput = {
    ...derivedInput,
    principal: { kind: "user", userId: otherId },
    idempotencyKey: `${readerId}_opposite`,
    draft: {
      ...draft,
      title: "Opposing assertion",
      assertion: `Opposing ${readerId}`,
      evidence: [
        { relation: "contradicts", reference },
        {
          relation: "contradicts",
          reference: { kind: "knowledge", id: reference.id, revision: 1 },
        },
      ],
    },
  };
  const opposingWitness = await publish({
    ...opposingInput,
    idempotencyKey: `${readerId}_opposite_witness`,
    draft: {
      ...opposingInput.draft,
      evidence: [
        {
          relation: "contradicts",
          reference: { kind: "witness", id: item.witness.id },
        },
      ],
    },
  });
  const opposite = await publish(opposingInput);

  expect(opposite.acceptedRecordId).toBe(opposingWitness.acceptedRecordId);
  const originalBody = await (await readRecord(reference.id)).json();

  expect(originalBody.conflict).toMatchObject({
    state: "unresolved",
    accessibleRecordIds: [opposite.acceptedRecordId],
  });
  expect(originalBody.confirmation.state).toBe("unconfirmed");
  expect(
    (
      await database.pool.query(
        "SELECT w.id FROM brain_evidence_witnesses w JOIN brain_evidence_observations o ON o.id=w.observation_id WHERE w.capture_locator->>'recordId'=$1",
        [reference.id],
      )
    ).rows,
  ).toEqual([{ id: item.witness.id }]);
  await publish({
    owner,
    principal,
    kind: "knowledge_correct",
    targetRecordId: reference.id,
    expectedRecordRevision: 1,
    idempotencyKey: `${readerId}_correct`,
    draft: { ...draft, assertion: `Corrected ${readerId}` },
  });
  const retained = await getKnowledgeEvidencePage(
    database.db,
    principal,
    { recordId: derived.acceptedRecordId!, revision: 1 },
    { limit: 10 },
  );

  expect(retained.items[0]).toMatchObject({
    witness: {
      id: item.witness.id,
      excerpt: draft.assertion,
      availability: "stale",
      sha256: reference.sha256,
    },
  });
  const historicalConflicts = await getKnowledgeConflictsPage(
    database.db,
    principal,
    { recordId: reference.id, revision: 1 },
    { limit: 10 },
  );

  expect(historicalConflicts.items).toMatchObject([
    {
      classification: "declared_conflict",
      reference: { id: opposite.acceptedRecordId, revision: 1 },
    },
  ]);
  await database.pool.query(
    "UPDATE brain_items SET visibility='restricted' WHERE id=$1",
    [reference.id],
  );
  const hiddenProposal = await getProposal(
    new NextRequest(
      `http://localhost/api/knowledge/proposals/${proposals[0]!.id}`,
    ),
    {
      params: Promise.resolve({ proposalId: proposals[0]!.id }),
    },
  );

  expect(hiddenProposal.status).toBe(404);
  const visible = await listKnowledgeProposals(database.db, principal, {
    owner,
    limit: 50,
  });

  expect(visible.items.map((item) => item.id)).not.toContain(proposals[0]!.id);
  expect((await readRecord(derived.acceptedRecordId!)).status).toBe(404);
  await expect(
    createBrainProposal(database.db, {
      ...derivedInput,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_reference_unavailable" },
  });
  vi.unstubAllEnvs();
});

it("IT-CBE-06 cross-owner record evidence inherits current source access and never obstructs source-project deletion", async () => {
  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "UPDATE projects SET brain_enabled=true WHERE id=$1",
    [project.id],
  );
  await database.pool.query("UPDATE users SET role='admin' WHERE id=$1", [
    readerId,
  ]);
  const principal = { kind: "user" as const, userId: readerId };
  const captured = await captureKnowledgeSource(database.db, principal, {
    owner: { kind: "project", projectId: project.id },
    title: "Project-restricted source",
    content: "Configured source observation remains restricted to its project",
    idempotencyKey: `${readerId}_project_capture`,
  });
  const sourceProposal = await createBrainProposal(database.db, {
    kind: "knowledge_add",
    owner: { kind: "project", projectId: project.id },
    principal,
    idempotencyKey: `${readerId}_source_record`,
    draft: {
      title: "Source project record",
      kind: "observation",
      assertion: `Source ${readerId}`,
      basis: "observed",
      evidence: [
        {
          relation: "supports",
          reference: { kind: "witness", id: captured.witness.id },
        },
      ],
      missingEvidence: [],
      limitations: [],
    },
  });
  const sourceRecord = await reviewKnowledgeProposal(database.db, {
    proposalId: sourceProposal.id,
    principal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Publish original project evidence",
    idempotencyKey: `${readerId}_source_review`,
  });
  const proposal = await createBrainProposal(database.db, {
    kind: "knowledge_add",
    owner: { kind: "company", companyId },
    principal,
    idempotencyKey: `${readerId}_derived_company`,
    draft: {
      title: "Company-owned derived observation",
      kind: "observation",
      assertion: "A finding derived from project evidence",
      basis: "inferred",
      evidence: [
        {
          relation: "supports",
          reference: {
            kind: "knowledge",
            id: sourceRecord.acceptedRecordId!,
            revision: 1,
          },
        },
      ],
      missingEvidence: [],
      limitations: [],
    },
  });
  const decision = {
    proposalId: proposal.id,
    principal,
    expectedRevision: 1,
    decision: "accept" as const,
    reason: "Publish with inherited source policy",
    idempotencyKey: `${readerId}_publish_derived`,
  };

  await database.pool.query("UPDATE users SET role='member' WHERE id=$1", [
    readerId,
  ]);
  await expect(
    reviewKnowledgeProposal(database.db, decision),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await database.pool.query("UPDATE users SET role='admin' WHERE id=$1", [
    readerId,
  ]);
  const accepted = await reviewKnowledgeProposal(database.db, decision);
  const recordId = accepted.acceptedRecordId!;

  expect((await readRecord(recordId)).status).toBe(200);
  const metadata = (
    await database.pool.query(
      "SELECT i.source_restrictions AS current,r.source_restrictions AS retained FROM brain_items i JOIN brain_record_revisions r ON r.record_id=i.id AND r.revision=i.current_revision WHERE i.id=$1",
      [recordId],
    )
  ).rows[0];

  expect(metadata.current).toEqual(
    expect.arrayContaining([{ kind: "project", projectId: project.id }]),
  );
  expect(metadata.retained).toEqual(metadata.current);
  await database.pool.query("UPDATE users SET role='member' WHERE id=$1", [
    readerId,
  ]);
  expect((await readRecord(recordId)).status).toBe(404);
  expect(
    (
      await searchKnowledge(
        database.db,
        principal,
        knowledgeSearchSchema.parse({ q: "Company-owned derived observation" }),
      )
    ).items,
  ).toEqual([]);
  await database.pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
  expect(
    (
      await database.pool.query("SELECT id FROM brain_items WHERE id=$1", [
        recordId,
      ])
    ).rows,
  ).toEqual([{ id: recordId }]);
  expect(
    (
      await database.pool.query("SELECT id FROM brain_proposals WHERE id=$1", [
        proposal.id,
      ])
    ).rows,
  ).toEqual([{ id: proposal.id }]);
  expect((await readRecord(recordId)).status).toBe(404);
});

it("IT-CBK-03 stale source support cannot establish a new factual confirmation", async () => {
  const principal = { kind: "user" as const, userId: readerId };
  const owner = { kind: "company" as const, companyId };

  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'user',$2,'knowledge:confirm',$2)",
    [companyId, readerId],
  );
  const sourceId = randomUUID();
  const observationId = randomUUID();
  const witnessId = randomUUID();
  const content =
    "The retained configured runbook version permits a bounded restart.";
  const hash = sha256(content);
  const attribution = {
    kind: "user",
    id: readerId,
    runId: null,
    attemptId: null,
  };

  await database.pool.query(
    "INSERT INTO brain_sources(id,company_id,kind,path,title,submitted_content,source_hash,chunker_id,chunker_version) VALUES($1,$2,'text',$3,'Retained legacy runbook',$4,$5,'legacy_submission','1')",
    [sourceId, companyId, `submitted:${sourceId}`, content, hash],
  );
  await database.pool.query(
    "INSERT INTO brain_evidence_observations(id,company_id,source_id,source_version,content_sha256,attribution) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
    [
      observationId,
      companyId,
      sourceId,
      `sha256:${hash}`,
      hash,
      JSON.stringify(attribution),
    ],
  );
  await database.pool.query(
    "INSERT INTO brain_evidence_witnesses(id,observation_id,source_version,content_sha256,selector,restrictions,capture_locator) VALUES($1,$2,$3,$4,'retained:text',$5::jsonb,$6::jsonb)",
    [
      witnessId,
      observationId,
      `sha256:${hash}`,
      hash,
      JSON.stringify([owner]),
      JSON.stringify({ kind: "inline", content }),
    ],
  );
  const proposed = await createBrainProposal(database.db, {
    kind: "knowledge_add",
    owner,
    principal,
    idempotencyKey: `${readerId}_source_version`,
    draft: {
      title: "Version-supported runbook claim",
      assertion: content,
      kind: "procedure",
      basis: "inferred",
      evidence: [
        {
          relation: "supports",
          reference: {
            kind: "witness",
            id: witnessId,
            version: `sha256:${hash}`,
            sha256: hash,
          },
        },
      ],
      missingEvidence: [],
      limitations: [],
    },
  });
  const published = await reviewKnowledgeProposal(database.db, {
    proposalId: proposed.id,
    principal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Publish the version-bound assertion",
    idempotencyKey: `${readerId}_source_accept`,
  });
  const confirmation = {
    recordId: published.acceptedRecordId!,
    principal,
    expectedRevision: 1,
    witnessIds: [witnessId],
    reason: "Confirm against the current retained source version",
    idempotencyKey: `${readerId}_confirm_current`,
    decision: "confirm" as const,
  };

  expect(await confirmKnowledgeRecord(database.db, confirmation)).toMatchObject(
    { status: "confirmed", duplicate: false },
  );
  await confirmKnowledgeRecord(database.db, {
    ...confirmation,
    decision: "revoke",
    witnessIds: [],
    reason: "Reassess source currency",
    idempotencyKey: `${readerId}_revoke_current`,
  });
  await database.pool.query(
    "UPDATE brain_sources SET source_hash=$2 WHERE id=$1",
    [sourceId, sha256("A newer source version")],
  );
  await expect(
    confirmKnowledgeRecord(database.db, {
      ...confirmation,
      idempotencyKey: `${readerId}_confirm_stale`,
    }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_evidence_unavailable" },
  });
  expect((await readRecord(published.acceptedRecordId!)).status).toBe(200);
});

it("IT-CBK-03 native HTTP publication and evidence-bound confirmation are separate current-authority decisions", async () => {
  const owner = { kind: "company", companyId };
  const captured = await captureSource(
    jsonRequest("/api/knowledge/sources", {
      owner,
      title: "HTTP review proof",
      content: "Inspect the configured service and verify independent health.",
      idempotencyKey: `${readerId}_http_review_source`,
    }),
  );
  const witness = (await captured.json()) as KnowledgeWitnessDto;
  const body = {
    idempotencyKey: `${readerId}_http_propose`,
    content: {
      change: "add",
      owner,
      title: "HTTP published procedure",
      kind: "procedure",
      assertion: "Follow the configured health check",
      basis: "inferred",
      evidence: [
        {
          relation: "supports",
          reference: {
            kind: "witness",
            id: witness.id,
            version: witness.sourceVersion,
            sha256: witness.sha256,
          },
        },
      ],
      missingEvidence: [],
      limitations: [],
    },
  };
  const created = await proposeKnowledge(
    jsonRequest("/api/knowledge/proposals", body),
  );

  expect(created.status).toBe(201);
  const proposal = (await created.json()) as { id: string; revision: number };

  assertContract("CBReceipt", proposal);
  const replay = await proposeKnowledge(
    jsonRequest("/api/knowledge/proposals", body),
  );

  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({
    id: proposal.id,
    duplicate: true,
  });
  const proposerToken = await issueUserAccessToken(
    {
      ownerUserId: readerId,
      name: "Own proposal inspection",
      scopes: normalizeTokenScopes(["knowledge:read", "knowledge:propose"]),
    },
    database.db,
  );
  const proposerHeaders = { Authorization: `Bearer ${proposerToken.secret}` };
  const proposerContext = {
    params: Promise.resolve({ proposalId: proposal.id }),
  };

  expect(
    (
      await extProposal(
        new NextRequest(
          `http://localhost/api/v1/ext/knowledge/proposals/${proposal.id}`,
          { headers: proposerHeaders },
        ),
        proposerContext,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await extProposals(
        new NextRequest("http://localhost/api/v1/ext/knowledge/proposals", {
          headers: proposerHeaders,
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await extDecide(
        new NextRequest(
          `http://localhost/api/v1/ext/knowledge/proposals/${proposal.id}/decision`,
          {
            method: "POST",
            headers: proposerHeaders,
            body: JSON.stringify({
              expectedRevision: 1,
              decision: "accept",
              reason: "A proposer cannot grant themselves review",
              idempotencyKey: `${readerId}_forbidden_review`,
            }),
          },
        ),
        proposerContext,
      )
    ).status,
  ).toBe(403);
  const unrelatedId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [unrelatedId, `${unrelatedId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) SELECT $1,'user',$2,action,$2 FROM unnest(ARRAY['knowledge:read','knowledge:propose']) action",
    [companyId, unrelatedId],
  );
  const unrelatedToken = await issueUserAccessToken(
    {
      ownerUserId: unrelatedId,
      name: "Unrelated proposer",
      scopes: normalizeTokenScopes(["knowledge:read", "knowledge:propose"]),
    },
    database.db,
  );

  expect(
    (
      await extProposal(
        new NextRequest(
          `http://localhost/api/v1/ext/knowledge/proposals/${proposal.id}`,
          { headers: { Authorization: `Bearer ${unrelatedToken.secret}` } },
        ),
        proposerContext,
      )
    ).status,
  ).toBe(404);
  const changed = await proposeKnowledge(
    jsonRequest("/api/knowledge/proposals", {
      ...body,
      content: { ...body.content, assertion: "A different assertion" },
    }),
  );

  expect(changed.status).toBe(409);
  const detail = await getProposal(
    new NextRequest(`http://localhost/api/knowledge/proposals/${proposal.id}`),
    { params: Promise.resolve({ proposalId: proposal.id }) },
  );

  expect(detail.status).toBe(200);
  const detailBody = await detail.json();

  assertContract("CBKnowledgeProposal", detailBody);
  expect(detailBody).toMatchObject({
    id: proposal.id,
    owner,
    content: body.content,
    evidence: [
      {
        relation: "supports",
        witness: { id: witness.id, availability: "available" },
      },
    ],
  });
  const list = await listProposals(
    new NextRequest(
      `http://localhost/api/knowledge/proposals?ownerKind=company&ownerId=${companyId}&status=pending`,
    ),
  );

  expect(list.status).toBe(200);
  const proposalsPage = await list.json();

  assertContract("CBKnowledgeProposalPage", proposalsPage);
  expect(proposalsPage.items.map((item: { id: string }) => item.id)).toContain(
    proposal.id,
  );
  const decision = {
    expectedRevision: 1,
    decision: "accept",
    reason: "Publish this version-bound procedure",
    idempotencyKey: `${readerId}_http_accept`,
  };
  const context = { params: Promise.resolve({ proposalId: proposal.id }) };
  const accepted = await decideKnowledge(
    jsonRequest(`/api/knowledge/proposals/${proposal.id}/decision`, decision),
    context,
  );

  expect(accepted.status).toBe(200);
  const acceptedBody = await accepted.json();

  assertContract("CBReceipt", acceptedBody);
  expect(acceptedBody).toMatchObject({
    id: proposal.id,
    revision: 2,
    status: "accepted",
    duplicate: false,
  });
  const recordId = String(
    (
      await database.pool.query(
        "SELECT published_record_id FROM brain_proposals WHERE id=$1",
        [proposal.id],
      )
    ).rows[0].published_record_id,
  );

  expect(await (await readRecord(recordId)).json()).toMatchObject({
    confirmation: { state: "unconfirmed" },
  });
  const repeated = await decideKnowledge(
    jsonRequest(`/api/knowledge/proposals/${proposal.id}/decision`, decision),
    context,
  );

  expect(await repeated.json()).toMatchObject({ duplicate: true });
  expect(
    (
      await decideKnowledge(
        jsonRequest(`/api/knowledge/proposals/${proposal.id}/decision`, {
          ...decision,
          decision: "reject",
        }),
        context,
      )
    ).status,
  ).toBe(409);
  const confirmation = {
    expectedRevision: 1,
    decision: "confirm",
    witnessIds: [witness.id],
    reason: "Confirm using the authorized current source version",
    idempotencyKey: `${readerId}_http_confirm`,
  };
  const recordContext = { params: Promise.resolve({ recordId }) };

  expect(
    (
      await confirmKnowledge(
        jsonRequest(`/api/knowledge/${recordId}/confirmations`, confirmation),
        recordContext,
      )
    ).status,
  ).toBe(403);
  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'user',$2,'knowledge:confirm',$2)",
    [companyId, readerId],
  );
  const confirmed = await confirmKnowledge(
    jsonRequest(`/api/knowledge/${recordId}/confirmations`, confirmation),
    recordContext,
  );

  expect(confirmed.status).toBe(200);
  const confirmationBody = await confirmed.json();

  assertContract("CBReceipt", confirmationBody);
  expect(confirmationBody).toMatchObject({
    status: "confirmed",
    revision: 1,
    duplicate: false,
  });
  expect(await (await readRecord(recordId)).json()).toMatchObject({
    confirmation: { state: "confirmed", witnessIds: [witness.id] },
  });
  expect(
    (
      await confirmKnowledge(
        jsonRequest(`/api/knowledge/${recordId}/confirmations`, {
          ...confirmation,
          confirmer: { id: "forged" },
        }),
        recordContext,
      )
    ).status,
  ).toBe(400);
  await database.pool.query(
    "UPDATE company_grants SET revoked_at=now(),revision=revision+1 WHERE company_id=$1 AND principal_id=$2 AND action='knowledge:confirm'",
    [companyId, readerId],
  );
  expect(
    (
      await confirmKnowledge(
        jsonRequest(`/api/knowledge/${recordId}/confirmations`, confirmation),
        recordContext,
      )
    ).status,
  ).toBe(403);
});

it("IT-CBK-06 review pagination applies source authority before LIMIT, bounds summaries and rechecks authority after continuation", async () => {
  vi.stubEnv("AUTH_SECRET", "native-proposal-cursor-test-secret");
  const principal = { kind: "user" as const, userId: readerId };
  const owner = { kind: "company" as const, companyId };
  const visible: string[] = [];

  for (let index = 0; index < 26; index++) {
    const proposed = await createBrainProposal(database.db, {
      kind: "knowledge_add",
      owner,
      principal,
      idempotencyKey: `${readerId}_queue_${index}`,
      draft: {
        title: `Bounded review ${index}`,
        kind: "assertion",
        assertion: "\u001f".repeat(2000) + `${readerId}_${index}`,
        basis: "inferred",
        evidence: [],
        missingEvidence: [
          {
            state: "absent",
            reason:
              "This is an explicitly unsupported assumption awaiting investigation.",
          },
        ],
        limitations: [],
      },
    });

    visible.push(proposed.id);
  }
  let submissions = 0;
  const counted: KnowledgeDatabase = {
    execute: (query) => database.db.execute(query),
    transaction: (action) =>
      database.db.transaction((tx) =>
        action({
          execute: (query) => {
            submissions++;

            return tx.execute(query);
          },
        }),
      ),
  };

  await listKnowledgeProposals(counted, principal, {
    owner,
    status: "pending",
    limit: 1,
  });
  const singleQueries = submissions;

  submissions = 0;
  const summaries = await listKnowledgeProposals(counted, principal, {
    owner,
    status: "pending",
    limit: 26,
  });

  expect(summaries.items.length).toBeGreaterThan(1);
  // One owner/source policy walk, rather than repeated detail/evidence reads for every summary.
  expect(submissions).toBeLessThanOrEqual(singleQueries + 2);
  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "UPDATE projects SET brain_enabled=true WHERE id=$1",
    [project.id],
  );
  await database.pool.query("UPDATE users SET role='admin' WHERE id=$1", [
    readerId,
  ]);
  const source = await captureKnowledgeSource(database.db, principal, {
    owner: { kind: "project", projectId: project.id },
    title: "Restricted review source",
    content: "Restricted diagnostic observation",
    idempotencyKey: `${readerId}_restricted_queue_source`,
  });
  const hidden: string[] = [];

  for (let index = 0; index < 3; index++) {
    const proposed = await createBrainProposal(database.db, {
      kind: "knowledge_add",
      owner,
      principal,
      idempotencyKey: `${readerId}_hidden_queue_${index}`,
      draft: {
        title: `Private review ${index}`,
        kind: "assertion",
        assertion: `${readerId} private observation ${index}`,
        basis: "observed",
        evidence: [
          {
            relation: "supports",
            reference: {
              kind: "witness",
              id: source.witness.id,
              version: source.witness.sourceVersion!,
              sha256: source.witness.sha256!,
            },
          },
        ],
        missingEvidence: [],
        limitations: [],
      },
    });

    hidden.push(proposed.id);
  }
  await database.pool.query("UPDATE users SET role='member' WHERE id=$1", [
    readerId,
  ]);
  const single = await listProposals(
    new NextRequest(
      `http://localhost/api/knowledge/proposals?ownerKind=company&ownerId=${companyId}&status=pending&limit=1`,
    ),
  );

  expect(single.status).toBe(200);
  const first = await single.json();

  expect(first.items.map((item: { id: string }) => item.id)).toEqual([
    visible.at(-1),
  ]);
  expect(first.nextCursor).not.toBeNull();
  for (const proposalId of hidden)
    expect(
      (
        await getProposal(
          new NextRequest(
            `http://localhost/api/knowledge/proposals/${proposalId}`,
          ),
          { params: Promise.resolve({ proposalId }) },
        )
      ).status,
    ).toBe(404);
  let cursor: string | null = null;
  let pages = 0;
  const found: string[] = [];

  do {
    const response = await listProposals(
      new NextRequest(
        `http://localhost/api/knowledge/proposals?ownerKind=company&ownerId=${companyId}&status=pending&limit=50${cursor === null ? "" : `&cursor=${cursor}`}`,
      ),
    );

    expect(response.status).toBe(200);
    const raw = await response.text();

    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(131072);
    const page = JSON.parse(raw) as {
      items: {
        id: string;
        assertionPreview: string;
        assertionTruncated: boolean;
        content?: unknown;
      }[];
      nextCursor: string | null;
    };

    assertContract("CBKnowledgeProposalPage", page);
    for (const item of page.items) {
      expect(hidden).not.toContain(item.id);
      expect(item.content).toBeUndefined();
      if (visible.includes(item.id)) {
        expect(item.assertionPreview).toHaveLength(1000);
        expect(item.assertionTruncated).toBe(true);
        found.push(item.id);
      }
    }
    cursor = page.nextCursor;
    if (++pages > 20) throw new Error("Bounded review queue failed to advance");
  } while (cursor !== null);
  expect(found.sort()).toEqual([...visible].sort());
  expect(pages).toBeGreaterThan(1);
  await database.pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM brain_proposals WHERE id=ANY($1::text[])",
        [hidden],
      )
    ).rows,
  ).toHaveLength(3);
  await database.pool.query(
    "UPDATE company_grants SET revoked_at=now(),revision=revision+1 WHERE company_id=$1 AND principal_id=$2 AND action='knowledge:review'",
    [companyId, readerId],
  );
  expect(
    (
      await listProposals(
        new NextRequest(
          `http://localhost/api/knowledge/proposals?ownerKind=company&ownerId=${companyId}&status=pending&limit=1&cursor=${first.nextCursor}`,
        ),
      )
    ).status,
  ).toBe(400);
  const afterRevocation = await listProposals(
    new NextRequest(
      `http://localhost/api/knowledge/proposals?ownerKind=company&ownerId=${companyId}&status=pending&limit=1`,
    ),
  );

  expect(afterRevocation.status).toBe(200);
  expect(await afterRevocation.json()).toEqual({ items: [], nextCursor: null });
  vi.unstubAllEnvs();
});

it("IT-CBX-02 native external validation keeps the established 422 contract and concealed references remain 404", async () => {
  const issued = await issueUserAccessToken(
    {
      ownerUserId: readerId,
      name: "Native external status qualification",
      scopes: normalizeTokenScopes(["knowledge:read", "knowledge:propose"]),
    },
    database.db,
  );
  const headers = {
    Authorization: `Bearer ${issued.secret}`,
    "Content-Type": "application/json",
  };
  const invalid = await extCapture(
    new NextRequest("http://localhost/api/v1/ext/knowledge/sources", {
      method: "POST",
      headers,
      body: JSON.stringify({
        owner: { kind: "company", companyId },
        title: "Rejected fabricated actor",
        content: "Source input",
        idempotencyKey: `${readerId}_external_bad_actor`,
        attribution: { kind: "user", id: "forged" },
      }),
    }),
  );

  expect(invalid.status).toBe(422);
  const invalidBody = await invalid.json();

  assertContract("CBError", invalidBody);
  expect(invalidBody).toMatchObject({ code: "CONFIG" });
  const query = await extSearch(
    new NextRequest("http://localhost/api/v1/ext/knowledge?limit=1&limit=2", {
      headers,
    }),
  );

  expect(query.status).toBe(422);
  assertContract("CBError", await query.json());
  const missing = await extWitness(
    new NextRequest(
      "http://localhost/api/v1/ext/knowledge/witnesses/unavailable",
      { headers },
    ),
    { params: Promise.resolve({ witnessId: "unavailable" }) },
  );

  expect(missing.status).toBe(404);
  const missingBody = await missing.json();

  assertContract("CBError", missingBody);
  expect(missingBody).toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT source_id FROM brain_source_submissions WHERE principal_key=$1 AND delivery_key=$2",
        [`user:${readerId}`, `${readerId}_external_bad_actor`],
      )
    ).rows,
  ).toEqual([]);
});

it("IT-CBK-06 a review page continues before its combined source footprint exceeds the resolution budget", async () => {
  vi.stubEnv("AUTH_SECRET", "native-review-footprint-cursor");
  const principal = { kind: "user" as const, userId: readerId };
  const owner = { kind: "company" as const, companyId };
  const proposals: string[] = [];

  for (let group = 0; group < 2; group++) {
    const leaves = Array.from({ length: 128 }, () => randomUUID());

    await database.pool.query(
      "INSERT INTO brain_items(id,company_id,kind,title,content,content_hash,confidence,source_restrictions) SELECT id,$2,'assertion',id,id,id,0.3,'[]'::jsonb FROM unnest($1::text[]) id",
      [leaves, companyId],
    );
    const root = randomUUID();

    await database.pool.query(
      "INSERT INTO brain_items(id,company_id,kind,title,content,content_hash,confidence,source_restrictions) VALUES($1,$2,'assertion',$1,$1,$1,0.3,$3::jsonb)",
      [
        root,
        companyId,
        JSON.stringify(
          leaves.map((recordId) => ({ kind: "record", recordId })),
        ),
      ],
    );
    const proposal = await createBrainProposal(database.db, {
      kind: "knowledge_correct",
      owner,
      principal,
      targetRecordId: root,
      expectedRecordRevision: 1,
      idempotencyKey: `${readerId}_footprint_${group}`,
      draft: {
        title: `Bounded source closure ${group}`,
        kind: "assertion",
        assertion: `Provisional correction ${root}`,
        basis: "inferred",
        evidence: [],
        missingEvidence: [
          {
            state: "unknown",
            reason:
              "These source records do not independently confirm this provisional assertion.",
          },
        ],
        limitations: [],
      },
    });

    proposals.push(proposal.id);
  }
  const first = await listKnowledgeProposals(database.db, principal, {
    owner,
    status: "pending",
    limit: 2,
  });

  expect(first.items.map((item) => item.id)).toEqual([proposals[1]]);
  expect(first.nextCursor).not.toBeNull();
  const second = await listKnowledgeProposals(database.db, principal, {
    owner,
    status: "pending",
    limit: 2,
    cursor: first.nextCursor!,
  });

  expect(second.items[0].id).toBe(proposals[0]);
  expect(second.items.map((item) => item.id)).not.toContain(proposals[1]);
});

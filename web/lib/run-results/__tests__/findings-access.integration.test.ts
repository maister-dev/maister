import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { NativeFindingsExecution } from "@/test-support/native-findings-seed";
import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { KnowledgeAccessCapture } from "@/lib/company/types";

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";

import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import { captureKnowledgeSource } from "@/lib/brain/knowledge-source-capture";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { contentDigest } from "@/lib/evaluations/digest";
import { loadNativeInputForUser } from "@/lib/orchestrator/native-input-read";
import {
  createKnowledgeProposal,
  reviewKnowledgeProposal,
} from "@/lib/brain/knowledge-proposals";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { searchKnowledge } from "@/lib/brain/knowledge-search";
import { buildAgentProfileContract } from "@/lib/run-results/contract";
import { issueAgentRunToken } from "@/lib/agents/tokens";
import {
  assertNativeRunKnowledgeInputs,
  recordNativeRunSources,
} from "@/lib/brain/knowledge-execution-access";
import { authorizeRunsKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { seedNativeFindingsExecution } from "@/test-support/native-findings-seed";
import { poll } from "@/test-support/durable-workers-ledger";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import {
  readAgentMemoryRaw,
  writeAgentMemoryCas,
} from "@/lib/agents/memory-store";
import { applyAgentMemoryForLaunch } from "@/lib/agents/launch";
import { runDirPath } from "@/lib/flows/graph/mutation-check";

let database: StartedPostgresTestDb;
let runtimeDirectory: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

const contract = buildAgentProfileContract({
  profileName: "findings",
  flowRefId: "native-context",
  resolvedRevision: "a".repeat(40),
  sourceFlowRevisionId: "retained-profile",
  schemaStem: "findings.v1",
  nativeContract: "evidence_findings_v1",
  schemaVersion: 1,
  sha256: "b".repeat(64),
  schema: { schemaVersion: 1, fields: [] },
});

beforeAll(async () => {
  runtimeDirectory = await mkdtemp(join(tmpdir(), "native-private-context-"));
  vi.stubEnv("MAISTER_RUNTIME_ROOT", runtimeDirectory);
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "native_findings_access",
  });
}, 180000);
afterAll(async () => {
  try {
    await database?.stop();
    await rm(runtimeDirectory, { recursive: true, force: true });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("IT-CBE-06 concurrent knowledge reads retain both source restrictions without manufacturing confirmation", async () => {
  const execution = await seedNativeFindingsExecution(database, contract);
  const user = { kind: "user" as const, userId: execution.submitterId };
  const owner = { kind: "company" as const, companyId: execution.companyId };
  const proposal = await createKnowledgeProposal(database.db, {
    kind: "knowledge_add",
    owner,
    principal: user,
    idempotencyKey: `concurrent:${execution.runId}`,
    draft: {
      title: "Independent claim about the retained observation",
      kind: "observation",
      assertion: "The retained probe describes one observed source version.",
      basis: "observed",
      evidence: [
        {
          relation: "supports",
          reference: { kind: "witness", id: execution.witness.id },
        },
      ],
      limitations: ["The same witness is not independent corroboration."],
      missingEvidence: [],
    },
  });

  await reviewKnowledgeProposal(database.db, {
    proposalId: proposal.id,
    principal: user,
    expectedRevision: proposal.revision,
    decision: "accept",
    reason:
      "Retain a separate claim while preserving the same source identity.",
    idempotencyKey: `concurrent-review:${execution.runId}`,
  });
  const secondRecordId = (
    await database.pool.query<{ published_record_id: string }>(
      "SELECT published_record_id FROM brain_proposals WHERE id=$1",
      [proposal.id],
    )
  ).rows[0]!.published_record_id;
  const principal = { kind: "token" as const, tokenId: execution.tokenId };
  const held = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const first = database.db.transaction(async (tx) => {
    const record = await getKnowledgeRecord(tx, principal, {
      recordId: execution.recordId,
    });
    const backend = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);

    held.resolve(Number(backend.rows[0]!.pid));
    await release.promise;

    return record;
  });

  // Propagate setup failure to the waiter and settle every transaction even if the assertion fails.
  void first.catch(held.reject);
  const backendId = await held.promise;
  const second = getKnowledgeRecord(database.db, principal, {
    recordId: secondRecordId,
  });

  const settled = Promise.allSettled([first, second]);

  try {
    await poll(
      async () => {
        const blocked = await database.pool.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))) AS waiting",
          [backendId],
        );

        return blocked.rows[0]?.waiting === true ? true : null;
      },
      2000,
      "the second actual knowledge reader to wait on the first capture transaction",
      25,
    );
  } finally {
    release.resolve();
    await settled;
  }
  const records = await Promise.all([first, second]);

  expect(records.map((record) => record.confirmation.state)).toEqual([
    "unconfirmed",
    "unconfirmed",
  ]);
  const capture = async (): Promise<KnowledgeAccessCapture> =>
    (
      await database.pool.query<{ knowledge_access: KnowledgeAccessCapture }>(
        "SELECT knowledge_access FROM runs WHERE id=$1",
        [execution.runId],
      )
    ).rows[0]!.knowledge_access;
  const combined = await capture();

  expect(combined).toMatchObject({ state: "complete", generation: 3 });
  expect(combined.restrictions).toEqual(
    expect.arrayContaining([
      { kind: "company", companyId: execution.companyId },
      { kind: "record", recordId: execution.recordId },
      { kind: "record", recordId: secondRecordId },
    ]),
  );
  expect(
    combined.restrictions.filter((entry) => entry.kind === "company"),
  ).toHaveLength(1);
  expect(
    (
      await getKnowledgeRecord(database.db, principal, {
        recordId: secondRecordId,
      })
    ).confirmation.state,
  ).toBe("unconfirmed");
  expect(await capture()).toEqual(combined);
});

it("IT-CBE-06 original delegated input inspection retains exact binding and current human source authority", async () => {
  const execution = await seedNativeFindingsExecution(database, contract);
  const principal = { kind: "token" as const, tokenId: execution.tokenId };

  await getKnowledgeRecord(database.db, principal, {
    recordId: execution.recordId,
  });
  const authority = await resolveKnowledgePrincipal(
    database.db,
    principal,
    "knowledge:read",
  );
  const parent = (
    await database.pool.query("SELECT knowledge_access FROM runs WHERE id=$1", [
      execution.runId,
    ])
  ).rows[0]!;
  const content = {
    schemaVersion: 1,
    sourceRunId: execution.runId,
    sourceGeneration: parent.knowledge_access.generation,
    sourceActor: authority.actor,
    sourceRestrictions: parent.knowledge_access.restrictions,
    target: { kind: "agent", id: execution.agentId },
    title: "Original private objective",
    prompt: "Diagnose the exact retained company observation.",
  };
  const nativeInput = { ...content, inputDigest: contentDigest(content) };
  const childId = randomUUID();

  await database.pool.query(
    "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,agent_workspace,agent_id,source_agent_id,launched_at,activity_sort_at,activity_timestamp_provenance,agent_activity_snapshot,knowledge_access,parent_run_id,delegation_snapshot) SELECT $2,project_id,'agent','Pending',flow_version,flow_revision,'none',agent_id,source_agent_id,now(),now(),'launch',agent_activity_snapshot,knowledge_access,id,$3::jsonb FROM runs WHERE id=$1",
    [
      execution.runId,
      childId,
      JSON.stringify({
        kind: "agent",
        agentDefinitionId: execution.agentId,
        revisionId: "retained-revision",
        nativeInput,
      }),
    ],
  );
  const expected = {
    title: content.title,
    prompt: content.prompt,
    sourceRunId: execution.runId,
    inputDigest: nativeInput.inputDigest,
  };

  expect(
    await loadNativeInputForUser(database.db, execution.submitterId, childId),
  ).toEqual(expected);
  await database.pool.query(
    "UPDATE company_grants SET revoked_at=now() WHERE company_id=$1 AND principal_type='user' AND principal_id=$2 AND action='knowledge:read'",
    [execution.companyId, execution.submitterId],
  );
  await expect(
    loadNativeInputForUser(database.db, execution.submitterId, childId),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_reference_unavailable" },
  });
  await createCompanyGrants(database.db, execution.submitterId, {
    principalKind: "user",
    principalId: execution.submitterId,
    actions: ["knowledge:read"],
    idempotencyKey: `input-inspection:${childId}`,
  });
  expect(
    await loadNativeInputForUser(database.db, execution.submitterId, childId),
  ).toEqual(expected);
  await database.pool.query(
    "UPDATE runs SET delegation_snapshot=jsonb_set(delegation_snapshot,'{nativeInput,prompt}','\"Changed without a new witness\"') WHERE id=$1",
    [childId],
  );
  await expect(
    loadNativeInputForUser(database.db, execution.submitterId, childId),
  ).rejects.toMatchObject({ code: "CRASH" });
  expect(
    await loadNativeInputForUser(
      database.db,
      execution.submitterId,
      execution.runId,
    ),
  ).toBeNull();
  await database.pool.query(
    "UPDATE runs SET delegation_snapshot=jsonb_set(delegation_snapshot,'{nativeInput}',$2::jsonb) WHERE id=$1",
    [childId, JSON.stringify(nativeInput)],
  );
  let firstInspection = true;
  const racedDb: SqlDatabase = {
    execute: database.db.execute.bind(database.db),
    async transaction<T>(
      action: (tx: SqlTransaction) => Promise<T>,
    ): Promise<T> {
      const result = await database.db.transaction(action);

      if (firstInspection) {
        firstInspection = false;
        const grant = (
          await database.pool.query<{ id: string; revision: number }>(
            "SELECT id,revision FROM company_grants WHERE principal_type='user' AND principal_id=$1 AND action='knowledge:read' AND revoked_at IS NULL",
            [execution.submitterId],
          )
        ).rows[0]!;

        await revokeCompanyGrant(database.db, execution.submitterId, grant.id, {
          expectedRevision: grant.revision,
          reason:
            "Revoke source access after private input assembly and before outward delivery.",
          idempotencyKey: `input-assembly:${childId}`,
        });
      }

      return result;
    },
  };

  await expect(
    loadNativeInputForUser(racedDb, execution.submitterId, childId),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_reference_unavailable" },
  });
});

it("IT-CBE-06 native private notes preserve their separate source policy and cannot store company-derived content", async () => {
  const execution = await seedNativeFindingsExecution(database, contract);

  await database.pool.query(
    "UPDATE agent_project_links SET memory_enabled=true WHERE project_id=$1 AND agent_id=$2",
    [execution.projectId, execution.agentId],
  );
  const project = (
    await database.pool.query<{ slug: string }>(
      "SELECT slug FROM projects WHERE id=$1",
      [execution.projectId],
    )
  ).rows[0]!;
  const { POST } = await import("@/app/api/v1/ext/agent/memory/route");
  const write = (content: string, ifHash: string | null): Promise<Response> =>
    POST(
      new NextRequest("http://localhost/api/v1/ext/agent/memory", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${execution.tokenSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content, ifHash }),
      }),
    );
  const localNotes = "Private procedural notes for this professional role.";
  const allowed = await write(localNotes, null);

  expect(allowed.status).toBe(200);
  const prior: { hash: string } = await allowed.json();
  const record = await getKnowledgeRecord(
    database.db,
    { kind: "token", tokenId: execution.tokenId },
    { recordId: execution.recordId },
  );
  const denied = await write(record.assertion, prior.hash);

  expect(denied.status).toBe(409);
  expect(await denied.json()).toMatchObject({
    code: "PRECONDITION",
    details: { reason: "native_unclassified_memory" },
  });
  expect(
    await readAgentMemoryRaw(project.slug, execution.agentId),
  ).toMatchObject({ content: localNotes, hash: prior.hash });
});

const contextCases = [
  {
    name: "project input context",
    peerCanRead: true,
    restriction: (e: NativeFindingsExecution) => ({
      kind: "project_context",
      projectId: e.projectId,
    }),
  },
  {
    name: "private agent memory",
    peerCanRead: false,
    restriction: (e: NativeFindingsExecution) => ({
      kind: "agent_memory",
      projectId: e.projectId,
      agentId: e.agentId,
    }),
  },
] as const;

it.each(contextCases)(
  "IT-CBE-06 derived $name retains source authority through capture, publication, search and project deletion",
  async ({ restriction, peerCanRead }) => {
    const execution = await seedNativeFindingsExecution(database, contract);
    const owner = { kind: "company" as const, companyId: execution.companyId };
    const source = restriction(execution);

    await database.pool.query(
      "UPDATE agent_project_links SET memory_enabled=true WHERE project_id=$1 AND agent_id=$2",
      [execution.projectId, execution.agentId],
    );
    await database.pool.query(
      "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'agent',$2,'knowledge:propose',$3)",
      [execution.companyId, execution.agentId, execution.submitterId],
    );
    await database.pool.query(
      "UPDATE runs SET knowledge_access=jsonb_set(knowledge_access,'{restrictions}',$2::jsonb) WHERE id=$1",
      [execution.runId, JSON.stringify([source])],
    );
    const principal = { kind: "token" as const, tokenId: execution.tokenId };
    const capture = await captureKnowledgeSource(database.db, principal, {
      owner,
      title: "An execution-context observation",
      content: `Context-derived observation ${execution.runId}`,
      idempotencyKey: `source:${execution.runId}`,
    });
    const title = `Context-derived finding ${execution.runId}`;
    const proposal = await createKnowledgeProposal(database.db, {
      kind: "knowledge_add",
      owner,
      principal,
      idempotencyKey: `proposal:${execution.runId}`,
      draft: {
        title,
        kind: "observation",
        assertion: title,
        basis: "inferred",
        evidence: [
          {
            relation: "supports",
            reference: { kind: "witness", id: capture.witness.id },
          },
        ],
        limitations: [],
        missingEvidence: [],
      },
    });

    await reviewKnowledgeProposal(database.db, {
      proposalId: proposal.id,
      principal: { kind: "user", userId: execution.submitterId },
      expectedRevision: proposal.revision,
      decision: "accept",
      reason: "Retain the finding with its original source restrictions.",
      idempotencyKey: `review:${execution.runId}`,
    });
    const published = (
      await database.pool.query<{ published_record_id: string }>(
        "SELECT published_record_id FROM brain_proposals WHERE id=$1",
        [proposal.id],
      )
    ).rows[0]!.published_record_id;
    const retained = (
      await database.pool.query(
        "SELECT source_restrictions FROM brain_record_revisions WHERE record_id=$1 AND revision=1",
        [published],
      )
    ).rows[0]?.source_restrictions;

    expect(retained).toContainEqual(source);
    const readerId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'viewer','active')",
      [readerId, `${readerId}@example.test`],
    );
    await database.pool.query(
      "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'user',$2,'knowledge:read',$3)",
      [execution.companyId, readerId, execution.submitterId],
    );
    const reader = { kind: "user" as const, userId: readerId };
    const search = () =>
      searchKnowledge(database.db, reader, {
        owner,
        q: execution.runId,
        limit: 1,
      });

    await expect(
      getKnowledgeRecord(database.db, reader, { recordId: published }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "knowledge_reference_unavailable" },
    });
    expect((await search()).items).toEqual([]);
    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'viewer')",
      [randomUUID(), execution.projectId, readerId],
    );
    expect((await search()).items).toEqual([]);
    await database.pool.query(
      "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
      [execution.projectId, readerId],
    );
    await expect(
      getKnowledgeRecord(database.db, reader, { recordId: published }),
    ).resolves.toMatchObject({
      id: published,
      confirmation: { state: "unconfirmed" },
    });
    expect((await search()).items.map((item) => item.id)).toEqual([published]);
    const peerAgentId = `${execution.agentId}-peer`;

    await database.pool.query(
      "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) SELECT $2,package_name,version_label,origin,'Peer researcher',description,workspace,mode,triggers,risk_tier,source_path FROM agents WHERE id=$1",
      [execution.agentId, peerAgentId],
    );
    await database.pool.query(
      "INSERT INTO agent_project_links(id,project_id,agent_id,enabled,can_read_brain,memory_enabled) VALUES($1,$2,$3,true,true,true)",
      [randomUUID(), execution.projectId, peerAgentId],
    );
    await database.pool.query(
      "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'agent',$2,'knowledge:read',$3)",
      [execution.companyId, peerAgentId, execution.submitterId],
    );
    const peerRunId = await seedRun(database.db, {
      projectId: execution.projectId,
      runKind: "agent",
      status: "Running",
      agentWorkspace: "none",
    });

    await database.pool.query(
      "UPDATE runs SET agent_id=$2,source_agent_id=$2,launched_at=now(),activity_sort_at=now(),activity_timestamp_provenance='launch',agent_activity_snapshot=jsonb_set((SELECT agent_activity_snapshot FROM runs WHERE id=$3),'{agentId}',to_jsonb($2::text)),result_contract=$4::jsonb,knowledge_access=$5::jsonb WHERE id=$1",
      [
        peerRunId,
        peerAgentId,
        execution.runId,
        JSON.stringify(contract),
        JSON.stringify({
          schemaVersion: 1,
          state: "complete",
          generation: 1,
          restrictions: [],
        }),
      ],
    );
    const peerToken = await issueAgentRunToken({
      agentId: peerAgentId,
      projectId: execution.projectId,
      runId: peerRunId,
      db: database.db,
    });
    const peer = { kind: "token" as const, tokenId: peerToken.tokenId };

    if (peerCanRead) {
      await expect(
        getKnowledgeRecord(database.db, peer, { recordId: published }),
      ).resolves.toMatchObject({ id: published });
    } else {
      await expect(
        getKnowledgeRecord(database.db, peer, { recordId: published }),
      ).rejects.toMatchObject({
        code: "PRECONDITION",
        details: { reason: "knowledge_reference_unavailable" },
      });
      expect(
        (
          await searchKnowledge(database.db, peer, {
            owner,
            q: execution.runId,
            limit: 1,
          })
        ).items,
      ).toEqual([]);
    }
    expect(
      (
        await database.pool.query(
          "SELECT brain_enabled FROM projects WHERE id=$1",
          [execution.projectId],
        )
      ).rows[0]?.brain_enabled,
    ).toBe(false);
    await database.pool.query(
      "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
      [execution.projectId, readerId],
    );
    expect((await search()).items).toEqual([]);
    await database.pool.query("DELETE FROM projects WHERE id=$1", [
      execution.projectId,
    ]);
    expect(
      (
        await database.pool.query("SELECT id FROM brain_items WHERE id=$1", [
          published,
        ])
      ).rows,
    ).toEqual([{ id: published }]);
    expect((await search()).items).toEqual([]);
    await expect(
      getKnowledgeRecord(database.db, reader, { recordId: published }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "knowledge_reference_unavailable" },
    });
  },
);

it("IT-CBE-06 captures actual private notes before a native launch writes its prompt snapshot", async () => {
  const execution = await seedNativeFindingsExecution(database, contract);

  await database.pool.query(
    "UPDATE agent_project_links SET memory_enabled=true WHERE project_id=$1 AND agent_id=$2",
    [execution.projectId, execution.agentId],
  );
  const slug = (
    await database.pool.query<{ slug: string }>(
      "SELECT slug FROM projects WHERE id=$1",
      [execution.projectId],
    )
  ).rows[0]!.slug;
  const content =
    "Private notes remain private source data, separate from Company Brain.";

  await writeAgentMemoryCas(
    database.db,
    slug,
    execution.agentId,
    content,
    null,
  );
  expect(
    await applyAgentMemoryForLaunch(
      database.db,
      {
        id: execution.runId,
        runId: execution.runId,
        agentId: execution.agentId,
        projectId: execution.projectId,
        runKind: "agent",
        resultContract: contract,
      },
      slug,
      false,
    ),
  ).toBe(content);
  const capture = (
    await database.pool.query("SELECT knowledge_access FROM runs WHERE id=$1", [
      execution.runId,
    ])
  ).rows[0]?.knowledge_access;

  expect(capture.restrictions).toContainEqual({
    kind: "agent_memory",
    projectId: execution.projectId,
    agentId: execution.agentId,
  });
  expect(
    await readFile(
      join(
        runDirPath(runtimeDirectory, slug, execution.runId),
        "memory-snapshot.md",
      ),
      "utf8",
    ),
  ).toBe(content);
});

it.each(["GET", "POST"] as const)(
  "IT-CBE-06 captures private bytes returned by the actual %s memory endpoint",
  async (method) => {
    const execution = await seedNativeFindingsExecution(database, contract);

    await database.pool.query(
      "UPDATE agent_project_links SET memory_enabled=true WHERE project_id=$1 AND agent_id=$2",
      [execution.projectId, execution.agentId],
    );
    const slug = (
      await database.pool.query<{ slug: string }>(
        "SELECT slug FROM projects WHERE id=$1",
        [execution.projectId],
      )
    ).rows[0]!.slug;
    const content =
      "These private source bytes must constrain even a CAS-conflict response.";

    await writeAgentMemoryCas(
      database.db,
      slug,
      execution.agentId,
      content,
      null,
    );
    const route = await import("@/app/api/v1/ext/agent/memory/route");
    const response = await route[method](
      new NextRequest("http://localhost/api/v1/ext/agent/memory", {
        method,
        headers: {
          Authorization: `Bearer ${execution.tokenSecret}`,
          "Content-Type": "application/json",
        },
        ...(method === "POST"
          ? {
              body: JSON.stringify({
                content: "Offered update",
                ifHash: "a-stale-memory-hash",
              }),
            }
          : {}),
      }),
    );

    expect(response.status).toBe(method === "GET" ? 200 : 409);
    const value: unknown = await response.json();

    expect(value).toMatchObject(
      method === "GET" ? { content } : { current: { content } },
    );
    const capture = (
      await database.pool.query(
        "SELECT knowledge_access FROM runs WHERE id=$1",
        [execution.runId],
      )
    ).rows[0]?.knowledge_access;

    expect(capture.restrictions).toContainEqual({
      kind: "agent_memory",
      projectId: execution.projectId,
      agentId: execution.agentId,
    });
  },
);

it.each([
  { path: "memory", method: "GET", body: undefined },
  {
    path: "memory",
    method: "POST",
    body: {
      kind: "observation",
      content: "A native finding must use the versioned proposal contract.",
    },
  },
  { path: "memory/clusters", method: "GET", body: undefined },
  {
    path: "memory/proposals",
    method: "POST",
    body: {
      kind: "state",
      evidenceItemIds: [],
      draft: {
        statement: "A native correction must retain its source profile.",
      },
      blastRadius: "low",
    },
  },
] as const)(
  "IT-CBE-06 requires structured knowledge transport for native $method $path",
  async ({ path, method, body }) => {
    const execution = await seedNativeFindingsExecution(database, contract);

    await database.pool.query(
      "UPDATE projects SET brain_enabled=true WHERE id=$1",
      [execution.projectId],
    );
    await database.pool.query(
      "UPDATE agent_project_links SET can_write_brain=true WHERE project_id=$1 AND agent_id=$2",
      [execution.projectId, execution.agentId],
    );
    const slug = (
      await database.pool.query<{ slug: string }>(
        "SELECT slug FROM projects WHERE id=$1",
        [execution.projectId],
      )
    ).rows[0]!.slug;
    const request = new NextRequest(
      `http://localhost/api/v1/ext/projects/${slug}/${path}?q=native`,
      {
        method,
        headers: {
          Authorization: `Bearer ${execution.tokenSecret}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const params = { params: Promise.resolve({ slug }) };
    let response: Response;

    if (path === "memory/clusters")
      response = await (
        await import("@/app/api/v1/ext/projects/[slug]/memory/clusters/route")
      ).GET(request, params);
    else if (path === "memory/proposals")
      response = await (
        await import("@/app/api/v1/ext/projects/[slug]/memory/proposals/route")
      ).POST(request, params);
    else {
      const route =
        await import("@/app/api/v1/ext/projects/[slug]/memory/route");

      response = await route[method](request, params);
    }
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "PRECONDITION",
      message: expect.stringContaining("knowledge_search"),
    });
  },
);

it("IT-CBE-06 retained native shared workspaces refuse consumption, dispatch and derived disclosure without blocking project deletion", async () => {
  const execution = await seedNativeFindingsExecution(database, contract);

  await database.pool.query(
    "UPDATE runs SET workspace_mode='shared' WHERE id=$1",
    [execution.runId],
  );
  const refusal = {
    code: "PRECONDITION",
    details: { reason: "native_shared_workspace_unsupported" },
  };

  await expect(
    assertNativeRunKnowledgeInputs(database.db, execution.runId),
  ).rejects.toMatchObject(refusal);
  await expect(
    recordNativeRunSources(database.db, execution.runId, []),
  ).rejects.toMatchObject(refusal);
  await expect(
    getKnowledgeRecord(
      database.db,
      { kind: "token", tokenId: execution.tokenId },
      { recordId: execution.recordId },
    ),
  ).rejects.toMatchObject(refusal);
  await expect(
    database.db.transaction((tx) =>
      authorizeRunsKnowledgeDisclosure(
        tx,
        { kind: "token", tokenId: execution.tokenId },
        [execution.runId],
      ),
    ),
  ).rejects.toMatchObject(refusal);
  await database.pool.query("DELETE FROM projects WHERE id=$1", [
    execution.projectId,
  ]);
  expect(
    (
      await database.pool.query("SELECT id FROM runs WHERE id=$1", [
        execution.runId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await database.pool.query("SELECT id FROM companies WHERE id=$1", [
        execution.companyId,
      ])
    ).rows,
  ).toHaveLength(1);
});

it("IT-CBE-06 native dispatch captures mounted repository sources and rechecks the current attachment grant", async () => {
  const execution = await seedNativeFindingsExecution(database, contract);
  const sibling = await seedProjectRow(database.db);
  const slug = (
    await database.pool.query<{ slug: string }>(
      "SELECT slug FROM projects WHERE id=$1",
      [sibling.id],
    )
  ).rows[0]!.slug;

  await database.pool.query(
    "UPDATE agent_project_links SET context_repos=$3::jsonb WHERE project_id=$1 AND agent_id=$2",
    [
      execution.projectId,
      execution.agentId,
      JSON.stringify([{ project: slug }]),
    ],
  );
  await database.pool.query(
    "UPDATE runs SET context_mounts=$2::jsonb WHERE id=$1",
    [
      execution.runId,
      JSON.stringify([
        {
          projectId: sibling.id,
          slug,
          repoPath: "/source/context",
          mountPath: "/run/context",
          committish: "a".repeat(40),
        },
      ]),
    ],
  );
  await expect(
    assertNativeRunKnowledgeInputs(database.db, execution.runId),
  ).resolves.toBeUndefined();
  const capture = (
    await database.pool.query("SELECT knowledge_access FROM runs WHERE id=$1", [
      execution.runId,
    ])
  ).rows[0]!.knowledge_access;

  expect(capture.restrictions).toContainEqual({
    kind: "project_context",
    projectId: sibling.id,
  });
  await database.pool.query(
    "UPDATE agent_project_links SET context_repos='[]'::jsonb WHERE project_id=$1 AND agent_id=$2",
    [execution.projectId, execution.agentId],
  );
  await expect(
    assertNativeRunKnowledgeInputs(database.db, execution.runId),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await database.pool.query("DELETE FROM projects WHERE id=$1", [sibling.id]);
  expect(
    (
      await database.pool.query("SELECT id FROM runs WHERE id=$1", [
        execution.runId,
      ])
    ).rows,
  ).toEqual([{ id: execution.runId }]);
});

it("IT-CBX-02 preserves supported long catalog role identities across grant input, storage and evidence attribution", async () => {
  const execution = await seedNativeFindingsExecution(
    database,
    contract,
    "researcher-" + "a".repeat(100),
  );

  expect(execution.agentId.length).toBeGreaterThan(128);
  const grants = await createCompanyGrants(database.db, execution.submitterId, {
    principalKind: "agent",
    principalId: execution.agentId,
    actions: ["knowledge:propose"],
    idempotencyKey: `long-role:${execution.runId}`,
  });

  expect(grants.page.items).toContainEqual(
    expect.objectContaining({
      principalId: execution.agentId,
      action: "knowledge:propose",
    }),
  );
  const source = await captureKnowledgeSource(
    database.db,
    { kind: "token", tokenId: execution.tokenId },
    {
      owner: { kind: "company", companyId: execution.companyId },
      title: "Role attribution boundary",
      content: "The server retains the full supported catalog identity.",
      idempotencyKey: `long-source:${execution.runId}`,
    },
  );

  expect(source.witness.attribution).toMatchObject({
    kind: "agent",
    id: execution.agentId,
    runId: execution.runId,
  });
});

it("IT-CBE-06 retains the combined native consumer capture limit across independently bounded source Runs", async () => {
  const execution = await seedNativeFindingsExecution(database, contract);
  const principal = { kind: "user" as const, userId: execution.submitterId };
  const proposalIds: string[] = [];

  for (let index = 0; index < 257; index++) {
    const proposal = await createKnowledgeProposal(database.db, {
      kind: "knowledge_add",
      owner: { kind: "company", companyId: execution.companyId },
      principal,
      idempotencyKey: `capture-bound:${execution.runId}:${index}`,
      draft: {
        title: `Capture-bound claim ${index}`,
        kind: "observation",
        assertion: `Bounded access claim ${index} refers to the same observed source.`,
        basis: "observed",
        evidence: [
          {
            relation: "supports",
            reference: { kind: "witness", id: execution.witness.id },
          },
        ],
        limitations: [
          "All claims share one witness and do not independently corroborate one another.",
        ],
        missingEvidence: [],
      },
    });

    await reviewKnowledgeProposal(database.db, {
      proposalId: proposal.id,
      principal,
      expectedRevision: proposal.revision,
      decision: "accept",
      reason:
        "Retain a distinct source identity for bounded disclosure qualification.",
      idempotencyKey: `capture-bound-review:${execution.runId}:${index}`,
    });
    proposalIds.push(proposal.id);
  }
  const records = (
    await database.pool.query<{ published_record_id: string }>(
      "SELECT published_record_id FROM brain_proposals WHERE id=ANY($1::text[]) ORDER BY published_record_id",
      [proposalIds],
    )
  ).rows;

  expect(records).toHaveLength(257);
  const sourceRuns: string[] = [];

  for (const group of [records.slice(0, 128), records.slice(128)]) {
    const sourceRun = await seedRun(database.db, {
      projectId: execution.projectId,
      runKind: "agent",
      agentWorkspace: "none",
      workspaceMode: "own",
    });
    const capture: KnowledgeAccessCapture = {
      schemaVersion: 1,
      generation: 1,
      state: "complete",
      restrictions: group.map((row) => ({
        kind: "record",
        recordId: row.published_record_id,
      })),
    };

    await database.pool.query(
      "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
      [sourceRun, JSON.stringify(capture)],
    );
    sourceRuns.push(sourceRun);
  }
  const before = (
    await database.pool.query("SELECT knowledge_access FROM runs WHERE id=$1", [
      execution.runId,
    ])
  ).rows;

  await expect(
    database.db.transaction((tx) =>
      authorizeRunsKnowledgeDisclosure(
        tx,
        { kind: "token", tokenId: execution.tokenId },
        sourceRuns,
      ),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_capture_limit" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT knowledge_access FROM runs WHERE id=$1",
        [execution.runId],
      )
    ).rows,
  ).toEqual(before);
}, 120000);

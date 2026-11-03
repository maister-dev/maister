import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { NativeFindingsExecution } from "@/test-support/native-findings-seed";

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createCompanyGrants } from "@/lib/company/grants";
import { captureKnowledgeSource } from "@/lib/brain/knowledge-source-capture";
import {
  createKnowledgeProposal,
  reviewKnowledgeProposal,
} from "@/lib/brain/knowledge-proposals";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { searchKnowledge } from "@/lib/brain/knowledge-search";
import { buildAgentProfileContract } from "@/lib/run-results/contract";
import { issueAgentRunToken } from "@/lib/agents/tokens";
import { assertNativeRunKnowledgeInputs } from "@/lib/brain/knowledge-execution-access";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { seedNativeFindingsExecution } from "@/test-support/native-findings-seed";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import { writeAgentMemoryCas } from "@/lib/agents/memory-store";
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

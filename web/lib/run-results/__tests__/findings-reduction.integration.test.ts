import type { KnowledgeAccessCapture } from "@/lib/company/types";
import type { EvidenceFindingsV1 } from "@/lib/run-results/findings-types";
import type { NativeFindingsExecution } from "@/test-support/native-findings-seed";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { issueOrchestratorRunToken } from "@/lib/agents/tokens";
import { captureKnowledgeSource } from "@/lib/brain/knowledge-source-capture";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import {
  assertSucceededAttemptResult,
  closeSucceededAttemptWithResult,
} from "@/lib/run-results/close-attempt";
import { nativeKnowledgeCaptureAtLaunch } from "@/lib/brain/knowledge-launch-capture";
import { validateFindingsReferences } from "@/lib/run-results/findings-references";
import { inspectFindingsReduction } from "@/lib/run-results/findings-reduction";
import { launchConsensusDraftRuns } from "@/lib/flows/graph/consensus/drafts";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { platformAcpRunners } from "@/lib/db/schema";
import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import {
  buildAgentProfileContract,
  buildFlowExportContract,
} from "@/lib/run-results/contract";
import { seedNativeFindingsExecution } from "@/test-support/native-findings-seed";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

const agentContract = buildAgentProfileContract({
  profileName: "findings",
  flowRefId: "native-reduction",
  resolvedRevision: "a".repeat(40),
  sourceFlowRevisionId: "pinned-findings",
  schemaStem: "findings.v1",
  nativeContract: "evidence_findings_v1",
  schemaVersion: 1,
  schema: { schemaVersion: 1, fields: [] },
  sha256: "b".repeat(64),
});
const flowContract = buildFlowExportContract({
  flowRefId: "native-reduction",
  resolvedRevision: "a".repeat(40),
  flowRevisionId: "pinned-findings",
  schemaPath: "./schemas/findings.v1.json",
  nativeContract: "evidence_findings_v1",
  schema: { schemaVersion: 1, fields: [] },
  sha256: "b".repeat(64),
  required: true,
  producerNodeIds: ["coordinator"],
});

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "native_findings_reduction",
  });
}, 180000);
afterAll(async () => {
  await database?.stop();
});

async function coordinator(
  source: NativeFindingsExecution,
  parentRunId: string | null = null,
): Promise<{
  runId: string;
  tokenId: string;
  secret: string;
  attemptId: string;
}> {
  const runId = randomUUID();
  const taskId = randomUUID();
  const attemptId = randomUUID();

  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt,status,stage) SELECT $1,$2,coalesce(max(number),0)+1,'Evidence coordination','Collect authorized child findings.','InFlight','InFlight' FROM tasks WHERE project_id=$2",
    [taskId, source.projectId],
  );
  const capture = await database.db.transaction((tx) =>
    nativeKnowledgeCaptureAtLaunch(tx, flowContract, {
      parentRunId,
      sourceRestrictions: [
        { kind: "project_context", projectId: source.projectId },
      ],
    }),
  );

  await database.pool.query(
    `INSERT INTO runs(id,project_id,task_id,run_kind,status,flow_version,flow_revision,agent_id,source_agent_id,agent_activity_snapshot,launched_at,activity_sort_at,activity_timestamp_provenance,current_step_id,result_contract,knowledge_access,parent_run_id,root_run_id)
    SELECT $1,project_id,$2,'flow','Running','fixture','pinned',agent_id,source_agent_id,agent_activity_snapshot,now(),now(),'launch','coordinator',$3::jsonb,$4::jsonb,$6::text,coalesce((SELECT root_run_id FROM runs WHERE id=$6),$6::text) FROM runs WHERE id=$5`,
    [
      runId,
      taskId,
      JSON.stringify(flowContract),
      JSON.stringify(capture),
      source.runId,
      parentRunId,
    ],
  );
  await database.pool.query(
    "INSERT INTO node_attempts(id,run_id,node_id,node_type,status) VALUES($1,$2,'coordinator','orchestrator','Running')",
    [attemptId, runId],
  );

  return {
    runId,
    attemptId,
    ...(await issueOrchestratorRunToken({
      projectId: source.projectId,
      runId,
      nodeAttemptId: attemptId,
      db: database.db,
    })),
  };
}

async function child(
  source: NativeFindingsExecution,
  parentRunId: string,
): Promise<string> {
  const runId = randomUUID();

  await database.db.transaction(async (tx) => {
    const capture = await nativeKnowledgeCaptureAtLaunch(tx, agentContract, {
      parentRunId,
      sourceRestrictions: [
        { kind: "project_context", projectId: source.projectId },
      ],
    });

    await tx.execute(sql`INSERT INTO runs(id,project_id,run_kind,status,flow_version,agent_workspace,agent_id,source_agent_id,agent_activity_snapshot,launched_at,activity_sort_at,activity_timestamp_provenance,parent_run_id,root_run_id,result_contract,knowledge_access)
      SELECT ${runId},source.project_id,'agent','Running','agent','none',source.agent_id,source.source_agent_id,source.agent_activity_snapshot,now(),now(),'launch',parent.id,coalesce(parent.root_run_id,parent.id),${JSON.stringify(agentContract)}::jsonb,${JSON.stringify(capture)}::jsonb
      FROM runs source JOIN runs parent ON parent.id=${parentRunId} AND parent.project_id=source.project_id WHERE source.id=${source.runId}`);
  });

  return runId;
}

function findings(source: NativeFindingsExecution): EvidenceFindingsV1 {
  return {
    schemaVersion: 1,
    findings: [
      {
        id: "health",
        assertion:
          "The observed component was healthy at the source's observation time.",
        basis: "observed",
        supporting: [{ kind: "witness", id: source.witness.id }],
        contradicting: [],
        missingEvidence: [],
        limitations: ["This is an observation of one source version."],
        openQuestions: [],
        sourceFindings: [],
      },
    ],
    knowledgeProposals: [],
    selection: [],
  };
}

async function collect(secret: string, childRunId: string): Promise<Response> {
  const route = await import("@/app/api/v1/ext/runs/collect/route");

  return route.POST(
    new NextRequest("http://localhost/api/v1/ext/runs/collect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ childRunId }),
    }),
    {},
  );
}

it.each(["new", "retained"] as const)(
  "IT-CBE-06 a native coordinator cannot create or resume an unclassified %s runner-only consensus child",
  async (phase) => {
    const source = await seedNativeFindingsExecution(database, agentContract);
    const parent = await coordinator(source);
    const runnerId = randomUUID();

    await database.db
      .insert(platformAcpRunners)
      .values(testPlatformRunnerRow(runnerId, "claude"));
    const retainedId = randomUUID();

    if (phase === "retained")
      await database.pool.query(
        "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,agent_workspace,parent_run_id,delegation_snapshot,trigger_payload) VALUES($1,$2,'agent','Pending','agent','manual','repo_read',$3,$4::jsonb,$5::jsonb)",
        [
          retainedId,
          source.projectId,
          parent.runId,
          JSON.stringify({
            kind: "runner",
            runnerId,
            participantId: "unbound",
            nodeId: "coordinator",
            nodeAttemptId: parent.attemptId,
            round: 1,
            workspaceMode: "repo_read",
          }),
          JSON.stringify({
            kind: "consensus_draft",
            nodeId: "coordinator",
            nodeAttemptId: parent.attemptId,
            round: 1,
            participantId: "unbound",
            participantKind: "runner",
            prompt: "Retained native input",
            workspaceMode: "repo_read",
          }),
        ],
      );
    await expect(
      launchConsensusDraftRuns({
        db: database.db,
        rootDb: database.db,
        projectId: source.projectId,
        taskId: null,
        flowRevisionId: null,
        runDefaultRunnerId: runnerId,
        runnerProfiles: undefined,
        parentRunId: parent.runId,
        rootRunId: parent.runId,
        nodeId: "coordinator",
        nodeAttemptId: parent.attemptId,
        round: 1,
        participants: [{ id: "unbound", runner: runnerId }],
        prompts: [
          {
            participantId: "unbound",
            prompt: "Source-controlled native diagnostic input",
          },
        ],
        workspaceMode: "repo_read",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "native_professional_role_required" },
    });
    expect(
      (
        await database.pool.query(
          "SELECT id FROM runs WHERE parent_run_id=$1",
          [parent.runId],
        )
      ).rows,
    ).toEqual(phase === "retained" ? [{ id: retainedId }] : []);
  },
);

it("IT-CBE-06 collection gates every derived child field, records the source union before bytes and retains exact one-time consumption", async () => {
  const source = await seedNativeFindingsExecution(database, agentContract);
  const parent = await coordinator(source);
  const childRunId = await child(source, parent.runId);
  const value = findings(source);
  const { finalizeAgentRun } = await import("@/lib/agents/launch");

  expect(
    await finalizeAgentRun(childRunId, "Done", {
      db: database.db,
      finalOutput: { kind: "value", value },
    }),
  ).toMatchObject({ finalized: true, status: "Done" });
  const privateText = `Source-controlled child output ${randomUUID()}`;

  await database.pool.query(
    "INSERT INTO artifact_instances(id,run_id,artifact_def_id,kind,producer,locator,validity,uri) VALUES($1,$2,'private-output','log','runner',$3::jsonb,'current',$4)",
    [
      randomUUID(),
      childRunId,
      JSON.stringify({ kind: "inline", text: privateText }),
      privateText,
    ],
  );
  const revoke = async (): Promise<void> => {
    const grants = await database.pool.query<{ id: string; revision: number }>(
      "SELECT id,revision FROM company_grants WHERE principal_type='agent' AND principal_id=$1 AND action='knowledge:read' AND revoked_at IS NULL",
      [source.agentId],
    );

    for (const grant of grants.rows)
      await revokeCompanyGrant(database.db, source.submitterId, grant.id, {
        expectedRevision: grant.revision,
        reason: "Recheck current source authority before child disclosure.",
        idempotencyKey: `revoke:${grant.id}`,
      });
  };

  await revoke();
  const refused = await collect(parent.secret, childRunId);

  expect(refused.status).toBe(409);
  const refusal = await refused.text();

  expect(refusal).not.toContain(privateText);
  expect(refusal).not.toContain(source.witness.id);
  expect(
    (
      await database.pool.query(
        "SELECT first_collected_at FROM run_results WHERE run_id=$1",
        [childRunId],
      )
    ).rows,
  ).toEqual([{ first_collected_at: null }]);

  await createCompanyGrants(database.db, source.submitterId, {
    principalKind: "agent",
    principalId: source.agentId,
    actions: ["knowledge:read"],
    idempotencyKey: `restore:${parent.runId}`,
  });
  const accepted = await collect(parent.secret, childRunId);

  expect(accepted.status).toBe(200);
  const body = await accepted.text();

  expect(JSON.parse(body)).toMatchObject([
    {
      result: { value },
      resultRevision: 1,
      outputText: privateText,
      artifacts: [{ name: privateText }],
    },
  ]);
  const capture = (
    await database.pool.query<{ knowledge_access: KnowledgeAccessCapture }>(
      "SELECT knowledge_access FROM runs WHERE id=$1",
      [parent.runId],
    )
  ).rows[0]!.knowledge_access;

  expect(capture.restrictions).toContainEqual({
    kind: "company",
    companyId: source.companyId,
  });
  const marked = (
    await database.pool.query<{ first_collected_at: Date }>(
      "SELECT first_collected_at FROM run_results WHERE run_id=$1",
      [childRunId],
    )
  ).rows[0]!.first_collected_at;

  expect(marked).toBeInstanceOf(Date);
  expect(await (await collect(parent.secret, childRunId)).text()).toBe(body);
  await revoke();
  const revoked = await collect(parent.secret, childRunId);

  expect(revoked.status).toBe(409);
  expect(await revoked.text()).not.toContain(privateText);
  expect(
    (
      await database.pool.query(
        "SELECT first_collected_at FROM run_results WHERE run_id=$1",
        [childRunId],
      )
    ).rows[0]?.first_collected_at,
  ).toEqual(marked);
});

async function observedFindings(
  source: NativeFindingsExecution,
): Promise<EvidenceFindingsV1> {
  const counter = await captureKnowledgeSource(
    database.db,
    { kind: "user", userId: source.submitterId },
    {
      owner: { kind: "company", companyId: source.companyId },
      title: "Contradicting health observation",
      content:
        "A different retained observation reported a failing component health probe.",
      idempotencyKey: `counter:${source.runId}`,
    },
  );
  const first = {
    ...findings(source).findings[0]!,
    contradicting: [{ kind: "witness" as const, id: counter.witness.id }],
    missingEvidence: [
      {
        state: "absent" as const,
        reason:
          "No independent current-health verification has been collected.",
      },
    ],
    openQuestions: ["What is the component's health now?"],
  };

  return {
    ...findings(source),
    findings: [
      first,
      {
        ...first,
        id: "follow-up",
        assertion:
          "An independent current-health verification remains necessary.",
        basis: "inferred",
      },
    ],
  };
}

function reduce(
  source: EvidenceFindingsV1,
  childRunId: string,
): EvidenceFindingsV1 {
  const sourceFindings = source.findings.map((finding) => ({
    childRunId,
    resultRevision: 1,
    findingId: finding.id,
  }));

  return {
    schemaVersion: 1,
    findings: [
      {
        ...source.findings[0]!,
        id: "assessment",
        assertion:
          "Current health remains unresolved after the reported observations.",
        basis: "inferred",
        sourceFindings,
      },
    ],
    knowledgeProposals: [],
    selection: sourceFindings.map((origin) => ({
      ...origin,
      disposition: "combined",
      outputFindingIds: ["assessment"],
    })),
  };
}

async function finishChild(
  runId: string,
  value: EvidenceFindingsV1,
): Promise<void> {
  const { finalizeAgentRun } = await import("@/lib/agents/launch");

  expect(
    await finalizeAgentRun(runId, "Done", {
      db: database.db,
      finalOutput: { kind: "value", value },
    }),
  ).toMatchObject({ finalized: true, status: "Done" });
}

it("IT-CBE-05 bounds aggregate retained reduction bytes before hydrating source bodies", async () => {
  const source = await seedNativeFindingsExecution(database, agentContract);
  const parent = await coordinator(source);
  const input: EvidenceFindingsV1 = {
    ...findings(source),
    findings: Array.from({ length: 3 }, (_, index) => ({
      ...findings(source).findings[0]!,
      id: `bounded-${index}`,
      limitations: Array.from({ length: 32 }, () => "l".repeat(1000)),
      openQuestions: Array.from({ length: 32 }, () => "q".repeat(1000)),
    })),
  };
  const selection: EvidenceFindingsV1["selection"] = [];

  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(262144);
  for (let index = 0; index < 22; index++) {
    const childRunId = await child(source, parent.runId);

    await finishChild(childRunId, input);
    expect((await collect(parent.secret, childRunId)).status).toBe(200);
    selection.push(
      ...input.findings.map((finding) => ({
        childRunId,
        resultRevision: 1,
        findingId: finding.id,
        disposition: "omitted" as const,
        outputFindingIds: [],
        reason:
          "Source retained for inspection; no new conclusion is asserted.",
      })),
    );
    if (index === 19)
      await expect(
        database.db.transaction((tx) =>
          inspectFindingsReduction(tx, parent.runId, {
            schemaVersion: 1,
            findings: [],
            knowledgeProposals: [],
            selection,
          }),
        ),
      ).resolves.toMatchObject({ hasSources: true });
  }
  let queries = 0;

  await expect(
    database.db.transaction((tx) =>
      inspectFindingsReduction(
        {
          execute: async (query) => {
            queries++;

            return tx.execute(query);
          },
        },
        parent.runId,
        { schemaVersion: 1, findings: [], knowledgeProposals: [], selection },
      ),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "findings_reduction_invalid", path: "selection" },
  });
  expect(queries).toBe(1);
});

it("IT-CBE-05 accounts for every consumed source finding up to the bounded selection limit", async () => {
  const source = await seedNativeFindingsExecution(database, agentContract);
  const parent = await coordinator(source);
  const input: EvidenceFindingsV1 = {
    ...findings(source),
    findings: Array.from({ length: 32 }, (_, index) => ({
      ...findings(source).findings[0]!,
      id: `source-${index}`,
    })),
  };
  const selection: EvidenceFindingsV1["selection"] = [];

  for (let index = 0; index < 8; index++) {
    const childRunId = await child(source, parent.runId);

    await finishChild(childRunId, input);
    expect((await collect(parent.secret, childRunId)).status).toBe(200);
    selection.push(
      ...input.findings.map((finding) => ({
        childRunId,
        resultRevision: 1,
        findingId: finding.id,
        disposition: "omitted" as const,
        outputFindingIds: [],
        reason: "No combined claim is warranted by these collected findings.",
      })),
    );
  }
  const output: EvidenceFindingsV1 = {
    schemaVersion: 1,
    findings: [],
    knowledgeProposals: [],
    selection,
  };

  expect(selection).toHaveLength(256);
  await expect(
    database.db.transaction((tx) =>
      inspectFindingsReduction(tx, parent.runId, output),
    ),
  ).resolves.toMatchObject({ hasSources: true });
  const extra = await child(source, parent.runId);

  await finishChild(extra, findings(source));
  expect((await collect(parent.secret, extra)).status).toBe(200);
  await expect(finishCoordinator(parent, output)).rejects.toMatchObject({
    code: "PRECONDITION",
  });
  expect(
    (
      await database.pool.query(
        "SELECT validity,value FROM run_results WHERE run_id=$1",
        [parent.runId],
      )
    ).rows,
  ).toEqual([{ validity: "invalid", value: null }]);
});

async function finishCoordinator(
  target: Awaited<ReturnType<typeof coordinator>>,
  value: EvidenceFindingsV1,
): Promise<void> {
  const result = await database.db.transaction(async (tx) => {
    const outcome = await closeSucceededAttemptWithResult({
      db: tx,
      runId: target.runId,
      nodeId: "coordinator",
      nodeAttemptId: target.attemptId,
      patch: { vars: value },
      resultContract: flowContract,
      structuredOutput: {
        ok: true,
        value,
        valueBytes: Buffer.byteLength(JSON.stringify(value)),
      },
    });

    if (outcome.kind === "succeeded")
      await tx.execute(
        sql`UPDATE runs SET status='Done',ended_at=now(),current_step_id=NULL WHERE id=${target.runId}`,
      );

    return outcome;
  });

  assertSucceededAttemptResult(result);
}

type BrokenReduction = Readonly<{
  name: string;
  alter: (value: EvidenceFindingsV1) => EvidenceFindingsV1;
}>;
const brokenReductions: readonly BrokenReduction[] = [
  {
    name: "drops original support",
    alter: (value) => ({
      ...value,
      findings: [{ ...value.findings[0]!, supporting: [] }],
    }),
  },
  {
    name: "drops a contradiction",
    alter: (value) => ({
      ...value,
      findings: [{ ...value.findings[0]!, contradicting: [] }],
    }),
  },
  {
    name: "drops missing evidence",
    alter: (value) => ({
      ...value,
      findings: [{ ...value.findings[0]!, missingEvidence: [] }],
    }),
  },
  {
    name: "drops a limitation",
    alter: (value) => ({
      ...value,
      findings: [{ ...value.findings[0]!, limitations: [] }],
    }),
  },
  {
    name: "drops an unresolved question",
    alter: (value) => ({
      ...value,
      findings: [{ ...value.findings[0]!, openQuestions: [] }],
    }),
  },
  {
    name: "declares a novel combined conclusion observed",
    alter: (value) => ({
      ...value,
      findings: [{ ...value.findings[0]!, basis: "observed" }],
    }),
  },
  {
    name: "duplicates source accounting",
    alter: (value) => ({
      ...value,
      selection: [...value.selection, value.selection[0]!],
    }),
  },
  {
    name: "silently excludes another consumed finding",
    alter: (value) => ({
      ...value,
      selection: [value.selection[0]!],
      findings: [
        {
          ...value.findings[0]!,
          sourceFindings: [value.findings[0]!.sourceFindings[0]!],
        },
      ],
    }),
  },
  {
    name: "names an uncollected revision",
    alter: (value) => ({
      ...value,
      selection: value.selection.map((entry) => ({
        ...entry,
        resultRevision: 2,
      })),
      findings: [
        {
          ...value.findings[0]!,
          sourceFindings: value.findings[0]!.sourceFindings.map((entry) => ({
            ...entry,
            resultRevision: 2,
          })),
        },
      ],
    }),
  },
  {
    name: "names a nonexistent finding",
    alter: (value) => ({
      ...value,
      selection: value.selection.map((entry, index) =>
        index === 0 ? { ...entry, findingId: "invented" } : entry,
      ),
      findings: [
        {
          ...value.findings[0]!,
          sourceFindings: value.findings[0]!.sourceFindings.map(
            (entry, index) =>
              index === 0 ? { ...entry, findingId: "invented" } : entry,
          ),
        },
      ],
    }),
  },
  {
    name: "omits without an actionable reason",
    alter: (value) => ({
      ...value,
      selection: value.selection.map((entry, index) =>
        index === 0
          ? { ...entry, disposition: "omitted", outputFindingIds: [] }
          : entry,
      ),
      findings: [
        {
          ...value.findings[0]!,
          sourceFindings: value.findings[0]!.sourceFindings.slice(1),
        },
      ],
    }),
  },
  {
    name: "maps to an absent output",
    alter: (value) => ({
      ...value,
      selection: value.selection.map((entry, index) =>
        index === 0 ? { ...entry, outputFindingIds: ["absent-output"] } : entry,
      ),
    }),
  },
];

it.each(brokenReductions)(
  "IT-CBE-05 refuses a reduction that $name at actual result publication",
  async ({ name, alter }) => {
    const source = await seedNativeFindingsExecution(database, agentContract);
    const parent = await coordinator(source);
    const childRunId = await child(source, parent.runId);
    const input = await observedFindings(source);

    await finishChild(childRunId, input);
    expect((await collect(parent.secret, childRunId)).status).toBe(200);
    if (name === "drops original support") {
      const value = alter(reduce(input, childRunId));
      const diagnostic = await database.db.transaction((tx) =>
        validateFindingsReferences(
          tx,
          parent.runId,
          flowContract,
          {
            kind: "valid",
            value,
            valueBytes: Buffer.byteLength(JSON.stringify(value)),
          },
          parent.attemptId,
        ),
      );

      expect(diagnostic).toMatchObject({
        kind: "invalid",
        reason: "reference_invalid",
        message:
          "Native findings reduction is invalid at selection[0]; preserve the exact collected finding and its evidence, limitations and questions",
      });
    }
    await expect(
      finishCoordinator(parent, alter(reduce(input, childRunId))),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(
      (
        await database.pool.query(
          "SELECT validity,value,invalid_reason FROM run_results WHERE run_id=$1",
          [parent.runId],
        )
      ).rows,
    ).toEqual([
      { validity: "invalid", value: null, invalid_reason: "reference_invalid" },
    ]);
  },
);

it("IT-CBE-05 preserves original evidence through depth-2 reduction without granting direct grandchild collection or confirming knowledge", async () => {
  const source = await seedNativeFindingsExecution(database, agentContract);
  const root = await coordinator(source);
  const intermediate = await coordinator(source, root.runId);
  const leaf = await child(source, intermediate.runId);
  const input = await observedFindings(source);

  await finishChild(leaf, input);
  expect((await collect(intermediate.secret, leaf)).status).toBe(200);
  const intermediateValue = reduce(input, leaf);
  const leafResult = { kind: "result" as const, id: leaf, revision: 1 };
  const withOriginalResult = {
    ...intermediateValue,
    findings: [
      {
        ...intermediateValue.findings[0]!,
        supporting: [...intermediateValue.findings[0]!.supporting, leafResult],
      },
    ],
  };

  await finishCoordinator(intermediate, withOriginalResult);
  expect((await collect(root.secret, intermediate.runId)).status).toBe(200);
  const forbidden = await collect(root.secret, leaf);

  expect(forbidden.status).toBe(409);
  expect(await forbidden.text()).toContain("not a child");
  const output = reduce(withOriginalResult, intermediate.runId);

  await expect(finishCoordinator(root, output)).resolves.toBeUndefined();
  const stored = (
    await database.pool.query<{ value: EvidenceFindingsV1 }>(
      "SELECT value FROM run_results WHERE run_id=$1 AND validity='valid'",
      [root.runId],
    )
  ).rows[0]!.value;

  expect(stored.findings[0]?.supporting).toContainEqual(leafResult);
  expect(stored.findings[0]?.supporting).toContainEqual(
    input.findings[0]!.supporting[0]!,
  );
  expect(stored.findings[0]?.contradicting).toEqual(
    input.findings[0]!.contradicting,
  );
  expect(stored.findings[0]?.sourceFindings).toEqual([
    {
      childRunId: intermediate.runId,
      resultRevision: 1,
      findingId: "assessment",
    },
  ]);
  expect(
    (
      await getKnowledgeRecord(
        database.db,
        { kind: "user", userId: source.submitterId },
        { recordId: source.recordId },
      )
    ).confirmation.state,
  ).toBe("unconfirmed");
});

it("IT-CBE-06 the run-result DTO requires its actual receiving user's current source authority", async () => {
  const source = await seedNativeFindingsExecution(database, agentContract);
  const parent = await coordinator(source);
  const childRunId = await child(source, parent.runId);
  const value = findings(source);

  await finishChild(childRunId, value);
  const userId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), source.projectId, userId],
  );
  const { loadRunPublicResult } = await import("@/lib/runs/run-result-dto");
  const recipient = { kind: "user" as const, userId };

  await expect(
    loadRunPublicResult(database.db, childRunId, recipient),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await createCompanyGrants(database.db, source.submitterId, {
    principalKind: "user",
    principalId: userId,
    actions: ["knowledge:read"],
    idempotencyKey: `reader:${childRunId}`,
  });
  await expect(
    loadRunPublicResult(database.db, childRunId, recipient),
  ).resolves.toMatchObject({ value, resultStatus: "valid" });
  await database.pool.query(
    "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
    [source.projectId, userId],
  );
  await expect(
    loadRunPublicResult(database.db, childRunId, recipient),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
});

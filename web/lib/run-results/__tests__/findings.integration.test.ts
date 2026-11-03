import type { KnowledgeAccessCapture } from "@/lib/company/types";
import type { EvidenceFindingsV1 } from "@/lib/run-results/findings-types";
import type { RunResultContract } from "@/lib/run-results/types";
import type { KnowledgeReference } from "@/lib/brain/knowledge-types";
import type { NativeFindingsExecution } from "@/test-support/native-findings-seed";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  buildAgentProfileContract,
  buildFlowExportContract,
} from "@/lib/run-results/contract";
import { runAgentStep } from "@/lib/flows/runner-agent";
import { validateNodeStructuredOutput } from "@/lib/flows/graph/node-output";
import { closeSucceededAttemptWithResult } from "@/lib/run-results/close-attempt";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import { seedNativeFindingsExecution } from "@/test-support/native-findings-seed";
import { resolveFlowBoundAgent } from "@/lib/agents/flow-binding";
import {
  issueNativeNodeRunToken,
  issueOrchestratorRunToken,
} from "@/lib/agents/tokens";
import { issueAgentRunToken } from "@/lib/agents/tokens";
import { assertNativeRunKnowledgeInputs } from "@/lib/brain/knowledge-execution-access";
import { createKnowledgeProposal } from "@/lib/brain/knowledge-proposals";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { nativeKnowledgeCaptureAtLaunch } from "@/lib/brain/knowledge-launch-capture";

let database: StartedPostgresTestDb;
let finalizeAgentRun: typeof import("@/lib/agents/launch").finalizeAgentRun;

// Bind server defaults to the same real, owned database as the explicit finalizer dependency.
vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

const missingEvidenceFindings: EvidenceFindingsV1 = {
  schemaVersion: 1,
  findings: [
    {
      id: "unresolved-health",
      assertion:
        "The configured component's current health has not been observed.",
      basis: "unknown",
      supporting: [],
      contradicting: [],
      missingEvidence: [
        {
          state: "absent",
          reason: "A separate authorized health observation is still required.",
        },
      ],
      limitations: [],
      openQuestions: ["What is the component's current health?"],
      sourceFindings: [],
    },
  ],
  knowledgeProposals: [],
  selection: [],
};

const legacyContract = buildAgentProfileContract({
  profileName: "findings",
  flowRefId: "native-rah",
  resolvedRevision: "a".repeat(40),
  sourceFlowRevisionId: "retained-profile-revision",
  schemaStem: "findings.v1",
  schemaVersion: 1,
  sha256: "b".repeat(64),
  schema: {
    schemaVersion: 1,
    fields: [
      { name: "schemaVersion", type: "number", required: true },
      {
        name: "findings",
        type: "array",
        items: { type: "json" },
        required: true,
      },
      {
        name: "knowledgeProposals",
        type: "array",
        items: { type: "json" },
        required: true,
      },
      {
        name: "selection",
        type: "array",
        items: { type: "json" },
        required: true,
      },
    ],
  },
});
const nativeContract: RunResultContract = {
  ...legacyContract,
  nativeContract: "evidence_findings_v1",
};
const nativeFlowContract = buildFlowExportContract({
  flowRefId: "native-rah",
  resolvedRevision: "a".repeat(40),
  flowRevisionId: "retained-flow-revision",
  schemaPath: "./schemas/findings.v1.json",
  schema: legacyContract.schema,
  sha256: legacyContract.sha256,
  required: true,
  producerNodeIds: ["findings"],
  nativeContract: "evidence_findings_v1",
});

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "native_findings_publication",
  });
  ({ finalizeAgentRun } = await import("@/lib/agents/launch"));
}, 180000);

afterAll(async () => {
  await database?.stop();
});

const cases: readonly Readonly<{
  name: string;
  frozen: RunResultContract;
  value: unknown;
  status: "Done" | "Failed";
}>[] = [
  {
    name: "permits an explicit missing-evidence finding without inventing a citation",
    frozen: nativeContract,
    value: missingEvidenceFindings,
    status: "Done",
  },
  {
    name: "rejects producer-declared confirmation authority",
    frozen: nativeContract,
    value: { ...missingEvidenceFindings, confirmed: true },
    status: "Failed",
  },
  {
    name: "rejects duplicate local finding identities",
    frozen: nativeContract,
    value: {
      ...missingEvidenceFindings,
      findings: [
        missingEvidenceFindings.findings[0],
        missingEvidenceFindings.findings[0],
      ],
    },
    status: "Failed",
  },
  {
    name: "rejects an unsupported native version",
    frozen: nativeContract,
    value: { ...missingEvidenceFindings, schemaVersion: 2 },
    status: "Failed",
  },
  {
    name: "enforces the native findings bound",
    frozen: nativeContract,
    value: {
      ...missingEvidenceFindings,
      findings: Array.from({ length: 33 }, (_, index) => ({
        ...missingEvidenceFindings.findings[0],
        id: `finding-${index}`,
      })),
    },
    status: "Failed",
  },
  {
    name: "refuses an invented witness identity",
    frozen: nativeContract,
    value: {
      ...missingEvidenceFindings,
      findings: [
        {
          ...missingEvidenceFindings.findings[0],
          supporting: [{ kind: "witness", id: "nonexistent-witness" }],
          missingEvidence: [],
        },
      ],
    },
    status: "Failed",
  },
  {
    name: "keeps an undeclared historical profile's original open JSON meaning",
    frozen: legacyContract,
    value: { ...missingEvidenceFindings, confirmed: true },
    status: "Done",
  },
];

it.each(cases)(
  "IT-CBE-04 native result publication $name",
  async ({ frozen, value, status }) => {
    const project = await seedProjectRow(database.db);
    const runId = await seedRun(database.db, {
      projectId: project.id,
      runKind: "agent",
      status: "Running",
      agentWorkspace: "none",
    });

    await database.pool.query(
      "UPDATE runs SET result_contract=$2::jsonb,knowledge_access=$3::jsonb WHERE id=$1",
      [
        runId,
        JSON.stringify(frozen),
        JSON.stringify({
          schemaVersion: 1,
          state: "complete",
          generation: 1,
          restrictions: [],
        }),
      ],
    );
    expect(
      await finalizeAgentRun(runId, "Done", {
        db: database.db,
        finalOutput: { kind: "value", value },
      }),
    ).toMatchObject({ finalized: true, status });
    const result = (
      await database.pool.query(
        "SELECT validity,value,schema_sha256,producer_kind FROM run_results WHERE run_id=$1",
        [runId],
      )
    ).rows;

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      validity: status === "Done" ? "valid" : "invalid",
      value: status === "Done" ? value : null,
      schema_sha256: frozen.sha256,
      producer_kind: "agent_session",
    });
    const events = await database.pool.query(
      "SELECT kind FROM domain_events WHERE run_id=$1 AND kind IN ('run.done','run.failed')",
      [runId],
    );

    expect(events.rows).toEqual([
      { kind: status === "Done" ? "run.done" : "run.failed" },
    ]);
  },
);

it("IT-CBE-04 rejects forged authority at the Flow producer seam before accepting intermediate vars", async () => {
  const project = await seedProjectRow(database.db);
  const runId = await seedRun(database.db, {
    projectId: project.id,
    status: "Running",
  });
  const attemptId = randomUUID();

  await database.pool.query(
    "INSERT INTO node_attempts(id,run_id,node_id,node_type,status) VALUES ($1,$2,'findings','judge','Running')",
    [attemptId, runId],
  );
  const contract = buildFlowExportContract({
    flowRefId: "native-rah",
    resolvedRevision: "a".repeat(40),
    flowRevisionId: "retained-flow-revision",
    schemaPath: "./schemas/findings.v1.json",
    schema: legacyContract.schema,
    sha256: legacyContract.sha256,
    required: true,
    producerNodeIds: ["findings"],
    nativeContract: "evidence_findings_v1",
  });
  const result = {
    stdout: `\u0060\u0060\u0060json maister:output\n${JSON.stringify({ ...missingEvidenceFindings, confirmed: true })}\n\u0060\u0060\u0060`,
    vars: {},
  };
  const verdict = await validateNodeStructuredOutput({
    db: database.db,
    node: {
      id: "findings",
      nodeType: "judge",
      output: { result: { schema: "./schemas/findings.v1.json" } },
    },
    result,
    runId,
    nodeAttemptId: attemptId,
    attempt: 1,
    projectSlug: project.slug,
    runtimeRoot: "/unused-native-findings",
    flowInstallPath: "/unused-native-findings",
    resultContract: contract,
  });

  expect(verdict.ok).toBe(false);
  expect(result.vars).toEqual({});
  expect(
    (
      await database.pool.query(
        "SELECT status,error_code,output_contract FROM node_attempts WHERE id=$1",
        [attemptId],
      )
    ).rows[0],
  ).toMatchObject({
    status: "Failed",
    error_code: "CONFIG",
    output_contract: { sha256: contract.sha256 },
  });
  expect(
    (
      await database.pool.query("SELECT id FROM run_results WHERE run_id=$1", [
        runId,
      ])
    ).rows,
  ).toEqual([]);
});

type ReferenceCase = Readonly<{
  name: string;
  reference: (execution: NativeFindingsExecution) => KnowledgeReference | null;
  prepare?: (execution: NativeFindingsExecution) => Promise<void>;
  status: "Done" | "Failed";
}>;

const referenceCases: readonly ReferenceCase[] = [
  {
    name: "accepts an authorized immutable witness with its exact content witness",
    reference: (e) => ({
      kind: "witness",
      id: e.witness.id,
      version: e.witness.sourceVersion!,
      sha256: e.witness.sha256!,
    }),
    status: "Done",
  },
  {
    name: "accepts an exact accepted record revision",
    reference: (e) => ({ kind: "knowledge", id: e.recordId, revision: 1 }),
    status: "Done",
  },
  {
    name: "refuses an invented witness under a valid execution identity",
    reference: () => ({ kind: "witness", id: "invented-native-witness" }),
    status: "Failed",
  },
  {
    name: "refuses a mismatched witness digest",
    reference: (e) => ({
      kind: "witness",
      id: e.witness.id,
      sha256: "0".repeat(64),
    }),
    status: "Failed",
  },
  {
    name: "refuses a mismatched source version",
    reference: (e) => ({
      kind: "witness",
      id: e.witness.id,
      version: "different-source-version",
    }),
    status: "Failed",
  },
  {
    name: "refuses a record revision attached to an immutable witness",
    reference: (e) => ({ kind: "witness", id: e.witness.id, revision: 1 }),
    status: "Failed",
  },
  {
    name: "refuses a floating record reference",
    reference: (e) => ({ kind: "knowledge", id: e.recordId }),
    status: "Failed",
  },
  {
    name: "refuses a nonexistent exact record revision",
    reference: (e) => ({ kind: "knowledge", id: e.recordId, revision: 2 }),
    status: "Failed",
  },
  {
    name: "refuses an operation without its operation-owner resolver",
    reference: () => ({ kind: "operation", id: "claimed-success" }),
    status: "Failed",
  },
  {
    name: "refuses current record access revoked after execution began",
    reference: (e) => ({ kind: "knowledge", id: e.recordId, revision: 1 }),
    prepare: async (e) => {
      await database.pool.query(
        "UPDATE company_grants SET revoked_at=now(),revision=revision+1 WHERE principal_type='agent' AND principal_id=$1 AND action='knowledge:read'",
        [e.agentId],
      );
    },
    status: "Failed",
  },
  {
    name: "records completed work after transport revocation under current role/source authority",
    reference: (e) => ({ kind: "witness", id: e.witness.id }),
    prepare: async (e) => {
      await database.pool.query(
        "UPDATE project_tokens SET revoked_at=now() WHERE id=$1",
        [e.tokenId],
      );
    },
    status: "Done",
  },
  {
    name: "refuses unknown historical capture even when citations are omitted",
    reference: () => null,
    prepare: async (e) => {
      await database.pool.query(
        "UPDATE runs SET knowledge_access=NULL WHERE id=$1",
        [e.runId],
      );
    },
    status: "Failed",
  },
  {
    name: "cannot shed revoked source restrictions by omitting every citation",
    reference: () => null,
    prepare: async (e) => {
      await database.pool.query(
        "UPDATE runs SET knowledge_access=jsonb_set(knowledge_access,'{restrictions}',$2::jsonb) WHERE id=$1",
        [
          e.runId,
          JSON.stringify([{ kind: "company", companyId: e.companyId }]),
        ],
      );
      await database.pool.query(
        "UPDATE company_grants SET revoked_at=now(),revision=revision+1 WHERE principal_type='agent' AND principal_id=$1 AND action='knowledge:read'",
        [e.agentId],
      );
    },
    status: "Failed",
  },
];

it.each(referenceCases)(
  "IT-CBE-04 native references $name",
  async ({ reference, prepare, status }) => {
    const execution = await seedNativeFindingsExecution(
      database,
      nativeContract,
    );

    await prepare?.(execution);
    const selected = reference(execution);
    const value: EvidenceFindingsV1 = {
      ...missingEvidenceFindings,
      findings: [
        {
          ...missingEvidenceFindings.findings[0]!,
          supporting: selected ? [selected, selected] : [],
        },
      ],
    };

    expect(
      await finalizeAgentRun(execution.runId, "Done", {
        db: database.db,
        finalOutput: { kind: "value", value },
      }),
    ).toMatchObject({ finalized: true, status });
    const result = await database.pool.query(
      "SELECT validity,value,invalid_reason FROM run_results WHERE run_id=$1",
      [execution.runId],
    );

    expect(result.rows).toEqual([
      expect.objectContaining({
        validity: status === "Done" ? "valid" : "invalid",
        value: status === "Done" ? value : null,
        invalid_reason: status === "Done" ? null : "reference_invalid",
      }),
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT id FROM brain_confirmations WHERE record_id=$1",
          [execution.recordId],
        )
      ).rows,
    ).toEqual([]);
    if (status === "Done") {
      const retained = await database.pool.query(
        "SELECT knowledge_access FROM runs WHERE id=$1",
        [execution.runId],
      );

      expect(retained.rows[0]?.knowledge_access.restrictions).toContainEqual({
        kind: "company",
        companyId: execution.companyId,
      });
      expect(
        (
          await database.pool.query(
            "SELECT revoked_at FROM project_tokens WHERE id=$1",
            [execution.tokenId],
          )
        ).rows[0]?.revoked_at,
      ).toBeInstanceOf(Date);
    }
  },
);

it("IT-CBE-04 rechecks current source authority in the transaction that closes a Flow producer", async () => {
  const execution = await seedNativeFindingsExecution(
    database,
    nativeFlowContract,
  );
  const role = (
    await database.pool.query<{ agent_activity_snapshot: unknown }>(
      "SELECT agent_activity_snapshot FROM runs WHERE id=$1",
      [execution.runId],
    )
  ).rows[0]!;
  const flowRunId = await seedRun(database.db, {
    projectId: execution.projectId,
    runKind: "flow",
    status: "Running",
  });

  await database.pool.query(
    "UPDATE runs SET current_step_id='findings',launched_at=now(),activity_sort_at=now(),activity_timestamp_provenance='launch',source_agent_id=$2,agent_activity_snapshot=$3::jsonb,result_contract=$4::jsonb,knowledge_access=$5::jsonb WHERE id=$1",
    [
      flowRunId,
      execution.agentId,
      JSON.stringify(role.agent_activity_snapshot),
      JSON.stringify(nativeFlowContract),
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [],
      }),
    ],
  );
  const attemptId = randomUUID();

  await database.pool.query(
    "INSERT INTO node_attempts(id,run_id,node_id,node_type,status) VALUES ($1,$2,'findings','judge','Running')",
    [attemptId, flowRunId],
  );
  const value: EvidenceFindingsV1 = {
    ...missingEvidenceFindings,
    findings: [
      {
        ...missingEvidenceFindings.findings[0]!,
        supporting: [{ kind: "witness", id: execution.witness.id }],
      },
    ],
  };
  const structuredOutput = await validateNodeStructuredOutput({
    db: database.db,
    node: {
      id: "findings",
      nodeType: "judge",
      output: { result: { schema: "./schemas/findings.v1.json" } },
    },
    result: { stdout: "", originalOutput: { kind: "value", value }, vars: {} },
    runId: flowRunId,
    nodeAttemptId: attemptId,
    attempt: 1,
    projectSlug: "native-findings",
    runtimeRoot: "/unused-native-findings",
    flowInstallPath: "/unused-native-findings",
    resultContract: nativeFlowContract,
  });

  expect(structuredOutput.ok).toBe(true);
  await database.pool.query(
    "UPDATE company_grants SET revoked_at=now(),revision=revision+1 WHERE principal_type='agent' AND principal_id=$1 AND action='knowledge:read'",
    [execution.agentId],
  );
  const capture = (
    await database.pool.query<{ knowledge_access: KnowledgeAccessCapture }>(
      "SELECT knowledge_access FROM runs WHERE id=$1",
      [flowRunId],
    )
  ).rows[0]!.knowledge_access;
  const bindExecution = vi.fn(async (): Promise<never> => {
    throw new Error("A revoked source must be refused before host binding");
  });
  const executor = {
    id: "native-source-guard",
    agent: "codex" as const,
    model: "qualification",
  };

  await expect(
    runAgentStep(
      {
        id: "findings",
        type: "agent",
        mode: "new-session",
        prompt: "Continue using retained evidence.",
      },
      {
        db: database.db,
        runId: flowRunId,
        runtimeRoot: "/unused-native-findings",
        worktreePath: "/unused-native-findings",
        projectSlug: "native-findings",
        stepId: "findings",
        sessionName: "findings",
        nodeAttemptId: attemptId,
        promptOwner: {
          variant: "node",
          nodeAttemptId: attemptId,
          promptOrdinal: 1,
        },
        resultContract: nativeFlowContract,
        knowledgeAccess: capture,
        executor,
        bindExecution,
        context: {
          task: {
            id: "native-source-task",
            title: "Native source check",
            prompt: "Continue using retained evidence.",
            effectivePrompt: "Continue using retained evidence.",
            clarifications: [],
            attemptNumber: 1,
          },
          run: {
            id: flowRunId,
            attemptNumber: 1,
            projectSlug: "native-findings",
          },
          executor,
          steps: {},
          env: {},
          artifacts: {},
        },
      },
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  expect(bindExecution).not.toHaveBeenCalled();
  await expect(
    closeSucceededAttemptWithResult({
      db: database.db,
      runId: flowRunId,
      nodeId: "findings",
      nodeAttemptId: attemptId,
      patch: { vars: value },
      resultContract: nativeFlowContract,
      structuredOutput,
    }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "native_findings_reference_unavailable" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT status,error_code FROM node_attempts WHERE id=$1",
        [attemptId],
      )
    ).rows,
  ).toEqual([{ status: "Failed", error_code: "PRECONDITION" }]);
  expect(
    (
      await database.pool.query(
        "SELECT validity,value,invalid_reason FROM run_results WHERE run_id=$1",
        [flowRunId],
      )
    ).rows,
  ).toEqual([
    { validity: "invalid", value: null, invalid_reason: "reference_invalid" },
  ]);
});

it("IT-CBE-04 keeps unknown historical node actors, freezes new attestations and permits project deletion", async () => {
  const execution = await seedNativeFindingsExecution(
    database,
    nativeFlowContract,
  );
  const attemptId = randomUUID();

  await database.pool.query(
    "INSERT INTO node_attempts(id,run_id,node_id,node_type,status) VALUES ($1,$2,'findings','orchestrator','Running')",
    [attemptId, execution.runId],
  );
  expect(
    (
      await database.pool.query(
        "SELECT knowledge_actor FROM node_attempts WHERE id=$1",
        [attemptId],
      )
    ).rows,
  ).toEqual([{ knowledge_actor: null }]);
  const actor = {
    schemaVersion: 1,
    agentId: execution.agentId,
    packageInstallId: "retained-install-identity",
    packageName: "retained-package",
    definitionSha256: "a".repeat(64),
  };

  await expect(
    database.pool.query(
      "UPDATE node_attempts SET knowledge_actor=$2::jsonb WHERE id=$1",
      [attemptId, JSON.stringify({ ...actor, schemaVersion: 2 })],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await database.pool.query(
    "UPDATE node_attempts SET knowledge_actor=$2::jsonb WHERE id=$1",
    [attemptId, JSON.stringify(actor)],
  );
  await expect(
    database.pool.query(
      "UPDATE node_attempts SET knowledge_actor=$2::jsonb WHERE id=$1",
      [attemptId, JSON.stringify({ ...actor, agentId: "replacement-role" })],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "node_attempts_knowledge_actor_immutable",
  });
  await expect(
    database.pool.query(
      "UPDATE node_attempts SET knowledge_actor=NULL WHERE id=$1",
      [attemptId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "node_attempts_knowledge_actor_immutable",
  });
  await database.pool.query("DELETE FROM projects WHERE id=$1", [
    execution.projectId,
  ]);
  expect(
    (
      await database.pool.query("SELECT id FROM node_attempts WHERE id=$1", [
        attemptId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await database.pool.query("SELECT id FROM brain_items WHERE id=$1", [
        execution.recordId,
      ])
    ).rows,
  ).toEqual([{ id: execution.recordId }]);
});

it("IT-CBE-04 binds native coordinator knowledge authority to its executed role and exact current node attempt", async () => {
  const evidence = await seedNativeFindingsExecution(
    database,
    nativeFlowContract,
  );
  const runId = await seedRun(database.db, {
    projectId: evidence.projectId,
    runKind: "flow",
    status: "Running",
  });
  const execution = { ...evidence, runId };

  await database.pool.query(
    "UPDATE runs SET current_step_id='findings',result_contract=$2::jsonb,knowledge_access=$3::jsonb WHERE id=$1",
    [
      runId,
      JSON.stringify(nativeFlowContract),
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [],
      }),
    ],
  );
  const directory = await mkdtemp(join(tmpdir(), "native-coordinator-actor-"));

  try {
    await mkdir(join(directory, "maister-agents"));
    const sourcePath = join(directory, "maister-agents", "researcher.md");
    const definition =
      "---\nname: Researcher\ndescription: Evidence-linked coordinator\nworkspace: none\nmode: session\ntriggers: [flow]\nrisk_tier: read_only\n---\nCoordinate bounded evidence-linked research.\n";

    await writeFile(sourcePath, definition);
    const installation = (
      await database.pool.query<{ id: string; name: string }>(
        "UPDATE package_installs SET installed_path=$2 WHERE name=(SELECT package_name FROM agents WHERE id=$1) RETURNING id,name",
        [execution.agentId, directory],
      )
    ).rows[0]!;

    await database.pool.query("UPDATE agents SET source_path=$2 WHERE id=$1", [
      execution.agentId,
      sourcePath,
    ]);
    const attemptId = randomUUID();

    await database.pool.query(
      "INSERT INTO node_attempts(id,run_id,node_id,node_type,status) VALUES ($1,$2,'findings','orchestrator','Running')",
      [attemptId, execution.runId],
    );
    const binding = {
      agentId: execution.agentId,
      runId: execution.runId,
      nodeAttemptId: attemptId,
      executorAgent: "claude",
      worktreePath: directory,
      db: database.db,
    };

    expect(await resolveFlowBoundAgent(binding)).toMatchObject({
      mode: "session",
      prompt: "Coordinate bounded evidence-linked research.",
    });
    const actor = (
      await database.pool.query(
        "SELECT knowledge_actor FROM node_attempts WHERE id=$1",
        [attemptId],
      )
    ).rows[0]?.knowledge_actor;

    expect(actor).toEqual({
      schemaVersion: 1,
      agentId: execution.agentId,
      packageInstallId: installation.id,
      packageName: installation.name,
      definitionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await database.pool.query(
      "UPDATE project_tokens SET revoked_at=now() WHERE id=$1",
      [execution.tokenId],
    );
    const nodeToken = await issueNativeNodeRunToken({
      projectId: execution.projectId,
      runId: execution.runId,
      nodeAttemptId: attemptId,
      db: database.db,
    });
    const nodeScopes = (
      await database.pool.query<{ scopes: string[] }>(
        "SELECT scopes FROM project_tokens WHERE id=$1",
        [nodeToken.tokenId],
      )
    ).rows[0]!.scopes;

    expect(nodeScopes).toContain("knowledge:read");
    expect(nodeScopes).not.toContain("runs:delegate");
    await expect(
      getKnowledgeRecord(
        database.db,
        { kind: "token", tokenId: nodeToken.tokenId },
        { recordId: execution.recordId },
      ),
    ).resolves.toMatchObject({ id: execution.recordId });
    const token = await issueOrchestratorRunToken({
      projectId: execution.projectId,
      runId: execution.runId,
      nodeAttemptId: attemptId,
      db: database.db,
    });

    expect(
      (
        await database.pool.query(
          "SELECT knowledge_node_attempt_id FROM project_tokens WHERE id=$1",
          [token.tokenId],
        )
      ).rows[0],
    ).toEqual({ knowledge_node_attempt_id: attemptId });
    const principal = { kind: "token" as const, tokenId: token.tokenId };

    await expect(
      getKnowledgeRecord(database.db, principal, {
        recordId: execution.recordId,
        revision: 1,
      }),
    ).resolves.toMatchObject({ id: execution.recordId });
    await database.pool.query(
      "UPDATE node_attempts SET status='Succeeded' WHERE id=$1",
      [attemptId],
    );
    await expect(
      getKnowledgeRecord(database.db, principal, {
        recordId: execution.recordId,
        revision: 1,
      }),
    ).resolves.toMatchObject({ id: execution.recordId });
    await expect(
      database.pool.query(
        "UPDATE project_tokens SET knowledge_node_attempt_id=NULL WHERE id=$1",
        [token.tokenId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "project_tokens_knowledge_node_attempt_immutable",
    });
    await writeFile(
      sourcePath,
      `${definition}\nA changed definition cannot replace the executing role.\n`,
    );
    await expect(resolveFlowBoundAgent(binding)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "native_knowledge_actor_changed" },
    });
    await database.pool.query(
      "INSERT INTO node_attempts(id,run_id,node_id,node_type,status,attempt) VALUES($1,$2,'findings','orchestrator','Running',2)",
      [randomUUID(), execution.runId],
    );
    await expect(
      getKnowledgeRecord(database.db, principal, {
        recordId: execution.recordId,
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await database.pool.query(
      "UPDATE runs SET current_step_id='next-node' WHERE id=$1",
      [execution.runId],
    );
    await expect(
      getKnowledgeRecord(database.db, principal, {
        recordId: execution.recordId,
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await database.pool.query("DELETE FROM projects WHERE id=$1", [
      execution.projectId,
    ]);
    expect(
      (
        await database.pool.query("SELECT id FROM project_tokens WHERE id=$1", [
          token.tokenId,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await database.pool.query("SELECT id FROM brain_items WHERE id=$1", [
          execution.recordId,
        ])
      ).rows,
    ).toEqual([{ id: execution.recordId }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("IT-CBE-04 inherits the complete parent source union and refuses to upgrade unknown historical capture", async () => {
  const project = await seedProjectRow(database.db);
  const parentRunId = await seedRun(database.db, { projectId: project.id });

  await expect(
    database.db.transaction((tx) =>
      nativeKnowledgeCaptureAtLaunch(tx, nativeContract, {
        parentRunId,
        sourceRestrictions: [
          { kind: "project_context", projectId: project.id },
        ],
      }),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "knowledge_capture_profile_required" },
  });
  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      parentRunId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 7,
        restrictions: [
          { kind: "project", projectId: project.id },
          { kind: "record", recordId: "retained-private-source" },
        ],
      }),
    ],
  );
  const capture = await database.db.transaction((tx) =>
    nativeKnowledgeCaptureAtLaunch(tx, nativeContract, {
      parentRunId,
      sourceRestrictions: [{ kind: "project_context", projectId: project.id }],
    }),
  );

  expect(capture).toMatchObject({
    schemaVersion: 1,
    state: "complete",
    generation: 1,
  });
  expect(capture?.restrictions).toHaveLength(3);
  expect(capture?.restrictions).toEqual(
    expect.arrayContaining([
      { kind: "project", projectId: project.id },
      { kind: "project_context", projectId: project.id },
      { kind: "record", recordId: "retained-private-source" },
    ]),
  );
  expect(
    await database.db.transaction((tx) =>
      nativeKnowledgeCaptureAtLaunch(tx, legacyContract, {
        parentRunId,
        sourceRestrictions: [
          { kind: "project_context", projectId: project.id },
        ],
      }),
    ),
  ).toEqual(capture);
  expect(
    await database.db.transaction((tx) =>
      nativeKnowledgeCaptureAtLaunch(tx, legacyContract, {
        parentRunId: null,
        sourceRestrictions: [
          { kind: "project_context", projectId: project.id },
        ],
      }),
    ),
  ).toBeNull();
});

it("IT-CBE-04 accepts renewed credentials for the same immutable specialist identity and revokes every lease on completion", async () => {
  const execution = await seedNativeFindingsExecution(database, nativeContract);

  await issueAgentRunToken({
    agentId: execution.agentId,
    projectId: execution.projectId,
    runId: execution.runId,
    db: database.db,
  });
  await expect(
    assertNativeRunKnowledgeInputs(database.db, execution.runId),
  ).resolves.toBeUndefined();
  const value: EvidenceFindingsV1 = {
    ...missingEvidenceFindings,
    findings: [
      {
        ...missingEvidenceFindings.findings[0]!,
        supporting: [{ kind: "witness", id: execution.witness.id }],
      },
    ],
  };

  expect(
    await finalizeAgentRun(execution.runId, "Done", {
      db: database.db,
      finalOutput: { kind: "value", value },
    }),
  ).toMatchObject({ finalized: true, status: "Done" });
  const tokens = await database.pool.query<{ revoked_at: Date }>(
    "SELECT revoked_at FROM project_tokens WHERE name=$1",
    [`agent-run:${execution.runId}`],
  );

  expect(tokens.rows).toHaveLength(2);
  expect(tokens.rows.every((token) => token.revoked_at instanceof Date)).toBe(
    true,
  );
});

it("IT-CBE-04 server inspection reads completed evidence without an API lease and cannot publish knowledge", async () => {
  const execution = await seedNativeFindingsExecution(database, nativeContract);

  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'agent',$2,'knowledge:propose',$3)",
    [execution.companyId, execution.agentId, execution.submitterId],
  );
  await database.pool.query(
    "UPDATE project_tokens SET revoked_at=now() WHERE id=$1",
    [execution.tokenId],
  );
  await expect(
    getKnowledgeRecord(
      database.db,
      { kind: "token", tokenId: execution.tokenId },
      { recordId: execution.recordId },
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const principal = {
    kind: "execution" as const,
    runId: execution.runId,
    nodeAttemptId: null,
  };

  await expect(
    getKnowledgeRecord(database.db, principal, {
      recordId: execution.recordId,
    }),
  ).resolves.toMatchObject({ id: execution.recordId });
  await expect(
    createKnowledgeProposal(database.db, {
      kind: "knowledge_add",
      owner: { kind: "company", companyId: execution.companyId },
      principal,
      idempotencyKey: `inspection:${execution.runId}`,
      draft: {
        title: "Inspection must not write",
        kind: "observation",
        assertion: "Inspection is read-only.",
        basis: "observed",
        evidence: [],
        limitations: [],
        missingEvidence: [],
      },
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(
    (
      await database.pool.query(
        "SELECT id FROM brain_proposals WHERE submission_key=$1",
        [`inspection:${execution.runId}`],
      )
    ).rows,
  ).toEqual([]);
});

it("IT-CBE-06 a governed child keeps its generic result grammar and cannot publish after inherited source access is revoked", async () => {
  const execution = await seedNativeFindingsExecution(database, legacyContract);

  await database.pool.query(
    "UPDATE runs SET knowledge_access=jsonb_set(knowledge_access,'{restrictions}',$2::jsonb) WHERE id=$1",
    [
      execution.runId,
      JSON.stringify([{ kind: "company", companyId: execution.companyId }]),
    ],
  );
  await expect(
    assertNativeRunKnowledgeInputs(database.db, execution.runId),
  ).resolves.toBeUndefined();
  await database.pool.query(
    "UPDATE company_grants SET revoked_at=now(),revision=revision+1 WHERE principal_type='agent' AND principal_id=$1 AND action='knowledge:read'",
    [execution.agentId],
  );
  await expect(
    assertNativeRunKnowledgeInputs(database.db, execution.runId),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  const value = {
    ...missingEvidenceFindings,
    findings: [
      { arbitrary: "The historical generic array permits this shape." },
    ],
  };

  expect(
    await finalizeAgentRun(execution.runId, "Done", {
      db: database.db,
      finalOutput: { kind: "value", value },
    }),
  ).toMatchObject({ finalized: true, status: "Failed" });
  expect(
    (
      await database.pool.query(
        "SELECT validity,invalid_reason,value FROM run_results WHERE run_id=$1",
        [execution.runId],
      )
    ).rows,
  ).toEqual([
    { validity: "invalid", invalid_reason: "reference_invalid", value: null },
  ]);
});

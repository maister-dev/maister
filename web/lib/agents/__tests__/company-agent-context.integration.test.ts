import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { CompanyAgentExecutionSnapshot } from "../company-agent-execution-types";
import type { PreparedSpecialistAssignment } from "@/lib/specialist-assignments/types";

import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve, sep } from "node:path";

import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  prepareCompanyAgentContext,
  captureCompanyAgentExecution,
} from "../company-agent-context";
import { detachCompanySpecialistBinding } from "../company-binding-mutations";
import { createCompanySpecialistBinding } from "../company-bindings";
import { resolveInstalledAgentDefinition } from "../effective";
import {
  agentDefinitionSha256,
  buildAgentActivitySnapshot,
} from "../activity-snapshot";
import {
  issueCompanyAgentRunToken,
  revokeAgentRunTokensForRun,
} from "../tokens";
import { buildOperationalContract } from "../launch-contract";

import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { searchKnowledge } from "@/lib/brain/knowledge-search";
import {
  createKnowledgeProposal,
  reviewKnowledgeProposal,
} from "@/lib/brain/knowledge-proposals";
import { verifyToken, actorUserIdForToken } from "@/lib/tokens/verify";
import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import {
  createSpecialistAssignment,
  cancelSpecialistAssignment,
  linkSpecialistAssignmentRunInTransaction,
} from "@/lib/specialist-assignments/store";
import {
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { git, initRepo } from "@/test-support/git-fixture";

let database: StartedPostgresTestDb;
let root: string;
let assignmentInput: PreparedSpecialistAssignment;
let grantId: string;
let request: {
  companyId: string;
  assignmentId: string;
  assignmentRevision: number;
  inputRevision: number;
  bindingId: string;
  bindingRevision: number;
  triggerSource: "manual";
};
const administratorId = randomUUID();
const userId = randomUUID();
const agentId = "rah:evidence-researcher";

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", "company-agent-knowledge-cursor-fixture");
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "company_agent_context",
  });
  root = await mkdtemp(join(os.tmpdir(), "company-agent-context-"));
  vi.spyOn(os, "homedir").mockReturnValue(root);
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active'),($3,$4,'member','active')",
    [
      administratorId,
      `${administratorId}@example.test`,
      userId,
      `${userId}@example.test`,
    ],
  );
  const grants = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: [
      "specialists:manage",
      "specialists:read",
      "assignments:read",
      "assignments:submit",
      "assignments:update",
      "assignments:cancel",
    ],
    idempotencyKey: randomUUID(),
  });

  grantId = (
    await database.pool.query(
      "SELECT id FROM company_grants WHERE principal_id=$1 AND action='assignments:update'",
      [userId],
    )
  ).rows[0]!.id;
  const source = join(root, "source");

  await cp(resolve("test-fixtures/rah-native"), source, {
    recursive: true,
    filter: (path) => !path.split(sep).includes(".git"),
  });
  await writeFile(
    join(source, "maister-agents/evidence-researcher.md"),
    "---\nname: Operations observer\ndescription: Diagnose authorized stand state\nkind: operational\ncompletion: {contract: operational_v1}\nspecialist:\n  responsibilities: [Inspect authorized stand state]\n  targetClasses: [stand]\nmode: session\nworkspace: none\ntriggers: [manual, cron]\nrisk_tier: read_only\nconfig:\n  - key: label\n    type: string\n    default: base\n---\nInspect the authorized target. Preserve missing evidence.\n",
  );
  const primarySource = await readFile(
    join(source, "maister-agents/evidence-researcher.md"),
    "utf8",
  );

  await writeFile(
    join(source, "maister-agents/repo-observer.md"),
    primarySource.replace("workspace: none", "workspace: repo_read"),
  );
  await writeFile(
    join(source, "maister-agents/flow-coordinator.md"),
    primarySource
      .replace(
        "kind: operational\ncompletion: {contract: operational_v1}\n",
        "",
      )
      .replace("workspace: none", "flow: rah-control\nworkspace: none"),
  );
  await writeFile(
    join(source, "maister-agents/disabled-observer.md"),
    primarySource,
  );
  await initRepo(source);
  await git(
    source,
    "tag",
    "-a",
    "rah/company-agent-context",
    "-m",
    "Synthetic company agent admission fixture",
  );
  const installed = await installPackageRevision({
    db: database.db,
    source,
    version: "rah/company-agent-context",
  });

  await trustPackageRevision({
    db: database.db,
    packageInstallId: installed.id,
  });
  const definition = await resolveInstalledAgentDefinition(database.db, {
    agentId,
    packageInstallId: installed.id,
  });
  const binding = await createCompanySpecialistBinding(
    database.db,
    userId,
    agentId,
    {
      owner: { kind: "company", companyId: grants.page.companyId },
      packageInstallId: installed.id,
      packageRevision: definition.resolvedRevision!,
      definitionSha256: agentDefinitionSha256(definition.parsed),
      enabled: true,
      configuration: {},
      grantActions: ["knowledge:read", "knowledge:propose"],
      idempotencyKey: randomUUID(),
    },
  );
  const result = buildOperationalContract(definition);

  assignmentInput = {
    owner: binding.specialist.owner,
    specialistBindingId: binding.specialist.bindingId,
    responsibleAgentId: agentId,
    standingDefinition: {
      schemaVersion: 1,
      agentId,
      packageInstallId: installed.id,
      packageName: definition.packageName,
      packageRevision: definition.resolvedRevision!,
      definitionSha256: agentDefinitionSha256(definition.parsed),
      definition: definition.parsed,
      configuration: {},
    },
    objectiveInput: {
      objective: "Diagnose the configured stand",
      expectedOutcome: "Typed diagnostic outcome",
      input: "No restart authorized",
      targetIds: [],
      inputRefs: [],
      constraints: ["Read only"],
      expectedResult: {
        schemaRef: result.schemaRef,
        schemaVersion: result.schemaVersion,
        sha256: result.sha256,
        required: true,
      },
      verification: [],
    },
    scheduledRequest: null,
    sourceRestrictions: [],
    executionPolicy: { preset: "supervised" },
    origin: { kind: "manual", interactionId: randomUUID() },
    destination: { kind: "inbox", userId },
  };
  const assignment = await createSpecialistAssignment(
    database.db,
    userId,
    assignmentInput,
  );

  request = {
    companyId: grants.page.companyId,
    assignmentId: assignment.id,
    assignmentRevision: 1,
    inputRevision: 1,
    bindingId: binding.specialist.bindingId,
    bindingRevision: 1,
    triggerSource: "manual",
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

it("CBS-02 preflights a real pinned company specialist and exact assignment input without a project or admission effects", async () => {
  const context = await database.db.transaction((tx) =>
    prepareCompanyAgentContext(tx, userId, request),
  );

  expect(context).toMatchObject({
    owner: assignmentInput.owner,
    assignment: { id: request.assignmentId, revision: 1, inputRevision: 1 },
    binding: { bindingId: request.bindingId, revision: 1 },
    effective: {
      parsed: { id: agentId, kind: "operational", workspace: "none" },
    },
    input: {
      revision: 1,
      snapshot: { objectiveInput: assignmentInput.objectiveInput },
    },
    authority: { actor: { kind: "user", id: userId } },
  });
  expect(
    (
      await database.pool.query(
        "SELECT (SELECT count(*)::int FROM projects) AS projects,(SELECT count(*)::int FROM runs) AS runs,(SELECT count(*)::int FROM project_tokens) AS tokens",
      )
    ).rows[0],
  ).toEqual({ projects: 0, runs: 0, tokens: 0 });
});

it("refuses stale business/input/binding revisions and forged launch fields without allocating work", async () => {
  for (const change of [
    { assignmentRevision: 2 },
    { inputRevision: 2 },
    { bindingRevision: 2 },
  ]) {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, { ...request, ...change }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  }
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...request,
        actor: { kind: "user", id: administratorId },
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...request,
        triggerSource: "webhook",
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFIG" });
});

it("rechecks actual package trust and the catalog kill switch on every preflight", async () => {
  const pin = assignmentInput.standingDefinition.packageInstallId;

  await database.pool.query(
    "UPDATE package_installs SET trust_status='untrusted' WHERE id=$1",
    [pin],
  );
  try {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, request),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  } finally {
    await database.pool.query(
      "UPDATE package_installs SET trust_status='trusted' WHERE id=$1",
      [pin],
    );
  }
  await database.pool.query("UPDATE agents SET enabled=false WHERE id=$1", [
    agentId,
  ]);
  try {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, request),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  } finally {
    await database.pool.query("UPDATE agents SET enabled=true WHERE id=$1", [
      agentId,
    ]);
  }
});

it("rejects a changed installed definition witness and an assignment with a different required result", async () => {
  const context = await database.db.transaction((tx) =>
    prepareCompanyAgentContext(tx, userId, request),
  );
  const original = await readFile(context.effective.sourcePath, "utf8");

  await writeFile(
    context.effective.sourcePath,
    original + "Changed provider bytes.\n",
  );
  try {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, request),
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "company_agent_pin_changed" },
    });
  } finally {
    await writeFile(context.effective.sourcePath, original);
  }
  const changed = await createSpecialistAssignment(database.db, userId, {
    ...assignmentInput,
    objectiveInput: {
      ...assignmentInput.objectiveInput,
      expectedResult: {
        ...assignmentInput.objectiveInput.expectedResult,
        sha256: "0".repeat(64),
      },
    },
  });

  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...request,
        assignmentId: changed.id,
      }),
    ),
  ).rejects.toMatchObject({
    code: "CONFIG",
    details: { reason: "company_assignment_result_mismatch" },
  });
});

it.each([
  ["rah:repo-observer", "company_agent_workspace_unsupported"],
  ["rah:flow-coordinator", "company_coordinator_required"],
] as const)(
  "refuses %s on standalone company admission instead of changing its declared execution model",
  async (roleId, reason) => {
    const effective = await resolveInstalledAgentDefinition(database.db, {
      agentId: roleId,
      packageInstallId: assignmentInput.standingDefinition.packageInstallId,
    });
    const binding = await createCompanySpecialistBinding(
      database.db,
      userId,
      roleId,
      {
        owner: { kind: "company", companyId: request.companyId },
        packageInstallId: effective.packageInstallId,
        packageRevision: effective.resolvedRevision!,
        definitionSha256: agentDefinitionSha256(effective.parsed),
        enabled: true,
        configuration: {},
        grantActions: [],
        idempotencyKey: randomUUID(),
      },
    );
    const assignment = await createSpecialistAssignment(database.db, userId, {
      ...assignmentInput,
      specialistBindingId: binding.specialist.bindingId,
      responsibleAgentId: roleId,
      standingDefinition: {
        ...assignmentInput.standingDefinition,
        agentId: roleId,
        definition: effective.parsed,
        definitionSha256: agentDefinitionSha256(effective.parsed),
      },
    });

    await expect(
      database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, {
          ...request,
          assignmentId: assignment.id,
          bindingId: binding.specialist.bindingId,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG", details: { reason } });
  },
);

it("refuses cancelled work and hides foreign project assignment identity before checking its revision", async () => {
  const cancelled = await createSpecialistAssignment(
    database.db,
    userId,
    assignmentInput,
  );

  await cancelSpecialistAssignment(
    database.db,
    userId,
    cancelled.id,
    1,
    "Cancelled before admission",
  );
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...request,
        assignmentId: cancelled.id,
        assignmentRevision: 2,
      }),
    ),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "company_assignment_changed" },
  });
  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), project.id, userId],
  );
  const foreign = await createSpecialistAssignment(database.db, userId, {
    ...assignmentInput,
    owner: { kind: "project", projectId: project.id },
    specialistBindingId: randomUUID(),
  });
  const failures: { code: unknown; message: string; details: unknown }[] = [];

  for (const assignmentId of [randomUUID(), foreign.id]) {
    try {
      await database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, {
          ...request,
          assignmentId,
          assignmentRevision: 2,
        }),
      );
      throw new Error("Foreign or absent assignment was admitted");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !("details" in error)
      )
        throw error;
      failures.push({
        code: error.code,
        message: error.message,
        details: error.details,
      });
    }
  }
  expect(failures[0]).toEqual(failures[1]);
  expect(failures[0]).toMatchObject({
    code: "PRECONDITION",
    details: { reason: "assignment_reference_unavailable" },
  });
});

it("refuses disabled and retired configuration, and standing input that changes effective role configuration", async () => {
  const roleId = "rah:disabled-observer";
  const effective = await resolveInstalledAgentDefinition(database.db, {
    agentId: roleId,
    packageInstallId: assignmentInput.standingDefinition.packageInstallId,
  });
  const binding = await createCompanySpecialistBinding(
    database.db,
    userId,
    roleId,
    {
      owner: { kind: "company", companyId: request.companyId },
      packageInstallId: effective.packageInstallId,
      packageRevision: effective.resolvedRevision!,
      definitionSha256: agentDefinitionSha256(effective.parsed),
      configuration: {},
      grantActions: [],
      idempotencyKey: randomUUID(),
    },
  );
  const assignment = await createSpecialistAssignment(database.db, userId, {
    ...assignmentInput,
    specialistBindingId: binding.specialist.bindingId,
    responsibleAgentId: roleId,
    standingDefinition: {
      ...assignmentInput.standingDefinition,
      agentId: roleId,
      definition: effective.parsed,
      definitionSha256: agentDefinitionSha256(effective.parsed),
    },
  });
  const disabled = {
    ...request,
    assignmentId: assignment.id,
    bindingId: binding.specialist.bindingId,
  };

  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, disabled),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "company_binding_disabled" },
  });
  await detachCompanySpecialistBinding(
    database.db,
    userId,
    roleId,
    binding.specialist.bindingId,
    {
      expectedRevision: 1,
      reason: "Retired before admission",
      idempotencyKey: randomUUID(),
    },
  );
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...disabled,
        bindingRevision: 2,
      }),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "company_binding_disabled" },
  });
  const changed = await createSpecialistAssignment(database.db, userId, {
    ...assignmentInput,
    standingDefinition: {
      ...assignmentInput.standingDefinition,
      configuration: { label: "different-input" },
    },
  });

  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...request,
        assignmentId: changed.id,
      }),
    ),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "company_assignment_standing_changed" },
  });
});

async function reserveCompanyFixtureRun(): Promise<
  Readonly<{
    runId: string;
    assignmentId: string;
    snapshot: CompanyAgentExecutionSnapshot;
  }>
> {
  const assignment = await createSpecialistAssignment(
    database.db,
    userId,
    assignmentInput,
  );
  const runId = randomUUID();
  const prepared = await database.db.transaction(async (tx) => {
    const context = await prepareCompanyAgentContext(tx, userId, {
      ...request,
      assignmentId: assignment.id,
    });
    const snapshot = captureCompanyAgentExecution(context);
    const result = buildOperationalContract(context.effective);

    await tx.execute(sql`INSERT INTO runs(id,run_kind,company_id,company_execution_snapshot,agent_id,source_agent_id,agent_kind,agent_workspace,flow_version,flow_revision,status,result_contract,created_by_user_id,launched_at,activity_sort_at,activity_timestamp_provenance,agent_config,execution_policy,agent_activity_snapshot)
      VALUES(${runId},'agent',${request.companyId},${JSON.stringify(snapshot)}::jsonb,${agentId},${agentId},'operational','none','agent','manual','Pending',${JSON.stringify(result)}::jsonb,${userId},now(),now(),'launch',${JSON.stringify(context.binding.snapshot.effectiveConfiguration)}::jsonb,${JSON.stringify(context.binding.snapshot.executionPolicy)}::jsonb,${JSON.stringify(buildAgentActivitySnapshot(agentId, context.effective))}::jsonb)`);
    await linkSpecialistAssignmentRunInTransaction(tx, userId, assignment.id, {
      expectedRevision: 1,
      inputRevision: 1,
      runId,
      role: "specialist",
      work: null,
    });

    return snapshot;
  });

  return { runId, assignmentId: assignment.id, snapshot: prepared };
}

it("reserves company run ownership and its exact immutable assignment input link in the existing run ledger", async () => {
  const {
    runId,
    assignmentId,
    snapshot: prepared,
  } = await reserveCompanyFixtureRun();

  expect(
    (
      await database.pool.query(
        "SELECT company_id,project_id,task_id,flow_id,company_execution_snapshot FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0],
  ).toEqual({
    company_id: request.companyId,
    project_id: null,
    task_id: null,
    flow_id: null,
    company_execution_snapshot: prepared,
  });
  expect(
    (
      await database.pool.query(
        "SELECT assignment_id,input_revision,role FROM specialist_run_links WHERE run_id=$1",
        [runId],
      )
    ).rows[0],
  ).toEqual({
    assignment_id: assignmentId,
    input_revision: 1,
    role: "specialist",
  });
  await expect(
    database.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(
        sql`INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs,to_jsonb(r)||jsonb_build_object('id',${randomUUID()}::text,'agent_kind',NULL,'result_contract',NULL))).* FROM runs r WHERE id=${runId}`,
      );
    }),
  ).rejects.toMatchObject({
    cause: { code: "23514", constraint: "runs_company_agent_shape_check" },
  });
  const unlinked = await database.db.transaction((tx) =>
    prepareCompanyAgentContext(tx, userId, request),
  );

  await expect(
    database.db.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs,to_jsonb(r)||jsonb_build_object('id',${randomUUID()}::text,'company_execution_snapshot',${JSON.stringify(captureCompanyAgentExecution(unlinked))}::jsonb))).* FROM runs r WHERE id=${runId}`,
      );
    }),
  ).rejects.toMatchObject({
    cause: { code: "23514", constraint: "runs_company_execution_link_check" },
  });
  await expect(
    database.pool.query(
      "UPDATE runs SET company_execution_snapshot=jsonb_set(company_execution_snapshot,'{assignment,inputSha256}',to_jsonb($2::text)) WHERE id=$1",
      [runId, "0".repeat(64)],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

it("rotates exact company run credentials with current grants, scope limits and transactional refusal recovery", async () => {
  const { runId } = await reserveCompanyFixtureRun();

  await expect(
    issueCompanyAgentRunToken({ db: database.db, runId }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    runId,
  ]);
  const first = await issueCompanyAgentRunToken({ db: database.db, runId });
  const actor = await verifyToken(first.secret, database.db);

  expect(actor).toMatchObject({
    companyId: request.companyId,
    projectId: null,
    tokenKind: "agent",
    agentId,
    ownerUserId: userId,
    boundRunId: runId,
    scopes: ["knowledge:read", "knowledge:propose"],
  });
  expect(actorUserIdForToken(actor)).toBeNull();
  const replacement = await issueCompanyAgentRunToken({
    db: database.db,
    runId,
  });

  await expect(verifyToken(first.secret, database.db)).rejects.toMatchObject({
    kind: "revoked",
  });
  const concurrent = await Promise.all([
    issueCompanyAgentRunToken({ db: database.db, runId }),
    issueCompanyAgentRunToken({ db: database.db, runId }),
  ]);
  const live = (
    await database.pool.query(
      "SELECT id FROM project_tokens WHERE company_run_id=$1 AND revoked_at IS NULL",
      [runId],
    )
  ).rows;

  expect(live).toHaveLength(1);
  const currentToken = concurrent.find(
    (token) => token.tokenId === live[0]!.id,
  );

  if (!currentToken)
    throw new Error("Current company credential has no issuance receipt");
  await expect(
    verifyToken(replacement.secret, database.db),
  ).rejects.toMatchObject({ kind: "revoked" });
  for (const change of [
    {
      disable:
        "UPDATE package_installs SET trust_status='untrusted' WHERE id=$1",
      restore: "UPDATE package_installs SET trust_status='trusted' WHERE id=$1",
      id: assignmentInput.standingDefinition.packageInstallId,
    },
    {
      disable: "UPDATE agents SET enabled=false WHERE id=$1",
      restore: "UPDATE agents SET enabled=true WHERE id=$1",
      id: agentId,
    },
  ]) {
    await database.pool.query(change.disable, [change.id]);
    try {
      await expect(
        verifyToken(currentToken.secret, database.db),
      ).rejects.toMatchObject({ kind: "owner-unavailable" });
    } finally {
      await database.pool.query(change.restore, [change.id]);
    }
  }
  const readGrant = (
    await database.pool.query(
      "SELECT id,revision FROM company_grants WHERE principal_id=$1 AND action='assignments:read' AND revoked_at IS NULL",
      [userId],
    )
  ).rows[0]!;

  await revokeCompanyGrant(database.db, administratorId, readGrant.id, {
    expectedRevision: readGrant.revision,
    reason: "Content access revoked",
    idempotencyKey: randomUUID(),
  });
  await expect(
    verifyToken(currentToken.secret, database.db),
  ).rejects.toMatchObject({ kind: "owner-unavailable" });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["assignments:read"],
    idempotencyKey: randomUUID(),
  });
  expect((await verifyToken(currentToken.secret, database.db)).boundRunId).toBe(
    runId,
  );
  await database.pool.query(
    "UPDATE users SET account_status='disabled' WHERE id=$1",
    [userId],
  );
  try {
    await expect(
      verifyToken(currentToken.secret, database.db),
    ).rejects.toMatchObject({ kind: "owner-unavailable" });
  } finally {
    await database.pool.query(
      "UPDATE users SET account_status='active' WHERE id=$1",
      [userId],
    );
  }
  await database.pool.query(
    "CREATE FUNCTION fail_company_token_issue_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Owned fixture issuance refusal' USING ERRCODE='23514',CONSTRAINT='company_token_issue_fixture'; END $$",
  );
  await database.pool.query(
    "CREATE TRIGGER company_token_issue_fixture BEFORE INSERT ON project_tokens FOR EACH ROW WHEN (NEW.company_id IS NOT NULL) EXECUTE FUNCTION fail_company_token_issue_fixture()",
  );
  try {
    await expect(
      issueCompanyAgentRunToken({ db: database.db, runId }),
    ).rejects.toMatchObject({
      code: "CRASH",
      message: "Database operation failed",
      details: { sqlState: "23514", constraint: "company_token_issue_fixture" },
    });
  } finally {
    await database.pool.query(
      "DROP TRIGGER company_token_issue_fixture ON project_tokens",
    );
    await database.pool.query(
      "DROP FUNCTION fail_company_token_issue_fixture()",
    );
  }
  expect((await verifyToken(currentToken.secret, database.db)).tokenId).toBe(
    currentToken.tokenId,
  );
  await expect(
    database.pool.query(
      "UPDATE project_tokens SET scopes='[\"*\"]'::jsonb WHERE id=$1",
      [currentToken.tokenId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await revokeAgentRunTokensForRun(runId, database.db);
  await expect(
    verifyToken(currentToken.secret, database.db),
  ).rejects.toMatchObject({ kind: "revoked" });
});

it("uses company Brain through current user and agent authority while retaining professional proposal attribution", async () => {
  const { runId, snapshot: prepared } = await reserveCompanyFixtureRun();

  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    runId,
  ]);
  const replacement = await issueCompanyAgentRunToken({
    db: database.db,
    runId,
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
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["knowledge:read", "knowledge:propose", "knowledge:review"],
    idempotencyKey: randomUUID(),
  });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "agent",
    principalId: agentId,
    actions: ["knowledge:read", "knowledge:propose"],
    idempotencyKey: randomUUID(),
  });
  const humanPrincipal = { kind: "user" as const, userId };
  const nativePrincipal = {
    kind: "token" as const,
    tokenId: replacement.tokenId,
  };
  const draft = {
    title: "Company inspection procedure",
    kind: "procedure" as const,
    assertion: "Inspect the configured health probe before taking action.",
    basis: "unknown" as const,
    evidence: [],
    missingEvidence: [
      {
        state: "absent" as const,
        reason: "No external observation is being claimed.",
      },
    ],
    limitations: ["This is an unconfirmed procedure."],
  };
  const humanProposal = await createKnowledgeProposal(database.db, {
    kind: "knowledge_add",
    owner: { kind: "company", companyId: request.companyId },
    principal: humanPrincipal,
    idempotencyKey: `company-procedure:${runId}`,
    draft,
  });
  const accepted = await reviewKnowledgeProposal(database.db, {
    proposalId: humanProposal.id,
    principal: humanPrincipal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Retain the explicit procedure without confirming it",
    idempotencyKey: `company-procedure-review:${runId}`,
  });

  if (!accepted.acceptedRecordId)
    throw new Error("Accepted procedure has no record identity");
  const recordId = accepted.acceptedRecordId;

  expect(
    await getKnowledgeRecord(database.db, nativePrincipal, { recordId }),
  ).toMatchObject({
    id: recordId,
    owner: { kind: "company", companyId: request.companyId },
    confirmation: { state: "unconfirmed" },
  });
  const { GET: knowledgeHttpGet } =
    await import("@/app/api/v1/ext/knowledge/[recordId]/route");
  const readableHttp = await knowledgeHttpGet(
    new NextRequest(`http://localhost/api/v1/ext/knowledge/${recordId}`, {
      headers: { Authorization: `Bearer ${replacement.secret}` },
    }),
    { params: Promise.resolve({ recordId }) },
  );

  expect(readableHttp.status).toBe(200);
  expect(readableHttp.headers.get("Cache-Control")).toBe("private, no-store");
  expect(readableHttp.headers.get("Vary")).toContain("Authorization");
  const readableBody: unknown = await readableHttp.json();

  expect(readableBody).toMatchObject({
    id: recordId,
    owner: { kind: "company", companyId: request.companyId },
  });
  expect(
    (
      await searchKnowledge(database.db, nativePrincipal, {
        q: "inspection",
        limit: 10,
      })
    ).items.map((item) => item.id),
  ).toContain(recordId);
  const agentProposal = await createKnowledgeProposal(database.db, {
    kind: "knowledge_add",
    owner: { kind: "company", companyId: request.companyId },
    principal: nativePrincipal,
    idempotencyKey: `company-agent-proposal:${runId}`,
    draft: { ...draft, title: "Proposed reusable diagnostic limitation" },
  });

  expect(
    (
      await database.pool.query(
        "SELECT knowledge_attribution,authority_snapshot FROM brain_proposals WHERE id=$1",
        [agentProposal.id],
      )
    ).rows[0],
  ).toMatchObject({
    knowledge_attribution: {
      kind: "agent",
      id: agentId,
      runId,
      attemptId: null,
    },
    authority_snapshot: {
      submit: {
        version: 2,
        initiator: { actor: { kind: "user", id: userId } },
        execution: {
          runId,
          launchSnapshot: { specialistBinding: prepared.specialistBinding },
        },
      },
    },
  });
  await expect(
    reviewKnowledgeProposal(database.db, {
      proposalId: agentProposal.id,
      principal: nativePrincipal,
      expectedRevision: 1,
      decision: "accept",
      reason: "An agent cannot grant its own acceptance authority",
      idempotencyKey: `forged-review:${runId}`,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await database.pool.query(
    "INSERT INTO brain_record_grants(record_id,principal_type,principal_id,action,created_by) VALUES($1,'agent',$2,'knowledge:read',$3::jsonb)",
    [
      recordId,
      agentId,
      JSON.stringify({
        kind: "user",
        id: userId,
        runId: null,
        attemptId: null,
      }),
    ],
  );
  await expect(
    getKnowledgeRecord(database.db, nativePrincipal, { recordId }),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  const hiddenBodies: unknown[] = [];

  for (const selected of [recordId, randomUUID()]) {
    const hiddenHttp = await knowledgeHttpGet(
      new NextRequest(`http://localhost/api/v1/ext/knowledge/${selected}`, {
        headers: { Authorization: `Bearer ${replacement.secret}` },
      }),
      { params: Promise.resolve({ recordId: selected }) },
    );

    expect(hiddenHttp.status).toBe(404);
    hiddenBodies.push(await hiddenHttp.json());
  }
  expect(hiddenBodies[0]).toEqual(hiddenBodies[1]);
  expect(
    (
      await searchKnowledge(database.db, nativePrincipal, {
        q: "inspection",
        limit: 10,
      })
    ).items,
  ).toEqual([]);
  await database.pool.query(
    "INSERT INTO brain_record_grants(record_id,principal_type,principal_id,action,created_by) VALUES($1,'user',$2,'knowledge:read',$3::jsonb)",
    [
      recordId,
      userId,
      JSON.stringify({
        kind: "user",
        id: userId,
        runId: null,
        attemptId: null,
      }),
    ],
  );
  expect(
    (await getKnowledgeRecord(database.db, nativePrincipal, { recordId })).id,
  ).toBe(recordId);
  const acceptedAgent = await reviewKnowledgeProposal(database.db, {
    proposalId: agentProposal.id,
    principal: humanPrincipal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Retain the limitation with its original professional attribution",
    idempotencyKey: `company-agent-review:${runId}`,
  });

  if (!acceptedAgent.acceptedRecordId)
    throw new Error("Accepted agent limitation has no record identity");
  expect(
    await getKnowledgeRecord(database.db, nativePrincipal, {
      recordId: acceptedAgent.acceptedRecordId,
    }),
  ).toMatchObject({
    attribution: { kind: "agent", id: agentId, runId },
    confirmation: { state: "unconfirmed" },
  });
  const firstPage = await searchKnowledge(database.db, nativePrincipal, {
    q: "",
    limit: 1,
  });

  expect(firstPage.nextCursor).not.toBeNull();
  const userReadGrant = (
    await database.pool.query(
      "SELECT id,revision FROM company_grants WHERE principal_type='user' AND principal_id=$1 AND action='knowledge:read' AND revoked_at IS NULL",
      [userId],
    )
  ).rows[0]!;

  await revokeCompanyGrant(database.db, administratorId, userReadGrant.id, {
    expectedRevision: userReadGrant.revision,
    reason: "Knowledge access revoked independently of assignment access",
    idempotencyKey: randomUUID(),
  });
  await expect(
    getKnowledgeRecord(database.db, nativePrincipal, { recordId }),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  expect(
    (await searchKnowledge(database.db, nativePrincipal, { q: "", limit: 10 }))
      .items,
  ).toEqual([]);
  await expect(
    searchKnowledge(database.db, nativePrincipal, {
      q: "",
      limit: 1,
      cursor: firstPage.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["knowledge:read"],
    idempotencyKey: randomUUID(),
  });
  const agentReadGrant = (
    await database.pool.query(
      "SELECT id,revision FROM company_grants WHERE principal_type='agent' AND principal_id=$1 AND action='knowledge:read' AND revoked_at IS NULL",
      [agentId],
    )
  ).rows[0]!;

  await revokeCompanyGrant(database.db, administratorId, agentReadGrant.id, {
    expectedRevision: agentReadGrant.revision,
    reason: "Professional source access revoked",
    idempotencyKey: randomUUID(),
  });
  await expect(
    getKnowledgeRecord(database.db, nativePrincipal, { recordId }),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  expect(
    (await searchKnowledge(database.db, nativePrincipal, { q: "", limit: 10 }))
      .items,
  ).toEqual([]);
  await expect(
    createKnowledgeProposal(database.db, {
      kind: "knowledge_add",
      owner: { kind: "company", companyId: request.companyId },
      principal: nativePrincipal,
      idempotencyKey: `revoked-source-proposal:${runId}`,
      draft,
    }),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "agent",
    principalId: agentId,
    actions: ["knowledge:read"],
    idempotencyKey: randomUUID(),
  });

  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "UPDATE projects SET brain_enabled=true WHERE id=$1",
    [project.id],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'owner')",
    [randomUUID(), project.id, userId],
  );
  const privateRecordId = (
    await database.pool.query(
      "INSERT INTO brain_items(id,project_id,kind,title,content,confidence,content_hash) VALUES($1,$2,'assertion','Project-private knowledge','A project-owned private observation',0.3,$3) RETURNING id",
      [randomUUID(), project.id, randomUUID()],
    )
  ).rows[0]!.id;

  expect(
    (
      await getKnowledgeRecord(database.db, humanPrincipal, {
        recordId: privateRecordId,
      })
    ).owner,
  ).toEqual({ kind: "project", projectId: project.id });
  await expect(
    getKnowledgeRecord(database.db, nativePrincipal, {
      recordId: privateRecordId,
    }),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  const derived = await createKnowledgeProposal(database.db, {
    kind: "knowledge_add",
    owner: { kind: "company", companyId: request.companyId },
    principal: humanPrincipal,
    idempotencyKey: `project-source-company:${runId}`,
    draft: {
      ...draft,
      title: "Derived project-private summary",
      evidence: [
        {
          relation: "references",
          reference: { kind: "knowledge", id: privateRecordId, revision: 1 },
        },
      ],
    },
  });
  const acceptedDerived = await reviewKnowledgeProposal(database.db, {
    proposalId: derived.id,
    principal: humanPrincipal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Retain its project source restriction",
    idempotencyKey: `project-source-company-review:${runId}`,
  });

  if (!acceptedDerived.acceptedRecordId)
    throw new Error("Derived source has no retained record identity");
  await expect(
    getKnowledgeRecord(database.db, nativePrincipal, {
      recordId: acceptedDerived.acceptedRecordId,
    }),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  expect(
    (
      await searchKnowledge(database.db, nativePrincipal, {
        q: "Derived project-private",
        limit: 10,
      })
    ).items,
  ).toEqual([]);

  await database.pool.query(
    "INSERT INTO brain_record_grants(record_id,principal_type,principal_id,action,created_by) VALUES($1,'agent',$2,'knowledge:propose',$3::jsonb)",
    [
      recordId,
      agentId,
      JSON.stringify({
        kind: "user",
        id: userId,
        runId: null,
        attemptId: null,
      }),
    ],
  );
  const correction = {
    kind: "knowledge_correct" as const,
    owner: { kind: "company" as const, companyId: request.companyId },
    principal: nativePrincipal,
    targetRecordId: recordId,
    expectedRecordRevision: 1,
    idempotencyKey: `company-correction:${runId}`,
    draft: {
      ...draft,
      assertion: "Inspection requires independent post-action verification.",
    },
  };

  await expect(
    createKnowledgeProposal(database.db, correction),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await database.pool.query(
    "INSERT INTO brain_record_grants(record_id,principal_type,principal_id,action,created_by) VALUES($1,'user',$2,'knowledge:propose',$3::jsonb)",
    [
      recordId,
      userId,
      JSON.stringify({
        kind: "user",
        id: userId,
        runId: null,
        attemptId: null,
      }),
    ],
  );
  expect(await createKnowledgeProposal(database.db, correction)).toMatchObject({
    status: "pending",
  });
  expect(
    (await getKnowledgeRecord(database.db, humanPrincipal, { recordId }))
      .revision,
  ).toBe(1);
});

it("requires current explicit company admission authority even for an administrator and after an earlier successful preflight", async () => {
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, administratorId, request),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await revokeCompanyGrant(database.db, administratorId, grantId, {
    expectedRevision: 1,
    reason: "Admission revoked",
    idempotencyKey: randomUUID(),
  });
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, request),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

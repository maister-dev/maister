import type { IssuedAgentToken } from "../tokens";
import type { Db } from "@/lib/execution-host/db";
import type { NativeKnowledgeActor } from "@/lib/company/types";
import type { JsonValue } from "@/lib/hitl-response-contract";
import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { CompanyFlowExecutionSnapshot } from "../company-execution-types";
import type { CompanyFlowContextInput } from "../company-flow-context";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { PreparedSpecialistAssignment } from "@/lib/specialist-assignments/types";
import type { SupervisorDiagnosticsStatus } from "@/lib/execution-host";

import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { join, resolve, sep } from "node:path";

import { eq, sql, getTableColumns } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { NextRequest } from "next/server";
import { createTranslator } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";

import {
  agentDefinitionSha256,
  buildAgentActivitySnapshot,
} from "../activity-snapshot";
import { createCompanySpecialistBinding } from "../company-bindings";
import {
  createCompanyFlowBinding,
  getCompanyFlowBinding,
} from "../company-flow-bindings";
import {
  captureCompanyFlowExecution,
  prepareCompanyFlowContext,
} from "../company-flow-context";
import { updateCompanyFlowBinding } from "../company-flow-binding-mutations";
import { reserveCompanyFlowRun } from "../company-flow-launch";
import { loadCompanyFlowSessionContext } from "../company-flow-session-context";
import { resolveFlowBoundAgent } from "../flow-binding";
import { resolveCompanyFlowNodeEnforcement } from "../company-flow-enforcement";
import { companyAgentWorkdirPath } from "../workspace-paths";
import { assertCompanyRunReadAccess } from "../company-run-read-access";
import {
  issueCompanyAgentRunToken,
  issueCompanyFlowNodeRunToken,
} from "../tokens";
import { updateCompanySpecialistBinding } from "../company-binding-mutations";
import { parseAgentDefinition } from "../definition";
import { resolveInstalledAgentDefinition } from "../effective";
import { buildOperationalContract } from "../launch-contract";
import {
  prepareCompanyAgentContext,
  captureCompanyAgentExecution,
} from "../company-agent-context";
import {
  operationalWorkspace,
  inspectOperationalWorkspace,
} from "../operational-context";
import {
  captureOperationalBaseline,
  captureOperationalGeneration,
} from "../operational-integrity";

import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { generateToken } from "@/lib/tokens/secret";
import { verifyToken } from "@/lib/tokens/verify";
import {
  appendNodeAttempt,
  markNodeRunning,
  setMaterializationPlan,
} from "@/lib/flows/graph/ledger";
import { authorizeKnowledge } from "@/lib/brain/knowledge-access";
import { nativeKnowledgeActorSchema } from "@/lib/company/types";
import { resolveKnowledgeRunIdentity } from "@/lib/brain/knowledge-run-identity";
import { recordNativeKnowledgeActor } from "@/lib/brain/knowledge-execution-actor";
import {
  loadWorkspaceSpecInput,
  workspaceSpecFor,
} from "@/lib/execution-host/adoption";
import { createExecutionHosts } from "@/lib/execution-host";
import { insertCommand } from "@/lib/execution-host/commands";
import { TERMINAL_COMMAND_STATES } from "@/lib/execution-host/types";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { runFlow } from "@/lib/flows/runner";
import { prepareFlowPermissionResponse } from "@/lib/flows/graph/prompt-permission";
import { MaisterError } from "@/lib/errors";
import { requireActiveUserById } from "@/lib/authz";
import { GET as assignmentGet } from "@/app/api/specialist-assignments/[assignmentId]/route";
import { POST as assignmentPost } from "@/app/api/specialist-assignments/route";
import { specialistAssignmentSchema } from "@/lib/specialist-assignments/types";
import { POST as stopRunPost } from "@/app/api/runs/[runId]/stop/route";
import { POST as respondHitlPost } from "@/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route";
import { GET as retainedResultGet } from "@/app/api/runs/[runId]/results/[revision]/route";
import { loadRetainedResultForUser } from "@/lib/run-results/retained-result";
import { createCompanyCronSchedule } from "@/lib/agents/company-schedules";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";
import { reserveCompanyManualAssignment } from "@/lib/specialist-assignments/company-manual-intake";
import { loadNativeInputForUser } from "@/lib/orchestrator/native-input-read";
import { NativeInputInspectionPanel } from "@/components/runs/native-input-inspection";
import enMessages from "@/messages/en.json";
import ruMessages from "@/messages/ru.json";
import { tryStartRun } from "@/lib/scheduler";
import { disposeOperationalRun } from "@/lib/gc/operational-disposition";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import { resumeRun } from "@/lib/runs/resume";
import { startFlowContinuationWorker } from "@/lib/flows/graph/continuation-worker";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";
import {
  runs,
  runSessions,
  platformAcpRunners,
  platformRuntimeSettings,
} from "@/lib/db/schema";
import {
  createSpecialistAssignment,
  getSpecialistAssignmentInput,
  linkSpecialistAssignmentRunInTransaction,
} from "@/lib/specialist-assignments/store";
import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import {
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import { resolveFlowExportContract } from "@/lib/run-results/flow-export";
import * as engine from "@/lib/flows/engine-version";
import { git, initRepo } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDbUpTo,
  applyMainMigration,
} from "@/test-support/pg-container";
import { seedProjectRow } from "@/test-support/execution-host-seed";

let database: StartedPostgresTestDb;
let root: string;
let schemaPath: string;
let storedFlowRunId: string;
let nativeFlowRunId: string;
let nativeNodeAttemptId: string;
let retainedCompanyCredential: IssuedAgentToken;
let migrationInputsBefore: { value: JsonValue }[];
let migrationInputsAfter: { value: JsonValue }[];
let migrationAssignmentsBefore: { value: JsonValue }[];
let migrationAssignmentsAfter: {
  value: JsonValue;
  project_task_id: string | null;
}[];
let migrationTokensBefore: { value: JsonValue }[];
let migrationTokensAfter: { value: JsonValue }[];
let baselineCounts: AllocationCounts;
let migrationBeforeRows: { value: JsonValue }[];
let migrationAfterRows: { value: JsonValue }[];
let preparedAssignment: PreparedSpecialistAssignment;
let request: CompanyFlowContextInput;
const administratorId = randomUUID();
const requesterId = randomUUID();
const outsiderId = randomUUID();
let browserUserId = requesterId;
let browserAuthenticated = true;
let browserLocale: "en" | "ru" = "en";
const result = {
  schema: "./schemas/evidence-findings.v1.json",
  required: true,
};
const manifest = {
  schemaVersion: 1,
  name: "rah-control",
  compat: { engine_min: "3.12.0", engine_max: "3.12.0" },
  execution: { workspace: "none", completion: "result" },
  result: {
    export: {
      ...result,
      native_contract: "evidence_findings_v1",
      from: ["diagnose"],
    },
  },
  nodes: [
    {
      id: "diagnose",
      type: "ai_coding",
      action: {
        prompt:
          "Investigate {{ assignment.objective }} using {{ assignment.input }}.",
      },
      output: { result },
      transitions: { success: "done" },
    },
  ],
};

const dialogueManifest = {
  ...manifest,
  name: "rah-company-dialogue",
  nodes: [
    {
      id: "intake",
      type: "form",
      settings: {
        form_schema: "./schemas/request.json",
        roles: ["maintainer"],
      },
      transitions: { success: "diagnose" },
    },
    {
      ...manifest.nodes[0],
      type: "orchestrator",
      settings: {
        delegation: {
          max_fanout: 1,
          max_depth: 1,
          max_active_children: 1,
          budget: {
            max_tokens: 10000,
            wall_clock_minutes: 2,
            max_child_runs: 1,
            consecutive_failures: 1,
          },
        },
      },
      action: {
        prompt:
          "Investigate {{ assignment.objective }} using {{ assignment.input }}. Component {{ steps.intake.vars.component }}.",
      },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      settings: { roles: ["maintainer"] },
      finish: { human: { decisions: ["approve"] } },
      transitions: { approve: "done" },
    },
  ],
};

async function writeCompanyCapabilityCache(hostRoot: string): Promise<void> {
  const checkedAt = new Date().toISOString();

  await writeFile(
    join(hostRoot, "adapter-smoke-cache.json"),
    JSON.stringify({
      version: 2,
      adapters: {
        claude: {
          status: "ok",
          checkedAt,
          protocolVersion: 1,
          capabilityEnforcement: {
            status: "ok",
            checkedAt,
            protocolVersion: 1,
            probeVersion: 2,
          },
        },
      },
    }),
  );
}

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "run.originalInput") =>
    createTranslator({
      locale: browserLocale,
      messages: browserLocale === "ru" ? ruMessages : enMessages,
      namespace,
    }),
}));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => {
    if (!browserAuthenticated)
      throw new MaisterError("UNAUTHENTICATED", "Login required");

    return requireActiveUserById(browserUserId);
  },
}));

function useEngineVersion(version: string) {
  return vi
    .spyOn(engine, "isEngineCompatible")
    .mockImplementation((min, max) => {
      const compatible =
        (min === undefined || engine.semverGte(version, min)) &&
        (max === undefined || engine.semverGte(max, version));

      return {
        compatible,
        reason: compatible
          ? null
          : "Controlled host is outside the declared engine range",
      };
    });
}

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    {
      databaseName: "company_flow_context",
    },
    "0247_company_operational_attention",
  );
  root = await mkdtemp(join(os.tmpdir(), "company-flow-context-"));
  vi.spyOn(os, "homedir").mockReturnValue(root);
  vi.stubEnv("MAISTER_WORKTREES_ROOT", join(root, "worktrees"));
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active'),($3,$4,'member','active'),($5,$6,'member','active')",
    [
      administratorId,
      `${administratorId}@example.test`,
      requesterId,
      `${requesterId}@example.test`,
      outsiderId,
      `${outsiderId}@example.test`,
    ],
  );
  const grant = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: requesterId,
    actions: [
      "specialists:read",
      "specialists:manage",
      "assignments:read",
      "assignments:submit",
      "assignments:update",
    ],
    idempotencyKey: randomUUID(),
  });
  const source = join(root, "source");

  await cp(resolve("test-fixtures/rah-native"), source, {
    recursive: true,
    filter: (path) => !path.split(sep).includes(".git"),
  });
  const rolePath = join(source, "maister-agents/evidence-researcher.md");

  await writeFile(
    rolePath,
    (await readFile(rolePath, "utf8"))
      .replace("  - flow", "  - flow\n  - cron")
      .replace(
        "workspace: none",
        "specialist:\n  responsibilities: [Coordinate authorized diagnosis]\n  targetClasses: [stand]\nflow: rah-control\nworkspace: none",
      ),
  );
  const diagnosticRolePath = join(
    source,
    "maister-agents/contradiction-researcher.md",
  );

  await writeFile(
    diagnosticRolePath,
    (await readFile(diagnosticRolePath, "utf8")).replace(
      "workspace: none",
      "specialist:\n  responsibilities: [Inspect opposing diagnostic evidence]\n  targetClasses: [stand]\nworkspace: none",
    ),
  );
  await writeFile(
    join(source, "flows/rah-control/flow.yaml"),
    stringify(manifest),
  );
  await writeFile(
    join(source, "maister-agents/migration-observer.md"),
    "---\nname: Retained operations observer\ndescription: Inspect an authorized stand\nkind: operational\ncompletion: {contract: operational_v1}\nspecialist:\n  responsibilities: [Inspect authorized stand state]\n  targetClasses: [stand]\nmode: session\nworkspace: none\ntriggers: [manual]\nrisk_tier: read_only\n---\nPreserve supported observations and missing evidence.\n",
  );
  await writeFile(
    join(source, "maister-agents/no-tool-observer.md"),
    "---\nname: Tool-less observer\ndescription: Evaluate supplied assignment input without native tools\nspecialist:\n  responsibilities: [Evaluate supplied input]\n  targetClasses: [stand]\nmode: session\nworkspace: none\ntriggers: [manual, flow]\nrisk_tier: read_only\nplatform_mcp: false\nmemory: none\n---\nReturn a bounded result from supplied input without requesting tools.\n",
  );
  const dialoguePath = join(source, "flows/rah-company-dialogue");

  await cp(join(source, "flows/rah-control"), dialoguePath, {
    recursive: true,
  });
  await writeFile(join(dialoguePath, "flow.yaml"), stringify(dialogueManifest));
  await writeFile(
    join(source, "schemas/request.json"),
    JSON.stringify({
      schemaVersion: 1,
      fields: [{ name: "component", type: "string", required: true }],
    }),
  );
  await writeFile(
    join(source, "maister-agents/dialogue-coordinator.md"),
    (await readFile(rolePath, "utf8")).replace(
      "flow: rah-control",
      "flow: rah-company-dialogue",
    ),
  );
  const packagePath = join(source, "maister-package.yaml");

  await writeFile(
    packagePath,
    (await readFile(packagePath, "utf8")).replace(
      "flows:\n",
      "flows:\n  - id: rah-company-dialogue\n    path: flows/rah-company-dialogue\n",
    ),
  );
  await initRepo(source);
  await git(
    source,
    "tag",
    "-a",
    "rah/company-context-v1",
    "-m",
    "Controlled company coordinator preflight fixture",
  );
  const installed = await installPackageRevision({
    source,
    version: "rah/company-context-v1",
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
      name: string;
    }>(
      "SELECT installed_path,resolved_revision,name FROM package_installs WHERE id=$1",
      [installed.id],
    )
  ).rows[0]!;
  const definition = parseAgentDefinition(
    "rah:evidence-researcher",
    await readFile(
      join(pin.installed_path, "maister-agents/evidence-researcher.md"),
      "utf8",
    ),
  );
  const flow = (
    await database.pool.query<{
      id: string;
      manifest_digest: string;
      installed_path: string;
    }>(
      "SELECT id,manifest_digest,installed_path FROM flow_revisions WHERE flow_ref_id='rah-control' AND resolved_revision=$1",
      [pin.resolved_revision],
    )
  ).rows[0]!;
  const specialist = await createCompanySpecialistBinding(
    database.db,
    requesterId,
    definition.id,
    {
      owner: { kind: "company", companyId: grant.page.companyId },
      packageInstallId: installed.id,
      packageRevision: pin.resolved_revision,
      definitionSha256: agentDefinitionSha256(definition),
      coordinatorFlowRevisionId: flow.id,
      configuration: {},
      grantActions: ["knowledge:read", "knowledge:propose"],
      enabled: true,
      idempotencyKey: randomUUID(),
    },
  );
  // Native configuration and execution use the installed engine predicate unchanged.
  // Range-refusal tests separately simulate an older or newer host.
  const compatibility = vi.spyOn(engine, "isEngineCompatible");
  let coordinator: Awaited<ReturnType<typeof createCompanyFlowBinding>>;

  try {
    coordinator = await createCompanyFlowBinding(database.db, requesterId, {
      owner: specialist.specialist.owner,
      specialistBindingId: specialist.specialist.bindingId,
      specialistRevision: specialist.specialist.configRevision,
      flowRevisionId: flow.id,
      manifestSha256: flow.manifest_digest,
      execution: { workspace: "none", completion: "result" },
      enabled: true,
      roleMappings: {},
      idempotencyKey: randomUUID(),
    });
  } finally {
    compatibility.mockRestore();
  }
  const contract = await resolveFlowExportContract({
    flowRefId: "rah-control",
    manifest,
    revision: {
      id: flow.id,
      installedPath: flow.installed_path,
      resolvedRevision: pin.resolved_revision,
    },
  });

  if (!contract)
    throw new Error("The real installed coordinator result schema is missing");
  const input: PreparedSpecialistAssignment = {
    owner: specialist.specialist.owner,
    specialistBindingId: specialist.specialist.bindingId,
    responsibleAgentId: definition.id,
    objectiveInput: {
      objective: "Diagnose configured stand",
      expectedOutcome: "Evidence-linked diagnosis",
      input: "Inspect only",
      targetIds: ["stand:configured"],
      inputRefs: [],
      constraints: ["No unapproved restart"],
      expectedResult: {
        schemaRef: contract.schemaRef,
        schemaVersion: contract.schemaVersion,
        sha256: contract.sha256,
        required: true,
      },
      verification: [{ kind: "result", referenceId: null, required: true }],
    },
    standingDefinition: {
      schemaVersion: 1,
      agentId: definition.id,
      packageInstallId: installed.id,
      packageName: pin.name,
      packageRevision: pin.resolved_revision,
      definitionSha256: agentDefinitionSha256(definition),
      definition,
      configuration: {},
    },
    sourceRestrictions: [],
    scheduledRequest: null,
    executionPolicy: specialist.specialist.executionPolicy,
    origin: { kind: "manual", interactionId: randomUUID() },
    destination: { kind: "inbox", userId: requesterId },
  };

  preparedAssignment = input;
  const assignment = await createSpecialistAssignment(
    database.db,
    requesterId,
    input,
  );

  schemaPath = join(flow.installed_path, "schemas/evidence-findings.v1.json");
  request = {
    companyId: grant.page.companyId,
    assignmentId: assignment.id,
    assignmentRevision: assignment.revision,
    inputRevision: assignment.inputRevision,
    bindingId: specialist.specialist.bindingId,
    bindingRevision: specialist.specialist.configRevision,
    coordinatorBindingId: coordinator.binding.id,
    coordinatorBindingRevision: coordinator.binding.revision,
    triggerSource: "manual",
  };
  await seedRetainedStandalone();
  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision) VALUES($1,$2,'agent','Pending','agent','manual')",
    [randomUUID(), project.id],
  );
  await database.pool.query(
    "INSERT INTO runs(id,run_kind,status,flow_version,flow_revision,persistent,created_by_user_id,agent_workspace) VALUES($1,'librarian','NeedsInputIdle','librarian','manual',true,$2,'none')",
    [randomUUID(), requesterId],
  );
  for (const kind of ["project", "user"] as const) {
    const credential = generateToken();

    await database.pool.query(
      "INSERT INTO project_tokens(id,project_id,name,token_kind,owner_user_id,prefix,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'[\"knowledge:read\"]'::jsonb,now()+interval '1 hour')",
      [
        randomUUID(),
        kind === "project" ? project.id : null,
        `retained-${kind}`,
        kind,
        kind === "user" ? requesterId : null,
        credential.prefix,
        credential.hash,
      ],
    );
  }
  migrationBeforeRows = (
    await database.pool.query<{ value: JsonValue }>(
      "SELECT to_jsonb(r) AS value FROM runs r ORDER BY id",
    )
  ).rows;
  migrationInputsBefore = (
    await database.pool.query<{ value: JsonValue }>(
      "SELECT to_jsonb(input) AS value FROM specialist_input_revisions input ORDER BY assignment_id,revision",
    )
  ).rows;
  migrationAssignmentsBefore = (
    await database.pool.query<{ value: JsonValue }>(
      "SELECT to_jsonb(assignment) AS value FROM specialist_assignments assignment ORDER BY id",
    )
  ).rows;
  await applyMainMigration(database.db, "0248_company_flow_execution");
  migrationTokensBefore = (
    await database.pool.query<{ value: JsonValue }>(
      "SELECT to_jsonb(t) AS value FROM project_tokens t ORDER BY id",
    )
  ).rows;
  await applyMainMigration(database.db, "0249_company_flow_node_credentials");
  await applyMainMigration(database.db, "0250_company_flow_workspace_witness");
  await applyMainMigration(database.db, "0251_company_flow_runtime");
  await applyMainMigration(database.db, "0252_company_run_cancellation");
  await applyMainMigration(database.db, "0253_specialist_intake_receipts");
  await applyMainMigration(database.db, "0254_specialist_project_flow_input");
  migrationAssignmentsAfter = (
    await database.pool.query<{
      value: JsonValue;
      project_task_id: string | null;
    }>(
      "SELECT to_jsonb(assignment)-'project_task_id' AS value,project_task_id FROM specialist_assignments assignment ORDER BY id",
    )
  ).rows;
  migrationInputsAfter = (
    await database.pool.query<{ value: JsonValue }>(
      "SELECT to_jsonb(input) AS value FROM specialist_input_revisions input ORDER BY assignment_id,revision",
    )
  ).rows;
  migrationTokensAfter = (
    await database.pool.query<{ value: JsonValue }>(
      "SELECT to_jsonb(t) AS value FROM project_tokens t ORDER BY id",
    )
  ).rows;
  migrationAfterRows = (
    await database.pool.query<{ value: JsonValue }>(
      "SELECT to_jsonb(r)-'company_cancellation_intent' AS value FROM runs r ORDER BY id",
    )
  ).rows;
  await database.pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
  baselineCounts = await counts();
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

type AllocationCounts = Readonly<{
  projects: number;
  tasks: number;
  runs: number;
  sessions: number;
  links: number;
}>;

async function counts(): Promise<AllocationCounts> {
  return (
    await database.pool.query<AllocationCounts>(
      "SELECT (SELECT count(*)::int FROM projects) AS projects,(SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM runs) AS runs,(SELECT count(*)::int FROM run_sessions) AS sessions,(SELECT count(*)::int FROM specialist_run_links) AS links",
    )
  ).rows[0]!;
}

async function intakeBusinessCounts(db: StartedPostgresTestDb): Promise<{
  assignments: number;
  inputs: number;
  receipts: number;
  events: number;
}> {
  return (
    await db.pool.query<{
      assignments: number;
      inputs: number;
      receipts: number;
      events: number;
    }>(
      "SELECT (SELECT count(*)::int FROM specialist_assignments) AS assignments,(SELECT count(*)::int FROM specialist_input_revisions) AS inputs,(SELECT count(*)::int FROM specialist_intake_receipts) AS receipts,(SELECT count(*)::int FROM domain_events) AS events",
    )
  ).rows[0]!;
}

async function seedRetainedStandalone(): Promise<void> {
  const effective = await resolveInstalledAgentDefinition(database.db, {
    agentId: "rah:migration-observer",
    packageInstallId: preparedAssignment.standingDefinition.packageInstallId,
  });
  const binding = await createCompanySpecialistBinding(
    database.db,
    requesterId,
    effective.parsed.id,
    {
      owner: { kind: "company", companyId: request.companyId },
      packageInstallId: effective.packageInstallId,
      packageRevision: preparedAssignment.standingDefinition.packageRevision,
      definitionSha256: agentDefinitionSha256(effective.parsed),
      configuration: {},
      grantActions: [],
      enabled: true,
      idempotencyKey: randomUUID(),
    },
  );
  const result = buildOperationalContract(effective);
  const work = await createSpecialistAssignment(database.db, requesterId, {
    ...preparedAssignment,
    specialistBindingId: binding.specialist.bindingId,
    responsibleAgentId: effective.parsed.id,
    executionPolicy: binding.specialist.executionPolicy,
    origin: { kind: "manual", interactionId: randomUUID() },
    standingDefinition: {
      ...preparedAssignment.standingDefinition,
      agentId: effective.parsed.id,
      definition: effective.parsed,
      definitionSha256: agentDefinitionSha256(effective.parsed),
    },
    objectiveInput: {
      ...preparedAssignment.objectiveInput,
      expectedResult: {
        schemaRef: result.schemaRef,
        schemaVersion: result.schemaVersion,
        sha256: result.sha256,
        required: true,
      },
    },
  });

  const retainedRunId = await database.db.transaction(async (tx) => {
    const context = await prepareCompanyAgentContext(tx, requesterId, {
      companyId: request.companyId,
      assignmentId: work.id,
      assignmentRevision: work.revision,
      inputRevision: work.inputRevision,
      bindingId: binding.specialist.bindingId,
      bindingRevision: binding.specialist.configRevision,
      triggerSource: "manual",
    });
    const runId = randomUUID();
    const capture = captureCompanyAgentExecution(context);

    await tx.execute(sql`INSERT INTO runs(id,run_kind,company_id,company_execution_snapshot,agent_id,source_agent_id,
      agent_kind,agent_workspace,flow_version,flow_revision,status,result_contract,created_by_user_id,
      launched_at,activity_sort_at,activity_timestamp_provenance,agent_config,execution_policy,agent_activity_snapshot)
      VALUES(${runId},'agent',${request.companyId},${JSON.stringify(capture)}::jsonb,${effective.parsed.id},${effective.parsed.id},
      'operational','none','agent','manual','Pending',${JSON.stringify(result)}::jsonb,${requesterId},now(),now(),'launch',
      ${JSON.stringify(context.binding.snapshot.effectiveConfiguration)}::jsonb,${JSON.stringify(context.binding.snapshot.executionPolicy)}::jsonb,
      ${JSON.stringify(buildAgentActivitySnapshot(effective.parsed.id, effective))}::jsonb)`);
    await linkSpecialistAssignmentRunInTransaction(tx, requesterId, work.id, {
      runId,
      inputRevision: work.inputRevision,
      expectedRevision: work.revision,
      role: "specialist",
      work: null,
    });

    return runId;
  });

  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    retainedRunId,
  ]);
  const {
    companyCancellationIntent: _newCancellationColumn,
    ...legacyRunColumns
  } = getTableColumns(runs);
  const [retainedRun] = await database.db
    .select(legacyRunColumns)
    .from(runs)
    .where(eq(runs.id, retainedRunId));

  if (!retainedRun) throw new Error("The retained v1 company Run is missing");
  const owner = await operationalWorkspace(database.db, retainedRun);

  await mkdir(owner.cwd, { recursive: true });
  const baseline = await captureOperationalGeneration(
    owner.cwd,
    await captureOperationalBaseline(owner.cwd, "plain_directory"),
    [],
  );

  await database.db
    .update(runs)
    .set({
      operationalIntegrityBaseline: {
        ...baseline,
        owner: {
          kind: "company",
          companyId: request.companyId,
          runId: retainedRunId,
          cwd: owner.cwd,
          runtimePath: owner.runtimePath,
        },
      },
    })
    .where(eq(runs.id, retainedRunId));
  retainedCompanyCredential = await issueCompanyAgentRunToken({
    db: database.db,
    runId: retainedRunId,
  });
}

it("preserves populated standalone/project/private Run and credential bytes through 0233–0239 and keeps project deletion independent of Brain", async () => {
  expect(migrationInputsBefore.length).toBeGreaterThan(0);
  expect(migrationInputsAfter).toEqual(migrationInputsBefore);
  expect(migrationAssignmentsAfter.map(({ value }) => ({ value }))).toEqual(
    migrationAssignmentsBefore,
  );
  expect(
    migrationAssignmentsAfter.every(
      ({ project_task_id }) => project_task_id === null,
    ),
  ).toBe(true);
  expect(migrationTokensAfter).toEqual(migrationTokensBefore);
  expect(migrationTokensBefore).toHaveLength(3);
  await expect(
    verifyToken(retainedCompanyCredential.secret, database.db),
  ).resolves.toMatchObject({
    companyId: request.companyId,
    agentId: "rah:migration-observer",
  });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM project_tokens",
      )
    ).rows[0],
  ).toEqual({ count: 2 });
  expect(migrationAfterRows).toEqual(migrationBeforeRows);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM runs WHERE company_cancellation_intent IS NOT NULL",
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
  expect(baselineCounts).toEqual({
    projects: 0,
    tasks: 0,
    runs: 2,
    sessions: 0,
    links: 1,
  });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('brain_record_revisions','brain_items')",
      )
    ).rows[0],
  ).toEqual({ count: 0 });
  expect(
    (
      await database.pool.query(
        "SELECT run_kind,project_id,company_id,company_execution_snapshot->'schemaVersion' AS version FROM runs ORDER BY run_kind",
      )
    ).rows,
  ).toEqual([
    {
      run_kind: "agent",
      project_id: null,
      company_id: request.companyId,
      version: 1,
    },
    {
      run_kind: "librarian",
      project_id: null,
      company_id: null,
      version: null,
    },
  ]);
});

it("refuses an older host capability before allocating any repository or execution", async () => {
  const compatibility = useEngineVersion("3.11.1");

  try {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyFlowContext(tx, requesterId, request),
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { flowManifestIncompatibility: { kind: "engine_incompatible" } },
    });
    expect(await counts()).toEqual(baselineCounts);
  } finally {
    compatibility.mockRestore();
  }
});

it("prepares exact trusted installed graph/input/result witnesses on a supported host without creating a carrier Task", async () => {
  const compatibility = vi.spyOn(engine, "isEngineCompatible");

  try {
    const context = await database.db.transaction((tx) =>
      prepareCompanyFlowContext(tx, requesterId, request),
    );
    const snapshot = captureCompanyFlowExecution(context);

    expect(context).toMatchObject({
      owner: { kind: "company", companyId: request.companyId },
      assignment: { id: request.assignmentId },
      resultContract: { kind: "flow_export", required: true },
    });
    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      executionKind: "flow",
      assignment: {
        id: request.assignmentId,
        inputRevision: request.inputRevision,
      },
      specialistBinding: {
        id: request.bindingId,
        revision: request.bindingRevision,
      },
      coordinatorFlowBinding: {
        id: request.coordinatorBindingId,
        revision: request.coordinatorBindingRevision,
      },
      authority: { actor: { id: requesterId } },
    });
    expect(context.resultContract.flowRevisionId).toBe(
      context.coordinator.snapshot.flowRevisionId,
    );
    expect(snapshot).not.toHaveProperty("projectId");
    expect(await counts()).toEqual(baselineCounts);
  } finally {
    compatibility.mockRestore();
  }
});

it.each([
  { assignmentRevision: 2 },
  { inputRevision: 2 },
  { bindingRevision: 2 },
  { coordinatorBindingRevision: 2 },
])(
  "refuses a stale reviewed business/input/configuration revision: %j",
  async (change) => {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyFlowContext(tx, requesterId, { ...request, ...change }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  },
);

it("requires current initiating authority even when the caller knows the exact owned configuration", async () => {
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyFlowContext(tx, outsiderId, request),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

it("refuses changed required schema bytes under the same retained package identity", async () => {
  const original = await readFile(schemaPath, "utf8");
  const compatibility = vi.spyOn(engine, "isEngineCompatible");

  try {
    await writeFile(schemaPath, original + "\n");
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyFlowContext(tx, requesterId, request),
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "company_assignment_result_mismatch" },
    });
  } finally {
    await writeFile(schemaPath, original);
    compatibility.mockRestore();
  }
});

it("honors the pinned Flow maximum on a newer host before execution allocation", async () => {
  const compatibility = useEngineVersion("3.13.0");

  try {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyFlowContext(tx, requesterId, request),
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { flowManifestIncompatibility: { kind: "engine_incompatible" } },
    });
    expect(await counts()).toEqual(baselineCounts);
  } finally {
    compatibility.mockRestore();
  }
});

it("refuses disabled coordinator configuration and requires the new reviewed revision when re-enabled", async () => {
  const current = await getCompanyFlowBinding(
    database.db,
    requesterId,
    request.coordinatorBindingId,
  );
  const configuration = current.configuration;
  const replacement = {
    owner: current.owner,
    specialistBindingId: configuration.specialistBindingId,
    specialistRevision: configuration.specialistRevision,
    flowRevisionId: configuration.flowRevisionId,
    manifestSha256: configuration.manifestSha256,
    execution: configuration.execution,
    roleMappings: configuration.roleMappings,
  };
  const disabled = await updateCompanyFlowBinding(
    database.db,
    requesterId,
    current.id,
    {
      ...replacement,
      enabled: false,
      expectedRevision: current.revision,
      idempotencyKey: randomUUID(),
    },
  );

  request = {
    ...request,
    coordinatorBindingRevision: disabled.binding.revision,
  };
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyFlowContext(tx, requesterId, request),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "company_flow_binding_disabled" },
  });
  const older = useEngineVersion("3.11.1");

  try {
    await expect(
      updateCompanyFlowBinding(database.db, requesterId, current.id, {
        ...replacement,
        enabled: true,
        expectedRevision: disabled.binding.revision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { flowManifestIncompatibility: { kind: "engine_incompatible" } },
    });
    expect(
      (await getCompanyFlowBinding(database.db, requesterId, current.id))
        .revision,
    ).toBe(disabled.binding.revision);
  } finally {
    older.mockRestore();
  }
  const compatibility = vi.spyOn(engine, "isEngineCompatible");

  try {
    const enabled = await updateCompanyFlowBinding(
      database.db,
      requesterId,
      current.id,
      {
        ...replacement,
        enabled: true,
        expectedRevision: disabled.binding.revision,
        idempotencyKey: randomUUID(),
      },
    );
    const stale = request;

    request = {
      ...request,
      coordinatorBindingRevision: enabled.binding.revision,
    };
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyFlowContext(tx, requesterId, stale),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (
        await database.db.transaction((tx) =>
          prepareCompanyFlowContext(tx, requesterId, request),
        )
      ).coordinator.revision,
    ).toBe(enabled.binding.revision);
  } finally {
    compatibility.mockRestore();
  }
});

it("retains a company graph reservation and exact coordinator/input link atomically without a Project or Task", async () => {
  const assignment = await createSpecialistAssignment(
    database.db,
    requesterId,
    {
      ...preparedAssignment,
      origin: { kind: "manual", interactionId: randomUUID() },
    },
  );
  const compatibility = vi.spyOn(engine, "isEngineCompatible");
  const runId = randomUUID();

  try {
    const snapshot = await database.db.transaction(async (tx) => {
      const context = await prepareCompanyFlowContext(tx, requesterId, {
        ...request,
        assignmentId: assignment.id,
        assignmentRevision: assignment.revision,
        inputRevision: assignment.inputRevision,
      });
      const capture = captureCompanyFlowExecution(context);
      const activity = buildAgentActivitySnapshot(
        context.effective.parsed.id,
        context.effective,
      );

      await tx.execute(sql`INSERT INTO runs(
        id,run_kind,company_id,company_execution_snapshot,agent_id,source_agent_id,
        agent_workspace,flow_version,flow_revision,flow_revision_id,status,result_contract,
        created_by_user_id,launched_at,activity_sort_at,activity_timestamp_provenance,
        agent_config,execution_policy,scheduled_request_snapshot,agent_activity_snapshot)
        VALUES(${runId},'flow',${context.owner.companyId},${JSON.stringify(capture)}::jsonb,
        ${context.effective.parsed.id},${context.effective.parsed.id},'none',
        ${context.flowVersion},${context.coordinator.snapshot.packageRevision},${context.coordinator.snapshot.flowRevisionId},'Pending',
        ${JSON.stringify(context.resultContract)}::jsonb,${requesterId},now(),now(),'launch',
        ${JSON.stringify(context.binding.snapshot.effectiveConfiguration)}::jsonb,${JSON.stringify(context.binding.snapshot.executionPolicy)}::jsonb,
        ${context.input.snapshot.scheduledRequest === null ? null : JSON.stringify(context.input.snapshot.scheduledRequest)}::jsonb,
        ${JSON.stringify(activity)}::jsonb)`);
      await linkSpecialistAssignmentRunInTransaction(
        tx,
        requesterId,
        assignment.id,
        {
          runId,
          inputRevision: assignment.inputRevision,
          expectedRevision: assignment.revision,
          role: "coordinator",
          work: null,
        },
      );

      return capture;
    });

    storedFlowRunId = runId;
    expect(
      (
        await database.pool.query(
          "SELECT run_kind,company_id,project_id,task_id,flow_id,company_execution_snapshot FROM runs WHERE id=$1",
          [runId],
        )
      ).rows[0],
    ).toEqual({
      run_kind: "flow",
      company_id: request.companyId,
      project_id: null,
      task_id: null,
      flow_id: null,
      company_execution_snapshot: snapshot,
    });
    expect(
      (
        await database.pool.query(
          "SELECT role,input_revision FROM specialist_run_links WHERE run_id=$1",
          [runId],
        )
      ).rows[0],
    ).toEqual({
      role: "coordinator",
      input_revision: assignment.inputRevision,
    });
    expect(
      (await database.pool.query("SELECT count(*)::int AS count FROM projects"))
        .rows[0],
    ).toEqual({ count: 0 });
    expect(
      (await database.pool.query("SELECT count(*)::int AS count FROM tasks"))
        .rows[0],
    ).toEqual({ count: 0 });
  } finally {
    compatibility.mockRestore();
  }
});

async function insertClonedGraphReservation(
  tx: SqlTransaction,
  runId: string,
  capture: unknown,
  patch: Readonly<Record<string, unknown>>,
): Promise<void> {
  await tx.execute(sql`INSERT INTO runs
    SELECT (jsonb_populate_record(NULL::runs,to_jsonb(source)||jsonb_build_object(
      'id',${runId}::text,'company_execution_snapshot',${JSON.stringify(capture)}::jsonb
    )||${JSON.stringify(patch)}::jsonb)).* FROM runs source WHERE source.id=${storedFlowRunId}`);
}

async function createFreshCompanyFlowRequest(): Promise<CompanyFlowContextInput> {
  const assignment = await createSpecialistAssignment(
    database.db,
    requesterId,
    {
      ...preparedAssignment,
      origin: { kind: "manual", interactionId: randomUUID() },
    },
  );

  return {
    ...request,
    assignmentId: assignment.id,
    assignmentRevision: assignment.revision,
    inputRevision: assignment.inputRevision,
  };
}

async function prepareFreshGraphReservation(): Promise<CompanyFlowExecutionSnapshot> {
  const input = await createFreshCompanyFlowRequest();
  const context = await database.db.transaction((tx) =>
    prepareCompanyFlowContext(tx, requesterId, input),
  );

  return captureCompanyFlowExecution(context);
}

it.each([
  {
    name: "coordinator witness",
    capture: (value: CompanyFlowExecutionSnapshot) => ({
      ...value,
      coordinatorFlowBinding: {
        ...value.coordinatorFlowBinding,
        snapshotSha256: "0".repeat(64),
      },
    }),
    patch: {},
  },
  {
    name: "assignment input witness",
    capture: (value: CompanyFlowExecutionSnapshot) => ({
      ...value,
      assignment: { ...value.assignment, inputSha256: "0".repeat(64) },
    }),
    patch: {},
  },
  {
    name: "unknown version",
    capture: (value: CompanyFlowExecutionSnapshot) => ({
      ...value,
      schemaVersion: 3,
    }),
    patch: {},
  },
  {
    name: "extra authority",
    capture: (value: CompanyFlowExecutionSnapshot) => ({
      ...value,
      confirmationAuthority: "invented",
    }),
    patch: {},
  },
  {
    name: "non-Pending admission",
    capture: (value: CompanyFlowExecutionSnapshot) => value,
    patch: { status: "Running" },
  },
  {
    name: "forged source revision",
    capture: (value: CompanyFlowExecutionSnapshot) => value,
    patch: { flow_revision: "invented" },
  },
  {
    name: "operational-agent substitution",
    capture: (value: CompanyFlowExecutionSnapshot) => value,
    patch: { agent_kind: "operational" },
  },
  {
    name: "optional result export",
    capture: (value: CompanyFlowExecutionSnapshot) => value,
    patch: { result_contract: { kind: "flow_export", required: false } },
  },
  {
    name: "missing pinned Flow",
    capture: (value: CompanyFlowExecutionSnapshot) => value,
    patch: { flow_revision_id: null },
  },
  {
    name: "fabricated project",
    capture: (value: CompanyFlowExecutionSnapshot) => value,
    patch: { project_id: "fabricated" },
  },
])(
  "refuses invalid graph provenance at the database boundary: $name",
  async ({ capture, patch }) => {
    const compatibility = vi.spyOn(engine, "isEngineCompatible");

    try {
      const valid = await prepareFreshGraphReservation();
      const before = await counts();

      await expect(
        database.db.transaction((tx) =>
          insertClonedGraphReservation(tx, randomUUID(), capture(valid), patch),
        ),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
      expect(await counts()).toEqual(before);
    } finally {
      compatibility.mockRestore();
    }
  },
);

it.each([
  {
    name: "producer identity",
    patch: { producerNodeIds: ["fabricated-producer"] },
  },
  {
    name: "native validation contract",
    patch: { nativeContract: "fabricated_contract" },
  },
])(
  "binds the frozen export routing to its pinned manifest: $name",
  async ({ patch }) => {
    const compatibility = vi.spyOn(engine, "isEngineCompatible");

    try {
      const capture = await prepareFreshGraphReservation();
      const retained = (
        await database.pool.query<{ result_contract: Record<string, unknown> }>(
          "SELECT result_contract FROM runs WHERE id=$1",
          [storedFlowRunId],
        )
      ).rows[0]!;
      const before = await counts();
      const runId = randomUUID();

      await expect(
        database.db.transaction(async (tx) => {
          await insertClonedGraphReservation(tx, runId, capture, {
            result_contract: { ...retained.result_contract, ...patch },
          });
          await linkSpecialistAssignmentRunInTransaction(
            tx,
            requesterId,
            capture.assignment.id,
            {
              runId,
              inputRevision: capture.assignment.inputRevision,
              expectedRevision: capture.assignmentRevision,
              role: "coordinator",
              work: null,
            },
          );
        }),
      ).rejects.toMatchObject({
        cause: {
          code: "23514",
          constraint: "runs_company_execution_reference_check",
        },
      });
      expect(await counts()).toEqual(before);
    } finally {
      compatibility.mockRestore();
    }
  },
);

it.each(["missing", "wrong_role"] as const)(
  "requires the exact coordinator/input link at commit: %s",
  async (link) => {
    const compatibility = vi.spyOn(engine, "isEngineCompatible");

    try {
      const capture = await prepareFreshGraphReservation();
      const before = await counts();
      const runId = randomUUID();

      await expect(
        database.db.transaction(async (tx) => {
          await insertClonedGraphReservation(tx, runId, capture, {});
          if (link === "wrong_role")
            await tx.execute(sql`
        INSERT INTO specialist_run_links(assignment_id,run_id,input_revision,role)
        VALUES(${capture.assignment.id},${runId},${capture.assignment.inputRevision},'specialist')
      `);
        }),
      ).rejects.toMatchObject({
        cause: {
          code: "23514",
          constraint: "runs_company_execution_link_check",
        },
      });
      expect(await counts()).toEqual(before);
    } finally {
      compatibility.mockRestore();
    }
  },
);

it.each(["flow_version", "flow_revision"] as const)(
  "preserves immutable retained graph source identity: %s",
  async (column) => {
    const statement =
      column === "flow_version"
        ? "UPDATE runs SET flow_version='retargeted' WHERE id=$1"
        : "UPDATE runs SET flow_revision='retargeted' WHERE id=$1";

    await expect(
      database.pool.query(statement, [storedFlowRunId]),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "runs_company_execution_immutable",
    });
  },
);

it("reserves one native company graph with frozen sessions/placement, refuses a disabled runner and admits an explicit runner without platform defaults", async () => {
  const supervisor = await startRealSupervisor({
    runtimeRoot: join(root, "reservation-host"),
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang"],
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const compatibility = vi.spyOn(engine, "isEngineCompatible");
  const runnerId = randomUUID();

  setDefaultTransportForTests(null);
  resetResolverForTests();
  resetRegistrarStateForTests();
  try {
    await database.db.insert(platformAcpRunners).values({
      id: runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "company-graph-reservation-fixture",
      provider: { kind: "anthropic" },
      readinessStatus: "Ready",
    });
    await database.db
      .insert(platformRuntimeSettings)
      .values({ id: "singleton", defaultRunnerId: runnerId });
    const hosts = createExecutionHosts({
      db: database.db,
      transport: createLocalDirectTransport(),
    });
    const input = await createFreshCompanyFlowRequest();
    const before = await counts();
    const raced = await Promise.allSettled([
      reserveCompanyFlowRun(database.db, requesterId, input, hosts),
      reserveCompanyFlowRun(database.db, requesterId, input, hosts),
    ]);
    const accepted = raced.filter((item) => item.status === "fulfilled");

    expect(accepted).toHaveLength(1);
    expect(raced.filter((item) => item.status === "rejected")).toMatchObject([
      { reason: { code: "CONFLICT" } },
    ]);
    const winner = accepted[0];

    if (!winner || winner.status !== "fulfilled")
      throw new Error("The native reservation winner is missing");
    expect(winner.value).toMatchObject({
      assignmentId: input.assignmentId,
      assignmentRevision: 3,
      status: "Pending",
    });
    expect(await counts()).toEqual({
      ...before,
      runs: before.runs + 1,
      sessions: before.sessions + 1,
      links: before.links + 1,
    });
    const retained = (
      await database.pool.query(
        "SELECT r.run_kind,r.project_id,r.task_id,r.flow_id,r.company_execution_snapshot,r.knowledge_access,s.session_name,s.runner_id,s.runner_snapshot,a.epoch AS assignment_epoch FROM runs r JOIN run_sessions s ON s.run_id=r.id JOIN execution_assignments a ON a.id=r.execution_assignment_id WHERE r.id=$1",
        [winner.value.runId],
      )
    ).rows[0];

    expect(retained).toMatchObject({
      run_kind: "flow",
      project_id: null,
      task_id: null,
      flow_id: null,
      company_execution_snapshot: {
        schemaVersion: 2,
        executionKind: "flow",
        assignment: {
          id: input.assignmentId,
          inputRevision: input.inputRevision,
        },
      },
      knowledge_access: {
        schemaVersion: 1,
        state: "complete",
        restrictions: [
          {
            kind: "assignment_input",
            assignmentId: input.assignmentId,
            inputRevision: input.inputRevision,
          },
        ],
      },
      session_name: "default",
      runner_id: runnerId,
      runner_snapshot: { id: runnerId },
      assignment_epoch: 1,
    });
    const rejectedInput = await createFreshCompanyFlowRequest();
    const beforeDisabled = await counts();

    await database.pool.query(
      "UPDATE platform_acp_runners SET enabled=false WHERE id=$1",
      [runnerId],
    );
    await expect(
      reserveCompanyFlowRun(database.db, requesterId, rejectedInput, hosts),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
    expect(await counts()).toEqual(beforeDisabled);
    await database.pool.query(
      "UPDATE platform_acp_runners SET enabled=true WHERE id=$1",
      [runnerId],
    );
    await database.pool.query(
      "DELETE FROM platform_runtime_settings WHERE id='singleton'",
    );
    const context = await database.db.transaction((tx) =>
      prepareCompanyFlowContext(tx, requesterId, rejectedInput),
    );
    const configuration = context.binding.snapshot;
    const specialist = await updateCompanySpecialistBinding(
      database.db,
      requesterId,
      configuration.agentId,
      request.bindingId,
      {
        owner: context.owner,
        packageInstallId: configuration.packageInstallId,
        packageRevision: configuration.packageRevision,
        definitionSha256: configuration.definitionSha256,
        enabled: true,
        configuration: configuration.configuration,
        grantActions: [...configuration.grantActions],
        runnerId,
        executionPolicy: configuration.executionPolicy,
        coordinatorFlowRevisionId: configuration.coordinatorFlowRevisionId,
        expectedRevision: request.bindingRevision,
        idempotencyKey: randomUUID(),
      },
    );
    const current = await getCompanyFlowBinding(
      database.db,
      requesterId,
      request.coordinatorBindingId,
    );
    const coordinator = await updateCompanyFlowBinding(
      database.db,
      requesterId,
      current.id,
      {
        owner: current.owner,
        specialistBindingId: request.bindingId,
        specialistRevision: specialist.specialist.configRevision,
        flowRevisionId: current.configuration.flowRevisionId,
        manifestSha256: current.configuration.manifestSha256,
        execution: current.configuration.execution,
        roleMappings: current.configuration.roleMappings,
        enabled: true,
        expectedRevision: current.revision,
        idempotencyKey: randomUUID(),
      },
    );

    request = {
      ...request,
      bindingRevision: specialist.specialist.configRevision,
      coordinatorBindingRevision: coordinator.binding.revision,
    };
    const explicit = await reserveCompanyFlowRun(
      database.db,
      requesterId,
      {
        ...rejectedInput,
        bindingRevision: request.bindingRevision,
        coordinatorBindingRevision: request.coordinatorBindingRevision,
      },
      hosts,
    );

    nativeFlowRunId = explicit.runId;
    expect(explicit.status).toBe("Pending");
    expect(
      (
        await database.pool.query(
          "SELECT runner_id,runner_resolution_tier,resolution_source FROM run_sessions WHERE run_id=$1",
          [explicit.runId],
        )
      ).rows,
    ).toEqual([
      {
        runner_id: runnerId,
        runner_resolution_tier: "binding",
        resolution_source: "company-specialist-binding",
      },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT (SELECT count(*)::int FROM platform_runtime_settings) AS defaults,(SELECT count(*)::int FROM project_tokens) AS tokens,(SELECT count(*)::int FROM execution_commands) AS commands,(SELECT count(*)::int FROM workspaces) AS workspaces",
        )
      ).rows[0],
    ).toEqual({ defaults: 0, tokens: 2, commands: 0, workspaces: 0 });
    // Retain this admitted context fixture in the pool until its later node tests.
    // Completing a separate controlled traversal must not dispatch it after host teardown.
    expect(
      await tryStartRun(nativeFlowRunId, { db: database.db }),
    ).toMatchObject({ started: true });
  } finally {
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    compatibility.mockRestore();
    resetResolverForTests();
    resetRegistrarStateForTests();
    setDefaultTransportForTests(null);
  }
}, 120000);

it("retains a v2 company graph plain-directory witness and adopts its explicit owner through the existing real host boundary", async () => {
  const [run] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, nativeFlowRunId));

  if (!run) throw new Error("The native graph reservation is missing");
  const owner = await operationalWorkspace(database.db, run);

  expect(owner).toMatchObject({
    ownerKind: "company",
    companyId: request.companyId,
    resourceKind: "plain_directory",
    repoPath: null,
    projectSlug: null,
  });
  await mkdir(owner.cwd, { recursive: true });
  await writeFile(
    join(owner.cwd, "observations.txt"),
    "Bounded graph evidence",
  );
  const baseline = await captureOperationalGeneration(
    owner.cwd,
    await captureOperationalBaseline(owner.cwd, "plain_directory"),
    [],
  );
  const retained = {
    ...run,
    operationalIntegrityBaseline: {
      ...baseline,
      owner: {
        kind: "company" as const,
        companyId: request.companyId,
        runId: nativeFlowRunId,
        cwd: owner.cwd,
        runtimePath: owner.runtimePath,
      },
    },
  };

  await database.db
    .update(runs)
    .set({
      operationalIntegrityBaseline: retained.operationalIntegrityBaseline,
    })
    .where(eq(runs.id, nativeFlowRunId));
  await expect(
    inspectOperationalWorkspace(database.db, retained),
  ).resolves.toMatchObject({ verdict: "clean" });
  await writeFile(
    join(owner.cwd, "observations.txt"),
    "Changed graph evidence",
  );
  await expect(
    inspectOperationalWorkspace(database.db, retained),
  ).resolves.toMatchObject({ verdict: "changed" });
  await writeFile(
    join(owner.cwd, "observations.txt"),
    "Bounded graph evidence",
  );
  await expect(
    operationalWorkspace(database.db, {
      ...retained,
      operationalIntegrityBaseline: {
        ...retained.operationalIntegrityBaseline,
        owner: { ...retained.operationalIntegrityBaseline.owner, cwd: root },
      },
    }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "company_workspace_owner_mismatch" },
  });
  const spec = await loadWorkspaceSpecInput(database.db, nativeFlowRunId);

  expect(spec.company).toMatchObject({
    companyId: request.companyId,
    executionKind: "flow",
  });
  if (!spec.company)
    throw new Error("The native company graph has no explicit adoption owner");
  expect(() =>
    workspaceSpecFor({
      ...spec,
      company: { ...spec.company, executionKind: "agent" },
    }),
  ).toThrowError(expect.objectContaining({ code: "PRECONDITION" }));
  expect(workspaceSpecFor(spec)).toMatchObject({
    owner: { kind: "company", companyId: request.companyId },
    projectSlug: "_company",
    kind: "directory",
    path: owner.cwd,
  });
  const supervisor = await startRealSupervisor({
    runtimeRoot: join(root, "reservation-host"),
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang"],
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);

  setDefaultTransportForTests(null);
  resetResolverForTests();
  resetRegistrarStateForTests();
  try {
    const hosts = createExecutionHosts({
      db: database.db,
      transport: createLocalDirectTransport(),
    });
    const client = await hosts.forRun(nativeFlowRunId, { reason: "launch" });
    const handle = await client.ensureWorkspace();

    await expect(hosts.local().getWorkspace(handle)).resolves.toMatchObject({
      runId: nativeFlowRunId,
      owner: { kind: "company", companyId: request.companyId },
      projectSlug: "_company",
      kind: "directory",
      releasedAt: null,
    });
    expect(await client.ensureWorkspace()).toBe(handle);
    expect(
      (
        await database.pool.query(
          "SELECT (SELECT count(*)::int FROM workspaces) AS workspaces,(SELECT count(*)::int FROM projects) AS projects",
        )
      ).rows[0],
    ).toEqual({ workspaces: 0, projects: 0 });
  } finally {
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    resetResolverForTests();
    resetRegistrarStateForTests();
    setDefaultTransportForTests(null);
  }
});

it("loads frozen company graph input and sessions without repository records, refusing unsupported hosts, disabled runners and changed schema bytes", async () => {
  const before = await counts();

  const older = useEngineVersion("3.11.1");

  try {
    await expect(
      database.db.transaction((tx) =>
        loadCompanyFlowSessionContext(tx, nativeFlowRunId),
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { flowManifestIncompatibility: { kind: "engine_incompatible" } },
    });
  } finally {
    older.mockRestore();
  }
  const compatibility = vi.spyOn(engine, "isEngineCompatible");

  try {
    const context = await database.db.transaction((tx) =>
      loadCompanyFlowSessionContext(tx, nativeFlowRunId),
    );

    expect(context).toMatchObject({
      run: { id: nativeFlowRunId, projectId: null, taskId: null, flowId: null },
      owner: { snapshot: { schemaVersion: 2, executionKind: "flow" } },
      input: {
        snapshot: { objectiveInput: preparedAssignment.objectiveInput },
      },
      primarySessionName: "default",
      sessions: [{ sessionName: "default" }],
      flowRefId: "rah-control",
      resultContract: { kind: "flow_export", required: true },
    });
    expect(context).not.toHaveProperty("task");
    expect(context).not.toHaveProperty("project");
    const { loadRun } = await import("@/lib/flows/graph/runner-core");
    const graphRun = await loadRun(database.db, nativeFlowRunId);

    expect(graphRun).toMatchObject({
      run: {
        id: nativeFlowRunId,
        companyId: request.companyId,
        projectId: null,
      },
      task: null,
      flow: null,
      workspace: null,
      projectSlug: "_company",
      companyContext: { input: context.input },
      execTrust: "trusted",
    });
    expect([...graphRun.sessions.keys()]).toEqual(["default"]);
    expect(graphRun.sessions.get("default")?.runner).toEqual(
      context.sessions[0]?.runnerSnapshot,
    );
    const session = context.sessions[0]!;

    await database.pool.query(
      "UPDATE platform_acp_runners SET enabled=false WHERE id=$1",
      [session.runnerId],
    );
    try {
      await expect(
        database.db.transaction((tx) =>
          loadCompanyFlowSessionContext(tx, nativeFlowRunId),
        ),
      ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
    } finally {
      await database.pool.query(
        "UPDATE platform_acp_runners SET enabled=true WHERE id=$1",
        [session.runnerId],
      );
    }
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`SAVEPOINT missing_company_flow_session`);
      await tx.execute(
        sql`DELETE FROM run_sessions WHERE run_id=${nativeFlowRunId}`,
      );
      try {
        await expect(
          loadCompanyFlowSessionContext(tx, nativeFlowRunId),
        ).rejects.toMatchObject({ code: "CONFIG" });
      } finally {
        await tx.execute(
          sql`ROLLBACK TO SAVEPOINT missing_company_flow_session`,
        );
      }
    });
    const original = await readFile(schemaPath, "utf8");

    try {
      await writeFile(schemaPath, original + "\n ");
      await expect(
        database.db.transaction((tx) =>
          loadCompanyFlowSessionContext(tx, nativeFlowRunId),
        ),
      ).rejects.toMatchObject({ code: "CONFIG" });
    } finally {
      await writeFile(schemaPath, original);
    }
    expect(await counts()).toEqual(before);
  } finally {
    compatibility.mockRestore();
  }
});

it("CBS-03 cancels a Pending company Flow with current authority, one attributed outcome and no ACP effect", async () => {
  const supervisor = await startRealSupervisor({
    runtimeRoot: join(root, "reservation-host"),
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang"],
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const compatibility = vi.spyOn(engine, "isEngineCompatible");

  resetResolverForTests();
  resetRegistrarStateForTests();
  setDefaultTransportForTests(null);
  try {
    const hosts = createExecutionHosts({
      db: database.db,
      transport: createLocalDirectTransport(),
    });
    const input = await createFreshCompanyFlowRequest();
    const receipt = await reserveCompanyFlowRun(
      database.db,
      requesterId,
      input,
      hosts,
    );
    const stop = (): Promise<Response> =>
      stopRunPost(
        new Request(`http://localhost/api/runs/${receipt.runId}/stop`, {
          method: "POST",
        }),
        { params: Promise.resolve({ runId: receipt.runId }) },
      );

    browserUserId = requesterId;
    expect((await stop()).status).toBe(403);
    const cancellation = await createCompanyGrants(
      database.db,
      administratorId,
      {
        principalKind: "user",
        principalId: requesterId,
        actions: ["assignments:cancel"],
        idempotencyKey: randomUUID(),
      },
    );

    const responses = await Promise.all([stop(), stop()]);

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        runId: receipt.runId,
        runStatus: "Abandoned",
        supervisorStopped: false,
      });
    }
    expect((await stop()).status).toBe(200);
    expect(
      (
        await database.pool.query(
          "SELECT company_cancellation_intent->>'userId' AS user_id FROM runs WHERE id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([{ user_id: requesterId }]);
    await expect(
      database.pool.query(
        "UPDATE runs SET company_cancellation_intent=NULL WHERE id=$1",
        [receipt.runId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "runs_company_cancellation_immutable",
    });
    const placement = (
      await database.pool.query<{ id: string; host_id: string; epoch: number }>(
        "SELECT assignment.id,assignment.execution_host_id AS host_id,assignment.epoch FROM runs execution JOIN execution_assignments assignment ON assignment.id=execution.execution_assignment_id WHERE execution.id=$1",
        [receipt.runId],
      )
    ).rows[0]!;

    await expect(
      insertCommand(database.db, {
        runId: receipt.runId,
        assignmentId: placement.id,
        hostId: placement.host_id,
        assignmentEpoch: placement.epoch,
        kind: "session.create",
        payload: {},
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "company_cancellation_pending" },
    });
    expect(
      (
        await database.pool.query(
          "SELECT status,operational_terminal FROM runs WHERE id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([{ status: "Abandoned", operational_terminal: null }]);
    expect(
      (
        await database.pool.query(
          "SELECT kind,company_id,project_id,actor_type,actor_id FROM domain_events WHERE run_id=$1 AND kind='run.abandoned'",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([
      {
        kind: "run.abandoned",
        company_id: input.companyId,
        project_id: null,
        actor_type: "user",
        actor_id: requesterId,
      },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await database.pool.query(
          "SELECT status FROM specialist_assignments WHERE id=$1",
          [input.assignmentId],
        )
      ).rows,
    ).toEqual([{ status: "active" }]);
    await revokeCompanyGrant(
      database.db,
      administratorId,
      cancellation.page.items[0]!.id,
      {
        expectedRevision: cancellation.page.items[0]!.revision,
        reason: "Withdraw cancellation authority before replay",
        idempotencyKey: randomUUID(),
      },
    );
    expect((await stop()).status).toBe(403);
  } finally {
    browserUserId = requesterId;
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    compatibility.mockRestore();
    resetResolverForTests();
    resetRegistrarStateForTests();
    setDefaultTransportForTests(null);
  }
}, 120000);

it("CBS-03 executes a native company graph through the existing driver, real supervisor and controlled ACP process without repository records", async () => {
  const hostRoot = join(root, "reservation-host");
  const previousRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;

  vi.stubEnv("MAISTER_RUNTIME_ROOT", hostRoot);
  await writeCompanyCapabilityCache(hostRoot);
  const supervisor = await startRealSupervisor({
    runtimeRoot: hostRoot,
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang"],
    env: {
      MAISTER_ADAPTER_SMOKE_CACHE_PATH: join(
        hostRoot,
        "adapter-smoke-cache.json",
      ),
    },
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const compatibility = vi.spyOn(engine, "isEngineCompatible");
  const worker = startProjectionWorker({
    db: database.db,
    projectors: canonicalProjectors,
  });
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;

  setDefaultTransportForTests(null);
  resetResolverForTests();
  resetRegistrarStateForTests();
  try {
    const output = {
      schemaVersion: 1,
      findings: [],
      knowledgeProposals: [],
      selection: [],
    };
    const { expectedResult: _expectedResult, ...objective } =
      preparedAssignment.objectiveInput;
    const manualRequest = {
      ...objective,
      owner: preparedAssignment.owner,
      specialistBindingId: preparedAssignment.specialistBindingId,
      input:
        "\nfixture-output:" +
        JSON.stringify({
          bytes: 0,
          text: "```json maister:output\n" + JSON.stringify(output) + "\n```",
        }) +
        "\n",
      idempotencyKey: randomUUID(),
    };
    const hosts = createExecutionHosts({
      db: database.db,
      transport: createLocalDirectTransport(),
    });

    await expect(hosts.local().diagnostics()).resolves.toMatchObject({
      kind: "ready",
      diagnostics: {
        adapters: expect.arrayContaining([
          expect.objectContaining({
            id: "claude",
            smoke: expect.objectContaining({
              capabilityEnforcement: expect.objectContaining({ status: "ok" }),
            }),
          }),
        ]),
      },
    });
    const submitManual = (value: unknown): Promise<Response> =>
      assignmentPost(
        new NextRequest("http://localhost/api/specialist-assignments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        }),
      );

    await database.pool.query(
      "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
    );
    const deliveries = await Promise.all([
      (async () => {
        const response = await submitManual(manualRequest);

        expect([200, 201]).toContain(response.status);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const assignment = specialistAssignmentSchema.parse(
          await response.json(),
        );

        return { assignment, duplicate: response.status === 200 };
      })(),
      reserveCompanyManualAssignment(
        database.db,
        requesterId,
        manualRequest,
        hosts,
      ),
    ]);

    expect(deliveries.map((delivery) => delivery.duplicate).sort()).toEqual([
      false,
      true,
    ]);
    expect(
      new Set(deliveries.map((delivery) => delivery.assignment.id)).size,
    ).toBe(1);
    const assignment = deliveries[0]!.assignment;

    expect(assignment.runIds).toHaveLength(1);
    expect(deliveries[1]!.assignment.runIds).toEqual(assignment.runIds);
    const receipt = { runId: assignment.runIds[0]! };
    const inspect = (assignmentId: string): Promise<Response> =>
      assignmentGet(
        new NextRequest(
          "http://localhost/api/specialist-assignments/" + assignmentId,
        ),
        {
          params: Promise.resolve({ assignmentId }),
        },
      );

    expect(
      (
        await database.pool.query("SELECT status FROM runs WHERE id=$1", [
          receipt.runId,
        ])
      ).rows,
    ).toEqual([{ status: "Pending" }]);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    const inspected = await inspect(assignment.id);

    expect(inspected.status).toBe(200);
    expect(inspected.headers.get("cache-control")).toBe("private, no-store");
    expect(specialistAssignmentSchema.parse(await inspected.json())).toEqual(
      assignment,
    );
    expect((await inspect(randomUUID())).status).toBe(404);
    browserUserId = outsiderId;
    try {
      expect((await inspect(assignment.id)).status).toBe(403);
    } finally {
      browserUserId = requesterId;
    }
    expect(
      (
        await submitManual({
          ...manualRequest,
          authority: { action: "assignments:update" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await submitManual({
          ...manualRequest,
          objective: "Different HTTP work under the same key",
        })
      ).status,
    ).toBe(409);
    browserAuthenticated = false;
    try {
      expect((await submitManual(manualRequest)).status).toBe(401);
      expect((await inspect(assignment.id)).status).toBe(401);
    } finally {
      browserAuthenticated = true;
    }
    await database.pool.query("DELETE FROM execution_host_pressure");

    expect(await tryStartRun(receipt.runId, { db: database.db })).toMatchObject(
      { started: true },
    );
    // Keep unrelated admission fixtures queued while this controlled traversal owns its host.
    vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
    await Promise.all([
      runFlow(receipt.runId, {
        db: database.db,
        executionHosts: hosts,
        runtimeRoot: hostRoot,
      }),
      runFlow(receipt.runId, {
        db: database.db,
        executionHosts: hosts,
        runtimeRoot: hostRoot,
      }),
    ]);
    const [completed] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, receipt.runId));

    expect(completed).toMatchObject({
      status: "Done",
      projectId: null,
      companyId: request.companyId,
      taskId: null,
      flowId: null,
      operationalIntegrityBaseline: {
        owner: { kind: "company", companyId: request.companyId },
      },
      operationalCleanup: {
        state: "released",
        resourceKind: "plain_directory",
        workspace: "none",
      },
    });
    const commands = await database.pool.query<{ kind: string }>(
      "SELECT kind FROM execution_commands WHERE run_id=$1",
      [receipt.runId],
    );

    expect(
      commands.rows.filter((command) => command.kind === "session.create"),
    ).toHaveLength(1);
    expect(
      commands.rows.filter((command) => command.kind === "session.prompt"),
    ).toHaveLength(1);
    expect(
      (
        await database.pool.query(
          "SELECT validity,value FROM run_results WHERE run_id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toMatchObject([{ validity: "valid", value: output }]);
    const beforeRefusal = await counts();
    const businessBeforeRefusal = await intakeBusinessCounts(database);

    await expect(
      reserveCompanyManualAssignment(
        database.db,
        requesterId,
        { ...manualRequest, authority: { action: "assignments:update" } },
        hosts,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
    await expect(
      reserveCompanyManualAssignment(
        database.db,
        requesterId,
        {
          ...manualRequest,
          objective: "Changed work under the same manual delivery",
        },
        hosts,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "specialist_intake_payload_conflict" },
    });
    const submitOnly = await createCompanyGrants(database.db, administratorId, {
      principalKind: "user",
      principalId: outsiderId,
      actions: ["assignments:read", "assignments:submit"],
      idempotencyKey: randomUUID(),
    });

    try {
      await expect(
        reserveCompanyManualAssignment(
          database.db,
          outsiderId,
          { ...manualRequest, idempotencyKey: randomUUID() },
          hosts,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      for (const grant of submitOnly.page.items.filter(
        (entry) =>
          entry.principalKind === "user" &&
          entry.principalId === outsiderId &&
          entry.revokedAt === null &&
          ["assignments:read", "assignments:submit"].includes(entry.action),
      )) {
        await revokeCompanyGrant(database.db, administratorId, grant.id, {
          expectedRevision: grant.revision,
          reason: "Restore the isolated unauthorized intake fixture",
          idempotencyKey: randomUUID(),
        });
      }
    }
    expect(await counts()).toEqual(beforeRefusal);
    expect(await intakeBusinessCounts(database)).toEqual(businessBeforeRefusal);
    const selector = { runId: receipt.runId, revision: 1 };
    const resultBeforeInspection = (
      await database.pool.query("SELECT * FROM run_results WHERE run_id=$1", [
        receipt.runId,
      ])
    ).rows;

    await expect(
      loadRetainedResultForUser(database.db, requesterId, selector),
    ).resolves.toMatchObject({
      ...selector,
      value: output,
      validity: "valid",
      collectedAt: null,
      findings: output,
    });
    const inspectionRequest = new Request(
      `http://localhost/api/runs/${receipt.runId}/results/1`,
    );
    const inspectionParams = {
      params: Promise.resolve({ runId: receipt.runId, revision: "1" }),
    };
    const inspection = await retainedResultGet(
      inspectionRequest,
      inspectionParams,
    );

    expect(inspection.status).toBe(200);
    expect(inspection.headers.get("Cache-Control")).toBe("no-store");
    expect(await inspection.json()).toMatchObject({
      ...selector,
      value: output,
    });
    const originalInput = await getSpecialistAssignmentInput(
      database.db,
      requesterId,
      assignment.id,
      1,
    );

    await expect(
      loadNativeInputForUser(database.db, requesterId, receipt.runId),
    ).resolves.toEqual({
      kind: "assignment_input",
      input: originalInput,
    });
    for (const locale of ["en", "ru"] as const) {
      browserLocale = locale;
      const catalog = locale === "ru" ? ruMessages : enMessages;
      const markup = renderToStaticMarkup(
        await NativeInputInspectionPanel({
          input: { kind: "assignment_input", input: originalInput },
        }),
      );

      expect(markup).toContain('data-testid="assignment-input-inspection"');
      expect(markup).toContain(catalog.run.originalInput.assignmentTitle);
      expect(markup).toContain(catalog.run.originalInput.objectiveSnapshot);
      expect(markup).toContain(catalog.run.originalInput.standingSnapshot);
      expect(markup).toContain(catalog.run.originalInput.authoritySnapshot);
      expect(markup).toContain(catalog.run.originalInput.notScheduled);
      expect(markup).toContain(originalInput.digest);
      expect(markup).toContain(originalInput.assignmentId);
      expect(markup).not.toContain("/runs/undefined");
    }
    browserLocale = "en";
    await expect(
      loadRetainedResultForUser(database.db, requesterId, {
        ...selector,
        revision: 2,
      }),
    ).resolves.toBeNull();
    browserUserId = outsiderId;
    expect(
      (await retainedResultGet(inspectionRequest, inspectionParams)).status,
    ).toBe(404);
    let reviewerGrant = await createCompanyGrants(
      database.db,
      administratorId,
      {
        principalKind: "user",
        principalId: outsiderId,
        actions: ["assignments:read"],
        idempotencyKey: randomUUID(),
      },
    );

    await expect(
      loadRetainedResultForUser(database.db, outsiderId, selector),
    ).resolves.toMatchObject({ value: output });
    const racedDb: SqlDatabase = {
      execute: database.db.execute.bind(database.db),
      async transaction<T>(
        action: (tx: SqlTransaction) => Promise<T>,
      ): Promise<T> {
        const assembled = await database.db.transaction(action);

        if (
          assembled !== null &&
          typeof assembled === "object" &&
          ("publishedAt" in assembled ||
            ("kind" in assembled && assembled.kind === "assignment_input"))
        ) {
          await revokeCompanyGrant(
            database.db,
            administratorId,
            reviewerGrant.page.items[0]!.id,
            {
              expectedRevision: reviewerGrant.page.items[0]!.revision,
              reason:
                "Revoke company inspection after assembly and before delivery",
              idempotencyKey: randomUUID(),
            },
          );
        }

        return assembled;
      },
    };

    await expect(
      loadRetainedResultForUser(racedDb, outsiderId, selector),
    ).resolves.toBeNull();
    expect(
      (await retainedResultGet(inspectionRequest, inspectionParams)).status,
    ).toBe(404);
    await expect(
      loadNativeInputForUser(database.db, outsiderId, receipt.runId),
    ).resolves.toBeNull();
    reviewerGrant = await createCompanyGrants(database.db, administratorId, {
      principalKind: "user",
      principalId: outsiderId,
      actions: ["assignments:read"],
      idempotencyKey: randomUUID(),
    });
    await expect(
      loadNativeInputForUser(database.db, outsiderId, receipt.runId),
    ).resolves.toEqual({
      kind: "assignment_input",
      input: originalInput,
    });
    await expect(
      loadNativeInputForUser(racedDb, outsiderId, receipt.runId),
    ).resolves.toBeNull();
    browserUserId = requesterId;
    expect(
      (
        await database.pool.query("SELECT * FROM run_results WHERE run_id=$1", [
          receipt.runId,
        ])
      ).rows,
    ).toEqual(resultBeforeInspection);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM project_tokens WHERE company_run_id=$1 AND revoked_at IS NULL",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await database.pool.query(
          "SELECT status FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows,
    ).toEqual([{ status: "active" }]);
    expect(
      (await hosts.local().listSessions()).filter(
        (session) => session.runId === receipt.runId,
      ),
    ).toMatchObject([{ status: "exited" }]);
    expect(
      (
        await database.pool.query(
          "SELECT (SELECT count(*)::int FROM projects) AS projects,(SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM workspaces) AS workspaces",
        )
      ).rows,
    ).toEqual([{ projects: 0, tasks: 0, workspaces: 0 }]);
    for (const refusal of [
      { name: "missing", text: "No structured result was produced." },
      {
        name: "invalid",
        text: '```json maister:output\n{"schemaVersion":1,"findings":"invalid","knowledgeProposals":[],"selection":[]}\n```',
      },
    ]) {
      const work = await createSpecialistAssignment(database.db, requesterId, {
        ...preparedAssignment,
        origin: { kind: "manual", interactionId: randomUUID() },
        objectiveInput: {
          ...preparedAssignment.objectiveInput,
          objective: `Qualify ${refusal.name} required native result`,
          input:
            "\nfixture-output:" +
            JSON.stringify({ bytes: 0, text: refusal.text }) +
            "\n",
        },
      });
      const refused = await reserveCompanyFlowRun(
        database.db,
        requesterId,
        {
          ...request,
          assignmentId: work.id,
          assignmentRevision: work.revision,
          inputRevision: work.inputRevision,
        },
        hosts,
      );

      vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "2");
      expect(
        await tryStartRun(refused.runId, { db: database.db }),
      ).toMatchObject({
        started: true,
      });
      vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
      await runFlow(refused.runId, {
        db: database.db,
        executionHosts: hosts,
        runtimeRoot: hostRoot,
      });
      expect(
        (
          await database.pool.query(
            "SELECT status,operational_terminal,operational_cleanup->>'state' AS cleanup FROM runs WHERE id=$1",
            [refused.runId],
          )
        ).rows,
      ).toEqual([
        { status: "Failed", operational_terminal: null, cleanup: "released" },
      ]);
      expect(
        (
          await database.pool.query(
            "SELECT status,error_code FROM node_attempts WHERE run_id=$1",
            [refused.runId],
          )
        ).rows,
      ).toEqual([{ status: "Failed", error_code: "CONFIG" }]);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM run_results WHERE run_id=$1",
            [refused.runId],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        (
          await database.pool.query(
            "SELECT status FROM specialist_assignments WHERE id=$1",
            [work.id],
          )
        ).rows,
      ).toEqual([{ status: "active" }]);
    }
    const stale = await database.pool.query<{ id: string }>(
      "SELECT id FROM runs WHERE company_id=$1 AND run_kind='flow' AND status='Pending' AND (company_execution_snapshot->'coordinatorFlowBinding'->>'revision')::int < $2 ORDER BY id LIMIT 1",
      [request.companyId, request.coordinatorBindingRevision],
    );

    expect(stale.rows).toHaveLength(1);
    const staleRunId = stale.rows[0]!.id;

    vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "100");
    expect(await tryStartRun(staleRunId, { db: database.db })).toMatchObject({
      started: true,
    });
    await expect(
      runFlow(staleRunId, {
        db: database.db,
        executionHosts: hosts,
        runtimeRoot: hostRoot,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      (
        await database.pool.query("SELECT status FROM runs WHERE id=$1", [
          staleRunId,
        ])
      ).rows,
    ).toEqual([{ status: "Failed" }]);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
          [staleRunId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    const cronRequest =
      "Inspect the configured target through its pinned native coordinator.\nfixture-output:" +
      JSON.stringify({
        bytes: 0,
        text: "```json maister:output\n" + JSON.stringify(output) + "\n```",
      });
    const graphCron = await createCompanyCronSchedule(
      database.db,
      requesterId,
      {
        owner: { kind: "company", companyId: request.companyId },
        specialistBindingId: request.bindingId,
        coordinatorFlowBindingId: request.coordinatorBindingId,
        cronExpr: "*/5 * * * *",
        timezone: "UTC",
        requestAtLaunch: cronRequest,
        enabled: true,
        idempotencyKey: randomUUID(),
      },
    );

    await database.pool.query(
      "UPDATE agent_schedules SET next_fire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [graphCron.scheduleId],
    );
    expect(await runSchedulerTick({ jobKind: "agent_tick" })).toMatchObject({
      succeededCount: 1,
      failedCount: 0,
    });
    const graphAttempt = (
      await database.pool.query(
        "SELECT id,reserved_run_id,run_id,outcome FROM agent_trigger_attempts WHERE schedule_id=$1",
        [graphCron.scheduleId],
      )
    ).rows;

    expect(graphAttempt).toHaveLength(1);
    expect(graphAttempt[0]).toMatchObject({
      run_id: graphAttempt[0].reserved_run_id,
      outcome: "queued",
    });
    await vi.waitFor(
      async () => {
        const [scheduled] = await database.db
          .select()
          .from(runs)
          .where(eq(runs.id, graphAttempt[0].reserved_run_id));

        expect(scheduled).toMatchObject({
          status: "Done",
          runKind: "flow",
          projectId: null,
          taskId: null,
          flowId: null,
          companyId: request.companyId,
          agentScheduleId: graphCron.scheduleId,
          operationalTerminal: null,
          scheduledRequestSnapshot: {
            version: 1,
            scheduleId: graphCron.scheduleId,
            triggerAttemptId: graphAttempt[0].id,
            requestAtLaunch: cronRequest,
          },
        });
      },
      { timeout: 30000, interval: 25 },
    );
    expect(
      (
        await database.pool.query(
          "SELECT validity,value FROM run_results WHERE run_id=$1",
          [graphAttempt[0].reserved_run_id],
        )
      ).rows,
    ).toEqual([{ validity: "valid", value: output }]);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM projects UNION ALL SELECT count(*)::int AS count FROM tasks",
          [],
        )
      ).rows,
    ).toEqual([{ count: 0 }, { count: 0 }]);
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    resetResolverForTests();
    resetRegistrarStateForTests();
    const originalSchema = `${schemaPath}.manual-replay-${randomUUID()}`;
    const beforeOfflineReplay = await counts();
    const businessBeforeReplay = await intakeBusinessCounts(database);

    await rename(schemaPath, originalSchema);
    try {
      const replay = await submitManual(manualRequest);

      expect(replay.status).toBe(200);
      expect(
        specialistAssignmentSchema.parse(await replay.json()),
      ).toMatchObject({
        id: assignment.id,
        runIds: [receipt.runId],
      });
    } finally {
      await rename(originalSchema, schemaPath);
    }
    expect(await counts()).toEqual(beforeOfflineReplay);
    expect(await intakeBusinessCounts(database)).toEqual(businessBeforeReplay);
  } finally {
    if (previousRuntimeRoot === undefined)
      delete process.env.MAISTER_RUNTIME_ROOT;
    else process.env.MAISTER_RUNTIME_ROOT = previousRuntimeRoot;
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
    else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousCap;
    await worker.stop();
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    compatibility.mockRestore();
    resetResolverForTests();
    resetRegistrarStateForTests();
    setDefaultTransportForTests(null);
  }
}, 120000);

it("CBS-03 cancels live native graph work once without allowing its completed output to win the stop intent", async () => {
  const hostRoot = join(root, "reservation-host");

  await writeCompanyCapabilityCache(hostRoot);
  const supervisor = await startRealSupervisor({
    runtimeRoot: hostRoot,
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: [
      "--hang",
      "--controlled-terminal",
      "--invocation-log",
      join(root, "native-cancel.jsonl"),
    ],
    env: {
      MAISTER_ADAPTER_SMOKE_CACHE_PATH: join(
        hostRoot,
        "adapter-smoke-cache.json",
      ),
    },
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const compatibility = vi.spyOn(engine, "isEngineCompatible");
  const worker = startProjectionWorker({
    db: database.db,
    projectors: canonicalProjectors,
  });
  const abort = new AbortController();
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  let driver: Promise<Readonly<{ error: unknown | null }>> | undefined;

  setDefaultTransportForTests(null);
  resetResolverForTests();
  resetRegistrarStateForTests();
  try {
    const work = await createSpecialistAssignment(database.db, requesterId, {
      ...preparedAssignment,
      origin: { kind: "manual", interactionId: randomUUID() },
      objectiveInput: {
        ...preparedAssignment.objectiveInput,
        input:
          "\nfixture-output:" +
          JSON.stringify({
            bytes: 0,
            terminalBarrier: "native-cancel",
            text:
              "```json maister:output\n" +
              JSON.stringify({
                schemaVersion: 1,
                findings: [],
                knowledgeProposals: [],
                selection: [],
              }) +
              "\n```",
          }) +
          "\n",
      },
    });
    const hosts = createExecutionHosts({
      db: database.db,
      transport: createLocalDirectTransport(),
    });
    const receipt = await reserveCompanyFlowRun(
      database.db,
      requesterId,
      {
        ...request,
        assignmentId: work.id,
        assignmentRevision: work.revision,
        inputRevision: work.inputRevision,
      },
      hosts,
    );

    expect(await tryStartRun(receipt.runId, { db: database.db })).toMatchObject(
      { started: true },
    );
    vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
    driver = runFlow(receipt.runId, {
      db: database.db,
      executionHosts: hosts,
      runtimeRoot: hostRoot,
      signal: abort.signal,
    }).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await expect
      .poll(
        async () => {
          const log = await readFile(join(root, "native-cancel.jsonl"), "utf8");

          return log
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { method: string })
            .some((entry) => entry.method === "session/prompt/terminal-held");
        },
        { timeout: 15000, interval: 50 },
      )
      .toBe(true);
    const operatorId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [operatorId, `${operatorId}@example.test`],
    );
    await createCompanyGrants(database.db, administratorId, {
      principalKind: "user",
      principalId: operatorId,
      actions: ["assignments:read", "assignments:cancel"],
      idempotencyKey: randomUUID(),
    });
    browserUserId = operatorId;
    const stop = (): Promise<Response> =>
      stopRunPost(
        new Request(`http://localhost/api/runs/${receipt.runId}/stop`, {
          method: "POST",
        }),
        { params: Promise.resolve({ runId: receipt.runId }) },
      );

    await expect
      .poll(
        async () => {
          const response = await stop();
          const body = await response.json();

          if (response.status === 503) {
            expect(body).toMatchObject({
              code: "EXECUTOR_UNAVAILABLE",
              details: { reason: "agent_execution_quiescence_unproven" },
            });

            return "awaiting-canonical-exit";
          }
          expect(response.status).toBe(200);
          expect(body).toMatchObject({
            runId: receipt.runId,
            runStatus: "Abandoned",
          });

          return "abandoned";
        },
        { timeout: 15000, interval: 50 },
      )
      .toBe("abandoned");
    expect(await driver).toEqual({ error: null });
    expect((await stop()).status).toBe(200);
    const cleanup = (
      await database.pool.query<{
        state: string;
        due_at: string | null;
        error_code: string | null;
      }>(
        "SELECT operational_cleanup->>'state' AS state,operational_cleanup->>'dueAt' AS due_at,operational_cleanup->>'errorCode' AS error_code FROM runs WHERE id=$1",
        [receipt.runId],
      )
    ).rows[0]!;

    if (cleanup.state === "retry") {
      expect(cleanup.error_code).toBe("operational_execution_not_quiescent");
      expect(cleanup.due_at).not.toBeNull();
      // Advance only the existing backoff clock; physical and ledger quiescence are still checked by recovery.
      const outcome = await disposeOperationalRun(receipt.runId, {
        db: database.db,
        hosts,
        now: new Date(cleanup.due_at!),
      });
      const openCommands = (
        await database.pool.query(
          "SELECT id,kind,state FROM execution_commands WHERE run_id=$1 AND state<>ALL($2::text[]) ORDER BY created_at,id",
          [receipt.runId, [...TERMINAL_COMMAND_STATES]],
        )
      ).rows;

      expect({ outcome, openCommands }).toEqual({
        outcome: "released",
        openCommands: [],
      });
    }
    expect(
      (
        await database.pool.query(
          "SELECT status,company_cancellation_intent->>'userId' AS user_id,operational_terminal,operational_cleanup->>'state' AS cleanup FROM runs WHERE id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([
      {
        status: "Abandoned",
        user_id: operatorId,
        operational_terminal: null,
        cleanup: "released",
      },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt','session.delete') GROUP BY kind ORDER BY kind",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([
      { kind: "session.create", count: 1 },
      { kind: "session.delete", count: 1 },
      { kind: "session.prompt", count: 1 },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT status FROM specialist_assignments WHERE id=$1",
          [work.id],
        )
      ).rows,
    ).toEqual([{ status: "active" }]);
  } finally {
    browserUserId = requesterId;
    abort.abort();
    await driver;
    await worker.stop();
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    compatibility.mockRestore();
    resetResolverForTests();
    resetRegistrarStateForTests();
    setDefaultTransportForTests(null);
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
    else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousCap;
  }
}, 90000);

it("CBS-03 recovers a published native result after terminal preparation interruption without repeating the completed prompt", async () => {
  const hostRoot = join(root, "reservation-host");

  await writeCompanyCapabilityCache(hostRoot);
  let supervisor = await startRealSupervisor({
    runtimeRoot: hostRoot,
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang"],
    env: {
      MAISTER_ADAPTER_SMOKE_CACHE_PATH: join(
        hostRoot,
        "adapter-smoke-cache.json",
      ),
    },
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const compatibility = vi.spyOn(engine, "isEngineCompatible");
  const worker = startProjectionWorker({
    db: database.db,
    projectors: canonicalProjectors,
  });
  const abort = new AbortController();
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  const direct = createLocalDirectTransport();
  let targetRunId: string | null = null;
  let interrupted = false;
  const transport: typeof direct = {
    ...direct,
    async listSessions() {
      const sessions = await direct.listSessions();

      if (targetRunId && !interrupted) {
        const closed = await database.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM node_attempts WHERE run_id=$1 AND status='Succeeded' AND finish_continuation IS NOT NULL",
          [targetRunId],
        );

        if (closed.rows[0]?.count === 1) {
          interrupted = true;
          abort.abort(
            new DOMException(
              "Controlled interruption after native result publication",
              "AbortError",
            ),
          );
          throw abort.signal.reason;
        }
      }

      return sessions;
    },
  };

  setDefaultTransportForTests(transport);
  resetResolverForTests();
  resetRegistrarStateForTests();
  try {
    const output = {
      schemaVersion: 1,
      findings: [],
      knowledgeProposals: [],
      selection: [],
    };
    const work = await createSpecialistAssignment(database.db, requesterId, {
      ...preparedAssignment,
      origin: { kind: "manual", interactionId: randomUUID() },
      objectiveInput: {
        ...preparedAssignment.objectiveInput,
        input:
          "\nfixture-output:" +
          JSON.stringify({
            bytes: 0,
            text: "```json maister:output\n" + JSON.stringify(output) + "\n```",
          }) +
          "\n",
      },
    });
    const hosts = createExecutionHosts({ db: database.db, transport });
    const receipt = await reserveCompanyFlowRun(
      database.db,
      requesterId,
      {
        ...request,
        assignmentId: work.id,
        assignmentRevision: work.revision,
        inputRevision: work.inputRevision,
      },
      hosts,
    );

    targetRunId = receipt.runId;
    expect(await tryStartRun(receipt.runId, { db: database.db })).toMatchObject(
      { started: true },
    );
    vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
    await expect(
      runFlow(receipt.runId, {
        db: database.db,
        executionHosts: hosts,
        runtimeRoot: hostRoot,
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(interrupted).toBe(true);
    expect(
      (
        await database.pool.query(
          "SELECT status,current_step_id,flow_driver_token,operational_cleanup,company_cancellation_intent FROM runs WHERE id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([
      {
        status: "Running",
        current_step_id: null,
        flow_driver_token: null,
        operational_cleanup: null,
        company_cancellation_intent: null,
      },
    ]);
    const before = (
      await database.pool.query("SELECT * FROM run_results WHERE run_id=$1", [
        receipt.runId,
      ])
    ).rows;

    expect(before).toMatchObject([
      { validity: "valid", value: output, revision: 1 },
    ]);
    await stopRuntimeEventConsumers();
    supervisor = await supervisor.restart();
    resetResolverForTests();
    resetRegistrarStateForTests();
    await runFlow(receipt.runId, {
      db: database.db,
      executionHosts: hosts,
      runtimeRoot: hostRoot,
    });
    expect(
      (
        await database.pool.query(
          "SELECT status,operational_cleanup->>'state' AS cleanup,flow_driver_token FROM runs WHERE id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([
      { status: "Done", cleanup: "released", flow_driver_token: null },
    ]);
    expect(
      (
        await database.pool.query("SELECT * FROM run_results WHERE run_id=$1", [
          receipt.runId,
        ])
      ).rows,
    ).toEqual(before);
    expect(
      (
        await database.pool.query(
          "SELECT status,count(*)::int AS count FROM node_attempts WHERE run_id=$1 GROUP BY status",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([{ status: "Succeeded", count: 1 }]);
    expect(
      (
        await database.pool.query(
          "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt') GROUP BY kind ORDER BY kind",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([
      { kind: "session.create", count: 1 },
      { kind: "session.prompt", count: 1 },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT status FROM specialist_assignments WHERE id=$1",
          [work.id],
        )
      ).rows,
    ).toEqual([{ status: "active" }]);
  } finally {
    await worker.stop();
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    compatibility.mockRestore();
    resetResolverForTests();
    resetRegistrarStateForTests();
    setDefaultTransportForTests(null);
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
    else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousCap;
  }
}, 90000);

it("CBS-03 preserves unexpected native source as bounded host evidence before releasing its failed directory", async () => {
  const hostRoot = join(root, "reservation-host");

  await writeCompanyCapabilityCache(hostRoot);
  const supervisor = await startRealSupervisor({
    runtimeRoot: hostRoot,
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang"],
    env: {
      MAISTER_ADAPTER_SMOKE_CACHE_PATH: join(
        hostRoot,
        "adapter-smoke-cache.json",
      ),
    },
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const compatibility = vi.spyOn(engine, "isEngineCompatible");
  const worker = startProjectionWorker({
    db: database.db,
    projectors: canonicalProjectors,
  });
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  const direct = createLocalDirectTransport();
  const unexpectedName = "unexpected-source.txt";
  const unexpectedBytes = "Retained unexpected company source\n";
  const transport: typeof direct = {
    ...direct,
    async startPrompt(...input: Parameters<typeof direct.startPrompt>) {
      const [run] = await database.db
        .select()
        .from(runs)
        .where(eq(runs.id, input[1].fence.runId));

      if (!run) throw new Error("The controlled native Run is missing");
      const context = await operationalWorkspace(database.db, run);

      await writeFile(join(context.cwd, unexpectedName), unexpectedBytes);

      return direct.startPrompt(...input);
    },
  };

  setDefaultTransportForTests(transport);
  resetResolverForTests();
  resetRegistrarStateForTests();
  try {
    const output = {
      schemaVersion: 1,
      findings: [],
      knowledgeProposals: [],
      selection: [],
    };
    const work = await createSpecialistAssignment(database.db, requesterId, {
      ...preparedAssignment,
      origin: { kind: "manual", interactionId: randomUUID() },
      objectiveInput: {
        ...preparedAssignment.objectiveInput,
        input:
          "\nfixture-output:" +
          JSON.stringify({
            bytes: 0,
            text: "```json maister:output\n" + JSON.stringify(output) + "\n```",
          }) +
          "\n",
      },
    });
    const hosts = createExecutionHosts({ db: database.db, transport });
    const receipt = await reserveCompanyFlowRun(
      database.db,
      requesterId,
      {
        ...request,
        assignmentId: work.id,
        assignmentRevision: work.revision,
        inputRevision: work.inputRevision,
      },
      hosts,
    );

    expect(await tryStartRun(receipt.runId, { db: database.db })).toMatchObject(
      {
        started: true,
      },
    );
    vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
    await runFlow(receipt.runId, {
      db: database.db,
      executionHosts: hosts,
      runtimeRoot: hostRoot,
    });
    const [completed] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, receipt.runId));

    expect(completed).toMatchObject({
      status: "Failed",
      agentKind: null,
      operationalTerminal: null,
      operationalCleanup: { state: "released" },
    });
    const evidenceIds = completed!.operationalCleanup!.evidenceIds;

    expect(evidenceIds.length).toBeGreaterThan(0);
    const archived = await Promise.all(
      evidenceIds.map((id) => direct.getRuntimeObjectContent(id)),
    );
    const archive = archived
      .map((content) => new TextDecoder().decode(content.bytes))
      .join("\n");

    expect(archive).toContain(unexpectedName);
    expect(archive).toContain(Buffer.from(unexpectedBytes).toString("base64"));
    const context = await operationalWorkspace(database.db, completed!);

    await expect(
      readFile(join(context.cwd, unexpectedName)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (
        await database.pool.query(
          "SELECT state FROM execution_assignments WHERE id=$1",
          [completed!.executionAssignmentId],
        )
      ).rows,
    ).toEqual([{ state: "released" }]);
    expect(
      (
        await database.pool.query(
          "SELECT status FROM specialist_assignments WHERE id=$1",
          [work.id],
        )
      ).rows,
    ).toEqual([{ status: "active" }]);
  } finally {
    await worker.stop();
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    compatibility.mockRestore();
    resetResolverForTests();
    resetRegistrarStateForTests();
    setDefaultTransportForTests(null);
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
    else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousCap;
  }
}, 90000);

it("CBS-03 resumes native form and human waits through the same company assignment and frozen result contract", async () => {
  const hostRoot = join(root, "reservation-host");

  await writeCompanyCapabilityCache(hostRoot);
  const supervisor = await startRealSupervisor({
    runtimeRoot: hostRoot,
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang"],
    env: {
      MAISTER_ADAPTER_SMOKE_CACHE_PATH: join(
        hostRoot,
        "adapter-smoke-cache.json",
      ),
    },
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const compatibility = vi.spyOn(engine, "isEngineCompatible");
  const worker = startProjectionWorker({
    db: database.db,
    projectors: canonicalProjectors,
  });
  const previousRuntime = process.env.MAISTER_RUNTIME_ROOT;
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;

  vi.stubEnv("MAISTER_RUNTIME_ROOT", hostRoot);
  setDefaultTransportForTests(null);
  resetResolverForTests();
  resetRegistrarStateForTests();
  try {
    await createCompanyGrants(database.db, administratorId, {
      principalKind: "user",
      principalId: requesterId,
      actions: ["assignments:answer"],
      idempotencyKey: randomUUID(),
    });
    const effective = await resolveInstalledAgentDefinition(database.db, {
      agentId: "rah:dialogue-coordinator",
      packageInstallId: preparedAssignment.standingDefinition.packageInstallId,
    });
    const flow = (
      await database.pool.query<{
        id: string;
        manifest_digest: string;
        installed_path: string;
      }>(
        "SELECT id,manifest_digest,installed_path FROM flow_revisions WHERE flow_ref_id='rah-company-dialogue' AND resolved_revision=$1",
        [preparedAssignment.standingDefinition.packageRevision],
      )
    ).rows[0]!;
    const configured = await getCompanyFlowBinding(
      database.db,
      requesterId,
      request.coordinatorBindingId,
    );
    const specialist = await createCompanySpecialistBinding(
      database.db,
      requesterId,
      effective.parsed.id,
      {
        runnerId: configured.configuration.specialist.runnerId,
        owner: { kind: "company", companyId: request.companyId },
        packageInstallId: effective.packageInstallId,
        packageRevision: preparedAssignment.standingDefinition.packageRevision,
        definitionSha256: agentDefinitionSha256(effective.parsed),
        coordinatorFlowRevisionId: flow.id,
        configuration: {},
        grantActions: ["knowledge:read", "knowledge:propose"],
        enabled: true,
        idempotencyKey: randomUUID(),
      },
    );
    const coordinator = await createCompanyFlowBinding(
      database.db,
      requesterId,
      {
        owner: { kind: "company", companyId: request.companyId },
        specialistBindingId: specialist.specialist.bindingId,
        specialistRevision: specialist.specialist.configRevision,
        flowRevisionId: flow.id,
        manifestSha256: flow.manifest_digest,
        execution: { workspace: "none", completion: "result" },
        enabled: true,
        roleMappings: { maintainer: [requesterId] },
        idempotencyKey: randomUUID(),
      },
    );
    const contract = await resolveFlowExportContract({
      flowRefId: "rah-company-dialogue",
      manifest: dialogueManifest,
      revision: {
        id: flow.id,
        installedPath: flow.installed_path,
        resolvedRevision: preparedAssignment.standingDefinition.packageRevision,
      },
    });

    if (!contract)
      throw new Error("The dialogue Flow has no required result contract");
    const output = {
      schemaVersion: 1,
      findings: [],
      knowledgeProposals: [],
      selection: [],
    };
    const assignment = await createSpecialistAssignment(
      database.db,
      requesterId,
      {
        ...preparedAssignment,
        specialistBindingId: specialist.specialist.bindingId,
        responsibleAgentId: effective.parsed.id,
        standingDefinition: {
          ...preparedAssignment.standingDefinition,
          agentId: effective.parsed.id,
          definition: effective.parsed,
          definitionSha256: agentDefinitionSha256(effective.parsed),
        },
        objectiveInput: {
          ...preparedAssignment.objectiveInput,
          input:
            "\nfixture-output:" +
            JSON.stringify({
              bytes: 0,
              text:
                "```json maister:output\n" + JSON.stringify(output) + "\n```",
            }) +
            "\n",
          expectedResult: {
            schemaRef: contract.schemaRef,
            schemaVersion: contract.schemaVersion,
            sha256: contract.sha256,
            required: true,
          },
        },
        origin: { kind: "manual", interactionId: randomUUID() },
      },
    );
    const hosts = createExecutionHosts({
      db: database.db,
      transport: createLocalDirectTransport(),
    });
    const receipt = await reserveCompanyFlowRun(
      database.db,
      requesterId,
      {
        ...request,
        assignmentId: assignment.id,
        assignmentRevision: assignment.revision,
        inputRevision: assignment.inputRevision,
        bindingId: specialist.specialist.bindingId,
        bindingRevision: specialist.specialist.configRevision,
        coordinatorBindingId: coordinator.binding.id,
        coordinatorBindingRevision: coordinator.binding.revision,
      },
      hosts,
    );

    expect(await tryStartRun(receipt.runId, { db: database.db })).toMatchObject(
      { started: true },
    );
    const frozenSql =
      "SELECT execution.company_execution_snapshot AS snapshot,execution.result_contract AS contract,link.input_revision FROM runs execution JOIN specialist_run_links link ON link.run_id=execution.id WHERE execution.id=$1";
    const frozen = (
      await database.pool.query<{
        snapshot: JsonValue;
        contract: JsonValue;
        input_revision: number;
      }>(frozenSql, [receipt.runId])
    ).rows[0]!;

    vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
    await runFlow(receipt.runId, {
      db: database.db,
      executionHosts: hosts,
      runtimeRoot: hostRoot,
    });
    expect(
      (
        await database.pool.query(
          "SELECT status,current_step_id FROM runs WHERE id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([{ status: "NeedsInput", current_step_id: "intake" }]);
    const form = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM hitl_requests WHERE run_id=$1 AND kind='form' AND responded_at IS NULL",
        [receipt.runId],
      )
    ).rows[0]!;
    const answer = (
      hitlRequestId: string,
      response: Readonly<Record<string, string>>,
    ): Promise<Response> =>
      respondHitlPost(
        new NextRequest(
          `http://localhost/api/runs/${receipt.runId}/hitl/${hitlRequestId}/respond`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ response }),
          },
        ),
        { params: Promise.resolve({ runId: receipt.runId, hitlRequestId }) },
      );

    browserUserId = requesterId;
    expect((await answer(form.id, {})).status).toBe(422);
    expect(
      (await answer(form.id, { component: "component-cache" })).status,
    ).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await database.pool.query<{ id: string }>(
              "SELECT id FROM hitl_requests WHERE run_id=$1 AND kind='human' AND responded_at IS NULL",
              [receipt.runId],
            )
          ).rows[0]?.id,
        { timeout: 20000, interval: 50 },
      )
      .toBeTruthy();
    const review = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM hitl_requests WHERE run_id=$1 AND kind='human' AND responded_at IS NULL",
        [receipt.runId],
      )
    ).rows[0]!;

    await expect
      .poll(
        async () =>
          (
            await database.pool.query<{ status: string }>(
              "SELECT status FROM runs WHERE id=$1",
              [receipt.runId],
            )
          ).rows[0]?.status,
        { timeout: 10000, interval: 50 },
      )
      .toBe("NeedsInput");
    expect((await answer(review.id, { decision: "approve" })).status).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await database.pool.query<{
              status: string;
              cleanup: string | null;
              driver: string | null;
            }>(
              "SELECT status,operational_cleanup->>'state' AS cleanup,flow_driver_token AS driver FROM runs WHERE id=$1",
              [receipt.runId],
            )
          ).rows[0],
        { timeout: 20000, interval: 50 },
      )
      .toEqual({ status: "Done", cleanup: "released", driver: null });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.prompt'",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await database.pool.query(
          "SELECT status FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows,
    ).toEqual([{ status: "active" }]);
    expect(
      (
        await database.pool.query(
          "SELECT vars FROM node_attempts WHERE run_id=$1 AND node_id='intake'",
          [receipt.runId],
        )
      ).rows,
    ).toMatchObject([{ vars: { component: "component-cache" } }]);
    expect(
      (
        await database.pool.query(
          "SELECT node_type,status FROM node_attempts WHERE run_id=$1 AND node_id='diagnose'",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([{ node_type: "orchestrator", status: "Succeeded" }]);
    expect(
      (
        await database.pool.query(
          "SELECT delegation_bounds FROM runs WHERE id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toMatchObject([
      {
        delegation_bounds: {
          maxDepth: 1,
          maxFanout: 1,
          maxActiveChildren: 1,
          budget: {
            maxTokens: 10000,
            wallClockMinutes: 2,
            maxChildRuns: 1,
            consecutiveFailures: 1,
          },
        },
      },
    ]);
    expect(
      (await database.pool.query(frozenSql, [receipt.runId])).rows,
    ).toEqual([frozen]);
    expect(
      (
        await database.pool.query(
          "SELECT validity,value FROM run_results WHERE run_id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toMatchObject([{ validity: "valid", value: output }]);
    expect(
      (
        await database.pool.query(
          "SELECT human.status,human.role_refs,actor.user_id FROM assignments human JOIN actor_identities actor ON actor.id=human.completed_by_actor_id WHERE human.run_id=$1 ORDER BY human.action_kind",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([
      { status: "completed", role_refs: ["maintainer"], user_id: requesterId },
      { status: "completed", role_refs: ["maintainer"], user_id: requesterId },
    ]);
  } finally {
    if (previousRuntime === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
    else process.env.MAISTER_RUNTIME_ROOT = previousRuntime;
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
    else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousCap;
    await worker.stop();
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    compatibility.mockRestore();
    resetResolverForTests();
    resetRegistrarStateForTests();
    setDefaultTransportForTests(null);
  }
}, 120000);

it("CBS-03 retains native permission consent, refuses revoked replay and delivers the same owned input after authority is restored", async () => {
  const db: Db = database.db;
  const hostRoot = join(root, "reservation-host");

  await writeCompanyCapabilityCache(hostRoot);
  const supervisor = await startRealSupervisor({
    runtimeRoot: hostRoot,
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang", "--supports-resume"],
    env: {
      MAISTER_ADAPTER_SMOKE_CACHE_PATH: join(
        hostRoot,
        "adapter-smoke-cache.json",
      ),
    },
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const compatibility = vi.spyOn(engine, "isEngineCompatible");
  const worker = startProjectionWorker({
    db: database.db,
    projectors: canonicalProjectors,
  });
  const abort = new AbortController();
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  let driver: Promise<Readonly<{ error: unknown | null }>> | undefined;
  const direct = createLocalDirectTransport();
  let deliveryAvailable = false;
  let deliveredInputs = 0;
  const transport: typeof direct = {
    ...direct,
    async deliverInput(...input: Parameters<typeof direct.deliverInput>) {
      if (!deliveryAvailable)
        throw new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "Controlled company permission transport is unavailable",
          { details: { httpStatus: 503 } },
        );

      deliveredInputs += 1;

      return direct.deliverInput(...input);
    },
  };

  setDefaultTransportForTests(transport);
  resetResolverForTests();
  resetRegistrarStateForTests();
  try {
    const output = {
      schemaVersion: 1,
      findings: [],
      knowledgeProposals: [],
      selection: [],
    };
    const work = await createSpecialistAssignment(database.db, requesterId, {
      ...preparedAssignment,
      objectiveInput: {
        ...preparedAssignment.objectiveInput,
        input:
          "\nfixture-output:" +
          JSON.stringify({
            bytes: 0,
            permission: true,
            permissionToolCall: {
              toolCallId: "company-flow-proposal-proof",
              title: "mcp__maister__knowledge_propose",
              kind: "other",
              status: "pending",
            },
            text: "```json maister:output\n" + JSON.stringify(output) + "\n```",
          }) +
          "\n",
      },
      origin: { kind: "manual", interactionId: randomUUID() },
    });
    const hosts = createExecutionHosts({
      db: database.db,
      transport,
    });
    const receipt = await reserveCompanyFlowRun(
      database.db,
      requesterId,
      {
        ...request,
        assignmentId: work.id,
        assignmentRevision: work.revision,
        inputRevision: work.inputRevision,
      },
      hosts,
    );

    expect(await tryStartRun(receipt.runId, { db: database.db })).toMatchObject(
      { started: true },
    );
    vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
    driver = runFlow(receipt.runId, {
      db: database.db,
      executionHosts: hosts,
      runtimeRoot: hostRoot,
      signal: abort.signal,
    }).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await expect
      .poll(
        async () =>
          (
            await database.pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM hitl_requests WHERE run_id=$1 AND kind='permission' AND responded_at IS NULL",
              [receipt.runId],
            )
          ).rows[0]?.count,
        { timeout: 15000, interval: 50 },
      )
      .toBe(1);
    const hitl = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM hitl_requests WHERE run_id=$1 AND kind='permission' AND responded_at IS NULL",
        [receipt.runId],
      )
    ).rows[0]!;
    const responderId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [responderId, `${responderId}@example.test`],
    );
    const grants = await createCompanyGrants(database.db, administratorId, {
      principalKind: "user",
      principalId: responderId,
      actions: ["assignments:read", "assignments:answer"],
      idempotencyKey: randomUUID(),
    });

    browserUserId = responderId;
    const response = await respondHitlPost(
      new NextRequest(
        `http://localhost/api/runs/${receipt.runId}/hitl/${hitl.id}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ optionId: "allow" }),
        },
      ),
      {
        params: Promise.resolve({
          runId: receipt.runId,
          hitlRequestId: hitl.id,
        }),
      },
    );

    expect(response.status).toBe(503);
    const retained = (
      await database.pool.query<{ response: JsonValue }>(
        "SELECT response FROM hitl_requests WHERE id=$1",
        [hitl.id],
      )
    ).rows[0]!.response;

    expect(retained).toMatchObject({
      optionId: "allow",
      _audit: {
        companyConsent: {
          version: 1,
          userId: responderId,
          actorId: expect.any(String),
        },
      },
      _delivery: { commandId: expect.any(String) },
    });
    const client = await hosts.forRun(receipt.runId);

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE hitl_requests SET response=response - '_audit' WHERE id=${hitl.id}`,
        );
        await prepareFlowPermissionResponse(tx, client, hitl.id);
      }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "company_permission_consent_missing" },
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE hitl_requests SET response=jsonb_set(response,'{_audit,companyConsent,userId}',to_jsonb(${requesterId}::text)) WHERE id=${hitl.id}`,
        );
        await prepareFlowPermissionResponse(tx, client, hitl.id);
      }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "company_permission_consent_actor" },
    });
    const answerGrant = grants.page.items.find(
      (grant) => grant.action === "assignments:answer",
    )!;

    await revokeCompanyGrant(database.db, administratorId, answerGrant.id, {
      expectedRevision: answerGrant.revision,
      reason: "Withdraw company consent before retry delivery",
      idempotencyKey: randomUUID(),
    });
    await expect(
      db.transaction((tx) =>
        prepareFlowPermissionResponse(tx, client, hitl.id),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      (
        await database.pool.query<{ response: JsonValue }>(
          "SELECT response FROM hitl_requests WHERE id=$1",
          [hitl.id],
        )
      ).rows[0]!.response,
    ).toEqual(retained);
    await createCompanyGrants(database.db, administratorId, {
      principalKind: "user",
      principalId: responderId,
      actions: ["assignments:answer"],
      idempotencyKey: randomUUID(),
    });
    deliveryAvailable = true;
    const retried = await respondHitlPost(
      new NextRequest(
        `http://localhost/api/runs/${receipt.runId}/hitl/${hitl.id}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ optionId: "allow" }),
        },
      ),
      {
        params: Promise.resolve({
          runId: receipt.runId,
          hitlRequestId: hitl.id,
        }),
      },
    );

    expect(retried.status).toBe(200);
    expect(await driver).toEqual({ error: null });
    expect(deliveredInputs).toBe(1);
    expect(
      (
        await database.pool.query(
          "SELECT status,operational_cleanup->>'state' AS cleanup,flow_driver_token FROM runs WHERE id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([
      { status: "Done", cleanup: "released", flow_driver_token: null },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.input'",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
    expect(
      (
        await database.pool.query(
          "SELECT human.status,actor.user_id,human.company_id,human.project_id FROM assignments human JOIN actor_identities actor ON actor.id=human.completed_by_actor_id WHERE human.hitl_request_id=$1",
          [hitl.id],
        )
      ).rows,
    ).toEqual([
      {
        status: "completed",
        user_id: responderId,
        company_id: request.companyId,
        project_id: null,
      },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT validity,value FROM run_results WHERE run_id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toMatchObject([{ validity: "valid", value: output }]);
    expect(
      (
        await database.pool.query(
          "SELECT status FROM specialist_assignments WHERE id=$1",
          [work.id],
        )
      ).rows,
    ).toEqual([{ status: "active" }]);
  } finally {
    browserUserId = requesterId;
    abort.abort();
    await driver;
    await worker.stop();
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    compatibility.mockRestore();
    resetResolverForTests();
    resetRegistrarStateForTests();
    setDefaultTransportForTests(null);
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
    else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousCap;
  }
}, 90000);

it("CBS-03 resumes a checkpointed native permission after retained-host restart without losing input, consent or capacity fences", async () => {
  const db: Db = database.db;
  const hostRoot = join(root, "reservation-host");

  await writeCompanyCapabilityCache(hostRoot);
  let supervisor = await startRealSupervisor({
    runtimeRoot: hostRoot,
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: [
      "--hang",
      "--supports-resume",
      "--session-state-dir",
      join(root, "native-acp-state"),
    ],
    env: {
      MAISTER_ADAPTER_SMOKE_CACHE_PATH: join(
        hostRoot,
        "adapter-smoke-cache.json",
      ),
    },
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const compatibility = vi.spyOn(engine, "isEngineCompatible");
  const worker = startProjectionWorker({ db, projectors: canonicalProjectors });
  const abort = new AbortController();
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  const previousRuntime = process.env.MAISTER_RUNTIME_ROOT;
  let driver: Promise<Readonly<{ error: unknown | null }>> | undefined;
  let continuation: ReturnType<typeof startFlowContinuationWorker> | undefined;

  vi.stubEnv("MAISTER_RUNTIME_ROOT", hostRoot);
  setDefaultTransportForTests(null);
  resetResolverForTests();
  resetRegistrarStateForTests();
  try {
    const output = {
      schemaVersion: 1,
      findings: [],
      knowledgeProposals: [],
      selection: [],
    };
    const work = await createSpecialistAssignment(db, requesterId, {
      ...preparedAssignment,
      origin: { kind: "manual", interactionId: randomUUID() },
      objectiveInput: {
        ...preparedAssignment.objectiveInput,
        input:
          "\nfixture-output:" +
          JSON.stringify({
            bytes: 0,
            permission: true,
            permissionToolCall: {
              toolCallId: "native-checkpoint-proof",
              title: "mcp__maister__knowledge_propose",
              kind: "other",
              status: "pending",
            },
            text: "```json maister:output\n" + JSON.stringify(output) + "\n```",
          }) +
          "\n",
      },
    });
    const hosts = createExecutionHosts({
      db,
      transport: createLocalDirectTransport(),
    });
    const receipt = await reserveCompanyFlowRun(
      db,
      requesterId,
      {
        ...request,
        assignmentId: work.id,
        assignmentRevision: work.revision,
        inputRevision: work.inputRevision,
      },
      hosts,
    );

    expect(await tryStartRun(receipt.runId, { db })).toMatchObject({
      started: true,
    });
    vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
    driver = runFlow(receipt.runId, {
      db,
      executionHosts: hosts,
      runtimeRoot: hostRoot,
      signal: abort.signal,
    }).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    await expect
      .poll(
        async () =>
          (
            await database.pool.query<{ status: string }>(
              "SELECT status FROM runs WHERE id=$1",
              [receipt.runId],
            )
          ).rows[0]?.status,
        { timeout: 15000, interval: 50 },
      )
      .toBe("NeedsInput");
    const hitl = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM hitl_requests WHERE run_id=$1 AND kind='permission' AND responded_at IS NULL",
        [receipt.runId],
      )
    ).rows[0]!;
    const frozen = await db
      .select({
        snapshot: runs.companyExecutionSnapshot,
        contract: runs.resultContract,
        acp: runSessions.acpSessionId,
      })
      .from(runs)
      .innerJoin(runSessions, eq(runSessions.runId, runs.id))
      .where(eq(runs.id, receipt.runId));

    expect(frozen[0]?.acp).toEqual(expect.any(String));
    await database.pool.query(
      "UPDATE runs SET keepalive_until=now()-interval '1 second' WHERE id=$1",
      [receipt.runId],
    );
    expect(await runSweepTick({ db, executionHosts: hosts })).toMatchObject({
      idledCount: 1,
    });
    abort.abort();
    await driver;
    const beforeHealth = await hosts.local().health();

    await stopRuntimeEventConsumers();
    supervisor = await supervisor.restart();
    resetRegistrarStateForTests();
    resetResolverForTests();
    const afterHealth = await hosts.local().health();

    if (beforeHealth.kind !== "ready" || afterHealth.kind !== "ready")
      throw new Error("The retained company host is not ready");
    expect(afterHealth.identity?.hostKey).toBe(beforeHealth.identity?.hostKey);
    expect(afterHealth.identity?.bootId).not.toBe(
      beforeHealth.identity?.bootId,
    );
    expect(
      await db
        .select({
          snapshot: runs.companyExecutionSnapshot,
          contract: runs.resultContract,
          acp: runSessions.acpSessionId,
        })
        .from(runs)
        .innerJoin(runSessions, eq(runSessions.runId, runs.id))
        .where(eq(runs.id, receipt.runId)),
    ).toEqual(frozen);
    const responderId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [responderId, `${responderId}@example.test`],
    );
    const grants = await createCompanyGrants(db, administratorId, {
      principalKind: "user",
      principalId: responderId,
      actions: ["assignments:read", "assignments:answer"],
      idempotencyKey: randomUUID(),
    });

    browserUserId = responderId;
    const answer = (): Promise<Response> =>
      respondHitlPost(
        new NextRequest(
          `http://localhost/api/runs/${receipt.runId}/hitl/${hitl.id}/respond`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ optionId: "allow" }),
          },
        ),
        {
          params: Promise.resolve({
            runId: receipt.runId,
            hitlRequestId: hitl.id,
          }),
        },
      );
    const queued = await answer();

    expect(queued.status).toBe(202);
    expect(
      (
        await database.pool.query("SELECT status FROM runs WHERE id=$1", [
          receipt.runId,
        ])
      ).rows,
    ).toEqual([{ status: "NeedsInputIdle" }]);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.create'",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    const answerGrant = grants.page.items.find(
      (grant) => grant.action === "assignments:answer",
    )!;

    await revokeCompanyGrant(db, administratorId, answerGrant.id, {
      expectedRevision: answerGrant.revision,
      reason: "Withdraw authority while native resume waits for capacity",
      idempotencyKey: randomUUID(),
    });
    vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "2");
    await expect(
      resumeRun(receipt.runId, { db, executionHosts: hosts }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      (
        await database.pool.query("SELECT status FROM runs WHERE id=$1", [
          receipt.runId,
        ])
      ).rows,
    ).toEqual([{ status: "NeedsInputIdle" }]);
    await createCompanyGrants(db, administratorId, {
      principalKind: "user",
      principalId: responderId,
      actions: ["assignments:answer"],
      idempotencyKey: randomUUID(),
    });
    continuation = startFlowContinuationWorker({
      db,
      executionHosts: hosts,
      runtimeRoot: hostRoot,
    });
    expect((await answer()).status).toBe(202);
    await expect
      .poll(
        async () =>
          (
            await database.pool.query<{
              status: string;
              cleanup: string | null;
              driver: string | null;
            }>(
              "SELECT status,operational_cleanup->>'state' AS cleanup,flow_driver_token AS driver FROM runs WHERE id=$1",
              [receipt.runId],
            )
          ).rows[0],
        { timeout: 20000, interval: 50 },
      )
      .toEqual({ status: "Done", cleanup: "released", driver: null });
    expect(
      await db
        .select({
          snapshot: runs.companyExecutionSnapshot,
          contract: runs.resultContract,
          acp: runSessions.acpSessionId,
        })
        .from(runs)
        .innerJoin(runSessions, eq(runSessions.runId, runs.id))
        .where(eq(runs.id, receipt.runId)),
    ).toEqual(frozen);
    expect(
      (
        await database.pool.query(
          "SELECT validity,value FROM run_results WHERE run_id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toMatchObject([{ validity: "valid", value: output }]);
    expect(
      (
        await database.pool.query(
          "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt','session.input') GROUP BY kind ORDER BY kind",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([
      { kind: "session.create", count: 2 },
      { kind: "session.input", count: 1 },
      { kind: "session.prompt", count: 2 },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT human.status,actor.user_id FROM assignments human JOIN actor_identities actor ON actor.id=human.completed_by_actor_id WHERE human.hitl_request_id=$1",
          [hitl.id],
        )
      ).rows,
    ).toEqual([{ status: "completed", user_id: responderId }]);
  } finally {
    browserUserId = requesterId;
    abort.abort();
    await driver;
    await continuation?.stop();
    await worker.stop();
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    compatibility.mockRestore();
    resetResolverForTests();
    resetRegistrarStateForTests();
    setDefaultTransportForTests(null);
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
    else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousCap;
    if (previousRuntime === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
    else process.env.MAISTER_RUNTIME_ROOT = previousRuntime;
  }
}, 90000);

it("respects an explicitly tool-less professional declaration even when reviewed action limits include knowledge", async () => {
  const effective = await database.db.transaction((tx) =>
    resolveInstalledAgentDefinition(tx, {
      agentId: "rah:no-tool-observer",
      packageInstallId: preparedAssignment.standingDefinition.packageInstallId,
    }),
  );

  if (!effective.resolvedRevision)
    throw new Error("The tool-less role has no exact installed revision");
  await createCompanySpecialistBinding(
    database.db,
    requesterId,
    effective.parsed.id,
    {
      owner: { kind: "company", companyId: request.companyId },
      packageInstallId: effective.packageInstallId,
      packageRevision: effective.resolvedRevision,
      definitionSha256: agentDefinitionSha256(effective.parsed),
      configuration: {},
      grantActions: ["knowledge:read", "knowledge:propose"],
      enabled: true,
      idempotencyKey: randomUUID(),
    },
  );
  await database.pool.query(
    "UPDATE runs SET status='Running',current_step_id='diagnose' WHERE id=$1",
    [nativeFlowRunId],
  );
  const node = await appendNodeAttempt({
    runId: nativeFlowRunId,
    nodeId: "diagnose",
    nodeType: "ai_coding",
    db: database.db,
  });

  await markNodeRunning(node.id, database.db);
  const compatibility = vi.spyOn(engine, "isEngineCompatible");

  try {
    await resolveFlowBoundAgent({
      agentId: effective.parsed.id,
      runId: nativeFlowRunId,
      nodeAttemptId: node.id,
      executorAgent: "claude",
      worktreePath: join(root, "unused-company-persona"),
      db: database.db,
    });
    await expect(
      database.db.transaction((tx) =>
        resolveCompanyFlowNodeEnforcement(tx, nativeFlowRunId, node.id),
      ),
    ).resolves.toMatchObject({
      tools: { allow: [] },
      mcps: { allowServers: [] },
      enforcedClasses: ["tools", "mcps"],
      allowedToolApproval: "execution_policy",
    });
  } finally {
    compatibility.mockRestore();
  }
});

it("resolves the actual company Flow driving persona from its reviewed provider and attests its current node before returning prompt bytes", async () => {
  await database.pool.query(
    "UPDATE runs SET status='Running',current_step_id='diagnose' WHERE id=$1",
    [nativeFlowRunId],
  );
  const node = await appendNodeAttempt({
    runId: nativeFlowRunId,
    nodeId: "diagnose",
    nodeType: "ai_coding",
    db: database.db,
  });

  await markNodeRunning(node.id, database.db);
  const compatibility = vi.spyOn(engine, "isEngineCompatible");

  try {
    await expect(
      resolveFlowBoundAgent({
        agentId: preparedAssignment.responsibleAgentId,
        runId: nativeFlowRunId,
        executorAgent: "claude",
        worktreePath: join(root, "unused-company-persona"),
        db: database.db,
        requireFlowTrigger: false,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    await expect(
      database.db.transaction((tx) =>
        resolveCompanyFlowNodeEnforcement(tx, nativeFlowRunId, node.id),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const bound = await resolveFlowBoundAgent({
      agentId: preparedAssignment.responsibleAgentId,
      runId: nativeFlowRunId,
      nodeAttemptId: node.id,
      executorAgent: "claude",
      worktreePath: join(root, "unused-company-persona"),
      db: database.db,
      requireFlowTrigger: false,
    });

    const profile = await database.db.transaction((tx) =>
      resolveCompanyFlowNodeEnforcement(tx, nativeFlowRunId, node.id),
    );

    expect(profile).toMatchObject({
      tools: {
        allow: expect.arrayContaining([
          "mcp__maister__knowledge_search",
          "mcp__maister__knowledge_propose",
        ]),
      },
      mcps: { allowServers: ["maister"] },
      enforcedClasses: ["tools", "mcps"],
      allowedToolApproval: "execution_policy",
    });
    expect(profile.tools?.allow).not.toContain("Read");
    expect(profile.tools?.allow).not.toContain(
      "mcp__maister__knowledge_confirm",
    );
    const { materializeCompanyFlowNodeCapabilities } =
      await import("../company-flow-materialization");
    const worktreePath = companyAgentWorkdirPath(
      request.companyId,
      nativeFlowRunId,
    );
    const materialization = {
      db: database.db,
      runId: nativeFlowRunId,
      nodeAttemptId: node.id,
      sessionName: "default",
      worktreePath,
    };
    const unavailable = async (): Promise<SupervisorDiagnosticsStatus> => ({
      kind: "unavailable",
      reason: "http",
      message: "qualification host unavailable",
    });

    await expect(
      materializeCompanyFlowNodeCapabilities({
        ...materialization,
        checkDiagnostics: unavailable,
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
    const diagnostics = async (): Promise<SupervisorDiagnosticsStatus> => ({
      kind: "ready",
      diagnostics: {
        status: "ready",
        version: "qualification",
        checkedAt: new Date().toISOString(),
        envRefs: [],
        adapters: [
          {
            id: "claude",
            binary: "controlled-acp",
            source: "override",
            path: null,
            available: true,
            version: null,
            error: null,
            smoke: {
              status: "ok",
              reason: null,
              checkedAt: null,
              protocolVersion: 1,
              readOnlySession: {
                status: "ok",
                reason: null,
                checkedAt: null,
                protocolVersion: 1,
                probeVersion: 1,
                staleReason: null,
              },
              capabilityEnforcement: {
                status: "ok",
                reason: null,
                checkedAt: null,
                protocolVersion: 1,
              },
            },
          },
        ],
      },
    });
    const materialized = await materializeCompanyFlowNodeCapabilities({
      ...materialization,
      checkDiagnostics: diagnostics,
    });
    const onDisk: unknown = JSON.parse(
      await readFile(materialized.capabilityProfilePath, "utf8"),
    );

    expect(onDisk).toMatchObject({
      projectId: null,
      owner: { kind: "company", companyId: request.companyId },
      selectedMcpIds: [],
      selectedSkillIds: [],
      supported: [],
    });
    expect(materialized.enforcementProfile).toEqual(profile);
    expect(materialized.plan.enforcementProfile).toEqual(profile);
    await setMaterializationPlan(node.id, materialized.plan, database.db);
    const retainedPlan = await database.pool.query<{
      materialization_plan: unknown;
    }>("SELECT materialization_plan FROM node_attempts WHERE id=$1", [node.id]);

    expect(retainedPlan.rows[0].materialization_plan).toEqual(
      materialized.plan,
    );
    expect(materialized.plan.resolvedRevisions).toEqual([]);
    expect(materialized.mcpServers).toEqual([]);
    expect(materialized.plan.materializedFiles).toContain(
      join(await realpath(worktreePath), ".claude/settings.local.json"),
    );
    const settings: unknown = JSON.parse(
      await readFile(join(worktreePath, ".claude/settings.local.json"), "utf8"),
    );

    expect(settings).toMatchObject({ permissions: { defaultMode: "default" } });
    expect(JSON.stringify(settings)).not.toContain("bypassPermissions");
    await expect(
      materializeCompanyFlowNodeCapabilities({
        ...materialization,
        worktreePath: join(root, "unowned-company-directory"),
        checkDiagnostics: diagnostics,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    await expect(
      materializeCompanyFlowNodeCapabilities({
        ...materialization,
        sessionName: "unfrozen-session",
        checkDiagnostics: diagnostics,
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(bound).toEqual({
      mode: "session",
      prompt: `${preparedAssignment.standingDefinition.definition.prompt.trim()}\n\n## Specialist configuration\n{}`,
    });
    await expect(
      database.db.transaction((tx) =>
        resolveKnowledgeRunIdentity(tx, nativeFlowRunId, node.id),
      ),
    ).resolves.toMatchObject({
      identity: {
        actor: {
          id: preparedAssignment.responsibleAgentId,
          attemptId: node.id,
        },
      },
    });
  } finally {
    compatibility.mockRestore();
  }
});

it("uses exact company graph node attribution, current role authority and source-guarded history without issuing standalone credentials", async () => {
  await expect(
    assertCompanyRunReadAccess(database.db, requesterId, nativeFlowRunId),
  ).resolves.toBeUndefined();
  await expect(
    assertCompanyRunReadAccess(database.db, outsiderId, nativeFlowRunId),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await database.pool.query(
    "UPDATE runs SET status='Running',current_step_id='diagnose' WHERE id=$1",
    [nativeFlowRunId],
  );
  const node = await appendNodeAttempt({
    runId: nativeFlowRunId,
    nodeId: "diagnose",
    nodeType: "ai_coding",
    db: database.db,
  });

  await markNodeRunning(node.id, database.db);
  const row = (
    await database.pool.query(
      "SELECT agent_activity_snapshot FROM runs WHERE id=$1",
      [nativeFlowRunId],
    )
  ).rows[0]!;
  const activity = row.agent_activity_snapshot;
  const actor: NativeKnowledgeActor = nativeKnowledgeActorSchema.parse({
    schemaVersion: 1,
    agentId: activity.agentId,
    packageInstallId: activity.packageInstallId,
    packageName: activity.packageName,
    definitionSha256: activity.definitionSha256,
  });

  await expect(
    database.db.transaction((tx) =>
      resolveKnowledgeRunIdentity(tx, nativeFlowRunId, null),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    database.db.transaction((tx) =>
      resolveKnowledgeRunIdentity(tx, nativeFlowRunId, node.id),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    recordNativeKnowledgeActor(database.db, {
      runId: nativeFlowRunId,
      nodeAttemptId: node.id,
      actor: { ...actor, definitionSha256: "e".repeat(64) },
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await recordNativeKnowledgeActor(database.db, {
    runId: nativeFlowRunId,
    nodeAttemptId: node.id,
    actor,
  });
  await expect(
    database.db.transaction((tx) =>
      resolveKnowledgeRunIdentity(tx, nativeFlowRunId, node.id),
    ),
  ).resolves.toMatchObject({
    runKind: "flow",
    identity: {
      kind: "company_agent",
      companyId: request.companyId,
      bindingId: request.bindingId,
      actor: {
        kind: "agent",
        id: actor.agentId,
        runId: nativeFlowRunId,
        attemptId: node.id,
      },
      execution: { schemaVersion: 2, executionKind: "flow" },
      actionLimits: ["knowledge:read", "knowledge:propose"],
    },
  });
  await expect(
    database.db.transaction((tx) =>
      authorizeKnowledge(
        tx,
        { kind: "execution", runId: nativeFlowRunId, nodeAttemptId: node.id },
        { kind: "company", companyId: request.companyId },
        "knowledge:read",
      ),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    recordNativeKnowledgeActor(database.db, {
      runId: nativeFlowRunId,
      nodeAttemptId: node.id,
      actor: { ...actor, definitionSha256: "f".repeat(64) },
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    issueCompanyAgentRunToken({ db: database.db, runId: nativeFlowRunId }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM project_tokens WHERE company_run_id=$1",
        [nativeFlowRunId],
      )
    ).rows[0],
  ).toEqual({ count: 0 });
  await database.pool.query("UPDATE agents SET enabled=false WHERE id=$1", [
    actor.agentId,
  ]);
  try {
    await expect(
      database.db.transaction((tx) =>
        resolveKnowledgeRunIdentity(tx, nativeFlowRunId, node.id),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      assertCompanyRunReadAccess(database.db, requesterId, nativeFlowRunId),
    ).resolves.toBeUndefined();
  } finally {
    await database.pool.query("UPDATE agents SET enabled=true WHERE id=$1", [
      actor.agentId,
    ]);
  }
  const newer = await appendNodeAttempt({
    runId: nativeFlowRunId,
    nodeId: "diagnose",
    nodeType: "ai_coding",
    db: database.db,
  });

  nativeNodeAttemptId = newer.id;
  await markNodeRunning(newer.id, database.db);
  await expect(
    database.db.transaction((tx) =>
      resolveKnowledgeRunIdentity(tx, nativeFlowRunId, node.id),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await recordNativeKnowledgeActor(database.db, {
    runId: nativeFlowRunId,
    nodeAttemptId: newer.id,
    actor,
  });
  await expect(
    database.db.transaction((tx) =>
      resolveKnowledgeRunIdentity(tx, nativeFlowRunId, newer.id),
    ),
  ).resolves.toMatchObject({ identity: { actor: { attemptId: newer.id } } });
});

it("mints and rotates exact company node credentials, verifies the current node and refuses retargeting or stale attempts", async () => {
  const first = await issueCompanyFlowNodeRunToken({
    db: database.db,
    runId: nativeFlowRunId,
    nodeAttemptId: nativeNodeAttemptId,
  });

  await expect(verifyToken(first.secret, database.db)).resolves.toMatchObject({
    companyId: request.companyId,
    projectId: null,
    boundRunId: nativeFlowRunId,
    agentId: "rah:evidence-researcher",
    tokenKind: "agent",
    scopes: ["knowledge:read", "knowledge:propose"],
  });
  await expect(
    database.db.transaction((tx) =>
      resolveKnowledgePrincipal(
        tx,
        { kind: "token", tokenId: first.tokenId },
        "knowledge:read",
      ),
    ),
  ).resolves.toMatchObject({
    kind: "company_agent",
    actor: { id: "rah:evidence-researcher", attemptId: nativeNodeAttemptId },
  });
  const rotated = await issueCompanyFlowNodeRunToken({
    db: database.db,
    runId: nativeFlowRunId,
    nodeAttemptId: nativeNodeAttemptId,
  });

  await expect(verifyToken(first.secret, database.db)).rejects.toMatchObject({
    kind: "revoked",
  });
  await expect(verifyToken(rotated.secret, database.db)).resolves.toMatchObject(
    { tokenId: rotated.tokenId },
  );
  await expect(
    database.pool.query(
      "UPDATE project_tokens SET knowledge_node_attempt_id=NULL WHERE id=$1",
      [rotated.tokenId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "project_tokens_knowledge_node_attempt_immutable",
  });
  const older = (
    await database.pool.query<{ id: string }>(
      "SELECT id FROM node_attempts WHERE run_id=$1 AND node_id='diagnose' ORDER BY attempt LIMIT 1",
      [nativeFlowRunId],
    )
  ).rows[0]!;
  const invalidBindings: readonly Readonly<Record<string, JsonValue>>[] = [
    { knowledge_node_attempt_id: null },
    { knowledge_node_attempt_id: older.id },
    { agent_id: "rah:migration-observer" },
    { owner_user_id: outsiderId },
    { company_id: randomUUID() },
    { scopes: ["knowledge:confirm"] },
  ];

  for (const patch of invalidBindings) {
    await expect(
      database.db.execute(
        sql`INSERT INTO project_tokens SELECT (jsonb_populate_record(NULL::project_tokens,to_jsonb(source)||${JSON.stringify({ ...patch, id: randomUUID() })}::jsonb)).* FROM project_tokens source WHERE source.id=${rotated.tokenId}`,
      ),
    ).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "project_tokens_company_reference_check",
      },
    });
  }
  const next = await appendNodeAttempt({
    runId: nativeFlowRunId,
    nodeId: "diagnose",
    nodeType: "ai_coding",
    db: database.db,
  });

  await markNodeRunning(next.id, database.db);
  await expect(verifyToken(rotated.secret, database.db)).rejects.toMatchObject({
    kind: "owner-unavailable",
  });
  await expect(
    issueCompanyFlowNodeRunToken({
      db: database.db,
      runId: nativeFlowRunId,
      nodeAttemptId: nativeNodeAttemptId,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    issueCompanyFlowNodeRunToken({
      db: database.db,
      runId: nativeFlowRunId,
      nodeAttemptId: next.id,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

it("requires a separate reviewed company persona and fences changed coordinator configuration while retaining readable history", async () => {
  const effective = await database.db.transaction(async (tx) => {
    const row = (
      await tx.execute(
        sql`SELECT agent_activity_snapshot->>'packageInstallId' AS package_install_id FROM runs WHERE id=${nativeFlowRunId}`,
      )
    ).rows[0];

    if (typeof row?.package_install_id !== "string")
      throw new Error(
        "The native graph fixture has no installed package witness",
      );

    return resolveInstalledAgentDefinition(tx, {
      agentId: "rah:contradiction-researcher",
      packageInstallId: row.package_install_id,
    });
  });
  const actor: NativeKnowledgeActor = {
    schemaVersion: 1,
    agentId: effective.parsed.id,
    packageInstallId: effective.packageInstallId,
    packageName: effective.packageName,
    definitionSha256: agentDefinitionSha256(effective.parsed),
  };
  const node = await appendNodeAttempt({
    runId: nativeFlowRunId,
    nodeId: "diagnose",
    nodeType: "ai_coding",
    db: database.db,
  });

  await markNodeRunning(node.id, database.db);
  await expect(
    recordNativeKnowledgeActor(database.db, {
      runId: nativeFlowRunId,
      nodeAttemptId: node.id,
      actor,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  if (!effective.resolvedRevision)
    throw new Error(
      "The company persona fixture has no resolved package revision",
    );
  const persona = await createCompanySpecialistBinding(
    database.db,
    requesterId,
    actor.agentId,
    {
      owner: { kind: "company", companyId: request.companyId },
      packageInstallId: actor.packageInstallId,
      packageRevision: effective.resolvedRevision,
      definitionSha256: actor.definitionSha256,
      configuration: {},
      grantActions: ["knowledge:read"],
      enabled: true,
      idempotencyKey: randomUUID(),
    },
  );

  const personaCompatibility = vi.spyOn(engine, "isEngineCompatible");

  try {
    await expect(
      resolveFlowBoundAgent({
        agentId: actor.agentId,
        runId: nativeFlowRunId,
        nodeAttemptId: node.id,
        executorAgent: "claude",
        worktreePath: join(root, "unused-company-persona"),
        db: database.db,
        requireFlowTrigger: false,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const bound = await resolveFlowBoundAgent({
      agentId: actor.agentId,
      runId: nativeFlowRunId,
      nodeAttemptId: node.id,
      executorAgent: "claude",
      worktreePath: join(root, "unused-company-persona"),
      db: database.db,
    });

    const profile = await database.db.transaction((tx) =>
      resolveCompanyFlowNodeEnforcement(tx, nativeFlowRunId, node.id),
    );

    expect(profile.tools?.allow).toContain("mcp__maister__knowledge_search");
    expect(profile.tools?.allow).not.toContain(
      "mcp__maister__knowledge_propose",
    );
    expect(bound).toEqual({
      mode: "session",
      prompt: `${effective.parsed.prompt.trim()}\n\n## Specialist configuration\n{}`,
    });
  } finally {
    personaCompatibility.mockRestore();
  }
  await expect(
    database.db.transaction((tx) =>
      resolveKnowledgeRunIdentity(tx, nativeFlowRunId, node.id),
    ),
  ).resolves.toMatchObject({
    identity: {
      actor: { id: actor.agentId, attemptId: node.id },
      bindingId: persona.specialist.bindingId,
      actionLimits: ["knowledge:read"],
    },
  });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: requesterId,
    actions: ["knowledge:read", "knowledge:propose"],
    idempotencyKey: randomUUID(),
  });
  const professionalGrant = await createCompanyGrants(
    database.db,
    administratorId,
    {
      principalKind: "agent",
      principalId: actor.agentId,
      actions: ["knowledge:read", "knowledge:propose"],
      idempotencyKey: randomUUID(),
    },
  );
  const principal = {
    kind: "execution" as const,
    runId: nativeFlowRunId,
    nodeAttemptId: node.id,
  };
  const owner = { kind: "company" as const, companyId: request.companyId };

  await expect(
    database.db.transaction((tx) =>
      authorizeKnowledge(tx, principal, owner, "knowledge:read"),
    ),
  ).resolves.toMatchObject({
    actor: {
      kind: "agent",
      id: actor.agentId,
      runId: nativeFlowRunId,
      attemptId: node.id,
    },
    policy: {
      version: 2,
      initiator: { actor: { id: requesterId } },
      execution: {
        runId: nativeFlowRunId,
        launchSnapshot: { schemaVersion: 2, executionKind: "flow" },
      },
    },
  });
  await expect(
    database.db.transaction((tx) =>
      authorizeKnowledge(tx, principal, owner, "knowledge:propose"),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const personaToken = await issueCompanyFlowNodeRunToken({
    db: database.db,
    runId: nativeFlowRunId,
    nodeAttemptId: node.id,
  });

  await expect(
    verifyToken(personaToken.secret, database.db),
  ).resolves.toMatchObject({
    agentId: actor.agentId,
    scopes: ["knowledge:read"],
  });
  await expect(
    database.db.transaction((tx) =>
      resolveKnowledgePrincipal(
        tx,
        { kind: "token", tokenId: personaToken.tokenId },
        "knowledge:read",
      ),
    ),
  ).resolves.toMatchObject({
    kind: "company_agent",
    bindingId: persona.specialist.bindingId,
    actor: { id: actor.agentId, attemptId: node.id },
  });
  const readGrant = professionalGrant.page.items.find(
    (item) => item.action === "knowledge:read",
  );

  if (!readGrant)
    throw new Error("The diagnostic role fixture has no current read grant");
  await revokeCompanyGrant(database.db, administratorId, readGrant.id, {
    expectedRevision: readGrant.revision,
    reason: "Verify current node knowledge authority",
    idempotencyKey: randomUUID(),
  });
  await expect(
    database.db.transaction((tx) =>
      authorizeKnowledge(tx, principal, owner, "knowledge:read"),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    database.db.transaction((tx) =>
      authorizeKnowledge(
        tx,
        { kind: "token", tokenId: personaToken.tokenId },
        owner,
        "knowledge:read",
      ),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const prior = await getCompanyFlowBinding(
    database.db,
    requesterId,
    request.coordinatorBindingId,
  );
  const replace = {
    owner: prior.owner,
    specialistBindingId: request.bindingId,
    specialistRevision: request.bindingRevision,
    flowRevisionId: prior.configuration.flowRevisionId,
    manifestSha256: prior.configuration.manifestSha256,
    execution: prior.configuration.execution,
    roleMappings: prior.configuration.roleMappings,
  };
  const disabled = await updateCompanyFlowBinding(
    database.db,
    requesterId,
    prior.id,
    {
      ...replace,
      enabled: false,
      expectedRevision: prior.revision,
      idempotencyKey: randomUUID(),
    },
  );

  await expect(
    database.db.transaction((tx) =>
      resolveKnowledgeRunIdentity(tx, nativeFlowRunId, node.id),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    database.db.transaction((tx) =>
      resolveCompanyFlowNodeEnforcement(tx, nativeFlowRunId, node.id),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    assertCompanyRunReadAccess(database.db, requesterId, nativeFlowRunId),
  ).resolves.toBeUndefined();
  const compatibility = vi.spyOn(engine, "isEngineCompatible");

  try {
    const enabled = await updateCompanyFlowBinding(
      database.db,
      requesterId,
      prior.id,
      {
        ...replace,
        enabled: true,
        expectedRevision: disabled.binding.revision,
        idempotencyKey: randomUUID(),
      },
    );

    request = {
      ...request,
      coordinatorBindingRevision: enabled.binding.revision,
    };
    await expect(
      database.db.transaction((tx) =>
        resolveKnowledgeRunIdentity(tx, nativeFlowRunId, node.id),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  } finally {
    compatibility.mockRestore();
  }
});

it("uses current initiating authority after revocation rather than the frozen input witness", async () => {
  const compatibility = vi.spyOn(engine, "isEngineCompatible");

  try {
    const capture = await prepareFreshGraphReservation();
    const before = await counts();
    const grant = (
      await database.pool.query<{ id: string; revision: number }>(
        "SELECT id,revision FROM company_grants WHERE principal_type='user' AND principal_id=$1 AND action='assignments:update' AND revoked_at IS NULL",
        [requesterId],
      )
    ).rows[0]!;

    await revokeCompanyGrant(database.db, administratorId, grant.id, {
      expectedRevision: grant.revision,
      reason: "Revoke coordinator admission",
      idempotencyKey: randomUUID(),
    });
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyFlowContext(tx, requesterId, request),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      database.db.transaction((tx) =>
        insertClonedGraphReservation(tx, randomUUID(), capture, {}),
      ),
    ).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "runs_company_execution_reference_check",
      },
    });
    expect(await counts()).toEqual(before);
  } finally {
    compatibility.mockRestore();
  }
});

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { CompanyAction } from "@/lib/company/types";
import type { SessionUser } from "@/lib/authz";
import type { AgentScheduleInput } from "@/lib/agents/project-links";
import type { Db } from "@/lib/execution-host/db";
import type { OperationalWorkspaceContext } from "../operational-context";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { CompanyAgentExecutionSnapshot } from "../company-agent-execution-types";
import type { PreparedSpecialistAssignment } from "@/lib/specialist-assignments/types";

import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { join, resolve, sep } from "node:path";
import { Writable } from "node:stream";

import { parse, stringify } from "yaml";
import pino from "pino";
import Ajv from "ajv";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";

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
  issueAgentRunToken,
  revokeAgentRunToken,
  revokeAgentRunTokensForRun,
} from "../tokens";
import { buildOperationalContract } from "../launch-contract";
import {
  operationalWorkspace,
  operationalReferenceEvidence,
  inspectOperationalWorkspace,
} from "../operational-context";
import {
  captureOperationalBaseline,
  captureOperationalGeneration,
} from "../operational-integrity";
import {
  prepareAgentRunFinalization,
  prepareUndispatchedAgentFailure,
} from "../finalization";
import {
  reserveCompanyAgentRun,
  reserveCompanyAgentRunInTransaction,
} from "../company-agent-launch";
import { startAgentSession } from "../launch";
import { startAgentContinuationWorker } from "../continuation-worker";
import { getCompanyAgentRunHistory } from "../activity-queries";

import {
  acknowledgeOperationalAttention,
  retryOperationalCleanup,
} from "@/lib/runs/operational-attention";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import { readTranscriptPage } from "@/lib/runs/transcript-page";
import { authorizePeekRun } from "@/lib/runs/peek-read-model";
import { requireActiveUserById } from "@/lib/authz";
import { GET as companyHistoryGet } from "@/app/api/specialists/[specialistId]/runs/route";
import { GET as streamGet } from "@/app/api/runs/[runId]/stream/route";
import {
  getRuntimeObjectForRun,
  publishRuntimeObject,
} from "@/lib/execution-host/runtime-objects";
import { authorizeRuntimeObjectContentActor } from "@/lib/execution-host/runtime-object-access";
import {
  runs,
  runSessions,
  platformAcpRunners,
  platformRuntimeSettings,
} from "@/lib/db/schema";
import { createExecutionHosts, localHost } from "@/lib/execution-host";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
  scriptAgentTurn,
} from "@/test-support/fake-execution-host";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import {
  tryStartRun,
  promoteNextPending,
  countLiveRuns,
} from "@/lib/scheduler";
import { disposeOperationalRun } from "@/lib/gc/operational-disposition";
import { operationalSuccessFixture } from "@/test-support/operational-agent";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { appendSpecialistAssignmentContext } from "@/lib/specialist-assignments/context";
import {
  GET as externalContextGet,
  PATCH as externalContextPatch,
} from "@/app/api/v1/ext/specialist-assignments/[assignmentId]/context/route";
import {
  knowledgeSourceReadPolicy,
  knowledgeReadPolicyCte,
} from "@/lib/brain/knowledge-query-policy";
import { assertNativeRunKnowledgeInputs } from "@/lib/brain/knowledge-execution-access";
import { resolveProjectEventChainDepth } from "@/lib/agents/chain-depth";
import { maxAgentChainDepth } from "@/lib/instance-config";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { searchKnowledge } from "@/lib/brain/knowledge-search";
import {
  createKnowledgeProposal,
  reviewKnowledgeProposal,
} from "@/lib/brain/knowledge-proposals";
import { verifyToken, actorUserIdForToken } from "@/lib/tokens/verify";
import { handleAssignmentAction } from "@/app/api/assignments/[assignmentId]/_shared";
import { POST as acknowledgeOperationalPost } from "@/app/api/runs/[runId]/operational/acknowledge/route";
import { POST as retryOperationalPost } from "@/app/api/runs/[runId]/operational/cleanup/retry/route";
import { POST as assignmentPost } from "@/app/api/specialist-assignments/route";
import { POST as externalAssignmentPost } from "@/app/api/v1/ext/specialist-assignments/route";
import { POST as inboundAgentEventPost } from "@/app/api/agents/[agentId]/event/route";
import { POST as routedProjectLaunchPost } from "@/app/api/projects/[slug]/agents/[agentId]/launch/route";
import { PATCH as projectAgentPatch } from "@/app/api/projects/[slug]/agents/[agentId]/route";
import { POST as taskCommentPost } from "@/app/api/projects/[slug]/tasks/[number]/comments/route";
import { GET as externalAssignmentGet } from "@/app/api/v1/ext/specialist-assignments/[assignmentId]/route";
import { issueUserAccessToken, issueToken } from "@/lib/tokens/issue";
import { createCompanyCronSchedule } from "@/lib/agents/company-schedules";
import { createCompanyEventSchedule } from "@/lib/agents/company-event-schedules";
import { resolveCompanyEventChainDepth } from "@/lib/agents/chain-depth";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";
import {
  dispatchDomainEvents,
  ensureConsumerRows,
} from "@/lib/domain-events/dispatch";
import { DOMAIN_EVENT_CONSUMERS } from "@/lib/domain-events/consumers";
import {
  claimCronAgentAttempt,
  claimEventAgentAttempt,
  assertProjectAgentTriggerClaim,
  reconcileAgentTriggerAttempts,
  settleCompanyAgentTriggerAttempt,
} from "@/lib/agents/trigger-attempts";
import { MaisterError } from "@/lib/errors";
import { loadProjectCommentAppointment } from "@/lib/specialist-assignments/project-comment-appointment";
import { loadProjectCronAppointment } from "@/lib/specialist-assignments/project-cron-appointment";
import { submitProjectCronAssignment } from "@/lib/specialist-assignments/project-cron-intake";
import { prepareCompanySpecialistAssignment } from "@/lib/specialist-assignments/company-intake";
import { reserveCompanyCronAssignment } from "@/lib/specialist-assignments/company-cron-intake";
import { wakePendingSpecialistAssignment } from "@/lib/specialist-assignments/admission-wake";
import { specialistAssignmentSchema } from "@/lib/specialist-assignments/types";
import { POST as stopRunPost } from "@/app/api/runs/[runId]/stop/route";
import { POST as respondHitlPost } from "@/app/api/runs/[runId]/hitl/[hitlRequestId]/respond/route";
import { POST as claimHumanAssignmentPost } from "@/app/api/assignments/[assignmentId]/claim/route";
import { createHitlRequest } from "@/lib/runs/hitl-create";
import {
  createHitlAssignmentForRun,
  claimAssignment,
  completeAssignment,
  completeHitlAssignmentFromCurrentActor,
  systemCloseActiveAssignmentsForRun,
  ensureUserActor,
  ensureCompanyUserActor,
} from "@/lib/assignments/service";
import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import {
  createSpecialistAssignment,
  createSpecialistAssignmentInTransaction,
  cancelSpecialistAssignment,
  linkSpecialistAssignmentRunInTransaction,
  activateInitialSpecialistAssignmentRunInTransaction,
} from "@/lib/specialist-assignments/store";
import {
  installPackageRevision,
  trustPackageRevision,
  attachPackage,
} from "@/lib/packages/attach";
import { loadNativeInputForUser } from "@/lib/orchestrator/native-input-read";
import { attachAgent, updateAgentLink } from "@/lib/agents/project-links";
import { enableRevision } from "@/lib/flows/lifecycle";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { git, initRepo } from "@/test-support/git-fixture";

const browserSession = vi.hoisted(() => ({ user: null as SessionUser | null }));
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

const submitExternal = (
  value: unknown,
  secret: string | null,
): Promise<Response> =>
  externalAssignmentPost(
    new NextRequest("http://localhost/api/v1/ext/specialist-assignments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(value),
    }),
  );

const inspectExternal = (
  assignmentId: string,
  secret: string,
): Promise<Response> =>
  externalAssignmentGet(
    new NextRequest(
      `http://localhost/api/v1/ext/specialist-assignments/${assignmentId}`,
      { headers: { Authorization: `Bearer ${secret}` } },
    ),
    { params: Promise.resolve({ assignmentId }) },
  );

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (original) => {
  const actual = await original<typeof import("@/lib/authz")>();

  return {
    ...actual,
    requireActiveSession: async () => {
      if (!browserSession.user)
        throw new Error(
          "The company read fixture has no authenticated session",
        );

      return browserSession.user;
    },
    requireProjectAction: async (
      projectId: string,
      action: Parameters<typeof actual.requireProjectAction>[1],
    ) => {
      if (!browserSession.user)
        throw new Error(
          "The project launch fixture has no authenticated session",
        );

      return actual.requireProjectActionForUser(
        browserSession.user.id,
        projectId,
        action,
      );
    },
  };
});

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", "company-agent-knowledge-cursor-fixture");
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "company_agent_context",
  });
  root = await realpath(
    await mkdtemp(join(os.tmpdir(), "company-agent-context-")),
  );
  vi.stubEnv("MAISTER_WORKTREES_ROOT", join(root, "worktrees"));
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
    "---\nname: Operations observer\ndescription: Diagnose authorized stand state\nkind: operational\ncompletion: {contract: operational_v1}\nspecialist:\n  responsibilities: [Inspect authorized stand state]\n  targetClasses: [stand]\nmode: session\nworkspace: none\ntriggers: [manual, cron, domain_event]\nrisk_tier: read_only\nconfig:\n  - key: label\n    type: string\n    default: base\n---\nInspect the authorized target. Preserve missing evidence.\n",
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
      .replace("workspace: none", "flow: rah-control\nworkspace: none")
      .replace(
        "triggers: [manual, cron, domain_event]",
        "triggers: [manual, cron, domain_event, webhook]",
      ),
  );
  await writeFile(
    join(source, "maister-agents/disabled-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/runner-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/context-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/context-source-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/context-writer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/memory-observer.md"),
    primarySource.replace(
      "workspace: none",
      "memory: enabled\nworkspace: none",
    ),
  );
  await writeFile(
    join(source, "maister-agents/wire-observer.md"),
    primarySource +
      "fixture-output:" +
      JSON.stringify({
        bytes: 0,
        text:
          "```json maister:output\n" +
          JSON.stringify(operationalSuccessFixture()) +
          "\n```",
      }) +
      "\n",
  );
  await cp(
    join(source, "maister-agents/wire-observer.md"),
    join(source, "maister-agents/event-observer.md"),
  );
  await writeFile(
    join(source, "maister-agents/webhook-observer.md"),
    (
      await readFile(join(source, "maister-agents/wire-observer.md"), "utf8")
    ).replace(
      "triggers: [manual, cron, domain_event]",
      "triggers: [manual, webhook]",
    ),
  );
  for (const delivery of ["live", "checkpointed", "cancelled"] as const) {
    await writeFile(
      join(source, `maister-agents/permission-${delivery}-observer.md`),
      primarySource +
        "fixture-output:" +
        JSON.stringify({
          bytes: 0,
          permission: true,
          permissionToolCall: {
            toolCallId: "company-proposal-proof",
            title: "mcp__maister__knowledge_propose",
            kind: "other",
            status: "pending",
          },
          text:
            "```json maister:output\n" +
            JSON.stringify(operationalSuccessFixture()) +
            "\n```",
        }) +
        "\n",
    );
  }
  await writeFile(
    join(source, "flows/rah-control/flow.yaml"),
    stringify({
      schemaVersion: 1,
      name: "rah-control",
      compat: { engine_min: "3.12.0" },
      result: {
        export: {
          schema: "./schemas/evidence-findings.v1.json",
          native_contract: "evidence_findings_v1",
          from: ["research"],
          required: true,
        },
      },
      nodes: [
        {
          id: "research",
          type: "ai_coding",
          action: {
            prompt:
              "Investigate the original assigned request: {{ task.prompt }}\nfixture-output:" +
              JSON.stringify({
                bytes: 0,
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
          output: {
            result: {
              schema: "./schemas/evidence-findings.v1.json",
              required: true,
            },
          },
          transitions: { success: "done" },
        },
      ],
    }),
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

it("CBS-02 adopts the server-resolved company directory through the real supervisor wire and retains its owner", async () => {
  const db: Db = database.db;
  const supervisor = await startRealSupervisor({
    runtimeRoot: join(root, "adoption-host"),
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang"],
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);

  setDefaultTransportForTests(null);
  resetResolverForTests();
  resetRegistrarStateForTests();
  try {
    const { runId } = await reserveCompanyFixtureRun();
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    const owner = await operationalWorkspace(db, run);

    await mkdir(owner.cwd, { recursive: true });
    const hosts = createExecutionHosts({
      db,
      transport: createLocalDirectTransport(),
    });
    const client = await hosts.forRun(runId, { reason: "launch" });
    const handle = await client.ensureWorkspace();
    const record = await hosts.local().getWorkspace(handle);

    expect(record).toMatchObject({
      runId,
      owner: { kind: "company", companyId: request.companyId },
      projectSlug: "_company",
      kind: "directory",
      releasedAt: null,
    });
    expect(await client.ensureWorkspace()).toBe(handle);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='workspace.adopt'",
          [runId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    expect(
      (
        await database.pool.query("SELECT project_id FROM runs WHERE id=$1", [
          runId,
        ])
      ).rows[0],
    ).toEqual({ project_id: null });
    const prepared = await prepareUndispatchedAgentFailure(runId, {
      db,
      reason: "fixture_adoption_probe_complete",
    });
    const finalized = await db.transaction((tx) => prepared.apply(tx));

    expect(finalized.finalized).toBe(true);
  } finally {
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    resetRegistrarStateForTests();
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
}, 120000);

it("IT-CBS-04 completes company HTTP and registered cron intake through the existing scheduler, real supervisor and ACP process with physical quiescence", async () => {
  const db: Db = database.db;
  const supervisor = await startRealSupervisor({
    runtimeRoot: join(root, "company-driver-host"),
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang"],
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const worker = startProjectionWorker({ db, projectors: canonicalProjectors });
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

  setDefaultTransportForTests(null);
  resetResolverForTests();
  resetRegistrarStateForTests();
  vi.stubEnv("MAISTER_MAX_CONCURRENT_AGENTS", "100");
  try {
    const roleId = "rah:wire-observer";
    const effective = await resolveInstalledAgentDefinition(db, {
      agentId: roleId,
      packageInstallId: assignmentInput.standingDefinition.packageInstallId,
    });
    const runnerId = randomUUID();

    await db.insert(platformAcpRunners).values({
      id: runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "company-wire-fixture",
      provider: { kind: "anthropic" },
      readinessStatus: "Ready",
    });
    const binding = await createCompanySpecialistBinding(db, userId, roleId, {
      owner: { kind: "company", companyId: request.companyId },
      packageInstallId: effective.packageInstallId,
      packageRevision: effective.resolvedRevision!,
      definitionSha256: agentDefinitionSha256(effective.parsed),
      enabled: true,
      configuration: {},
      grantActions: ["knowledge:read", "knowledge:propose"],
      runnerId,
      idempotencyKey: randomUUID(),
    });
    const { expectedResult: _expectedResult, ...objective } =
      assignmentInput.objectiveInput;
    const manualRequest = {
      ...objective,
      owner: assignmentInput.owner,
      specialistBindingId: binding.specialist.bindingId,
      idempotencyKey: randomUUID(),
    };
    const eventDefinition = await resolveInstalledAgentDefinition(db, {
      agentId: "rah:event-observer",
      packageInstallId: effective.packageInstallId,
    });
    const eventBinding = await createCompanySpecialistBinding(
      db,
      userId,
      "rah:event-observer",
      {
        owner: { kind: "company", companyId: request.companyId },
        packageInstallId: eventDefinition.packageInstallId,
        packageRevision: eventDefinition.resolvedRevision!,
        definitionSha256: agentDefinitionSha256(eventDefinition.parsed),
        enabled: true,
        configuration: {},
        grantActions: [
          "knowledge:read",
          "knowledge:propose",
          "assignments:read",
        ],
        runnerId,
        idempotencyKey: randomUUID(),
      },
    );

    const eventSourceRequest = {
      owner: { kind: "company", companyId: request.companyId } as const,
      specialistBindingId: eventBinding.specialist.bindingId,
      eventKinds: ["run.done"] as ["run.done"],
      enabled: true,
      idempotencyKey: randomUUID(),
    };
    const eventContract: { components: { schemas: Record<string, object> } } =
      parse(await readFile(resolve("../docs/api/web.openapi.yaml"), "utf8"));
    const validateEventSource = new Ajv({
      strict: false,
      validateFormats: false,
    }).compile({
      components: eventContract.components,
      ...eventContract.components.schemas.CBCompanyEventScheduleInput,
    });

    expect(
      validateEventSource(eventSourceRequest),
      JSON.stringify(validateEventSource.errors),
    ).toBe(true);
    for (const invalid of [
      { ...eventSourceRequest, eventKinds: [] },
      { ...eventSourceRequest, eventKinds: ["run.done", "run.done"] },
      { ...eventSourceRequest, eventKinds: ["task.created"] },
      { ...eventSourceRequest, eventKinds: ["agent.activity_changed"] },
      { ...eventSourceRequest, requestAtLaunch: "untrusted recurring input" },
      { ...eventSourceRequest, permissions: ["assignments:read"] },
    ]) {
      expect(validateEventSource(invalid)).toBe(false);
      await expect(
        createCompanyEventSchedule(db, userId, invalid),
      ).rejects.toMatchObject({ code: "CONFIG" });
    }
    await expect(
      createCompanyEventSchedule(db, userId, eventSourceRequest),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "company_event_source_sharing_required" },
    });
    await createCompanyGrants(db, administratorId, {
      principalKind: "agent",
      principalId: roleId,
      actions: ["assignments:read"],
      idempotencyKey: randomUUID(),
    });
    await expect(
      createCompanyEventSchedule(db, userId, {
        ...eventSourceRequest,
        specialistBindingId: binding.specialist.bindingId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "company_event_source_sharing_required" },
    });
    const draftRequest = {
      ...eventSourceRequest,
      enabled: false,
      eventKinds: ["run.failed", "run.done"] as ["run.failed", "run.done"],
      idempotencyKey: randomUUID(),
    };
    const draft = await createCompanyEventSchedule(db, userId, draftRequest);
    const draftReplay = await createCompanyEventSchedule(db, userId, {
      ...draftRequest,
      eventKinds: ["run.done", "run.failed"],
    });

    expect(draftReplay).toEqual({ ...draft, duplicate: true });
    expect(draftRequest.eventKinds).toEqual(["run.failed", "run.done"]);
    expect(
      (
        await database.pool.query(
          "SELECT event_match,request_at_launch,cron_expr,timezone,next_fire_at,enabled FROM agent_schedules WHERE id=$1",
          [draft.scheduleId],
        )
      ).rows,
    ).toEqual([
      {
        event_match: { kinds: ["run.done", "run.failed"] },
        request_at_launch: null,
        cron_expr: null,
        timezone: null,
        next_fire_at: null,
        enabled: false,
      },
    ]);
    await expect(
      createCompanyEventSchedule(db, userId, {
        ...draftRequest,
        eventKinds: ["run.done"],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      createCompanyCronSchedule(db, userId, {
        owner: draftRequest.owner,
        specialistBindingId: draftRequest.specialistBindingId,
        cronExpr: "*/5 * * * *",
        timezone: "UTC",
        idempotencyKey: draftRequest.idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await createCompanyGrants(db, administratorId, {
      principalKind: "agent",
      principalId: "rah:event-observer",
      actions: ["assignments:read", "knowledge:read"],
      idempotencyKey: randomUUID(),
    });
    const eventSources: string[] = [];

    let malformedEventSource = "";

    for (let subscriber = 0; subscriber < 2; subscriber++) {
      const sourceRequest = {
        ...eventSourceRequest,
        idempotencyKey: randomUUID(),
      };
      const receipts = await Promise.all([
        createCompanyEventSchedule(db, userId, sourceRequest),
        createCompanyEventSchedule(db, userId, sourceRequest),
      ]);

      expect(new Set(receipts.map((receipt) => receipt.scheduleId)).size).toBe(
        1,
      );
      expect(receipts.map((receipt) => receipt.duplicate).sort()).toEqual([
        false,
        true,
      ]);
      eventSources.push(receipts[0].scheduleId);
    }
    const malformedDraft = await createCompanyCronSchedule(db, userId, {
      owner: { kind: "company", companyId: request.companyId },
      specialistBindingId: eventBinding.specialist.bindingId,
      cronExpr: "*/5 * * * *",
      timezone: "UTC",
      enabled: false,
      idempotencyKey: randomUUID(),
    });

    // Only corruption qualification writes malformed owned source metadata directly.
    await database.pool.query(
      "UPDATE agent_schedules SET trigger_type='event',cron_expr=NULL,timezone=NULL,next_fire_at=NULL,event_match=$2::jsonb,enabled=true,company_config_revision=company_config_revision+1 WHERE id=$1",
      [malformedDraft.scheduleId, JSON.stringify({ kinds: 7 })],
    );
    malformedEventSource = malformedDraft.scheduleId;
    await ensureConsumerRows(db, DOMAIN_EVENT_CONSUMERS);
    const hosts = createExecutionHosts({
      db,
      transport: createLocalDirectTransport(),
    });
    const beforeUnconfigured = (
      await database.pool.query(
        "SELECT (SELECT count(*) FROM runs) AS runs,(SELECT count(*) FROM run_sessions) AS sessions,(SELECT count(*) FROM specialist_run_links) AS links",
      )
    ).rows[0];

    await expect(
      reserveCompanyAgentRun(db, userId, request, hosts),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
    expect(
      (
        await database.pool.query(
          "SELECT (SELECT count(*) FROM runs) AS runs,(SELECT count(*) FROM run_sessions) AS sessions,(SELECT count(*) FROM specialist_run_links) AS links",
        )
      ).rows[0],
    ).toEqual(beforeUnconfigured);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM runs WHERE run_kind='agent' AND status='Pending'",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    browserSession.user = await requireActiveUserById(userId);
    const submit = (): Promise<Response> =>
      assignmentPost(
        new NextRequest("http://localhost/api/specialist-assignments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(manualRequest),
        }),
      );
    const personalToken = await issueUserAccessToken(
      {
        ownerUserId: userId,
        name: "company-assignment-intake",
        scopes: ["assignments:read", "assignments:submit"],
      },
      db,
    );
    const readOnlyToken = await issueUserAccessToken(
      {
        ownerUserId: userId,
        name: "company-assignment-read",
        scopes: ["assignments:read"],
      },
      db,
    );

    expect((await submitExternal({ invalid: true }, null)).status).toBe(401);
    expect(
      (await submitExternal(manualRequest, readOnlyToken.secret)).status,
    ).toBe(403);
    expect(
      (
        await submitExternal(
          {
            ...manualRequest,
            requester: { kind: "user", id: administratorId },
          },
          personalToken.secret,
        )
      ).status,
    ).toBe(422);
    const response = await submitExternal(manualRequest, personalToken.secret);

    expect(response.status).toBe(201);
    const assignment = specialistAssignmentSchema.parse(await response.json());

    expect(assignment.runIds).toHaveLength(1);
    const externalInspection = await inspectExternal(
      assignment.id,
      readOnlyToken.secret,
    );

    expect(externalInspection.status).toBe(200);
    expect(externalInspection.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(await externalInspection.json()).toMatchObject({
      id: assignment.id,
      requester: { kind: "user", id: userId },
    });
    expect(
      (await inspectExternal(randomUUID(), readOnlyToken.secret)).status,
    ).toBe(404);
    await database.pool.query(
      "UPDATE project_tokens SET revoked_at=now() WHERE id=$1",
      [readOnlyToken.tokenId],
    );
    expect(
      (await inspectExternal(assignment.id, readOnlyToken.secret)).status,
    ).toBe(401);
    const externalReplay = await submitExternal(
      manualRequest,
      personalToken.secret,
    );

    expect(externalReplay.status).toBe(200);
    expect(await externalReplay.json()).toMatchObject({
      id: assignment.id,
      runIds: assignment.runIds,
    });
    expect(
      (
        await submitExternal(
          { ...manualRequest, input: "changed request" },
          personalToken.secret,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM token_audit_log WHERE token_id=$1 AND endpoint LIKE '%specialist-assignments%'",
          [personalToken.tokenId],
        )
      ).rows[0].count,
    ).toBeGreaterThanOrEqual(4);
    const receipt = { runId: assignment.runIds[0]! };

    await vi.waitFor(
      async () => {
        const [completed] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, receipt.runId));

        expect(completed).toMatchObject({
          status: "Done",
          operationalCleanup: { state: "released" },
        });
      },
      { timeout: 30000, interval: 25 },
    );
    const replay = await submit();

    expect(replay.status).toBe(200);
    expect(
      specialistAssignmentSchema.parse(await replay.json()).runIds,
    ).toEqual([receipt.runId]);
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, receipt.runId));

    expect(run).toMatchObject({
      status: "Done",
      projectId: null,
      companyId: request.companyId,
      operationalTerminal: { effectiveOutcome: "success" },
    });
    const commands = await database.pool.query(
      "SELECT kind,state FROM execution_commands WHERE run_id=$1 ORDER BY created_at,id",
      [receipt.runId],
    );

    expect(
      commands.rows.filter((command) => command.kind === "session.create"),
    ).toHaveLength(1);
    expect(
      commands.rows.filter((command) => command.kind === "session.prompt"),
    ).toHaveLength(1);
    expect(
      commands.rows.some((command) => command.kind === "workspace.adopt"),
    ).toBe(true);
    const sessions = await hosts.local().listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: "exited" });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM run_results WHERE run_id=$1 AND validity='valid'",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM project_tokens WHERE company_run_id=$1 AND revoked_at IS NULL",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    expect(
      (
        await database.pool.query(
          "SELECT status,revision FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ status: "active", revision: 3 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_assignments WHERE run_id=$1 AND state='active'",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    await expect(
      authorizePeekRun(userId, receipt.runId),
    ).resolves.toMatchObject({ canReadTranscript: true });
    const transcript = await readTranscriptPage(userId, receipt.runId, {
      limit: "20",
    });

    expect(JSON.stringify(transcript.messages)).toContain("maister:output");
    browserSession.user = await requireActiveUserById(userId);
    const terminalStop = await stopRunPost(
      new Request(`http://localhost/api/runs/${receipt.runId}/stop`, {
        method: "POST",
      }),
      { params: Promise.resolve({ runId: receipt.runId }) },
    );

    expect(terminalStop.status).toBe(409);
    const originatingEvent = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM domain_events WHERE run_id=$1 AND kind='run.done'",
        [receipt.runId],
      )
    ).rows[0]!;

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE runs SET trigger_source=NULL WHERE id=${receipt.runId}`,
        );
        const inspection = await resolveCompanyEventChainDepth(
          tx,
          Number(originatingEvent.id),
        );

        // Keep the legacy provenance probe isolated even when its assertion is RED.
        throw new MaisterError(
          "CONFLICT",
          "Roll back the historical source classification probe",
          {
            details: { reason: "legacy_event_probe", inspection },
          },
        );
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        reason: "legacy_event_probe",
        inspection: { atCap: true, reason: "company_event_chain_unclassified" },
      },
    });
    expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
    expect(
      (
        await database.pool.query(
          "SELECT last_outcome,last_error_code,(SELECT count(*)::int FROM agent_trigger_attempts WHERE schedule_id=$1) AS claims FROM agent_schedules WHERE id=$1",
          [malformedEventSource],
        )
      ).rows,
    ).toEqual([
      { last_outcome: "refused", last_error_code: "CONFIG", claims: 0 },
    ]);
    const eventAttempts = (
      await database.pool.query(
        "SELECT id,schedule_id,reserved_run_id,run_id,outcome,scheduled_request_snapshot FROM agent_trigger_attempts WHERE schedule_id=ANY($1::text[]) AND trigger_event_id=$2 ORDER BY schedule_id",
        [eventSources, originatingEvent.id],
      )
    ).rows;

    expect(eventAttempts).toHaveLength(2);
    for (const eventAttempt of eventAttempts) {
      expect(eventAttempt).toMatchObject({
        outcome: "queued",
        run_id: eventAttempt.reserved_run_id,
        scheduled_request_snapshot: null,
      });
      await vi.waitFor(
        async () => {
          expect(
            (
              await database.pool.query(
                "SELECT status,trigger_source,trigger_event_id,agent_schedule_id,agent_chain_depth,project_id,task_id FROM runs WHERE id=$1",
                [eventAttempt.reserved_run_id],
              )
            ).rows,
          ).toEqual([
            {
              status: "Done",
              trigger_source: "domain_event",
              trigger_event_id: originatingEvent.id,
              agent_schedule_id: eventAttempt.schedule_id,
              agent_chain_depth: 1,
              project_id: null,
              task_id: null,
            },
          ]);
        },
        { timeout: 30000, interval: 25 },
      );
      const retainedEventInput = (
        await database.pool.query(
          "SELECT assignment.origin,input.objective_input,input.source_restrictions,(SELECT knowledge_access->'restrictions' FROM runs WHERE id=$2) AS original_restrictions FROM specialist_run_links link JOIN specialist_assignments assignment ON assignment.id=link.assignment_id JOIN specialist_input_revisions input ON input.assignment_id=link.assignment_id AND input.revision=link.input_revision WHERE link.run_id=$1",
          [eventAttempt.reserved_run_id, receipt.runId],
        )
      ).rows[0]!;

      expect(retainedEventInput.origin).toEqual({
        kind: "event",
        eventId: originatingEvent.id,
        subscriptionId: eventAttempt.schedule_id,
      });
      expect(retainedEventInput.source_restrictions).toEqual(
        retainedEventInput.original_restrictions,
      );
      expect(JSON.parse(retainedEventInput.objective_input.input)).toEqual({
        schemaVersion: 1,
        event: {
          id: originatingEvent.id,
          kind: "run.done",
          runId: receipt.runId,
        },
      });
    }
    await expect(
      database.pool.query("UPDATE runs SET agent_schedule_id=$2 WHERE id=$1", [
        eventAttempts[0]!.reserved_run_id,
        eventAttempts[1]!.schedule_id,
      ]),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "runs_company_event_source_immutable",
    });
    await database.pool.query(
      "UPDATE domain_event_consumers SET cursor_event_id=$1::bigint-1 WHERE consumer_id='agent_triggers'",
      [originatingEvent.id],
    );
    expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM agent_trigger_attempts WHERE schedule_id=ANY($1::text[]) AND trigger_event_id=$2",
          [eventSources, originatingEvent.id],
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
    await expect(
      createCompanyCronSchedule(db, userId, {
        owner: { kind: "company", companyId: request.companyId },
        specialistBindingId: binding.specialist.bindingId,
        cronExpr: "*/5 * * * *",
        timezone: "UTC",
        requestAtLaunch: "  \r\n  ",
        enabled: true,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "NEEDS_INPUT",
      details: { reason: "company_scheduled_request_missing" },
    });
    const cron = await createCompanyCronSchedule(db, userId, {
      owner: { kind: "company", companyId: request.companyId },
      specialistBindingId: binding.specialist.bindingId,
      cronExpr: "*/5 * * * *",
      timezone: "UTC",
      requestAtLaunch:
        "Inspect this configured company target on the recurring schedule.",
      enabled: true,
      idempotencyKey: randomUUID(),
    });
    const poisonCron = await createCompanyCronSchedule(db, userId, {
      owner: { kind: "company", companyId: request.companyId },
      specialistBindingId: binding.specialist.bindingId,
      cronExpr: "*/5 * * * *",
      timezone: "UTC",
      requestAtLaunch: "This damaged source must not starve valid work.",
      enabled: false,
      idempotencyKey: randomUUID(),
    });

    await database.pool.query(
      "UPDATE agent_schedules SET next_fire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [cron.scheduleId],
    );
    await database.pool.query(
      "UPDATE agent_schedules SET enabled=true,cron_expr='invalid source',company_config_revision=company_config_revision+1,next_fire_at=clock_timestamp()-interval '1 day' WHERE id=$1",
      [poisonCron.scheduleId],
    );
    await database.pool.query(
      "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
    );
    const cronTicks = await Promise.all([
      runSchedulerTick({ jobKind: "agent_tick" }),
      runSchedulerTick({ jobKind: "agent_tick" }),
    ]);

    expect(
      cronTicks.reduce((total, tick) => total + tick.succeededCount, 0),
    ).toBe(1);
    const attempts = (
      await database.pool.query(
        "SELECT id,reserved_run_id,run_id,outcome,scheduled_request_snapshot FROM agent_trigger_attempts WHERE schedule_id=$1",
        [cron.scheduleId],
      )
    ).rows;

    expect(attempts).toHaveLength(1);
    const attempt = attempts[0];

    expect(attempt).toMatchObject({
      outcome: "queued",
      run_id: attempt.reserved_run_id,
      scheduled_request_snapshot: {
        version: 1,
        scheduleId: cron.scheduleId,
        triggerAttemptId: attempt.id,
        requestAtLaunch:
          "Inspect this configured company target on the recurring schedule.",
      },
    });
    expect(
      (
        await database.pool.query(
          "SELECT last_outcome,last_error_code,last_error_message,next_fire_at>clock_timestamp()+interval '4 minutes' AS deferred FROM agent_schedules WHERE id=$1",
          [poisonCron.scheduleId],
        )
      ).rows,
    ).toEqual([
      {
        last_outcome: "refused",
        last_error_code: "CONFIG",
        last_error_message: "Company source capture requires attention",
        deferred: true,
      },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT status,(SELECT count(*)::int FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')) AS dispatches FROM runs WHERE id=$1",
          [attempt.reserved_run_id],
        )
      ).rows,
    ).toEqual([{ status: "Pending", dispatches: 0 }]);
    const pendingCron = await reserveCompanyCronAssignment(db, {
      attemptId: attempt.id,
      runId: attempt.reserved_run_id,
    });

    expect(pendingCron.duplicate).toBe(true);
    await database.pool.query("DELETE FROM execution_host_pressure");
    await wakePendingSpecialistAssignment(db, pendingCron);
    await vi.waitFor(
      async () => {
        const [scheduled] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, attempt.reserved_run_id));

        expect(scheduled).toMatchObject({
          status: "Done",
          projectId: null,
          taskId: null,
          companyId: request.companyId,
          agentScheduleId: cron.scheduleId,
          scheduledRequestSnapshot: attempt.scheduled_request_snapshot,
        });
      },
      { timeout: 30000, interval: 25 },
    );
    const nextEvent = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM domain_events WHERE run_id=$1 AND kind='run.done'",
        [attempt.reserved_run_id],
      )
    ).rows[0]!;
    const recipientGrant = (
      await database.pool.query<{ id: string; revision: number }>(
        "SELECT id,revision FROM company_grants WHERE principal_type='agent' AND principal_id='rah:event-observer' AND action='assignments:read' AND revoked_at IS NULL",
      )
    ).rows[0]!;

    await revokeCompanyGrant(db, administratorId, recipientGrant.id, {
      expectedRevision: recipientGrant.revision,
      reason: "Qualify revoked event-recipient source sharing",
      idempotencyKey: randomUUID(),
    });
    try {
      expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
      expect(
        (
          await database.pool.query(
            "SELECT outcome,reason_code,run_id,(SELECT count(*)::int FROM execution_commands command WHERE command.run_id=invocation.reserved_run_id AND command.kind IN ('session.create','session.prompt')) AS dispatches FROM agent_trigger_attempts invocation WHERE schedule_id=ANY($1::text[]) AND trigger_event_id=$2 ORDER BY schedule_id",
            [eventSources, nextEvent.id],
          )
        ).rows,
      ).toEqual([
        {
          outcome: "refused",
          reason_code: "PRECONDITION",
          run_id: null,
          dispatches: 0,
        },
        {
          outcome: "refused",
          reason_code: "PRECONDITION",
          run_id: null,
          dispatches: 0,
        },
      ]);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM specialist_assignments WHERE origin->>'kind'='event' AND origin->>'eventId'=$1",
            [nextEvent.id],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await createCompanyGrants(db, administratorId, {
        principalKind: "agent",
        principalId: "rah:event-observer",
        actions: ["assignments:read"],
        idempotencyKey: randomUUID(),
      });
    }
    expect(
      (
        await database.pool.query(
          "SELECT assignment.origin,assignment.status,input.scheduled_request FROM specialist_assignments assignment JOIN specialist_run_links link ON link.assignment_id=assignment.id JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=link.input_revision WHERE link.run_id=$1",
          [attempt.reserved_run_id],
        )
      ).rows,
    ).toEqual([
      {
        origin: {
          kind: "schedule",
          scheduleId: cron.scheduleId,
          triggerAttemptId: attempt.id,
        },
        status: "active",
        scheduled_request: attempt.scheduled_request_snapshot,
      },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt') GROUP BY kind ORDER BY kind",
          [attempt.reserved_run_id],
        )
      ).rows,
    ).toEqual([
      { kind: "session.create", count: 1 },
      { kind: "session.prompt", count: 1 },
    ]);

    const { idempotencyKey: _manualKey, ...originalCronRequest } =
      manualRequest;
    const reservationHost = await localHost({ db, transport: hosts.transport });

    await expect(
      db.transaction(async (tx) => {
        const prepared = await prepareCompanySpecialistAssignment(
          tx,
          userId,
          {
            ...originalCronRequest,
            owner: { kind: "company", companyId: request.companyId },
          },
          {
            origin: {
              kind: "schedule",
              scheduleId: cron.scheduleId,
              triggerAttemptId: attempt.id,
            },
            scheduledRequest: attempt.scheduled_request_snapshot,
            destination: { kind: "inbox", userId },
          },
        );
        const unappointed = await createSpecialistAssignmentInTransaction(
          tx,
          userId,
          prepared,
        );

        await reserveCompanyAgentRunInTransaction(
          tx,
          userId,
          {
            companyId: request.companyId,
            assignmentId: unappointed.id,
            assignmentRevision: unappointed.revision,
            inputRevision: unappointed.inputRevision,
            bindingId: binding.specialist.bindingId,
            bindingRevision: binding.specialist.configRevision,
            triggerSource: "cron",
          },
          hosts,
          reservationHost,
        );
        // The regression rollback must also occur when an unsafe constructor
        // accepts the missing source appointment, so RED cannot leave live work.
        throw new MaisterError(
          "CRASH",
          "The native constructor accepted cron work without its existing source reservation",
        );
      }),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "company_trigger_reservation_required" },
    });
    const cronReplay = await reserveCompanyCronAssignment(db, {
      attemptId: attempt.id,
      runId: attempt.reserved_run_id,
    });

    expect(cronReplay).toMatchObject({
      duplicate: true,
      assignment: { runIds: [attempt.reserved_run_id] },
    });
    await database.pool.query(
      "UPDATE agent_schedules SET next_fire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [cron.scheduleId],
    );
    const recoveryNow = new Date();
    const interrupted = await claimCronAgentAttempt(
      db,
      cron.scheduleId,
      recoveryNow,
      new Date(recoveryNow.getTime() + 300000),
    );

    expect(interrupted).not.toBeNull();
    const retainedCron = await reserveCompanyCronAssignment(db, {
      attemptId: interrupted!.id,
      runId: interrupted!.reservedRunId,
    });

    expect(retainedCron.duplicate).toBe(false);
    expect(retainedCron.assignment.id).not.toBe(cronReplay.assignment.id);
    expect(
      (
        await database.pool.query(
          "SELECT outcome FROM agent_trigger_attempts WHERE id=$1",
          [interrupted!.id],
        )
      ).rows,
    ).toEqual([{ outcome: null }]);
    await database.pool.query(
      "UPDATE agent_trigger_attempts SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [interrupted!.id],
    );
    expect(await reconcileAgentTriggerAttempts(db, new Date())).toEqual({
      adopted: 1,
      unknown: 0,
    });
    expect(
      (
        await database.pool.query(
          "SELECT run_id,outcome FROM agent_trigger_attempts WHERE id=$1",
          [interrupted!.id],
        )
      ).rows,
    ).toEqual([{ run_id: interrupted!.reservedRunId, outcome: "queued" }]);
    await wakePendingSpecialistAssignment(db, retainedCron);
    await vi.waitFor(
      async () => {
        const [recovered] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, interrupted!.reservedRunId));

        expect(recovered.status).toBe("Done");
      },
      { timeout: 30000, interval: 25 },
    );
    const boundedEvent = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM domain_events WHERE run_id=$1 AND kind='run.done'",
        [interrupted!.reservedRunId],
      )
    ).rows[0]!;
    const previousChainCap = process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH;

    vi.stubEnv("MAISTER_MAX_AGENT_CHAIN_DEPTH", "0");
    try {
      expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
      expect(
        (
          await database.pool.query(
            "SELECT outcome,reason_code,run_id FROM agent_trigger_attempts WHERE schedule_id=ANY($1::text[]) AND trigger_event_id=$2 ORDER BY schedule_id",
            [eventSources, boundedEvent.id],
          )
        ).rows,
      ).toEqual([
        {
          outcome: "suppressed",
          reason_code: "chain_depth_exhausted",
          run_id: null,
        },
        {
          outcome: "suppressed",
          reason_code: "chain_depth_exhausted",
          run_id: null,
        },
      ]);
    } finally {
      if (previousChainCap === undefined)
        delete process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH;
      else process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH = previousChainCap;
    }
    await database.pool.query(
      "UPDATE agent_schedules SET next_fire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [cron.scheduleId],
    );
    const uncertain = await claimCronAgentAttempt(
      db,
      cron.scheduleId,
      new Date(),
      new Date(Date.now() + 300000),
    );

    expect(uncertain).not.toBeNull();
    await database.pool.query(
      "UPDATE agent_trigger_attempts SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [uncertain!.id],
    );
    expect(await reconcileAgentTriggerAttempts(db, new Date())).toEqual({
      adopted: 0,
      unknown: 1,
    });
    expect(
      (
        await database.pool.query(
          "SELECT run_id,outcome,reason_code FROM agent_trigger_attempts WHERE id=$1",
          [uncertain!.id],
        )
      ).rows,
    ).toEqual([
      {
        run_id: null,
        outcome: "unknown",
        reason_code: "agent_trigger_outcome_unknown",
      },
    ]);
    await expect(
      reserveCompanyCronAssignment(db, {
        attemptId: uncertain!.id,
        runId: uncertain!.reservedRunId,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "company_trigger_already_settled" },
    });
    await database.pool.query(
      "UPDATE agent_schedules SET next_fire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [cron.scheduleId],
    );
    const revokedInvocation = await claimCronAgentAttempt(
      db,
      cron.scheduleId,
      new Date(),
      new Date(Date.now() + 300000),
    );

    expect(revokedInvocation).not.toBeNull();
    const revokedWork = await reserveCompanyCronAssignment(db, {
      attemptId: revokedInvocation!.id,
      runId: revokedInvocation!.reservedRunId,
    });

    await settleCompanyAgentTriggerAttempt(db, revokedInvocation!, {
      outcome: "queued",
      runId: revokedInvocation!.reservedRunId,
      reasonCode: null,
      now: new Date(),
    });
    const readGrant = (
      await database.pool.query<{ id: string; revision: number }>(
        "SELECT id,revision FROM company_grants WHERE principal_type='user' AND principal_id=$1 AND action='assignments:read' AND revoked_at IS NULL",
        [userId],
      )
    ).rows[0]!;

    await revokeCompanyGrant(db, administratorId, readGrant.id, {
      expectedRevision: readGrant.revision,
      reason:
        "Qualify current source-creator revocation after cron reservation",
      idempotencyKey: randomUUID(),
    });
    try {
      await wakePendingSpecialistAssignment(db, revokedWork);
      await vi.waitFor(
        async () => {
          expect(
            (
              await database.pool.query(
                "SELECT status,(SELECT count(*)::int FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')) AS dispatches FROM runs WHERE id=$1",
                [revokedInvocation!.reservedRunId],
              )
            ).rows,
          ).toEqual([{ status: "Failed", dispatches: 0 }]);
        },
        { timeout: 10000, interval: 25 },
      );
    } finally {
      await createCompanyGrants(db, administratorId, {
        principalKind: "user",
        principalId: userId,
        actions: ["assignments:read"],
        idempotencyKey: randomUUID(),
      });
    }
    expect(
      (
        await database.pool.query(
          "SELECT status FROM specialist_assignments WHERE id=$1",
          [revokedWork.assignment.id],
        )
      ).rows,
    ).toEqual([{ status: "active" }]);
    browserSession.user = null;
  } finally {
    browserSession.user = null;
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
    await worker.stop();
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    resetRegistrarStateForTests();
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
}, 90000);

it("IT-CBS-04 admits company webhook deliveries through the actual authenticated entry point and retains one native effect across token rotation", async () => {
  const db: Db = database.db;
  const supervisor = await startRealSupervisor({
    runtimeRoot: join(root, "company-webhook-host"),
    workspaceRoots: [join(root, "worktrees")],
    fixtureArgs: ["--hang"],
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const worker = startProjectionWorker({ db, projectors: canonicalProjectors });
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

  setDefaultTransportForTests(null);
  resetResolverForTests();
  resetRegistrarStateForTests();
  vi.stubEnv("MAISTER_MAX_CONCURRENT_AGENTS", "100");
  try {
    const agentId = "rah:webhook-observer";
    const effective = await resolveInstalledAgentDefinition(db, {
      agentId,
      packageInstallId: assignmentInput.standingDefinition.packageInstallId,
    });
    const runnerId = randomUUID();

    await db.insert(platformAcpRunners).values({
      id: runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "company-webhook-fixture",
      provider: { kind: "anthropic" },
      readinessStatus: "Ready",
    });
    const binding = await createCompanySpecialistBinding(db, userId, agentId, {
      owner: { kind: "company", companyId: request.companyId },
      packageInstallId: effective.packageInstallId,
      packageRevision: effective.resolvedRevision!,
      definitionSha256: agentDefinitionSha256(effective.parsed),
      enabled: true,
      configuration: {},
      grantActions: ["knowledge:read", "knowledge:propose"],
      runnerId,
      idempotencyKey: randomUUID(),
    });
    const { expectedResult: _expectedResult, ...objective } =
      assignmentInput.objectiveInput;
    const body = {
      schemaVersion: 1,
      assignment: {
        ...objective,
        owner: binding.specialist.owner,
        specialistBindingId: binding.specialist.bindingId,
        input: "Inspect the webhook's authorized configured target.",
      },
    };
    const contract: { components: { schemas: Record<string, object> } } = parse(
      await readFile(resolve("../docs/api/web.openapi.yaml"), "utf8"),
    );
    const validateWebhook = new Ajv({
      strict: false,
      validateFormats: false,
    }).compile({
      components: contract.components,
      ...contract.components.schemas.CBCompanyWebhookEnvelope,
    });

    expect(validateWebhook(body), JSON.stringify(validateWebhook.errors)).toBe(
      true,
    );
    expect(validateWebhook({ ...body, requester: userId })).toBe(false);
    const token = await issueUserAccessToken(
      {
        ownerUserId: userId,
        name: "company-webhook",
        scopes: ["agents:trigger", "assignments:submit"],
      },
      db,
    );
    const rotated = await issueUserAccessToken(
      {
        ownerUserId: userId,
        name: "company-webhook-rotated",
        scopes: ["agents:trigger", "assignments:submit"],
      },
      db,
    );
    const key = randomUUID();
    const submit = (
      secret: string | null,
      value: unknown = body,
      deliveryId: string | null = key,
    ): Promise<Response> =>
      inboundAgentEventPost(
        new NextRequest(
          "http://localhost/api/agents/rah:webhook-observer/event",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Maister-Owner-Kind": "company",
              ...(secret === null ? {} : { Authorization: `Bearer ${secret}` }),
              ...(deliveryId === null ? {} : { "Idempotency-Key": deliveryId }),
            },
            body: JSON.stringify(value),
          },
        ),
        { params: Promise.resolve({ agentId }) },
      );

    expect((await submit(null)).status).toBe(401);
    const responses = await Promise.all([
      submit(token.secret),
      submit(rotated.secret),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 201,
    ]);
    const assignments = await Promise.all(
      responses.map(async (response) => {
        expect(response.headers.get("cache-control")).toBe("private, no-store");

        return specialistAssignmentSchema.parse(await response.json());
      }),
    );

    expect(assignments[0].id).toBe(assignments[1].id);
    expect(assignments[0].runIds).toHaveLength(1);
    const runId = assignments[0].runIds[0]!;

    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query(
              "SELECT status,trigger_source,project_id,task_id,company_id FROM runs WHERE id=$1",
              [runId],
            )
          ).rows,
        ).toEqual([
          {
            status: "Done",
            trigger_source: "webhook",
            project_id: null,
            task_id: null,
            company_id: request.companyId,
          },
        ]);
      },
      { timeout: 30000, interval: 25 },
    );
    expect(
      (
        await database.pool.query(
          "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt') GROUP BY kind ORDER BY kind",
          [runId],
        )
      ).rows,
    ).toEqual([
      { kind: "session.create", count: 1 },
      { kind: "session.prompt", count: 1 },
    ]);
    expect(assignments[0]).toMatchObject({
      requester: { kind: "user", id: userId },
      origin: { kind: "webhook", deliveryId: key },
      destination: { kind: "inbox", userId },
    });
    expect((await submit(rotated.secret)).status).toBe(200);
    expect((await submit(token.secret, body, null)).status).toBe(422);
    expect(
      (await submit(token.secret, { ...body, requester: userId })).status,
    ).toBe(422);
    expect(
      (
        await submit(token.secret, {
          ...body,
          assignment: { ...body.assignment, input: "Changed delivery" },
        })
      ).status,
    ).toBe(409);
    const noTrigger = await issueUserAccessToken(
      {
        ownerUserId: userId,
        name: "company-webhook-no-trigger",
        scopes: ["assignments:submit"],
      },
      db,
    );

    expect((await submit(noTrigger.secret)).status).toBe(403);
    const noSubmit = await issueUserAccessToken(
      {
        ownerUserId: userId,
        name: "company-webhook-no-submit",
        scopes: ["agents:trigger"],
      },
      db,
    );

    expect((await submit(noSubmit.secret)).status).toBe(403);
    expect(
      (
        await submit(
          rotated.secret,
          {
            ...body,
            assignment: {
              ...body.assignment,
              specialistBindingId: randomUUID(),
            },
          },
          randomUUID(),
        )
      ).status,
    ).toBe(404);
    const oversized = { ...body, padding: "x".repeat(32769) };

    expect((await submit(token.secret, oversized)).status).toBe(413);
    await database.pool.query(
      "UPDATE project_tokens SET revoked_at=now() WHERE id=$1",
      [token.tokenId],
    );
    expect((await submit(token.secret)).status).toBe(401);
    expect((await submit(rotated.secret)).status).toBe(200);
    await database.pool.query(
      "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
    );
    const independentKey = randomUUID();
    const independentResponse = await submit(
      rotated.secret,
      body,
      independentKey,
    );

    expect(independentResponse.status).toBe(201);
    const independent = specialistAssignmentSchema.parse(
      await independentResponse.json(),
    );

    expect(independent.id).not.toBe(assignments[0].id);
    expect(independent.runIds).toHaveLength(1);
    const independentRun = independent.runIds[0]!;

    expect(
      (
        await database.pool.query(
          "SELECT status,(SELECT count(*)::int FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')) AS effects FROM runs WHERE id=$1",
          [independentRun],
        )
      ).rows,
    ).toEqual([{ status: "Pending", effects: 0 }]);
    await database.pool.query(
      "DELETE FROM execution_host_pressure WHERE execution_host_id IN (SELECT id FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL)",
    );
    expect((await submit(rotated.secret, body, independentKey)).status).toBe(
      200,
    );
    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query("SELECT status FROM runs WHERE id=$1", [
              independentRun,
            ])
          ).rows,
        ).toEqual([{ status: "Done" }]);
      },
      { timeout: 30000, interval: 25 },
    );
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM token_audit_log WHERE token_id=$1 AND endpoint='POST /api/agents/[agentId]/event'",
          [rotated.tokenId],
        )
      ).rows[0].count,
    ).toBeGreaterThanOrEqual(3);
    const currentRead = (
      await database.pool.query<{ id: string; revision: number }>(
        "SELECT id,revision FROM company_grants WHERE principal_type='user' AND principal_id=$1 AND company_id=$2 AND action='assignments:read' AND revoked_at IS NULL",
        [userId, request.companyId],
      )
    ).rows;

    expect(currentRead).toHaveLength(1);
    await revokeCompanyGrant(db, administratorId, currentRead[0].id, {
      expectedRevision: currentRead[0].revision,
      reason: "Withdraw webhook requester access before replay",
      idempotencyKey: randomUUID(),
    });
    try {
      expect((await submit(rotated.secret)).status).toBe(403);
    } finally {
      await createCompanyGrants(db, administratorId, {
        principalKind: "user",
        principalId: userId,
        actions: ["assignments:read"],
        idempotencyKey: randomUUID(),
      });
    }
  } finally {
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
    await worker.stop();
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    resetRegistrarStateForTests();
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
}, 90000);

it("IT-CBA-02 submits project specialist work through its actual attachment, original input and existing agent admission", async () => {
  const db: Db = database.db;
  const repo = await initRepo(join(root, "project-manual-repo"));
  const project = await seedProjectRow(database.db, { repoPath: repo });

  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), project.id, userId],
  );
  await attachPackage({
    projectId: project.id,
    projectSlug: project.slug,
    packageInstallId: assignmentInput.standingDefinition.packageInstallId,
    db,
  });
  const runnerId = randomUUID();

  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "project-manual-fixture",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  await db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId })
    .onConflictDoUpdate({
      target: platformRuntimeSettings.id,
      set: { defaultRunnerId: runnerId },
    });
  const link = await attachAgent(
    {
      projectId: project.id,
      agentId: "rah:wire-observer",
      runnerOverrideId: runnerId,
    },
    db,
  );
  const supervisor = await startRealSupervisor({
    runtimeRoot: join(root, "project-manual-host"),
    workspaceRoots: [join(root, "worktrees"), repo],
    fixtureArgs: ["--hang"],
  });
  const restoreUrl = useRealSupervisorUrl(supervisor.url);
  const worker = startProjectionWorker({ db, projectors: canonicalProjectors });

  setDefaultTransportForTests(null);
  resetResolverForTests();
  resetRegistrarStateForTests();
  try {
    browserSession.user = await requireActiveUserById(userId);
    const { expectedResult: _expectedResult, ...objective } =
      assignmentInput.objectiveInput;
    const value = {
      ...objective,
      owner: { kind: "project", projectId: project.id },
      specialistBindingId: link.linkId,
      input:
        "Project assignment literal input must survive the original launch.",
      idempotencyKey: randomUUID(),
    };
    const submit = (request: unknown = value): Promise<Response> =>
      assignmentPost(
        new NextRequest("http://localhost/api/specialist-assignments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        }),
      );

    const routedContract: { components: { schemas: Record<string, object> } } =
      parse(await readFile(resolve("../docs/api/web.openapi.yaml"), "utf8"));
    const validateRouted = new Ajv({
      strict: false,
      validateFormats: false,
    }).compile({
      components: routedContract.components,
      ...routedContract.components.schemas.CBProjectManualAssignmentEnvelope,
    });

    const submitRouted = (
      agentId: string,
      request: typeof value,
    ): Promise<Response> => {
      const {
        owner: _owner,
        specialistBindingId: _binding,
        idempotencyKey,
        ...assignment
      } = request;

      const envelope = { schemaVersion: 1, assignment, idempotencyKey };

      expect(
        validateRouted(envelope),
        JSON.stringify(validateRouted.errors),
      ).toBe(true);
      expect(validateRouted({ ...envelope, owner: value.owner })).toBe(false);

      return routedProjectLaunchPost(
        new NextRequest(
          `http://localhost/api/projects/${project.slug}/agents/${agentId}/launch`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              schemaVersion: 1,
              assignment,
              idempotencyKey,
            }),
          },
        ),
        { params: Promise.resolve({ slug: project.slug, agentId }) },
      );
    };

    await localHost({ db, transport: createLocalDirectTransport() });
    await database.pool.query(
      "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
    );
    const personalProjectToken = await issueUserAccessToken(
      {
        ownerUserId: userId,
        name: "project-specialist-manual",
        scopes: ["assignments:read", "assignments:submit"],
      },
      db,
    );
    const projectToken = await issueToken(
      {
        projectId: project.id,
        name: "project-specialist-no-human",
        scopes: ["assignments:read", "assignments:submit"],
        createdByUserId: userId,
      },
      db,
    );

    expect((await submitExternal(value, projectToken.secret)).status).toBe(403);
    const responses = await Promise.all([
      submit(),
      submitExternal(value, personalProjectToken.secret),
      submitRouted("rah:wire-observer", value),
    ]);

    expect(
      responses.map((item) => item.status).sort(),
      JSON.stringify(
        await Promise.all(
          responses.map(async (item) => ({
            status: item.status,
            body: await item.clone().json(),
          })),
        ),
      ),
    ).toEqual([200, 200, 201]);
    const response = responses.find((item) => item.status === 201)!;

    expect({
      status: response.status,
      body: await response.clone().json(),
    }).toMatchObject({ status: 201 });
    const assignment = specialistAssignmentSchema.parse(await response.json());

    expect(
      (await inspectExternal(assignment.id, projectToken.secret)).status,
    ).toBe(403);
    expect(
      (await inspectExternal(assignment.id, personalProjectToken.secret))
        .status,
    ).toBe(200);

    expect(assignment.owner).toEqual(value.owner);
    expect(assignment.runIds).toHaveLength(1);
    const runId = assignment.runIds[0]!;

    expect(
      (
        await database.pool.query("SELECT status FROM runs WHERE id=$1", [
          runId,
        ])
      ).rows,
    ).toEqual([{ status: "Pending" }]);
    const contextCredential = await issueAgentRunToken({
      db,
      projectId: project.id,
      agentId: "rah:wire-observer",
      runId,
    });

    await updateAgentLink(
      {
        projectId: project.id,
        agentId: "rah:wire-observer",
        patch: { canReadBrain: false, canWriteBrain: false },
      },
      db,
    );
    try {
      const readContext = () =>
        externalContextGet(
          new NextRequest(
            `http://localhost/api/v1/ext/specialist-assignments/${assignment.id}/context?revision=0`,
            {
              headers: { Authorization: `Bearer ${contextCredential.secret}` },
            },
          ),
          { params: Promise.resolve({ assignmentId: assignment.id }) },
        );
      const contextResponse = await readContext();

      expect(contextResponse.status).toBe(200);
      expect(await contextResponse.json()).toMatchObject({
        assignmentId: assignment.id,
        revision: 0,
        recording: "unrecorded",
        objective: value.objective,
        digest: null,
        createdAt: null,
      });
      const queuedWrite = await externalContextPatch(
        new NextRequest(
          `http://localhost/api/v1/ext/specialist-assignments/${assignment.id}/context`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${contextCredential.secret}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              expectedRevision: 0,
              expectedInputRevision: 1,
              idempotencyKey: randomUUID(),
              updates: [
                {
                  id: "queued-write",
                  kind: "decision",
                  text: "A queued agent cannot write as an active execution",
                  state: "open",
                  references: [],
                },
              ],
            }),
          },
        ),
        { params: Promise.resolve({ assignmentId: assignment.id }) },
      );

      expect(queuedWrite.status).toBe(403);
      expect(await queuedWrite.json()).toMatchObject({
        code: "UNAUTHORIZED",
        message: expect.stringContaining("current active execution"),
      });
      await database.pool.query(
        "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
        [project.id, userId],
      );
      expect((await readContext()).status).toBe(404);
    } finally {
      await database.pool.query(
        "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
        [project.id, userId],
      );
      await updateAgentLink(
        {
          projectId: project.id,
          agentId: "rah:wire-observer",
          patch: { canReadBrain: true, canWriteBrain: true },
        },
        db,
      );
      await revokeAgentRunToken(contextCredential.tokenId, db);
    }

    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
          [runId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    await database.pool.query("DELETE FROM execution_host_pressure");
    const resumedPending = await submit();

    expect(resumedPending.status).toBe(200);
    expect(
      specialistAssignmentSchema.parse(await resumedPending.json()).runIds,
    ).toEqual([runId]);
    await vi.waitFor(
      async () => {
        const [run] = await db.select().from(runs).where(eq(runs.id, runId));

        expect(run).toMatchObject({
          status: "Done",
          projectId: project.id,
          companyId: null,
          operationalCleanup: { state: "released" },
        });
      },
      { timeout: 30000, interval: 25 },
    );
    const input = await database.pool.query(
      "SELECT objective_input,actor FROM specialist_input_revisions WHERE assignment_id=$1 AND revision=1",
      [assignment.id],
    );

    expect(input.rows).toMatchObject([
      {
        objective_input: { input: value.input },
        actor: { kind: "user", id: userId },
      },
    ]);
    expect(
      JSON.stringify(
        (await readTranscriptPage(userId, runId, { limit: "20" })).messages,
      ),
    ).toContain(value.input);
    expect(
      await loadNativeInputForUser(database.db, userId, runId),
    ).toMatchObject({
      kind: "assignment_input",
      input: {
        assignmentId: assignment.id,
        revision: 1,
        snapshot: { objectiveInput: { input: value.input } },
      },
    });
    const replay = await submit();

    expect(replay.status).toBe(200);
    expect(
      specialistAssignmentSchema.parse(await replay.json()).runIds,
    ).toEqual([runId]);
    expect(
      (
        await database.pool.query(
          "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt') GROUP BY kind ORDER BY kind",
          [runId],
        )
      ).rows,
    ).toEqual([
      { kind: "session.create", count: 1 },
      { kind: "session.prompt", count: 1 },
    ]);
    const countsBeforeRefusals = (
      await database.pool.query(
        "SELECT (SELECT count(*) FROM specialist_assignments) AS assignments,(SELECT count(*) FROM specialist_intake_receipts) AS receipts,(SELECT count(*) FROM runs) AS runs",
      )
    ).rows;

    await database.pool.query(
      "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [project.id, userId],
    );
    try {
      expect((await submit()).status).toBe(403);
      expect((await submitRouted("rah:wire-observer", value)).status).toBe(403);
      expect(
        (await submitExternal(value, personalProjectToken.secret)).status,
      ).toBe(403);
    } finally {
      await database.pool.query(
        "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
        [project.id, userId],
      );
    }
    await database.pool.query(
      "UPDATE agent_project_links SET enabled=false WHERE id=$1",
      [link.linkId],
    );
    try {
      expect((await submit()).status).toBe(200);
      expect((await submitRouted("rah%3Awire-observer", value)).status).toBe(
        200,
      );
    } finally {
      await database.pool.query(
        "UPDATE agent_project_links SET enabled=true WHERE id=$1",
        [link.linkId],
      );
    }
    expect(
      (
        await database.pool.query(
          "SELECT (SELECT count(*) FROM specialist_assignments) AS assignments,(SELECT count(*) FROM specialist_intake_receipts) AS receipts,(SELECT count(*) FROM runs) AS runs",
        )
      ).rows,
    ).toEqual(countsBeforeRefusals);
    const mentionRevision = (
      await database.pool.query<{ schedules_revision: number }>(
        "SELECT schedules_revision FROM agent_project_links WHERE id=$1",
        [link.linkId],
      )
    ).rows[0]!.schedules_revision;

    browserSession.user = await requireActiveUserById(administratorId);
    const mentionConfiguration = await projectAgentPatch(
      new NextRequest(
        `http://localhost/api/projects/${project.slug}/agents/rah:wire-observer`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schedulesRevision: mentionRevision,
            schedules: [
              { triggerType: "mention", enabled: true },
              {
                triggerType: "cron",
                cronExpr: "* * * * *",
                timezone: "UTC",
                requestAtLaunch:
                  "Inspect the explicitly reviewed project target",
                reviewForAssignments: true,
                enabled: false,
              },
              {
                triggerType: "event",
                eventKinds: ["run.done"],
                reviewForAssignments: true,
                enabled: false,
              },
            ],
          }),
        },
      ),
      {
        params: Promise.resolve({
          slug: project.slug,
          agentId: "rah:wire-observer",
        }),
      },
    );

    expect(mentionConfiguration.status).toBe(200);
    const reviewedSources = (
      await database.pool.query<{
        trigger_type: string;
        project_source_review: {
          reviewerUserId: string;
          sourceRevision: number;
        } | null;
      }>(
        "SELECT trigger_type,project_source_review FROM agent_schedules WHERE project_id=$1 AND agent_id='rah:wire-observer' ORDER BY trigger_type",
        [project.id],
      )
    ).rows;

    expect(reviewedSources).toEqual([
      {
        trigger_type: "cron",
        project_source_review: expect.objectContaining({
          reviewerUserId: administratorId,
          sourceRevision: mentionRevision + 1,
        }),
      },
      {
        trigger_type: "event",
        project_source_review: expect.objectContaining({
          reviewerUserId: administratorId,
          sourceRevision: mentionRevision + 1,
        }),
      },
      { trigger_type: "mention", project_source_review: null },
    ]);
    const forgedReview = await projectAgentPatch(
      new NextRequest(
        `http://localhost/api/projects/${project.slug}/agents/rah:wire-observer`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schedulesRevision: mentionRevision + 1,
            schedules: [
              {
                triggerType: "event",
                eventKinds: ["run.done"],
                assignmentReview: reviewedSources[1]!.project_source_review,
              },
            ],
          }),
        },
      ),
      {
        params: Promise.resolve({
          slug: project.slug,
          agentId: "rah:wire-observer",
        }),
      },
    );

    expect(forgedReview.status).toBe(422);
    browserSession.user = await requireActiveUserById(userId);
    const commentTaskId = randomUUID();

    await database.pool.query(
      "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES($1,$2,9001,'Inspect component diagnostics','Inspect the authorized component without mutation')",
      [commentTaskId, project.id],
    );
    await ensureConsumerRows(db, DOMAIN_EVENT_CONSUMERS);
    await database.pool.query(
      "UPDATE domain_event_consumers SET cursor_event_id=(SELECT coalesce(max(id),0) FROM domain_events) WHERE consumer_id='agent_triggers'",
    );
    await database.pool.query(
      "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
    );
    const commentIds: string[] = [];

    for (const text of [
      "@rah:wire-observer Inspect the configured component state.",
      "@rah:wire-observer Independently inspect the configured diagnostic limits.",
    ]) {
      const response = await taskCommentPost(
        new NextRequest(
          `http://localhost/api/projects/${project.slug}/tasks/9001/comments`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: text }),
          },
        ),
        { params: Promise.resolve({ slug: project.slug, number: "9001" }) },
      );

      expect(response.status).toBe(201);
      const body: { comment: { id: string } } = await response.json();

      commentIds.push(body.comment.id);
      expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
    }
    const commentWork = (
      await database.pool.query<{
        id: string;
        run_id: string;
        origin: { kind: string; commentId: string };
        actor: { kind: string; id: string };
        objective_input: { input: string };
        source_body: string;
      }>(
        "SELECT assignment.id,link.run_id,assignment.origin,input.actor,input.objective_input,comment.body AS source_body FROM specialist_assignments assignment JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=1 JOIN specialist_run_links link ON link.assignment_id=assignment.id JOIN task_comments comment ON comment.id=assignment.origin->>'commentId' WHERE assignment.project_id=$1 AND assignment.origin->>'kind'='task_comment' AND assignment.origin->>'commentId'=ANY($2::text[]) ORDER BY comment.created_at,comment.id",
        [project.id, commentIds],
      )
    ).rows;

    expect(commentWork).toHaveLength(2);
    for (const work of commentWork) {
      expect(work.origin).toMatchObject({
        kind: "task_comment",
        projectId: project.id,
        taskId: commentTaskId,
      });
      expect(work.actor).toMatchObject({ kind: "user", id: userId });
      expect(work.objective_input.input).toBe(work.source_body);
      expect(
        (
          await database.pool.query(
            "SELECT status,(SELECT count(*)::int FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')) AS effects FROM runs WHERE id=$1",
            [work.run_id],
          )
        ).rows,
      ).toEqual([{ status: "Pending", effects: 0 }]);
    }
    await database.pool.query(
      "DELETE FROM execution_host_pressure WHERE execution_host_id IN (SELECT id FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL)",
    );
    await database.pool.query(
      "UPDATE scheduler_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE id='agent_tick.dispatcher'",
    );
    expect(await runSchedulerTick({ jobKind: "agent_tick" })).toMatchObject({
      succeededCount: 1,
      failedCount: 0,
    });
    for (const work of commentWork) {
      await vi.waitFor(
        async () => {
          expect(
            (
              await database.pool.query("SELECT status FROM runs WHERE id=$1", [
                work.run_id,
              ])
            ).rows,
          ).toEqual([{ status: "Done" }]);
        },
        { timeout: 30000, interval: 25 },
      );
      expect(
        (
          await database.pool.query(
            "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt') GROUP BY kind ORDER BY kind",
            [work.run_id],
          )
        ).rows,
      ).toEqual([
        { kind: "session.create", count: 1 },
        { kind: "session.prompt", count: 1 },
      ]);
    }
    const queuedRequest = {
      ...value,
      idempotencyKey: randomUUID(),
      objective:
        "Preserve independent work while its selected runner is unavailable",
    };

    await database.pool.query(
      "UPDATE platform_acp_runners SET enabled=false WHERE id=$1",
      [runnerId],
    );
    try {
      expect((await submit(queuedRequest)).status).toBe(503);
    } finally {
      await database.pool.query(
        "UPDATE platform_acp_runners SET enabled=true WHERE id=$1",
        [runnerId],
      );
    }
    const queued = (
      await database.pool.query<{
        id: string;
        status: string;
        run_count: number;
      }>(
        "SELECT assignment.id,assignment.status,(SELECT count(*)::int FROM specialist_run_links link WHERE link.assignment_id=assignment.id) AS run_count FROM specialist_assignments assignment JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=1 WHERE assignment.project_id=$1 AND input.objective_input->>'objective'=$2",
        [project.id, queuedRequest.objective],
      )
    ).rows;

    expect(queued).toMatchObject([{ status: "queued", run_count: 0 }]);
    expect(queued).toHaveLength(1);
    const resumed = await submit(queuedRequest);

    expect(resumed.status).toBe(200);
    const retained = specialistAssignmentSchema.parse(await resumed.json());

    expect(retained.id).toBe(queued[0]!.id);
    expect(retained.id).not.toBe(assignment.id);
    expect(retained.inputRevision).toBe(1);
    expect(retained.runIds).toHaveLength(1);
    await vi.waitFor(
      async () => {
        const [completed] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, retained.runIds[0]!));

        expect(completed).toMatchObject({
          status: "Done",
          operationalCleanup: { state: "released" },
        });
      },
      { timeout: 30000, interval: 25 },
    );
    const coordinatorProvider = (
      await database.pool.query(
        "SELECT enabled_revision_id FROM flows WHERE project_id=$1 AND flow_ref_id='rah-control'",
        [project.id],
      )
    ).rows[0];

    await enableRevision({
      projectId: project.id,
      flowRefId: "rah-control",
      revisionId: coordinatorProvider.enabled_revision_id,
      db,
    });
    const coordinator = await attachAgent(
      {
        projectId: project.id,
        agentId: "rah:flow-coordinator",
        runnerOverrideId: runnerId,
      },
      db,
    );
    const flowRequest = {
      ...value,
      specialistBindingId: coordinator.linkId,
      idempotencyKey: randomUUID(),
      objective: "Coordinate the original project evidence request",
      input:
        "PRIVATE PROJECT FLOW REQUEST\nInspect this original assignment input.",
    };
    const coordinatedResponses = await Promise.all([
      submit(flowRequest),
      submitRouted("rah:flow-coordinator", flowRequest),
    ]);

    expect(
      coordinatedResponses.map((response) => response.status).sort(),
    ).toEqual([200, 201]);
    const coordinatedResponse = coordinatedResponses.find(
      (response) => response.status === 201,
    )!;

    expect({
      status: coordinatedResponse.status,
      body: await coordinatedResponse.clone().json(),
    }).toMatchObject({
      status: 201,
      body: expect.objectContaining({ id: expect.any(String) }),
    });
    const coordinated = specialistAssignmentSchema.parse(
      await coordinatedResponse.json(),
    );

    expect(coordinated.runIds).toHaveLength(1);
    const coordinatedRunId = coordinated.runIds[0]!;

    await vi.waitFor(
      async () => {
        const [completed] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, coordinatedRunId));

        expect(completed).toMatchObject({
          status: "Done",
          runKind: "flow",
          projectId: project.id,
          companyId: null,
        });
      },
      { timeout: 30000, interval: 25 },
    );
    const [coordinatedRun] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, coordinatedRunId));

    expect(
      await loadNativeInputForUser(database.db, userId, coordinatedRunId),
    ).toMatchObject({
      kind: "assignment_input",
      input: {
        assignmentId: coordinated.id,
        revision: 1,
        snapshot: {
          standingDefinition: {
            schemaVersion: 2,
            coordinatorFlow: { flowRevisionId: coordinatedRun!.flowRevisionId },
          },
        },
      },
    });
    expect(
      (
        await database.pool.query("SELECT prompt FROM tasks WHERE id=$1", [
          coordinatedRun!.taskId,
        ])
      ).rows,
    ).toEqual([{ prompt: "rah:flow-coordinator" }]);
    expect(
      JSON.stringify(
        (
          await readTranscriptPage(userId, coordinatedRunId, {
            node: "research",
            limit: "20",
          })
        ).messages,
      ),
    ).toContain("PRIVATE PROJECT FLOW REQUEST");
    expect(
      (
        await database.pool.query(
          "SELECT project_task_id FROM specialist_assignments WHERE id=$1",
          [coordinated.id],
        )
      ).rows,
    ).toEqual([{ project_task_id: coordinatedRun!.taskId }]);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM tasks WHERE project_id=$1 AND agent_id='rah:flow-coordinator'",
          [project.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    await expect(
      database.pool.query(
        "UPDATE specialist_assignments SET project_task_id=NULL,revision=revision+1 WHERE id=$1",
        [coordinated.id],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "specialist_assignments_project_task_immutable",
    });
    const coordinatorMentionRevision = (
      await database.pool.query<{ schedules_revision: number }>(
        "SELECT schedules_revision FROM agent_project_links WHERE id=$1",
        [coordinator.linkId],
      )
    ).rows[0]!.schedules_revision;

    browserSession.user = await requireActiveUserById(administratorId);
    const coordinatorMention = await projectAgentPatch(
      new NextRequest(
        `http://localhost/api/projects/${project.slug}/agents/rah:flow-coordinator`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schedulesRevision: coordinatorMentionRevision,
            schedules: [{ triggerType: "mention", enabled: true }],
          }),
        },
      ),
      {
        params: Promise.resolve({
          slug: project.slug,
          agentId: "rah:flow-coordinator",
        }),
      },
    );

    expect(coordinatorMention.status).toBe(200);
    browserSession.user = await requireActiveUserById(userId);
    const coordinatorCommentResponse = await taskCommentPost(
      new NextRequest(
        `http://localhost/api/projects/${project.slug}/tasks/9001/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: "@rah:flow-coordinator Coordinate an independent evidence-linked diagnostic result.",
          }),
        },
      ),
      { params: Promise.resolve({ slug: project.slug, number: "9001" }) },
    );

    expect(coordinatorCommentResponse.status).toBe(201);
    const coordinatorComment: { comment: { id: string } } =
      await coordinatorCommentResponse.json();
    const coordinatorEvent = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM domain_events WHERE project_id=$1 AND kind='task.comment_added' AND payload->>'commentId'=$2",
        [project.id, coordinatorComment.comment.id],
      )
    ).rows[0]!;
    const coordinatorSource = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM agent_schedules WHERE project_id=$1 AND agent_id='rah:flow-coordinator' AND trigger_type='mention'",
        [project.id],
      )
    ).rows[0]!;
    const rollbackAppointmentProbe = new Error(
      "Rollback owned comment source qualification",
    );

    await expect(
      db.transaction(async (tx) => {
        const claim = await claimEventAgentAttempt(
          tx,
          coordinatorSource.id,
          new Date(),
          Number(coordinatorEvent.id),
        );

        expect(claim).not.toBeNull();
        const appointment = {
          schemaVersion: 1 as const,
          kind: "task_comment" as const,
          attemptId: claim!.id,
          scheduleId: claim!.scheduleId,
          runId: claim!.reservedRunId,
          eventId: Number(coordinatorEvent.id),
        };

        expect(
          await loadProjectCommentAppointment(tx, appointment),
        ).toMatchObject({
          projectId: project.id,
          taskId: commentTaskId,
          commentId: coordinatorComment.comment.id,
          userId,
        });
        await expect(
          loadProjectCommentAppointment(tx, {
            ...appointment,
            runId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: "PRECONDITION" });
        await tx.execute(
          sql`UPDATE agent_schedules SET cron_expr='owned-selector-change' WHERE id=${coordinatorSource.id}`,
        );
        await expect(
          loadProjectCommentAppointment(tx, appointment),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          details: { reason: "project_comment_source_changed" },
        });
        throw rollbackAppointmentProbe;
      }),
    ).rejects.toBe(rollbackAppointmentProbe);
    expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
    const coordinatorCommentWork = (
      await database.pool.query<{
        id: string;
        run_id: string;
        reserved_run_id: string;
        status: string;
        origin: { commentId: string };
      }>(
        "SELECT assignment.id,link.run_id,invocation.reserved_run_id,assignment.status,assignment.origin FROM specialist_assignments assignment JOIN specialist_run_links link ON link.assignment_id=assignment.id JOIN agent_trigger_attempts invocation ON invocation.run_id=link.run_id WHERE assignment.project_id=$1 AND assignment.origin->>'commentId'=$2",
        [project.id, coordinatorComment.comment.id],
      )
    ).rows;

    expect(coordinatorCommentWork).toHaveLength(1);
    expect(coordinatorCommentWork[0].run_id).toBe(
      coordinatorCommentWork[0].reserved_run_id,
    );
    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query(
              "SELECT status,run_kind,trigger_source,trigger_event_id,agent_schedule_id FROM runs WHERE id=$1",
              [coordinatorCommentWork[0].run_id],
            )
          ).rows,
        ).toEqual([
          {
            status: "Done",
            run_kind: "flow",
            trigger_source: "domain_event",
            trigger_event_id: coordinatorEvent.id,
            agent_schedule_id: coordinatorSource.id,
          },
        ]);
      },
      { timeout: 30000, interval: 25 },
    );
    expect(
      (
        await database.pool.query(
          "SELECT validity FROM run_results WHERE run_id=$1",
          [coordinatorCommentWork[0].run_id],
        )
      ).rows,
    ).toEqual([{ validity: "valid" }]);
    const firstCommentEvent = (
      await database.pool.query<{ id: string }>(
        "SELECT min(id)::text AS id FROM domain_events WHERE project_id=$1 AND kind='task.comment_added' AND payload->>'commentId'=ANY($2::text[])",
        [project.id, commentIds],
      )
    ).rows[0]!;

    await database.pool.query(
      "UPDATE domain_event_consumers SET cursor_event_id=$1::bigint-1 WHERE consumer_id='agent_triggers'",
      [firstCommentEvent.id],
    );
    expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM specialist_assignments WHERE project_id=$1 AND origin->>'kind'='task_comment'",
          [project.id],
        )
      ).rows,
    ).toEqual([{ count: 3 }]);
    for (const runId of [
      ...commentWork.map((work) => work.run_id),
      coordinatorCommentWork[0].run_id,
    ])
      expect(
        (
          await database.pool.query(
            "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt') GROUP BY kind ORDER BY kind",
            [runId],
          )
        ).rows,
      ).toEqual([
        { kind: "session.create", count: 1 },
        { kind: "session.prompt", count: 1 },
      ]);
    const deniedCommentResponse = await taskCommentPost(
      new NextRequest(
        `http://localhost/api/projects/${project.slug}/tasks/9001/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: "@rah:wire-observer Inspect a request whose author loses launch authority before dispatch.",
          }),
        },
      ),
      { params: Promise.resolve({ slug: project.slug, number: "9001" }) },
    );

    expect(deniedCommentResponse.status).toBe(201);
    const deniedComment: { comment: { id: string } } =
      await deniedCommentResponse.json();

    await database.pool.query(
      "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [project.id, userId],
    );
    try {
      expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM specialist_assignments WHERE project_id=$1 AND origin->>'commentId'=$2",
            [project.id, deniedComment.comment.id],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        (
          await database.pool.query(
            "SELECT invocation.outcome,invocation.reason_code,invocation.run_id FROM agent_trigger_attempts invocation JOIN domain_events event ON event.id=invocation.trigger_event_id WHERE event.project_id=$1 AND event.payload->>'commentId'=$2",
            [project.id, deniedComment.comment.id],
          )
        ).rows,
      ).toEqual([
        { outcome: "refused", reason_code: "UNAUTHORIZED", run_id: null },
      ]);
    } finally {
      await database.pool.query(
        "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
        [project.id, userId],
      );
    }
    const oversizedCommentResponse = await taskCommentPost(
      new NextRequest(
        `http://localhost/api/projects/${project.slug}/tasks/9001/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: "@rah:wire-observer " + "x".repeat(8100),
          }),
        },
      ),
      { params: Promise.resolve({ slug: project.slug, number: "9001" }) },
    );

    expect(oversizedCommentResponse.status).toBe(201);
    const oversizedComment: { comment: { id: string } } =
      await oversizedCommentResponse.json();

    expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM specialist_assignments WHERE project_id=$1 AND origin->>'commentId'=$2",
          [project.id, oversizedComment.comment.id],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await database.pool.query(
          "SELECT invocation.outcome,invocation.reason_code,invocation.run_id FROM agent_trigger_attempts invocation JOIN domain_events event ON event.id=invocation.trigger_event_id WHERE event.project_id=$1 AND event.payload->>'commentId'=$2",
          [project.id, oversizedComment.comment.id],
        )
      ).rows,
    ).toEqual([
      {
        outcome: "refused",
        reason_code: "project_comment_input_too_large",
        run_id: null,
      },
    ]);
    const deferredFlowRequest = {
      ...flowRequest,
      idempotencyKey: randomUUID(),
      objective: "Retain coordinator work during a runner outage",
    };

    await db
      .update(platformAcpRunners)
      .set({ enabled: false })
      .where(eq(platformAcpRunners.id, runnerId));
    expect((await submit(deferredFlowRequest)).status).toBe(503);
    const deferredCoordinator = (
      await database.pool.query(
        "SELECT assignment.id,assignment.revision,assignment.input_revision,assignment.project_task_id FROM specialist_assignments assignment JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=1 WHERE assignment.project_id=$1 AND input.objective_input->>'objective'=$2",
        [project.id, deferredFlowRequest.objective],
      )
    ).rows;

    expect(deferredCoordinator).toHaveLength(1);
    expect(deferredCoordinator[0]).toMatchObject({ input_revision: 1 });
    expect(
      (
        await database.pool.query(
          "SELECT run_id FROM specialist_run_links WHERE assignment_id=$1",
          [deferredCoordinator[0].id],
        )
      ).rows,
    ).toEqual([]);
    await database.pool.query(
      "UPDATE flows SET enablement_state='Disabled' WHERE id=$1",
      [coordinatedRun!.flowId],
    );
    await db
      .update(platformAcpRunners)
      .set({ enabled: true })
      .where(eq(platformAcpRunners.id, runnerId));
    expect((await submit(deferredFlowRequest)).status).toBe(409);
    await enableRevision({
      projectId: project.id,
      flowRefId: "rah-control",
      revisionId: coordinatedRun!.flowRevisionId!,
      db,
    });
    const resumedCoordinatorResponse = await submit(deferredFlowRequest);

    expect(resumedCoordinatorResponse.status).toBe(200);
    const resumedCoordinator = specialistAssignmentSchema.parse(
      await resumedCoordinatorResponse.json(),
    );

    expect(resumedCoordinator.id).toBe(deferredCoordinator[0].id);
    expect(resumedCoordinator.inputRevision).toBe(1);
    expect(resumedCoordinator.runIds).toHaveLength(1);
    await vi.waitFor(
      async () => {
        const [retained] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, resumedCoordinator.runIds[0]!));

        expect(retained.status).toBe("Done");
      },
      { timeout: 30000, interval: 25 },
    );
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM tasks WHERE project_id=$1 AND agent_id='rah:flow-coordinator'",
          [project.id],
        )
      ).rows,
    ).toEqual([{ count: 3 }]);
    expect((await submit(flowRequest)).status).toBe(200);
    expect(
      (
        await database.pool.query(
          "SELECT status FROM specialist_assignments WHERE id=$1",
          [coordinated.id],
        )
      ).rows,
    ).toEqual([{ status: "active" }]);
    const cronSource = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM agent_schedules WHERE project_id=$1 AND agent_id='rah:wire-observer' AND trigger_type='cron'",
        [project.id],
      )
    ).rows[0]!;
    const sourceRevision = (
      await database.pool.query<{ schedules_revision: number }>(
        "SELECT schedules_revision FROM agent_project_links WHERE id=$1",
        [link.linkId],
      )
    ).rows[0]!.schedules_revision;
    const cronText =
      "Inspect the exact reviewed project recurring request.\nKeep original evidence and unknowns 😀";

    browserSession.user = await requireActiveUserById(administratorId);
    const enableCron = await projectAgentPatch(
      new NextRequest(
        `http://localhost/api/projects/${project.slug}/agents/rah:wire-observer`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schedulesRevision: sourceRevision,
            schedules: [
              {
                id: cronSource.id,
                triggerType: "cron",
                cronExpr: "*/5 * * * *",
                timezone: "UTC",
                requestAtLaunch: cronText,
                reviewForAssignments: true,
                enabled: true,
              },
            ],
          }),
        },
      ),
      {
        params: Promise.resolve({
          slug: project.slug,
          agentId: "rah:wire-observer",
        }),
      },
    );

    expect(enableCron.status).toBe(200);
    await database.pool.query(
      "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
    );
    let nativeCronRunId: string;

    try {
      await database.pool.query(
        "UPDATE agent_schedules SET next_fire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [cronSource.id],
      );
      await database.pool.query(
        "UPDATE scheduler_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE id='agent_tick.dispatcher'",
      );
      expect(await runSchedulerTick({ jobKind: "agent_tick" })).toMatchObject({
        succeededCount: 1,
        failedCount: 0,
      });
      const work = (
        await database.pool.query<{
          id: string;
          run_id: string;
          reserved_run_id: string;
          binding_snapshot: {
            version: number;
            review: { reviewerUserId: string };
          };
          scheduled_request_snapshot: unknown;
          actor: { kind: string; id: string };
          scheduled_request: unknown;
          status: string;
        }>(
          "SELECT assignment.id,link.run_id,invocation.reserved_run_id,invocation.binding_snapshot,invocation.scheduled_request_snapshot,input.actor,input.scheduled_request,run.status FROM specialist_assignments assignment JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=1 JOIN specialist_run_links link ON link.assignment_id=assignment.id JOIN runs run ON run.id=link.run_id JOIN agent_trigger_attempts invocation ON invocation.id=assignment.origin->>'triggerAttemptId' WHERE assignment.project_id=$1 AND assignment.origin->>'kind'='schedule' AND assignment.origin->>'scheduleId'=$2",
          [project.id, cronSource.id],
        )
      ).rows;

      expect(work).toHaveLength(1);
      nativeCronRunId = work[0]!.run_id;
      expect(work[0]).toMatchObject({
        reserved_run_id: nativeCronRunId,
        status: "Pending",
        actor: { kind: "user", id: administratorId },
        binding_snapshot: {
          version: 3,
          review: { reviewerUserId: administratorId },
        },
      });
      expect(work[0]!.scheduled_request).toEqual(
        work[0]!.scheduled_request_snapshot,
      );
      expect(work[0]!.scheduled_request).toMatchObject({
        version: 1,
        requestAtLaunch: cronText,
      });
      expect(
        (
          await database.pool.query(
            "SELECT id FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
            [nativeCronRunId],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await database.pool.query("DELETE FROM execution_host_pressure");
    }
    await database.pool.query(
      "UPDATE scheduler_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE id='agent_tick.dispatcher'",
    );
    expect(await runSchedulerTick({ jobKind: "agent_tick" })).toMatchObject({
      succeededCount: 1,
      failedCount: 0,
    });
    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query("SELECT status FROM runs WHERE id=$1", [
              nativeCronRunId,
            ])
          ).rows,
        ).toEqual([{ status: "Done" }]);
      },
      { timeout: 30000, interval: 25 },
    );
    expect(
      (
        await database.pool.query(
          "SELECT validity FROM run_results WHERE run_id=$1",
          [nativeCronRunId],
        )
      ).rows,
    ).toEqual([{ validity: "valid" }]);
    expect(
      (
        await database.pool.query(
          "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt') GROUP BY kind ORDER BY kind",
          [nativeCronRunId],
        )
      ).rows,
    ).toEqual([
      { kind: "session.create", count: 1 },
      { kind: "session.prompt", count: 1 },
    ]);
    const forgedAttemptId = randomUUID();

    await expect(
      database.pool.query(
        `INSERT INTO agent_trigger_attempts
      SELECT (jsonb_populate_record(NULL::agent_trigger_attempts,to_jsonb(original)||jsonb_build_object(
        'id',$2::text,'reserved_run_id',$3::text,'delivery_key',$4::text,
        'binding_snapshot',jsonb_set(original.binding_snapshot,'{review,reviewerUserId}',to_jsonb($5::text)),
        'scheduled_request_snapshot',jsonb_set(original.scheduled_request_snapshot,'{triggerAttemptId}',to_jsonb($2::text))
      ))).* FROM agent_trigger_attempts original WHERE original.reserved_run_id=$1`,
        [
          nativeCronRunId,
          forgedAttemptId,
          randomUUID(),
          `forged:${forgedAttemptId}`,
          userId,
        ],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "agent_trigger_project_review_reference",
    });
    const fireCron = async (scheduleId: string): Promise<void> => {
      await database.pool.query(
        "UPDATE agent_schedules SET next_fire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [scheduleId],
      );
      await database.pool.query(
        "UPDATE scheduler_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE id='agent_tick.dispatcher'",
      );
      expect(await runSchedulerTick({ jobKind: "agent_tick" })).toMatchObject({
        succeededCount: 1,
        failedCount: 0,
      });
    };

    await database.pool.query(
      "UPDATE agent_schedules SET next_fire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [cronSource.id],
    );
    const interruptedCron = await claimCronAgentAttempt(
      db,
      cronSource.id,
      new Date(),
      new Date(Date.now() + 300000),
    );

    if (!interruptedCron)
      throw new Error("Owned interrupted native cron claim was unavailable");
    assertProjectAgentTriggerClaim(interruptedCron);
    const cronAppointment = {
      schemaVersion: 1 as const,
      kind: "cron" as const,
      attemptId: interruptedCron.id,
      scheduleId: cronSource.id,
      runId: interruptedCron.reservedRunId,
    };
    const rollbackCronProbe = new Error(
      "Rollback owned cron source qualification",
    );

    await expect(
      db.transaction(async (tx) => {
        expect(
          await loadProjectCronAppointment(tx, cronAppointment),
        ).toMatchObject({
          projectId: project.id,
          userId: administratorId,
          scheduledRequest: { requestAtLaunch: cronText },
        });
        await expect(
          loadProjectCronAppointment(tx, {
            ...cronAppointment,
            runId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: "PRECONDITION" });
        await tx.execute(
          sql`UPDATE agent_schedules SET request_at_launch='changed after review' WHERE id=${cronSource.id}`,
        );
        await expect(
          loadProjectCronAppointment(tx, cronAppointment),
        ).rejects.toMatchObject({
          code: "CONFIG",
          details: { reason: "project_source_review_changed" },
        });
        throw rollbackCronProbe;
      }),
    ).rejects.toBe(rollbackCronProbe);
    await database.pool.query(
      "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
    );
    try {
      const concurrent = await Promise.all([
        submitProjectCronAssignment(db, interruptedCron),
        submitProjectCronAssignment(db, interruptedCron),
      ]);

      expect(
        new Set(concurrent.map((receipt) => receipt.assignment.id)).size,
      ).toBe(1);
      expect(
        concurrent.every(
          (receipt) =>
            receipt.assignment.runIds.length === 1 &&
            receipt.assignment.runIds[0] === interruptedCron.reservedRunId,
        ),
      ).toBe(true);
      await database.pool.query(
        "UPDATE agent_trigger_attempts SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [interruptedCron.id],
      );
      expect(await reconcileAgentTriggerAttempts(db, new Date())).toEqual({
        adopted: 1,
        unknown: 0,
      });
      expect(
        (
          await database.pool.query(
            "SELECT outcome,run_id FROM agent_trigger_attempts WHERE id=$1",
            [interruptedCron.id],
          )
        ).rows,
      ).toEqual([{ outcome: "queued", run_id: interruptedCron.reservedRunId }]);
      expect(
        (
          await database.pool.query(
            "SELECT id FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
            [interruptedCron.reservedRunId],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await database.pool.query("DELETE FROM execution_host_pressure");
    }
    await database.pool.query(
      "UPDATE scheduler_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE id='agent_tick.dispatcher'",
    );
    expect(await runSchedulerTick({ jobKind: "agent_tick" })).toMatchObject({
      succeededCount: 1,
      failedCount: 0,
    });
    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query("SELECT status FROM runs WHERE id=$1", [
              interruptedCron.reservedRunId,
            ])
          ).rows,
        ).toEqual([{ status: "Done" }]);
      },
      { timeout: 30000, interval: 25 },
    );
    expect(
      (
        await database.pool.query(
          "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt') GROUP BY kind ORDER BY kind",
          [interruptedCron.reservedRunId],
        )
      ).rows,
    ).toEqual([
      { kind: "session.create", count: 1 },
      { kind: "session.prompt", count: 1 },
    ]);

    const beforeCronRefusals = (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM specialist_assignments WHERE project_id=$1 AND origin->>'kind'='schedule'",
        [project.id],
      )
    ).rows;

    await database.pool.query("UPDATE users SET role='viewer' WHERE id=$1", [
      administratorId,
    ]);
    try {
      await fireCron(cronSource.id);
      expect(
        (
          await database.pool.query(
            "SELECT outcome,reason_code,run_id FROM agent_trigger_attempts WHERE schedule_id=$1 ORDER BY fence DESC LIMIT 1",
            [cronSource.id],
          )
        ).rows,
      ).toEqual([
        { outcome: "refused", reason_code: "UNAUTHORIZED", run_id: null },
      ]);
    } finally {
      await database.pool.query("UPDATE users SET role='admin' WHERE id=$1", [
        administratorId,
      ]);
    }
    await database.pool.query(
      "UPDATE agent_schedules SET project_source_review=NULL WHERE id=$1",
      [cronSource.id],
    );
    await fireCron(cronSource.id);
    expect(
      (
        await database.pool.query(
          "SELECT outcome,reason_code,run_id FROM agent_trigger_attempts WHERE schedule_id=$1 ORDER BY fence DESC LIMIT 1",
          [cronSource.id],
        )
      ).rows,
    ).toEqual([
      {
        outcome: "refused",
        reason_code: "project_source_review_required",
        run_id: null,
      },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM specialist_assignments WHERE project_id=$1 AND origin->>'kind'='schedule'",
          [project.id],
        )
      ).rows,
    ).toEqual(beforeCronRefusals);
    const saveProjectSchedules = async (
      agentId: string,
      schedules: AgentScheduleInput[],
    ): Promise<Response> => {
      const revision = (
        await database.pool.query<{ schedules_revision: number }>(
          "SELECT schedules_revision FROM agent_project_links WHERE project_id=$1 AND agent_id=$2",
          [project.id, agentId],
        )
      ).rows[0]!.schedules_revision;

      return projectAgentPatch(
        new NextRequest(
          `http://localhost/api/projects/${project.slug}/agents/${agentId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ schedulesRevision: revision, schedules }),
          },
        ),
        { params: Promise.resolve({ slug: project.slug, agentId }) },
      );
    };

    expect(
      (
        await saveProjectSchedules("rah:wire-observer", [
          {
            id: cronSource.id,
            triggerType: "cron",
            cronExpr: "*/5 * * * *",
            timezone: "UTC",
            requestAtLaunch: null,
            reviewForAssignments: true,
            enabled: true,
          },
        ])
      ).status,
    ).toBe(200);
    await fireCron(cronSource.id);
    expect(
      (
        await database.pool.query(
          "SELECT outcome,reason_code,run_id FROM agent_trigger_attempts WHERE schedule_id=$1 ORDER BY fence DESC LIMIT 1",
          [cronSource.id],
        )
      ).rows,
    ).toEqual([
      {
        outcome: "refused",
        reason_code: "project_scheduled_request_missing",
        run_id: null,
      },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM specialist_assignments WHERE project_id=$1 AND origin->>'kind'='schedule'",
          [project.id],
        )
      ).rows,
    ).toEqual(beforeCronRefusals);
    expect(
      (
        await saveProjectSchedules("rah:flow-coordinator", [
          {
            triggerType: "cron",
            cronExpr: "*/5 * * * *",
            timezone: "UTC",
            requestAtLaunch:
              "Coordinate the exact reviewed project cron diagnosis.",
            reviewForAssignments: true,
            enabled: true,
          },
        ])
      ).status,
    ).toBe(200);
    const flowCronSource = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM agent_schedules WHERE project_id=$1 AND agent_id='rah:flow-coordinator' AND trigger_type='cron'",
        [project.id],
      )
    ).rows[0]!;

    await fireCron(flowCronSource.id);
    const flowCron = (
      await database.pool.query<{
        id: string;
        run_id: string;
        reserved_run_id: string;
      }>(
        "SELECT assignment.id,link.run_id,invocation.reserved_run_id FROM specialist_assignments assignment JOIN specialist_run_links link ON link.assignment_id=assignment.id JOIN agent_trigger_attempts invocation ON invocation.id=assignment.origin->>'triggerAttemptId' WHERE assignment.project_id=$1 AND assignment.origin->>'kind'='schedule' AND assignment.origin->>'scheduleId'=$2",
        [project.id, flowCronSource.id],
      )
    ).rows;

    expect(flowCron).toHaveLength(1);
    expect(flowCron[0]!.run_id).toBe(flowCron[0]!.reserved_run_id);
    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query(
              "SELECT status,run_kind FROM runs WHERE id=$1",
              [flowCron[0]!.run_id],
            )
          ).rows,
        ).toEqual([{ status: "Done", run_kind: "flow" }]);
      },
      { timeout: 30000, interval: 25 },
    );
    expect(
      (
        await database.pool.query(
          "SELECT validity FROM run_results WHERE run_id=$1",
          [flowCron[0]!.run_id],
        )
      ).rows,
    ).toEqual([{ validity: "valid" }]);
    expect(
      (
        await database.pool.query(
          "SELECT status FROM specialist_assignments WHERE id=$1",
          [flowCron[0]!.id],
        )
      ).rows,
    ).toEqual([{ status: "active" }]);
    expect(
      (
        await saveProjectSchedules("rah:wire-observer", [
          {
            triggerType: "event",
            eventKinds: ["run.done"],
            enabled: true,
            reviewForAssignments: true,
            shareEventContext: true,
          },
        ])
      ).status,
    ).toBe(200);
    const eventSource = (
      await database.pool.query<{ id: string }>(
        "SELECT id FROM agent_schedules WHERE project_id=$1 AND agent_id='rah:wire-observer' AND trigger_type='event'",
        [project.id],
      )
    ).rows[0]!;

    await database.pool.query(
      "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
    );
    try {
      expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM specialist_assignments WHERE project_id=$1 AND origin->>'kind'='event'",
            [project.id],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      await database.pool.query("DELETE FROM execution_host_pressure");
    }
    await fireCron(flowCronSource.id);
    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query(
              "SELECT count(*)::int AS count FROM runs WHERE project_id=$1 AND agent_schedule_id=$2 AND status='Done'",
              [project.id, flowCronSource.id],
            )
          ).rows,
        ).toEqual([{ count: 2 }]);
      },
      { timeout: 30000, interval: 25 },
    );
    await database.pool.query(
      "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
    );
    let eventRunId: string;

    try {
      expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
      const eventWork = (
        await database.pool.query<{
          run_id: string;
          reserved_run_id: string;
          status: string;
          agent_chain_depth: number;
          source_run_id: string;
          knowledge_access: { restrictions: unknown[] };
        }>(
          "SELECT link.run_id,invocation.reserved_run_id,run.status,run.agent_chain_depth,event.run_id AS source_run_id,run.knowledge_access FROM specialist_assignments work JOIN specialist_run_links link ON link.assignment_id=work.id JOIN runs run ON run.id=link.run_id JOIN agent_trigger_attempts invocation ON invocation.reserved_run_id=run.id JOIN domain_events event ON event.id=invocation.trigger_event_id WHERE work.project_id=$1 AND work.origin->>'kind'='event' AND work.origin->>'subscriptionId'=$2",
          [project.id, eventSource.id],
        )
      ).rows;

      expect(eventWork).toHaveLength(1);
      eventRunId = eventWork[0]!.run_id;
      expect(eventWork[0]).toMatchObject({
        reserved_run_id: eventRunId,
        status: "Pending",
        agent_chain_depth: 1,
      });
      const producer = (
        await database.pool.query<{
          knowledge_access: { restrictions: unknown[] };
          agent_chain_depth: number;
        }>("SELECT knowledge_access,agent_chain_depth FROM runs WHERE id=$1", [
          eventWork[0]!.source_run_id,
        ])
      ).rows[0]!;

      expect(producer.agent_chain_depth).toBe(0);
      expect(eventWork[0]!.knowledge_access.restrictions).toEqual(
        expect.arrayContaining(producer.knowledge_access.restrictions),
      );
      const principal = {
        kind: "execution" as const,
        runId: eventRunId,
        nodeAttemptId: null,
      };

      await expect(
        authorizeSourceRestrictions(
          db,
          principal,
          producer.knowledge_access.restrictions,
        ),
      ).resolves.toBeDefined();
      const unrelated = (
        await database.pool.query<{ knowledge_access: unknown }>(
          "SELECT knowledge_access FROM runs WHERE id=$1",
          [flowCron[0]!.run_id],
        )
      ).rows[0]!;

      await expect(
        authorizeSourceRestrictions(
          db,
          principal,
          (unrelated.knowledge_access as { restrictions: unknown[] })
            .restrictions,
        ),
      ).rejects.toMatchObject({
        code: "PRECONDITION",
        details: { reason: "knowledge_reference_unavailable" },
      });
      await database.pool.query(
        "UPDATE domain_event_consumers SET cursor_event_id=(SELECT trigger_event_id-1 FROM runs WHERE id=$1) WHERE consumer_id='agent_triggers'",
        [eventRunId],
      );
      expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM specialist_assignments WHERE project_id=$1 AND origin->>'kind'='event'",
            [project.id],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      const retained = (
        await database.pool.query(
          "SELECT to_jsonb(input) AS value FROM specialist_input_revisions input JOIN specialist_run_links link ON link.assignment_id=input.assignment_id AND link.input_revision=input.revision WHERE link.run_id=$1",
          [eventRunId],
        )
      ).rows;

      expect(
        (
          await saveProjectSchedules("rah:wire-observer", [
            {
              id: eventSource.id,
              triggerType: "event",
              eventKinds: ["run.done"],
              enabled: true,
              reviewForAssignments: true,
            },
          ])
        ).status,
      ).toBe(200);
      await expect(
        authorizeSourceRestrictions(
          db,
          principal,
          eventWork[0]!.knowledge_access.restrictions,
        ),
      ).rejects.toMatchObject({
        code: "PRECONDITION",
        details: { reason: "knowledge_reference_unavailable" },
      });
      expect(
        (
          await saveProjectSchedules("rah:wire-observer", [
            {
              id: eventSource.id,
              triggerType: "event",
              eventKinds: ["run.done"],
              enabled: true,
              reviewForAssignments: true,
              shareEventContext: true,
            },
          ])
        ).status,
      ).toBe(200);
      await expect(
        authorizeSourceRestrictions(
          db,
          principal,
          eventWork[0]!.knowledge_access.restrictions,
        ),
      ).resolves.toBeDefined();
      expect(
        (
          await database.pool.query(
            "SELECT to_jsonb(input) AS value FROM specialist_input_revisions input JOIN specialist_run_links link ON link.assignment_id=input.assignment_id AND link.input_revision=input.revision WHERE link.run_id=$1",
            [eventRunId],
          )
        ).rows,
      ).toEqual(retained);
    } finally {
      await database.pool.query("DELETE FROM execution_host_pressure");
    }
    await database.pool.query(
      "UPDATE scheduler_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE id='agent_tick.dispatcher'",
    );
    await runSchedulerTick({ jobKind: "agent_tick" });
    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query("SELECT status FROM runs WHERE id=$1", [
              eventRunId,
            ])
          ).rows,
        ).toEqual([{ status: "Done" }]);
      },
      { timeout: 30000, interval: 25 },
    );

    await attachAgent(
      {
        projectId: project.id,
        agentId: "rah:event-observer",
        runnerOverrideId: runnerId,
      },
      db,
    );
    for (const agentId of ["rah:event-observer", "rah:flow-coordinator"])
      expect(
        (
          await saveProjectSchedules(agentId, [
            {
              triggerType: "event",
              eventKinds: ["run.done"],
              enabled: true,
              reviewForAssignments: true,
              shareEventContext: true,
            },
          ])
        ).status,
      ).toBe(200);
    await database.pool.query(
      "INSERT INTO agent_schedules(id,agent_id,project_id,trigger_type,event_match,project_source_review,enabled) SELECT '000-event-malformed-'||series,'rah:wire-observer',$1,'event','{\"kinds\":\"invalid\"}'::jsonb,project_source_review,true FROM generate_series(1,25) series CROSS JOIN agent_schedules WHERE id=$2",
      [project.id, eventSource.id],
    );
    const producerResponse = await submitRouted("rah:wire-observer", {
      ...value,
      idempotencyKey: randomUUID(),
      input:
        "Produce independent classified evidence for native event recipients.",
    });

    expect(producerResponse.status).toBe(201);
    const producerReceipt = specialistAssignmentSchema.parse(
      await producerResponse.json(),
    );
    const producingRunId = producerReceipt.runIds[0]!;

    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query("SELECT status FROM runs WHERE id=$1", [
              producingRunId,
            ])
          ).rows,
        ).toEqual([{ status: "Done" }]);
      },
      { timeout: 30000, interval: 25 },
    );
    expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
    const receiverWork = (
      await database.pool.query<{
        run_id: string;
        source_agent_id: string;
        run_kind: string;
        agent_chain_depth: number;
      }>(
        "SELECT link.run_id,run.source_agent_id,run.run_kind,run.agent_chain_depth FROM specialist_assignments work JOIN specialist_run_links link ON link.assignment_id=work.id JOIN runs run ON run.id=link.run_id JOIN domain_events fact ON fact.id::text=work.origin->>'eventId' WHERE work.project_id=$1 AND work.origin->>'kind'='event' AND fact.run_id=$2 ORDER BY run.source_agent_id",
        [project.id, producingRunId],
      )
    ).rows;

    expect(receiverWork).toEqual([
      {
        run_id: expect.any(String),
        source_agent_id: "rah:event-observer",
        run_kind: "agent",
        agent_chain_depth: 1,
      },
      {
        run_id: expect.any(String),
        source_agent_id: "rah:flow-coordinator",
        run_kind: "flow",
        agent_chain_depth: 1,
      },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM agent_schedules WHERE project_id=$1 AND id LIKE '000-event-malformed-%' AND last_outcome='refused'",
          [project.id],
        )
      ).rows,
    ).toEqual([{ count: 25 }]);
    expect(
      (
        await database.pool.query(
          "SELECT invocation.outcome,invocation.reason_code FROM agent_trigger_attempts invocation JOIN domain_events fact ON fact.id=invocation.trigger_event_id WHERE invocation.schedule_id=$1 AND fact.run_id=$2",
          [eventSource.id, producingRunId],
        )
      ).rows,
    ).toEqual([{ outcome: "suppressed", reason_code: "self_authored_event" }]);
    for (const receiver of receiverWork) {
      await vi.waitFor(
        async () => {
          expect(
            (
              await database.pool.query("SELECT status FROM runs WHERE id=$1", [
                receiver.run_id,
              ])
            ).rows,
          ).toEqual([{ status: "Done" }]);
        },
        { timeout: 30000, interval: 25 },
      );
      expect(
        (
          await database.pool.query(
            "SELECT validity FROM run_results WHERE run_id=$1",
            [receiver.run_id],
          )
        ).rows,
      ).toEqual([{ validity: "valid" }]);
    }

    const rollbackMarker = new Error("Qualification-only state must roll back");

    await expect(
      db.transaction(async (tx) => {
        for (const classification of ["unknown", "capped"] as const) {
          const fixtureRunId = randomUUID();

          await tx.execute(
            sql`INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs,to_jsonb(original)||jsonb_build_object('id',${fixtureRunId}::text,'agent_chain_depth',${classification === "capped" ? maxAgentChainDepth() : 0}::int))).* FROM runs original WHERE original.id=${producingRunId}`,
          );
          if (classification === "capped")
            await tx.execute(
              sql`INSERT INTO specialist_run_links SELECT assignment_id,${fixtureRunId},input_revision,role,work_id,work_revision,linked_at FROM specialist_run_links WHERE run_id=${producingRunId}`,
            );
          const fact = (
            await tx.execute(
              sql`INSERT INTO domain_events(kind,project_id,run_id,actor_type,payload,occurred_at) VALUES('run.done',${project.id},${fixtureRunId},'system','{}'::jsonb,clock_timestamp()) RETURNING id`,
            )
          ).rows[0]!;
          const chain = await resolveProjectEventChainDepth(
            tx,
            project.id,
            Number(fact.id),
          );

          expect(chain).toEqual(
            classification === "capped"
              ? { depth: maxAgentChainDepth() + 1, atCap: true }
              : {
                  depth: maxAgentChainDepth(),
                  atCap: true,
                  reason: "project_event_chain_unclassified",
                },
          );
        }
        throw rollbackMarker;
      }),
    ).rejects.toBe(rollbackMarker);
    for (const roleId of ["rah:event-observer", "rah:flow-coordinator"])
      expect((await saveProjectSchedules(roleId, [])).status).toBe(200);
    expect(
      (
        await saveProjectSchedules("rah:wire-observer", [
          {
            id: eventSource.id,
            triggerType: "event",
            eventKinds: ["run.done"],
            enabled: true,
            reviewForAssignments: true,
          },
        ])
      ).status,
    ).toBe(200);
    const privateProducerResponse = await submitRouted("rah:flow-coordinator", {
      ...flowRequest,
      idempotencyKey: randomUUID(),
    });

    expect(privateProducerResponse.status).toBe(201);
    const privateProducer = specialistAssignmentSchema.parse(
      await privateProducerResponse.json(),
    );
    const privateProducerId = privateProducer.runIds[0]!;

    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query("SELECT status FROM runs WHERE id=$1", [
              privateProducerId,
            ])
          ).rows,
        ).toEqual([{ status: "Done" }]);
      },
      { timeout: 30000, interval: 25 },
    );
    expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
    expect(
      (
        await database.pool.query(
          "SELECT invocation.outcome,invocation.reason_code,invocation.run_id FROM agent_trigger_attempts invocation JOIN domain_events fact ON fact.id=invocation.trigger_event_id WHERE invocation.schedule_id=$1 AND fact.run_id=$2",
          [eventSource.id, privateProducerId],
        )
      ).rows,
    ).toEqual([
      {
        outcome: "refused",
        reason_code: "project_event_sharing_required",
        run_id: null,
      },
    ]);
    expect(
      (
        await saveProjectSchedules("rah:wire-observer", [
          {
            id: eventSource.id,
            triggerType: "event",
            eventKinds: ["task.comment_added"],
            enabled: true,
            reviewForAssignments: true,
          },
        ])
      ).status,
    ).toBe(200);
    const userFactResponse = await taskCommentPost(
      new NextRequest(
        `http://localhost/api/projects/${project.slug}/tasks/9001/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: "A bounded project fact without a producing agent Run.",
          }),
        },
      ),
      { params: Promise.resolve({ slug: project.slug, number: "9001" }) },
    );

    expect(userFactResponse.status).toBe(201);
    const userComment: { comment: { id: string } } =
      await userFactResponse.json();

    expect(await dispatchDomainEvents({ db })).toMatchObject({ failures: 0 });
    const rootWork = (
      await database.pool.query<{
        id: string;
        agent_chain_depth: number;
        input: string;
      }>(
        "SELECT run.id,run.agent_chain_depth,input.objective_input->>'input' AS input FROM specialist_assignments work JOIN specialist_input_revisions input ON input.assignment_id=work.id AND input.revision=1 JOIN specialist_run_links link ON link.assignment_id=work.id JOIN runs run ON run.id=link.run_id JOIN domain_events fact ON fact.id::text=work.origin->>'eventId' WHERE work.project_id=$1 AND work.origin->>'kind'='event' AND fact.payload->>'commentId'=$2",
        [project.id, userComment.comment.id],
      )
    ).rows;

    expect(rootWork).toHaveLength(1);
    expect(rootWork[0]!.agent_chain_depth).toBe(0);
    expect(rootWork[0]!.input).not.toContain("bounded project fact");
    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query("SELECT status FROM runs WHERE id=$1", [
              rootWork[0]!.id,
            ])
          ).rows,
        ).toEqual([{ status: "Done" }]);
      },
      { timeout: 30000, interval: 25 },
    );

    const webhookLink = await attachAgent(
      {
        projectId: project.id,
        agentId: "rah:webhook-observer",
        runnerOverrideId: runnerId,
      },
      db,
    );
    const webhookTokens = await Promise.all(
      ["first", "rotated"].map((name) =>
        issueUserAccessToken(
          {
            ownerUserId: userId,
            name: `project-webhook-${name}`,
            scopes: ["agents:trigger", "assignments:submit"],
          },
          db,
        ),
      ),
    );
    const webhookDelivery = randomUUID();
    const webhookRequest = {
      schemaVersion: 1,
      assignment: {
        ...objective,
        owner: { kind: "project", projectId: project.id },
        specialistBindingId: webhookLink.linkId,
        input:
          "Retain this exact project webhook request independently of payload metadata.",
      },
    };
    const webhookContract: { components: { schemas: Record<string, object> } } =
      parse(await readFile(resolve("../docs/api/web.openapi.yaml"), "utf8"));
    const validateProjectWebhook = new Ajv({
      strict: false,
      validateFormats: false,
    }).compile({
      components: webhookContract.components,
      ...webhookContract.components.schemas.CBProjectWebhookEnvelope,
    });

    expect(
      validateProjectWebhook(webhookRequest),
      JSON.stringify(validateProjectWebhook.errors),
    ).toBe(true);
    expect(
      validateProjectWebhook({
        ...webhookRequest,
        actor: { kind: "user", id: administratorId },
      }),
    ).toBe(false);
    const submitProjectWebhook = (
      roleId: string,
      body: unknown,
      key: string | null,
      secret: string,
      extraHeaders: Record<string, string> = {},
    ): Promise<Response> =>
      inboundAgentEventPost(
        new NextRequest(`http://localhost/api/agents/${roleId}/event`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${secret}`,
            "X-Maister-Owner-Kind": "project",
            ...(key === null ? {} : { "Idempotency-Key": key }),
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ agentId: roleId }) },
      );

    await database.pool.query(
      "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
    );
    let webhookRunId: string;
    let independentWebhookRunId: string;

    try {
      const deliveries = await Promise.all(
        webhookTokens.map((token) =>
          submitProjectWebhook(
            "rah:webhook-observer",
            webhookRequest,
            webhookDelivery,
            token.secret,
          ),
        ),
      );

      expect(deliveries.map((response) => response.status).sort()).toEqual([
        200, 201,
      ]);
      const work = await Promise.all(
        deliveries.map(async (response) =>
          specialistAssignmentSchema.parse(await response.json()),
        ),
      );

      expect(work[0].requester).toEqual({
        kind: "user",
        id: userId,
        runId: null,
        attemptId: null,
      });
      expect(work[0].destination).toEqual({ kind: "inbox", userId });
      expect(work[0].id).toBe(work[1].id);
      expect(work[0].origin).toMatchObject({
        kind: "webhook",
        deliveryId: webhookDelivery,
      });
      webhookRunId = work[0].runIds[0]!;
      expect(
        (
          await database.pool.query(
            "SELECT status,trigger_source,scheduled_request_snapshot FROM runs WHERE id=$1",
            [webhookRunId],
          )
        ).rows,
      ).toEqual([
        {
          status: "Pending",
          trigger_source: "webhook",
          scheduled_request_snapshot: null,
        },
      ]);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
            [webhookRunId],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      const independent = await submitProjectWebhook(
        "rah:webhook-observer",
        webhookRequest,
        randomUUID(),
        webhookTokens[0].secret,
      );

      expect(independent.status).toBe(201);
      const independentWork = specialistAssignmentSchema.parse(
        await independent.json(),
      );

      expect(independentWork.id).not.toBe(work[0].id);
      independentWebhookRunId = independentWork.runIds[0]!;
      await database.pool.query(
        "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
        [project.id, userId],
      );
      try {
        expect(
          (
            await submitProjectWebhook(
              "rah:webhook-observer",
              webhookRequest,
              webhookDelivery,
              webhookTokens[1].secret,
            )
          ).status,
        ).toBe(403);
      } finally {
        await database.pool.query(
          "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
          [project.id, userId],
        );
      }
    } finally {
      await database.pool.query("DELETE FROM execution_host_pressure");
    }
    expect(
      (
        await submitProjectWebhook(
          "rah:webhook-observer",
          webhookRequest,
          webhookDelivery,
          webhookTokens[1].secret,
        )
      ).status,
    ).toBe(200);
    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query("SELECT status FROM runs WHERE id=$1", [
              webhookRunId,
            ])
          ).rows,
        ).toEqual([{ status: "Done" }]);
      },
      { timeout: 30000, interval: 25 },
    );
    expect(
      (
        await database.pool.query(
          "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt') GROUP BY kind ORDER BY kind",
          [webhookRunId],
        )
      ).rows,
    ).toEqual([
      { kind: "session.create", count: 1 },
      { kind: "session.prompt", count: 1 },
    ]);
    expect(
      (
        await submitProjectWebhook(
          "rah:webhook-observer",
          {
            ...webhookRequest,
            assignment: {
              ...webhookRequest.assignment,
              input: "Changed under a used delivery",
            },
          },
          webhookDelivery,
          webhookTokens[0].secret,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await submitProjectWebhook(
          "rah:webhook-observer",
          webhookRequest,
          null,
          webhookTokens[0].secret,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await submitProjectWebhook(
          "rah:webhook-observer",
          { ...webhookRequest, schemaVersion: 2 },
          randomUUID(),
          webhookTokens[0].secret,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await submitProjectWebhook(
          "rah:webhook-observer",
          { ...webhookRequest, actor: { kind: "user", id: administratorId } },
          randomUUID(),
          webhookTokens[0].secret,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await submitProjectWebhook(
          "rah:webhook-observer",
          webhookRequest,
          randomUUID(),
          webhookTokens[0].secret,
          { "X-Maister-Trigger-Event-Id": "1" },
        )
      ).status,
    ).toBe(422);
    const confinedWebhookToken = await issueToken(
      {
        projectId: project.id,
        name: "project-webhook-cannot-impersonate",
        scopes: ["agents:trigger", "assignments:submit"],
        createdByUserId: userId,
      },
      db,
    );

    expect(
      (
        await submitProjectWebhook(
          "rah:webhook-observer",
          webhookRequest,
          randomUUID(),
          confinedWebhookToken.secret,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await submitProjectWebhook(
          "rah:webhook-observer",
          webhookRequest,
          randomUUID(),
          personalProjectToken.secret,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await submitProjectWebhook(
          "rah:webhook-observer",
          {
            ...webhookRequest,
            assignment: {
              ...webhookRequest.assignment,
              owner: assignmentInput.owner,
            },
          },
          randomUUID(),
          webhookTokens[0].secret,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await submitProjectWebhook(
          "rah:webhook-observer",
          {
            ...webhookRequest,
            assignment: {
              ...webhookRequest.assignment,
              specialistBindingId: coordinator.linkId,
            },
          },
          randomUUID(),
          webhookTokens[0].secret,
        )
      ).status,
    ).toBe(409);
    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query("SELECT status FROM runs WHERE id=$1", [
              independentWebhookRunId,
            ])
          ).rows,
        ).toEqual([{ status: "Done" }]);
      },
      { timeout: 30000, interval: 25 },
    );
    await updateAgentLink(
      {
        projectId: project.id,
        agentId: "rah:webhook-observer",
        actorUserId: administratorId,
        patch: { enabled: false },
      },
      db,
    );
    expect(
      (
        await submitProjectWebhook(
          "rah:webhook-observer",
          webhookRequest,
          webhookDelivery,
          webhookTokens[1].secret,
        )
      ).status,
    ).toBe(200);
    await updateAgentLink(
      {
        projectId: project.id,
        agentId: "rah:webhook-observer",
        actorUserId: administratorId,
        patch: { enabled: true },
      },
      db,
    );
    const flowWebhook = await submitProjectWebhook(
      "rah:flow-coordinator",
      {
        schemaVersion: 1,
        assignment: {
          ...objective,
          owner: { kind: "project", projectId: project.id },
          specialistBindingId: flowRequest.specialistBindingId,
          input: "Coordinate the exact project webhook evidence.",
        },
      },
      randomUUID(),
      webhookTokens[0].secret,
    );

    expect(flowWebhook.status).toBe(201);
    const flowWebhookWork = specialistAssignmentSchema.parse(
      await flowWebhook.json(),
    );

    await vi.waitFor(
      async () => {
        expect(
          (
            await database.pool.query(
              "SELECT status,run_kind FROM runs WHERE id=$1",
              [flowWebhookWork.runIds[0]!],
            )
          ).rows,
        ).toEqual([{ status: "Done", run_kind: "flow" }]);
      },
      { timeout: 30000, interval: 25 },
    );
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM specialist_assignments WHERE project_id=$1 AND origin->>'kind'='webhook'",
          [project.id],
        )
      ).rows,
    ).toEqual([{ count: 3 }]);
    expect(
      (
        await database.pool.query(
          "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt') GROUP BY kind ORDER BY kind",
          [webhookRunId],
        )
      ).rows,
    ).toEqual([
      { kind: "session.create", count: 1 },
      { kind: "session.prompt", count: 1 },
    ]);
  } finally {
    await database.pool.query(
      "UPDATE agent_schedules SET enabled=false WHERE project_id=$1",
      [project.id],
    );
    browserSession.user = null;
    await worker.stop();
    await stopRuntimeEventConsumers();
    await supervisor.stop();
    restoreUrl();
    resetResolverForTests();
    resetRegistrarStateForTests();
    setDefaultTransportForTests(null);
  }
}, 90000);

it.each(["live", "checkpointed", "cancelled"] as const)(
  "CBS-02 routes a real company permission through current human authority and the existing owned delivery (%s)",
  async (delivery) => {
    const db: Db = database.db;
    let supervisor = await startRealSupervisor({
      runtimeRoot: join(root, `company-permission-${delivery}-host`),
      workspaceRoots: [join(root, "worktrees")],
      fixtureArgs: ["--hang", "--supports-resume"],
    });
    const restoreUrl = useRealSupervisorUrl(supervisor.url);
    const worker = startProjectionWorker({
      db,
      projectors: canonicalProjectors,
    });
    const abort = new AbortController();
    const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    let driver: Promise<Readonly<{ error: unknown | null }>> | undefined;
    let continuation:
      ReturnType<typeof startAgentContinuationWorker> | undefined;
    let blockerRunId: string | undefined;

    setDefaultTransportForTests(null);
    resetResolverForTests();
    resetRegistrarStateForTests();
    vi.stubEnv("MAISTER_MAX_CONCURRENT_AGENTS", "100");
    try {
      const roleId = `rah:permission-${delivery}-observer`;
      const effective = await resolveInstalledAgentDefinition(db, {
        agentId: roleId,
        packageInstallId: assignmentInput.standingDefinition.packageInstallId,
      });
      const runnerId = randomUUID();

      await db.insert(platformAcpRunners).values({
        id: runnerId,
        adapter: "claude",
        capabilityAgent: "claude",
        model: "company-permission-fixture",
        provider: { kind: "anthropic" },
        readinessStatus: "Ready",
      });
      const binding = await createCompanySpecialistBinding(db, userId, roleId, {
        owner: { kind: "company", companyId: request.companyId },
        packageInstallId: effective.packageInstallId,
        packageRevision: effective.resolvedRevision!,
        definitionSha256: agentDefinitionSha256(effective.parsed),
        enabled: true,
        configuration: {},
        grantActions: ["knowledge:read", "knowledge:propose"],
        runnerId,
        idempotencyKey: randomUUID(),
      });
      const contract = buildOperationalContract(effective);
      const assignment = await createSpecialistAssignment(db, userId, {
        ...assignmentInput,
        specialistBindingId: binding.specialist.bindingId,
        responsibleAgentId: roleId,
        standingDefinition: {
          ...assignmentInput.standingDefinition,
          agentId: roleId,
          definition: effective.parsed,
          definitionSha256: agentDefinitionSha256(effective.parsed),
        },
        objectiveInput: {
          ...assignmentInput.objectiveInput,
          expectedResult: {
            schemaRef: contract.schemaRef,
            schemaVersion: contract.schemaVersion,
            sha256: contract.sha256,
            required: true,
          },
        },
      });
      const hosts = createExecutionHosts({
        db,
        transport: createLocalDirectTransport(),
      });
      const receipt = await reserveCompanyAgentRun(
        db,
        userId,
        {
          ...request,
          assignmentId: assignment.id,
          bindingId: binding.specialist.bindingId,
        },
        hosts,
      );

      expect(await tryStartRun(receipt.runId, { db })).toMatchObject({
        started: true,
      });
      driver = startAgentSession(receipt.runId, {
        db,
        executionHosts: hosts,
        signal: abort.signal,
      }).then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
      await expect
        .poll(
          async () =>
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM hitl_requests WHERE run_id=$1 AND kind='permission'",
                [receipt.runId],
              )
            ).rows[0].count,
          { timeout: 30000, interval: 50 },
        )
        .toBe(1);
      const hitl = (
        await database.pool.query(
          "SELECT id,response,responded_at FROM hitl_requests WHERE run_id=$1 AND kind='permission'",
          [receipt.runId],
        )
      ).rows[0];

      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM domain_events WHERE kind='run.needs_input' AND run_id=$1 AND company_id=$2 AND project_id IS NULL AND task_id IS NULL AND payload->>'hitlRequestId'=$3",
            [receipt.runId, request.companyId, hitl.id],
          )
        ).rows[0],
      ).toEqual({ count: 1 });
      browserSession.user = await requireActiveUserById(userId);
      const denied = await respondHitlPost(
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

      expect(denied.status).toBe(403);
      expect(
        (
          await database.pool.query(
            "SELECT response,responded_at FROM hitl_requests WHERE id=$1",
            [hitl.id],
          )
        ).rows[0],
      ).toEqual({ response: null, responded_at: null });
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.input'",
            [receipt.runId],
          )
        ).rows[0],
      ).toEqual({ count: 0 });
      const human = (
        await database.pool.query(
          "SELECT id,status,company_id,project_id FROM assignments WHERE hitl_request_id=$1",
          [hitl.id],
        )
      ).rows[0];

      expect(human).toMatchObject({
        status: "open",
        company_id: request.companyId,
        project_id: null,
      });
      const responderId = randomUUID();

      await database.pool.query(
        "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
        [responderId, `${responderId}@example.test`],
      );
      const responseGrants = await createCompanyGrants(db, administratorId, {
        principalKind: "user",
        principalId: responderId,
        actions:
          delivery === "cancelled"
            ? ["assignments:read", "assignments:cancel"]
            : ["assignments:read", "assignments:answer"],
        idempotencyKey: randomUUID(),
      });

      if (delivery === "cancelled") {
        const direct = createLocalDirectTransport();

        setDefaultTransportForTests({
          ...direct,
          deleteSession: async (
            ...input: Parameters<typeof direct.deleteSession>
          ): Promise<Awaited<ReturnType<typeof direct.deleteSession>>> => {
            const result = await direct.deleteSession(...input);

            // Hold the real DELETE response until the prompt worker observes the retained stop intent.
            await expect
              .poll(
                async () =>
                  (
                    await database.pool.query<{ cause: string | null }>(
                      "SELECT application_error->'causeDetails'->>'causeCode' AS cause FROM execution_commands WHERE run_id=$1 AND kind='session.prompt' ORDER BY created_at DESC LIMIT 1",
                      [receipt.runId],
                    )
                  ).rows[0]?.cause,
                { timeout: 10000, interval: 50 },
              )
              .toBe("company_cancellation_pending");
            expect(
              (
                await database.pool.query(
                  "SELECT status,company_cancellation_intent->>'userId' AS user_id FROM runs WHERE id=$1",
                  [receipt.runId],
                )
              ).rows,
            ).toEqual([{ status: "NeedsInput", user_id: responderId }]);

            return result;
          },
        });
        browserSession.user = await requireActiveUserById(responderId);
        await expect
          .poll(
            async () => {
              const stopped = await stopRunPost(
                new Request(`http://localhost/api/runs/${receipt.runId}/stop`, {
                  method: "POST",
                }),
                { params: Promise.resolve({ runId: receipt.runId }) },
              );
              const body = await stopped.json();

              if (stopped.status === 503) {
                expect(body).toMatchObject({
                  code: "EXECUTOR_UNAVAILABLE",
                  details: { reason: "agent_execution_quiescence_unproven" },
                });

                return "awaiting-canonical-teardown";
              }
              expect(stopped.status).toBe(200);
              expect(body).toMatchObject({
                ok: true,
                runId: receipt.runId,
                runStatus: "Abandoned",
                supervisorStopped: expect.any(Boolean),
              });

              return "abandoned";
            },
            { timeout: 10000, interval: 50 },
          )
          .toBe("abandoned");
        expect(
          (
            await database.pool.query(
              "SELECT human.status,actor.user_id FROM assignments human JOIN assignment_events event ON event.assignment_id=human.id AND event.event_kind='cancelled' JOIN actor_identities actor ON actor.id=event.actor_id WHERE human.id=$1",
              [human.id],
            )
          ).rows,
        ).toEqual([{ status: "cancelled", user_id: responderId }]);
        expect(
          (
            await database.pool.query(
              "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.input'",
              [receipt.runId],
            )
          ).rows[0],
        ).toEqual({ count: 0 });
        expect(
          (
            await database.pool.query(
              "SELECT count(*)::int AS count FROM run_results WHERE run_id=$1",
              [receipt.runId],
            )
          ).rows[0],
        ).toEqual({ count: 0 });
        expect(
          (
            await database.pool.query(
              "SELECT status,revision FROM specialist_assignments WHERE id=$1",
              [assignment.id],
            )
          ).rows[0],
        ).toEqual({ status: "active", revision: 3 });

        expect(
          (
            await database.pool.query(
              "SELECT state FROM execution_commands WHERE run_id=$1 AND kind='session.delete'",
              [receipt.runId],
            )
          ).rows,
        ).toEqual([{ state: "succeeded" }]);

        return;
      }
      if (delivery === "checkpointed") {
        await database.pool.query(
          "UPDATE runs SET keepalive_until=now()-interval '1 second' WHERE id=$1",
          [receipt.runId],
        );
        expect(await runSweepTick({ db, executionHosts: hosts })).toMatchObject(
          {
            idledCount: 1,
          },
        );
        abort.abort();
        await driver;
        const beforeHealth = await hosts.local().health();
        const frozen = await db
          .select({
            snapshot: runs.companyExecutionSnapshot,
            contract: runs.resultContract,
            acpSessionId: runSessions.acpSessionId,
          })
          .from(runs)
          .innerJoin(runSessions, eq(runSessions.runId, runs.id))
          .where(eq(runs.id, receipt.runId));

        await stopRuntimeEventConsumers();
        supervisor = await supervisor.restart();
        resetRegistrarStateForTests();
        resetResolverForTests();
        const afterHealth = await hosts.local().health();

        expect(beforeHealth.kind).toBe("ready");
        expect(afterHealth.kind).toBe("ready");
        if (beforeHealth.kind !== "ready" || afterHealth.kind !== "ready")
          throw new Error(
            "Company recovery fixture did not retain a ready execution host",
          );
        expect(afterHealth.identity?.hostKey).toBe(
          beforeHealth.identity?.hostKey,
        );
        expect(afterHealth.identity?.bootId).not.toBe(
          beforeHealth.identity?.bootId,
        );
        expect(
          await db
            .select({
              snapshot: runs.companyExecutionSnapshot,
              contract: runs.resultContract,
              acpSessionId: runSessions.acpSessionId,
            })
            .from(runs)
            .innerJoin(runSessions, eq(runSessions.runId, runs.id))
            .where(eq(runs.id, receipt.runId)),
        ).toEqual(frozen);
        expect(frozen[0].acpSessionId).toEqual(expect.any(String));
        const blockerProject = await seedProjectRow(database.db);

        blockerRunId = randomUUID();
        await database.pool.query(
          "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision) VALUES($1,$2,'agent','Running','fixture','fixture')",
          [blockerRunId, blockerProject.id],
        );
        vi.stubEnv("MAISTER_MAX_CONCURRENT_AGENTS", "1");
        expect(
          (await db.select().from(runs).where(eq(runs.id, receipt.runId)))[0]
            .status,
        ).toBe("NeedsInputIdle");
      }
      browserSession.user = await requireActiveUserById(responderId);
      const accepted = await respondHitlPost(
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

      expect(accepted.status).toBe(delivery === "live" ? 200 : 202);
      if (delivery === "live") expect(await driver).toEqual({ error: null });
      if (delivery === "checkpointed") {
        const answerGrant = responseGrants.page.items.find(
          (grant) => grant.action === "assignments:answer",
        )!;

        await revokeCompanyGrant(db, administratorId, answerGrant.id, {
          expectedRevision: answerGrant.revision,
          reason:
            "Withdraw consent authority while checkpoint delivery waits for capacity",
          idempotencyKey: randomUUID(),
        });
        await database.pool.query(
          "UPDATE runs SET status='Failed' WHERE id=$1",
          [blockerRunId],
        );
        continuation = startAgentContinuationWorker({
          db,
          executionHosts: hosts,
        });
        await expect
          .poll(
            async () =>
              (
                await database.pool.query(
                  "SELECT count(*)::int AS count FROM execution_events WHERE run_id=$1 AND event_type='session.permission_request'",
                  [receipt.runId],
                )
              ).rows[0].count,
            { timeout: 30000, interval: 50 },
          )
          .toBe(2);
        expect(
          (
            await database.pool.query(
              "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.input'",
              [receipt.runId],
            )
          ).rows[0],
        ).toEqual({ count: 0 });
        expect(
          (
            await database.pool.query(
              "SELECT status,assignee_actor_id FROM assignments WHERE run_id=$1 AND hitl_request_id<>$2",
              [receipt.runId, hitl.id],
            )
          ).rows,
        ).toEqual([]);
        await createCompanyGrants(db, administratorId, {
          principalKind: "user",
          principalId: responderId,
          actions: ["assignments:answer"],
          idempotencyKey: randomUUID(),
        });
      }

      await expect
        .poll(
          async () =>
            (await db.select().from(runs).where(eq(runs.id, receipt.runId)))[0]
              .status,
          { timeout: 30000, interval: 50 },
        )
        .toBe("Done");
      expect(
        (await db.select().from(runs).where(eq(runs.id, receipt.runId)))[0],
      ).toMatchObject({
        status: "Done",
        companyId: request.companyId,
        projectId: null,
      });
      expect(
        (
          await database.pool.query(
            "SELECT human.status,actor.user_id,actor.company_id FROM assignments human JOIN actor_identities actor ON actor.id=human.completed_by_actor_id WHERE human.id=$1",
            [human.id],
          )
        ).rows[0],
      ).toEqual({
        status: "completed",
        user_id: responderId,
        company_id: request.companyId,
      });
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.input'",
            [receipt.runId],
          )
        ).rows[0],
      ).toEqual({ count: 1 });
      expect(
        (
          await database.pool.query(
            "SELECT human.status,actor.user_id,actor.company_id FROM assignments human JOIN actor_identities actor ON actor.id=human.completed_by_actor_id WHERE human.run_id=$1 ORDER BY human.id",
            [receipt.runId],
          )
        ).rows,
      ).toEqual(
        Array.from({ length: delivery === "live" ? 1 : 2 }, () => ({
          status: "completed",
          user_id: responderId,
          company_id: request.companyId,
        })),
      );
      expect(
        (
          await database.pool.query(
            "SELECT status,revision FROM specialist_assignments WHERE id=$1",
            [assignment.id],
          )
        ).rows[0],
      ).toEqual({ status: "active", revision: 3 });
    } finally {
      browserSession.user = null;
      abort.abort();
      await driver;
      await continuation?.stop();
      await worker.stop();
      await stopRuntimeEventConsumers();
      await supervisor.stop();
      restoreUrl();
      resetRegistrarStateForTests();
      resetResolverForTests();
      setDefaultTransportForTests(null);
      if (previousCap === undefined)
        delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
      else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
    }
  },
  90000,
);

it("CBS-02 shares the existing bounded agent pool across project and company work and promotes a queued company run once", async () => {
  const db: Db = database.db;
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

  vi.stubEnv("MAISTER_MAX_CONCURRENT_AGENTS", "1");
  try {
    const project = await seedProjectRow(database.db);
    const projectRunId = randomUUID();

    await database.pool.query(
      "INSERT INTO runs(id,run_kind,project_id,agent_id,agent_workspace,flow_version,flow_revision,status) VALUES($1,'agent',$2,$3,'none','agent','manual','Pending')",
      [projectRunId, project.id, agentId],
    );
    const first = await reserveCompanyFixtureRun();
    const second = await reserveCompanyFixtureRun();

    expect(await tryStartRun(projectRunId, { db })).toMatchObject({
      started: true,
    });
    expect(await tryStartRun(first.runId, { db })).toMatchObject({
      started: false,
    });
    expect(await tryStartRun(second.runId, { db })).toMatchObject({
      started: false,
    });
    expect(await countLiveRuns(db, "agent")).toBe(1);
    const projectFailure = await prepareUndispatchedAgentFailure(projectRunId, {
      db,
      reason: "fixture_before_dispatch",
    });

    await db.transaction((tx) => projectFailure.apply(tx));
    const contenders = [first.runId, second.runId];
    const outcomes = await Promise.all(
      contenders.map((runId) => tryStartRun(runId, { db })),
    );

    expect(outcomes.filter((outcome) => outcome.started)).toHaveLength(1);
    expect(await countLiveRuns(db, "agent")).toBe(1);
    const winner = contenders[outcomes.findIndex((outcome) => outcome.started)];
    const queued =
      contenders[outcomes.findIndex((outcome) => !outcome.started)];
    const undispatched = await prepareUndispatchedAgentFailure(winner, {
      db,
      reason: "fixture_before_dispatch",
    });

    await db.transaction((tx) => undispatched.apply(tx));
    expect(await countLiveRuns(db, "agent")).toBe(0);
    const dispatched: string[] = [];
    const promoted = await promoteNextPending({
      db,
      pool: "agent",
      startAgentRun: (id) => {
        dispatched.push(id);
      },
    });

    expect(promoted).toMatchObject({ promotedRunId: queued });
    expect(dispatched).toEqual([queued]);
    expect(await countLiveRuns(db, "agent")).toBe(1);
    await promoteNextPending({
      db,
      pool: "agent",
      startAgentRun: (id) => {
        dispatched.push(id);
      },
    });
    expect(dispatched).toEqual([queued]);
    expect(
      (
        await database.pool.query(
          "SELECT run_id,project_id FROM webhook_events WHERE run_id=ANY($1::text[]) AND type='run.started'",
          [[projectRunId, ...contenders]],
        )
      ).rows,
    ).toEqual([{ run_id: projectRunId, project_id: project.id }]);
    const last = await prepareUndispatchedAgentFailure(queued, {
      db,
      reason: "fixture_before_dispatch",
    });

    await db.transaction((tx) => last.apply(tx));
  } finally {
    vi.stubEnv("MAISTER_MAX_CONCURRENT_AGENTS", previousCap);
  }
});

it("CBS-02 atomically reserves one company execution with frozen session and placement under concurrent admission", async () => {
  const db: Db = database.db;
  const { hosts, hostId } = await fakeExecutionHosts(db);
  const runnerId = randomUUID();

  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "fixture",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  await db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId })
    .onConflictDoUpdate({
      target: platformRuntimeSettings.id,
      set: { defaultRunnerId: runnerId },
    });
  const assignment = await createSpecialistAssignment(
    db,
    userId,
    assignmentInput,
  );
  const admission = { ...request, assignmentId: assignment.id };

  try {
    const outcomes = await Promise.allSettled([
      reserveCompanyAgentRun(db, userId, admission, hosts),
      reserveCompanyAgentRun(db, userId, admission, hosts),
    ]);
    const accepted = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    const refused = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(outcomes, "one native reservation must commit").toContainEqual(
      expect.objectContaining({ status: "fulfilled" }),
    );
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ reason: { code: "CONFLICT" } });
    if (accepted[0]?.status !== "fulfilled")
      throw new Error("Company admission did not reserve its execution");
    const receipt = accepted[0].value;

    expect(receipt).toMatchObject({
      assignmentId: assignment.id,
      assignmentRevision: 3,
      status: "Pending",
    });
    const stored = (
      await database.pool.query(
        "SELECT execution.project_id,execution.company_id,execution.agent_config,execution.execution_policy,execution.status,execution.knowledge_access,session.runner_id,session.runner_resolution_tier,placement.execution_host_id,placement.epoch,assignment.status AS assignment_status,link.input_revision FROM runs execution JOIN run_sessions session ON session.run_id=execution.id JOIN execution_assignments placement ON placement.run_id=execution.id JOIN specialist_run_links link ON link.run_id=execution.id JOIN specialist_assignments assignment ON assignment.id=link.assignment_id WHERE execution.id=$1",
        [receipt.runId],
      )
    ).rows;

    expect(stored).toEqual([
      expect.objectContaining({
        project_id: null,
        company_id: request.companyId,
        agent_config: { label: "base" },
        execution_policy: { preset: "supervised" },
        status: "Pending",
        runner_id: runnerId,
        runner_resolution_tier: "platformDefault",
        execution_host_id: hostId,
        epoch: 1,
        assignment_status: "active",
        input_revision: 1,
      }),
    ]);
    expect(stored[0].knowledge_access).toMatchObject({
      state: "complete",
      restrictions: [
        {
          kind: "assignment_input",
          assignmentId: assignment.id,
          inputRevision: 1,
        },
      ],
    });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM project_tokens WHERE company_run_id=$1",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    const source = await seedProjectRow(database.db);

    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
      [randomUUID(), source.id, userId],
    );
    const restricted = await createSpecialistAssignment(db, userId, {
      ...assignmentInput,
      sourceRestrictions: [{ kind: "project_context", projectId: source.id }],
    });
    const before = (
      await database.pool.query(
        "SELECT (SELECT count(*) FROM runs) AS runs,(SELECT count(*) FROM run_sessions) AS sessions,(SELECT count(*) FROM execution_assignments) AS placements,(SELECT count(*) FROM specialist_run_links) AS links,(SELECT count(*) FROM domain_events) AS events",
      )
    ).rows[0];

    await expect(
      reserveCompanyAgentRun(
        db,
        userId,
        { ...request, assignmentId: restricted.id },
        hosts,
      ),
    ).rejects.toMatchObject({
      details: { reason: "knowledge_reference_unavailable" },
    });
    expect(
      (
        await database.pool.query(
          "SELECT (SELECT count(*) FROM runs) AS runs,(SELECT count(*) FROM run_sessions) AS sessions,(SELECT count(*) FROM execution_assignments) AS placements,(SELECT count(*) FROM specialist_run_links) AS links,(SELECT count(*) FROM domain_events) AS events",
        )
      ).rows[0],
    ).toEqual(before);
    expect(
      (
        await database.pool.query(
          "SELECT status,revision FROM specialist_assignments WHERE id=$1",
          [restricted.id],
        )
      ).rows[0],
    ).toEqual({ status: "queued", revision: 1 });
    await database.pool.query("DELETE FROM projects WHERE id=$1", [source.id]);
  } finally {
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
});

it("CBS-02 cancels a native Pending company Run only under current cancellation authority and retains one terminal outcome", async () => {
  const db: Db = database.db;
  const { hosts } = await fakeExecutionHosts(db);
  const runnerId = randomUUID();

  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "company-cancel-fixture",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  await db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId })
    .onConflictDoUpdate({
      target: platformRuntimeSettings.id,
      set: { defaultRunnerId: runnerId },
    });
  const assignment = await createSpecialistAssignment(
    db,
    userId,
    assignmentInput,
  );
  const receipt = await reserveCompanyAgentRun(
    db,
    userId,
    { ...request, assignmentId: assignment.id },
    hosts,
  );
  const stop = (): Promise<Response> =>
    stopRunPost(
      new Request(`http://localhost/api/runs/${receipt.runId}/stop`, {
        method: "POST",
      }),
      { params: Promise.resolve({ runId: receipt.runId }) },
    );
  const responderId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [responderId, `${responderId}@example.test`],
  );
  await createCompanyGrants(db, administratorId, {
    principalKind: "user",
    principalId: responderId,
    actions: ["assignments:read"],
    idempotencyKey: randomUUID(),
  });
  try {
    browserSession.user = await requireActiveUserById(responderId);
    expect((await stop()).status).toBe(403);
    expect(
      (await db.select().from(runs).where(eq(runs.id, receipt.runId)))[0]
        .status,
    ).toBe("Pending");
    browserSession.user = await requireActiveUserById(administratorId);
    expect((await stop()).status).toBe(404);
    const cancellation = await createCompanyGrants(db, administratorId, {
      principalKind: "user",
      principalId: responderId,
      actions: ["assignments:cancel"],
      idempotencyKey: randomUUID(),
    });

    browserSession.user = await requireActiveUserById(responderId);
    const [accepted, concurrent] = await Promise.all([stop(), stop()]);

    expect(concurrent.status).toBe(200);
    expect(await concurrent.json()).toEqual({
      ok: true,
      runId: receipt.runId,
      runStatus: "Abandoned",
      supervisorStopped: false,
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();

    await assertWebPostResponseContract(
      "/api/runs/{runId}/stop",
      200,
      acceptedBody,
    );
    expect(acceptedBody).toEqual({
      ok: true,
      runId: receipt.runId,
      runStatus: "Abandoned",
      supervisorStopped: false,
    });
    const repeated = await stop();

    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({
      ok: true,
      runId: receipt.runId,
      runStatus: "Abandoned",
      supervisorStopped: false,
    });
    await revokeCompanyGrant(
      db,
      administratorId,
      cancellation.page.items[0].id,
      {
        expectedRevision: cancellation.page.items[0].revision,
        reason: "Withdraw cancellation authority before replay",
        idempotencyKey: randomUUID(),
      },
    );
    expect((await stop()).status).toBe(403);
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
        company_id: request.companyId,
        project_id: null,
        actor_type: "user",
        actor_id: responderId,
      },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.delete')",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    expect(
      (
        await database.pool.query(
          "SELECT status,revision FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ status: "active", revision: 3 });
  } finally {
    browserSession.user = null;
  }
});

it("CBS-02 uses the exact company binding runner and refuses its kill switch instead of choosing a ready platform default", async () => {
  const db: Db = database.db;
  const { hosts } = await fakeExecutionHosts(db);
  const runnerId = randomUUID();
  const roleId = "rah:runner-observer";
  const effective = await resolveInstalledAgentDefinition(db, {
    agentId: roleId,
    packageInstallId: assignmentInput.standingDefinition.packageInstallId,
  });

  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "binding-fixture",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  const binding = await createCompanySpecialistBinding(db, userId, roleId, {
    owner: { kind: "company", companyId: request.companyId },
    packageInstallId: effective.packageInstallId,
    packageRevision: effective.resolvedRevision!,
    definitionSha256: agentDefinitionSha256(effective.parsed),
    enabled: true,
    configuration: {},
    grantActions: [],
    runnerId,
    idempotencyKey: randomUUID(),
  });
  const assignment = await createSpecialistAssignment(db, userId, {
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
  const admission = {
    ...request,
    assignmentId: assignment.id,
    bindingId: binding.specialist.bindingId,
  };

  try {
    await db
      .update(platformAcpRunners)
      .set({ enabled: false })
      .where(eq(platformAcpRunners.id, runnerId));
    await expect(
      reserveCompanyAgentRun(db, userId, admission, hosts),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
    expect(
      (
        await database.pool.query(
          "SELECT status,revision FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ status: "queued", revision: 1 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM specialist_run_links WHERE assignment_id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    await db
      .update(platformAcpRunners)
      .set({ enabled: true })
      .where(eq(platformAcpRunners.id, runnerId));
    const receipt = await reserveCompanyAgentRun(db, userId, admission, hosts);

    expect(
      (
        await database.pool.query(
          "SELECT runner_id,runner_resolution_tier,runner_snapshot->>'model' AS model FROM run_sessions WHERE run_id=$1",
          [receipt.runId],
        )
      ).rows,
    ).toEqual([
      {
        runner_id: runnerId,
        runner_resolution_tier: "binding",
        model: "binding-fixture",
      },
    ]);
  } finally {
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
});

it("CBS-02 dispatches a company assignment through the existing owned agent driver and verifies its operational result", async () => {
  const db: Db = database.db;
  const fake = createFakeExecutionHost();
  const { prompts } = scriptAgentTurn(fake, {
    text:
      "```json maister:output\n" +
      JSON.stringify(operationalSuccessFixture()) +
      "\n```",
    onPrompt: ({ sessionId }) => {
      const session = fake.sessions.get(sessionId);

      if (!session)
        throw new Error("The scripted operational session was not created");
      fake.sessions.set(sessionId, {
        ...session,
        status: "exited",
        exitCode: 0,
        exitedAt: new Date().toISOString(),
      });

      return { stopReason: "end_turn", meta: null };
    },
  });
  const { hosts } = await fakeExecutionHosts(db, { fake });
  const runnerId = randomUUID();
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "company-driver-fixture",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  await db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId })
    .onConflictDoUpdate({
      target: platformRuntimeSettings.id,
      set: { defaultRunnerId: runnerId },
    });
  const assignment = await createSpecialistAssignment(
    db,
    userId,
    assignmentInput,
  );
  const receipt = await reserveCompanyAgentRun(
    db,
    userId,
    { ...request, assignmentId: assignment.id },
    hosts,
  );

  vi.stubEnv("MAISTER_MAX_CONCURRENT_AGENTS", "100");
  try {
    expect(await tryStartRun(receipt.runId, { db })).toMatchObject({
      started: true,
    });
    await publishRuntimeObject({
      client: await hosts.forRun(receipt.runId),
      kind: "generated_artifact",
      logicalName: "diagnosis.txt",
      mimeType: "text/plain",
      retentionClass: "run",
      bytes: new TextEncoder().encode("Bounded company diagnostic evidence"),
    });
    await fake.waitForCanonicalEvents();
    await startAgentSession(receipt.runId, { db, executionHosts: hosts });
    expect(fake.callsOf("createSession")).toHaveLength(1);
    expect(fake.callsOf("createSession")[0].envelope?.payload).toMatchObject({
      readOnlySession: true,
      agentKind: "operational",
      reapOnEndTurn: true,
      autoApprovePermissions: false,
    });
    expect(fake.callsOf("adoptWorkspace")[0].envelope?.payload).toMatchObject({
      projectSlug: "_company",
      owner: { kind: "company", companyId: request.companyId },
      kind: "directory",
    });
    expect(fake.callsOf("listSessions").length).toBeGreaterThan(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(assignmentInput.objectiveInput.objective);
    expect(prompts[0]).toContain(assignmentInput.objectiveInput.input);
    expect(prompts[0]).toContain(assignment.id);
    expect(prompts[0]).toContain("base");
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, receipt.runId));

    expect(run).toMatchObject({
      status: "Done",
      projectId: null,
      operationalIntegrityBaseline: {
        owner: {
          kind: "company",
          companyId: request.companyId,
          runId: receipt.runId,
        },
      },
    });
    const detail = await authorizePeekRun(userId, receipt.runId);

    expect(detail).toMatchObject({
      run: { id: receipt.runId, projectId: null, companyId: request.companyId },
      canReadTranscript: true,
    });
    const objects = await database.pool.query(
      "SELECT id FROM execution_runtime_objects WHERE run_id=$1 ORDER BY id",
      [receipt.runId],
    );

    expect(objects.rows.length).toBeGreaterThan(0);
    const object = await getRuntimeObjectForRun({
      db,
      runId: receipt.runId,
      objectId: objects.rows[0].id,
    });

    if (!object)
      throw new Error(
        "The completed company Run has no retained evidence object",
      );
    await expect(
      authorizeRuntimeObjectContentActor(object, userId),
    ).resolves.toBeUndefined();
    await expect(
      authorizeRuntimeObjectContentActor(object, administratorId),
    ).rejects.toMatchObject({
      details: { reason: "runtime_object_not_found" },
    });
    browserSession.user = await requireActiveUserById(userId);
    const stream = await streamGet(
      new NextRequest(`http://localhost/api/runs/${receipt.runId}/stream`),
      { params: Promise.resolve({ runId: receipt.runId }) },
    );

    expect(stream.status).toBe(200);
    expect(await stream.text()).toContain("session.command");
    browserSession.user = await requireActiveUserById(administratorId);
    const denied = await streamGet(
      new NextRequest(`http://localhost/api/runs/${receipt.runId}/stream`),
      { params: Promise.resolve({ runId: receipt.runId }) },
    );

    expect(denied.status).toBe(404);
    browserSession.user = null;
    expect(
      (
        await database.pool.query(
          "SELECT status,revision FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ status: "active", revision: 3 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM run_results WHERE run_id=$1 AND validity='valid'",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM project_tokens WHERE company_run_id=$1 AND revoked_at IS NULL",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
  } finally {
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
    await fake.waitForCanonicalEvents();
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
}, 60000);

it("CBS-02 refuses revoked current assignment authority after reservation before workspace or session effects", async () => {
  const db: Db = database.db;
  const { hosts, fake } = await fakeExecutionHosts(db);
  const initiatorId = randomUUID();
  const runnerId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [initiatorId, `${initiatorId}@example.test`],
  );
  await createCompanyGrants(db, administratorId, {
    principalKind: "user",
    principalId: initiatorId,
    actions: ["assignments:read", "assignments:update"],
    idempotencyKey: randomUUID(),
  });
  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "authority-fixture",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  await db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId })
    .onConflictDoUpdate({
      target: platformRuntimeSettings.id,
      set: { defaultRunnerId: runnerId },
    });
  const assignment = await createSpecialistAssignment(
    db,
    userId,
    assignmentInput,
  );
  const receipt = await reserveCompanyAgentRun(
    db,
    initiatorId,
    { ...request, assignmentId: assignment.id },
    hosts,
  );
  const updateGrant = (
    await database.pool.query(
      "SELECT id FROM company_grants WHERE principal_id=$1 AND action='assignments:update' AND revoked_at IS NULL",
      [initiatorId],
    )
  ).rows[0];

  await revokeCompanyGrant(db, administratorId, updateGrant.id, {
    expectedRevision: 1,
    reason: "Withdraw execution authority before dispatch",
    idempotencyKey: randomUUID(),
  });
  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    receipt.runId,
  ]);
  try {
    await startAgentSession(receipt.runId, { db, executionHosts: hosts });
    expect(fake.callsOf("createSession")).toHaveLength(0);
    expect(fake.callsOf("adoptWorkspace")).toHaveLength(0);
    expect(fake.callsOf("sendPrompt")).toHaveLength(0);
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, receipt.runId));
    const workspace = await operationalWorkspace(db, run);

    expect(run.status).toBe("Failed");
    await expect(lstat(workspace.cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (
        await database.pool.query(
          "SELECT input_revision,status FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ input_revision: 1, status: "active" });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM project_tokens WHERE company_run_id=$1",
          [receipt.runId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
  } finally {
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
});

it("CBS-02 refuses a frozen runner disabled after reservation and preserves the requested work", async () => {
  const db: Db = database.db;
  const { hosts, fake } = await fakeExecutionHosts(db);
  const runnerId = randomUUID();

  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: "disabled-after-reservation",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  await db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId })
    .onConflictDoUpdate({
      target: platformRuntimeSettings.id,
      set: { defaultRunnerId: runnerId },
    });
  const assignment = await createSpecialistAssignment(
    db,
    userId,
    assignmentInput,
  );
  const receipt = await reserveCompanyAgentRun(
    db,
    userId,
    { ...request, assignmentId: assignment.id },
    hosts,
  );

  await db
    .update(platformAcpRunners)
    .set({ enabled: false })
    .where(eq(platformAcpRunners.id, runnerId));
  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    receipt.runId,
  ]);
  try {
    await startAgentSession(receipt.runId, { db, executionHosts: hosts });
    expect(fake.callsOf("createSession")).toHaveLength(0);
    expect(fake.callsOf("adoptWorkspace")).toHaveLength(0);
    expect(
      (
        await database.pool.query("SELECT status FROM runs WHERE id=$1", [
          receipt.runId,
        ])
      ).rows[0],
    ).toEqual({ status: "Failed" });
    expect(
      (
        await database.pool.query(
          "SELECT status,input_revision FROM specialist_assignments WHERE id=$1",
          [assignment.id],
        )
      ).rows[0],
    ).toEqual({ status: "active", input_revision: 1 });
  } finally {
    resetResolverForTests();
    setDefaultTransportForTests(null);
  }
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

it("CBS-02 refuses assignment authority that differs from the reviewed specialist policy and accepts equivalent normalized policy", async () => {
  for (const executionPolicy of [
    { preset: "unattended" as const },
    {
      preset: "supervised" as const,
      overrides: { permissions: "auto_approve" as const },
    },
  ]) {
    const assignment = await createSpecialistAssignment(database.db, userId, {
      ...assignmentInput,
      executionPolicy,
    });

    await expect(
      database.db.transaction((tx) =>
        prepareCompanyAgentContext(tx, userId, {
          ...request,
          assignmentId: assignment.id,
        }),
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "company_assignment_policy_mismatch" },
    });
  }
  const assignment = await createSpecialistAssignment(database.db, userId, {
    ...assignmentInput,
    executionPolicy: { preset: "supervised", overrides: {} },
  });

  await expect(
    database.db.transaction((tx) =>
      prepareCompanyAgentContext(tx, userId, {
        ...request,
        assignmentId: assignment.id,
      }),
    ),
  ).resolves.toMatchObject({ assignment: { id: assignment.id } });
});

it.each([
  ["rah:repo-observer", "company_agent_workspace_unsupported"],
  ["rah:flow-coordinator", "company_coordinator_required"],
  ["rah:memory-observer", "company_agent_project_capability_unsupported"],
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

async function assertWebPostResponseContract(
  path: string,
  status: number,
  body: unknown,
): Promise<void> {
  const document: {
    components: Record<string, object>;
    paths: Record<
      string,
      {
        post: {
          responses: Record<
            string,
            { content: Record<string, { schema: object }> }
          >;
        };
      }
    >;
  } = parse(await readFile(resolve("../docs/api/web.openapi.yaml"), "utf8"));
  const validate = new Ajv({ strict: false, validateFormats: false }).compile({
    components: document.components,
    ...document.paths[path].post.responses[String(status)].content[
      "application/json"
    ].schema,
  });

  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}

async function retainCompanyFixtureRun(
  tx: SqlTransaction,
  context: Awaited<ReturnType<typeof prepareCompanyAgentContext>>,
  runId: string,
): Promise<CompanyAgentExecutionSnapshot> {
  const roleId = context.effective.parsed.id;
  const snapshot = captureCompanyAgentExecution(context);
  const result = buildOperationalContract(context.effective);

  await tx.execute(sql`INSERT INTO runs(id,run_kind,company_id,company_execution_snapshot,agent_id,source_agent_id,agent_kind,agent_workspace,flow_version,flow_revision,status,result_contract,created_by_user_id,launched_at,activity_sort_at,activity_timestamp_provenance,agent_config,execution_policy,agent_activity_snapshot)
    VALUES(${runId},'agent',${context.owner.companyId},${JSON.stringify(snapshot)}::jsonb,${roleId},${roleId},'operational','none','agent','manual','Pending',${JSON.stringify(result)}::jsonb,${userId},now(),now(),'launch',${JSON.stringify(context.binding.snapshot.effectiveConfiguration)}::jsonb,${JSON.stringify(context.binding.snapshot.executionPolicy)}::jsonb,${JSON.stringify(buildAgentActivitySnapshot(roleId, context.effective))}::jsonb)`);

  return snapshot;
}

async function reserveCompanyFixtureRun(
  input: PreparedSpecialistAssignment = assignmentInput,
): Promise<
  Readonly<{
    runId: string;
    assignmentId: string;
    snapshot: CompanyAgentExecutionSnapshot;
  }>
> {
  const assignment = await createSpecialistAssignment(
    database.db,
    userId,
    input,
  );
  const runId = randomUUID();
  const prepared = await database.db.transaction(async (tx) => {
    const context = await prepareCompanyAgentContext(tx, userId, {
      ...request,
      assignmentId: assignment.id,
      bindingId: input.specialistBindingId,
    });
    const snapshot = await retainCompanyFixtureRun(tx, context, runId);

    await linkSpecialistAssignmentRunInTransaction(tx, userId, assignment.id, {
      expectedRevision: 1,
      inputRevision: 1,
      runId,
      role: "specialist",
      work: null,
    });

    return snapshot;
  });

  return {
    runId,
    assignmentId: assignment.id,
    snapshot: prepared,
  };
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

it("CBS-02 retains company human work in the existing assignment/actor ledger and refuses a foreign project actor", async () => {
  const { runId, snapshot } = await reserveCompanyFixtureRun();
  const hitlRequestId = randomUUID();

  await database.db.transaction(async (tx) => {
    await createHitlRequest(tx, {
      id: hitlRequestId,
      runId,
      stepId: "agent",
      kind: "permission",
      prompt: "Review the bounded diagnostic permission",
      schema: {
        requestId: randomUUID(),
        supervisorSessionId: randomUUID(),
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      },
    });
  });
  const human = await createHitlAssignmentForRun({
    db: database.db,
    runId,
    hitlRequestId,
    actionKind: "permission",
    title: "Review diagnostic permission",
  });

  expect(human).toMatchObject({
    projectId: null,
    companyId: request.companyId,
    runId,
    hitlRequestId,
    status: "open",
    taskId: null,
  });
  await expect(
    completeHitlAssignmentFromCurrentActor({ db: database.db, hitlRequestId }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "company_human_actor_missing" },
  });
  const actor = await ensureCompanyUserActor({
    db: database.db,
    companyId: request.companyId,
    userId,
    label: "Authorized company operator",
  });
  const replayActor = await ensureCompanyUserActor({
    db: database.db,
    companyId: request.companyId,
    userId,
    label: "Authorized company operator",
  });

  expect(replayActor.id).toBe(actor.id);
  const project = await seedProjectRow(database.db);
  const foreignActor = await ensureUserActor({
    db: database.db,
    projectId: project.id,
    userId,
  });

  await expect(
    claimAssignment({
      db: database.db,
      assignmentId: human.id,
      actorId: foreignActor.id,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    claimAssignment({
      db: database.db,
      assignmentId: human.id,
      actorId: actor.id,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [
          {
            kind: "assignment_input",
            assignmentId: snapshot.assignment.id,
            inputRevision: snapshot.assignment.inputRevision,
            inputSha256: snapshot.assignment.inputSha256,
          },
        ],
      }),
    ],
  );
  const answerGrant = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["assignments:answer"],
    idempotencyKey: randomUUID(),
  });

  browserSession.user = await requireActiveUserById(userId);
  const diagnosticLines: string[] = [];
  const diagnosticLog = pino(
    { level: "debug" },
    new Writable({
      write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        done: (error?: Error | null) => void,
      ) {
        diagnosticLines.push(chunk.toString());
        done();
      },
    }),
  );

  await database.pool.query(
    "CREATE FUNCTION fail_company_human_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id IS NOT NULL AND NEW.status='claimed' THEN RAISE EXCEPTION 'private-company-claim-witness'; END IF; RETURN NEW; END $$",
  );
  await database.pool.query(
    "CREATE TRIGGER fail_company_human_claim BEFORE UPDATE ON assignments FOR EACH ROW EXECUTE FUNCTION fail_company_human_claim()",
  );
  try {
    const refused = await handleAssignmentAction({
      req: new NextRequest(
        `http://localhost/api/assignments/${human.id}/claim`,
        { method: "POST" },
      ),
      routeParams: { params: Promise.resolve({ assignmentId: human.id }) },
      actionName: "company claim diagnostic probe",
      log: diagnosticLog,
      run: ({ db, assignmentId, actor: responseActor }) =>
        claimAssignment({ db, assignmentId, actorId: responseActor.id }),
    });

    expect(refused.status).toBe(500);
    expect(diagnosticLines.join("")).not.toContain("Failed query:");
    expect(diagnosticLines.join("")).not.toContain(
      "private-company-claim-witness",
    );
    expect(diagnosticLines.join("")).toContain('"sqlState":"P0001"');
    expect(
      (
        await database.pool.query(
          "SELECT status FROM assignments WHERE id=$1",
          [human.id],
        )
      ).rows[0],
    ).toEqual({ status: "open" });
  } finally {
    await database.pool.query(
      "DROP TRIGGER fail_company_human_claim ON assignments",
    );
    await database.pool.query("DROP FUNCTION fail_company_human_claim()");
  }
  const claimed = await claimHumanAssignmentPost(
    new NextRequest(`http://localhost/api/assignments/${human.id}/claim`, {
      method: "POST",
    }),
    { params: Promise.resolve({ assignmentId: human.id }) },
  );

  expect(claimed.status).toBe(200);
  const claimedBody: unknown = await claimed.json();

  expect(claimedBody).toMatchObject({
    projectId: null,
    companyId: request.companyId,
    status: "claimed",
    assigneeActor: { id: actor.id, kind: "user" },
  });
  const contract: { components: { schemas: Record<string, object> } } = parse(
    await readFile(resolve("../docs/api/web.openapi.yaml"), "utf8"),
  );
  const validate = new Ajv({ strict: false, validateFormats: false }).compile({
    components: contract.components,
    $ref: "#/components/schemas/Assignment",
  });

  expect(validate(claimedBody), JSON.stringify(validate.errors)).toBe(true);
  browserSession.user = null;
  await revokeCompanyGrant(
    database.db,
    administratorId,
    answerGrant.page.items[0].id,
    {
      expectedRevision: 1,
      reason: "Withdraw company answer authority",
      idempotencyKey: randomUUID(),
    },
  );
  await expect(
    completeAssignment({
      db: database.db,
      assignmentId: human.id,
      actorId: actor.id,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["assignments:answer"],
    idempotencyKey: randomUUID(),
  });
  await expect(
    completeAssignment({
      db: database.db,
      assignmentId: human.id,
      actorId: actor.id,
    }),
  ).resolves.toMatchObject({
    status: "completed",
    completedByActorId: actor.id,
  });
  const events = (
    await database.pool.query(
      "SELECT company_id,project_id,run_id,actor_id,event_kind FROM assignment_events WHERE assignment_id=$1 ORDER BY created_at,id",
      [human.id],
    )
  ).rows;

  expect(events.map((event) => event.event_kind).sort()).toEqual([
    "claimed",
    "completed",
    "created",
  ]);
  expect(
    events.every(
      (event) =>
        event.company_id === request.companyId &&
        event.project_id === null &&
        event.run_id === runId,
    ),
  ).toBe(true);
  expect(
    events
      .filter((event) => event.event_kind !== "created")
      .every((event) => event.actor_id === actor.id),
  ).toBe(true);
  await expect(
    database.pool.query(
      "UPDATE assignments SET assignee_actor_id=$2 WHERE id=$1",
      [human.id, foreignActor.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "human_assignment_actor_owner",
  });
  await expect(
    database.pool.query(
      "UPDATE assignments SET project_id=$2,company_id=NULL WHERE id=$1",
      [human.id, project.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "human_assignment_owner_immutable",
  });
  await expect(
    database.pool.query(
      "UPDATE assignment_events SET project_id=$2,company_id=NULL WHERE assignment_id=$1",
      [human.id, project.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "human_assignment_event_immutable",
  });
  await expect(
    database.pool.query("UPDATE actor_identities SET user_id=$2 WHERE id=$1", [
      actor.id,
      administratorId,
    ]),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "human_actor_principal_immutable",
  });
  const cancelledHitlId = randomUUID();

  await database.db.transaction(async (tx) => {
    await createHitlRequest(tx, {
      id: cancelledHitlId,
      runId,
      stepId: "agent",
      kind: "permission",
      prompt: "Cancelled by lifecycle",
      schema: {
        requestId: randomUUID(),
        supervisorSessionId: randomUUID(),
        options: [],
      },
    });
  });
  const cancelledHuman = await createHitlAssignmentForRun({
    db: database.db,
    runId,
    hitlRequestId: cancelledHitlId,
    actionKind: "permission",
    title: "Cancelled company work",
  });

  await expect(
    systemCloseActiveAssignmentsForRun({
      db: database.db,
      runId,
      reason: "Company wait ended",
    }),
  ).resolves.toMatchObject([
    {
      id: cancelledHuman.id,
      status: "cancelled",
      companyId: request.companyId,
      projectId: null,
    },
  ]);
  expect(
    (
      await database.pool.query(
        "SELECT actor.kind,actor.company_id FROM assignment_events event JOIN actor_identities actor ON actor.id=event.actor_id WHERE event.assignment_id=$1 AND event.event_kind='system_closed'",
        [cancelledHuman.id],
      )
    ).rows[0],
  ).toEqual({ kind: "system", company_id: request.companyId });
  await database.pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
  expect(
    (
      await database.pool.query("SELECT status FROM assignments WHERE id=$1", [
        human.id,
      ])
    ).rows[0],
  ).toEqual({ status: "completed" });
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

it("CBS-02 authorizes only the executing specialist's exact assignment input without implying Company Brain read access", async () => {
  const { runId, snapshot } = await reserveCompanyFixtureRun();
  const reference = {
    kind: "assignment_input" as const,
    assignmentId: snapshot.assignment.id,
    inputRevision: snapshot.assignment.inputRevision,
    inputSha256: snapshot.assignment.inputSha256,
  };

  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [reference],
      }),
    ],
  );
  await expect(
    assertNativeRunKnowledgeInputs(database.db, runId),
  ).resolves.toBeUndefined();
  await expect(
    authorizeSourceRestrictions(
      database.db,
      { kind: "execution", runId, nodeAttemptId: null },
      [{ kind: "company", companyId: request.companyId }],
    ),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  const other = await reserveCompanyFixtureRun();

  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      other.runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [reference],
      }),
    ],
  );
  await expect(
    assertNativeRunKnowledgeInputs(database.db, other.runId),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  for (const changed of [
    { ...reference, inputRevision: 2 },
    { ...reference, inputSha256: "0".repeat(64) },
  ]) {
    await expect(
      authorizeSourceRestrictions(database.db, { kind: "user", userId }, [
        changed,
      ]),
    ).rejects.toMatchObject({
      details: { reason: "knowledge_reference_unavailable" },
    });
  }
});

async function reserveContextFixture(
  roleId: string,
  actions: readonly CompanyAction[],
): Promise<
  Awaited<ReturnType<typeof reserveCompanyFixtureRun>> & {
    credential: Awaited<ReturnType<typeof issueCompanyAgentRunToken>>;
  }
> {
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
      grantActions: [...actions],
      idempotencyKey: randomUUID(),
    },
  );
  const input: PreparedSpecialistAssignment = {
    ...assignmentInput,
    specialistBindingId: binding.specialist.bindingId,
    responsibleAgentId: roleId,
    standingDefinition: {
      ...assignmentInput.standingDefinition,
      agentId: roleId,
      definition: effective.parsed,
      definitionSha256: agentDefinitionSha256(effective.parsed),
    },
  };
  const assignment = await createSpecialistAssignment(
    database.db,
    userId,
    input,
  );
  const runId = randomUUID();
  const snapshot = await database.db.transaction(async (tx) => {
    const context = await prepareCompanyAgentContext(tx, userId, {
      ...request,
      assignmentId: assignment.id,
      bindingId: input.specialistBindingId,
    });
    const snapshot = await retainCompanyFixtureRun(tx, context, runId);

    await activateInitialSpecialistAssignmentRunInTransaction(
      tx,
      userId,
      assignment.id,
      { runId, inputRevision: 1, expectedRevision: 1, role: "specialist" },
    );

    return snapshot;
  });
  const appointment = { runId, assignmentId: assignment.id, snapshot };

  await database.pool.query(
    "UPDATE runs SET status='Running',knowledge_access=$2::jsonb WHERE id=$1",
    [
      appointment.runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [
          {
            kind: "assignment_input",
            assignmentId: appointment.assignmentId,
            inputRevision: 1,
            inputSha256: appointment.snapshot.assignment.inputSha256,
          },
        ],
      }),
    ],
  );
  const credential = await issueCompanyAgentRunToken({
    db: database.db,
    runId: appointment.runId,
  });

  return { ...appointment, credential };
}

it("IT-CBA-04 discloses only the appointed company context through a scoped actual credential without granting Brain access", async () => {
  const appointment = await reserveContextFixture("rah:context-observer", [
    "assignments:read",
  ]);
  const { credential } = appointment;
  const foreign = await reserveCompanyFixtureRun();

  await appendSpecialistAssignmentContext(
    database.db,
    userId,
    appointment.assignmentId,
    {
      expectedRevision: 0,
      expectedInputRevision: 1,
      idempotencyKey: randomUUID(),
      updates: [
        {
          id: "diagnosis-question",
          kind: "question",
          text: "Which health observation is still missing?",
          state: "open",
          references: [],
        },
      ],
    },
  );
  const read = (assignmentId: string, secret: string = credential.secret) =>
    externalContextGet(
      new NextRequest(
        `http://localhost/api/v1/ext/specialist-assignments/${assignmentId}/context`,
        { headers: { Authorization: `Bearer ${secret}` } },
      ),
      { params: Promise.resolve({ assignmentId }) },
    );

  try {
    const response = await read(appointment.assignmentId);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      assignmentId: appointment.assignmentId,
      revision: 1,
      entries: [
        {
          entry: { id: "diagnosis-question" },
          actor: { kind: "user", id: userId },
          ownerEpoch: null,
        },
      ],
    });
    const withheld = await read(foreign.assignmentId);

    expect(withheld.status).toBe(404);
    expect(await withheld.json()).toMatchObject({
      details: { reason: "knowledge_reference_unavailable" },
    });
    const actor = await verifyToken(credential.secret, database.db);

    expect(actor.scopes).toEqual(["assignments:read"]);
    await expect(
      authorizeSourceRestrictions(
        database.db,
        { kind: "execution", runId: appointment.runId, nodeAttemptId: null },
        [{ kind: "company", companyId: request.companyId }],
      ),
    ).rejects.toMatchObject({
      details: { reason: "knowledge_reference_unavailable" },
    });
    await database.pool.query(
      "UPDATE project_tokens SET revoked_at=now() WHERE id=$1",
      [credential.tokenId],
    );
    expect((await read(appointment.assignmentId)).status).toBe(401);
  } finally {
    await revokeAgentRunTokensForRun(appointment.runId, database.db);
  }
});

it("IT-CBE-06 captures context sources before disclosure and retains revocation after citation-free supersession", async () => {
  const appointment = await reserveContextFixture(
    "rah:context-source-observer",
    ["assignments:read", "knowledge:read"],
  );
  const userGrant = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["knowledge:read"],
    idempotencyKey: randomUUID(),
  });
  const professionalGrant = await createCompanyGrants(
    database.db,
    administratorId,
    {
      principalKind: "agent",
      principalId: "rah:context-source-observer",
      actions: ["knowledge:read"],
      idempotencyKey: randomUUID(),
    },
  );
  const recordId = randomUUID();
  const read = () =>
    externalContextGet(
      new NextRequest(
        `http://localhost/api/v1/ext/specialist-assignments/${appointment.assignmentId}/context`,
        {
          headers: { Authorization: `Bearer ${appointment.credential.secret}` },
        },
      ),
      { params: Promise.resolve({ assignmentId: appointment.assignmentId }) },
    );

  try {
    await database.pool.query(
      "INSERT INTO brain_items(id,company_id,kind,title,content,confidence,content_hash) VALUES($1,$2,'observation','Private context observation','Sensitive observed component state',0.9,$3)",
      [recordId, request.companyId, randomUUID()],
    );
    const witness = (
      await database.pool.query<{ content_sha256: string }>(
        "SELECT content_sha256 FROM brain_record_revisions WHERE record_id=$1 AND revision=1",
        [recordId],
      )
    ).rows[0]!;

    await appendSpecialistAssignmentContext(
      database.db,
      userId,
      appointment.assignmentId,
      {
        expectedRevision: 0,
        expectedInputRevision: 1,
        idempotencyKey: randomUUID(),
        updates: [
          {
            id: "observed-source",
            kind: "source",
            text: "Sensitive observed component state",
            state: "open",
            references: [
              {
                kind: "knowledge",
                id: recordId,
                revision: 1,
                sha256: witness.content_sha256,
              },
            ],
          },
        ],
      },
    );
    const response = await read();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revision: 1,
      entries: [{ entry: { id: "observed-source" } }],
    });
    const capture = (
      await database.pool.query<{
        knowledge_access: { restrictions: unknown[] };
      }>("SELECT knowledge_access FROM runs WHERE id=$1", [appointment.runId])
    ).rows[0]!.knowledge_access;

    expect(capture.restrictions).toEqual(
      expect.arrayContaining([{ kind: "record", recordId }]),
    );
    await appendSpecialistAssignmentContext(
      database.db,
      userId,
      appointment.assignmentId,
      {
        expectedRevision: 1,
        expectedInputRevision: 1,
        idempotencyKey: randomUUID(),
        updates: [
          {
            id: "derived-without-citation",
            supersedesEntryId: "observed-source",
            kind: "hypothesis",
            text: "An inferred diagnosis without a repeated citation",
            state: "open",
            references: [],
          },
        ],
      },
    );
    expect((await read()).status).toBe(200);
    const professional = professionalGrant.page.items.find(
      (item) => item.action === "knowledge:read",
    )!;

    await revokeCompanyGrant(database.db, administratorId, professional.id, {
      expectedRevision: professional.revision,
      reason: "Withdraw access after context disclosure",
      idempotencyKey: randomUUID(),
    });
    const denied = await read();

    expect(denied.status).toBe(404);
    expect(JSON.stringify(await denied.json())).not.toContain(
      "inferred diagnosis",
    );
    await expect(
      assertNativeRunKnowledgeInputs(database.db, appointment.runId),
    ).rejects.toMatchObject({
      details: { reason: "knowledge_reference_unavailable" },
    });
  } finally {
    await revokeAgentRunTokensForRun(appointment.runId, database.db);
    const grant = userGrant.page.items.find(
      (item) => item.action === "knowledge:read",
    )!;

    await revokeCompanyGrant(database.db, administratorId, grant.id, {
      expectedRevision: grant.revision,
      reason: "Release owned context qualification authority",
      idempotencyKey: randomUUID(),
    });
  }
});

it("IT-CBA-04 attributes agent context edits to the current execution and refuses races, forged authorship and revoked mutation authority", async () => {
  const appointment = await reserveContextFixture("rah:context-writer", [
    "assignments:read",
    "assignments:update",
    "knowledge:read",
  ]);
  const grant = await createCompanyGrants(database.db, administratorId, {
    principalKind: "agent",
    principalId: "rah:context-writer",
    actions: ["assignments:update"],
    idempotencyKey: randomUUID(),
  });
  const sourceUserGrant = await createCompanyGrants(
    database.db,
    administratorId,
    {
      principalKind: "user",
      principalId: userId,
      actions: ["knowledge:read"],
      idempotencyKey: randomUUID(),
    },
  );
  const sourceAgentGrant = await createCompanyGrants(
    database.db,
    administratorId,
    {
      principalKind: "agent",
      principalId: "rah:context-writer",
      actions: ["knowledge:read"],
      idempotencyKey: randomUUID(),
    },
  );
  const recordId = randomUUID();
  let credential = appointment.credential;
  const url = `http://localhost/api/v1/ext/specialist-assignments/${appointment.assignmentId}/context`;
  const patch = (body: unknown) =>
    externalContextPatch(
      new NextRequest(url, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${credential.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ assignmentId: appointment.assignmentId }) },
    );
  const value = {
    expectedRevision: 0,
    expectedInputRevision: 1,
    idempotencyKey: randomUUID(),
    updates: [
      {
        id: "initial-diagnosis",
        kind: "hypothesis",
        text: "Inspection still needs an independent health observation",
        state: "open",
        references: [],
      },
    ],
  };

  try {
    await database.pool.query(
      "INSERT INTO brain_items(id,company_id,kind,title,content,confidence,content_hash) VALUES($1,$2,'observation','Private learned source','A source read before the uncited working note',0.9,$3)",
      [recordId, request.companyId, randomUUID()],
    );
    await getKnowledgeRecord(
      database.db,
      { kind: "token", tokenId: appointment.credential.tokenId },
      { recordId, revision: 1 },
    );
    const response = await patch(value);

    expect(response.status).toBe(200);
    const first = await response.json();

    expect(first).toMatchObject({
      revision: 1,
      entries: [
        {
          actor: {
            kind: "agent",
            id: "rah:context-writer",
            runId: appointment.runId,
            attemptId: null,
          },
          introducedRevision: 1,
          ownerEpoch: null,
        },
      ],
    });
    expect(
      (
        await database.pool.query(
          "SELECT actor_type,actor_id,run_id,payload->'originExecution' AS origin_execution FROM domain_events WHERE kind='specialist.assignment_changed' AND payload->>'assignmentId'=$1 AND payload->>'cause'='context' ORDER BY id",
          [appointment.assignmentId],
        )
      ).rows,
    ).toEqual([
      {
        actor_type: "agent",
        actor_id: "rah:context-writer",
        run_id: null,
        origin_execution: { runId: appointment.runId, nodeAttemptId: null },
      },
    ]);
    const eventContract = parse(
      await readFile(
        resolve("../docs/api/async/operational-lifecycle.asyncapi.yaml"),
        "utf8",
      ),
    ) as {
      components: {
        messages: { SpecialistAssignmentChanged: { payload: object } };
      };
    };
    const validateEvent = new Ajv({
      strict: false,
      validateFormats: false,
    }).compile(
      eventContract.components.messages.SpecialistAssignmentChanged.payload,
    );
    const eventPayload = (
      await database.pool.query<{ payload: unknown }>(
        "SELECT payload FROM domain_events WHERE kind='specialist.assignment_changed' AND payload->>'assignmentId'=$1 AND payload->>'cause'='context' ORDER BY id",
        [appointment.assignmentId],
      )
    ).rows[0]!.payload;

    expect(
      validateEvent(eventPayload),
      JSON.stringify(validateEvent.errors),
    ).toBe(true);
    const restrictions = (
      await database.pool.query<{ source_restrictions: unknown[] }>(
        "SELECT source_restrictions FROM specialist_context_revisions WHERE assignment_id=$1 AND revision=1",
        [appointment.assignmentId],
      )
    ).rows[0]!.source_restrictions;

    expect(restrictions).toEqual(
      expect.arrayContaining([{ kind: "record", recordId }]),
    );
    credential = await issueCompanyAgentRunToken({
      db: database.db,
      runId: appointment.runId,
    });
    const repeated = await patch(value);

    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(first);
    expect(
      (
        await patch({
          ...value,
          updates: [{ ...value.updates[0]!, text: "Different bytes" }],
        })
      ).status,
    ).toBe(409);
    expect(
      (await patch({ ...value, actor: { kind: "user", id: userId } })).status,
    ).toBe(422);
    const racers = await Promise.all(
      ["left", "right"].map((id) =>
        patch({
          expectedRevision: 1,
          expectedInputRevision: 1,
          idempotencyKey: randomUUID(),
          updates: [
            {
              id,
              kind: "question",
              text: "Which observation follows?",
              state: "open",
              references: [],
            },
          ],
        }),
      ),
    );

    expect(racers.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const authority = grant.page.items.find(
      (item) => item.action === "assignments:update",
    )!;

    await revokeCompanyGrant(database.db, administratorId, authority.id, {
      expectedRevision: authority.revision,
      reason: "Withdraw context mutation authority",
      idempotencyKey: randomUUID(),
    });
    expect(
      (
        await patch({
          expectedRevision: 2,
          expectedInputRevision: 1,
          idempotencyKey: randomUUID(),
          updates: [
            {
              id: "stale-authority",
              kind: "decision",
              text: "Cannot persist this decision",
              state: "open",
              references: [],
            },
          ],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM specialist_context_revisions WHERE assignment_id=$1",
          [appointment.assignmentId],
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
    const visible = await externalContextGet(
      new NextRequest(url, {
        headers: { Authorization: `Bearer ${credential.secret}` },
      }),
      { params: Promise.resolve({ assignmentId: appointment.assignmentId }) },
    );

    expect(visible.status).toBe(200);
  } finally {
    await revokeAgentRunTokensForRun(appointment.runId, database.db);
    for (const receipt of [sourceUserGrant, sourceAgentGrant]) {
      const sourceGrant = receipt.page.items.find(
        (item) => item.action === "knowledge:read",
      )!;

      await revokeCompanyGrant(database.db, administratorId, sourceGrant.id, {
        expectedRevision: sourceGrant.revision,
        reason: "Release owned writer source authority",
        idempotencyKey: randomUUID(),
      });
    }
  }
});

it("CBS-02 reads retained company execution content under current explicit reader authority independently of specialist availability", async () => {
  const { runId, snapshot } = await reserveCompanyFixtureRun();
  const unavailable = { details: { reason: "run_unavailable" } };

  // Historical rows without a complete source capture cannot release content.
  await expect(authorizePeekRun(userId, runId)).rejects.toMatchObject(
    unavailable,
  );
  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [
          {
            kind: "assignment_input",
            assignmentId: snapshot.assignment.id,
            inputRevision: snapshot.assignment.inputRevision,
            inputSha256: snapshot.assignment.inputSha256,
          },
        ],
      }),
    ],
  );
  await expect(authorizePeekRun(userId, runId)).resolves.toMatchObject({
    run: { id: runId, companyId: request.companyId, projectId: null },
    canReadTranscript: true,
  });
  await expect(authorizePeekRun(administratorId, runId)).rejects.toMatchObject(
    unavailable,
  );
  await expect(authorizePeekRun(userId, randomUUID())).rejects.toMatchObject(
    unavailable,
  );
  await database.pool.query("UPDATE agents SET enabled=false WHERE id=$1", [
    agentId,
  ]);
  try {
    await expect(authorizePeekRun(userId, runId)).resolves.toMatchObject({
      canReadTranscript: true,
    });
  } finally {
    await database.pool.query("UPDATE agents SET enabled=true WHERE id=$1", [
      agentId,
    ]);
  }
  const readerId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [readerId, `${readerId}@example.test`],
  );
  await expect(authorizePeekRun(readerId, runId)).rejects.toMatchObject(
    unavailable,
  );
  const grants = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: readerId,
    actions: ["assignments:read"],
    idempotencyKey: randomUUID(),
  });

  await expect(authorizePeekRun(readerId, runId)).resolves.toMatchObject({
    canReadTranscript: true,
  });
  browserSession.user = await requireActiveUserById(readerId);
  const stream = await streamGet(
    new NextRequest(`http://localhost/api/runs/${runId}/stream?replay=false`, {
      signal: AbortSignal.timeout(10000),
    }),
    { params: Promise.resolve({ runId }) },
  );

  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();

  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    "session.stream_ready",
  );
  await revokeCompanyGrant(
    database.db,
    administratorId,
    grants.page.items[0].id,
    {
      expectedRevision: grants.page.items[0].revision,
      reason: "Withdraw historical Run access",
      idempotencyKey: randomUUID(),
    },
  );
  await expect(authorizePeekRun(readerId, runId)).rejects.toMatchObject(
    unavailable,
  );
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  reader.releaseLock();
  browserSession.user = null;
});

it("CBS-02 pages company history under current source authority before LIMIT and binds the existing cursor to its reader", async () => {
  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), project.id, userId],
  );
  const first = await reserveCompanyFixtureRun();
  const second = await reserveCompanyFixtureRun();
  const hidden = await reserveCompanyFixtureRun({
    ...assignmentInput,
    sourceRestrictions: [{ kind: "project_context", projectId: project.id }],
  });

  for (const fixture of [first, second, hidden]) {
    await database.pool.query(
      "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
      [
        fixture.runId,
        JSON.stringify({
          schemaVersion: 1,
          state: "complete",
          generation: 1,
          restrictions: [
            {
              kind: "assignment_input",
              assignmentId: fixture.snapshot.assignment.id,
              inputRevision: fixture.snapshot.assignment.inputRevision,
              inputSha256: fixture.snapshot.assignment.inputSha256,
            },
          ],
        }),
      ],
    );
  }
  await database.pool.query(
    "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
    [project.id, userId],
  );
  const page = await getCompanyAgentRunHistory(database.db, userId, {
    agentId,
    limit: 2,
  });

  expect(page.items.map((item) => item.runId)).toEqual([
    second.runId,
    first.runId,
  ]);
  expect(page.nextCursor).not.toBeNull();
  const later = await reserveCompanyFixtureRun();

  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      later.runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [
          {
            kind: "assignment_input",
            assignmentId: later.snapshot.assignment.id,
            inputRevision: later.snapshot.assignment.inputRevision,
            inputSha256: later.snapshot.assignment.inputSha256,
          },
        ],
      }),
    ],
  );
  const next = await getCompanyAgentRunHistory(database.db, userId, {
    agentId,
    limit: 2,
    cursor: page.nextCursor!,
  });

  expect(next.asOf).toBe(page.asOf);
  expect(
    next.items.every(
      (item) =>
        ![first.runId, second.runId, hidden.runId, later.runId].includes(
          item.runId,
        ),
    ),
  ).toBe(true);
  await expect(
    getCompanyAgentRunHistory(database.db, administratorId, { agentId }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    getCompanyAgentRunHistory(database.db, userId, {
      agentId,
      status: "Done",
      cursor: page.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await expect(
    getCompanyAgentRunHistory(database.db, userId, { agentId: "absent:role" }),
  ).resolves.toMatchObject({ items: [], nextCursor: null });
  browserSession.user = await requireActiveUserById(userId);
  const response = await companyHistoryGet(
    new NextRequest(`http://localhost/api/specialists/${agentId}/runs?limit=2`),
    { params: Promise.resolve({ specialistId: agentId }) },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body: unknown = await response.json();
  const document: {
    components: { schemas: Record<string, object> };
    paths: Record<
      string,
      {
        get: {
          responses: Record<
            string,
            { content: Record<string, { schema: object }> }
          >;
        };
      }
    >;
  } = parse(await readFile(resolve("../docs/api/web.openapi.yaml"), "utf8"));
  const validate = new Ajv({ strict: false, validateFormats: false }).compile({
    components: document.components,
    ...document.paths["/api/specialists/{specialistId}/runs"].get.responses[
      "200"
    ].content["application/json"].schema,
  });

  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(JSON.stringify(body)).not.toContain(hidden.runId);
  for (const query of [
    "limit=1&limit=2",
    "limit=101",
    "status=invalid",
    "companyId=forged",
    "userId=forged",
    "projectId=forged",
  ]) {
    const refused = await companyHistoryGet(
      new NextRequest(
        `http://localhost/api/specialists/${agentId}/runs?${query}`,
      ),
      { params: Promise.resolve({ specialistId: agentId }) },
    );

    expect(refused.status).toBe(400);
  }
  browserSession.user = await requireActiveUserById(administratorId);
  expect(
    (
      await companyHistoryGet(
        new NextRequest(`http://localhost/api/specialists/${agentId}/runs`),
        { params: Promise.resolve({ specialistId: agentId }) },
      )
    ).status,
  ).toBe(403);
  browserSession.user = null;
  const readerId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [readerId, `${readerId}@example.test`],
  );
  const granted = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: readerId,
    actions: ["assignments:read"],
    idempotencyKey: randomUUID(),
  });

  await expect(
    getCompanyAgentRunHistory(database.db, readerId, {
      agentId,
      cursor: page.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  const readerPage = await getCompanyAgentRunHistory(database.db, readerId, {
    agentId,
    limit: 1,
  });

  expect(readerPage.nextCursor).not.toBeNull();
  await revokeCompanyGrant(
    database.db,
    administratorId,
    granted.page.items[0].id,
    {
      expectedRevision: 1,
      reason: "Withdraw history access",
      idempotencyKey: randomUUID(),
    },
  );
  await expect(
    getCompanyAgentRunHistory(database.db, readerId, {
      agentId,
      cursor: readerPage.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: readerId,
    actions: ["assignments:read"],
    idempotencyKey: randomUUID(),
  });
  await expect(
    getCompanyAgentRunHistory(database.db, readerId, {
      agentId,
      cursor: readerPage.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await database.pool.query("UPDATE agents SET enabled=false WHERE id=$1", [
    agentId,
  ]);
  try {
    await expect(
      getCompanyAgentRunHistory(database.db, userId, { agentId, limit: 1 }),
    ).resolves.toMatchObject({ items: [{ runId: later.runId }] });
  } finally {
    await database.pool.query("UPDATE agents SET enabled=true WHERE id=$1", [
      agentId,
    ]);
  }
});

it("CBS-02 preserves nested assignment source restrictions and lets the source project be deleted without Brain blocking it", async () => {
  const project = await seedProjectRow(database.db);

  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), project.id, userId],
  );
  const { runId, snapshot } = await reserveCompanyFixtureRun({
    ...assignmentInput,
    sourceRestrictions: [{ kind: "project_context", projectId: project.id }],
  });
  const reference = {
    kind: "assignment_input" as const,
    assignmentId: snapshot.assignment.id,
    inputRevision: snapshot.assignment.inputRevision,
    inputSha256: snapshot.assignment.inputSha256,
  };
  const human = { kind: "user" as const, userId };

  await expect(
    authorizeSourceRestrictions(database.db, human, [reference]),
  ).resolves.toMatchObject({
    visited: expect.arrayContaining([
      expect.stringContaining("project_context:"),
    ]),
  });
  const humanCanRead = async (): Promise<boolean> =>
    database.db.transaction(async (tx) => {
      const identity = await resolveKnowledgePrincipal(
        tx,
        human,
        "knowledge:read",
      );

      return z
        .boolean()
        .parse(
          (
            await tx.execute(
              sql`SELECT ${knowledgeSourceReadPolicy(identity, sql`${JSON.stringify(reference)}::jsonb`)} AS readable`,
            )
          ).rows[0].readable,
        );
    });

  expect(await humanCanRead()).toBe(true);
  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [reference],
      }),
    ],
  );
  await expect(authorizePeekRun(userId, runId)).resolves.toMatchObject({
    canReadTranscript: true,
  });
  await expect(
    assertNativeRunKnowledgeInputs(database.db, runId),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  await database.pool.query(
    "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
    [project.id, userId],
  );
  expect(await humanCanRead()).toBe(false);
  await expect(authorizePeekRun(userId, runId)).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  await expect(
    authorizeSourceRestrictions(database.db, human, [reference]),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  await database.pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
  expect(await humanCanRead()).toBe(false);
  expect(
    (
      await database.pool.query(
        "SELECT input_revision FROM specialist_assignments WHERE id=$1",
        [snapshot.assignment.id],
      )
    ).rows[0],
  ).toEqual({ input_revision: 1 });
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
        restrictions: [
          {
            kind: "assignment_input",
            assignmentId: prepared.assignment.id,
            inputRevision: prepared.assignment.inputRevision,
            inputSha256: prepared.assignment.inputSha256,
          },
        ],
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
  expect(
    (
      await database.pool.query(
        "SELECT source_restrictions FROM brain_items WHERE id=$1",
        [acceptedAgent.acceptedRecordId],
      )
    ).rows[0].source_restrictions,
  ).toEqual(
    expect.arrayContaining([
      {
        kind: "assignment_input",
        assignmentId: prepared.assignment.id,
        inputRevision: prepared.assignment.inputRevision,
        inputSha256: prepared.assignment.inputSha256,
      },
    ]),
  );
  expect(
    (
      await searchKnowledge(database.db, nativePrincipal, { q: "", limit: 10 })
    ).items.map((item) => item.id),
  ).toContain(acceptedAgent.acceptedRecordId);
  const queryPlan = await database.db.transaction(async (tx) => {
    const identity = await resolveKnowledgePrincipal(
      tx,
      nativePrincipal,
      "knowledge:read",
    );
    const result = await tx.execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${knowledgeReadPolicyCte(identity, sql`true`)} SELECT id FROM knowledge_readable_records LIMIT 10`,
    );

    return z
      .array(
        z.object({
          JIT: z.unknown().optional(),
          "Execution Time": z.number(),
          "Planning Time": z.number(),
        }),
      )
      .min(1)
      .parse(result.rows[0]["QUERY PLAN"])[0];
  });

  expect(queryPlan["Execution Time"] + queryPlan["Planning Time"]).toBeLessThan(
    500,
  );
  const foreign = await reserveCompanyFixtureRun();

  await database.pool.query(
    "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
    [
      foreign.runId,
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [
          {
            kind: "assignment_input",
            assignmentId: foreign.snapshot.assignment.id,
            inputRevision: foreign.snapshot.assignment.inputRevision,
            inputSha256: foreign.snapshot.assignment.inputSha256,
          },
        ],
      }),
    ],
  );
  await assertNativeRunKnowledgeInputs(database.db, foreign.runId);
  await expect(
    getKnowledgeRecord(
      database.db,
      { kind: "execution", runId: foreign.runId, nodeAttemptId: null },
      { recordId: acceptedAgent.acceptedRecordId },
    ),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  expect(
    (
      await searchKnowledge(
        database.db,
        { kind: "execution", runId: foreign.runId, nodeAttemptId: null },
        { q: "", limit: 10 },
      )
    ).items.map((item) => item.id),
  ).not.toContain(acceptedAgent.acceptedRecordId);
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

it("CBS-02 resolves and inspects an owned company plain directory without a project and rejects retargeted baseline paths", async () => {
  const { runId } = await reserveCompanyFixtureRun();
  const [run] = await database.db.select().from(runs).where(eq(runs.id, runId));
  const context = await operationalWorkspace(database.db, run);

  expect(context).toMatchObject({
    ownerKind: "company",
    companyId: request.companyId,
    resourceKind: "plain_directory",
    repoPath: null,
    projectSlug: null,
  });
  expect(context.cwd.startsWith(join(root, "worktrees") + sep)).toBe(true);
  expect(context.runtimePath).not.toBe(context.cwd);
  expect(await operationalReferenceEvidence(database.db, run)).toEqual([]);
  await mkdir(context.cwd, { recursive: true });
  await writeFile(
    join(context.cwd, "observations.txt"),
    "Bounded company evidence.",
  );
  const baseline = await captureOperationalGeneration(
    context.cwd,
    await captureOperationalBaseline(context.cwd, "plain_directory"),
    [],
  );
  const owner = {
    kind: "company" as const,
    companyId: request.companyId,
    runId,
    cwd: context.cwd,
    runtimePath: context.runtimePath,
  };
  const retained = {
    ...run,
    operationalIntegrityBaseline: { ...baseline, owner },
  };

  await database.db
    .update(runs)
    .set({
      operationalIntegrityBaseline: retained.operationalIntegrityBaseline,
    })
    .where(eq(runs.id, runId));
  expect(await operationalWorkspace(database.db, retained)).toEqual(context);
  expect(
    await inspectOperationalWorkspace(database.db, retained),
  ).toMatchObject({ verdict: "clean" });
  await writeFile(join(context.cwd, "observations.txt"), "Changed source.");
  expect(
    await inspectOperationalWorkspace(database.db, retained),
  ).toMatchObject({ verdict: "changed" });
  await expect(
    operationalWorkspace(database.db, {
      ...retained,
      operationalIntegrityBaseline: {
        ...baseline,
        owner: { ...owner, cwd: root },
      },
    }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "company_workspace_owner_mismatch" },
  });
  await expect(
    operationalWorkspace(database.db, { ...run, agentWorkspace: "repo_read" }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await expect(
    operationalWorkspace(database.db, {
      ...run,
      companyExecutionSnapshot: null,
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await expect(
    operationalWorkspace(database.db, {
      ...run,
      companyId: null,
      companyExecutionSnapshot: null,
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
});

async function seedCompanyOperationalTerminal(): Promise<
  Readonly<{
    runId: string;
    assignmentId: string;
    context: Extract<OperationalWorkspaceContext, { ownerKind: "company" }>;
  }>
> {
  const { runId, assignmentId } = await reserveCompanyFixtureRun();
  const [run] = await database.db.select().from(runs).where(eq(runs.id, runId));
  const context = await operationalWorkspace(database.db, run);

  if (context.ownerKind !== "company")
    throw new Error("Expected a company workspace fixture");
  await mkdir(context.cwd, { recursive: true });
  await mkdir(context.runtimePath, { recursive: true });
  await writeFile(join(context.runtimePath, "cache"), "Adapter state");
  await writeFile(
    join(context.cwd, "diagnosis.txt"),
    "Retained company diagnostic input",
  );
  const baseline = await captureOperationalGeneration(
    context.cwd,
    await captureOperationalBaseline(context.cwd, "plain_directory"),
    [],
  );

  await database.db
    .update(runs)
    .set({
      status: "Running",
      operationalIntegrityBaseline: {
        ...baseline,
        contextMounts: [],
        owner: {
          kind: "company",
          companyId: request.companyId,
          runId,
          cwd: context.cwd,
          runtimePath: context.runtimePath,
        },
      },
    })
    .where(eq(runs.id, runId));

  return { runId, assignmentId, context };
}

it("CBS-02 atomically finalizes company result evidence, revokes credentials and releases plain materialization without completing the assignment", async () => {
  const db: Db = database.db;
  const { runId, assignmentId, context } =
    await seedCompanyOperationalTerminal();
  const credential = await issueCompanyAgentRunToken({
    db: database.db,
    runId,
  });
  const prepared = await prepareAgentRunFinalization(runId, "Done", {
    db: database.db,
    finalText:
      "```json maister:output\n" +
      JSON.stringify(operationalSuccessFixture()) +
      "\n```",
  });
  const project = await seedProjectRow(database.db);
  const projectRunId = randomUUID();

  await database.pool.query(
    "INSERT INTO runs(id,run_kind,project_id,agent_id,agent_workspace,flow_version,flow_revision,status) VALUES($1,'agent',$2,$3,'none','agent','manual','Pending')",
    [projectRunId, project.id, agentId],
  );
  await expect(
    database.pool.query(
      "INSERT INTO domain_events(kind,company_id,run_id,payload,occurred_at) VALUES('run.done',$1,$2,'{}'::jsonb,now())",
      [request.companyId, projectRunId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_run_reference_check",
  });
  await expect(
    database.pool.query(
      "INSERT INTO domain_events(kind,company_id,run_id,payload,occurred_at) VALUES('task.created',$1,$2,'{}'::jsonb,now())",
      [request.companyId, runId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_kind_check",
  });
  const originalEvents = (
    await database.pool.query(
      "SELECT count(*)::int AS count FROM domain_events WHERE run_id=$1",
      [runId],
    )
  ).rows[0].count;

  await expect(
    db.transaction(async (tx) => {
      await prepared.apply(tx);
      throw new Error("Roll back terminal fixture application");
    }),
  ).rejects.toThrow("Roll back terminal fixture application");
  expect(
    (await database.pool.query("SELECT status FROM runs WHERE id=$1", [runId]))
      .rows[0].status,
  ).toBe("Running");
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM run_results WHERE run_id=$1",
        [runId],
      )
    ).rows[0].count,
  ).toBe(0);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM domain_events WHERE run_id=$1",
        [runId],
      )
    ).rows[0].count,
  ).toBe(originalEvents);
  await expect(
    verifyToken(credential.secret, database.db),
  ).resolves.toMatchObject({ companyId: request.companyId });

  await expect(
    db.transaction((tx) => prepared.apply(tx)),
  ).resolves.toMatchObject({ finalized: true, status: "Done" });
  await expect(
    verifyToken(credential.secret, database.db),
  ).rejects.toMatchObject({ kind: "revoked" });
  expect(
    (
      await database.pool.query(
        "SELECT status,operational_terminal,operational_cleanup FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0],
  ).toMatchObject({
    status: "Done",
    operational_terminal: {
      successful: true,
      integrity: "clean",
      resultRevision: 1,
    },
    operational_cleanup: { state: "armed" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT company_id,project_id,task_id,kind,payload FROM domain_events WHERE run_id=$1 AND kind='run.done'",
        [runId],
      )
    ).rows,
  ).toMatchObject([
    {
      company_id: request.companyId,
      project_id: null,
      task_id: null,
      kind: "run.done",
      payload: { parentRunId: null, resultStatus: "valid" },
    },
  ]);
  await expect(
    db.transaction((tx) => prepared.apply(tx)),
  ).resolves.toMatchObject({ finalized: false });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM run_results WHERE run_id=$1",
        [runId],
      )
    ).rows[0].count,
  ).toBe(1);
  await expect(
    database.pool.query(
      "UPDATE domain_events SET company_id=NULL,project_id=$2 WHERE run_id=$1 AND kind='run.done'",
      [runId, project.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_identity_check",
  });
  expect(await disposeOperationalRun(runId, { db: database.db })).toBe(
    "released",
  );
  await expect(lstat(context.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(context.runtimePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (
      await database.pool.query(
        "SELECT operational_cleanup FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0].operational_cleanup,
  ).toMatchObject({ state: "released", attempts: 1 });
  expect(
    (
      await database.pool.query(
        "SELECT status FROM specialist_assignments WHERE id=$1",
        [assignmentId],
      )
    ).rows[0].status,
  ).toBe("queued");
  expect(await disposeOperationalRun(runId, { db: database.db })).toBe(
    "skipped",
  );
});

it("CBS-02 refuses company completion without its required result and retains failed source bytes for evidence recovery", async () => {
  const db: Db = database.db;
  const { runId, assignmentId, context } =
    await seedCompanyOperationalTerminal();
  const prepared = await prepareAgentRunFinalization(runId, "Done", {
    db: database.db,
  });

  await expect(
    db.transaction((tx) => prepared.apply(tx)),
  ).resolves.toMatchObject({ finalized: true, status: "Failed" });
  expect(
    (
      await database.pool.query(
        "SELECT operational_terminal FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0].operational_terminal,
  ).toMatchObject({ successful: false, validation: "invalid" });
  expect(
    (
      await database.pool.query(
        "SELECT kind,payload FROM domain_events WHERE run_id=$1 AND kind='run.failed'",
        [runId],
      )
    ).rows,
  ).toMatchObject([
    {
      kind: "run.failed",
      payload: {
        resultStatus: "unavailable",
        cause: { code: "CONFIG", reason: "result_missing" },
      },
    },
  ]);
  expect(await disposeOperationalRun(runId, { db: database.db })).toBe(
    "deferred",
  );
  expect(await readFile(join(context.cwd, "diagnosis.txt"), "utf8")).toBe(
    "Retained company diagnostic input",
  );
  expect(
    (
      await database.pool.query(
        "SELECT operational_cleanup FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0].operational_cleanup,
  ).toMatchObject({
    state: "retry",
    attempts: 1,
    errorCode: "operational_evidence_host_missing",
  });
  expect(
    (
      await database.pool.query(
        "SELECT status FROM specialist_assignments WHERE id=$1",
        [assignmentId],
      )
    ).rows[0].status,
  ).toBe("queued");
});

it("CBS-02 governs company operational acknowledgement and exhausted cleanup rearm through current grants and existing receipts", async () => {
  const db: Db = database.db;
  const { runId, assignmentId, context } =
    await seedCompanyOperationalTerminal();
  const prepared = await prepareAgentRunFinalization(runId, "Done", { db });

  await db.transaction((tx) => prepared.apply(tx));
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const snapshot = run.companyExecutionSnapshot!;

  await db
    .update(runs)
    .set({
      knowledgeAccess: {
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [
          {
            kind: "assignment_input",
            assignmentId,
            inputRevision: snapshot.assignment.inputRevision,
            inputSha256: snapshot.assignment.inputSha256,
          },
        ],
      },
    })
    .where(eq(runs.id, runId));
  const acknowledge = (): Promise<Response> =>
    acknowledgeOperationalPost(
      new NextRequest(
        `http://localhost/api/runs/${runId}/operational/acknowledge`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "operation_failure", revision: 1 }),
        },
      ),
      { params: Promise.resolve({ runId }) },
    );

  const operatorId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [operatorId, `${operatorId}@example.test`],
  );
  await createCompanyGrants(db, administratorId, {
    principalKind: "user",
    principalId: operatorId,
    actions: ["assignments:read"],
    idempotencyKey: randomUUID(),
  });
  try {
    browserSession.user = await requireActiveUserById(operatorId);
    expect((await acknowledge()).status).toBe(403);
    await expect(
      acknowledgeOperationalAttention(db, {
        runId,
        userId: operatorId,
        reason: "operation_failure",
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const grants = await createCompanyGrants(db, administratorId, {
      principalKind: "user",
      principalId: operatorId,
      actions: ["assignments:answer", "assignments:recover"],
      idempotencyKey: randomUUID(),
    });

    browserSession.user = await requireActiveUserById(operatorId);
    const acknowledged = await acknowledge();

    expect(acknowledged.status).toBe(200);
    const acknowledgementBody = await acknowledged.json();

    await assertWebPostResponseContract(
      "/api/runs/{runId}/operational/acknowledge",
      200,
      acknowledgementBody,
    );
    expect(acknowledgementBody).toEqual({
      acknowledged: true,
      revision: 1,
    });
    expect((await acknowledge()).status).toBe(200);
    expect(
      (
        await database.pool.query(
          "SELECT company_id,project_id,actor_id FROM domain_events WHERE run_id=$1 AND kind='run.operational_attention_acknowledged'",
          [runId],
        )
      ).rows,
    ).toEqual([
      { company_id: request.companyId, project_id: null, actor_id: operatorId },
    ]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await database.pool.query(
        "UPDATE runs SET operational_cleanup=jsonb_set(operational_cleanup,'{dueAt}',to_jsonb((now()-interval '1 second')::text)) WHERE id=$1",
        [runId],
      );
      expect(await disposeOperationalRun(runId, { db })).toBe("deferred");
    }
    const [exhausted] = await db.select().from(runs).where(eq(runs.id, runId));

    expect(exhausted.operationalCleanup).toMatchObject({
      state: "exhausted",
      attempts: 5,
      errorCode: "operational_evidence_host_missing",
    });
    const revision = exhausted.operationalCleanup!.revision;
    const retry = (): Promise<Response> =>
      retryOperationalPost(
        new NextRequest(
          `http://localhost/api/runs/${runId}/operational/cleanup/retry`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedRevision: revision }),
          },
        ),
        { params: Promise.resolve({ runId }) },
      );
    const rearmed = await retry();

    expect(rearmed.status).toBe(202);
    const rearmedBody = await rearmed.json();

    await assertWebPostResponseContract(
      "/api/runs/{runId}/operational/cleanup/retry",
      202,
      rearmedBody,
    );
    expect(rearmedBody).toMatchObject({
      state: "armed",
      revision: revision + 1,
      attempts: 0,
      errorCode: null,
    });
    const replayed = await retry();

    expect(replayed.status).toBe(202);
    expect(await replayed.json()).toMatchObject({
      state: "armed",
      revision: revision + 1,
      attempts: 0,
    });
    const recoveryGrant = grants.page.items.find(
      (grant) => grant.action === "assignments:recover",
    )!;

    await revokeCompanyGrant(db, administratorId, recoveryGrant.id, {
      expectedRevision: recoveryGrant.revision,
      reason: "Withdraw cleanup recovery authority",
      idempotencyKey: randomUUID(),
    });
    expect((await retry()).status).toBe(403);
    await expect(
      retryOperationalCleanup(db, {
        runId,
        userId: operatorId,
        expectedRevision: revision,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await readFile(join(context.cwd, "diagnosis.txt"), "utf8")).toBe(
      "Retained company diagnostic input",
    );
    expect(
      (
        await database.pool.query(
          "SELECT status FROM specialist_assignments WHERE id=$1",
          [assignmentId],
        )
      ).rows[0],
    ).toEqual({ status: "queued" });
  } finally {
    browserSession.user = null;
  }
});

it("CBS-02 quarantines a company specialist source violation and preserves failed bytes instead of accepting a valid-looking result", async () => {
  const db: Db = database.db;
  const { runId, context } = await seedCompanyOperationalTerminal();
  const credential = await issueCompanyAgentRunToken({ db, runId });

  await writeFile(
    join(context.cwd, "diagnosis.txt"),
    "Unapproved source mutation",
  );
  const prepared = await prepareAgentRunFinalization(runId, "Done", {
    db,
    finalText:
      "```json maister:output\n" +
      JSON.stringify(operationalSuccessFixture()) +
      "\n```",
  });

  await expect(
    db.transaction((tx) => prepared.apply(tx)),
  ).resolves.toMatchObject({ finalized: true, status: "Failed" });
  expect(
    (
      await database.pool.query(
        "SELECT operational_terminal FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0].operational_terminal,
  ).toMatchObject({ integrity: "changed", successful: false });
  expect(
    (
      await database.pool.query(
        "SELECT quarantined_at,quarantine_reason FROM agents WHERE id=$1",
        [agentId],
      )
    ).rows[0],
  ).toMatchObject({
    quarantined_at: expect.any(Date),
    quarantine_reason: "operational_source_contract_violation",
  });
  await expect(verifyToken(credential.secret, db)).rejects.toMatchObject({
    kind: "revoked",
  });
  expect(await disposeOperationalRun(runId, { db })).toBe("deferred");
  expect(await readFile(join(context.cwd, "diagnosis.txt"), "utf8")).toBe(
    "Unapproved source mutation",
  );
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

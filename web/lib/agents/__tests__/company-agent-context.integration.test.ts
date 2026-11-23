import type { ProjectAgentTriggerClaim } from "../trigger-attempts";
import type { AssignmentContextPrincipal } from "@/lib/specialist-assignments/context-access";
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
import { once } from "node:events";
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
import { createServer } from "node:http";
import os from "node:os";
import { join, resolve, sep } from "node:path";
import { Writable } from "node:stream";

import { parse, stringify } from "yaml";
import pino from "pino";
import Ajv from "ajv";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  prepareCompanyAgentContext,
  captureCompanyAgentExecution,
} from "../company-agent-context";
import { detachCompanySpecialistBinding } from "../company-binding-mutations";
import { createCompanyFlowBinding } from "../company-flow-bindings";
import { loadCompanyFlowSessionContext } from "../company-flow-session-context";
import {
  createCompanySpecialistBinding,
  getCompanySpecialistBindingRevision,
} from "../company-bindings";
import { resolveInstalledAgentDefinition } from "../effective";
import {
  buildCompanyAgentPrompt,
  loadCompanyAgentSessionContext,
} from "../company-session-context";
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
import { settleAgentPreparationFailure } from "../create-failure";
import { openAgentPreparation } from "../preparation-workspace";
import {
  reserveCompanyAgentRun,
  reserveCompanyAgentRunInTransaction,
} from "../company-agent-launch";
import {
  acceptAgentRetry,
  getAgentRetryOptions,
  getAgentRetryReceipt,
  runAgentRetryAdmissionSweep,
} from "../retry";
import { reobserveAgentSession, startAgentSession } from "../launch";
import * as agentLaunch from "../launch";
import { startAgentContinuationWorker } from "../continuation-worker";
import { getCompanyAgentRunHistory } from "../activity-queries";

import { runReconcileSweep } from "@/lib/reconcile";
import { wakeParkedCoordinator } from "@/lib/flows/graph/coordinator-wake";
import { buildOrchestratorResumeConsumer } from "@/lib/domain-events/orchestrator-resume";
import { submitProjectManualAssignment } from "@/lib/specialist-assignments/project-manual-intake";
import {
  mintAssignment,
  releaseAssignmentForRun,
} from "@/lib/execution-host/assignments";
import { validateOperationalEvidenceReferences } from "@/lib/run-results/operational-evidence";
import { decideAgentResult } from "@/lib/run-results/agent-result";
import * as flowRunner from "@/lib/flows/runner";
import { poll } from "@/test-support/durable-workers-ledger";
import { answerAssignmentQuestion } from "@/lib/services/assignment-question-response";
import { assignmentQuestionReceiptSchema } from "@/lib/specialist-assignments/question-types";
import { retainDelegatedWorkInTransaction } from "@/lib/specialist-assignments/delegated-intake";
import { dispatchProjectAssignmentChild } from "@/lib/specialist-assignments/project-child-dispatch";
import { collectChild } from "@/lib/run-results/collect";
import { admitDelegatedChild } from "@/lib/orchestrator/admission";
import { getSpecialistAssignmentAdmission } from "@/lib/specialist-assignments/admission-read";
import { listSpecialistAssignmentWork } from "@/lib/specialist-assignments/pages";
import { requestTaskRequalificationIfCurrent } from "@/lib/tasks/qualification-requalification";
import {
  getSpecialistAssignment,
  getSpecialistAssignmentInput,
  getSpecialistAssignmentInputInTransaction,
} from "@/lib/specialist-assignments/store";
import {
  acknowledgeOperationalAttention,
  retryOperationalCleanup,
} from "@/lib/runs/operational-attention";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import { readTranscriptPage } from "@/lib/runs/transcript-page";
import { authorizePeekRun } from "@/lib/runs/peek-read-model";
import {
  getHumanTaskAssessmentDraft,
  recordHumanTaskAssessment,
} from "@/lib/tasks/human-assessment";
import { QUALIFICATION_DIMENSIONS } from "@/lib/tasks/qualification-types";
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
  executionCommands,
  executionEvents,
  executionHosts,
  domainEvents,
  platformAcpRunners,
  platformRuntimeSettings,
} from "@/lib/db/schema";
import { createExecutionHosts, localHost } from "@/lib/execution-host";
import * as executionHostServices from "@/lib/execution-host";
import { POST as delegateExternalRun } from "@/app/api/v1/ext/runs/delegate/route";
import { POST as collectExternalRun } from "@/app/api/v1/ext/runs/collect/route";
import { POST as messageExternalRun } from "@/app/api/v1/ext/runs/message/route";
import { POST as reworkExternalRun } from "@/app/api/v1/ext/runs/rework/route";
import { POST as decideSpecialistWork } from "@/app/api/specialist-assignments/[assignmentId]/work/[workId]/decisions/route";
import { POST as decideSpecialistWorkExternal } from "@/app/api/v1/ext/specialist-assignments/[assignmentId]/work/[workId]/decisions/route";
import { runFlow } from "@/lib/flows/runner";
import { captureNativeChildInput } from "@/lib/orchestrator/native-child-input";
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
import { readPromptRequest } from "@/lib/execution-host/command-request";
import {
  appendSpecialistAssignmentContext,
  getSpecialistAssignmentTokenContext,
} from "@/lib/specialist-assignments/context";
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
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import {
  claimCronAgentAttempt,
  claimEventAgentAttempt,
  assertProjectAgentTriggerClaim,
  reconcileAgentTriggerAttempts,
  settleCompanyAgentTriggerAttempt,
  settleAgentTriggerAttempt,
} from "@/lib/agents/trigger-attempts";
import { MaisterError } from "@/lib/errors";
import { loadProjectCommentAppointment } from "@/lib/specialist-assignments/project-comment-appointment";
import { loadProjectCronAppointment } from "@/lib/specialist-assignments/project-cron-appointment";
import { loadProjectAssignmentExecutionInput } from "@/lib/specialist-assignments/project-admission";
import { submitProjectCommentAssignment } from "@/lib/specialist-assignments/project-comment-intake";
import { submitProjectCronAssignment } from "@/lib/specialist-assignments/project-cron-intake";
import { submitProjectEventAssignment } from "@/lib/specialist-assignments/project-event-intake";
import { prepareCompanySpecialistAssignment } from "@/lib/specialist-assignments/company-intake";
import { reserveCompanyCronAssignment } from "@/lib/specialist-assignments/company-cron-intake";
import { reserveCompanyEventAssignment } from "@/lib/specialist-assignments/company-event-intake";
import { reserveCompanyManualAssignment } from "@/lib/specialist-assignments/company-manual-intake";
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
import { addDetachedWorktree } from "@/lib/worktree";
import { contentDigest } from "@/lib/evaluations/digest";
import { claimBudgetTermination } from "@/lib/runs/budget-termination";
import { reconcileRunCostRollups } from "@/lib/runs/cost-rollups";
import { claimCompanyStop } from "@/lib/runs/stop";

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

async function retainedPrompt(runId: string): Promise<string> {
  const command = (
    await database.db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, runId),
          eq(executionCommands.kind, "session.prompt"),
        ),
      )
  )[0]!;
  const host = (
    await database.db
      .select()
      .from(executionHosts)
      .where(eq(executionHosts.id, command.executionHostId))
  )[0]!;

  return readPromptRequest(command, host.hostKey).payload.prompt;
}

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
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: vi.fn(),
}));

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
    join(source, "maister-agents/detached-retry-observer.md"),
    primarySource.replace(
      "workspace: none",
      "workspace: repo_read\nworkspace_ref: main",
    ),
  );
  await writeFile(
    join(source, "maister-agents/worktree-retry-observer.md"),
    primarySource.replace("workspace: none", "workspace: worktree"),
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
    join(source, "maister-agents/vault-installation-fixture.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/vault-installation-producer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/context-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/evidence-observer.md"),
    primarySource.replace(
      "contract: operational_v1",
      "contract: operational_evidence_v2",
    ),
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
    join(source, "maister-agents/owner-fence-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/observer-adoption.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/observer-adoption-waiting.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/event-retry-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/cron-retry-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/delegating-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/interrupted-cooperation-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/project-dispatch-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/company-dispatch-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/interrupted-dispatch-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/child-interruption-observer.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/child-interruption-receiver.md"),
    primarySource,
  );
  await writeFile(
    join(source, "maister-agents/company-child-coordinator.md"),
    primarySource
      .replace(
        "kind: operational\ncompletion: {contract: operational_v1}\n",
        "",
      )
      .replace("workspace: none", "flow: rah-company-child\nworkspace: none"),
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
  for (const role of [
    "projection-reader",
    "projection-disabled",
    "projection-denied",
    "question-observer",
    "question-recovery-observer",
    "question-agent-observer",
    "question-cancelled-observer",
    "question-project-observer",
  ])
    await cp(
      join(source, "maister-agents/wire-observer.md"),
      join(source, `maister-agents/${role}.md`),
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
  const childFlowPath = join(source, "flows/rah-company-child");
  const controlFlow = parse(
    (
      await readFile(join(source, "flows/rah-control/flow.yaml"), "utf8")
    ).replace("{{ task.prompt }}", "{{ assignment.input }}"),
  ) as Record<string, unknown> & { nodes: Record<string, unknown>[] };

  await mkdir(childFlowPath, { recursive: true });
  await writeFile(
    join(childFlowPath, "flow.yaml"),
    stringify({
      ...controlFlow,
      name: "rah-company-child",
      execution: { workspace: "none", completion: "result" },
      nodes: controlFlow.nodes.map((node) => ({
        ...node,
        type: "orchestrator",
        settings: {
          delegation: {
            max_fanout: 2,
            max_depth: 2,
            max_active_children: 2,
            budget: {
              max_tokens: 10000,
              wall_clock_minutes: 5,
              max_child_runs: 8,
              consecutive_failures: 2,
            },
          },
        },
      })),
    }),
  );
  const manifestPath = join(source, "maister-package.yaml");
  const manifest = parse(await readFile(manifestPath, "utf8")) as {
    flows: { id: string; path: string }[];
  };

  await writeFile(
    manifestPath,
    stringify({
      ...manifest,
      compat: { engine_min: "3.12.0" },
      flows: [
        ...manifest.flows,
        { id: "rah-company-child", path: "flows/rah-company-child" },
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

describe("company and project intake through the real supervisor and ACP", () => {
  it("IT-CBC-01 fails closed on incomplete work witnesses and retains company source identity after catalog removal", async () => {
    const db: Db = database.db;
    const { hosts } = await fakeExecutionHosts(db);
    const runnerId = randomUUID();
    const host = await localHost({ db, transport: hosts.transport });
    const before = (
      await db.execute(sql`SELECT
    (SELECT count(*) FROM specialist_assignments) AS assignments,
    (SELECT count(*) FROM runs) AS runs,
    (SELECT to_jsonb(settings) FROM platform_runtime_settings settings WHERE id='singleton') AS runtime
  `)
    ).rows;

    const rollback = new Error(
      "Restore the retained catalog fixture after checking deferred guards",
    );

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(platformAcpRunners).values({
          id: runnerId,
          adapter: "claude",
          capabilityAgent: "claude",
          model: "work-source-fixture",
          provider: { kind: "anthropic" },
          readinessStatus: "Ready",
        });
        await tx
          .insert(platformRuntimeSettings)
          .values({ id: "singleton", defaultRunnerId: runnerId })
          .onConflictDoUpdate({
            target: platformRuntimeSettings.id,
            set: { defaultRunnerId: runnerId },
          });
        const assignment = await createSpecialistAssignmentInTransaction(
          tx,
          userId,
          assignmentInput,
        );
        const receipt = await reserveCompanyAgentRunInTransaction(
          tx,
          userId,
          { ...request, assignmentId: assignment.id },
          hosts,
          host,
        );
        const input = await getSpecialistAssignmentInputInTransaction(
          tx,
          userId,
          assignment.id,
          1,
        );

        await tx.execute(
          sql`UPDATE runs SET status='Running' WHERE id=${receipt.runId}`,
        );
        const [binding] = (
          await tx.execute<{ snapshot_digest: string }>(sql`
        SELECT snapshot_digest FROM company_specialist_binding_revisions
        WHERE binding_id=${request.bindingId} AND revision=${request.bindingRevision}
      `)
        ).rows;
        const target = {
          kind: "company_agent",
          companyId: request.companyId,
          specialistBinding: {
            id: request.bindingId,
            revision: request.bindingRevision,
            snapshotSha256: binding!.snapshot_digest,
          },
          role: {
            agentId,
            packageInstallId:
              assignmentInput.standingDefinition.packageInstallId,
            packageRevision: assignmentInput.standingDefinition.packageRevision,
            definitionSha256:
              assignmentInput.standingDefinition.definitionSha256,
          },
        };
        const definition = {
          schemaVersion: 1,
          objectiveInput: assignmentInput.objectiveInput,
          target,
          context: {
            revision: 0,
            inputRevision: 1,
            inputSha256: input.digest,
            contentSha256: null,
          },
          parent: {
            runId: receipt.runId,
            nodeAttemptId: null,
            rootRunId: receipt.runId,
          },
        };
        const actor = {
          kind: "agent",
          id: agentId,
          runId: receipt.runId,
          attemptId: null,
        };

        expect(
          (
            await tx.execute(
              sql`SELECT agent_id,source_agent_id,project_id FROM runs WHERE id=${receipt.runId}`,
            )
          ).rows,
        ).toEqual([
          { agent_id: agentId, source_agent_id: agentId, project_id: null },
        ]);
        // Exercise the actual ON DELETE SET NULL retention path, not a fabricated launch shape.
        await tx.execute(sql`DELETE FROM agents WHERE id=${agentId}`);
        expect(
          (
            await tx.execute(
              sql`SELECT agent_id,source_agent_id FROM runs WHERE id=${receipt.runId}`,
            )
          ).rows,
        ).toEqual([{ agent_id: null, source_agent_id: agentId }]);
        const { companyId: _companyId, ...unscopedTarget } = target;
        const cases = [
          {
            logicalWorkId: "forged-actor",
            definition,
            actor: { ...actor, id: "rah:unrelated-role" },
            constraint: "specialist_work_source_binding",
          },
          {
            logicalWorkId: "missing-context",
            definition: { ...definition, context: { revision: 0 } },
            actor,
            constraint: "specialist_work_context_binding",
          },
          {
            logicalWorkId: "missing-target-owner",
            definition: { ...definition, target: unscopedTarget },
            actor,
            constraint: "specialist_work_target_binding",
          },
          {
            logicalWorkId: "retained-source",
            definition,
            actor,
            constraint: null,
          },
        ];
        const unexpectedlyAccepted: string[] = [];

        for (const candidate of cases) {
          const workId = randomUUID();
          const sourceKey = contentDigest({
            assignmentId: assignment.id,
            inputRevision: 1,
            logicalWorkId: candidate.logicalWorkId,
            workRevision: 1,
          });
          const requestSha256 = contentDigest(candidate.definition);
          const authority = {
            schemaVersion: 1,
            actor: candidate.actor,
            capturedAt: new Date().toISOString(),
            executionPolicy: assignmentInput.executionPolicy,
            witnesses: [],
          };
          const write = tx.transaction(async (nested) => {
            await nested.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
            await nested.execute(sql`INSERT INTO specialist_work(id,work_revision,assignment_id,input_revision,input_sha256,logical_work_id,parent_run_id,definition,definition_sha256,actor,authority_snapshot,bounds,source_restrictions,request_sha256,source_key,reserved_run_id)
            VALUES(${workId},1,${assignment.id},1,${input.digest},${candidate.logicalWorkId},${receipt.runId},${JSON.stringify(candidate.definition)}::jsonb,${contentDigest(candidate.definition)},${JSON.stringify(candidate.actor)}::jsonb,${JSON.stringify(authority)}::jsonb,
              '{"schemaVersion":1,"maxDepth":2,"maxFanout":4,"maxActiveChildren":2,"maxChildRuns":8,"maxTokens":100000,"wallClockMinutes":30,"consecutiveFailures":3}'::jsonb,'[]'::jsonb,${requestSha256},${sourceKey},${randomUUID()})`);
            await nested.execute(sql`INSERT INTO specialist_intake_receipts(source_kind,source_key,request_digest,assignment_id,input_revision,actor,disposition,work_id,work_revision)
            VALUES('delegation',${sourceKey},${requestSha256},${assignment.id},1,${JSON.stringify(candidate.actor)}::jsonb,'delegated',${workId},1)`);
            await nested.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
          });

          if (candidate.constraint === null) {
            await expect(write).resolves.toBeUndefined();
          } else {
            await write.then(
              () => {
                unexpectedlyAccepted.push(candidate.logicalWorkId);
              },
              (error: unknown) => {
                expect(error, candidate.logicalWorkId).toMatchObject({
                  cause: { code: "23514", constraint: candidate.constraint },
                });
              },
            );
          }
        }
        expect(unexpectedlyAccepted).toEqual([]);
        expect(
          (
            await tx.execute(
              sql`SELECT logical_work_id,actor FROM specialist_work WHERE assignment_id=${assignment.id}`,
            )
          ).rows,
        ).toEqual([{ logical_work_id: "retained-source", actor }]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(
      (
        await db.execute(sql`SELECT
    (SELECT count(*) FROM specialist_assignments) AS assignments,
    (SELECT count(*) FROM runs) AS runs,
    (SELECT to_jsonb(settings) FROM platform_runtime_settings settings WHERE id='singleton') AS runtime
  `)
      ).rows,
    ).toEqual(before);
  });

  it("IT-CBS-02 preflights a real pinned company specialist and exact assignment input without a project or admission effects", async () => {
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

  it("IT-CBS-02 adopts the server-resolved company directory through the real supervisor wire and retains its owner", async () => {
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
    const worker = startProjectionWorker({
      db,
      projectors: canonicalProjectors,
    });
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

        expect(
          new Set(receipts.map((receipt) => receipt.scheduleId)).size,
        ).toBe(1);
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
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "Sec-Fetch-Site": "same-origin",
            },
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
      const response = await submitExternal(
        manualRequest,
        personalToken.secret,
      );

      expect(response.status).toBe(201);
      const assignment = specialistAssignmentSchema.parse(
        await response.json(),
      );

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
          inspection: {
            atCap: true,
            reason: "company_event_chain_unclassified",
          },
        },
      });
      await database.pool.query(
        "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
      );
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
      await appendSpecialistAssignmentContext(db, userId, assignment.id, {
        expectedRevision: 0,
        expectedInputRevision: 1,
        idempotencyKey: randomUUID(),
        updates: [
          {
            id: "producer-later-context",
            kind: "hypothesis",
            text: "A later working note is not shared merely by quoting the producer input",
            state: "open",
            references: [],
          },
        ],
      });
      await database.pool.query("DELETE FROM execution_host_pressure");
      expect(
        await tryStartRun(eventAttempts[0]!.reserved_run_id, { db }),
      ).toMatchObject({ started: true });
      const eventContextCredential = await issueCompanyAgentRunToken({
        db,
        runId: eventAttempts[0]!.reserved_run_id,
      });

      try {
        const ownAppointment = (
          await database.pool.query<{ assignment_id: string }>(
            "SELECT assignment_id FROM specialist_run_links WHERE run_id=$1",
            [eventAttempts[0]!.reserved_run_id],
          )
        ).rows[0]!;

        expect(
          (
            await externalContextGet(
              new NextRequest(
                `http://localhost/api/v1/ext/specialist-assignments/${ownAppointment.assignment_id}/context`,
                {
                  headers: {
                    Authorization: `Bearer ${eventContextCredential.secret}`,
                  },
                },
              ),
              {
                params: Promise.resolve({
                  assignmentId: ownAppointment.assignment_id,
                }),
              },
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await externalContextGet(
              new NextRequest(
                `http://localhost/api/v1/ext/specialist-assignments/${assignment.id}/context`,
                {
                  headers: {
                    Authorization: `Bearer ${eventContextCredential.secret}`,
                  },
                },
              ),
              { params: Promise.resolve({ assignmentId: assignment.id }) },
            )
          ).status,
        ).toBe(404);
      } finally {
        await revokeAgentRunToken(eventContextCredential.tokenId, db);
        await database.pool.query("DELETE FROM execution_host_pressure");
        await startAgentSession(eventAttempts[0]!.reserved_run_id, {
          db,
          executionHosts: hosts,
        });
        await promoteNextPending({ db, pool: "agent" });
      }
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
        database.pool.query(
          "UPDATE runs SET agent_schedule_id=$2 WHERE id=$1",
          [eventAttempts[0]!.reserved_run_id, eventAttempts[1]!.schedule_id],
        ),
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
        expect(await dispatchDomainEvents({ db })).toMatchObject({
          failures: 0,
        });
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
          status: "awaiting_acceptance",
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
      const reservationHost = await localHost({
        db,
        transport: hosts.transport,
      });

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
        expect(await dispatchDomainEvents({ db })).toMatchObject({
          failures: 0,
        });
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
    const worker = startProjectionWorker({
      db,
      projectors: canonicalProjectors,
    });
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
      const binding = await createCompanySpecialistBinding(
        db,
        userId,
        agentId,
        {
          owner: { kind: "company", companyId: request.companyId },
          packageInstallId: effective.packageInstallId,
          packageRevision: effective.resolvedRevision!,
          definitionSha256: agentDefinitionSha256(effective.parsed),
          enabled: true,
          configuration: {},
          grantActions: ["knowledge:read", "knowledge:propose"],
          runnerId,
          idempotencyKey: randomUUID(),
        },
      );
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
      const contract: { components: { schemas: Record<string, object> } } =
        parse(await readFile(resolve("../docs/api/web.openapi.yaml"), "utf8"));
      const validateWebhook = new Ajv({
        strict: false,
        validateFormats: false,
      }).compile({
        components: contract.components,
        ...contract.components.schemas.CBCompanyWebhookEnvelope,
      });

      expect(
        validateWebhook(body),
        JSON.stringify(validateWebhook.errors),
      ).toBe(true);
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
                ...(secret === null
                  ? {}
                  : { Authorization: `Bearer ${secret}` }),
                ...(deliveryId === null
                  ? {}
                  : { "Idempotency-Key": deliveryId }),
              },
              body: JSON.stringify(value),
            },
          ),
          { params: Promise.resolve({ agentId }) },
        );

      expect((await submit(null)).status).toBe(401);
      const recoveryKey = randomUUID();

      await localHost({ db, transport: createLocalDirectTransport() });
      await database.pool.query(
        "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
      );
      const recovery = await createCompanyGrants(db, administratorId, {
        principalKind: "user",
        principalId: userId,
        actions: ["assignments:recover"],
        idempotencyKey: randomUUID(),
      });
      const recoveryGrant = recovery.page.items[0];

      try {
        const accepted = await submit(token.secret, body, recoveryKey);

        expect(accepted.status).toBe(201);
        const original = specialistAssignmentSchema.parse(
          await accepted.json(),
        );
        const [sourceRunId] = original.runIds;
        const failure = await prepareUndispatchedAgentFailure(sourceRunId, {
          db,
          reason: "agent_dispatch_failed",
        });

        await db.transaction(failure.apply);
        const preview = await getAgentRetryOptions(db, sourceRunId, userId);

        expect(preview).toMatchObject({
          eligible: true,
          selectedRunnerId: runnerId,
        });
        const replacement = await acceptAgentRetry(db, sourceRunId, userId, {
          requestKey: randomUUID(),
          runnerId,
          previewFingerprint: preview.previewFingerprint,
        });

        expect(replacement).toMatchObject({
          intentState: "launched",
          runStatus: "Pending",
        });
        expect(
          await db.transaction((tx) =>
            loadCompanyAgentSessionContext(tx, replacement.runId!),
          ),
        ).toMatchObject({
          run: { triggerSource: "webhook", retryOfRunId: sourceRunId },
          input: {
            snapshot: { objectiveInput: { input: body.assignment.input } },
          },
        });
        const replay = await submit(rotated.secret, body, recoveryKey);

        expect(replay.status).toBe(200);
        expect(
          specialistAssignmentSchema.parse(await replay.json()),
        ).toMatchObject({
          id: original.id,
          runIds: expect.arrayContaining([sourceRunId, replacement.runId]),
        });
        const settle = await prepareUndispatchedAgentFailure(
          replacement.runId!,
          {
            db,
            reason: "fixture_replacement_complete",
          },
        );

        await db.transaction(settle.apply);
      } finally {
        await database.pool.query("DELETE FROM execution_host_pressure");
        await revokeCompanyGrant(db, administratorId, recoveryGrant.id, {
          expectedRevision: recoveryGrant.revision,
          reason: "Release webhook recovery qualification authority",
          idempotencyKey: randomUUID(),
        });
      }
      const responses = await Promise.all([
        submit(token.secret),
        submit(rotated.secret),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 201,
      ]);
      const assignments = await Promise.all(
        responses.map(async (response) => {
          expect(response.headers.get("cache-control")).toBe(
            "private, no-store",
          );

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

  it.each([
    {
      roleId: "rah:projection-reader",
      actions: ["assignments:read"],
      expectedStatus: "Done",
      recorded: true,
      privateSource: false,
    },
    {
      roleId: "rah:projection-disabled",
      actions: ["knowledge:read", "knowledge:propose"],
      expectedStatus: "Done",
      recorded: false,
      privateSource: false,
    },
    {
      roleId: "rah:projection-denied",
      actions: ["assignments:read"],
      expectedStatus: "Failed",
      recorded: false,
      privateSource: true,
    },
  ] as const)(
    "IT-CBA-04 projects native working context before real standalone dispatch under current role/source policy ($roleId)",
    async (scenario) => {
      const db: Db = database.db;
      const supervisor = await startRealSupervisor({
        runtimeRoot: join(root, scenario.roleId.replace(":", "-")),
        workspaceRoots: [join(root, "worktrees")],
        fixtureArgs: ["--hang"],
      });
      const restoreUrl = useRealSupervisorUrl(supervisor.url);
      const worker = startProjectionWorker({
        db,
        projectors: canonicalProjectors,
      });

      setDefaultTransportForTests(null);
      resetResolverForTests();
      resetRegistrarStateForTests();
      let sourceGrant:
        Awaited<ReturnType<typeof createCompanyGrants>> | undefined;

      try {
        const effective = await resolveInstalledAgentDefinition(db, {
          agentId: scenario.roleId,
          packageInstallId: assignmentInput.standingDefinition.packageInstallId,
        });
        const runnerId = randomUUID();

        await db.insert(platformAcpRunners).values({
          id: runnerId,
          adapter: "claude",
          capabilityAgent: "claude",
          model: "context-projection-fixture",
          provider: { kind: "anthropic" },
          readinessStatus: "Ready",
        });
        const binding = await createCompanySpecialistBinding(
          db,
          userId,
          scenario.roleId,
          {
            owner: { kind: "company", companyId: request.companyId },
            packageInstallId: effective.packageInstallId,
            packageRevision: effective.resolvedRevision!,
            definitionSha256: agentDefinitionSha256(effective.parsed),
            enabled: true,
            configuration: {},
            grantActions: [...scenario.actions],
            runnerId,
            idempotencyKey: randomUUID(),
          },
        );
        const assignment = await createSpecialistAssignment(db, userId, {
          ...assignmentInput,
          specialistBindingId: binding.specialist.bindingId,
          responsibleAgentId: scenario.roleId,
          standingDefinition: {
            ...assignmentInput.standingDefinition,
            agentId: scenario.roleId,
            definition: effective.parsed,
            definitionSha256: agentDefinitionSha256(effective.parsed),
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
        const references: {
          kind: "knowledge";
          id: string;
          revision: number;
        }[] = [];

        if (scenario.privateSource) {
          sourceGrant = await createCompanyGrants(db, administratorId, {
            principalKind: "user",
            principalId: userId,
            actions: ["knowledge:read"],
            idempotencyKey: randomUUID(),
          });
          const recordId = randomUUID();

          await database.pool.query(
            "INSERT INTO brain_items(id,company_id,kind,title,content,confidence,content_hash) VALUES($1,$2,'observation','Private projected source','This source is not shared with the executing role',0.9,$3)",
            [recordId, request.companyId, randomUUID()],
          );
          references.push({ kind: "knowledge", id: recordId, revision: 1 });
        }
        const text = `Working context for ${scenario.roleId} must respect its reviewed read limit`;
        const context = await appendSpecialistAssignmentContext(
          db,
          userId,
          assignment.id,
          {
            expectedRevision: 0,
            expectedInputRevision: 1,
            idempotencyKey: randomUUID(),
            updates: [
              {
                id: "working-question",
                kind: "question",
                text,
                state: "open",
                references,
              },
            ],
          },
        );

        expect(await tryStartRun(receipt.runId, { db })).toMatchObject({
          started: true,
        });
        await startAgentSession(receipt.runId, { db, executionHosts: hosts });
        await vi.waitFor(
          async () => {
            const [run] = await db
              .select()
              .from(runs)
              .where(eq(runs.id, receipt.runId));

            expect(run?.status).toBe(scenario.expectedStatus);
          },
          { timeout: 30000, interval: 25 },
        );
        const creates = (
          await database.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
            [receipt.runId],
          )
        ).rows[0]!.count;

        if (scenario.expectedStatus === "Failed") expect(creates).toBe(0);
        else {
          expect(creates).toBe(2);
          const prompt = await retainedPrompt(receipt.runId);

          if (scenario.recorded)
            expect(prompt).toContain(JSON.stringify(context));
          else expect(prompt).not.toContain(text);
        }
      } finally {
        if (sourceGrant) {
          const grant = sourceGrant.page.items.find(
            (item) => item.action === "knowledge:read",
          )!;

          await revokeCompanyGrant(db, administratorId, grant.id, {
            expectedRevision: grant.revision,
            reason: "Release owned context projection authority",
            idempotencyKey: randomUUID(),
          });
        }
        await worker.stop();
        await stopRuntimeEventConsumers();
        await supervisor.stop();
        restoreUrl();
        resetResolverForTests();
        resetRegistrarStateForTests();
        setDefaultTransportForTests(null);
      }
    },
    45000,
  );

  it.each(["normal", "activation-recovery", "agent", "cancelled"] as const)(
    "IT-CBA-05 persists and activates a company assignment clarification through its real owned checkpoint without a task (%s)",
    async (mode) => {
      const db: Db = database.db;
      const supervisor = await startRealSupervisor({
        runtimeRoot: join(root, `assignment-question-${mode}-host`),
        workspaceRoots: [join(root, "worktrees")],
        fixtureArgs: ["--hang", "--controlled-prompt", "--supports-resume"],
      });
      const restoreUrl = useRealSupervisorUrl(supervisor.url);
      const worker = startProjectionWorker({
        db,
        projectors: canonicalProjectors,
      });
      const abort = new AbortController();
      let ownedAnswerGrant:
        Readonly<{ id: string; revision: number }> | undefined;
      let continuation:
        ReturnType<typeof startAgentContinuationWorker> | undefined;
      let driver: Promise<unknown> | undefined;
      let runId: string | undefined;

      setDefaultTransportForTests(null);
      resetResolverForTests();
      resetRegistrarStateForTests();
      try {
        const roleIds = {
          normal: "rah:question-observer",
          "activation-recovery": "rah:question-recovery-observer",
          agent: "rah:question-agent-observer",
          cancelled: "rah:question-cancelled-observer",
        } as const;
        const roleId = roleIds[mode];
        const effective = await resolveInstalledAgentDefinition(db, {
          agentId: roleId,
          packageInstallId: assignmentInput.standingDefinition.packageInstallId,
        });
        const runnerId = randomUUID();

        await db.insert(platformAcpRunners).values({
          id: runnerId,
          adapter: "claude",
          capabilityAgent: "claude",
          model: "assignment-question-fixture",
          provider: { kind: "anthropic" },
          readinessStatus: "Ready",
        });
        const binding = await createCompanySpecialistBinding(
          db,
          userId,
          roleId,
          {
            owner: { kind: "company", companyId: request.companyId },
            packageInstallId: effective.packageInstallId,
            packageRevision: effective.resolvedRevision!,
            definitionSha256: agentDefinitionSha256(effective.parsed),
            enabled: true,
            configuration: {},
            grantActions: ["assignments:read", "assignments:update"],
            runnerId,
            idempotencyKey: randomUUID(),
          },
        );
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

        runId = receipt.runId;
        expect(await tryStartRun(runId, { db })).toMatchObject({
          started: true,
        });
        driver = startAgentSession(runId, {
          db,
          executionHosts: hosts,
          signal: abort.signal,
        }).catch((error: unknown) => error);
        await vi.waitFor(
          async () => {
            const turns = (
              await database.pool.query(
                "SELECT id FROM agent_turns WHERE run_id=$1 AND state='dispatched' AND command_id IS NOT NULL",
                [runId],
              )
            ).rows;

            expect(turns).toHaveLength(1);
          },
          { timeout: 30000, interval: 25 },
        );
        if (mode === "normal")
          await appendSpecialistAssignmentContext(db, userId, assignment.id, {
            expectedRevision: 0,
            expectedInputRevision: 1,
            idempotencyKey: randomUUID(),
            updates: [
              {
                id: "retained-diagnostic-hypothesis",
                kind: "hypothesis",
                text: "Preserve this working hypothesis across clarification input revisions",
                state: "open",
                references: [],
              },
            ],
          });
        const questionRevision =
          receipt.assignmentRevision + (mode === "normal" ? 1 : 0);
        const body = {
          expectedRevision: questionRevision,
          inputRevision: 1,
          question: "Which configured component should be inspected?",
          schema: {
            schemaVersion: 1 as const,
            fields: [
              {
                name: "component",
                type: "string" as const,
                required: true,
                label: "Component",
                options: ["web", "supervisor"],
              },
            ],
          },
          reTriggerMode: "agent" as const,
          idempotencyKey: randomUUID(),
        };
        const { createOrActivateAssignmentQuestion } =
          await import("@/lib/services/assignment-question");

        if (mode === "normal") {
          for (const schema of [
            {
              ...body.schema,
              assignmentQuestion: { actor: { kind: "user", id: "forged" } },
            },
            { ...body.schema, flowQuestion: { commandId: "forged" } },
            { ...body.schema, agentPrompt: { commandId: "forged" } },
            { ...body.schema, supervisorSessionId: "forged" },
            {
              schemaVersion: 1,
              fields: Array.from({ length: 65 }, (_, index) => ({
                name: `field_${index}`,
                type: "string",
                required: true,
              })),
            },
            {
              schemaVersion: 1,
              fields: [{ name: "constructor", type: "string", required: true }],
            },
            {
              schemaVersion: 1,
              fields: [
                { name: "component", type: "string" },
                { name: "component", type: "number" },
              ],
            },
            {
              schemaVersion: 1,
              fields: [
                {
                  name: "observations",
                  type: "array",
                  items: {
                    type: "object",
                    fields: [{ name: "prototype", type: "string" }],
                  },
                },
              ],
            },
          ]) {
            await expect(
              createOrActivateAssignmentQuestion(
                db,
                { kind: "user", userId },
                assignment.id,
                { ...body, schema },
                { executionHosts: hosts },
              ),
            ).rejects.toMatchObject({ code: "CONFIG" });
          }
          let deepField: unknown = { name: "leaf", type: "string" };

          for (let depth = 0; depth < 70; depth += 1)
            deepField = { name: "nested", type: "object", fields: [deepField] };
          await expect(
            createOrActivateAssignmentQuestion(
              db,
              { kind: "user", userId },
              assignment.id,
              { ...body, schema: { schemaVersion: 1, fields: [deepField] } },
              { executionHosts: hosts },
            ),
          ).rejects.toMatchObject({ code: "CONFIG" });
          await expect(
            createOrActivateAssignmentQuestion(
              db,
              { kind: "user", userId },
              assignment.id,
              { ...body, question: "x".repeat(8100) },
              { executionHosts: hosts },
            ),
          ).rejects.toMatchObject({ code: "PRECONDITION" });
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM hitl_requests WHERE specialist_assignment_id=$1",
                [assignment.id],
              )
            ).rows,
          ).toEqual([{ count: 0 }]);
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.checkpoint'",
                [runId],
              )
            ).rows,
          ).toEqual([{ count: 0 }]);
        }
        let questionTokenSecret: string | undefined;
        let questionPrincipal: AssignmentContextPrincipal = {
          kind: "user",
          userId,
        };

        if (mode === "agent") {
          const credential = await issueCompanyAgentRunToken({ db, runId });

          questionPrincipal = { kind: "token", tokenId: credential.tokenId };
          questionTokenSecret = credential.secret;
          await expect(
            createOrActivateAssignmentQuestion(
              db,
              questionPrincipal,
              assignment.id,
              body,
              { executionHosts: hosts },
            ),
          ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
          await createCompanyGrants(db, administratorId, {
            principalKind: "agent",
            principalId: roleId,
            actions: ["assignments:update"],
            idempotencyKey: randomUUID(),
          });
        }
        if (mode === "activation-recovery") {
          await expect(
            createOrActivateAssignmentQuestion(
              db,
              { kind: "user", userId },
              assignment.id,
              body,
              {
                executionHosts: hosts,
                recordSuccessAudit: async () => {
                  throw new MaisterError(
                    "CRASH",
                    "Injected activation persistence failure",
                  );
                },
              },
            ),
          ).rejects.toMatchObject({ code: "CRASH" });
          expect(
            (
              await database.pool.query(
                "SELECT activation_state FROM hitl_requests WHERE specialist_assignment_id=$1",
                [assignment.id],
              )
            ).rows,
          ).toEqual([{ activation_state: "pending_termination" }]);
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM assignments WHERE hitl_request_id IN (SELECT id FROM hitl_requests WHERE specialist_assignment_id=$1)",
                [assignment.id],
              )
            ).rows,
          ).toEqual([{ count: 0 }]);
          expect(
            (
              await database.pool.query("SELECT status FROM runs WHERE id=$1", [
                runId,
              ])
            ).rows,
          ).toEqual([{ status: "NeedsInputIdle" }]);
          const { recoverPendingAgentQuestions } =
            await import("@/lib/services/agent-question");

          expect(
            await recoverPendingAgentQuestions({
              db,
              sessions: [],
              executionHosts: hosts,
            }),
          ).toBe(1);
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.checkpoint'",
                [runId],
              )
            ).rows,
          ).toEqual([{ count: 1 }]);
        }
        const first = await (async () => {
          if (mode === "normal") {
            const { POST } =
              await import("@/app/api/specialist-assignments/[assignmentId]/questions/route");

            browserSession.user = await requireActiveUserById(userId);
            const ask = (value: unknown) =>
              POST(
                new NextRequest(
                  `http://localhost/api/specialist-assignments/${assignment.id}/questions`,
                  {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      Origin: "http://localhost",
                      "Sec-Fetch-Site": "same-origin",
                    },
                    body: JSON.stringify(value),
                  },
                ),
                { params: Promise.resolve({ assignmentId: assignment.id }) },
              );

            expect(
              (await ask({ ...body, actor: { kind: "user", id: "forged" } }))
                .status,
            ).toBe(400);
            expect(
              (
                await ask({
                  ...body,
                  expectedRevision: body.expectedRevision + 1,
                })
              ).status,
            ).toBe(409);
            expect(
              (await ask({ ...body, question: "x".repeat(34000) })).status,
            ).toBe(413);
            const response = await ask(body);

            expect(
              response.status,
              JSON.stringify(await response.clone().json()),
            ).toBe(201);
            expect(response.headers.get("cache-control")).toBe(
              "private, no-store",
            );

            return assignmentQuestionReceiptSchema.parse(await response.json());
          }
          if (mode === "agent") {
            const { POST } =
              await import("@/app/api/v1/ext/specialist-assignments/[assignmentId]/questions/route");
            const ask = (value: unknown) =>
              POST(
                new NextRequest(
                  `http://localhost/api/v1/ext/specialist-assignments/${assignment.id}/questions`,
                  {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      authorization: `Bearer ${questionTokenSecret}`,
                    },
                    body: JSON.stringify(value),
                  },
                ),
                { params: Promise.resolve({ assignmentId: assignment.id }) },
              );

            expect(
              (await ask({ ...body, actor: { kind: "user", id: "forged" } }))
                .status,
            ).toBe(422);
            const response = await ask(body);

            expect(
              response.status,
              JSON.stringify(await response.clone().json()),
            ).toBe(201);
            expect(response.headers.get("cache-control")).toBe(
              "private, no-store",
            );
            expect((await ask(body)).status).toBe(401);
            expect(
              (
                await database.pool.query(
                  "SELECT result,status_code FROM token_audit_log WHERE token_id=$1 AND endpoint='POST /api/v1/ext/specialist-assignments/[assignmentId]/questions' ORDER BY created_at",
                  [
                    questionPrincipal.kind === "token"
                      ? questionPrincipal.tokenId
                      : null,
                  ],
                )
              ).rows,
            ).toEqual([
              { result: "error", status_code: 422 },
              { result: "ok", status_code: 201 },
              { result: "error", status_code: 401 },
            ]);

            return assignmentQuestionReceiptSchema.parse(await response.json());
          }

          return createOrActivateAssignmentQuestion(
            db,
            questionPrincipal,
            assignment.id,
            body,
            { executionHosts: hosts },
          );
        })();

        expect(first).toMatchObject({
          assignmentId: assignment.id,
          sourceRunId: runId,
          inputRevision: 1,
          activationState: "active",
          created: mode !== "activation-recovery",
        });
        expect(
          (
            await database.pool.query(
              "SELECT task_id,specialist_assignment_id,specialist_input_revision,activation_state,schema->'assignmentQuestion'->'actor' AS actor FROM hitl_requests WHERE id=$1",
              [first.hitlRequestId],
            )
          ).rows,
        ).toEqual([
          {
            task_id: null,
            specialist_assignment_id: assignment.id,
            specialist_input_revision: 1,
            activation_state: "active",
            actor:
              mode === "agent"
                ? { kind: "agent", id: roleId, runId, attemptId: null }
                : { kind: "user", id: userId, runId: null, attemptId: null },
          },
        ]);
        expect(
          (
            await database.pool.query(
              "SELECT project_id,company_id,task_id FROM assignments WHERE hitl_request_id=$1",
              [first.hitlRequestId],
            )
          ).rows,
        ).toEqual([
          { project_id: null, company_id: request.companyId, task_id: null },
        ]);
        expect(
          (
            await database.pool.query("SELECT status FROM runs WHERE id=$1", [
              runId,
            ])
          ).rows,
        ).toEqual([{ status: "NeedsInputIdle" }]);
        expect(
          (
            await database.pool.query(
              "SELECT status,input_revision FROM specialist_assignments WHERE id=$1",
              [assignment.id],
            )
          ).rows,
        ).toEqual([{ status: "waiting_input", input_revision: 1 }]);
        if (mode === "agent") {
          await expect(
            createOrActivateAssignmentQuestion(
              db,
              questionPrincipal,
              assignment.id,
              body,
              { executionHosts: hosts },
            ),
          ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
          const rotated = await issueCompanyAgentRunToken({ db, runId });

          questionPrincipal = { kind: "token", tokenId: rotated.tokenId };
        }
        expect(
          await createOrActivateAssignmentQuestion(
            db,
            questionPrincipal,
            assignment.id,
            body,
            { executionHosts: hosts },
          ),
        ).toMatchObject({ hitlRequestId: first.hitlRequestId, created: false });
        await expect(
          createOrActivateAssignmentQuestion(
            db,
            questionPrincipal,
            assignment.id,
            {
              ...body,
              question:
                "A changed delivery must not replace the original question",
            },
            { executionHosts: hosts },
          ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        for (const mutation of [
          "UPDATE hitl_requests SET prompt='A forged question replaces the original' WHERE id=$1",
          "UPDATE hitl_requests SET schema=jsonb_set(schema,'{assignmentQuestion,actor,id}',to_jsonb('forged-author'::text)) WHERE id=$1",
          "DELETE FROM hitl_requests WHERE id=$1",
        ])
          await expect(
            database.pool.query(mutation, [first.hitlRequestId]),
          ).rejects.toMatchObject({
            code: "23514",
            constraint: "hitl_specialist_question_immutable",
          });
        expect(
          (
            await database.pool.query(
              "SELECT count(*)::int AS count FROM hitl_requests WHERE specialist_assignment_id=$1",
              [assignment.id],
            )
          ).rows,
        ).toEqual([{ count: 1 }]);
        if (mode === "normal") {
          const answerGrants = await createCompanyGrants(db, administratorId, {
            principalKind: "user",
            principalId: userId,
            actions: ["assignments:answer"],
            idempotencyKey: randomUUID(),
          });

          ownedAnswerGrant = answerGrants.page.items.find(
            (grant) => grant.action === "assignments:answer",
          );
          browserSession.user = await requireActiveUserById(userId);
          const answerValue = (response: unknown) =>
            respondHitlPost(
              new NextRequest(
                `http://localhost/api/runs/${runId}/hitl/${first.hitlRequestId}/respond`,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    Origin: "http://localhost",
                    "Sec-Fetch-Site": "same-origin",
                  },
                  body: JSON.stringify({ response }),
                },
              ),
              {
                params: Promise.resolve({
                  runId: receipt.runId,
                  hitlRequestId: first.hitlRequestId,
                }),
              },
            );

          const answer = (component: string) => answerValue({ component });

          expect((await answer("   ")).status).toBe(422);
          expect(
            (
              await answerValue(
                JSON.parse('{"component":"web","__proto__":{"forged":true}}'),
              )
            ).status,
          ).toBe(422);
          expect((await answerValue({})).status).toBe(422);
          expect((await answer("x".repeat(9000))).status).toBe(409);
          expect((await answer("x".repeat(34000))).status).toBe(400);
          let deeplyNested: unknown = "leaf";

          for (let depth = 0; depth < 70; depth += 1)
            deeplyNested = { child: deeplyNested };
          expect(
            (await answerValue({ component: "web", extra: deeplyNested }))
              .status,
          ).toBe(422);
          const answerInput = {
            expectedRevision: questionRevision + 1,
            inputRevision: 1,
            response: { component: "custom-component" },
            idempotencyKey: `hitl:${first.hitlRequestId}`,
          };

          await expect(
            answerAssignmentQuestion(
              db,
              userId,
              assignment.id,
              first.hitlRequestId,
              {
                ...answerInput,
                expectedRevision: answerInput.expectedRevision + 1,
              },
            ),
          ).rejects.toMatchObject({ code: "CONFLICT" });
          await expect(
            answerAssignmentQuestion(
              db,
              userId,
              assignment.id,
              first.hitlRequestId,
              { ...answerInput, inputRevision: 2 },
            ),
          ).rejects.toMatchObject({ code: "CONFLICT" });
          await expect(
            answerAssignmentQuestion(
              db,
              userId,
              assignment.id,
              first.hitlRequestId,
              answerInput,
              async () => {
                throw new MaisterError(
                  "CRASH",
                  "Injected answer audit persistence failure",
                );
              },
            ),
          ).rejects.toMatchObject({ code: "CRASH" });
          expect(
            (
              await database.pool.query(
                "SELECT status,input_revision FROM specialist_assignments WHERE id=$1",
                [assignment.id],
              )
            ).rows,
          ).toEqual([{ status: "waiting_input", input_revision: 1 }]);
          expect(
            (
              await database.pool.query(
                "SELECT response,specialist_answer_input_revision FROM hitl_requests WHERE id=$1",
                [first.hitlRequestId],
              )
            ).rows,
          ).toEqual([
            { response: null, specialist_answer_input_revision: null },
          ]);
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM specialist_input_revisions WHERE assignment_id=$1",
                [assignment.id],
              )
            ).rows,
          ).toEqual([{ count: 1 }]);
          const { POST: respondNative } =
            await import("@/app/api/specialist-assignments/[assignmentId]/questions/[questionId]/respond/route");
          const nativeAnswer = (value: unknown) =>
            respondNative(
              new NextRequest(
                `http://localhost/api/specialist-assignments/${assignment.id}/questions/${first.hitlRequestId}/respond`,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    Origin: "http://localhost",
                    "Sec-Fetch-Site": "same-origin",
                  },
                  body: JSON.stringify(value),
                },
              ),
              {
                params: Promise.resolve({
                  assignmentId: assignment.id,
                  questionId: first.hitlRequestId,
                }),
              },
            );

          expect(
            (await nativeAnswer({ ...answerInput, actor: "forged" })).status,
          ).toBe(400);
          const concurrent = await Promise.all([
            nativeAnswer(answerInput),
            answer("custom-component"),
          ]);

          expect(concurrent.map((response) => response.status).sort()).toEqual([
            200, 202,
          ]);

          const answered = (
            await database.pool.query(
              "SELECT status,input_revision,revision FROM specialist_assignments WHERE id=$1",
              [assignment.id],
            )
          ).rows[0];

          expect(answered).toMatchObject({
            status: "active",
            input_revision: 2,
            revision: questionRevision + 2,
          });
          expect(
            (
              await database.pool.query(
                "SELECT specialist_answer_input_revision,response FROM hitl_requests WHERE id=$1",
                [first.hitlRequestId],
              )
            ).rows,
          ).toEqual([
            {
              specialist_answer_input_revision: 2,
              response: { component: "custom-component" },
            },
          ]);
          const { POST: respondExternal } =
            await import("@/app/api/v1/ext/specialist-assignments/[assignmentId]/questions/[questionId]/respond/route");
          const answerToken = await issueUserAccessToken(
            {
              ownerUserId: userId,
              name: "native-human-answer",
              scopes: ["assignments:answer"],
            },
            db,
          );
          const externalAnswer = (value: unknown) =>
            respondExternal(
              new NextRequest(
                `http://localhost/api/v1/ext/specialist-assignments/${assignment.id}/questions/${first.hitlRequestId}/respond`,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${answerToken.secret}`,
                  },
                  body: JSON.stringify(value),
                },
              ),
              {
                params: Promise.resolve({
                  assignmentId: assignment.id,
                  questionId: first.hitlRequestId,
                }),
              },
            );

          expect((await externalAnswer(answerInput)).status).toBe(200);
          expect(
            (
              await externalAnswer({
                ...answerInput,
                response: { component: "changed" },
              })
            ).status,
          ).toBe(409);
          await database.pool.query(
            "UPDATE project_tokens SET revoked_at=now() WHERE id=$1",
            [answerToken.tokenId],
          );
          expect((await externalAnswer(answerInput)).status).toBe(401);
          expect((await answer("custom-component")).status).toBe(200);
          expect((await answer("changed-component")).status).toBe(409);
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM specialist_input_revisions WHERE assignment_id=$1",
                [assignment.id],
              )
            ).rows,
          ).toEqual([{ count: 2 }]);
          expect(
            (
              await database.pool.query(
                "SELECT status,resume_requested_at IS NOT NULL AS resume_requested FROM runs WHERE id=$1",
                [runId],
              )
            ).rows,
          ).toEqual([{ status: "NeedsInputIdle", resume_requested: true }]);
          const original = await getSpecialistAssignmentInput(
            db,
            userId,
            assignment.id,
            1,
          );
          const updated = await getSpecialistAssignmentInput(
            db,
            userId,
            assignment.id,
            2,
          );

          expect(updated.snapshot.objectiveInput.input).toContain(
            "custom-component",
          );
          expect(updated.snapshot.standingDefinition).toEqual(
            original.snapshot.standingDefinition,
          );
          expect(updated.snapshot.scheduledRequest).toEqual(
            original.snapshot.scheduledRequest,
          );
          expect(updated.actor).toMatchObject({ kind: "user", id: userId });
          const credential = await issueCompanyAgentRunToken({ db, runId });
          const inspection = await inspectExternal(
            assignment.id,
            credential.secret,
          );

          expect(inspection.status).toBe(200);
          expect(await inspection.json()).toMatchObject({
            id: assignment.id,
            inputRevision: 2,
          });
          for (const mutation of [
            "UPDATE hitl_requests SET specialist_answer=jsonb_set(specialist_answer,'{actor,id}',to_jsonb('forged'::text)) WHERE id=$1",
            'UPDATE hitl_requests SET response=\'{"component":"forged"}\'::jsonb WHERE id=$1',
            "UPDATE hitl_requests SET specialist_answer_input_revision=NULL WHERE id=$1",
          ])
            await expect(
              database.pool.query(mutation, [first.hitlRequestId]),
            ).rejects.toMatchObject({
              code: "23514",
              constraint: "hitl_specialist_question_immutable",
            });
          const currentHost = await localHost({
            db,
            transport: hosts.transport,
          });

          await database.pool.query(
            "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) VALUES($1,now()) ON CONFLICT DO NOTHING",
            [currentHost.id],
          );
          const { claimAgentResumeSlot } = await import("@/lib/services/hitl");

          expect(await claimAgentResumeSlot(db, receipt.runId, hosts)).toEqual({
            outcome: "queued",
          });
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.prompt'",
                [runId],
              )
            ).rows,
          ).toEqual([{ count: 1 }]);
          await database.pool.query(
            "DELETE FROM execution_host_pressure WHERE execution_host_id=$1",
            [currentHost.id],
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
                    "SELECT count(*)::int AS count FROM agent_turns WHERE run_id=$1 AND variant='resume' AND state='dispatched' AND command_id IS NOT NULL",
                    [runId],
                  )
                ).rows[0].count,
              { timeout: 30000, interval: 25 },
            )
            .toBe(1);
          const resumedTurns = (
            await database.pool.query(
              "SELECT id,variant,state,ordinal,command_id FROM agent_turns WHERE run_id=$1 ORDER BY ordinal",
              [runId],
            )
          ).rows;

          expect(resumedTurns).toHaveLength(2);
          expect(resumedTurns[1]).toMatchObject({
            variant: "resume",
            state: "dispatched",
          });
          const resumedCommand = (
            await db
              .select()
              .from(executionCommands)
              .where(
                eq(executionCommands.id, String(resumedTurns[1].command_id)),
              )
          )[0]!;
          const resumedHost = (
            await db
              .select()
              .from(executionHosts)
              .where(eq(executionHosts.id, resumedCommand.executionHostId))
          )[0]!;
          const resumedPrompt = readPromptRequest(
            resumedCommand,
            resumedHost.hostKey,
          ).payload.prompt;

          expect(resumedPrompt).toContain("custom-component");
          expect(
            (
              await database.pool.query(
                "SELECT status,company_execution_snapshot->'assignment'->'inputRevision' AS original_input FROM runs WHERE id=$1",
                [runId],
              )
            ).rows,
          ).toEqual([{ status: "Running", original_input: 1 }]);
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM specialist_run_links WHERE assignment_id=$1",
                [assignment.id],
              )
            ).rows,
          ).toEqual([{ count: 1 }]);
          const currentAnswerGrant = ownedAnswerGrant!;

          await revokeCompanyGrant(db, administratorId, currentAnswerGrant.id, {
            expectedRevision: currentAnswerGrant.revision,
            reason: "Withdraw human answer authority before replay",
            idempotencyKey: randomUUID(),
          });
          ownedAnswerGrant = undefined;
          expect((await answer("custom-component")).status).toBe(403);
          const renewedAnswerGrants = await createCompanyGrants(
            db,
            administratorId,
            {
              principalKind: "user",
              principalId: userId,
              actions: ["assignments:answer"],
              idempotencyKey: randomUUID(),
            },
          );

          ownedAnswerGrant = renewedAnswerGrants.page.items.find(
            (grant) => grant.action === "assignments:answer",
          );
          const secondQuestion = await createOrActivateAssignmentQuestion(
            db,
            { kind: "user", userId },
            assignment.id,
            {
              ...body,
              expectedRevision: questionRevision + 2,
              inputRevision: 2,
              question:
                "Which post-inspection health signal should be checked?",
              idempotencyKey: randomUUID(),
            },
            { executionHosts: hosts },
          );

          expect(secondQuestion).toMatchObject({
            sourceRunId: runId,
            inputRevision: 2,
            activationState: "active",
          });
          const secondAnswer = await respondHitlPost(
            new NextRequest(
              `http://localhost/api/runs/${runId}/hitl/${secondQuestion.hitlRequestId}/respond`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  Origin: "http://localhost",
                  "Sec-Fetch-Site": "same-origin",
                },
                body: JSON.stringify({
                  response: { component: "health-endpoint" },
                }),
              },
            ),
            {
              params: Promise.resolve({
                runId: receipt.runId,
                hitlRequestId: secondQuestion.hitlRequestId,
              }),
            },
          );

          expect(secondAnswer.status).toBe(202);
          expect(
            (await getSpecialistAssignmentInput(db, userId, assignment.id, 3))
              .snapshot.objectiveInput.input,
          ).toContain("health-endpoint");
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM specialist_run_links WHERE assignment_id=$1",
                [assignment.id],
              )
            ).rows,
          ).toEqual([{ count: 1 }]);
          const waitForAnsweredPrompt = async (
            ordinal: number,
          ): Promise<void> => {
            await expect
              .poll(
                async () =>
                  (
                    await database.pool.query(
                      "SELECT count(*)::int AS count FROM agent_turns turn JOIN execution_commands command ON command.id=turn.command_id WHERE turn.run_id=$1 AND turn.ordinal=$2 AND turn.state='dispatched' AND command.state='accepted'",
                      [runId, ordinal],
                    )
                  ).rows[0].count,
                { timeout: 30000, interval: 25 },
              )
              .toBe(1);
          };

          for (
            let completedAnswers = 2;
            completedAnswers < 32;
            completedAnswers += 1
          ) {
            await waitForAnsweredPrompt(completedAnswers);
            const boundedQuestion = await createOrActivateAssignmentQuestion(
              db,
              { kind: "user", userId },
              assignment.id,
              {
                ...body,
                expectedRevision: questionRevision + completedAnswers * 2,
                inputRevision: completedAnswers + 1,
                question: "?",
                schema: { schemaVersion: 1, fields: [] },
                idempotencyKey: randomUUID(),
              },
              { executionHosts: hosts },
            );

            await answerAssignmentQuestion(
              db,
              userId,
              assignment.id,
              boundedQuestion.hitlRequestId,
              {
                expectedRevision: questionRevision + completedAnswers * 2 + 1,
                inputRevision: completedAnswers + 1,
                response: {},
                idempotencyKey: randomUUID(),
              },
            );
          }
          await waitForAnsweredPrompt(32);
          const beforeLimit = (
            await database.pool.query(
              "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.checkpoint'",
              [runId],
            )
          ).rows;

          await expect(
            createOrActivateAssignmentQuestion(
              db,
              { kind: "user", userId },
              assignment.id,
              {
                ...body,
                expectedRevision: questionRevision + 64,
                inputRevision: 33,
                question: "?",
                schema: { schemaVersion: 1, fields: [] },
                idempotencyKey: randomUUID(),
              },
              { executionHosts: hosts },
            ),
          ).rejects.toMatchObject({
            code: "PRECONDITION",
            details: { reason: "assignment_question_limit" },
          });
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind='session.checkpoint'",
                [runId],
              )
            ).rows,
          ).toEqual(beforeLimit);
          expect(
            (
              await database.pool.query(
                "SELECT status,input_revision FROM specialist_assignments WHERE id=$1",
                [assignment.id],
              )
            ).rows,
          ).toEqual([{ status: "active", input_revision: 33 }]);
        }
        if (mode === "cancelled") {
          const responderId = randomUUID();

          await database.pool.query(
            "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
            [responderId, `${responderId}@example.test`],
          );
          await createCompanyGrants(db, administratorId, {
            principalKind: "user",
            principalId: responderId,
            actions: ["assignments:read", "assignments:answer"],
            idempotencyKey: randomUUID(),
          });
          browserSession.user = await requireActiveUserById(userId);
          expect(
            (
              await stopRunPost(
                new Request(`http://localhost/api/runs/${runId}/stop`, {
                  method: "POST",
                }),
                { params: Promise.resolve({ runId: receipt.runId }) },
              )
            ).status,
          ).toBe(200);
          await cancelSpecialistAssignment(
            db,
            userId,
            assignment.id,
            questionRevision + 1,
            "Cancel before answering the retained clarification",
          );
          browserSession.user = await requireActiveUserById(responderId);
          const late = await respondHitlPost(
            new NextRequest(
              `http://localhost/api/runs/${runId}/hitl/${first.hitlRequestId}/respond`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  Origin: "http://localhost",
                  "Sec-Fetch-Site": "same-origin",
                },
                body: JSON.stringify({ response: { component: "too-late" } }),
              },
            ),
            {
              params: Promise.resolve({
                runId: receipt.runId,
                hitlRequestId: first.hitlRequestId,
              }),
            },
          );

          expect(late.status).toBe(409);
          const { POST: respondNative } =
            await import("@/app/api/specialist-assignments/[assignmentId]/questions/[questionId]/respond/route");
          const nativeClosedAnswer = (questionId: string) =>
            respondNative(
              new NextRequest(
                `http://localhost/api/specialist-assignments/${assignment.id}/questions/${questionId}/respond`,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    Origin: "http://localhost",
                    "Sec-Fetch-Site": "same-origin",
                  },
                  body: JSON.stringify({
                    expectedRevision: questionRevision + 1,
                    inputRevision: 1,
                    response: { component: "too-late" },
                    idempotencyKey: randomUUID(),
                  }),
                },
              ),
              {
                params: Promise.resolve({
                  assignmentId: assignment.id,
                  questionId,
                }),
              },
            );
          const outsiderId = randomUUID();

          await database.pool.query(
            "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
            [outsiderId, `${outsiderId}@example.test`],
          );
          browserSession.user = await requireActiveUserById(outsiderId);
          expect((await nativeClosedAnswer(first.hitlRequestId)).status).toBe(
            403,
          );
          browserSession.user = await requireActiveUserById(responderId);
          expect((await nativeClosedAnswer(randomUUID())).status).toBe(404);
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM specialist_input_revisions WHERE assignment_id=$1",
                [assignment.id],
              )
            ).rows,
          ).toEqual([{ count: 1 }]);
          expect(
            (
              await database.pool.query(
                "SELECT response,specialist_answer FROM hitl_requests WHERE id=$1",
                [first.hitlRequestId],
              )
            ).rows,
          ).toEqual([{ response: null, specialist_answer: null }]);
        }
      } finally {
        browserSession.user = await requireActiveUserById(userId);
        if (runId) {
          const retainedRunId = runId;

          await expect
            .poll(
              async () =>
                (
                  await stopRunPost(
                    new Request(
                      `http://localhost/api/runs/${retainedRunId}/stop`,
                      { method: "POST" },
                    ),
                    { params: Promise.resolve({ runId: retainedRunId }) },
                  )
                ).status,
              { timeout: 10000, interval: 25 },
            )
            .toBe(200);
        }
        await continuation?.stop();
        if (ownedAnswerGrant)
          await revokeCompanyGrant(db, administratorId, ownedAnswerGrant.id, {
            expectedRevision: ownedAnswerGrant.revision,
            reason:
              "Release this clarification fixture's exact temporary authority",
            idempotencyKey: randomUUID(),
          });
        abort.abort();
        await supervisor.stop();
        await driver;
        await worker.stop();
        await stopRuntimeEventConsumers();
        restoreUrl();
        browserSession.user = null;
        resetResolverForTests();
        resetRegistrarStateForTests();
        setDefaultTransportForTests(null);
      }
    },
    // All 32 real checkpoint/answer/resume cycles must fit, including bounded owner recovery.
    600000,
  );

  it("IT-CBA-05 resumes a repository-admitted project assignment after its actual specialist clarification under current project membership", async () => {
    const db: Db = database.db;
    const repo = await initRepo(join(root, "project-question-repo"));
    const project = await seedProjectRow(database.db, { repoPath: repo });
    const responderId = randomUUID();
    const responderMembershipId = randomUUID();
    const roleId = "rah:question-project-observer";
    const runnerId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [responderId, `${responderId}@example.test`],
    );
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
    await db.insert(platformAcpRunners).values({
      id: runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "project-question-fixture",
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
    const binding = await attachAgent(
      { projectId: project.id, agentId: roleId, runnerOverrideId: runnerId },
      db,
    );

    await updateAgentLink(
      {
        projectId: project.id,
        agentId: roleId,
        patch: { canReadBrain: false, canWriteBrain: false },
      },
      db,
    );
    const supervisor = await startRealSupervisor({
      runtimeRoot: join(root, "project-question-host"),
      workspaceRoots: [join(root, "worktrees"), repo],
      fixtureArgs: ["--hang", "--controlled-prompt", "--supports-resume"],
    });
    const restoreUrl = useRealSupervisorUrl(supervisor.url);
    const worker = startProjectionWorker({
      db,
      projectors: canonicalProjectors,
    });
    const abort = new AbortController();
    let runId: string | undefined;
    let driver: Promise<unknown> | undefined;
    let continuation:
      ReturnType<typeof startAgentContinuationWorker> | undefined;

    setDefaultTransportForTests(null);
    resetResolverForTests();
    resetRegistrarStateForTests();
    try {
      const hosts = createExecutionHosts({
        db,
        transport: createLocalDirectTransport(),
      });
      const host = await localHost({ db, transport: hosts.transport });

      await database.pool.query(
        "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) VALUES($1,now()) ON CONFLICT DO NOTHING",
        [host.id],
      );
      browserSession.user = await requireActiveUserById(userId);
      const { expectedResult: _expectedResult, ...objective } =
        assignmentInput.objectiveInput;
      const response = await assignmentPost(
        new NextRequest("http://localhost/api/specialist-assignments", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Origin: "http://localhost",
            "Sec-Fetch-Site": "same-origin",
          },
          body: JSON.stringify({
            ...objective,
            owner: { kind: "project", projectId: project.id },
            specialistBindingId: binding.linkId,
            input:
              "Preserve this original repository-admitted diagnostic request",
            idempotencyKey: randomUUID(),
          }),
        }),
      );

      expect(
        response.status,
        JSON.stringify(await response.clone().json()),
      ).toBe(201);
      const assignment = specialistAssignmentSchema.parse(
        await response.json(),
      );

      expect(assignment.runIds).toHaveLength(1);
      runId = assignment.runIds[0]!;
      await database.pool.query(
        "DELETE FROM execution_host_pressure WHERE execution_host_id=$1",
        [host.id],
      );
      expect(await tryStartRun(runId, { db })).toMatchObject({ started: true });
      driver = startAgentSession(runId, {
        db,
        executionHosts: hosts,
        signal: abort.signal,
      }).catch((error: unknown) => error);
      await expect
        .poll(
          async () =>
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM agent_turns WHERE run_id=$1 AND state='dispatched' AND command_id IS NOT NULL",
                [runId],
              )
            ).rows[0].count,
          { timeout: 30000, interval: 25 },
        )
        .toBe(1);
      const credential = await issueAgentRunToken({
        db,
        projectId: project.id,
        agentId: roleId,
        runId,
      });
      const metadata = await inspectExternal(assignment.id, credential.secret);

      expect(metadata.status).toBe(200);
      const current = specialistAssignmentSchema.parse(await metadata.json());
      const { createOrActivateAssignmentQuestion } =
        await import("@/lib/services/assignment-question");
      const question = await createOrActivateAssignmentQuestion(
        db,
        { kind: "token", tokenId: credential.tokenId },
        assignment.id,
        {
          expectedRevision: current.revision,
          inputRevision: 1,
          question: "Which repository component needs diagnosis?",
          schema: {
            schemaVersion: 1,
            fields: [
              {
                name: "component",
                type: "string",
                required: true,
                options: ["web", "supervisor"],
              },
            ],
          },
          reTriggerMode: "agent",
          idempotencyKey: randomUUID(),
        },
        { executionHosts: hosts },
      );

      expect(question).toMatchObject({
        assignmentId: assignment.id,
        sourceRunId: runId,
        activationState: "active",
      });
      expect(
        (
          await database.pool.query(
            "SELECT company_id,project_id,task_id FROM assignments WHERE hitl_request_id=$1",
            [question.hitlRequestId],
          )
        ).rows,
      ).toEqual([{ company_id: null, project_id: project.id, task_id: null }]);
      browserSession.user = await requireActiveUserById(responderId);
      const answer = () =>
        respondHitlPost(
          new NextRequest(
            `http://localhost/api/runs/${runId}/hitl/${question.hitlRequestId}/respond`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                Origin: "http://localhost",
                "Sec-Fetch-Site": "same-origin",
              },
              body: JSON.stringify({
                response: { component: "custom-project-component" },
              }),
            },
          ),
          {
            params: Promise.resolve({
              runId: runId!,
              hitlRequestId: question.hitlRequestId,
            }),
          },
        );

      expect((await answer()).status).toBe(403);
      await database.pool.query(
        "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
        [responderMembershipId, project.id, responderId],
      );
      expect((await answer()).status).toBe(202);
      const updated = await getSpecialistAssignmentInput(
        db,
        userId,
        assignment.id,
        2,
      );

      expect(updated.actor).toMatchObject({ kind: "user", id: responderId });
      expect(updated.snapshot.authoritySnapshot.witnesses).toContainEqual({
        kind: "project_membership",
        projectId: project.id,
        membershipId: responderMembershipId,
        role: "member",
      });
      expect(updated.snapshot.objectiveInput.input).toContain(
        "Preserve this original repository-admitted diagnostic request",
      );
      expect(updated.snapshot.objectiveInput.input).toContain(
        "custom-project-component",
      );
      await database.pool.query("DELETE FROM project_members WHERE id=$1", [
        responderMembershipId,
      ]);
      expect((await answer()).status).toBe(403);
      continuation = startAgentContinuationWorker({
        db,
        executionHosts: hosts,
      });
      await expect
        .poll(
          async () =>
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM agent_turns WHERE run_id=$1 AND variant='resume' AND state='dispatched' AND command_id IS NOT NULL",
                [runId],
              )
            ).rows[0].count,
          { timeout: 30000, interval: 25 },
        )
        .toBe(1);
      const rotated = await issueAgentRunToken({
        db,
        projectId: project.id,
        agentId: roleId,
        runId,
      });
      const inspection = await inspectExternal(assignment.id, rotated.secret);

      expect(inspection.status).toBe(200);
      expect(await inspection.json()).toMatchObject({
        id: assignment.id,
        owner: { kind: "project", projectId: project.id },
        inputRevision: 2,
      });
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM specialist_run_links WHERE assignment_id=$1",
            [assignment.id],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM specialist_input_revisions WHERE assignment_id=$1",
            [assignment.id],
          )
        ).rows,
      ).toEqual([{ count: 2 }]);
    } finally {
      await database.pool.query(
        "DELETE FROM execution_host_pressure WHERE execution_host_id IN (SELECT id FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL)",
      );
      browserSession.user = await requireActiveUserById(userId);
      if (runId) {
        const retainedRunId = runId;

        await expect
          .poll(
            async () =>
              (
                await stopRunPost(
                  new Request(
                    `http://localhost/api/runs/${retainedRunId}/stop`,
                    {
                      method: "POST",
                    },
                  ),
                  { params: Promise.resolve({ runId: retainedRunId }) },
                )
              ).status,
            { timeout: 10000, interval: 25 },
          )
          .toBe(200);
      }
      await continuation?.stop();
      abort.abort();
      await supervisor.stop();
      await driver;
      await worker.stop();
      await stopRuntimeEventConsumers();
      restoreUrl();
      browserSession.user = null;
      resetResolverForTests();
      resetRegistrarStateForTests();
      setDefaultTransportForTests(null);
    }
  }, 60000);

  it("IT-CBA-02 submits project specialist work through its actual attachment, original input and existing agent admission", async () => {
    const db: Db = database.db;
    const repo = await initRepo(join(root, "project-manual-repo"));

    await writeFile(
      join(repo, "README.md"),
      "# Diagnostic project\nInspect the addressed component and return evidence-linked findings.\n",
    );
    await git(repo, "add", "README.md");
    await git(
      repo,
      "commit",
      "-q",
      "-m",
      "Record diagnostic qualification evidence",
    );
    const project = await seedProjectRow(database.db, { repoPath: repo });
    const qualifyCoordinatorTask = async (
      taskId: string,
      assessorId: string,
    ): Promise<void> => {
      const qualificationScope = {
        projectId: project.id,
        taskId,
        userId: assessorId,
      };
      const qualificationDraft = await getHumanTaskAssessmentDraft(
        db,
        qualificationScope,
        { repository: true },
      );

      expect(qualificationDraft.repository).not.toBeNull();
      await recordHumanTaskAssessment(db, qualificationScope, {
        requestKey: randomUUID(),
        contextToken: qualificationDraft.contextToken,
        expectedInputRevision: qualificationDraft.expectedInputRevision,
        expectedQualificationRevision:
          qualificationDraft.expectedQualificationRevision,
        repositoryToken: qualificationDraft.repository!.token,
        requestType: "feature",
        decision: "ready",
        checks: QUALIFICATION_DIMENSIONS.map((dimension) => ({
          dimension,
          state: dimension === "bug_evidence" ? "not_applicable" : "pass",
          rationale:
            dimension === "bug_evidence"
              ? "This is a diagnostic feature request."
              : "Reviewed the retained original specialist input, source reservation and evidence-linked result requirement.",
          evidenceIndexes: [0],
        })),
        evidence: [{ kind: "file", path: "README.md" }],
        nextActions: [],
      });
    };
    const drainProjectTriggerEvents = async (): Promise<void> => {
      const watermark = (
        await database.pool.query<{ id: string }>(
          "SELECT coalesce(max(id),0)::text AS id FROM domain_events",
        )
      ).rows[0].id;

      await poll(
        async () => {
          expect(await dispatchDomainEvents({ db })).toMatchObject({
            failures: 0,
          });
          const cursor = (
            await database.pool.query<{ complete: boolean }>(
              "SELECT cursor_event_id >= $1::bigint AS complete FROM domain_event_consumers WHERE consumer_id='agent_triggers'",
              [watermark],
            )
          ).rows[0];

          return cursor?.complete ? true : null;
        },
        30000,
        `agent_triggers cursor through event ${watermark}`,
        25,
      );
    };
    const qualifyQueuedCoordinators = async (): Promise<void> => {
      await drainProjectTriggerEvents();
      const queued = (
        await database.pool.query<{ task_id: string }>(
          `SELECT head.project_task_id AS task_id FROM specialist_assignments head
       JOIN specialist_input_revisions input ON input.assignment_id=head.id AND input.revision=head.input_revision
       WHERE head.project_id=$1 AND head.status='queued' AND head.project_task_id IS NOT NULL
         AND input.standing_definition->'schemaVersion'='2'::jsonb
         AND NOT EXISTS(SELECT 1 FROM task_launch_intents intent WHERE intent.task_id=head.project_task_id)`,
          [project.id],
        )
      ).rows;

      for (const work of queued)
        await qualifyCoordinatorTask(work.task_id, administratorId);
      await drainProjectTriggerEvents();
    };
    const driveCoordinatorAssignment = async (
      assignmentId: string,
    ): Promise<void> => {
      const intents = (
        await database.pool.query<{ id: string }>(
          `SELECT intent.id FROM task_launch_intents intent JOIN specialist_assignments head
       ON head.project_task_id=intent.task_id WHERE head.id=$1`,
          [assignmentId],
        )
      ).rows;

      expect(intents).toHaveLength(1);
      const { prepareTaskLaunchIntent, dispatchTaskLaunchIntent } =
        await import("@/lib/tasks/launch-dispatch");

      await prepareTaskLaunchIntent(db, intents[0].id);
      await dispatchTaskLaunchIntent(db, intents[0].id);
    };

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
    const worker = startProjectionWorker({
      db,
      projectors: canonicalProjectors,
    });
    let initialRunIds: readonly string[] | undefined;
    let restoreAgentDispatch: (() => void) | undefined;
    let restoreFlowDispatch: (() => void) | undefined;
    const dispatchedRunIds = new Set<string>();
    const activeDispatches = new Set<
      Promise<Readonly<{ ok: true } | { ok: false; error: unknown }>>
    >();
    const dispatchAbort = new AbortController();
    const cleanupFailures: unknown[] = [];
    let closing = false;
    let bodyFailure: Readonly<{ error: unknown }> | undefined;
    let ownedCancellation:
      Readonly<{ id: string; revision: number }> | undefined;
    const observeDispatch = (
      runId: string,
      pending: Promise<void>,
    ): Promise<void> => {
      dispatchedRunIds.add(runId);
      const settled = pending.then(
        (): Readonly<{ ok: true }> => ({ ok: true }),
        (error: unknown): Readonly<{ ok: false; error: unknown }> => ({
          ok: false,
          error,
        }),
      );

      activeDispatches.add(settled);
      void settled.then((outcome) => {
        activeDispatches.delete(settled);
        if (closing && !outcome.ok) cleanupFailures.push(outcome.error);
      });

      return pending;
    };
    const originalAgentDispatch = agentLaunch.startAgentSession;
    const originalFlowDispatch = flowRunner.runFlow;

    setDefaultTransportForTests(null);
    resetResolverForTests();
    resetRegistrarStateForTests();
    try {
      initialRunIds = (
        await database.pool.query<{ id: string }>("SELECT id FROM runs")
      ).rows.map((row) => row.id);
      const agentDispatch = vi.spyOn(agentLaunch, "startAgentSession");

      restoreAgentDispatch = () => {
        agentDispatch.mockRestore();
      };
      agentDispatch.mockImplementation((runId, options = {}) =>
        observeDispatch(
          runId,
          originalAgentDispatch(runId, {
            ...options,
            signal: options.signal
              ? AbortSignal.any([options.signal, dispatchAbort.signal])
              : dispatchAbort.signal,
          }),
        ),
      );
      const flowDispatch = vi.spyOn(flowRunner, "runFlow");

      restoreFlowDispatch = () => {
        flowDispatch.mockRestore();
      };
      flowDispatch.mockImplementation((runId, options = {}) =>
        observeDispatch(
          runId,
          originalFlowDispatch(runId, {
            ...options,
            signal: options.signal
              ? AbortSignal.any([options.signal, dispatchAbort.signal])
              : dispatchAbort.signal,
          }),
        ),
      );
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
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "Sec-Fetch-Site": "same-origin",
            },
            body: JSON.stringify(request),
          }),
        );

      const routedContract: {
        components: { schemas: Record<string, object> };
      } = parse(
        await readFile(resolve("../docs/api/web.openapi.yaml"), "utf8"),
      );
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
              headers: {
                "Content-Type": "application/json",
                Origin: "http://localhost",
                "Sec-Fetch-Site": "same-origin",
              },
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

      expect((await submitExternal(value, projectToken.secret)).status).toBe(
        403,
      );
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
      const assignment = specialistAssignmentSchema.parse(
        await response.json(),
      );

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
                headers: {
                  Authorization: `Bearer ${contextCredential.secret}`,
                },
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
      const projectWorkingContext = await appendSpecialistAssignmentContext(
        db,
        userId,
        assignment.id,
        {
          expectedRevision: 0,
          expectedInputRevision: 1,
          idempotencyKey: randomUUID(),
          updates: [
            {
              id: "project-runtime-question",
              kind: "question",
              text: "Retain the original project question through deferred execution",
              state: "open",
              references: [],
            },
          ],
        },
      );

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
      expect(await retainedPrompt(runId)).toContain(
        JSON.stringify(projectWorkingContext),
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
        expect((await submitRouted("rah:wire-observer", value)).status).toBe(
          403,
        );
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
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "Sec-Fetch-Site": "same-origin",
            },
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
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "Sec-Fetch-Site": "same-origin",
            },
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
        "@rah:wire-observer Retain this independent request if launch is interrupted.",
      ]) {
        const response = await taskCommentPost(
          new NextRequest(
            `http://localhost/api/projects/${project.slug}/tasks/9001/comments`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: "http://localhost",
                "Sec-Fetch-Site": "same-origin",
              },
              body: JSON.stringify({ body: text }),
            },
          ),
          { params: Promise.resolve({ slug: project.slug, number: "9001" }) },
        );

        expect(response.status).toBe(201);
        const body: { comment: { id: string } } = await response.json();

        commentIds.push(body.comment.id);
        await drainProjectTriggerEvents();
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

      expect(commentWork).toHaveLength(3);
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
      const [interruptedComment, ...ordinaryComments] = commentWork;
      const failedCommentRun = interruptedComment!.run_id;
      const commentFailure = await prepareUndispatchedAgentFailure(
        failedCommentRun,
        {
          db,
          reason: "agent_dispatch_failed",
        },
      );

      await db.transaction(commentFailure.apply);
      const commentPreview = await getAgentRetryOptions(
        db,
        failedCommentRun,
        userId,
      );

      expect(commentPreview).toMatchObject({
        eligible: true,
        selectedRunnerId: runnerId,
      });
      const commentRetry = await acceptAgentRetry(
        db,
        failedCommentRun,
        userId,
        {
          requestKey: randomUUID(),
          runnerId,
          previewFingerprint: commentPreview.previewFingerprint,
        },
      );

      await expect(runAgentRetryAdmissionSweep(db)).resolves.toEqual({
        processed: 1,
        errors: [],
      });
      const commentSuccessor = await getAgentRetryReceipt(
        db,
        failedCommentRun,
        commentRetry.retryIntentId,
        userId,
      );

      expect(commentSuccessor).toMatchObject({
        intentState: "launched",
        runStatus: "Pending",
      });
      expect(commentSuccessor.runId).not.toBe(failedCommentRun);
      const [retainedCommentRun] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, commentSuccessor.runId!));

      expect(
        await loadProjectAssignmentExecutionInput(db, retainedCommentRun!),
      ).toMatchObject({
        assignmentId: interruptedComment!.id,
        revision: 1,
        snapshot: {
          objectiveInput: { input: interruptedComment!.source_body },
        },
      });
      expect(
        (
          await database.pool.query(
            "SELECT successor.task_id,successor.trigger_event_id=source.trigger_event_id AS original_event,successor.agent_schedule_id=source.agent_schedule_id AS original_schedule FROM runs successor JOIN runs source ON source.id=successor.retry_of_run_id WHERE successor.id=$1",
            [commentSuccessor.runId],
          )
        ).rows,
      ).toEqual([
        {
          task_id: commentTaskId,
          original_event: true,
          original_schedule: true,
        },
      ]);
      const dispatchedCommentRuns = [
        ...ordinaryComments.map((work) => work.run_id),
        commentSuccessor.runId!,
      ];

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
      for (const runId of dispatchedCommentRuns) {
        await vi.waitFor(
          async () => {
            expect(
              (
                await database.pool.query(
                  "SELECT status FROM runs WHERE id=$1",
                  [runId],
                )
              ).rows,
            ).toEqual([{ status: "Done" }]);
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
      const queuedCoordinator = specialistAssignmentSchema.parse(
        await coordinatedResponse.json(),
      );

      expect(queuedCoordinator.status).toBe("queued");
      expect(queuedCoordinator.runIds).toEqual([]);
      const acceptedIntents = (
        await database.pool.query<{
          id: string;
          basis: unknown;
          settings_snapshot: unknown;
          input_snapshot: { sourceVersion: string | null };
        }>(
          "SELECT id,basis,settings_snapshot,input_snapshot FROM task_launch_intents WHERE settings_snapshot->'serverExecution'->'execution'->'specialistAssignment'->>'assignmentId'=$1",
          [queuedCoordinator.id],
        )
      ).rows;

      expect(acceptedIntents).toHaveLength(1);
      expect(acceptedIntents[0].basis).toMatchObject({
        kind: "manual",
        userId,
      });
      expect(acceptedIntents[0].settings_snapshot).toMatchObject({
        serverExecution: {
          execution: {
            specialistAssignment: {
              assignmentId: queuedCoordinator.id,
              inputRevision: 1,
              userId,
            },
          },
        },
      });
      const originalCoordinatorInput = await getSpecialistAssignmentInput(
        db,
        userId,
        queuedCoordinator.id,
        1,
      );

      expect(acceptedIntents[0].input_snapshot.sourceVersion).toBe(
        `specialist-assignment:v1:${queuedCoordinator.id}:1:${originalCoordinatorInput.digest}`,
      );
      const { prepareTaskLaunchIntent, dispatchTaskLaunchIntent } =
        await import("@/lib/tasks/launch-dispatch");

      expect(
        await prepareTaskLaunchIntent(db, acceptedIntents[0].id),
      ).toMatchObject({ state: "run_bound" });
      await dispatchTaskLaunchIntent(db, acceptedIntents[0].id);
      const coordinated = await getSpecialistAssignment(
        db,
        userId,
        queuedCoordinator.id,
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
              coordinatorFlow: {
                flowRevisionId: coordinatedRun!.flowRevisionId,
              },
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
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "Sec-Fetch-Site": "same-origin",
            },
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
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "Sec-Fetch-Site": "same-origin",
            },
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
      const concurrentCommentClaim = await claimEventAgentAttempt(
        db,
        coordinatorSource.id,
        new Date(),
        Number(coordinatorEvent.id),
      );

      expect(concurrentCommentClaim).not.toBeNull();
      assertProjectAgentTriggerClaim(concurrentCommentClaim!);
      const { runAutoLaunchTriagedJob: recoverProjectIntake } =
        await import("@/lib/scheduler/handlers/auto-launch-triaged");

      await database.pool
        .query(`CREATE FUNCTION cb_owned_carrier_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.agent_id='rah:flow-coordinator' THEN
        RAISE EXCEPTION 'Owned intake interruption before carrier retention' USING ERRCODE='23514',CONSTRAINT='cb_owned_carrier_fault';
      END IF; RETURN NEW; END $$`);
      await database.pool.query(
        "CREATE TRIGGER cb_owned_carrier_fault BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION cb_owned_carrier_fault()",
      );
      try {
        await expect(
          submitProjectCommentAssignment(db, concurrentCommentClaim!),
        ).rejects.toMatchObject({
          code: "CRASH",
          details: { sqlState: "23514", constraint: "cb_owned_carrier_fault" },
        });
        expect(
          (
            await database.pool.query(
              "SELECT project_task_id,input_revision FROM specialist_assignments WHERE project_id=$1 AND origin->>'commentId'=$2",
              [project.id, coordinatorComment.comment.id],
            )
          ).rows,
        ).toEqual([{ project_task_id: null, input_revision: 1 }]);
        const interrupted = (
          await database.pool.query<{ id: string }>(
            "SELECT id FROM specialist_assignments WHERE project_id=$1 AND origin->>'commentId'=$2",
            [project.id, coordinatorComment.comment.id],
          )
        ).rows[0]!;

        expect(
          await getSpecialistAssignmentAdmission(db, userId, interrupted.id),
        ).toMatchObject({
          kind: "project_flow",
          carrier: null,
          status: "queued",
          inputRevision: 1,
        });
      } finally {
        await database.pool.query(
          "DROP TRIGGER cb_owned_carrier_fault ON tasks",
        );
        await database.pool.query("DROP FUNCTION cb_owned_carrier_fault()");
      }
      await database.pool
        .query(`CREATE FUNCTION cb_owned_pointer_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.specialist_assignment IS NOT NULL THEN
        RAISE EXCEPTION 'Owned intake interruption before source handoff commit' USING ERRCODE='23514',CONSTRAINT='cb_owned_pointer_fault';
      END IF; RETURN NEW; END $$`);
      await database.pool.query(
        "CREATE TRIGGER cb_owned_pointer_fault BEFORE UPDATE ON agent_trigger_attempts FOR EACH ROW EXECUTE FUNCTION cb_owned_pointer_fault()",
      );
      try {
        await expect(recoverProjectIntake({ db })).rejects.toMatchObject({
          cause: { code: "23514", constraint: "cb_owned_pointer_fault" },
        });
        expect(
          (
            await database.pool.query(
              "SELECT project_task_id FROM specialist_assignments WHERE project_id=$1 AND origin->>'commentId'=$2",
              [project.id, coordinatorComment.comment.id],
            )
          ).rows[0].project_task_id,
        ).toEqual(expect.any(String));
      } finally {
        await database.pool.query(
          "DROP TRIGGER cb_owned_pointer_fault ON agent_trigger_attempts",
        );
        await database.pool.query("DROP FUNCTION cb_owned_pointer_fault()");
      }
      await database.pool.query(
        "UPDATE agent_trigger_attempts SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [concurrentCommentClaim!.id],
      );
      expect(await reconcileAgentTriggerAttempts(db, new Date())).toEqual({
        adopted: 0,
        unknown: 1,
      });

      await recoverProjectIntake({ db });
      expect(
        (
          await database.pool.query(
            "SELECT outcome,run_id,specialist_assignment IS NOT NULL AS retained FROM agent_trigger_attempts WHERE id=$1",
            [concurrentCommentClaim!.id],
          )
        ).rows,
      ).toEqual([{ outcome: "queued", run_id: null, retained: true }]);
      expect(
        (
          await database.pool.query(
            "SELECT source_resolved_at IS NOT NULL AS resolved FROM agent_incident_occurrences WHERE source_fact_key='attempt:'||$1 AND channel='admission_refusal'",
            [concurrentCommentClaim!.id],
          )
        ).rows,
      ).toEqual([{ resolved: true }]);
      const concurrentCommentReceipts = await Promise.all([
        submitProjectCommentAssignment(db, concurrentCommentClaim!),
        submitProjectCommentAssignment(db, concurrentCommentClaim!),
      ]);

      expect(
        new Set(
          concurrentCommentReceipts.map((receipt) => receipt.assignment.id),
        ).size,
      ).toBe(1);
      expect(
        concurrentCommentReceipts.map(
          (receipt) => receipt.projectAdmission?.kind,
        ),
      ).toEqual(["qualification_wait", "qualification_wait"]);
      await database.pool.query(
        "UPDATE agent_trigger_attempts SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [concurrentCommentClaim!.id],
      );
      expect(await reconcileAgentTriggerAttempts(db, new Date())).toEqual({
        adopted: 0,
        unknown: 0,
      });
      await drainProjectTriggerEvents();
      const waitingComment = (
        await database.pool.query<{
          task_id: string;
          assignment_id: string;
          outcome: string;
          run_id: string | null;
          handoff: unknown;
        }>(
          `SELECT assignment.project_task_id AS task_id,assignment.id AS assignment_id,
          invocation.outcome,invocation.run_id,to_jsonb(invocation)->'specialist_assignment' AS handoff
         FROM specialist_assignments assignment
         JOIN agent_trigger_attempts invocation ON invocation.trigger_event_id=$3
           AND invocation.schedule_id=$4
         WHERE assignment.project_id=$1 AND assignment.origin->>'commentId'=$2`,
          [
            project.id,
            coordinatorComment.comment.id,
            coordinatorEvent.id,
            coordinatorSource.id,
          ],
        )
      ).rows;

      expect(waitingComment).toHaveLength(1);
      const admissionState = async () =>
        (
          await database.pool.query(
            `SELECT head.revision,head.input_revision,head.context_revision,head.project_task_id,
      carrier.qualification_input_revision,carrier.current_qualification_id,
      (SELECT count(*)::int FROM task_launch_intents WHERE task_id=carrier.id) AS intents,
      (SELECT count(*)::int FROM specialist_run_links WHERE assignment_id=head.id) AS links,
      (SELECT count(*)::int FROM specialist_input_revisions WHERE assignment_id=head.id) AS inputs,
      (SELECT count(*)::int FROM domain_events WHERE payload->>'assignmentId'=head.id OR task_id=carrier.id) AS events
      FROM specialist_assignments head JOIN tasks carrier ON carrier.id=head.project_task_id WHERE head.id=$1`,
            [waitingComment[0].assignment_id],
          )
        ).rows;
      const beforeInspection = await admissionState();
      const admissionBefore = await getSpecialistAssignmentAdmission(
        db,
        userId,
        waitingComment[0].assignment_id,
      );

      expect(admissionBefore).toMatchObject({
        schemaVersion: 1,
        assignmentId: waitingComment[0].assignment_id,
        inputRevision: 1,
        kind: "project_flow",
        status: "queued",
        limitations: ["repository_evidence_not_checked"],
        carrier: {
          taskId: waitingComment[0].task_id,
          input: {
            revision: 1,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          qualification: { freshness: "unassessed" },
          activeLaunch: null,
        },
      });
      expect(admissionBefore.carrier?.taskHref).toBe(
        `/projects/${project.slug}/tasks/${admissionBefore.carrier?.taskNumber}`,
      );

      expect(waitingComment[0]).toMatchObject({
        outcome: "queued",
        run_id: null,
        handoff: {
          schemaVersion: 1,
          assignment: { id: waitingComment[0].assignment_id, inputRevision: 1 },
          source: {
            kind: "task_comment",
            eventId: Number(coordinatorEvent.id),
          },
        },
      });
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT id FROM tasks WHERE id=${waitingComment[0].task_id} FOR UPDATE`,
        );
        expect(
          await getSpecialistAssignmentAdmission(
            db,
            userId,
            waitingComment[0].assignment_id,
          ),
        ).toMatchObject({
          carrier: { taskId: waitingComment[0].task_id },
          kind: "project_flow",
        });
      });
      expect(await admissionState()).toEqual(beforeInspection);
      const commentReservation = (
        await database.pool.query<{ id: string }>(
          "SELECT id FROM agent_trigger_attempts WHERE trigger_event_id=$1 AND schedule_id=$2",
          [coordinatorEvent.id, coordinatorSource.id],
        )
      ).rows[0];

      await expect(
        database.pool.query(
          "UPDATE agent_trigger_attempts SET specialist_assignment=jsonb_set(specialist_assignment,'{assignment,inputSha256}',to_jsonb($2::text)) WHERE id=$1",
          [commentReservation.id, "f".repeat(64)],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "project_source_handoff_immutable",
      });
      await database.pool.query(
        "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
        [project.id, userId],
      );
      try {
        const { resumeQualifiedProjectAssignments } =
          await import("@/lib/specialist-assignments/project-source-resume");

        expect(
          await resumeQualifiedProjectAssignments(
            db,
            project.id,
            waitingComment[0].task_id,
          ),
        ).toBe(0);
        expect(
          (
            await database.pool.query(
              "SELECT id FROM task_launch_intents WHERE task_id=$1",
              [waitingComment[0].task_id],
            )
          ).rows,
        ).toEqual([]);
      } finally {
        await database.pool.query(
          "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
          [project.id, userId],
        );
      }
      const { reserveProjectAssignmentTask } =
        await import("@/lib/specialist-assignments/project-task");
      const retainedCommentInput = await getSpecialistAssignmentInput(
        db,
        userId,
        waitingComment[0].assignment_id,
        1,
      );
      const retainedCommentHead = await getSpecialistAssignment(
        db,
        userId,
        waitingComment[0].assignment_id,
      );

      await database.pool.query(
        "UPDATE tasks SET qualification_source_version='changed-private-input-witness' WHERE id=$1",
        [waitingComment[0].task_id],
      );
      try {
        expect(
          await getSpecialistAssignmentAdmission(
            db,
            userId,
            retainedCommentHead.id,
          ),
        ).toMatchObject({
          carrier: { taskId: waitingComment[0].task_id, input: null },
          limitations: [
            "repository_evidence_not_checked",
            "carrier_input_unavailable",
          ],
        });
        await expect(
          reserveProjectAssignmentTask(
            db,
            project.id,
            {
              assignmentId: retainedCommentHead.id,
              inputRevision: 1,
              expectedRevision: retainedCommentHead.revision,
              userId,
            },
            async () => {
              throw new Error(
                "The existing carrier must never allocate a replacement",
              );
            },
          ),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          details: { reason: "project_assignment_input_changed" },
        });
      } finally {
        await database.pool.query(
          "UPDATE tasks SET qualification_source_version=$2 WHERE id=$1",
          [
            waitingComment[0].task_id,
            `specialist-assignment:v1:${retainedCommentHead.id}:1:${retainedCommentInput.digest}`,
          ],
        );
      }
      const qualificationHorizon = await database.pool.connect();

      try {
        await qualificationHorizon.query("BEGIN");
        await qualificationHorizon.query("SELECT pg_current_xact_id()");
        await qualifyCoordinatorTask(waitingComment[0].task_id, userId);
        expect(
          await getSpecialistAssignmentAdmission(
            db,
            userId,
            waitingComment[0].assignment_id,
          ),
        ).toMatchObject({
          carrier: {
            input: { revision: 1 },
            qualification: { freshness: "current", decision: "ready" },
          },
          limitations: ["repository_evidence_not_checked"],
        });

        expect(await dispatchDomainEvents({ db })).toMatchObject({
          failures: 0,
        });
        const heldQualificationEvent = (
          await database.pool.query<{ id: string }>(
            "SELECT id::text AS id FROM domain_events WHERE kind='task.qualification_changed' AND task_id=$1 ORDER BY id DESC LIMIT 1",
            [waitingComment[0].task_id],
          )
        ).rows[0]!;

        expect(
          (
            await database.pool.query(
              "SELECT cursor_event_id < $1::bigint AS behind FROM domain_event_consumers WHERE consumer_id='agent_triggers'",
              [heldQualificationEvent.id],
            )
          ).rows,
        ).toEqual([{ behind: true }]);
        expect(
          (
            await database.pool.query(
              "SELECT run_id FROM specialist_run_links WHERE assignment_id=$1",
              [waitingComment[0].assignment_id],
            )
          ).rows,
        ).toEqual([]);
      } finally {
        try {
          await qualificationHorizon.query("ROLLBACK");
        } finally {
          qualificationHorizon.release();
        }
      }
      await drainProjectTriggerEvents();
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
      await drainProjectTriggerEvents();
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM specialist_assignments WHERE project_id=$1 AND origin->>'kind'='task_comment'",
            [project.id],
          )
        ).rows,
      ).toEqual([{ count: commentIds.length + 1 }]);
      for (const runId of [
        ...dispatchedCommentRuns,
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
      expect(
        (
          await database.pool.query(
            "SELECT id FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
            [failedCommentRun],
          )
        ).rows,
      ).toEqual([]);
      const mentionRemovalProbe = new Error("Rollback mention removal probe");

      await expect(
        database.pool.query(
          "UPDATE runs SET agent_schedule_id=NULL WHERE id=$1",
          [commentSuccessor.runId],
        ),
      ).rejects.toMatchObject({
        constraint: "project_event_replacement_source_scope",
      });
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(
            sql`DELETE FROM agent_schedules WHERE id=${retainedCommentRun!.agentScheduleId}`,
          );
          const [detached] = await tx
            .select()
            .from(runs)
            .where(eq(runs.id, commentSuccessor.runId!));

          expect(detached).toMatchObject({
            agentScheduleId: null,
            triggerEventId: retainedCommentRun!.triggerEventId,
            retryOfRunId: failedCommentRun,
          });
          const [receipt] = (
            await tx.execute(
              sql`SELECT recipe->'replacement'->'comment' AS appointment FROM agent_retry_intents WHERE id=${commentRetry.retryIntentId}`,
            )
          ).rows;

          expect(receipt?.appointment).toMatchObject({
            scheduleId: retainedCommentRun!.agentScheduleId,
          });
          throw mentionRemovalProbe;
        }),
      ).rejects.toBe(mentionRemovalProbe);
      const deniedCommentResponse = await taskCommentPost(
        new NextRequest(
          `http://localhost/api/projects/${project.slug}/tasks/9001/comments`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "Sec-Fetch-Site": "same-origin",
            },
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
        await drainProjectTriggerEvents();
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
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "Sec-Fetch-Site": "same-origin",
            },
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

      await drainProjectTriggerEvents();
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
      const createOrderedCoordinatorSource = async (
        label: string,
      ): Promise<ProjectAgentTriggerClaim> => {
        browserSession.user = await requireActiveUserById(userId);
        const response = await taskCommentPost(
          new NextRequest(
            `http://localhost/api/projects/${project.slug}/tasks/9001/comments`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: "http://localhost",
                "Sec-Fetch-Site": "same-origin",
              },
              body: JSON.stringify({
                body: `@rah:flow-coordinator Qualify the ${label} ordering without repeating completed work.`,
              }),
            },
          ),
          { params: Promise.resolve({ slug: project.slug, number: "9001" }) },
        );

        expect(response.status).toBe(201);
        const comment = z
          .object({ comment: z.object({ id: z.string() }) })
          .parse(await response.json());
        const event = (
          await database.pool.query<{ id: string }>(
            "SELECT id FROM domain_events WHERE project_id=$1 AND kind='task.comment_added' AND payload->>'commentId'=$2",
            [project.id, comment.comment.id],
          )
        ).rows[0]!;
        const claim = await claimEventAgentAttempt(
          db,
          coordinatorSource.id,
          new Date(),
          Number(event.id),
        );

        if (!claim)
          throw new Error(
            "Ordered coordinator source was claimed before its controlled intake",
          );
        assertProjectAgentTriggerClaim(claim);

        return claim;
      };
      const cancellationOrders = [
        "cancel_before_assessment",
        "cancel_after_assessment",
      ] as const;
      const earlyQualificationOrders = [
        "current_repository_evidence",
        "advanced_repository_evidence",
      ] as const;

      for (const order of cancellationOrders) {
        const claim = await createOrderedCoordinatorSource(order);
        const queued = await submitProjectCommentAssignment(db, claim);

        expect(queued.projectAdmission).toMatchObject({
          kind: "qualification_wait",
        });
        const carrier = await getSpecialistAssignmentAdmission(
          db,
          userId,
          queued.assignment.id,
        );

        if (!carrier.carrier)
          throw new Error(
            "Queued cancellation fixture is missing its retained carrier",
          );
        if (order === "cancel_after_assessment")
          await qualifyCoordinatorTask(carrier.carrier.taskId, userId);
        const cancelled = await cancelSpecialistAssignment(
          db,
          userId,
          queued.assignment.id,
          queued.assignment.revision,
          "Cancel the original queued specialist request",
        );

        if (order === "cancel_before_assessment")
          await qualifyCoordinatorTask(carrier.carrier.taskId, userId);
        await drainProjectTriggerEvents();
        await recoverProjectIntake({ db });
        const retained = await getSpecialistAssignment(
          db,
          userId,
          queued.assignment.id,
        );

        expect(retained).toMatchObject({
          status: "cancelled",
          revision: cancelled.revision,
          inputRevision: 1,
          runIds: [],
        });
        await expect(
          submitProjectCommentAssignment(db, claim),
        ).rejects.toMatchObject({
          code: "PRECONDITION",
          details: { reason: "project_comment_appointment_unavailable" },
        });
        expect(
          (
            await database.pool.query(
              "SELECT (SELECT count(*)::int FROM task_launch_intents WHERE task_id=$1) AS intents,(SELECT count(*)::int FROM runs WHERE id=$2) AS runs,(SELECT count(*)::int FROM execution_commands WHERE run_id=$2) AS commands",
              [carrier.carrier.taskId, claim.reservedRunId],
            )
          ).rows,
        ).toEqual([{ intents: 0, runs: 0, commands: 0 }]);
        expect(
          (
            await database.pool.query(
              "SELECT outcome,run_id,specialist_assignment->'assignment'->>'id' AS assignment_id FROM agent_trigger_attempts WHERE id=$1",
              [claim.id],
            )
          ).rows,
        ).toEqual([
          {
            outcome: "queued",
            run_id: null,
            assignment_id: queued.assignment.id,
          },
        ]);
        expect(
          await getSpecialistAssignmentAdmission(
            db,
            userId,
            queued.assignment.id,
          ),
        ).toMatchObject({
          status: "cancelled",
          carrier: {
            input: { revision: 1 },
            qualification: { freshness: "current", decision: "ready" },
          },
        });
      }
      await database.pool.query(
        "CREATE TABLE cb_ordered_pointer_fault_target(attempt_id text PRIMARY KEY)",
      );
      await database.pool
        .query(`CREATE FUNCTION cb_ordered_pointer_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.specialist_assignment IS NOT NULL AND EXISTS(SELECT 1 FROM cb_ordered_pointer_fault_target WHERE attempt_id=NEW.id) THEN
        RAISE EXCEPTION 'Controlled interruption before qualification source handoff' USING ERRCODE='23514',CONSTRAINT='cb_ordered_pointer_fault';
      END IF; RETURN NEW; END $$`);
      await database.pool.query(
        "CREATE TRIGGER cb_ordered_pointer_fault BEFORE UPDATE ON agent_trigger_attempts FOR EACH ROW EXECUTE FUNCTION cb_ordered_pointer_fault()",
      );
      try {
        for (const order of earlyQualificationOrders) {
          const claim = await createOrderedCoordinatorSource(order);

          await database.pool.query(
            "INSERT INTO cb_ordered_pointer_fault_target(attempt_id) VALUES($1)",
            [claim.id],
          );
          await expect(
            submitProjectCommentAssignment(db, claim),
          ).rejects.toMatchObject({
            code: "CRASH",
            details: {
              sqlState: "23514",
              constraint: "cb_ordered_pointer_fault",
            },
          });
          const original = (
            await database.pool.query<{
              id: string;
              project_task_id: string;
              input_revision: number;
            }>(
              "SELECT head.id,head.project_task_id,head.input_revision FROM specialist_assignments head JOIN domain_events event ON event.id=$2 WHERE head.project_id=$1 AND head.origin->>'commentId'=event.payload->>'commentId'",
              [project.id, claim.triggerEventId],
            )
          ).rows[0]!;
          const frozenInput = await getSpecialistAssignmentInput(
            db,
            userId,
            original.id,
            1,
          );

          await qualifyCoordinatorTask(original.project_task_id, userId);
          const qualificationBefore = (
            await database.pool.query<{
              current_qualification_id: string;
              qualification_input_revision: number;
            }>(
              "SELECT current_qualification_id,qualification_input_revision FROM tasks WHERE id=$1",
              [original.project_task_id],
            )
          ).rows[0]!;

          await drainProjectTriggerEvents();
          expect(
            (
              await database.pool.query(
                "SELECT run_id,specialist_assignment FROM agent_trigger_attempts WHERE id=$1",
                [claim.id],
              )
            ).rows,
          ).toEqual([{ run_id: null, specialist_assignment: null }]);
          expect(
            (await getSpecialistAssignment(db, userId, original.id)).runIds,
          ).toEqual([]);
          if (order === "advanced_repository_evidence") {
            await writeFile(
              join(repo, "README.md"),
              "# Updated diagnostic project\nRepository evidence advanced after qualification and before source handoff.\n",
            );
            await git(repo, "add", "README.md");
            await git(
              repo,
              "commit",
              "-q",
              "-m",
              "Advance coordinator qualification evidence",
            );
          }
          await database.pool.query(
            "DELETE FROM cb_ordered_pointer_fault_target WHERE attempt_id=$1",
            [claim.id],
          );
          await database.pool.query(
            "UPDATE agent_trigger_attempts SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [claim.id],
          );
          expect(await reconcileAgentTriggerAttempts(db, new Date())).toEqual({
            adopted: 0,
            unknown: 1,
          });
          await recoverProjectIntake({ db });
          if (order === "advanced_repository_evidence") {
            expect(
              await getSpecialistAssignmentAdmission(db, userId, original.id),
            ).toMatchObject({
              status: "queued",
              carrier: {
                input: { revision: 1, sha256: frozenInput.digest },
                qualification: { freshness: "stale" },
              },
            });
            expect(
              (await getSpecialistAssignment(db, userId, original.id)).runIds,
            ).toEqual([]);
            expect(
              (
                await database.pool.query(
                  "SELECT outcome,run_id FROM agent_trigger_attempts WHERE id=$1",
                  [claim.id],
                )
              ).rows,
            ).toEqual([{ outcome: "queued", run_id: null }]);
            const refusedRevision = (
              await getSpecialistAssignmentAdmission(db, userId, original.id)
            ).carrier?.qualification?.inputRevision;

            expect(refusedRevision).toBe(
              qualificationBefore.qualification_input_revision + 1,
            );
            const repeatedRefusals = await Promise.all([
              submitProjectCommentAssignment(db, claim),
              submitProjectCommentAssignment(db, claim),
            ]);

            expect(
              repeatedRefusals.map((result) => result.projectAdmission?.kind),
            ).toEqual(["qualification_wait", "qualification_wait"]);
            expect(
              (await getSpecialistAssignmentAdmission(db, userId, original.id))
                .carrier?.qualification?.inputRevision,
            ).toBe(refusedRevision);
            await qualifyCoordinatorTask(original.project_task_id, userId);
            const delayedRefusal = (
              await database.pool.query<{
                current_qualification_id: string;
                qualification_input_revision: number;
              }>(
                "SELECT current_qualification_id,qualification_input_revision FROM tasks WHERE id=$1",
                [original.project_task_id],
              )
            ).rows[0]!;

            await qualifyCoordinatorTask(original.project_task_id, userId);
            expect(
              await requestTaskRequalificationIfCurrent(db, {
                projectId: project.id,
                taskId: original.project_task_id,
                qualificationId: delayedRefusal.current_qualification_id,
                inputRevision: delayedRefusal.qualification_input_revision,
              }),
            ).toBe(false);
            expect(
              await getSpecialistAssignmentAdmission(db, userId, original.id),
            ).toMatchObject({
              carrier: {
                qualification: {
                  inputRevision: delayedRefusal.qualification_input_revision,
                  freshness: "current",
                  decision: "ready",
                },
              },
            });

            await drainProjectTriggerEvents();
          }
          await driveCoordinatorAssignment(original.id);
          await vi.waitFor(
            async () => {
              expect(
                (
                  await database.pool.query(
                    "SELECT status FROM runs WHERE id=$1",
                    [claim.reservedRunId],
                  )
                ).rows,
              ).toEqual([{ status: "Done" }]);
            },
            { timeout: 30000, interval: 25 },
          );
          if (claim.triggerEventId === null)
            throw new Error("Ordered source lost its original event identity");
          await database.pool.query(
            "UPDATE domain_event_consumers SET cursor_event_id=$1::bigint-1 WHERE consumer_id='agent_triggers'",
            [claim.triggerEventId],
          );
          await drainProjectTriggerEvents();
          await recoverProjectIntake({ db });
          expect(
            await getSpecialistAssignment(db, userId, original.id),
          ).toMatchObject({
            id: original.id,
            inputRevision: 1,
            runIds: [claim.reservedRunId],
          });
          expect(
            (await getSpecialistAssignmentInput(db, userId, original.id, 1))
              .digest,
          ).toBe(frozenInput.digest);
          expect(
            (
              await database.pool.query(
                "SELECT count(*)::int AS count FROM task_launch_intents WHERE task_id=$1",
                [original.project_task_id],
              )
            ).rows,
          ).toEqual([{ count: 1 }]);
          expect(
            (
              await database.pool.query(
                "SELECT kind,count(*)::int AS count FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt') GROUP BY kind ORDER BY kind",
                [claim.reservedRunId],
              )
            ).rows,
          ).toEqual([
            { kind: "session.create", count: 1 },
            { kind: "session.prompt", count: 1 },
          ]);
        }
      } finally {
        await database.pool.query(
          "DROP TRIGGER cb_ordered_pointer_fault ON agent_trigger_attempts",
        );
        await database.pool.query("DROP FUNCTION cb_ordered_pointer_fault()");
        await database.pool.query("DROP TABLE cb_ordered_pointer_fault_target");
      }
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
      expect(
        await getSpecialistAssignmentAdmission(
          db,
          userId,
          deferredCoordinator[0].id,
        ),
      ).toMatchObject({
        kind: "project_flow",
        status: "queued",
        inputRevision: 1,
      });

      expect(deferredCoordinator[0]).toMatchObject({ input_revision: 1 });
      expect(
        (
          await database.pool.query(
            "SELECT run_id FROM specialist_run_links WHERE assignment_id=$1",
            [deferredCoordinator[0].id],
          )
        ).rows,
      ).toEqual([]);
      const coordinatorWorkingContext = await appendSpecialistAssignmentContext(
        db,
        userId,
        deferredCoordinator[0].id,
        {
          expectedRevision: 0,
          expectedInputRevision: 1,
          idempotencyKey: randomUUID(),
          updates: [
            {
              id: "coordinator-runtime-question",
              kind: "question",
              text: "Preserve the deferred coordinator question in its exact current node prompt",
              state: "open",
              references: [],
            },
          ],
        },
      );

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
      const resumedCoordinatorReceipt = specialistAssignmentSchema.parse(
        await resumedCoordinatorResponse.json(),
      );

      expect(resumedCoordinatorReceipt.runIds).toEqual([]);
      await driveCoordinatorAssignment(resumedCoordinatorReceipt.id);
      const resumedCoordinator = await getSpecialistAssignment(
        db,
        userId,
        resumedCoordinatorReceipt.id,
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
      expect(await retainedPrompt(resumedCoordinator.runIds[0]!)).toContain(
        JSON.stringify(coordinatorWorkingContext),
      );
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS count FROM tasks WHERE project_id=$1 AND agent_id='rah:flow-coordinator'",
            [project.id],
          )
        ).rows,
      ).toEqual([
        {
          count:
            3 + cancellationOrders.length + earlyQualificationOrders.length,
        },
      ]);
      expect((await submit(flowRequest)).status).toBe(200);
      await vi.waitFor(async () => {
        expect(await dispatchDomainEvents({ db })).toMatchObject({
          failures: 0,
        });
        expect(
          (
            await database.pool.query(
              "SELECT status,acceptance_id FROM specialist_assignments WHERE id=$1",
              [coordinated.id],
            )
          ).rows,
        ).toEqual([{ status: "awaiting_acceptance", acceptance_id: null }]);
      });
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
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "Sec-Fetch-Site": "same-origin",
            },
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
        expect(await runSchedulerTick({ jobKind: "agent_tick" })).toMatchObject(
          {
            succeededCount: 1,
            failedCount: 0,
          },
        );
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
        await database.pool.query(
          "UPDATE agent_schedules SET next_fire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [cronSource.id],
        );
        const retryTime = new Date();
        const failedCronClaim = await claimCronAgentAttempt(
          db,
          cronSource.id,
          retryTime,
          new Date(retryTime.getTime() + 300000),
        );

        if (!failedCronClaim)
          throw new Error(
            "The project cron replacement fixture could not claim its reviewed source",
          );
        assertProjectAgentTriggerClaim(failedCronClaim);
        const failedCron = await submitProjectCronAssignment(
          db,
          failedCronClaim,
        );
        const [sourceRunId] = failedCron.assignment.runIds;

        await database.pool.query(
          "UPDATE agent_trigger_attempts SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [failedCronClaim.id],
        );
        await reconcileAgentTriggerAttempts(db, new Date());
        const failure = await prepareUndispatchedAgentFailure(sourceRunId, {
          db,
          reason: "agent_dispatch_failed",
        });

        await db.transaction(failure.apply);
        const preview = await getAgentRetryOptions(
          db,
          sourceRunId,
          administratorId,
        );

        expect(preview).toMatchObject({
          eligible: true,
          selectedRunnerId: runnerId,
        });
        const retry = await acceptAgentRetry(db, sourceRunId, administratorId, {
          requestKey: randomUUID(),
          runnerId,
          previewFingerprint: preview.previewFingerprint,
        });

        await expect(runAgentRetryAdmissionSweep(db)).resolves.toEqual({
          processed: 1,
          errors: [],
        });
        const successor = await getAgentRetryReceipt(
          db,
          sourceRunId,
          retry.retryIntentId,
          administratorId,
        );

        expect(successor).toMatchObject({
          intentState: "launched",
          runStatus: "Pending",
        });
        const [retained] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, successor.runId!));

        expect(retained).toMatchObject({
          triggerSource: "cron",
          agentScheduleId: cronSource.id,
          retryOfRunId: sourceRunId,
          scheduledRequestSnapshot: failedCronClaim.scheduledRequestSnapshot,
        });
        const settle = await prepareUndispatchedAgentFailure(successor.runId!, {
          db,
          reason: "fixture_replacement_complete",
        });

        await db.transaction(settle.apply);
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
        expect(await runSchedulerTick({ jobKind: "agent_tick" })).toMatchObject(
          {
            succeededCount: 1,
            failedCount: 0,
          },
        );
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
        ).toEqual([
          { outcome: "queued", run_id: interruptedCron.reservedRunId },
        ]);
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
              headers: {
                "Content-Type": "application/json",
                Origin: "http://localhost",
                "Sec-Fetch-Site": "same-origin",
              },
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
      await qualifyQueuedCoordinators();
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
      await vi.waitFor(async () => {
        expect(await dispatchDomainEvents({ db })).toMatchObject({
          failures: 0,
        });
        expect(
          (
            await database.pool.query(
              "SELECT status,acceptance_id FROM specialist_assignments WHERE id=$1",
              [flowCron[0]!.id],
            )
          ).rows,
        ).toEqual([{ status: "awaiting_acceptance", acceptance_id: null }]);
      });
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
        await drainProjectTriggerEvents();
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
      await qualifyQueuedCoordinators();
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
        await drainProjectTriggerEvents();
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
          }>(
            "SELECT knowledge_access,agent_chain_depth FROM runs WHERE id=$1",
            [eventWork[0]!.source_run_id],
          )
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
        await drainProjectTriggerEvents();
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
        const producing = eventWork[0]!.source_run_id;
        const eventNonce = randomUUID();

        await emitDomainEvent({
          db,
          projectId: project.id,
          runId: producing,
          parentRunId: null,
          kind: "run.done",
          actor: { type: "system", id: null },
          payload: { runId: producing, eventNonce },
        });
        const [fact] = (
          await database.pool.query<{ id: string }>(
            "SELECT id FROM domain_events WHERE run_id=$1 AND payload->>'eventNonce'=$2",
            [producing, eventNonce],
          )
        ).rows;
        const now = new Date();
        const invocation = await claimEventAgentAttempt(
          db,
          eventSource.id,
          now,
          Number(fact.id),
        );

        if (!invocation)
          throw new Error(
            "Project event replacement could not claim the exact reviewed source",
          );
        assertProjectAgentTriggerClaim(invocation);
        const retrySource = await submitProjectEventAssignment(db, invocation);
        const [sourceRunId] = retrySource.assignment.runIds;

        await settleAgentTriggerAttempt(db, invocation, {
          outcome: "queued",
          runId: sourceRunId,
          reasonCode: null,
          now,
        });
        const failure = await prepareUndispatchedAgentFailure(sourceRunId, {
          db,
          reason: "agent_dispatch_failed",
        });

        await db.transaction(failure.apply);
        const preview = await getAgentRetryOptions(
          db,
          sourceRunId,
          administratorId,
        );

        expect(preview).toMatchObject({
          eligible: true,
          reason: null,
          selectedRunnerId: runnerId,
        });
        const retry = await acceptAgentRetry(db, sourceRunId, administratorId, {
          requestKey: randomUUID(),
          runnerId,
          previewFingerprint: preview.previewFingerprint,
        });

        await expect(runAgentRetryAdmissionSweep(db)).resolves.toEqual({
          processed: 1,
          errors: [],
        });
        const successor = await getAgentRetryReceipt(
          db,
          sourceRunId,
          retry.retryIntentId,
          administratorId,
        );

        expect(successor).toMatchObject({
          intentState: "launched",
          runStatus: "Pending",
        });
        const [replacement] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, successor.runId!));

        expect(replacement).toMatchObject({
          retryOfRunId: sourceRunId,
          agentScheduleId: eventSource.id,
          triggerEventId: Number(fact.id),
          agentChainDepth: 1,
        });
        expect(replacement.knowledgeAccess?.restrictions).toEqual(
          expect.arrayContaining(producer.knowledge_access.restrictions),
        );
        await expect(
          loadProjectAssignmentExecutionInput(db, replacement),
        ).resolves.toMatchObject({ revision: 1 });
        await expect(
          claimEventAgentAttempt(db, eventSource.id, now, Number(fact.id)),
        ).resolves.toBeNull();
        const settle = await prepareUndispatchedAgentFailure(replacement.id, {
          db,
          reason: "fixture_replacement_complete",
        });

        await db.transaction(settle.apply);
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
      await drainProjectTriggerEvents();
      await qualifyQueuedCoordinators();
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
      ).toEqual([
        { outcome: "suppressed", reason_code: "self_authored_event" },
      ]);
      for (const receiver of receiverWork) {
        await vi.waitFor(
          async () => {
            expect(
              (
                await database.pool.query(
                  "SELECT status FROM runs WHERE id=$1",
                  [receiver.run_id],
                )
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

      const rollbackMarker = new Error(
        "Qualification-only state must roll back",
      );

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
      const privateProducerResponse = await submitRouted(
        "rah:flow-coordinator",
        {
          ...flowRequest,
          idempotencyKey: randomUUID(),
        },
      );

      expect(privateProducerResponse.status).toBe(201);
      const privateProducerReceipt = specialistAssignmentSchema.parse(
        await privateProducerResponse.json(),
      );

      expect(privateProducerReceipt.runIds).toEqual([]);
      await driveCoordinatorAssignment(privateProducerReceipt.id);
      const privateProducer = await getSpecialistAssignment(
        db,
        administratorId,
        privateProducerReceipt.id,
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
      await drainProjectTriggerEvents();
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
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "Sec-Fetch-Site": "same-origin",
            },
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

      await drainProjectTriggerEvents();
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
      const webhookContract: {
        components: { schemas: Record<string, object> };
      } = parse(
        await readFile(resolve("../docs/api/web.openapi.yaml"), "utf8"),
      );
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
      let webhookReplacementRunId: string;
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
        const webhookFailure = await prepareUndispatchedAgentFailure(
          webhookRunId,
          {
            db,
            reason: "agent_dispatch_failed",
          },
        );

        await db.transaction(webhookFailure.apply);
        const webhookPreview = await getAgentRetryOptions(
          db,
          webhookRunId,
          userId,
        );

        expect(webhookPreview).toMatchObject({
          eligible: true,
          selectedRunnerId: runnerId,
        });
        const webhookRetry = await acceptAgentRetry(db, webhookRunId, userId, {
          requestKey: randomUUID(),
          runnerId,
          previewFingerprint: webhookPreview.previewFingerprint,
        });

        await expect(runAgentRetryAdmissionSweep(db)).resolves.toEqual({
          processed: 1,
          errors: [],
        });
        const successor = await getAgentRetryReceipt(
          db,
          webhookRunId,
          webhookRetry.retryIntentId,
          userId,
        );

        expect(successor).toMatchObject({
          intentState: "launched",
          runStatus: "Pending",
        });
        webhookReplacementRunId = successor.runId!;
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
      const webhookReplay = await submitProjectWebhook(
        "rah:webhook-observer",
        webhookRequest,
        webhookDelivery,
        webhookTokens[1].secret,
      );

      expect(webhookReplay.status).toBe(200);
      expect(
        specialistAssignmentSchema.parse(await webhookReplay.json()).runIds,
      ).toEqual(
        expect.arrayContaining([webhookRunId, webhookReplacementRunId]),
      );
      await vi.waitFor(
        async () => {
          expect(
            (
              await database.pool.query("SELECT status FROM runs WHERE id=$1", [
                webhookReplacementRunId,
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
            [webhookReplacementRunId],
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
      const flowWebhookQueued = specialistAssignmentSchema.parse(
        await flowWebhook.json(),
      );

      expect(flowWebhookQueued.runIds).toEqual([]);
      const webhookCarrier = (
        await database.pool.query<{ project_task_id: string }>(
          "SELECT project_task_id FROM specialist_assignments WHERE id=$1",
          [flowWebhookQueued.id],
        )
      ).rows[0];

      await qualifyCoordinatorTask(webhookCarrier.project_task_id, userId);
      const { runAutoLaunchTriagedJob } =
        await import("@/lib/scheduler/handlers/auto-launch-triaged");

      await runAutoLaunchTriagedJob({ db });
      const flowWebhookWork = await getSpecialistAssignment(
        db,
        userId,
        flowWebhookQueued.id,
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
            [webhookReplacementRunId],
          )
        ).rows,
      ).toEqual([
        { kind: "session.create", count: 1 },
        { kind: "session.prompt", count: 1 },
      ]);
    } catch (error) {
      bodyFailure = { error };
      throw error;
    } finally {
      closing = true;
      const cleanup: readonly (() => void | Promise<void>)[] = [
        async () => {
          await database.pool.query(
            "UPDATE agent_schedules SET enabled=false WHERE project_id=$1",
            [project.id],
          );
        },
        async () => {
          if (initialRunIds === undefined) return;
          const existing = await database.pool.query(
            "SELECT id FROM company_grants WHERE principal_type='user' AND principal_id=$1 AND action='assignments:cancel' AND revoked_at IS NULL",
            [userId],
          );

          if (existing.rows.length === 0) {
            const granted = await createCompanyGrants(db, administratorId, {
              principalKind: "user",
              principalId: userId,
              actions: ["assignments:cancel"],
              idempotencyKey: randomUUID(),
            });

            ownedCancellation = granted.page.items.find(
              (grant) => grant.action === "assignments:cancel",
            );
            expect(ownedCancellation).toBeDefined();
          }
          const failedStops = new Set<string>();

          await poll(
            async () => {
              const owned = (
                await database.pool.query<{
                  id: string;
                  company_id: string | null;
                }>(
                  "SELECT id,company_id FROM runs WHERE (id<>ALL($1::text[]) OR id=ANY($2::text[])) AND status NOT IN ('Done','Failed','Crashed','Abandoned')",
                  [initialRunIds, [...dispatchedRunIds]],
                )
              ).rows;

              for (const run of owned) {
                if (failedStops.has(run.id)) continue;
                try {
                  browserSession.user = await requireActiveUserById(
                    run.company_id === null ? administratorId : userId,
                  );
                  const response = await stopRunPost(
                    new Request(`http://localhost/api/runs/${run.id}/stop`, {
                      method: "POST",
                    }),
                    { params: Promise.resolve({ runId: run.id }) },
                  );
                  const result: unknown = await response.json();

                  if (response.status === 503) {
                    expect(result).toMatchObject({
                      code: "EXECUTOR_UNAVAILABLE",
                    });
                    continue;
                  }
                  const retained = (
                    await database.pool.query<{ terminal: boolean }>(
                      "SELECT status IN ('Done','Failed','Crashed','Abandoned') AS terminal FROM runs WHERE id=$1",
                      [run.id],
                    )
                  ).rows[0];

                  expect(
                    retained?.terminal,
                    JSON.stringify({
                      runId: run.id,
                      status: response.status,
                      result,
                    }),
                  ).toBe(true);
                } catch (error) {
                  failedStops.add(run.id);
                  cleanupFailures.push(error);
                }
              }

              return owned.every((run) => failedStops.has(run.id))
                ? true
                : null;
            },
            30000,
            "owned native Run settlement",
            25,
          );
        },
        () => {
          dispatchAbort.abort();
        },
        async () => {
          await poll(
            async () => (activeDispatches.size === 0 ? true : null),
            10000,
            "owned dispatch settlement before host teardown",
            25,
          );
        },
        () => supervisor.stop(),
        async () => {
          await poll(
            async () => (activeDispatches.size === 0 ? true : null),
            30000,
            "owned dispatch settlement after host teardown",
            25,
          );
        },
        async () => {
          if (initialRunIds === undefined) return;
          const remaining = await database.pool.query(
            "SELECT assignment.run_id FROM execution_assignments assignment WHERE assignment.state='active' AND (assignment.run_id<>ALL($1::text[]) OR assignment.run_id=ANY($2::text[]))",
            [initialRunIds, [...dispatchedRunIds]],
          );

          expect(remaining.rows).toEqual([]);
        },
        async () => {
          if (ownedCancellation)
            await revokeCompanyGrant(
              db,
              administratorId,
              ownedCancellation.id,
              {
                expectedRevision: ownedCancellation.revision,
                reason:
                  "Release this project fixture's exact temporary cancellation authority",
                idempotencyKey: randomUUID(),
              },
            );
        },
        () => worker.stop(),
        () => stopRuntimeEventConsumers(),
        () => {
          restoreAgentDispatch?.();
        },
        () => {
          restoreFlowDispatch?.();
        },
        () => {
          restoreUrl();
        },
        () => {
          browserSession.user = null;
        },
        () => {
          resetResolverForTests();
        },
        () => {
          resetRegistrarStateForTests();
        },
        () => {
          setDefaultTransportForTests(null);
        },
      ];

      for (const release of cleanup) {
        try {
          await release();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (cleanupFailures.length)
        throw new AggregateError(
          [...(bodyFailure ? [bodyFailure.error] : []), ...cleanupFailures],
          "Project assignment fixture could not release all owned executions",
        );
    }
    // Manual, mention, event and webhook deliveries each retain their own bounded waits.
  }, 240000);

  it.each(["live", "checkpointed", "cancelled"] as const)(
    "IT-CBS-02 routes a real company permission through current human authority and the existing owned delivery (%s)",
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
        const binding = await createCompanySpecialistBinding(
          db,
          userId,
          roleId,
          {
            owner: { kind: "company", companyId: request.companyId },
            packageInstallId: effective.packageInstallId,
            packageRevision: effective.resolvedRevision!,
            definitionSha256: agentDefinitionSha256(effective.parsed),
            enabled: true,
            configuration: {},
            grantActions: ["knowledge:read", "knowledge:propose"],
            runnerId,
            idempotencyKey: randomUUID(),
          },
        );
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
              headers: {
                "content-type": "application/json",
                Origin: "http://localhost",
                "Sec-Fetch-Site": "same-origin",
              },
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
                  new Request(
                    `http://localhost/api/runs/${receipt.runId}/stop`,
                    {
                      method: "POST",
                    },
                  ),
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
          expect(
            await runSweepTick({ db, executionHosts: hosts }),
          ).toMatchObject({
            idledCount: 1,
          });
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
              headers: {
                "content-type": "application/json",
                Origin: "http://localhost",
                "Sec-Fetch-Site": "same-origin",
              },
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
              (
                await db.select().from(runs).where(eq(runs.id, receipt.runId))
              )[0].status,
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
});

describe("company admission, reservation and preflight guards", () => {
  it("IT-CBS-02 shares the existing bounded agent pool across project and company work and promotes a queued company run once", async () => {
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
      const projectFailure = await prepareUndispatchedAgentFailure(
        projectRunId,
        {
          db,
          reason: "fixture_before_dispatch",
        },
      );

      await db.transaction((tx) => projectFailure.apply(tx));
      const contenders = [first.runId, second.runId];
      const outcomes = await Promise.all(
        contenders.map((runId) => tryStartRun(runId, { db })),
      );

      expect(outcomes.filter((outcome) => outcome.started)).toHaveLength(1);
      expect(await countLiveRuns(db, "agent")).toBe(1);
      const winner =
        contenders[outcomes.findIndex((outcome) => outcome.started)];
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

  it("IT-CBS-02 atomically reserves one company execution with frozen session and placement under concurrent admission", async () => {
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
      const refused = outcomes.filter(
        (outcome) => outcome.status === "rejected",
      );

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
      await database.pool.query("DELETE FROM projects WHERE id=$1", [
        source.id,
      ]);
    } finally {
      resetResolverForTests();
      setDefaultTransportForTests(null);
    }
  });

  it("IT-CBS-02 serializes company cancellation and budget termination by their first retained owner", async () => {
    const db: Db = database.db;
    const { hosts } = await fakeExecutionHosts(db);
    const host = await localHost({ db, transport: hosts.transport });
    const runnerId = randomUUID();
    const rollback = new Error("Roll back the company stop ordering fixtures");

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(platformAcpRunners).values({
          id: runnerId,
          adapter: "claude",
          capabilityAgent: "claude",
          model: "company-stop-ordering-fixture",
          provider: { kind: "anthropic" },
          readinessStatus: "Ready",
        });
        await tx
          .insert(platformRuntimeSettings)
          .values({ id: "singleton", defaultRunnerId: runnerId })
          .onConflictDoUpdate({
            target: platformRuntimeSettings.id,
            set: { defaultRunnerId: runnerId },
          });
        for (const first of ["budget", "operator"] as const) {
          const assignment = await createSpecialistAssignmentInTransaction(
            tx,
            userId,
            assignmentInput,
          );
          const receipt = await reserveCompanyAgentRunInTransaction(
            tx,
            userId,
            { ...request, assignmentId: assignment.id },
            hosts,
            host,
          );
          const [run] = await tx
            .update(runs)
            .set({ status: "Running" })
            .where(eq(runs.id, receipt.runId))
            .returning();
          const claimBudget = () =>
            claimBudgetTermination(tx, {
              runId: run.id,
              nodeId: run.currentStepId,
              scope: "run",
              meter: "tokens",
              current: 2,
              limit: 1,
              assignmentId: run.executionAssignmentId,
              sessionId: null,
            });

          if (first === "budget") {
            const termination = await claimBudget();

            expect(termination).not.toBeNull();
            await expect(
              claimCompanyStop(tx, userId, run.id),
            ).rejects.toMatchObject({
              code: "CONFLICT",
              details: { reason: "budget_termination_pending" },
            });
            const [retained] = await tx
              .select()
              .from(runs)
              .where(eq(runs.id, run.id));

            expect(retained.companyCancellationIntent).toBeNull();
            expect(retained.budgetState?.termination?.id).toBe(termination!.id);
          } else {
            const stopped = await claimCompanyStop(tx, userId, run.id);

            expect(stopped.companyCancellationIntent?.userId).toBe(userId);
            expect(await claimBudget()).toBeNull();
            const [retained] = await tx
              .select()
              .from(runs)
              .where(eq(runs.id, run.id));

            expect(retained.companyCancellationIntent).toEqual(
              stopped.companyCancellationIntent,
            );
            expect(retained.budgetState?.termination).toBeUndefined();
          }
          expect(
            (
              await tx
                .select()
                .from(executionCommands)
                .where(eq(executionCommands.runId, run.id))
            ).length,
          ).toBe(0);
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it("IT-CBS-02 cancels a native Pending company Run only under current cancellation authority and retains one terminal outcome", async () => {
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

  it("IT-CBS-02 uses the exact company binding runner and refuses its kill switch instead of choosing a ready platform default", async () => {
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
      const receipt = await reserveCompanyAgentRun(
        db,
        userId,
        admission,
        hosts,
      );

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

  it("IT-CBS-02 dispatches a company assignment through the existing owned agent driver and verifies its operational result", async () => {
    const db: Db = database.db;
    const fake = createFakeExecutionHost();
    const promptEntered = Promise.withResolvers<void>();
    const finishPrompt = Promise.withResolvers<void>();
    const { prompts } = scriptAgentTurn(fake, {
      text:
        "```json maister:output\n" +
        JSON.stringify(operationalSuccessFixture()) +
        "\n```",
      onPrompt: async ({ sessionId }) => {
        promptEntered.resolve();
        await finishPrompt.promise;
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
      const firstCreate = Promise.withResolvers<void>();
      const keepCreateOpen = Promise.withResolvers<void>();
      let createCalls = 0;
      const executionHosts: typeof hosts = {
        ...hosts,
        async executionFor(...args) {
          const execution = await hosts.executionFor(...args);

          return {
            ...execution,
            client: {
              ...execution.client,
              async createOwnedSession(...createArgs) {
                if (++createCalls === 1) {
                  firstCreate.resolve();
                  await keepCreateOpen.promise;
                }

                return execution.client.createOwnedSession(...createArgs);
              },
            },
          };
        },
      };
      const firstDriver = startAgentSession(receipt.runId, {
        db,
        executionHosts,
      });
      let secondDriver: Promise<void> | undefined;

      try {
        await Promise.race([
          firstCreate.promise,
          firstDriver.then(() => {
            throw new Error("The first driver did not start creation");
          }),
        ]);
        secondDriver = startAgentSession(receipt.runId, { db, executionHosts });
        await Promise.race([
          secondDriver,
          promptEntered.promise.then(() => {
            throw new Error(
              "The competing driver submitted a prompt while creation was held",
            );
          }),
        ]);
        expect(createCalls).toBe(1);
        keepCreateOpen.resolve();
        await Promise.race([
          promptEntered.promise,
          firstDriver.then(() => {
            throw new Error("The owning driver did not submit its prompt");
          }),
        ]);
        const create = fake.callsOf("createSession")[0]?.envelope?.payload;
        const [running] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, receipt.runId));
        const { cwd } = await operationalWorkspace(db, running);
        const settings: unknown = JSON.parse(
          await readFile(join(cwd, ".claude/settings.local.json"), "utf8"),
        );

        expect(settings).toMatchObject({
          model: "company-driver-fixture",
          availableModels: ["company-driver-fixture"],
          permissions: { deny: expect.arrayContaining(["Edit", "Write"]) },
        });
        const descriptor = z
          .object({
            mcpServers: z.array(
              z.object({
                name: z.string(),
                env: z.record(z.string(), z.string()).optional(),
              }),
            ),
          })
          .parse(create);
        const credential = descriptor.mcpServers.find(
          ({ name }) => name === "maister",
        )?.env?.MAISTER_PROJECT_TOKEN;

        if (!credential)
          throw new Error(
            "The original create did not bind a facade credential",
          );
        await expect(verifyToken(credential, db)).resolves.toMatchObject({
          boundRunId: receipt.runId,
        });
      } finally {
        keepCreateOpen.resolve();
        finishPrompt.resolve();
        await Promise.allSettled([firstDriver, secondDriver]);
      }
      expect(fake.callsOf("createSession")).toHaveLength(1);
      expect(
        (
          await database.pool.query(
            "SELECT id FROM project_tokens WHERE company_run_id=$1",
            [receipt.runId],
          )
        ).rows,
      ).toHaveLength(1);
      expect(fake.callsOf("createSession")[0].envelope?.payload).toMatchObject({
        readOnlySession: true,
        agentKind: "operational",
        reapOnEndTurn: true,
        autoApprovePermissions: false,
      });
      expect(fake.callsOf("adoptWorkspace")[0].envelope?.payload).toMatchObject(
        {
          projectSlug: "_company",
          owner: { kind: "company", companyId: request.companyId },
          kind: "directory",
        },
      );
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
        run: {
          id: receipt.runId,
          projectId: null,
          companyId: request.companyId,
        },
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

  it("IT-CBS-02 refuses revoked current assignment authority after reservation before workspace or session effects", async () => {
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

  it("IT-CBS-02 refuses a frozen runner disabled after reservation and preserves the requested work", async () => {
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

  it("IT-CBS-02 refuses assignment authority that differs from the reviewed specialist policy and accepts equivalent normalized policy", async () => {
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

describe("company run ownership, credentials and assignment input authority", () => {
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

  it("IT-CBS-02 retains company human work in the existing assignment/actor ledger and refuses a foreign project actor", async () => {
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
      completeHitlAssignmentFromCurrentActor({
        db: database.db,
        hitlRequestId,
      }),
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
    const answerGrant = await createCompanyGrants(
      database.db,
      administratorId,
      {
        principalKind: "user",
        principalId: userId,
        actions: ["assignments:answer"],
        idempotencyKey: randomUUID(),
      },
    );

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
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(
      {
        components: contract.components,
        $ref: "#/components/schemas/Assignment",
      },
    );

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
      database.pool.query(
        "UPDATE actor_identities SET user_id=$2 WHERE id=$1",
        [actor.id, administratorId],
      ),
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
        await database.pool.query(
          "SELECT status FROM assignments WHERE id=$1",
          [human.id],
        )
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
        restore:
          "UPDATE package_installs SET trust_status='trusted' WHERE id=$1",
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
    expect(
      (await verifyToken(currentToken.secret, database.db)).boundRunId,
    ).toBe(runId);
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
        details: {
          sqlState: "23514",
          constraint: "company_token_issue_fixture",
        },
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

  it("IT-CBS-02 authorizes only the executing specialist's exact assignment input without implying Company Brain read access", async () => {
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
});

async function reserveContextFixture(
  roleId: string,
  actions: readonly CompanyAction[],
  verification = assignmentInput.objectiveInput.verification,
  executionPolicy = assignmentInput.executionPolicy,
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
      executionPolicy,
      grantActions: [...actions],
      idempotencyKey: randomUUID(),
    },
  );
  const result = buildOperationalContract(effective);
  const input: PreparedSpecialistAssignment = {
    ...assignmentInput,
    executionPolicy,
    objectiveInput: {
      ...assignmentInput.objectiveInput,
      expectedResult: {
        schemaRef: result.schemaRef,
        schemaVersion: result.schemaVersion,
        sha256: result.sha256,
        required: true,
      },
      verification,
    },
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

describe("observation guards, source-bound replacement and execution handoff", () => {
  it("IT-CBO-08 refuses an otherwise valid observation when the exact company input requires independent health evidence", async () => {
    const appointment = await reserveContextFixture(
      "rah:evidence-observer",
      ["assignments:read"],
      [{ kind: "health", required: true, referenceId: null }],
    );
    const [run] = await database.db
      .select({ contract: runs.resultContract })
      .from(runs)
      .where(eq(runs.id, appointment.runId));
    const contract = run?.contract;

    expect(contract).toMatchObject({ contractName: "operational_evidence_v2" });
    if (!contract)
      throw new Error("The installed evidence contract is missing");
    const value = {
      ...operationalSuccessFixture(),
      schemaVersion: 2,
      findings: {
        schemaVersion: 1,
        findings: [],
        selection: [],
        knowledgeProposals: [],
      },
      operationIds: [],
      verificationIds: [],
    };
    const decision = decideAgentResult({
      contract,
      finalText: "```json maister:output\n" + JSON.stringify(value) + "\n```",
    });

    expect(decision.kind).toBe("valid");
    await expect(
      database.db.transaction((tx) =>
        validateOperationalEvidenceReferences(
          tx,
          appointment.runId,
          contract,
          decision,
        ),
      ),
    ).resolves.toMatchObject({
      kind: "invalid",
      validationDiagnostics: [
        { code: "evidence_reference_unavailable", path: "verificationIds" },
      ],
    });
    await revokeAgentRunTokensForRun(appointment.runId, database.db);
  });

  it("IT-CBC-03 reserves one source-bound replacement for a settled company specialist before dispatch", async () => {
    const db: Db = database.db;
    const { hosts } = await fakeExecutionHosts(db);
    const runnerId = randomUUID();
    const [previous] = await db.select().from(platformRuntimeSettings);

    await db.insert(platformAcpRunners).values({
      id: runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "replacement-fixture",
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
    const source = await reserveCompanyAgentRun(
      db,
      userId,
      {
        ...request,
        assignmentId: assignment.id,
      },
      hosts,
    );
    const grants = await createCompanyGrants(db, administratorId, {
      principalKind: "user",
      principalId: userId,
      actions: ["assignments:recover"],
      idempotencyKey: randomUUID(),
    });
    let recoverGrant = grants.page.items.find(
      (grant) => grant.action === "assignments:recover",
    )!;

    try {
      expect(await tryStartRun(source.runId, { db })).toMatchObject({
        started: true,
      });
      const failed = await prepareUndispatchedAgentFailure(source.runId, {
        db,
        reason: "agent_dispatch_failed",
      });

      await db.transaction(failed.apply);
      const preview = await getAgentRetryOptions(db, source.runId, userId);

      expect(preview).toMatchObject({ eligible: true, reason: null });
      const retry = {
        runnerId: preview.selectedRunnerId!,
        requestKey: randomUUID(),
        previewFingerprint: preview.previewFingerprint,
      };
      const cancelling = await database.pool.connect();

      try {
        await cancelling.query("BEGIN");
        await cancelling.query(
          "SELECT id FROM specialist_assignments WHERE id=$1 FOR UPDATE",
          [assignment.id],
        );
        await expect(
          acceptAgentRetry(db, source.runId, userId, retry),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          details: { reason: "retry_assignment_busy" },
        });
      } finally {
        await cancelling.query("ROLLBACK");
        cancelling.release();
      }

      await expect(
        acceptAgentRetry(db, source.runId, userId, {
          ...retry,
          previewFingerprint: "0".repeat(64),
        }),
      ).rejects.toMatchObject({ details: { reason: "retry_preview_stale" } });
      await revokeCompanyGrant(db, administratorId, recoverGrant.id, {
        expectedRevision: recoverGrant.revision,
        reason: "Exercise action-time recovery authority",
        idempotencyKey: randomUUID(),
      });
      await expect(
        acceptAgentRetry(db, source.runId, userId, retry),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      const restored = await createCompanyGrants(db, administratorId, {
        principalKind: "user",
        principalId: userId,
        actions: ["assignments:recover"],
        idempotencyKey: randomUUID(),
      });

      recoverGrant = restored.page.items.find(
        (grant) => grant.action === "assignments:recover",
      )!;
      const receipts = await Promise.all([
        acceptAgentRetry(db, source.runId, userId, retry),
        acceptAgentRetry(db, source.runId, userId, retry),
      ]);

      expect(receipts[0]).toMatchObject({
        intentState: "launched",
        runStatus: "Pending",
      });
      expect(receipts[1]).toEqual(receipts[0]);
      const reviewing = await database.pool.connect();

      try {
        await reviewing.query("BEGIN");
        await reviewing.query(
          "SELECT id FROM specialist_assignments WHERE id=$1 FOR UPDATE",
          [assignment.id],
        );
        await expect(
          getAgentRetryOptions(db, source.runId, userId),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          details: { reason: "retry_assignment_busy" },
        });
        await expect(
          getAgentRetryReceipt(
            db,
            source.runId,
            receipts[0].retryIntentId,
            userId,
          ),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          details: { reason: "retry_assignment_busy" },
        });
      } finally {
        await reviewing.query("ROLLBACK");
        reviewing.release();
      }
      await expect(
        getAgentRetryOptions(db, source.runId, userId),
      ).resolves.toMatchObject({
        eligible: false,
        reason: "retry_successor_already_owned",
        existingIntentId: receipts[0].retryIntentId,
      });
      await expect(
        getAgentRetryReceipt(
          db,
          source.runId,
          receipts[0].retryIntentId,
          userId,
        ),
      ).resolves.toEqual(receipts[0]);
      expect(
        (
          await database.pool.query(
            "SELECT run_id,role,input_revision FROM specialist_run_links WHERE assignment_id=$1 ORDER BY root_appointment_epoch",
            [assignment.id],
          )
        ).rows,
      ).toEqual([
        { run_id: source.runId, role: "specialist", input_revision: 1 },
        { run_id: receipts[0].runId, role: "continuation", input_revision: 1 },
      ]);
      expect(
        (
          await database.pool.query(
            "SELECT recipe->'replacement' AS witness FROM agent_retry_intents WHERE id=$1",
            [receipts[0].retryIntentId],
          )
        ).rows[0],
      ).toMatchObject({
        witness: { sourceRunId: source.runId, ownerEpoch: 1 },
      });
      const successor = receipts[0].runId!;

      expect(await tryStartRun(successor, { db })).toMatchObject({
        started: true,
      });
      await expect(
        db.transaction((tx) => loadCompanyAgentSessionContext(tx, successor)),
      ).resolves.toMatchObject({
        input: {
          revision: 1,
          digest: (
            await getSpecialistAssignmentInput(db, userId, assignment.id, 1)
          ).digest,
        },
      });
      await revokeCompanyGrant(db, administratorId, recoverGrant.id, {
        expectedRevision: recoverGrant.revision,
        reason: "Withdraw recovery authority before replacement dispatch",
        idempotencyKey: randomUUID(),
      });
      await expect(
        db.transaction((tx) => loadCompanyAgentSessionContext(tx, successor)),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      const renewed = await createCompanyGrants(db, administratorId, {
        principalKind: "user",
        principalId: userId,
        actions: ["assignments:recover"],
        idempotencyKey: randomUUID(),
      });

      recoverGrant = renewed.page.items.find(
        (grant) => grant.action === "assignments:recover",
      )!;
      const settle = await prepareUndispatchedAgentFailure(successor, {
        db,
        reason: "fixture_replacement_complete",
      });

      await db.transaction(settle.apply);
    } finally {
      if (previous)
        await db
          .update(platformRuntimeSettings)
          .set({ defaultRunnerId: previous.defaultRunnerId })
          .where(eq(platformRuntimeSettings.id, "singleton"));
      else
        await db
          .delete(platformRuntimeSettings)
          .where(eq(platformRuntimeSettings.id, "singleton"));
      await revokeCompanyGrant(db, administratorId, recoverGrant.id, {
        expectedRevision: recoverGrant.revision,
        reason: "Release replacement qualification authority",
        idempotencyKey: randomUUID(),
      });
    }
  });

  it("IT-CBC-03 preserves the settled company cron invocation and frozen request across replacement", async () => {
    const db: Db = database.db;
    const { hosts } = await fakeExecutionHosts(db);
    const roleId = "rah:cron-retry-observer";
    const effective = await resolveInstalledAgentDefinition(db, {
      agentId: roleId,
      packageInstallId: assignmentInput.standingDefinition.packageInstallId,
    });
    const runnerId = randomUUID();

    await db.insert(platformAcpRunners).values({
      id: runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "company-cron-retry-fixture",
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
    const cron = await createCompanyCronSchedule(db, userId, {
      owner: { kind: "company", companyId: request.companyId },
      specialistBindingId: binding.specialist.bindingId,
      cronExpr: "*/5 * * * *",
      timezone: "UTC",
      requestAtLaunch:
        "Recover the original recurring request bytes, including кириллица.",
      enabled: true,
      idempotencyKey: randomUUID(),
    });
    const grants = await createCompanyGrants(db, administratorId, {
      principalKind: "user",
      principalId: userId,
      actions: ["assignments:recover"],
      idempotencyKey: randomUUID(),
    });
    const grant = grants.page.items.find(
      (item) => item.action === "assignments:recover",
    )!;

    try {
      await database.pool.query(
        "UPDATE agent_schedules SET next_fire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [cron.scheduleId],
      );
      const now = new Date();
      const attempt = await claimCronAgentAttempt(
        db,
        cron.scheduleId,
        now,
        new Date(now.getTime() + 300000),
      );

      expect(attempt).not.toBeNull();
      const receipt = await reserveCompanyCronAssignment(
        db,
        { attemptId: attempt!.id, runId: attempt!.reservedRunId },
        hosts,
      );

      await database.pool.query(
        "UPDATE agent_trigger_attempts SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [attempt!.id],
      );
      await reconcileAgentTriggerAttempts(db, new Date());
      const [sourceRunId] = receipt.assignment.runIds;
      const failure = await prepareUndispatchedAgentFailure(sourceRunId, {
        db,
        reason: "agent_dispatch_failed",
      });

      await db.transaction(failure.apply);
      const preview = await getAgentRetryOptions(db, sourceRunId, userId);

      expect(preview).toMatchObject({
        eligible: true,
        selectedRunnerId: runnerId,
      });
      const replacement = await acceptAgentRetry(db, sourceRunId, userId, {
        requestKey: randomUUID(),
        runnerId,
        previewFingerprint: preview.previewFingerprint,
      });

      expect(replacement).toMatchObject({
        intentState: "launched",
        runStatus: "Pending",
      });
      const [successor] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, replacement.runId!));
      const [source] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, sourceRunId));

      expect(successor).toMatchObject({
        triggerSource: "cron",
        agentScheduleId: cron.scheduleId,
        retryOfRunId: sourceRunId,
        scheduledRequestSnapshot: source.scheduledRequestSnapshot,
      });
      expect(
        (
          await database.pool.query(
            "SELECT run_id,outcome FROM agent_trigger_attempts WHERE schedule_id=$1",
            [cron.scheduleId],
          )
        ).rows,
      ).toEqual([{ run_id: sourceRunId, outcome: "queued" }]);
      await expect(
        db.transaction((tx) =>
          loadCompanyAgentSessionContext(tx, successor.id),
        ),
      ).resolves.toMatchObject({
        input: {
          snapshot: { scheduledRequest: source.scheduledRequestSnapshot },
        },
      });
      await database.pool.query(
        "UPDATE agent_schedules SET enabled=false,company_config_revision=company_config_revision+1 WHERE id=$1",
        [cron.scheduleId],
      );
      await expect(
        db.transaction((tx) =>
          loadCompanyAgentSessionContext(tx, successor.id),
        ),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "retry_context_changed" },
      });
      const settle = await prepareUndispatchedAgentFailure(successor.id, {
        db,
        reason: "fixture_replacement_complete",
      });

      await db.transaction(settle.apply);
    } finally {
      await revokeCompanyGrant(db, administratorId, grant.id, {
        expectedRevision: grant.revision,
        reason: "Release cron recovery qualification authority",
        idempotencyKey: randomUUID(),
      });
    }
  });

  it("IT-CBC-03 preserves the original company event and its producing Run evidence on retry", async () => {
    const db: Db = database.db;
    const { hosts } = await fakeExecutionHosts(db);
    const roleId = "rah:event-retry-observer";
    const effective = await resolveInstalledAgentDefinition(db, {
      agentId: roleId,
      packageInstallId: assignmentInput.standingDefinition.packageInstallId,
    });
    const runnerId = randomUUID();

    await db.insert(platformAcpRunners).values({
      id: runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "company-event-retry-fixture",
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
      grantActions: ["assignments:read"],
      runnerId,
      idempotencyKey: randomUUID(),
    });
    const agentGrants = await createCompanyGrants(db, administratorId, {
      principalKind: "agent",
      principalId: roleId,
      actions: ["assignments:read"],
      idempotencyKey: randomUUID(),
    });
    const userGrants = await createCompanyGrants(db, administratorId, {
      principalKind: "user",
      principalId: userId,
      actions: ["assignments:recover"],
      idempotencyKey: randomUUID(),
    });

    try {
      const subscription = await createCompanyEventSchedule(db, userId, {
        owner: { kind: "company", companyId: request.companyId },
        specialistBindingId: binding.specialist.bindingId,
        eventKinds: ["run.done"],
        enabled: true,
        idempotencyKey: randomUUID(),
      });
      const producing = await reserveCompanyFixtureRun();

      await db
        .update(runs)
        .set({
          triggerSource: "manual",
          knowledgeAccess: {
            schemaVersion: 1,
            state: "complete",
            generation: 1,
            restrictions: [
              {
                kind: "assignment_input",
                assignmentId: producing.snapshot.assignment.id,
                inputRevision: 1,
                inputSha256: producing.snapshot.assignment.inputSha256,
              },
            ],
          },
        })
        .where(eq(runs.id, producing.runId));

      await emitDomainEvent({
        db,
        companyId: request.companyId,
        runId: producing.runId,
        parentRunId: null,
        kind: "run.done",
        actor: { type: "system", id: null },
        payload: {
          runId: producing.runId,
          runKind: "agent",
          flowId: null,
          taskId: null,
        },
      });
      const [fact] = (
        await database.pool.query<{ id: string }>(
          "SELECT id FROM domain_events WHERE run_id=$1 AND kind='run.done'",
          [producing.runId],
        )
      ).rows;
      const now = new Date();
      const invocation = await claimEventAgentAttempt(
        db,
        subscription.scheduleId,
        now,
        Number(fact.id),
      );

      expect(invocation).not.toBeNull();
      const source = await reserveCompanyEventAssignment(
        db,
        { attemptId: invocation!.id, runId: invocation!.reservedRunId },
        hosts,
      );
      const [sourceRunId] = source.assignment.runIds;

      await settleCompanyAgentTriggerAttempt(db, invocation!, {
        outcome: "queued",
        runId: sourceRunId,
        reasonCode: null,
        now,
      });
      const failure = await prepareUndispatchedAgentFailure(sourceRunId, {
        db,
        reason: "agent_dispatch_failed",
      });

      await db.transaction(failure.apply);
      const preview = await getAgentRetryOptions(db, sourceRunId, userId);

      expect(preview).toMatchObject({
        eligible: true,
        selectedRunnerId: runnerId,
      });
      const replacement = await acceptAgentRetry(db, sourceRunId, userId, {
        requestKey: randomUUID(),
        runnerId,
        previewFingerprint: preview.previewFingerprint,
      });

      expect(replacement).toMatchObject({
        intentState: "launched",
        runStatus: "Pending",
      });
      const context = await db.transaction((tx) =>
        loadCompanyAgentSessionContext(tx, replacement.runId!),
      );

      expect(context.run).toMatchObject({
        triggerSource: "domain_event",
        agentScheduleId: subscription.scheduleId,
        triggerEventId: Number(fact.id),
        retryOfRunId: sourceRunId,
      });
      expect(context.input.snapshot.sourceRestrictions).toContainEqual({
        kind: "assignment_input",
        assignmentId: producing.snapshot.assignment.id,
        inputRevision: 1,
        inputSha256: producing.snapshot.assignment.inputSha256,
      });
      await expect(
        claimEventAgentAttempt(
          db,
          subscription.scheduleId,
          now,
          Number(fact.id),
        ),
      ).resolves.toBeNull();
      const grant = agentGrants.page.items[0];

      await revokeCompanyGrant(db, administratorId, grant.id, {
        expectedRevision: grant.revision,
        reason: "Revoke event source sharing before dispatch",
        idempotencyKey: randomUUID(),
      });
      await expect(
        db.transaction((tx) =>
          loadCompanyAgentSessionContext(tx, replacement.runId!),
        ),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "retry_context_changed" },
      });
      const settle = await prepareUndispatchedAgentFailure(replacement.runId!, {
        db,
        reason: "fixture_replacement_complete",
      });

      await db.transaction(settle.apply);
    } finally {
      for (const grant of userGrants.page.items)
        await revokeCompanyGrant(db, administratorId, grant.id, {
          expectedRevision: grant.revision,
          reason: "Release event recovery qualification authority",
          idempotencyKey: randomUUID(),
        });
    }
  });

  it.each(["none", "worktree", "repo_read", "detached"] as const)(
    "IT-CBC-03 preserves an exact native project appointment through the existing retry sweep (%s)",
    async (workspace) => {
      const db: Db = database.db;
      const { host, hosts, fake } = await fakeExecutionHosts(db);
      const repo = await initRepo(
        join(root, `project-replacement-${workspace}`),
      );
      const project = await seedProjectRow(database.db, { repoPath: repo });
      const runnerId = randomUUID();
      const [previous] = await db.select().from(platformRuntimeSettings);

      await db.insert(platformAcpRunners).values({
        id: runnerId,
        adapter: "claude",
        capabilityAgent: "claude",
        model: "project-replacement-fixture",
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
      const link = await attachAgent(
        {
          projectId: project.id,
          agentId: {
            none: "rah:wire-observer",
            worktree: "rah:worktree-retry-observer",
            repo_read: "rah:repo-observer",
            detached: "rah:detached-retry-observer",
          }[workspace],
          runnerOverrideId: runnerId,
        },
        db,
      );
      const pressure = await database.pool.query<{ execution_host_id: string }>(
        `INSERT INTO execution_host_pressure(execution_host_id,pressured_since)
      VALUES($1,now()) ON CONFLICT DO NOTHING RETURNING execution_host_id`,
        [host.id],
      );

      try {
        const { expectedResult: _expectedResult, ...objective } =
          assignmentInput.objectiveInput;
        const receipt = await submitProjectManualAssignment(db, userId, {
          ...objective,
          owner: { kind: "project", projectId: project.id },
          specialistBindingId: link.linkId,
          input:
            "Preserve this exact project assignment input through replacement.",
          idempotencyKey: randomUUID(),
        });
        const [sourceRunId] = receipt.assignment.runIds;

        expect(sourceRunId).toBeDefined();
        const originalReadCommit =
          workspace === "repo_read" || workspace === "detached"
            ? await git(repo, "rev-parse", "HEAD")
            : null;

        if (originalReadCommit) {
          await database.pool.query(
            "DELETE FROM execution_host_pressure WHERE execution_host_id=$1",
            [host.id],
          );
          expect(await tryStartRun(sourceRunId, { db })).toMatchObject({
            started: true,
          });
          const [source] = await db
            .select()
            .from(runs)
            .where(eq(runs.id, sourceRunId));
          const context = await operationalWorkspace(db, source);
          const preparation = await openAgentPreparation(db, {
            ...context,
            runId: source.id,
            assignmentId: source.executionAssignmentId!,
          });

          try {
            if (workspace === "detached")
              await preparation.runEffect(() =>
                addDetachedWorktree({
                  projectRepoPath: repo,
                  worktreePath: context.cwd,
                  committish: originalReadCommit,
                }),
              );
            const baseline = await captureOperationalBaseline(
              database.db as unknown as import("@/lib/execution-host/db").Db,
              context.cwd,
              context.resourceKind,
            );

            await preparation.publishBaseline({
              ...baseline,
              owner: {
                cwd: context.cwd,
                repoPath: repo,
                projectSlug: project.slug,
              },
            });
            await settleAgentPreparationFailure(
              db,
              source.id,
              preparation,
              new MaisterError(
                "PRECONDITION",
                "Controlled interruption before session creation",
              ),
              { runId: source.id, stage: "baseline" },
            );
          } finally {
            await preparation.release();
            await database.pool.query(
              "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) VALUES($1,now()) ON CONFLICT DO NOTHING",
              [host.id],
            );
          }
        } else {
          const failure = await prepareUndispatchedAgentFailure(sourceRunId, {
            db,
            reason: "agent_dispatch_failed",
          });

          await db.transaction(failure.apply);
        }
        const sourceWorkspace =
          workspace === "worktree"
            ? (
                await database.pool.query<{
                  base_commit: string;
                  base_branch: string;
                }>(
                  "SELECT base_commit,base_branch FROM workspaces WHERE run_id=$1",
                  [sourceRunId],
                )
              ).rows[0]!
            : null;

        if (sourceWorkspace) {
          await git(
            repo,
            "commit",
            "--allow-empty",
            "-m",
            "Advance branch before replacement",
          );

          expect((await git(repo, "rev-parse", "HEAD")).trim()).not.toBe(
            sourceWorkspace.base_commit,
          );
        }
        const options = await getAgentRetryOptions(db, sourceRunId, userId);

        expect(options).toMatchObject({
          eligible: true,
          reason: null,
          selectedRunnerId: runnerId,
        });
        if (workspace === "repo_read") {
          await git(
            repo,
            "commit",
            "--allow-empty",
            "-m",
            "Advance the shared read-only checkout",
          );
          await expect(
            getAgentRetryOptions(db, sourceRunId, userId),
          ).resolves.toMatchObject({
            eligible: false,
            reason: "retry_context_changed",
          });
          await git(repo, "reset", "--hard", "HEAD^");
        }
        if (workspace === "detached")
          await git(
            repo,
            "commit",
            "--allow-empty",
            "-m",
            "Advance detached checkout source ref",
          );
        const request = {
          runnerId,
          requestKey: randomUUID(),
          previewFingerprint: options.previewFingerprint,
        };
        const retry = await acceptAgentRetry(db, sourceRunId, userId, request);

        expect(retry).toMatchObject({ intentState: "accepted", runId: null });
        await expect(
          database.pool.query(
            "UPDATE agent_retry_intents SET state='launched',created_run_id=source_run_id WHERE id=$1",
            [retry.retryIntentId],
          ),
        ).rejects.toMatchObject({
          constraint: "project_specialist_replacement_successor",
        });
        const editing = await database.pool.connect();
        const startedAt = new Date();
        let nextSweepAt: Date;

        try {
          await editing.query("BEGIN");
          await editing.query(
            "SELECT id FROM specialist_assignments WHERE id=$1 FOR UPDATE",
            [receipt.assignment.id],
          );
          await expect(
            runAgentRetryAdmissionSweep(db, startedAt),
          ).resolves.toEqual({
            processed: 1,
            errors: [`retry ${retry.retryIntentId}: retry_assignment_busy`],
          });
          const [deferred] = (
            await database.pool.query<{
              attempts: number;
              state: string;
              due_at: Date;
            }>(
              "SELECT attempts,state,due_at FROM agent_retry_intents WHERE id=$1",
              [retry.retryIntentId],
            )
          ).rows;

          expect(deferred).toMatchObject({ attempts: 0, state: "accepted" });
          expect(deferred.due_at.getTime()).toBeGreaterThan(
            startedAt.getTime(),
          );
          nextSweepAt = deferred.due_at;
        } finally {
          await editing.query("ROLLBACK");
          editing.release();
        }
        await expect(
          runAgentRetryAdmissionSweep(db, nextSweepAt),
        ).resolves.toEqual({
          processed: 1,
          errors: [],
        });
        const successor = await getAgentRetryReceipt(
          db,
          sourceRunId,
          retry.retryIntentId,
          userId,
        );

        expect(successor).toMatchObject({
          intentState: "launched",
          runStatus: "Pending",
        });
        if (sourceWorkspace) {
          const [retainedWorkspace] = (
            await database.pool.query<{
              base_commit: string;
              base_branch: string;
              worktree_path: string;
            }>(
              "SELECT base_commit,base_branch,worktree_path FROM workspaces WHERE run_id=$1",
              [successor.runId],
            )
          ).rows;

          expect(retainedWorkspace).toMatchObject(sourceWorkspace);
          expect(
            (
              await git(retainedWorkspace!.worktree_path, "rev-parse", "HEAD")
            ).trim(),
          ).toBe(sourceWorkspace.base_commit);
        }
        await expect(
          acceptAgentRetry(db, sourceRunId, userId, request),
        ).resolves.toEqual(successor);
        const retained = await database.pool.query(
          `SELECT link.run_id,link.role,link.input_revision,run.retry_of_run_id
        FROM specialist_run_links link JOIN runs run ON run.id=link.run_id
        WHERE link.assignment_id=$1 ORDER BY link.root_appointment_epoch`,
          [receipt.assignment.id],
        );

        expect(retained.rows).toEqual([
          {
            run_id: sourceRunId,
            role: "specialist",
            input_revision: receipt.inputRevision,
            retry_of_run_id: null,
          },
          {
            run_id: successor.runId,
            role: "continuation",
            input_revision: receipt.inputRevision,
            retry_of_run_id: sourceRunId,
          },
        ]);
        if (sourceWorkspace) {
          const [retainedWorkspace] = (
            await database.pool.query<{ worktree_path: string }>(
              "SELECT worktree_path FROM workspaces WHERE run_id=$1",
              [successor.runId],
            )
          ).rows;

          await writeFile(
            join(retainedWorkspace!.worktree_path, "unexpected.txt"),
            "Changed after admission\n",
          );
          await database.pool.query(
            "DELETE FROM execution_host_pressure WHERE execution_host_id=$1",
            [host.id],
          );
          expect(await tryStartRun(successor.runId!, { db })).toMatchObject({
            started: true,
          });
          const createCalls = fake.callsOf("createSession").length;

          await startAgentSession(successor.runId!, {
            db,
            executionHosts: hosts,
          });
          expect(fake.callsOf("createSession")).toHaveLength(createCalls);
          expect(
            (
              await db.select().from(runs).where(eq(runs.id, successor.runId!))
            )[0],
          ).toMatchObject({ status: "Failed" });
        }
        if (workspace === "detached") {
          await database.pool.query(
            "DELETE FROM execution_host_pressure WHERE execution_host_id=$1",
            [host.id],
          );
          expect(await tryStartRun(successor.runId!, { db })).toMatchObject({
            started: true,
          });
          const observedCommit: { value: string | null } = { value: null };
          const removeHook = fake.onCall("createSession", async (call) => {
            if (call.envelope?.fence.runId !== successor.runId) return;
            const [current] = await db
              .select()
              .from(runs)
              .where(eq(runs.id, successor.runId!));
            const context = await operationalWorkspace(db, current);

            observedCommit.value = await git(context.cwd, "rev-parse", "HEAD");
          });

          try {
            scriptAgentTurn(fake, {
              text:
                "```json maister:output\n" +
                JSON.stringify(operationalSuccessFixture()) +
                "\n```",
              onPrompt: ({ sessionId }) => {
                const session = fake.sessions.get(sessionId);

                if (!session)
                  throw new Error(
                    "The detached replacement session was not created",
                  );
                fake.sessions.set(sessionId, {
                  ...session,
                  status: "exited",
                  exitCode: 0,
                  exitedAt: new Date().toISOString(),
                });

                return { stopReason: "end_turn", meta: null };
              },
            });
            await startAgentSession(successor.runId!, {
              db,
              executionHosts: hosts,
            });
            expect(observedCommit.value).toBe(originalReadCommit);
          } finally {
            removeHook();
          }
        }
        await database.pool.query(
          "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
          [project.id, userId],
        );
        await expect(
          getAgentRetryReceipt(db, sourceRunId, retry.retryIntentId, userId),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        if (!sourceWorkspace && workspace !== "detached") {
          const settle = await prepareUndispatchedAgentFailure(
            successor.runId!,
            {
              db,
              reason: "fixture_replacement_complete",
            },
          );

          await db.transaction(settle.apply);
        }
      } finally {
        if (pressure.rowCount)
          await database.pool.query(
            "DELETE FROM execution_host_pressure WHERE execution_host_id=$1",
            [host.id],
          );
        if (previous)
          await db
            .update(platformRuntimeSettings)
            .set({ defaultRunnerId: previous.defaultRunnerId })
            .where(eq(platformRuntimeSettings.id, "singleton"));
        else
          await db
            .delete(platformRuntimeSettings)
            .where(eq(platformRuntimeSettings.id, "singleton"));
      }
    },
  );

  it.each(["Running", "NeedsInput"] as const)(
    "IT-CBC-03 reclaims the expired specialist epoch when reconciliation reobserves retained work (%s)",
    async (status) => {
      const db: Db = database.db;
      const appointment = await reserveContextFixture(
        status === "Running"
          ? "rah:observer-adoption"
          : "rah:observer-adoption-waiting",
        ["assignments:read"],
      );
      const { hostId, hosts, fake } = await fakeExecutionHosts(db);
      const placement = await db.transaction((tx) =>
        mintAssignment(tx, {
          runId: appointment.runId,
          hostId,
          reason: "launch",
        }),
      );
      const context = await operationalWorkspace(
        db,
        (await db.select().from(runs).where(eq(runs.id, appointment.runId)))[0],
      );

      await mkdir(context.cwd, { recursive: true });
      const execution = await hosts.forRun(appointment.runId);

      await execution.adoptWorkspace({
        runId: appointment.runId,
        kind: "directory",
        path: context.cwd,
        projectSlug: "_company",
        owner: { kind: "company", companyId: request.companyId },
      });
      const session = await execution.createSession({
        stepId: "agent",
        executor: { agent: "claude", model: "mock" },
      });

      await fake.waitForCanonicalEvents();
      if (status === "NeedsInput")
        await db
          .update(runs)
          .set({ status })
          .where(eq(runs.id, appointment.runId));
      const observed = (
        await database.pool.query<{ epoch: number }>(
          "UPDATE specialist_owner_claims SET renewed_at=clock_timestamp()-interval '121 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE assignment_id=$1 RETURNING epoch",
          [appointment.assignmentId],
        )
      ).rows[0];
      const sessionId = session.sessionId;

      try {
        expect(
          await reobserveAgentSession({
            db,
            runId: appointment.runId,
            sessionId: randomUUID(),
            executionHosts: hosts,
          }),
        ).toBe(false);
        expect(
          (
            await database.pool.query(
              "SELECT epoch FROM specialist_owner_claims WHERE assignment_id=$1",
              [appointment.assignmentId],
            )
          ).rows,
        ).toEqual([observed]);
        expect(
          await runReconcileSweep({ db, executionHosts: hosts }),
        ).toMatchObject({ reobserved: 1 });
        expect(
          await reobserveAgentSession({
            db,
            runId: appointment.runId,
            sessionId,
            executionHosts: hosts,
          }),
        ).toBe(false);
        await poll(
          async () => {
            const [owner] = (
              await database.pool.query(
                "SELECT epoch,placement_id,expires_at>clock_timestamp() AS active FROM specialist_owner_claims WHERE assignment_id=$1",
                [appointment.assignmentId],
              )
            ).rows;

            return owner.epoch === observed.epoch + 1 &&
              owner.placement_id === placement.id &&
              owner.active
              ? owner
              : null;
          },
          1500,
          "re-observation adopted the same placed assignment",
          25,
        );
        expect(
          (
            await db.select().from(runs).where(eq(runs.id, appointment.runId))
          )[0],
        ).toMatchObject({ status });
        expect(fake.callsOf("createSession")).toHaveLength(1);
        expect(fake.callsOf("sendPrompt")).toHaveLength(0);
      } finally {
        await execution.deleteSession(sessionId);
        await revokeAgentRunTokensForRun(appointment.runId, db);
        await releaseAssignmentForRun(db, appointment.runId, "run_terminal");
      }
    },
  );

  it("IT-CBC-03 fences a company context writer at execution ownership handoff and preserves committed work", async () => {
    const db: Db = database.db;
    const roleId = "rah:owner-fence-observer";
    const appointment = await reserveContextFixture(roleId, [
      "assignments:read",
      "assignments:update",
    ]);
    const grants = await createCompanyGrants(db, administratorId, {
      principalKind: "agent",
      principalId: roleId,
      actions: ["assignments:update"],
      idempotencyKey: randomUUID(),
    });
    const grant = grants.page.items.find(
      (item) => item.action === "assignments:update",
    )!;
    const { hostId } = await fakeExecutionHosts(db);
    const url = `http://localhost/api/v1/ext/specialist-assignments/${appointment.assignmentId}/context`;
    const moveOwner = (reason: "launch" | "recover") =>
      db.transaction((tx) =>
        mintAssignment(tx, { runId: appointment.runId, hostId, reason }),
      );
    const mintCredential = () =>
      issueCompanyAgentRunToken({ db, runId: appointment.runId });
    const update = (revision: number, id: string) => ({
      expectedRevision: revision,
      expectedInputRevision: 1,
      idempotencyKey: `owner-fence-${id}`,
      updates: [
        {
          id,
          kind: "decision",
          state: "resolved",
          text: "Keep the verified observation.",
          references: [],
        },
      ],
    });
    const patch = (secret: string, body: ReturnType<typeof update>) =>
      externalContextPatch(
        new NextRequest(url, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ assignmentId: appointment.assignmentId }) },
      );

    try {
      const before = await moveOwner("launch");
      const original = await mintCredential();
      const first = await patch(
        original.secret,
        update(0, "first-observation"),
      );

      expect(first.status).toBe(200);
      const after = await moveOwner("recover");

      await database.pool.query(
        "UPDATE specialist_owner_claims SET renewed_at=clock_timestamp()-interval '45 seconds',expires_at=clock_timestamp()+interval '75 seconds' WHERE assignment_id=$1",
        [appointment.assignmentId],
      );
      await expect(
        database.pool.query(
          "SELECT renew_specialist_executor($1,$2,$3) AS current",
          [appointment.runId, before.id, 1],
        ),
      ).resolves.toMatchObject({ rows: [{ current: false }] });
      await expect(
        database.pool.query(
          "SELECT renew_specialist_executor($1,$2,$3) AS current",
          [appointment.runId, after.id, 2],
        ),
      ).resolves.toMatchObject({ rows: [{ current: true }] });
      await expect(
        database.pool.query(
          "SELECT epoch,expires_at>clock_timestamp()+interval '110 seconds' AS renewed FROM specialist_owner_claims WHERE assignment_id=$1",
          [appointment.assignmentId],
        ),
      ).resolves.toMatchObject({ rows: [{ epoch: 2, renewed: true }] });
      const continuation = update(1, "second-observation");
      const stale = await patch(original.secret, continuation);

      expect(stale.status).toBe(401);
      const owner = await mintCredential();
      const replay = await patch(owner.secret, update(0, "first-observation"));

      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        revision: 1,
        entries: [{ ownerEpoch: 1, executionEpoch: before.epoch }],
      });
      const recovered = await patch(owner.secret, continuation);

      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({
        revision: 2,
        entries: [
          {
            entry: { id: "first-observation" },
            ownerEpoch: 1,
            executionEpoch: before.epoch,
          },
          {
            entry: { id: "second-observation" },
            ownerEpoch: 2,
            executionEpoch: after.epoch,
          },
        ],
      });
      await expect(
        database.pool.query(
          `INSERT INTO specialist_context_revisions
        (assignment_id,revision,base_revision,input_revision,context,source_restrictions,actor,execution_epoch,principal_key,request_key,request_digest,content_digest)
        SELECT assignment_id,3,2,input_revision,context,source_restrictions,actor,$2,principal_key,'forged-old-epoch',request_digest,content_digest
        FROM specialist_context_revisions WHERE assignment_id=$1 AND revision=2`,
          [appointment.assignmentId, before.epoch],
        ),
      ).rejects.toMatchObject({
        constraint: "specialist_context_execution_epoch_required",
      });
      await expect(
        database.pool.query(
          `INSERT INTO specialist_context_revisions
        (assignment_id,revision,base_revision,input_revision,context,source_restrictions,actor,execution_epoch,owner_epoch,principal_key,request_key,request_digest,content_digest)
        SELECT assignment_id,3,2,input_revision,context,source_restrictions,actor,execution_epoch,1,principal_key,'forged-old-owner',request_digest,content_digest
        FROM specialist_context_revisions WHERE assignment_id=$1 AND revision=2`,
          [appointment.assignmentId],
        ),
      ).rejects.toMatchObject({
        constraint: "specialist_context_owner_epoch_required",
      });
      await database.pool.query(
        "UPDATE execution_assignments SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [after.id],
      );
      const expired = await patch(
        owner.secret,
        update(2, "expired-observation"),
      );

      expect(expired.status).toBe(409);
      expect(await expired.json()).toMatchObject({
        details: { reason: "assignment_fenced" },
      });
      await database.pool.query(
        "UPDATE execution_assignments SET lease_expires_at=NULL WHERE id=$1",
        [after.id],
      );
      await database.pool.query(
        "UPDATE specialist_owner_claims SET renewed_at=clock_timestamp()-interval '121 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE assignment_id=$1",
        [appointment.assignmentId],
      );
      expect(
        (await patch(owner.secret, update(2, "expired-owner"))).status,
      ).toBe(409);
      await expect(
        getSpecialistAssignmentTokenContext(
          db,
          owner.tokenId,
          appointment.assignmentId,
        ),
      ).resolves.toMatchObject({ revision: 2 });
      await expect(
        database.pool.query(
          "SELECT begin_specialist_executor($1,$2) AS epoch",
          [appointment.runId, after.id],
        ),
      ).resolves.toMatchObject({ rows: [{ epoch: 3 }] });
      await expect(
        database.pool.query(
          "SELECT renew_specialist_executor($1,$2,$3) AS current",
          [appointment.runId, after.id, 2],
        ),
      ).resolves.toMatchObject({ rows: [{ current: false }] });
      expect(
        (await patch(owner.secret, update(2, "stale-after-adoption"))).status,
      ).toBe(403);
      await expect(
        database.pool.query(
          "UPDATE project_tokens SET created_at=clock_timestamp() WHERE id=$1",
          [owner.tokenId],
        ),
      ).rejects.toMatchObject({
        constraint: "project_tokens_company_binding_immutable",
      });
      const adoptedOwner = await mintCredential();
      const adopted = await patch(
        adoptedOwner.secret,
        update(2, "adopted-observation"),
      );

      expect(adopted.status).toBe(200);
      expect(await adopted.json()).toMatchObject({
        revision: 3,
        entries: [{ ownerEpoch: 1 }, { ownerEpoch: 2 }, { ownerEpoch: 3 }],
      });
    } finally {
      await db.transaction((tx) =>
        releaseAssignmentForRun(tx, appointment.runId, "test_finished"),
      );
      await revokeAgentRunTokensForRun(appointment.runId, db);
      await revokeCompanyGrant(db, administratorId, grant.id, {
        expectedRevision: grant.revision,
        reason: "Release ownership qualification authority",
        idempotencyKey: randomUUID(),
      });
    }
  });
});

const cooperationRunnerId = randomUUID();

for (const stop of [
  "budget",
  "parent interruption",
  "child interruption",
] as const) {
  // Each scenario awaits several independently bounded host transitions.
  it(
    `IT-CBC-01 IT-CBC-04 IT-CBC-05 requires current company delegation grants and retains exact results through Flow rework, acceptance and ${stop}`,
    () => qualifyCompanyCooperation(stop),
    120_000,
  );
}

async function recordAssignmentBudgetUsage(
  db: Db,
  runId: string,
  inputTokens: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [allocated] = await tx
      .update(runs)
      .set({
        nextExecutionEventSequence: sql`${runs.nextExecutionEventSequence} + 1`,
      })
      .where(eq(runs.id, runId))
      .returning({ next: runs.nextExecutionEventSequence });

    await tx.insert(executionEvents).values({
      id: randomUUID(),
      source: "manager",
      sourceKey: `assignment-budget:${runId}`,
      runId,
      eventType: "usage.recorded",
      payloadSchema: "maister.usage.recorded.v1",
      payload: {
        sessionName: "default",
        model: "budget-fixture",
        inputTokens,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        resumed: false,
      },
      occurredAt: new Date(),
      receivedAt: new Date(),
      runSequence: allocated!.next - 1n,
      ingestDisposition: "accepted",
    });
  });
}

async function qualifyCompanyCooperation(
  stop: "budget" | "parent interruption" | "child interruption",
): Promise<void> {
  const db: Db = database.db;
  const reviewedTokens = 750_000;
  const executionPolicy = {
    preset: "supervised" as const,
    overrides: { budget: { tree: { maxTokens: reviewedTokens } } },
  };
  const roleId =
    stop === "budget"
      ? "rah:delegating-observer"
      : stop === "parent interruption"
        ? "rah:interrupted-cooperation-observer"
        : "rah:child-interruption-observer";
  const receivingRoleId =
    stop === "budget"
      ? "rah:company-dispatch-observer"
      : stop === "parent interruption"
        ? "rah:interrupted-dispatch-observer"
        : "rah:child-interruption-receiver";
  const appointment = await reserveContextFixture(
    roleId,
    [
      "knowledge:read",
      "assignments:read",
      "assignments:update",
      "assignments:delegate",
      "assignments:accept",
    ],
    assignmentInput.objectiveInput.verification,
    executionPolicy,
  );
  const assignment = await getSpecialistAssignment(
    database.db,
    userId,
    appointment.assignmentId,
  );
  const effective = await resolveInstalledAgentDefinition(database.db, {
    agentId: receivingRoleId,
    packageInstallId: assignmentInput.standingDefinition.packageInstallId,
  });
  const runnerId = cooperationRunnerId;

  await database.db
    .insert(platformAcpRunners)
    .values({
      id: runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "native-company-dispatch-fixture",
      provider: { kind: "anthropic" },
      readinessStatus: "Ready",
    })
    .onConflictDoNothing({ target: platformAcpRunners.id });
  const receiving = await createCompanySpecialistBinding(
    database.db,
    userId,
    receivingRoleId,
    {
      owner: { kind: "company", companyId: request.companyId },
      packageInstallId: effective.packageInstallId,
      packageRevision: effective.resolvedRevision!,
      definitionSha256: agentDefinitionSha256(effective.parsed),
      enabled: true,
      configuration: {},
      runnerId,
      executionPolicy,
      grantActions: ["assignments:read"],
      idempotencyKey: randomUUID(),
    },
  );
  const reviewed = await getCompanySpecialistBindingRevision(
    database.db,
    userId,
    receivingRoleId,
    receiving.specialist.bindingId,
    receiving.specialist.configRevision,
  );
  const prepared = {
    objectiveInput: {
      ...assignmentInput.objectiveInput,
      objective: "Inspect only the retained health observation",
      input: "Inspect only the retained health observation",
      verification: [
        { kind: "result" as const, referenceId: null, required: true },
      ],
    },
    target: {
      kind: "company_agent" as const,
      companyId: request.companyId,
      specialistBinding: {
        id: reviewed.bindingId,
        revision: reviewed.revision,
        snapshotSha256: reviewed.snapshotDigest,
      },
      role: {
        agentId: receivingRoleId,
        packageInstallId: effective.packageInstallId,
        packageRevision: effective.resolvedRevision!,
        definitionSha256: agentDefinitionSha256(effective.parsed),
      },
    },
    bounds: {
      schemaVersion: 1 as const,
      maxDepth: 2,
      maxFanout: 4,
      maxActiveChildren: 2,
      maxChildRuns: 8,
      maxTokens: 100000,
      wallClockMinutes: 30,
      consecutiveFailures: 3,
    },
    sourceRestrictions: [],
  };
  const workRequest = {
    tokenId: appointment.credential.tokenId,
    selector: {
      schemaVersion: 1 as const,
      assignmentId: assignment.id,
      expectedRevision: assignment.revision,
      inputRevision: assignment.inputRevision,
      contextRevision: assignment.contextRevision,
      logicalWorkId: "inspect",
      workRevision: 1,
    },
    prepared,
  };
  const retain = () =>
    database.db.transaction((tx) =>
      retainDelegatedWorkInTransaction(tx, workRequest),
    );
  const userGrant = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: userId,
    actions: ["assignments:delegate"],
    idempotencyKey: randomUUID(),
  });
  const initiating = userGrant.page.items.find(
    (entry) => entry.action === "assignments:delegate",
  )!;
  const fake = createFakeExecutionHost();
  const { hosts, hostId } = await fakeExecutionHosts(db, { fake });
  const revoke = (grant: { id: string; revision: number }) =>
    revokeCompanyGrant(database.db, administratorId, grant.id, {
      expectedRevision: grant.revision,
      reason: "End company delegation qualification",
      idempotencyKey: randomUUID(),
    });

  try {
    await expect(retain()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const professionalGrant = await createCompanyGrants(
      database.db,
      administratorId,
      {
        principalKind: "agent",
        principalId: roleId,
        actions: ["assignments:delegate"],
        idempotencyKey: randomUUID(),
      },
    );
    const professional = professionalGrant.page.items.find(
      (entry) => entry.action === "assignments:delegate",
    )!;
    let receipt: Awaited<ReturnType<typeof retain>>;
    let parkedGraphRunId: string | undefined;
    let pendingNestedRunId: string | undefined;
    let pendingGraphRunId: string | undefined;
    let qualifyParkedRootBudget: (() => Promise<void>) | undefined;

    try {
      await database.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT id FROM specialist_assignments WHERE id=${assignment.id} FOR UPDATE`,
        );
        await expect(retain()).rejects.toMatchObject({
          code: "CONFLICT",
          details: { reason: "assignment_work_busy" },
        });
      });
      receipt = await retain();
      expect(receipt).toMatchObject({
        duplicate: false,
        work: {
          bounds: { maxTokens: reviewedTokens },
          actor: { kind: "agent", id: roleId, runId: appointment.runId },
          definition: { target: prepared.target },
          authoritySnapshot: {
            witnesses: [
              { authorityId: initiating.id, revision: initiating.revision },
              {
                authorityId: professional.id,
                revision: professional.revision,
              },
            ],
          },
        },
      });
      expect(
        (
          await database.pool.query(
            "SELECT company_id, project_id, task_id FROM runs WHERE id=$1",
            [appointment.runId],
          )
        ).rows,
      ).toEqual([
        { company_id: request.companyId, project_id: null, task_id: null },
      ]);
      const { reserveCompanyDelegatedAgentRun } =
        await import("../company-agent-launch");
      const promptEntered = Promise.withResolvers<void>();
      const releasePrompt = Promise.withResolvers<void>();

      fake.setSteering(true);
      const scriptedTurn = {
        text:
          "```json maister:output\n" +
          JSON.stringify(operationalSuccessFixture()) +
          "\n```",
        onPrompt: async ({ sessionId }: { sessionId: string }) => {
          promptEntered.resolve();
          await releasePrompt.promise;
          const session = fake.sessions.get(sessionId);

          if (!session)
            throw new Error("The delegated company session was not created");
          fake.sessions.set(sessionId, {
            ...session,
            status: "exited",
            exitCode: 0,
            exitedAt: new Date().toISOString(),
          });

          return { stopReason: "end_turn" as const, meta: null };
        },
      };
      const { prompts } = scriptAgentTurn(fake, scriptedTurn);
      const dispatch = () =>
        reserveCompanyDelegatedAgentRun(database.db, workRequest, hosts);

      await expect(dispatch()).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      const { rows: missingChild } = await database.pool.query(
        "SELECT id FROM runs WHERE id=$1",
        [receipt.work.reservedRunId],
      );

      expect(missingChild).toEqual([]);
      const receivingGrants = await createCompanyGrants(
        database.db,
        administratorId,
        {
          principalKind: "agent",
          principalId: receivingRoleId,
          actions: ["assignments:read"],
          idempotencyKey: randomUUID(),
        },
      );
      const receivingGrant = receivingGrants.page.items.find(
        (grant) => grant.action === "assignments:read",
      )!;
      const first = await dispatch();

      expect(first).toEqual({
        childRunId: receipt.work.reservedRunId,
        status: "Pending",
      });
      await expect(dispatch()).resolves.toEqual(first);
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${appointment.credential.secret}`,
      };
      const hostOverride = vi
        .spyOn(executionHostServices, "createExecutionHosts")
        .mockReturnValue(hosts);

      try {
        const body = {
          target: { agentId: receivingRoleId },
          mode: "run" as const,
          prompt: prepared.objectiveInput.objective,
          assignmentWork: {
            selector: workRequest.selector,
            expectedOutcome: prepared.objectiveInput.expectedOutcome,
          },
        };
        const { dispatchCompanyAssignmentChild } =
          await import("@/lib/specialist-assignments/company-child-dispatch");
        const blocker = await database.pool.connect();

        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT id FROM runs WHERE id=$1 FOR NO KEY UPDATE",
            [appointment.runId],
          );
          const result = dispatchCompanyAssignmentChild(db, {
            companyId: request.companyId,
            parentRunId: appointment.runId,
            tokenId: appointment.credential.tokenId,
            body,
          }).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );

          await new Promise<void>((resolve) => setTimeout(resolve, 150));
          await blocker.query("ROLLBACK");
          expect(await result).toEqual({ value: first });
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
        const replay = await delegateExternalRun(
          new NextRequest("http://localhost/api/v1/ext/runs/delegate", {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          }),
          {},
        );

        expect(replay.status).toBe(202);
        expect(await replay.json()).toEqual(first);
      } finally {
        hostOverride.mockRestore();
      }
      const loadChild = () =>
        db.transaction((tx) =>
          loadCompanyAgentSessionContext(tx, first.childRunId),
        );
      const context = await loadChild();

      expect(buildCompanyAgentPrompt(context)).toContain(
        prepared.objectiveInput.objective,
      );
      expect(buildCompanyAgentPrompt(context)).not.toContain(
        assignmentInput.objectiveInput.objective,
      );
      expect(context.run).toMatchObject({
        agentId: receivingRoleId,
        companyId: request.companyId,
        projectId: null,
        taskId: null,
        parentRunId: appointment.runId,
      });
      await expect(
        db.transaction((tx) =>
          tx.execute(sql`
      INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs,to_jsonb(child)
        || jsonb_build_object('id',${randomUUID()}::text))).*
      FROM runs child WHERE child.id=${first.childRunId}
    `),
        ),
      ).rejects.toMatchObject({
        cause: {
          code: "23514",
          constraint: "runs_company_execution_reference_check",
        },
      });
      const collected = await collectExternalRun(
        new NextRequest("http://localhost/api/v1/ext/runs/collect", {
          method: "POST",
          headers,
          body: JSON.stringify({ childRunId: first.childRunId }),
        }),
        {},
      );

      expect(collected.status).toBe(200);
      expect(await collected.json()).toMatchObject([
        { childRunId: first.childRunId, status: "Pending" },
      ]);
      const prematureRecovery = await reworkExternalRun(
        new NextRequest("http://localhost/api/v1/ext/runs/rework", {
          method: "POST",
          headers,
          body: JSON.stringify({
            childRunId: first.childRunId,
            prompt: prepared.objectiveInput.objective,
            assignmentWork: {
              schemaVersion: 1,
              mode: "recover_interrupted",
              expectedRevision: 2,
              workRevision: 1,
              inputRevision: assignment.inputRevision,
              resultRevision: 1,
              requestKey: "recover-interrupted-observer",
            },
          }),
        }),
        {},
      );

      expect(prematureRecovery.status).toBe(409);
      expect(await prematureRecovery.json()).toMatchObject({
        details: { reason: "work_rework_interruption_unproven" },
      });
      if (stop === "child interruption") {
        fake.setStreamEvents([]);
        fake.setPromptBehavior(async ({ sessionId, envelope }) => {
          const session = fake.sessions.get(sessionId);

          if (!session)
            throw new Error("The appointed child session is missing");
          await fake.publishCanonical(envelope, sessionId, {
            type: "session.crashed",
            sessionId,
            monotonicId: 1,
            exitCode: 1,
            signal: null,
          });
          fake.sessions.set(sessionId, {
            ...session,
            status: "exited",
            exitCode: 1,
            exitedAt: new Date().toISOString(),
          });
          throw new MaisterError(
            "ACP_PROTOCOL",
            "The test adapter exited during its accepted prompt",
          );
        });
        const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

        process.env.MAISTER_MAX_CONCURRENT_AGENTS = "100";
        try {
          await expect(tryStartRun(first.childRunId, { db })).resolves.toEqual({
            started: true,
          });
          await startAgentSession(first.childRunId, {
            db,
            executionHosts: hosts,
          });
          await fake.waitForCanonicalEvents();
          const readChild = (childRunId: string) =>
            collectExternalRun(
              new NextRequest("http://localhost/api/v1/ext/runs/collect", {
                method: "POST",
                headers,
                body: JSON.stringify({ childRunId }),
              }),
              {},
            );
          const [terminal] = await (await readChild(first.childRunId)).json();

          expect(terminal).toMatchObject({
            status: "Failed",
            result: null,
            resultRevision: 1,
            recoveryMode: "recover_interrupted",
            resultFailure: { reason: "result_missing" },
          });
          const recovery = {
            schemaVersion: 1,
            mode: "recover_interrupted",
            expectedRevision: terminal.assignmentWork.revision,
            workRevision: terminal.assignmentWork.workRevision,
            inputRevision: terminal.assignmentWork.inputRevision,
            resultRevision: terminal.resultRevision,
            requestKey: "recover-interrupted-observer",
          };
          const sendRecovery = (prompt: string) =>
            reworkExternalRun(
              new NextRequest("http://localhost/api/v1/ext/runs/rework", {
                method: "POST",
                headers,
                body: JSON.stringify({
                  childRunId: first.childRunId,
                  prompt,
                  assignmentWork: recovery,
                }),
              }),
              {},
            );

          expect((await sendRecovery("Changed objective")).status).toBe(409);
          const approved = await sendRecovery(
            prepared.objectiveInput.objective,
          );

          expect(approved.status, await approved.clone().text()).toBe(202);
          const continuation = await approved.json();

          expect(continuation.childRunId).not.toBe(first.childRunId);
          expect(
            await (
              await sendRecovery(prepared.objectiveInput.objective)
            ).json(),
          ).toEqual(continuation);
          const replacement = await loadCompanyAgentSessionContext(
            db,
            continuation.childRunId,
          );

          expect(buildCompanyAgentPrompt(replacement)).toContain(
            prepared.objectiveInput.input,
          );
          const witness = await database.pool.query(
            `SELECT decisions.interruption_command_id,successor.work_revision,prompt.run_id AS original_run_id
              FROM specialist_work successor
              JOIN specialist_work_decisions decisions ON decisions.work_id=successor.id AND decisions.work_revision=1
              JOIN execution_commands prompt ON prompt.id=decisions.interruption_command_id
              WHERE successor.child_run_id=$1`,
            [continuation.childRunId],
          );

          expect(witness.rows).toEqual([
            {
              interruption_command_id: expect.any(String),
              work_revision: 2,
              original_run_id: first.childRunId,
            },
          ]);
          scriptAgentTurn(fake, scriptedTurn);
          releasePrompt.resolve();
          expect(
            await tryStartRun(continuation.childRunId, { db }),
          ).toMatchObject({ started: true });
          await startAgentSession(continuation.childRunId, {
            db,
            executionHosts: hosts,
          });
          await fake.waitForCanonicalEvents();
          expect(
            await (await readChild(continuation.childRunId)).json(),
          ).toMatchObject([{ status: "Done", resultStatus: "valid" }]);

          return;
        } finally {
          if (previousCap === undefined)
            delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
          else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
        }
      }
      const captureChildInput = () =>
        captureNativeChildInput(
          db,
          { kind: "token", tokenId: appointment.credential.tokenId },
          { sourceRunId: appointment.runId, childRunId: first.childRunId },
        );

      await expect(captureChildInput()).resolves.toBeUndefined();
      const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

      process.env.MAISTER_MAX_CONCURRENT_AGENTS = "100";
      try {
        await database.pool.query(
          "INSERT INTO run_cost_rollups(run_id,input_tokens) VALUES($1,$2)",
          [appointment.runId, reviewedTokens],
        );
        await expect(
          tryStartRun(first.childRunId, { db }),
        ).resolves.toMatchObject({ started: false });
        await promoteNextPending({
          db,
          pool: "agent",
          startAgentRun: () => {},
        });
        const [budgetBlocked] = await db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, first.childRunId));

        expect(budgetBlocked?.status).toBe("Pending");
        await database.pool.query(
          "DELETE FROM run_cost_rollups WHERE run_id=$1",
          [appointment.runId],
        );
        const { startTaskLaunchWorker } =
          await import("@/lib/tasks/launch-worker");
        const launch = await import("@/lib/agents/launch");
        const start = vi
          .spyOn(launch, "startAgentSession")
          .mockResolvedValue(undefined);
        const worker = startTaskLaunchWorker({ db });

        try {
          await vi.waitFor(
            () => expect(start).toHaveBeenCalledWith(first.childRunId, { db }),
            {
              timeout: 6_000,
            },
          );
          expect(
            start.mock.calls.filter(([id]) => id === first.childRunId),
          ).toHaveLength(1);
        } finally {
          await worker.stop();
          start.mockRestore();
        }
      } finally {
        if (previousCap === undefined)
          delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
        else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
      }
      const childCredential = await issueCompanyAgentRunToken({
        db,
        runId: first.childRunId,
      });

      await expect(
        verifyToken(childCredential.secret, db),
      ).resolves.toMatchObject({
        boundRunId: first.childRunId,
        companyId: request.companyId,
        projectId: null,
        agentId: receivingRoleId,
        scopes: ["assignments:read"],
      });
      await revoke(receivingGrant);
      await expect(loadChild()).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(dispatch()).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(captureChildInput()).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(
        verifyToken(childCredential.secret, db),
      ).rejects.toMatchObject({ kind: "owner-unavailable" });
      await createCompanyGrants(db, administratorId, {
        principalKind: "agent",
        principalId: receivingRoleId,
        actions: ["assignments:read"],
        idempotencyKey: randomUUID(),
      });
      const childExecution = startAgentSession(first.childRunId, {
        db,
        executionHosts: hosts,
      });
      const messageHost = vi
        .spyOn(executionHostServices, "createExecutionHosts")
        .mockReturnValue(hosts);
      const sendClarification = (
        prompt: string,
        requestKey = "clarify-observation",
      ) =>
        messageExternalRun(
          new NextRequest("http://localhost/api/v1/ext/runs/message", {
            method: "POST",
            headers,
            body: JSON.stringify({
              childRunId: first.childRunId,
              requestKey,
              mode: "steer",
              prompt,
            }),
          }),
          {},
        );

      try {
        await Promise.race([
          promptEntered.promise,
          childExecution.then(() => {
            throw new Error("The child finished before the clarification");
          }),
        ]);
        const clarification =
          "Check whether the retained observation still applies.";
        const firstMessage = await sendClarification(clarification);

        expect(firstMessage.status).toBe(200);
        const receipt = await firstMessage.json();

        expect(receipt).toMatchObject({
          childRunId: first.childRunId,
          messageState: "applied",
          delivery: "steered",
        });
        const replay = await sendClarification(clarification);

        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(receipt);
        const conflict = await sendClarification("Change the same request.");

        expect(conflict.status).toBe(409);
        fake.setSteerBehavior(async () => ({
          refused: "promptRequired",
        }));
        const refusedInput = "This must never become a successor turn.";
        const refused = await sendClarification(
          refusedInput,
          "refused-clarification",
        );
        const refusedReplay = await sendClarification(
          refusedInput,
          "refused-clarification",
        );

        expect(refused.status).toBe(409);
        expect(refusedReplay.status).toBe(409);
        expect(await refused.json()).toMatchObject({
          details: { reason: "delegated_steer_refused" },
        });
        const commands = await database.pool.query(
          "SELECT state FROM execution_commands WHERE run_id=$1 AND kind='session.steer' ORDER BY created_at",
          [first.childRunId],
        );

        expect(commands.rows).toEqual([
          { state: "succeeded" },
          { state: "failed" },
        ]);
        const turns = await database.pool.query(
          "SELECT variant,state FROM agent_turns WHERE run_id=$1 ORDER BY ordinal",
          [first.childRunId],
        );

        expect(turns.rows).toEqual([
          { variant: "initial", state: "dispatched" },
          { variant: "steer", state: "applied" },
          { variant: "steer", state: "superseded" },
        ]);
        const transcript = await database.pool.query(
          "SELECT content FROM run_messages WHERE run_id=$1 AND delivery='steered'",
          [first.childRunId],
        );

        expect(transcript.rows).toEqual([{ content: clarification }]);
      } finally {
        releasePrompt.resolve();
        await childExecution;
        messageHost.mockRestore();
      }
      await fake.waitForCanonicalEvents();

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(prepared.objectiveInput.objective);
      expect(
        prompts[0].split("## Assignment working context", 1)[0],
      ).not.toContain(assignmentInput.objectiveInput.objective);
      expect(prompts[0]).not.toContain(assignmentInput.objectiveInput.input);
      const resultResponse = await collectExternalRun(
        new NextRequest("http://localhost/api/v1/ext/runs/collect", {
          method: "POST",
          headers,
          body: JSON.stringify({ childRunId: first.childRunId }),
        }),
        {},
      );

      expect(resultResponse.status).toBe(200);
      const initialResults: {
        resultRevision: number;
        assignmentWork: {
          id: string;
          revision: number;
          workRevision: number;
          inputRevision: number;
        };
      }[] = await resultResponse.json();

      expect(initialResults).toMatchObject([
        {
          childRunId: first.childRunId,
          status: "Done",
          resultStatus: "valid",
          result: { value: { outcome: "success" } },
        },
      ]);
      const [initialResult] = initialResults;
      const initialWork = initialResult.assignmentWork;
      const executionDecision = () =>
        decideSpecialistWorkExternal(
          new NextRequest(
            `http://localhost/api/v1/ext/specialist-assignments/${assignment.id}/work/${initialWork.id}/decisions`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                decision: "accept",
                expectedRevision: initialWork.revision,
                workRevision: initialWork.workRevision,
                inputRevision: initialWork.inputRevision,
                resultRevision: initialResult.resultRevision,
                reason: "The child returned the requested typed result.",
                idempotencyKey: "coordinator-accept-initial-result",
              }),
            },
          ),
          {
            params: Promise.resolve({
              assignmentId: assignment.id,
              workId: initialWork.id,
            }),
          },
        );

      expect((await executionDecision()).status).toBe(403);
      const [initiatingAccept, professionalAccept] = await Promise.all([
        createCompanyGrants(db, administratorId, {
          principalKind: "user",
          principalId: userId,
          actions: ["assignments:accept"],
          idempotencyKey: randomUUID(),
        }),
        createCompanyGrants(db, administratorId, {
          principalKind: "agent",
          principalId: roleId,
          actions: ["assignments:accept"],
          idempotencyKey: randomUUID(),
        }),
      ]);
      const acceptGrants = [initiatingAccept, professionalAccept].map((grant) =>
        grant.page.items.find(
          (entry) => entry.action === "assignments:accept",
        )!,
      );

      try {
        const decision = await executionDecision();

        expect(decision.status).toBe(200);
        const accepted = await decision.json();

        expect(accepted).toMatchObject({ status: "accepted" });
        const context = await getSpecialistAssignmentTokenContext(
          db,
          appointment.credential.tokenId,
          assignment.id,
        );

        expect(context.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              actor: expect.objectContaining({
                kind: "agent",
                id: roleId,
                runId: appointment.runId,
              }),
              entry: expect.objectContaining({
                acceptedWork: expect.objectContaining({
                  decisionId: accepted.id,
                  childRunId: first.childRunId,
                }),
              }),
            }),
          ]),
        );
      } finally {
        for (const grant of acceptGrants) await revoke(grant);
      }
      expect((await executionDecision()).status).toBe(403);
      await expect(
        getSpecialistAssignment(db, userId, assignment.id),
      ).resolves.toMatchObject({ status: "active" });

      const flowRoleId = "rah:company-child-coordinator";
      const flowRole = await resolveInstalledAgentDefinition(db, {
        agentId: flowRoleId,
        packageInstallId: effective.packageInstallId,
      });
      const flowPin = (
        await database.pool.query<{ id: string; manifest_digest: string }>(
          "SELECT id,manifest_digest FROM flow_revisions WHERE flow_ref_id='rah-company-child' AND resolved_revision=$1",
          [flowRole.resolvedRevision],
        )
      ).rows[0]!;
      const graphRole = await createCompanySpecialistBinding(
        db,
        userId,
        flowRoleId,
        {
          owner: { kind: "company", companyId: request.companyId },
          packageInstallId: flowRole.packageInstallId,
          packageRevision: flowRole.resolvedRevision!,
          definitionSha256: agentDefinitionSha256(flowRole.parsed),
          coordinatorFlowRevisionId: flowPin.id,
          configuration: {},
          runnerId,
          executionPolicy,
          enabled: true,
          grantActions: [
            "knowledge:read",
            "assignments:read",
            "assignments:update",
            "assignments:delegate",
          ],
          idempotencyKey: "cooperation-graph-specialist-v1",
        },
      );

      await createCompanyFlowBinding(db, userId, {
        owner: { kind: "company", companyId: request.companyId },
        specialistBindingId: graphRole.specialist.bindingId,
        specialistRevision: graphRole.specialist.configRevision,
        flowRevisionId: flowPin.id,
        manifestSha256: flowPin.manifest_digest,
        execution: { workspace: "none", completion: "result" },
        enabled: true,
        roleMappings: {},
        idempotencyKey: "cooperation-graph-binding-v1",
      });
      await createCompanyGrants(db, administratorId, {
        principalKind: "agent",
        principalId: flowRoleId,
        actions: ["assignments:read", "assignments:delegate"],
        idempotencyKey: "cooperation-graph-grants-v1",
      });
      const graphObjective =
        "Review the child result against the retained observation";
      const graphHost = vi
        .spyOn(executionHostServices, "createExecutionHosts")
        .mockReturnValue(hosts);

      try {
        const admitGraph = async (logicalWorkId: string) => {
          const current = await getSpecialistAssignment(
            db,
            userId,
            assignment.id,
          );
          const response = await delegateExternalRun(
            new NextRequest("http://localhost/api/v1/ext/runs/delegate", {
              method: "POST",
              headers,
              body: JSON.stringify({
                target: { flowId: "rah-company-child" },
                mode: "run",
                prompt: graphObjective,
                assignmentWork: {
                  selector: {
                    ...workRequest.selector,
                    expectedRevision: current.revision,
                    contextRevision: current.contextRevision,
                    logicalWorkId,
                  },
                  expectedOutcome: "A pinned structured review",
                },
              }),
            }),
            {},
          );

          expect(response.status).toBe(202);

          return (await response.json()) as {
            childRunId: string;
            status: string;
          };
        };
        const graph = await admitGraph("review-child");
        const context = await db.transaction((tx) =>
          loadCompanyFlowSessionContext(tx, graph.childRunId),
        );

        expect(context.run).toMatchObject({
          runKind: "flow",
          projectId: null,
          taskId: null,
          parentRunId: appointment.runId,
        });
        expect(
          context.owner.delegated?.definition.objectiveInput.objective,
        ).toBe(graphObjective);
        const findings = {
          schemaVersion: 1,
          findings: [],
          knowledgeProposals: [],
          selection: [],
        };
        let nestedChildRunId: string | undefined;
        let drivingGraphRunId = graph.childRunId;
        let drivingGraphAssignmentId = assignment.id;
        const graphBearer = (): string => {
          const create = fake
            .callsOf("createSession")
            .filter((call) => call.envelope?.fence.runId === drivingGraphRunId)
            .at(-1)?.envelope?.payload as
            | {
                mcpServers?: { name: string; env?: Record<string, string> }[];
              }
            | undefined;
          const bearer = create?.mcpServers?.find(
            (server) => server.name === "maister",
          )?.env?.MAISTER_PROJECT_TOKEN;

          if (!bearer)
            throw new Error("The company graph node has no facade credential");

          return bearer;
        };
        const graphPrompts: string[] = [];
        const graphTurn = {
          ...scriptedTurn,
          prompts: graphPrompts,
          text: "```json maister:output\n" + JSON.stringify(findings) + "\n```",
          onPrompt: async (prompt: { sessionId: string }) => {
            const bearer = graphBearer();

            if (nestedChildRunId) {
              const collected = await collectExternalRun(
                new NextRequest("http://localhost/api/v1/ext/runs/collect", {
                  method: "POST",
                  headers: { ...headers, Authorization: `Bearer ${bearer}` },
                  body: JSON.stringify({ childRunId: nestedChildRunId }),
                }),
                {},
              );

              expect(collected.status).toBe(200);
              expect(await collected.json()).toMatchObject([
                {
                  childRunId: nestedChildRunId,
                  status: "Done",
                  resultStatus: "valid",
                },
              ]);

              return scriptedTurn.onPrompt(prompt);
            }
            const current = await getSpecialistAssignment(
              db,
              userId,
              drivingGraphAssignmentId,
            );
            const requestBody = {
              target: { agentId: receivingRoleId },
              mode: "run",
              prompt: "Cross-check the bounded graph observation",
              assignmentWork: {
                selector: {
                  ...workRequest.selector,
                  assignmentId: current.id,
                  inputRevision: current.inputRevision,
                  expectedRevision: current.revision,
                  contextRevision: current.contextRevision,
                  logicalWorkId:
                    drivingGraphRunId === graph.childRunId
                      ? "cross-check"
                      : "interrupted-cross-check",
                },
                expectedOutcome: "Independent observation",
              },
            };
            const delegate = () =>
              delegateExternalRun(
                new NextRequest("http://localhost/api/v1/ext/runs/delegate", {
                  method: "POST",
                  headers: { ...headers, Authorization: `Bearer ${bearer}` },
                  body: JSON.stringify(requestBody),
                }),
                {},
              );
            const firstNested = await delegate();

            expect(firstNested.status).toBe(202);
            const receipt = (await firstNested.json()) as {
              childRunId: string;
              status: string;
            };
            const replayNested = await delegate();

            expect(replayNested.status).toBe(202);
            expect(await replayNested.json()).toEqual(receipt);
            const collected = await collectExternalRun(
              new NextRequest("http://localhost/api/v1/ext/runs/collect", {
                method: "POST",
                headers: { ...headers, Authorization: `Bearer ${bearer}` },
                body: JSON.stringify({ childRunId: receipt.childRunId }),
              }),
              {},
            );

            expect(collected.status).toBe(200);
            expect(await collected.json()).toMatchObject([
              { childRunId: receipt.childRunId, status: "Pending" },
            ]);
            nestedChildRunId = receipt.childRunId;

            return scriptedTurn.onPrompt(prompt);
          },
        };

        scriptAgentTurn(fake, graphTurn);
        const smoke = {
          status: "ok" as const,
          reason: null,
          checkedAt: new Date().toISOString(),
          protocolVersion: 1,
        };

        fake.setDiagnostics({
          kind: "ready",
          diagnostics: {
            status: "ready",
            version: "test",
            checkedAt: smoke.checkedAt,
            envRefs: [],
            adapters: [
              {
                id: "claude",
                binary: "test-claude",
                source: "path",
                path: null,
                available: true,
                version: null,
                error: null,
                smoke: {
                  ...smoke,
                  capabilityEnforcement: smoke,
                  readOnlySession: {
                    ...smoke,
                    probeVersion: 2,
                    staleReason: null,
                  },
                },
              },
            ],
          },
        });
        const savedFlowCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
        const savedAgentCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

        process.env.MAISTER_MAX_CONCURRENT_RUNS = "100";
        process.env.MAISTER_MAX_CONCURRENT_AGENTS = "100";
        try {
          await expect(tryStartRun(graph.childRunId, { db })).resolves.toEqual({
            started: true,
          });
          await runFlow(graph.childRunId, { db, executionHosts: hosts });
          await fake.waitForCanonicalEvents();
          expect(nestedChildRunId).toBeDefined();
          expect(
            (
              await db.select().from(runs).where(eq(runs.id, graph.childRunId))
            )[0],
          ).toMatchObject({ status: "WaitingOnChildren" });
          scriptAgentTurn(fake, scriptedTurn);
          expect(await tryStartRun(nestedChildRunId!, { db })).toMatchObject({
            started: true,
          });
          await startAgentSession(nestedChildRunId!, {
            db,
            executionHosts: hosts,
          });
          await fake.waitForCanonicalEvents();
          const [settled] = await db
            .select()
            .from(domainEvents)
            .where(
              and(
                eq(domainEvents.runId, nestedChildRunId!),
                eq(domainEvents.kind, "run.done"),
              ),
            );

          expect(settled).toMatchObject({
            companyId: request.companyId,
            projectId: null,
            payload: { parentRunId: graph.childRunId },
          });
          scriptAgentTurn(fake, graphTurn);
          const wokenRuns: string[] = [];
          const resumeFlow: NonNullable<
            Parameters<typeof runReconcileSweep>[0]
          >["runFlow"] = (runId, options) => {
            wokenRuns.push(runId);

            return runFlow(runId, { ...options, db, executionHosts: hosts });
          };
          const consumer = buildOrchestratorResumeConsumer({
            db,
            resumeFlow,
          });

          await consumer.handle([
            { ...settled, companyId: randomUUID() },
            { ...settled, runId: first.childRunId },
            { ...settled, kind: "run.failed" },
          ]);
          expect(wokenRuns).toEqual([]);
          await db
            .update(runs)
            .set({ startedAt: new Date() })
            .where(eq(runs.id, appointment.runId));
          await db.execute(
            sql`UPDATE node_attempts SET started_at=clock_timestamp()-interval '10 minutes' WHERE run_id=${graph.childRunId}`,
          );
          await runReconcileSweep({
            db,
            executionHosts: hosts,
            runFlow: resumeFlow,
          });

          // The sweep spans every company. Inspect the runs in this delegation
          // tree and distinguish the recovery wake from a later event replay.
          expect(wokenRuns).toEqual([graph.childRunId]);
          const { rows: recovered } = await database.pool.query<{
            id: string;
            status: string;
          }>("SELECT id, status FROM runs WHERE id = ANY($1::text[])", [
            [
              appointment.runId,
              first.childRunId,
              graph.childRunId,
              nestedChildRunId,
            ],
          ]);

          expect(
            Object.fromEntries(recovered.map((row) => [row.id, row.status])),
          ).toEqual({
            [appointment.runId]: "Running",
            [first.childRunId]: "Done",
            [graph.childRunId]: "Done",
            [nestedChildRunId!]: "Done",
          });
          await consumer.handle([settled]);
          expect(wokenRuns).toEqual([graph.childRunId]);
        } finally {
          if (savedFlowCap === undefined)
            delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
          else process.env.MAISTER_MAX_CONCURRENT_RUNS = savedFlowCap;
          if (savedAgentCap === undefined)
            delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
          else process.env.MAISTER_MAX_CONCURRENT_AGENTS = savedAgentCap;
        }

        expect(graphPrompts).toHaveLength(2);
        expect(graphPrompts[0]).toContain(graphObjective);
        expect(graphPrompts[0]).not.toContain(
          assignmentInput.objectiveInput.input,
        );
        expect(nestedChildRunId).toBeDefined();
        const nested = await database.pool.query(
          "SELECT parent_run_id,root_run_id,project_id,task_id FROM runs WHERE id=$1",
          [nestedChildRunId],
        );

        expect(nested.rows).toEqual([
          {
            parent_run_id: graph.childRunId,
            root_run_id: appointment.runId,
            project_id: null,
            task_id: null,
          },
        ]);
        const collectedGraph = await collectExternalRun(
          new NextRequest("http://localhost/api/v1/ext/runs/collect", {
            method: "POST",
            headers,
            body: JSON.stringify({ childRunId: graph.childRunId }),
          }),
          {},
        );

        expect(collectedGraph.status).toBe(200);
        const graphResult: {
          resultRevision: number;
          assignmentWork: {
            id: string;
            revision: number;
            workRevision: number;
            inputRevision: number;
          };
        }[] = await collectedGraph.json();

        expect(graphResult).toMatchObject([
          {
            childRunId: graph.childRunId,
            status: "Done",
            resultStatus: "valid",
            result: { value: findings },
          },
        ]);
        const { assignmentWork: work, resultRevision } = graphResult[0];
        const reworkBody = {
          childRunId: graph.childRunId,
          prompt: "Recheck the conclusion against the retained evidence.",
          assignmentWork: {
            schemaVersion: 1,
            expectedRevision: work.revision,
            workRevision: work.workRevision,
            inputRevision: work.inputRevision,
            resultRevision,
            requestKey: "recheck-collected-conclusion",
          },
        };
        const sendRework = (body: typeof reworkBody) =>
          reworkExternalRun(
            new NextRequest("http://localhost/api/v1/ext/runs/rework", {
              method: "POST",
              headers,
              body: JSON.stringify(body),
            }),
            {},
          );
        const wrongResult = await sendRework({
          ...reworkBody,
          assignmentWork: {
            ...reworkBody.assignmentWork,
            resultRevision: resultRevision + 1,
          },
        });

        expect(wrongResult.status).toBe(409);
        expect(await wrongResult.json()).toMatchObject({
          details: { reason: "work_rework_result_unavailable" },
        });
        await database.pool.query(
          "INSERT INTO run_cost_rollups(run_id,input_tokens) VALUES($1,$2)",
          [appointment.runId, reviewedTokens],
        );
        try {
          const blocked = await sendRework(reworkBody);

          expect(
            blocked.status,
            JSON.stringify(await blocked.clone().json()),
          ).toBe(409);
          expect(await blocked.json()).toMatchObject({
            details: { reason: "assignment_budget_exhausted" },
          });
        } finally {
          await database.pool.query(
            "DELETE FROM run_cost_rollups WHERE run_id=$1",
            [appointment.runId],
          );
        }
        const reworked = await sendRework(reworkBody);

        expect(reworked.status).toBe(202);
        const continuation: { childRunId: string; status: string } =
          await reworked.json();
        const replayed = await sendRework(reworkBody);

        expect(continuation.status).toBe("Pending");
        expect(continuation.childRunId).not.toBe(graph.childRunId);
        expect(replayed.status).toBe(202);
        expect(await replayed.json()).toEqual(continuation);
        const mismatched = await sendRework({
          ...reworkBody,
          prompt: "Change the previous rework request.",
        });

        expect(mismatched.status).toBe(409);
        const retained = await database.pool.query(
          `SELECT id, work_revision, child_run_id, decision_state
        FROM specialist_work WHERE id=$1 ORDER BY work_revision`,
          [work.id],
        );

        expect(retained.rows).toEqual([
          {
            id: work.id,
            work_revision: work.workRevision,
            child_run_id: graph.childRunId,
            decision_state: "rework_requested",
          },
          {
            id: work.id,
            work_revision: work.workRevision + 1,
            child_run_id: continuation.childRunId,
            decision_state: "open",
          },
        ]);
        expect(
          (
            await database.pool.query(
              `SELECT result.validity,result.run_id,result.revision
            FROM specialist_work_decisions decision
            JOIN run_results result ON result.id=decision.result_id
            WHERE decision.work_id=$1 AND decision.work_revision=$2`,
              [work.id, work.workRevision],
            )
          ).rows,
        ).toEqual([
          {
            validity: "valid",
            run_id: graph.childRunId,
            revision: resultRevision,
          },
        ]);
        await expect(
          database.pool.query(
            "UPDATE specialist_work_decisions SET reason='overwrite' WHERE work_id=$1",
            [work.id],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "specialist_work_decision_immutable",
        });
        const continuationPrompt = scriptAgentTurn(fake, {
          ...scriptedTurn,
          text:
            "```json maister:output\n" +
            JSON.stringify({
              ...findings,
              findings: [
                {
                  id: "observation-gap",
                  assertion:
                    "The applicability of the original observation is unresolved.",
                  basis: "unknown",
                  supporting: [],
                  contradicting: [],
                  missingEvidence: [
                    {
                      state: "absent",
                      reason: "No fresh observation was supplied.",
                    },
                  ],
                  limitations: ["No stand was inspected."],
                  openQuestions: ["Does the original observation still apply?"],
                  sourceFindings: [],
                },
              ],
            }) +
            "\n```",
        });

        process.env.MAISTER_MAX_CONCURRENT_RUNS = "100";
        try {
          await expect(
            tryStartRun(continuation.childRunId, { db }),
          ).resolves.toEqual({
            started: true,
          });
          await runFlow(continuation.childRunId, {
            db,
            executionHosts: hosts,
          });
          await fake.waitForCanonicalEvents();
        } finally {
          if (savedFlowCap === undefined)
            delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
          else process.env.MAISTER_MAX_CONCURRENT_RUNS = savedFlowCap;
        }
        expect(continuationPrompt.prompts).toHaveLength(1);
        expect(continuationPrompt.prompts[0]).toContain(reworkBody.prompt);
        const readContinuation = async () =>
          (
            await listSpecialistAssignmentWork(db, userId, assignment.id, {})
          ).items.find((item) => item.childRunId === continuation.childRunId);

        await expect(readContinuation()).resolves.toMatchObject({
          resultRevision: null,
          canAccept: false,
          canReject: false,
        });
        const continuationResult = await collectExternalRun(
          new NextRequest("http://localhost/api/v1/ext/runs/collect", {
            method: "POST",
            headers,
            body: JSON.stringify({ childRunId: continuation.childRunId }),
          }),
          {},
        );

        expect(continuationResult.status).toBe(200);
        const completed: {
          resultRevision: number;
          assignmentWork: {
            id: string;
            revision: number;
            workRevision: number;
            inputRevision: number;
          };
        }[] = await continuationResult.json();

        expect(completed).toMatchObject([
          {
            childRunId: continuation.childRunId,
            status: "Done",
            resultStatus: "valid",
            assignmentWork: {
              id: work.id,
              workRevision: work.workRevision + 1,
            },
          },
        ]);
        const [ready] = completed;

        await expect(readContinuation()).resolves.toMatchObject({
          state: "result_ready",
          resultRevision: ready.resultRevision,
          canAccept: true,
          canReject: true,
        });
        const acceptBody = {
          decision: "accept",
          expectedRevision: ready.assignmentWork.revision,
          inputRevision: ready.assignmentWork.inputRevision,
          workRevision: ready.assignmentWork.workRevision,
          resultRevision: ready.resultRevision,
          reason: "The continued result addresses the requested observation.",
          idempotencyKey: "accept-continued-observation",
        };
        const decide = (body: typeof acceptBody) =>
          decideSpecialistWork(
            new NextRequest(
              `http://localhost/api/specialist-assignments/${assignment.id}/work/${work.id}/decisions`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              },
            ),
            {
              params: Promise.resolve({
                assignmentId: assignment.id,
                workId: work.id,
              }),
            },
          );

        browserSession.user = await requireActiveUserById(userId);
        try {
          expect((await decide(acceptBody)).status).toBe(403);
        } finally {
          browserSession.user = null;
        }
        const grants = await createCompanyGrants(db, administratorId, {
          principalKind: "user",
          principalId: userId,
          actions: ["assignments:accept"],
          idempotencyKey: randomUUID(),
        });
        const acceptGrant = grants.page.items.find(
          (entry) => entry.action === "assignments:accept",
        )!;

        browserSession.user = await requireActiveUserById(userId);
        try {
          const mismatched = await decide({
            ...acceptBody,
            resultRevision: acceptBody.resultRevision + 1,
          });

          expect(mismatched.status).toBe(409);
          const accepted = await decide(acceptBody);

          expect(accepted.status).toBe(200);
          const receipt: { id: string } = await accepted.json();
          const repeated = await decide(acceptBody);

          expect(repeated.status).toBe(200);
          expect(await repeated.json()).toMatchObject({
            ...receipt,
            status: "accepted",
            duplicate: true,
          });
          await expect(
            getSpecialistAssignment(db, userId, assignment.id),
          ).resolves.toMatchObject({ status: "active" });
          const acceptedContext = await getSpecialistAssignmentTokenContext(
            db,
            appointment.credential.tokenId,
            assignment.id,
          );

          expect(acceptedContext.entries).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                actor: expect.objectContaining({ kind: "user", id: userId }),
                entry: expect.objectContaining({
                  kind: "accepted",
                  state: "accepted",
                  acceptedWork: expect.objectContaining({
                    decisionId: receipt.id,
                    childRunId: continuation.childRunId,
                    resultRevision: ready.resultRevision,
                    sourceFindings: [
                      {
                        childRunId: continuation.childRunId,
                        resultRevision: ready.resultRevision,
                        findingId: "observation-gap",
                      },
                    ],
                  }),
                }),
              }),
            ]),
          );
        } finally {
          browserSession.user = null;
          await revoke(acceptGrant);
        }
        const parked = await admitGraph("interrupted-review");

        parkedGraphRunId = parked.childRunId;
        drivingGraphRunId = parkedGraphRunId;
        nestedChildRunId = undefined;
        scriptAgentTurn(fake, graphTurn);
        process.env.MAISTER_MAX_CONCURRENT_RUNS = "100";
        try {
          expect(await tryStartRun(parkedGraphRunId, { db })).toEqual({
            started: true,
          });
          await runFlow(parkedGraphRunId, { db, executionHosts: hosts });
          await fake.waitForCanonicalEvents();
        } finally {
          if (savedFlowCap === undefined)
            delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
          else process.env.MAISTER_MAX_CONCURRENT_RUNS = savedFlowCap;
        }
        const [parkedGraph] = await db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, parkedGraphRunId));

        expect(parkedGraph?.status).toBe("WaitingOnChildren");
        expect(nestedChildRunId).toBeDefined();
        pendingNestedRunId = nestedChildRunId!;
        if (stop === "parent interruption")
          pendingGraphRunId = (await admitGraph("never-started-review"))
            .childRunId;

        qualifyParkedRootBudget = async () => {
          const { expectedResult: _expectedResult, ...objective } =
            assignmentInput.objectiveInput;
          const rootCoordinator = await reserveCompanyManualAssignment(
            db,
            userId,
            {
              ...objective,
              owner: graphRole.specialist.owner,
              specialistBindingId: graphRole.specialist.bindingId,
              idempotencyKey: randomUUID(),
            },
            hosts,
          );
          const rootRunId = rootCoordinator.assignment.runIds[0]!;

          drivingGraphRunId = rootRunId;
          drivingGraphAssignmentId = rootCoordinator.assignment.id;
          nestedChildRunId = undefined;
          scriptAgentTurn(fake, graphTurn);
          const hostOverride = vi
            .spyOn(executionHostServices, "createExecutionHosts")
            .mockReturnValue(hosts);

          process.env.MAISTER_MAX_CONCURRENT_RUNS = "100";
          try {
            expect(await tryStartRun(rootRunId, { db })).toEqual({
              started: true,
            });
            await runFlow(rootRunId, { db, executionHosts: hosts });
            await fake.waitForCanonicalEvents();
          } finally {
            hostOverride.mockRestore();
            if (savedFlowCap === undefined)
              delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
            else process.env.MAISTER_MAX_CONCURRENT_RUNS = savedFlowCap;
          }
          expect(nestedChildRunId).toBeDefined();
          const before = await database.pool.query(
            "SELECT status,current_step_id FROM runs WHERE id=$1",
            [rootRunId],
          );

          expect(before.rows).toEqual([
            {
              status: "WaitingOnChildren",
              current_step_id: expect.any(String),
            },
          ]);
          await recordAssignmentBudgetUsage(db, rootRunId, reviewedTokens);
          await reconcileRunCostRollups(rootRunId, { client: db });
          await database.pool.query(
            "UPDATE runs SET failed_child_wake_at=clock_timestamp() WHERE id=$1",
            [rootRunId],
          );
          const resumeFlow = vi.fn();

          expect(
            await wakeParkedCoordinator({
              db,
              parentRunId: rootRunId,
              cause: "settled_child",
              resumeFlow,
            }),
          ).toMatchObject({ kind: "skipped", reason: "assignment-budget" });
          expect(resumeFlow).not.toHaveBeenCalled();
          await runSweepTick({ db, executionHosts: hosts });
          await runSweepTick({ db, executionHosts: hosts });
          const outcomes = await database.pool.query(
            `SELECT run.id,run.status,event.payload->'cause'->>'code' AS cause_code
             FROM runs run JOIN domain_events event ON event.run_id=run.id
             WHERE run.id=ANY($1::text[]) AND event.kind IN ('run.failed','run.abandoned')
             ORDER BY event.id`,
            [[nestedChildRunId, rootRunId]],
          );

          expect(outcomes.rows).toEqual([
            { id: nestedChildRunId, status: "Abandoned", cause_code: null },
            { id: rootRunId, status: "Failed", cause_code: "BUDGET_EXCEEDED" },
          ]);
          const ledger = await database.pool.query(
            `SELECT node.status,node.error_code,run.current_step_id,run.failed_child_wake_at
             FROM node_attempts node JOIN runs run ON run.id=node.run_id
             WHERE node.run_id=$1`,
            [rootRunId],
          );

          expect(ledger.rows).toEqual([
            {
              status: "Failed",
              error_code: "BUDGET_EXCEEDED",
              current_step_id: null,
              failed_child_wake_at: null,
            },
          ]);
        };
      } finally {
        graphHost.mockRestore();
      }
    } finally {
      await revoke(professional);
    }

    await expect(retain()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      (
        await database.pool.query(
          "SELECT id FROM specialist_work WHERE assignment_id=$1 AND logical_work_id='inspect'",
          [assignment.id],
        )
      ).rows,
    ).toEqual([{ id: receipt.work.id }]);
    if (stop === "parent interruption") {
      const prepared = await prepareAgentRunFinalization(
        appointment.runId,
        "Crashed",
        { db, executionHosts: hosts, reason: "agent-session-gone" },
      );
      const terminal = await db.transaction((tx) => prepared.apply(tx));

      expect(terminal.finalized).toBe(true);
      await expect(
        tryStartRun(pendingNestedRunId!, { db }),
      ).resolves.toMatchObject({
        started: false,
      });
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE runs SET failed_child_wake_at=clock_timestamp() WHERE id=${parkedGraphRunId}`,
        );
      });
      const resumeFlow = vi.fn();
      const wake = await wakeParkedCoordinator({
        db,
        parentRunId: parkedGraphRunId!,
        cause: "settled_child",
        allowFailedOrchestratorChild: true,
        resumeFlow,
      });

      expect(wake.kind).toBe("skipped");
      expect(resumeFlow).not.toHaveBeenCalled();
      await prepared.afterCommit(terminal);
      const terminalEvents = () =>
        database.pool.query<{
          run_id: string;
          company_id: string;
          status: string;
        }>(
          `SELECT event.run_id, event.company_id, run.status
           FROM domain_events event JOIN runs run ON run.id=event.run_id
           WHERE event.kind IN ('run.abandoned','run.crashed') AND event.run_id=ANY($1::text[])
           ORDER BY event.id`,
          [[pendingNestedRunId, parkedGraphRunId, pendingGraphRunId]],
        );
      await runReconcileSweep({ db, executionHosts: hosts });
      const { rows: events } = await terminalEvents();
      const [queuedOrphan] = await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, pendingGraphRunId!));

      expect(queuedOrphan).toEqual({ status: "Abandoned" });
      expect(
        events.filter((event) => event.run_id !== pendingGraphRunId),
      ).toEqual([
        {
          run_id: pendingNestedRunId,
          company_id: request.companyId,
          status: "Abandoned",
        },
        {
          run_id: parkedGraphRunId,
          company_id: request.companyId,
          status: "Crashed",
        },
      ]);

      await runReconcileSweep({ db, executionHosts: hosts });
      expect((await terminalEvents()).rows).toEqual(events);

      return;
    }
    await db.transaction((tx) =>
      mintAssignment(tx, {
        runId: appointment.runId,
        hostId,
        reason: "launch",
      }),
    );
    await recordAssignmentBudgetUsage(db, appointment.runId, reviewedTokens);
    await runSweepTick({ db, executionHosts: hosts });
    const [budgetRoot] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, appointment.runId));

    expect(budgetRoot).toEqual({ status: "Failed" });
    const { rows: abandoned } = await database.pool.query(
      `SELECT event.run_id, event.company_id, run.status
     FROM domain_events event JOIN runs run ON run.id=event.run_id
     WHERE event.kind='run.abandoned' AND event.run_id=ANY($1::text[])
     ORDER BY event.id`,
      [[pendingNestedRunId, parkedGraphRunId]],
    );

    expect(abandoned).toEqual(
      [pendingNestedRunId, parkedGraphRunId].map((id) => ({
        run_id: id,
        company_id: request.companyId,
        status: "Abandoned",
      })),
    );
    expect(
      (
        await database.pool.query(
          "SELECT status,operational_terminal->>'status' AS terminal FROM runs WHERE root_run_id=$1 AND agent_kind='operational' ORDER BY status",
          [appointment.runId],
        )
      ).rows,
    ).toEqual([
      { status: "Abandoned", terminal: "Abandoned" },
      { status: "Done", terminal: "Done" },
      { status: "Done", terminal: "Done" },
    ]);
    expect(
      (
        await database.pool.query(
          "SELECT decision,count(*)::int AS count FROM specialist_work_decisions decision JOIN specialist_work work ON work.id=decision.work_id AND work.work_revision=decision.work_revision WHERE work.assignment_id=$1 GROUP BY decision ORDER BY decision",
          [assignment.id],
        )
      ).rows,
    ).toEqual([
      { decision: "accept", count: 2 },
      { decision: "rework", count: 1 },
    ]);
    await qualifyParkedRootBudget!();
  } finally {
    await revoke(initiating);
  }
}

describe("context disclosure and retained company execution reads", () => {
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
      const inspection = await inspectExternal(
        appointment.assignmentId,
        credential.secret,
      );

      expect(inspection.status).toBe(200);
      expect(inspection.headers.get("cache-control")).toBe("private, no-store");
      expect(await inspection.json()).toMatchObject({
        id: appointment.assignmentId,
        revision: 4,
        inputRevision: 1,
        contextRevision: 1,
        runIds: [appointment.runId],
      });
      expect(
        (await inspectExternal(foreign.assignmentId, credential.secret)).status,
      ).toBe(404);
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
      expect(
        (await inspectExternal(appointment.assignmentId, credential.secret))
          .status,
      ).toBe(401);
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
            headers: {
              Authorization: `Bearer ${appointment.credential.secret}`,
            },
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
      const inspection = await inspectExternal(
        appointment.assignmentId,
        appointment.credential.secret,
      );

      expect(inspection.status).toBe(200);
      expect(await inspection.json()).toMatchObject({
        id: appointment.assignmentId,
        contextRevision: 1,
      });
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
      const deniedInspection = await inspectExternal(
        appointment.assignmentId,
        appointment.credential.secret,
      );

      expect(deniedInspection.status).toBe(404);
      expect(JSON.stringify(await deniedInspection.json())).not.toContain(
        "inferred diagnosis",
      );
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

  it("IT-CBS-02 reads retained company execution content under current explicit reader authority independently of specialist availability", async () => {
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
    await expect(
      authorizePeekRun(administratorId, runId),
    ).rejects.toMatchObject(unavailable);
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
      new NextRequest(
        `http://localhost/api/runs/${runId}/stream?replay=false`,
        {
          signal: AbortSignal.timeout(10000),
        },
      ),
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

  it("IT-CBS-02 pages company history under current source authority before LIMIT and binds the existing cursor to its reader", async () => {
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
      getCompanyAgentRunHistory(database.db, userId, {
        agentId: "absent:role",
      }),
    ).resolves.toMatchObject({ items: [], nextCursor: null });
    browserSession.user = await requireActiveUserById(userId);
    const response = await companyHistoryGet(
      new NextRequest(
        `http://localhost/api/specialists/${agentId}/runs?limit=2`,
      ),
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
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(
      {
        components: document.components,
        ...document.paths["/api/specialists/{specialistId}/runs"].get.responses[
          "200"
        ].content["application/json"].schema,
      },
    );

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

  it("IT-CBS-02 preserves nested assignment source restrictions and lets the source project be deleted without Brain blocking it", async () => {
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
      reason:
        "Retain the limitation with its original professional attribution",
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
        await searchKnowledge(database.db, nativePrincipal, {
          q: "",
          limit: 10,
        })
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

    expect(
      queryPlan["Execution Time"] + queryPlan["Planning Time"],
    ).toBeLessThan(500);
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
      (
        await searchKnowledge(database.db, nativePrincipal, {
          q: "",
          limit: 10,
        })
      ).items,
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
      (
        await searchKnowledge(database.db, nativePrincipal, {
          q: "",
          limit: 10,
        })
      ).items,
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
    expect(
      await createKnowledgeProposal(database.db, correction),
    ).toMatchObject({
      status: "pending",
    });
    expect(
      (await getKnowledgeRecord(database.db, humanPrincipal, { recordId }))
        .revision,
    ).toBe(1);
  });

  it("IT-CBS-02 resolves and inspects an owned company plain directory without a project and rejects retargeted baseline paths", async () => {
    const { runId } = await reserveCompanyFixtureRun();
    const [run] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, runId));
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
      database.db as unknown as import("@/lib/execution-host/db").Db,
      context.cwd,
      await captureOperationalBaseline(
        database.db as unknown as import("@/lib/execution-host/db").Db,
        context.cwd,
        "plain_directory",
      ),
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
      await inspectOperationalWorkspace(
        database.db,
        retained,
        "final_verification",
      ),
    ).toMatchObject({ verdict: "clean" });
    await writeFile(join(context.cwd, "observations.txt"), "Changed source.");
    expect(
      await inspectOperationalWorkspace(
        database.db,
        retained,
        "final_verification",
      ),
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
      operationalWorkspace(database.db, {
        ...run,
        agentWorkspace: "repo_read",
      }),
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
    database.db as unknown as import("@/lib/execution-host/db").Db,
    context.cwd,
    await captureOperationalBaseline(
      database.db as unknown as import("@/lib/execution-host/db").Db,
      context.cwd,
      "plain_directory",
    ),
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

describe("company terminal evidence and project child dispatch", () => {
  it("IT-CBS-02 atomically finalizes company result evidence, revokes credentials and releases plain materialization without completing the assignment", async () => {
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
      (
        await database.pool.query("SELECT status FROM runs WHERE id=$1", [
          runId,
        ])
      ).rows[0].status,
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

  it("IT-CBS-02 refuses company completion without its required result and retains failed source bytes for evidence recovery", async () => {
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

  it("IT-CBS-02 governs company operational acknowledgement and exhausted cleanup rearm through current grants and existing receipts", async () => {
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
            headers: {
              "content-type": "application/json",
              Origin: "http://localhost",
              "Sec-Fetch-Site": "same-origin",
            },
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
        {
          company_id: request.companyId,
          project_id: null,
          actor_id: operatorId,
        },
      ]);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await database.pool.query(
          "UPDATE runs SET operational_cleanup=jsonb_set(operational_cleanup,'{dueAt}',to_jsonb((now()-interval '1 second')::text)) WHERE id=$1",
          [runId],
        );
        expect(await disposeOperationalRun(runId, { db })).toBe("deferred");
      }
      const [exhausted] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, runId));

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
              headers: {
                "content-type": "application/json",
                Origin: "http://localhost",
                "Sec-Fetch-Site": "same-origin",
              },
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

  it("IT-CBS-02 quarantines a company specialist source violation and preserves failed bytes instead of accepting a valid-looking result", async () => {
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

  it("IT-CBC-01 IT-CBC-04 dispatches one exact project child and retains a rejected continuation", async () => {
    const db: Db = database.db;
    const repo = await initRepo(join(root, "project-child-rework-repo"));
    const project = await seedProjectRow(database.db, { repoPath: repo });
    const roleId = "rah:project-dispatch-observer";
    const runnerId = randomUUID();
    const parentRunId = randomUUID();

    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'owner')",
      [randomUUID(), project.id, userId],
    );
    await attachPackage({
      projectId: project.id,
      projectSlug: project.slug,
      packageInstallId: assignmentInput.standingDefinition.packageInstallId,
      db,
    });
    await db.insert(platformAcpRunners).values({
      id: runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "native-project-dispatch-fixture",
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
    const binding = await attachAgent(
      { projectId: project.id, agentId: roleId, runnerOverrideId: runnerId },
      db,
    );

    await updateAgentLink(
      {
        projectId: project.id,
        agentId: roleId,
        patch: { canReadBrain: true },
      },
      db,
    );
    const effective = await resolveInstalledAgentDefinition(database.db, {
      agentId: roleId,
      packageInstallId: assignmentInput.standingDefinition.packageInstallId,
    });
    const assignment = await createSpecialistAssignment(database.db, userId, {
      ...assignmentInput,
      owner: { kind: "project", projectId: project.id },
      specialistBindingId: binding.linkId,
      responsibleAgentId: roleId,
      standingDefinition: {
        ...assignmentInput.standingDefinition,
        agentId: roleId,
        definition: effective.parsed,
        definitionSha256: agentDefinitionSha256(effective.parsed),
      },
    });

    await database.pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,agent_id,source_agent_id,created_by_user_id,agent_workspace,knowledge_access,agent_activity_snapshot,launched_at,activity_sort_at,activity_timestamp_provenance) VALUES($1,$2,'agent','Running','agent','manual',$3,$3,$4,'none',$5::jsonb,$6::jsonb,now(),now(),'launch')",
      [
        parentRunId,
        project.id,
        roleId,
        userId,
        JSON.stringify({
          schemaVersion: 1,
          state: "complete",
          generation: 1,
          restrictions: [],
        }),
        JSON.stringify(buildAgentActivitySnapshot(roleId, effective)),
      ],
    );
    await database.db.transaction((tx) =>
      activateInitialSpecialistAssignmentRunInTransaction(
        tx,
        userId,
        assignment.id,
        {
          expectedRevision: 1,
          inputRevision: 1,
          runId: parentRunId,
          role: "specialist",
        },
      ),
    );
    const head = await getSpecialistAssignment(
      database.db,
      userId,
      assignment.id,
    );
    const credential = await issueAgentRunToken({
      db,
      projectId: project.id,
      runId: parentRunId,
      agentId: roleId,
    });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential.secret}`,
    };

    await expect(
      db.transaction((tx) => admitDelegatedChild(tx, { parentRunId })),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "assignment_work_required" },
    });
    const { fake, hosts } = await fakeExecutionHosts(db);
    const savedAgentCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "1";
    try {
      const request = {
        projectId: project.id,
        parentRunId,
        tokenId: credential.tokenId,
        body: {
          target: { agentId: roleId },
          mode: "run" as const,
          prompt: "Inspect the recorded health observation",
          assignmentWork: {
            selector: {
              schemaVersion: 1 as const,
              assignmentId: assignment.id,
              expectedRevision: head.revision,
              inputRevision: head.inputRevision,
              contextRevision: head.contextRevision,
              logicalWorkId: "read-observation",
              workRevision: 1,
            },
            expectedOutcome: "A typed health observation with its limitations",
          },
        },
      };
      const [first, transportReplay] = await Promise.all([
        dispatchProjectAssignmentChild(db, request),
        delegateExternalRun(
          new NextRequest("http://localhost/api/v1/ext/runs/delegate", {
            method: "POST",
            headers,
            body: JSON.stringify(request.body),
          }),
          {},
        ),
      ]);

      expect(transportReplay.status).toBe(202);
      const replay: { childRunId: string } = await transportReplay.json();

      expect(first).toEqual({
        childRunId: replay.childRunId,
        status: "Pending",
      });
      const legacyRefused = await delegateExternalRun(
        new NextRequest("http://localhost/api/v1/ext/runs/delegate", {
          method: "POST",
          headers,
          body: JSON.stringify({
            target: request.body.target,
            mode: "run",
            prompt:
              "Attempt legacy delegation without a native appointment selector.",
          }),
        }),
        {},
      );

      expect(legacyRefused.status).toBe(403);
      const rows = (
        await database.pool.query(
          `SELECT child.id, child.task_id, child.parent_run_id, work.child_run_id, link.role,
              child.knowledge_access->'restrictions' AS restrictions
       FROM runs child JOIN specialist_run_links link ON link.run_id=child.id
       JOIN specialist_work work ON work.id=link.work_id AND work.work_revision=link.work_revision
       WHERE child.parent_run_id=$1`,
          [parentRunId],
        )
      ).rows;

      expect(rows).toEqual([
        {
          id: first.childRunId,
          task_id: null,
          parent_run_id: parentRunId,
          child_run_id: first.childRunId,
          role: "child",
          restrictions: expect.arrayContaining([
            expect.objectContaining({
              kind: "assignment_input",
              assignmentId: assignment.id,
              inputRevision: head.inputRevision,
            }),
          ]),
        },
      ]);
      const collect = (tokenId: string) =>
        collectChild(db, {
          parentRunId,
          projectId: project.id,
          childRunId: first.childRunId,
          recipient: { kind: "token", tokenId },
        });

      await expect(collect(credential.tokenId)).resolves.toMatchObject({
        result: {
          childRunId: first.childRunId,
          status: "Pending",
          resultStatus: "pending",
        },
      });
      const personal = await issueUserAccessToken(
        {
          ownerUserId: userId,
          name: "assignment-child-non-origin",
          scopes: ["knowledge:read", "assignments:read"],
        },
        db,
      );

      await expect(collect(personal.tokenId)).rejects.toMatchObject({
        details: { reason: "delegated_work_origin_required" },
      });
      await expect(
        dispatchProjectAssignmentChild(db, {
          ...request,
          body: { ...request.body, prompt: "Different objective" },
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "specialist_intake_payload_conflict" },
      });

      await database.pool.query(
        "UPDATE runs SET status='Running' WHERE id=$1",
        [first.childRunId],
      );
      const current = await getSpecialistAssignment(
        database.db,
        userId,
        assignment.id,
      );
      const childCredential = await issueAgentRunToken({
        db,
        projectId: project.id,
        runId: first.childRunId,
        agentId: roleId,
      });
      const nested = await dispatchProjectAssignmentChild(db, {
        ...request,
        parentRunId: first.childRunId,
        tokenId: childCredential.tokenId,
        body: {
          ...request.body,
          assignmentWork: {
            ...request.body.assignmentWork,
            selector: {
              ...request.body.assignmentWork.selector,
              expectedRevision: current.revision,
              logicalWorkId: "cross-check-observation",
            },
          },
        },
      });

      await expect(
        collectChild(db, {
          parentRunId: first.childRunId,
          projectId: project.id,
          childRunId: nested.childRunId,
          recipient: { kind: "token", tokenId: childCredential.tokenId },
        }),
      ).resolves.toMatchObject({
        result: { status: "Pending", resultStatus: "pending" },
      });
      const { rows: lineage } = await database.pool.query(
        "SELECT parent_run_id, root_run_id FROM runs WHERE id=$1",
        [nested.childRunId],
      );

      expect(lineage).toEqual([
        { parent_run_id: first.childRunId, root_run_id: parentRunId },
      ]);

      const enteredPrompt = Promise.withResolvers<void>();
      const releasePrompt = Promise.withResolvers<void>();

      fake.setSteering(true);
      const scripted = scriptAgentTurn(fake, {
        text:
          "```json maister:output\n" +
          JSON.stringify(operationalSuccessFixture()) +
          "\n```",
        onPrompt: async ({ sessionId }) => {
          enteredPrompt.resolve();
          await releasePrompt.promise;
          const session = fake.sessions.get(sessionId);

          if (!session) throw new Error("The project child session is missing");
          fake.sessions.set(sessionId, {
            ...session,
            status: "exited",
            exitCode: 0,
            exitedAt: new Date().toISOString(),
          });

          return { stopReason: "end_turn", meta: null };
        },
      });
      const execution = startAgentSession(first.childRunId, {
        db,
        executionHosts: hosts,
      });
      const messageHost = vi
        .spyOn(executionHostServices, "createExecutionHosts")
        .mockReturnValue(hosts);

      try {
        await Promise.race([
          enteredPrompt.promise,
          execution.then(() => {
            throw new Error("The project child finished before clarification");
          }),
        ]);
        const clarification = await messageExternalRun(
          new NextRequest("http://localhost/api/v1/ext/runs/message", {
            method: "POST",
            headers,
            body: JSON.stringify({
              childRunId: first.childRunId,
              mode: "steer",
              requestKey: "project-clarification",
              prompt: "Include the observation date in the result.",
            }),
          }),
          {},
        );

        expect(clarification.status).toBe(200);
        expect(await clarification.json()).toMatchObject({
          childRunId: first.childRunId,
          messageState: "applied",
        });
      } finally {
        releasePrompt.resolve();
        await execution;
        messageHost.mockRestore();
      }
      await fake.waitForCanonicalEvents();
      const collected = await collectExternalRun(
        new NextRequest("http://localhost/api/v1/ext/runs/collect", {
          method: "POST",
          headers,
          body: JSON.stringify({ childRunId: first.childRunId }),
        }),
        {},
      );

      expect(collected.status).toBe(200);
      const [exact]: {
        assignmentWork: {
          id: string;
          revision: number;
          workRevision: number;
          inputRevision: number;
        };
        resultRevision: number;
        resultStatus: string;
      }[] = await collected.json();

      expect(exact.resultStatus).toBe("valid");
      const reworkBody = {
        childRunId: first.childRunId,
        prompt: "Recheck the project observation.",
        assignmentWork: {
          schemaVersion: 1,
          expectedRevision: exact.assignmentWork.revision,
          workRevision: exact.assignmentWork.workRevision,
          inputRevision: exact.assignmentWork.inputRevision,
          resultRevision: exact.resultRevision,
          requestKey: "project-observation-recheck",
        },
      };
      const requestRework = () =>
        reworkExternalRun(
          new NextRequest("http://localhost/api/v1/ext/runs/rework", {
            method: "POST",
            headers,
            body: JSON.stringify(reworkBody),
          }),
          {},
        );
      const continued = await requestRework();

      expect(continued.status).toBe(202);
      const continuation: { childRunId: string; status: string } =
        await continued.json();
      const repeated = await requestRework();

      expect(repeated.status).toBe(202);
      expect(await repeated.json()).toEqual(continuation);
      const { rows: continuedWork } = await database.pool.query(
        `SELECT work.id,work.work_revision,run.project_id,run.task_id,run.parent_run_id
      FROM specialist_work work JOIN runs run ON run.id=work.child_run_id
      WHERE run.id=$1`,
        [continuation.childRunId],
      );

      expect(continuedWork).toEqual([
        {
          id: exact.assignmentWork.id,
          work_revision: exact.assignmentWork.workRevision + 1,
          project_id: project.id,
          task_id: null,
          parent_run_id: parentRunId,
        },
      ]);
      process.env.MAISTER_MAX_CONCURRENT_AGENTS = "100";
      await expect(
        tryStartRun(continuation.childRunId, { db }),
      ).resolves.toEqual({ started: true });
      await startAgentSession(continuation.childRunId, {
        db,
        executionHosts: hosts,
      });
      await fake.waitForCanonicalEvents();

      expect(scripted.prompts).toHaveLength(2);
      expect(scripted.prompts[1]).toContain(reworkBody.prompt);
      const continuationResponse = await collectExternalRun(
        new NextRequest("http://localhost/api/v1/ext/runs/collect", {
          method: "POST",
          headers,
          body: JSON.stringify({ childRunId: continuation.childRunId }),
        }),
        {},
      );

      expect(continuationResponse.status).toBe(200);
      const [continuationProjection]: (typeof exact)[] =
        await continuationResponse.json();

      expect(continuationProjection).toMatchObject({
        status: "Done",
        resultStatus: "valid",
        assignmentWork: {
          id: exact.assignmentWork.id,
          workRevision: exact.assignmentWork.workRevision + 1,
        },
      });
      const review = {
        expectedRevision: continuationProjection.assignmentWork.revision,
        workRevision: continuationProjection.assignmentWork.workRevision,
        inputRevision: continuationProjection.assignmentWork.inputRevision,
        resultRevision: continuationProjection.resultRevision,
        decision: "reject",
        reason:
          "The continued result does not resolve the disputed observation.",
        idempotencyKey: "reject-project-observation",
      };
      const decide = (value: typeof review) =>
        decideSpecialistWork(
          new NextRequest(
            `http://localhost/api/specialist-assignments/${assignment.id}/work/${exact.assignmentWork.id}/decisions`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(value),
            },
          ),
          {
            params: Promise.resolve({
              assignmentId: assignment.id,
              workId: exact.assignmentWork.id,
            }),
          },
        );

      browserSession.user = await requireActiveUserById(userId);
      try {
        await expect(
          database.pool.query(
            "UPDATE specialist_work SET decision_state='rejected',revision=revision+1 WHERE id=$1 AND work_revision=$2",
            [exact.assignmentWork.id, review.workRevision],
          ),
        ).rejects.toMatchObject({
          constraint: "specialist_work_decision_required",
        });
        const rejected = await decide(review);

        expect(rejected.status).toBe(200);
        const decision: { id: string; status: string } = await rejected.json();

        expect(decision.status).toBe("rejected");
        const replay = await decide(review);

        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({
          id: decision.id,
          duplicate: true,
        });
        expect((await decide({ ...review, decision: "accept" })).status).toBe(
          409,
        );
        const { rows } = await database.pool.query(
          `SELECT work.decision_state,decision.actor->>'id' AS reviewer,result.validity,result.run_id
        FROM specialist_work_decisions decision JOIN specialist_work work
          ON work.id=decision.work_id AND work.work_revision=decision.work_revision
        JOIN run_results result ON result.id=decision.result_id WHERE decision.id=$1`,
          [decision.id],
        );

        expect(rows).toEqual([
          {
            decision_state: "rejected",
            reviewer: userId,
            validity: "valid",
            run_id: continuation.childRunId,
          },
        ]);
        await expect(
          getSpecialistAssignment(db, userId, assignment.id),
        ).resolves.toMatchObject({ status: "active" });
        const context = await getSpecialistAssignmentTokenContext(
          db,
          credential.tokenId,
          assignment.id,
        );

        expect(context.entries).toContainEqual(
          expect.objectContaining({
            actor: expect.objectContaining({ id: userId, kind: "user" }),
            entry: {
              id: decision.id,
              kind: "decision",
              state: "resolved",
              text: review.reason,
              references: [],
            },
          }),
        );
      } finally {
        browserSession.user = null;
      }
    } finally {
      if (savedAgentCap === undefined)
        delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
      else process.env.MAISTER_MAX_CONCURRENT_AGENTS = savedAgentCap;
    }
  }, 120_000);
});

it("AV-06 reserves an installation Run and intersects current project authority before MCP disclosure", async () => {
  const { updateCompanySpecialistBinding } =
    await import("../company-binding-mutations");
  const { retainCompanyAgentSessionCredential } = await import("../tokens");
  const { captureInstallationProjects, installationRunProjects } =
    await import("../installation-source-capture");
  const projectList = await import("@/app/api/v1/ext/projects/route");

  type ResponseContract = {
    content: { "application/json": { schema: object } };
  };
  const externalContract = parse(
    await readFile(
      resolve("../docs/api/external/operations.openapi.yaml"),
      "utf8",
    ),
  ) as {
    components: {
      schemas: Record<string, object>;
      responses: Record<string, ResponseContract>;
    };
    paths: Record<
      string,
      {
        get: {
          responses: Record<string, ResponseContract | { $ref: string }>;
        };
      }
    >;
  };
  const api = new Ajv({ strict: false, validateFormats: false });
  const validators = new Map<string, ReturnType<typeof api.compile>>();

  async function assertExternalRead(
    path: string,
    response: Response,
    status = 200,
  ): Promise<unknown> {
    expect(response.status, await response.clone().text()).toBe(status);
    const body: unknown = await response.json();
    const operation = externalContract.paths[path]!.get.responses[status]!;
    const { content } =
      "$ref" in operation
        ? externalContract.components.responses[
            operation.$ref.split("/").at(-1)!
          ]!
        : operation;
    const key = `${path} ${status}`;
    const validate =
      validators.get(key) ??
      api.compile({
        components: externalContract.components,
        ...content["application/json"].schema,
      });

    validators.set(key, validate);
    expect(validate(body), `${key}: ${api.errorsText(validate.errors)}`).toBe(
      true,
    );

    return body;
  }
  const noteCommand =
    await import("@/app/api/v1/ext/agent/memory/commands/route");
  const { hosts } = await fakeExecutionHosts(database.db);
  const db: Db = database.db;
  const launchUserId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [launchUserId, `${launchUserId}@example.test`],
  );
  await createCompanyGrants(db, administratorId, {
    principalKind: "user",
    principalId: launchUserId,
    actions: [
      "specialists:read",
      "specialists:manage",
      "assignments:read",
      "assignments:submit",
      "assignments:update",
      "assignments:recover",
    ],
    idempotencyKey: randomUUID(),
  });
  const installationAdminId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active')",
    [installationAdminId, `${installationAdminId}@example.test`],
  );
  const pin = assignmentInput.standingDefinition;
  const candidateId = "rah:vault-installation-fixture";
  const effective = await resolveInstalledAgentDefinition(db, {
    agentId: candidateId,
    packageInstallId: pin.packageInstallId,
  });

  await createCompanyGrants(db, installationAdminId, {
    principalKind: "user",
    principalId: installationAdminId,
    actions: [
      "specialists:read",
      "specialists:manage",
      "assignments:read",
      "assignments:submit",
      "assignments:update",
    ],
    idempotencyKey: randomUUID(),
  });
  const configuration = {
    owner: assignmentInput.owner as { kind: "company"; companyId: string },
    packageInstallId: pin.packageInstallId,
    packageRevision: pin.packageRevision,
    definitionSha256: agentDefinitionSha256(effective.parsed),
    enabled: true,
    configuration: {},
    grantActions: [] as [],
  };
  const grant = {
    schemaVersion: 1 as const,
    reach: "active_projects" as const,
    memoryEnabled: true,
    scopes: [
      "projects:read",
      "runs:read",
      "tasks:read",
      "activity:read",
      "observatory:read",
      "memory:read",
      "memory:propose",
      "knowledge:read",
      "knowledge:propose",
      "agent_memory:read",
      "agent_memory:propose",
    ] as const,
  };
  const { specialist } = await createCompanySpecialistBinding(
    db,
    installationAdminId,
    candidateId,
    {
      ...configuration,
      installationGrant: { ...grant, scopes: [...grant.scopes] },
      idempotencyKey: randomUUID(),
    },
  );
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
  const assignment = await createSpecialistAssignment(db, launchUserId, {
    ...assignmentInput,
    destination: { kind: "inbox", userId: launchUserId },
    specialistBindingId: specialist.bindingId,
    responsibleAgentId: candidateId,
    standingDefinition: {
      ...pin,
      agentId: candidateId,
      definition: effective.parsed,
      definitionSha256: configuration.definitionSha256,
    },
  });
  const run = await reserveCompanyAgentRun(
    db,
    launchUserId,
    {
      ...request,
      assignmentId: assignment.id,
      bindingId: specialist.bindingId,
      bindingRevision: specialist.configRevision,
    },
    hosts,
  );
  const [a, b, archived] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ].sort() as [string, string, string];

  for (const [id, name, taskKey] of [
    [a, "install-a", "INSTA"],
    [b, "install-b", "INSTB"],
    [archived, "install-archive", "INSTAR"],
  ] as const) {
    await database.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,task_key,archived_at) VALUES($1,$2,$2,$3,$4,$5)",
      [
        id,
        name,
        join(root, name),
        taskKey,
        id === archived ? new Date() : null,
      ],
    );
  }
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member'),($4,$5,$3,'member')",
    [randomUUID(), a, launchUserId, randomUUID(), archived],
  );
  await database.pool.query(
    "INSERT INTO agent_memory_cutover(generation) VALUES(1) ON CONFLICT DO NOTHING",
  );
  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    run.runId,
  ]);
  const token = await db.transaction((tx) =>
    retainCompanyAgentSessionCredential(tx, run.runId),
  );
  const headers = {
    authorization: `Bearer ${token.secret}`,
    "content-type": "application/json",
  };
  const { secret: userSecret } = await issueUserAccessToken(
    {
      name: "Installation facade ordinary reader",
      ownerUserId: installationAdminId,
      scopes: ["projects:read", "tasks:read", "runs:read"],
    },
    db,
  );
  const ordinaryHeaders = { authorization: `Bearer ${userSecret}` };
  const listUrl = "http://localhost/api/v1/ext/projects";
  const list = (query = "") =>
    projectList.GET(new NextRequest(listUrl + query, { headers }));
  const initial = await list();

  expect(initial.headers.get("cache-control")).toBe("private, no-store");
  const initialBody = (await assertExternalRead(
    "/api/v1/ext/projects",
    initial,
  )) as {
    items: { id: string }[];
  };

  expect(initialBody.items.map(({ id }) => id)).toContain(a);
  await assertExternalRead(
    "/api/v1/ext/projects",
    await projectList.GET(new NextRequest(listUrl)),
    401,
  );
  expect(
    await assertExternalRead(
      "/api/v1/ext/projects",
      await projectList.GET(
        new NextRequest(listUrl, { headers: ordinaryHeaders }),
      ),
    ),
  ).toMatchObject({
    projects: expect.arrayContaining([
      { id: a, slug: "install-a", name: "install-a" },
    ]),
  });
  await expect(installationRunProjects(db, run.runId)).resolves.toContain(a);
  await expect(installationRunProjects(db, run.runId)).resolves.not.toContain(
    b,
  );
  await expect(installationRunProjects(db, run.runId)).resolves.not.toContain(
    archived,
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), b, launchUserId],
  );
  const firstPage = (await assertExternalRead(
    "/api/v1/ext/projects",
    await list("?limit=1"),
  )) as { items: { id: string }[]; nextCursor: string };

  expect(firstPage.items).toHaveLength(1);
  expect(firstPage.nextCursor).toEqual(expect.any(String));
  expect(firstPage.items[0]?.id).toBe(a);
  expect(await installationRunProjects(db, run.runId)).toEqual([a]);
  const nextPage = (await assertExternalRead(
    "/api/v1/ext/projects",
    await list(`?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`),
  )) as { items: { id: string }[]; nextCursor: string | null };

  expect(
    [...firstPage.items, ...nextPage.items].map(({ id }) => id).sort(),
  ).toEqual([a, b].sort());
  expect(nextPage.nextCursor).toBeNull();
  const activityRunId = randomUUID();
  const activityEventId = randomUUID();

  await database.pool.query(
    "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,started_at) VALUES($1,$2,'flow','Done','fixture','fixture',now()-interval '90 days')",
    [activityRunId, a],
  );
  await database.pool.query(
    "INSERT INTO execution_events(id,source,source_key,run_id,event_type,payload_schema,payload,occurred_at,ingest_disposition) VALUES($1,'manager',$1,$2,'fixture.observation','fixture','{}',now(),'accepted')",
    [activityEventId, activityRunId],
  );
  const { generateToken } = await import("@/lib/tokens/secret");
  const activityToken = generateToken();

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE project_tokens SET revoked_at=clock_timestamp() WHERE id=${token.tokenId}`,
    );
    // A subset of the appointed scopes is legal on the exact retained Run.
    await tx.execute(sql`INSERT INTO project_tokens(id,company_id,company_run_id,installation_run_id,name,token_kind,
      owner_user_id,agent_id,prefix,token_hash,scopes,expires_at)
      SELECT ${randomUUID()},company_id,company_run_id,installation_run_id,name,token_kind,
        owner_user_id,agent_id,${activityToken.prefix},${activityToken.hash},'["activity:read"]'::jsonb,expires_at
      FROM project_tokens WHERE id=${token.tokenId}`);
  });
  const { GET: getManualActivity } =
    await import("@/app/api/v1/ext/runs/[runId]/activity/route");
  const activityResponse = await getManualActivity(
    new NextRequest(
      `http://localhost/api/v1/ext/runs/${activityRunId}/activity`,
      {
        headers: { authorization: `Bearer ${activityToken.secret}` },
      },
    ),
    { params: Promise.resolve({ runId: activityRunId }) },
  );

  expect(
    await assertExternalRead(
      "/api/v1/ext/runs/{runId}/activity",
      activityResponse,
    ),
  ).toMatchObject({ items: [{ id: activityEventId, projectId: a }] });
  expect(
    (
      await database.pool.query(
        "SELECT knowledge_access FROM runs WHERE id=$1",
        [run.runId],
      )
    ).rows,
  ).toEqual([
    {
      knowledge_access: expect.objectContaining({
        restrictions: expect.arrayContaining([
          { kind: "project_context", projectId: a },
        ]),
      }),
    },
  ]);

  const refreshedToken = await db.transaction((tx) =>
    retainCompanyAgentSessionCredential(tx, run.runId),
  );

  headers.authorization = `Bearer ${refreshedToken.secret}`;
  await database.pool.query(
    "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
    [a, launchUserId],
  );
  try {
    expect(
      await assertExternalRead("/api/v1/ext/projects", await list(), 409),
    ).toMatchObject({ code: "PRECONDITION" });
    await expect(
      db.transaction((tx) => loadCompanyAgentSessionContext(tx, run.runId)),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  } finally {
    await database.pool.query(
      "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
      [a, launchUserId],
    );
  }
  const slug = "install-a";
  const params = { params: Promise.resolve({ slug }) };
  const directory =
    await import("@/app/api/v1/ext/projects/[slug]/directory/route");
  const directoryPath = "/api/v1/ext/projects/{slug}/directory";
  const directoryUrl = `http://localhost/api/v1/ext/projects/${slug}/directory`;

  expect(
    await assertExternalRead(
      directoryPath,
      await directory.GET(new NextRequest(directoryUrl, { headers }), params),
    ),
  ).toEqual({ id: a, projectId: a, slug, name: slug });
  expect(
    await assertExternalRead(
      directoryPath,
      await directory.GET(
        new NextRequest(directoryUrl, { headers: ordinaryHeaders }),
        params,
      ),
    ),
  ).toMatchObject({ project: { id: a, slug, name: slug } });

  const tasks = await import("@/app/api/v1/ext/projects/[slug]/tasks/route");
  const taskId = randomUUID();
  const taskTitle = "Inspect scoped execution metadata";

  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES($1,$2,1,$3,'Review run data')",
    [taskId, a, taskTitle],
  );
  const taskListPath = "/api/v1/ext/projects/{slug}/tasks";
  const taskListUrl = `http://localhost/api/v1/ext/projects/${slug}/tasks`;
  const compactTask = {
    id: taskId,
    projectId: a,
    slug,
    number: 1,
    title: taskTitle,
    status: "Backlog",
  };

  expect(
    await assertExternalRead(
      taskListPath,
      await tasks.GET(new NextRequest(taskListUrl, { headers }), params),
    ),
  ).toEqual({ items: [compactTask], nextCursor: null });
  expect(
    await assertExternalRead(
      taskListPath,
      await tasks.GET(
        new NextRequest(taskListUrl, { headers: ordinaryHeaders }),
        params,
      ),
    ),
  ).toMatchObject({ tasks: [{ id: taskId, prompt: "Review run data" }] });
  const task =
    await import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/route");
  const taskPath = "/api/v1/ext/projects/{slug}/tasks/{taskId}";
  const taskUrl = `${taskListUrl}/${taskId}`;
  const taskParams = { params: Promise.resolve({ slug, taskId }) };

  expect(
    await assertExternalRead(
      taskPath,
      await task.GET(new NextRequest(taskUrl, { headers }), taskParams),
    ),
  ).toEqual(compactTask);
  expect(
    await assertExternalRead(
      taskPath,
      await task.GET(
        new NextRequest(taskUrl, { headers: ordinaryHeaders }),
        taskParams,
      ),
    ),
  ).toMatchObject({ id: taskId, prompt: "Review run data" });
  const emptyOrMissing = (projectSlug: string) =>
    tasks.GET(
      new NextRequest(
        `http://localhost/api/v1/ext/projects/${projectSlug}/tasks`,
        { headers },
      ),
      { params: Promise.resolve({ slug: projectSlug }) },
    );

  expect(
    await assertExternalRead(taskListPath, await emptyOrMissing("install-b")),
  ).toEqual({
    items: [],
    nextCursor: null,
  });
  const [archivedTasks, missingTasks] = await Promise.all([
    emptyOrMissing("install-archive"),
    emptyOrMissing("install-missing"),
  ]);

  expect(await assertExternalRead(taskListPath, archivedTasks, 404)).toEqual(
    await assertExternalRead(taskListPath, missingTasks, 404),
  );
  const detailWithPaging = await task.GET(
    new NextRequest(`${taskUrl}?limit=1`, { headers }),
    taskParams,
  );

  expect(
    await assertExternalRead(taskPath, detailWithPaging, 422),
  ).toMatchObject({
    code: "CONFIG",
  });
  expect(
    (
      await tasks.POST(
        new NextRequest(taskListUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Must not create" }),
        }),
        params,
      )
    ).status,
  ).toBe(403);
  await database.pool.query(
    "UPDATE projects SET brain_enabled=true WHERE id IN ($1,$2)",
    [a, b],
  );
  const { POST: brainProposal } =
    await import("@/app/api/v1/ext/projects/[slug]/memory/proposals/route");
  const { POST: knowledgeProposal } =
    await import("@/app/api/v1/ext/knowledge/proposals/route");
  const body = {
    title: "Installation analyzer observation",
    content: "Covered all visible active projects.",
  };
  const brain = await brainProposal(
    new NextRequest(
      "http://localhost/api/v1/ext/projects/install-a/memory/proposals",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "state", draft: body }),
      },
    ),
    params,
  );

  expect(brain.status, await brain.clone().text()).toBe(201);
  const embedding = createServer((request, response) => {
    request.resume();
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }));
  });

  embedding.listen(0, "127.0.0.1");
  try {
    await once(embedding, "listening");
    const address = embedding.address();

    if (!address || typeof address === "string")
      throw new Error("Expected TCP embedding fixture");
    await database.pool.query(
      "UPDATE platform_runtime_settings SET embedding_base_url=$1,embedding_model='fixture',embedding_dimensions=3 WHERE id='singleton'",
      [`http://127.0.0.1:${address.port}`],
    );
    const { GET: recall } =
      await import("@/app/api/v1/ext/projects/[slug]/memory/route");
    const recalled = await recall(
      new NextRequest(
        "http://localhost/api/v1/ext/projects/install-b/memory?q=observation",
        { headers },
      ),
      { params: Promise.resolve({ slug: "install-b" }) },
    );

    expect(recalled.status, await recalled.clone().text()).toBe(200);
    expect(await recalled.json()).toMatchObject({ items: [] });
  } finally {
    await new Promise<void>((resolve, reject) =>
      embedding.close((error) => (error ? reject(error) : resolve())),
    );
    await database.pool.query(
      "UPDATE platform_runtime_settings SET embedding_base_url=NULL,embedding_model=NULL,embedding_dimensions=NULL WHERE id='singleton'",
    );
  }
  const knowledge = await knowledgeProposal(
    new NextRequest("http://localhost/api/v1/ext/knowledge/proposals", {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        content: {
          change: "add",
          owner: { kind: "project", projectId: a },
          title: body.title,
          assertion: body.content,
          kind: "observation",
          basis: "unknown",
          evidence: [],
          limitations: [],
          missingEvidence: [],
        },
      }),
    }),
  );

  expect(knowledge.status, await knowledge.clone().text()).toBe(201);
  expect(await knowledge.json()).toMatchObject({ status: "pending" });
  const { GET: searchKnowledge } =
    await import("@/app/api/v1/ext/knowledge/route");

  expect(
    await (
      await searchKnowledge(
        new NextRequest(
          `http://localhost/api/v1/ext/knowledge?ownerKind=project&ownerId=${a}`,
          { headers },
        ),
      )
    ).json(),
  ).toMatchObject({ items: [] });
  const proposed = await noteCommand.POST(
    new NextRequest("http://localhost/api/v1/ext/agent/memory/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        command: "create",
        path: "/memories/notes/installation.md",
        file_text: "Observe the two project runs.",
        ifHash: null,
        ifRevisionId: null,
        requestKey: randomUUID(),
      }),
    }),
  );

  expect(proposed.status, JSON.stringify(await proposed.clone().json())).toBe(
    202,
  );
  const { proposalId } = await proposed.json();

  expect(
    (
      await database.pool.query(
        "SELECT source_project_ids,source_restrictions FROM agent_memory_proposals WHERE id=$1",
        [proposalId],
      )
    ).rows,
  ).toEqual([
    {
      source_project_ids: [a, b].sort(),
      source_restrictions: expect.arrayContaining(
        [a, b].map((projectId) => ({ kind: "project_context", projectId })),
      ),
    },
  ]);
  const { decideVaultProposal } =
    await import("@/lib/agent-memory-vault/review");
  const { listProposalReviews } =
    await import("@/lib/queries/knowledge-memory-reviews");
  const { prepareHumanInstallationVault } =
    await import("@/lib/agent-memory-vault/installation-access");
  const { viewAgentMemory } = await import("@/lib/agent-memory-vault/view");
  const { parseAgentMemoryView } =
    await import("@/lib/agent-memory-vault/commands");
  const listReviews = (reviewer: string) =>
    listProposalReviews(db, reviewer, {
      kind: "vault",
      agentId: candidateId,
      limit: 20,
    });

  expect((await listReviews(installationAdminId)).items).toContainEqual(
    expect.objectContaining({ id: proposalId, allowed: ["accept", "reject"] }),
  );
  expect((await listReviews(launchUserId)).items).toEqual([]);
  await expect(
    decideVaultProposal(db, {
      proposalId,
      userId: installationAdminId,
      expectedVersion: 1,
      decision: "accept",
      requestKey: randomUUID(),
    }),
  ).resolves.toMatchObject({ state: "accepted" });
  const command = parseAgentMemoryView({
    command: "view",
    path: "/memories/notes/installation.md",
  });
  const view = (viewer: string) =>
    viewAgentMemory(
      db,
      command,
      prepareHumanInstallationVault({
        userId: viewer,
        agentId: candidateId,
        bindingId: specialist.bindingId,
        action: "read",
      }),
    );

  await expect(view(installationAdminId)).resolves.toMatchObject({
    kind: "note",
    content: "Observe the two project runs.",
  });
  await expect(view(launchUserId)).resolves.toMatchObject({ kind: "note" });
  await database.pool.query(
    "UPDATE projects SET archived_at=clock_timestamp() WHERE id=$1",
    [a],
  );
  await expect(view(launchUserId)).rejects.toMatchObject({
    details: { reason: "agent_memory_unavailable" },
  });
  await expect(view(installationAdminId)).resolves.toMatchObject({
    kind: "note",
  });
  await database.pool.query(
    "UPDATE projects SET archived_at=NULL WHERE id=$1",
    [a],
  );
  await database.pool.query(
    "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
    [a, launchUserId],
  );
  await expect(view(launchUserId)).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "agent_memory_unavailable" },
  });
  expect(
    await assertExternalRead("/api/v1/ext/projects", await list(), 409),
  ).toMatchObject({ code: "PRECONDITION" });
  await expect(
    db.transaction((tx) => loadCompanyAgentSessionContext(tx, run.runId)),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  const cron = await createCompanyCronSchedule(db, launchUserId, {
    owner: configuration.owner,
    specialistBindingId: specialist.bindingId,
    cronExpr: "*/5 * * * *",
    timezone: "UTC",
    requestAtLaunch: "Inspect recent runs in active installation projects.",
    enabled: true,
    idempotencyKey: randomUUID(),
  });
  const eventSubscription = await createCompanyEventSchedule(db, launchUserId, {
    owner: configuration.owner,
    specialistBindingId: specialist.bindingId,
    eventKinds: ["run.done"],
    enabled: true,
    idempotencyKey: randomUUID(),
  });

  await database.pool.query(
    "UPDATE agent_schedules SET next_fire_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
    [cron.scheduleId],
  );
  await database.pool.query(
    "UPDATE users SET must_change_password=true WHERE id=$1",
    [launchUserId],
  );
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "1";
  try {
    await runSchedulerTick({ jobKind: "agent_tick" });
  } finally {
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
  }
  const [cronRun] = (
    await database.pool.query<{
      id: string;
      status: string;
      principal: unknown;
    }>(
      "SELECT r.id,r.status,authority.principal FROM runs r JOIN agent_installation_run_authorities authority ON authority.run_id=r.id WHERE r.agent_schedule_id=$1",
      [cron.scheduleId],
    )
  ).rows;

  expect(cronRun?.principal).toEqual({ kind: "unattended", trigger: "cron" });
  expect(cronRun?.status).toBe("Pending");
  if (!cronRun) throw new Error("Scheduler did not retain an installation Run");
  expect(
    (
      await database.pool.query(
        "SELECT r.created_by_user_id, i.actor FROM runs r JOIN specialist_run_links link ON link.run_id=r.id JOIN specialist_input_revisions i ON (i.assignment_id,i.revision)=(link.assignment_id,link.input_revision) WHERE r.id=$1",
        [cronRun.id],
      )
    ).rows,
  ).toEqual([
    {
      created_by_user_id: null,
      actor: {
        kind: "agent",
        id: candidateId,
        runId: cronRun.id,
        attemptId: null,
      },
    },
  ]);
  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    cronRun.id,
  ]);
  try {
    await expect(
      db.transaction((tx) => loadCompanyAgentSessionContext(tx, cronRun.id)),
    ).resolves.toMatchObject({
      installation: { principal: { kind: "unattended", trigger: "cron" } },
    });
    const scheduled = await db.transaction((tx) =>
      retainCompanyAgentSessionCredential(tx, cronRun.id),
    );
    const { GET: getRun } = await import("@/app/api/v1/ext/runs/[runId]/route");
    const cronHeaders = { authorization: `Bearer ${scheduled.secret}` };
    const runIds = await Promise.all(
      [a, b].map(async (source) => {
        const runId = randomUUID();

        await database.pool.query(
          "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,started_at,ended_at) VALUES($1,$2,'flow','Done','fixture','fixture',now()-interval '1 minute',now())",
          [runId, source],
        );
        const path = "/api/v1/ext/runs/{runId}";
        const url = `http://localhost/api/v1/ext/runs/${runId}`;
        const route = { params: Promise.resolve({ runId }) };

        expect(
          await assertExternalRead(
            path,
            await getRun(new NextRequest(url, { headers: cronHeaders }), route),
          ),
        ).toMatchObject({ id: runId, projectId: source, runKind: "flow" });
        expect(
          await assertExternalRead(
            path,
            await getRun(
              new NextRequest(url, { headers: ordinaryHeaders }),
              route,
            ),
          ),
        ).toMatchObject({ id: runId, runnerId: null });

        return runId;
      }),
    );
    const { GET: getActivity } =
      await import("@/app/api/v1/ext/runs/[runId]/activity/route");
    const runId = runIds[0]!;

    const eventId = randomUUID();
    const eventType = "fixture.observation";

    await database.pool.query(
      "INSERT INTO execution_events(id,source,source_key,run_id,event_type,payload_schema,payload,occurred_at,ingest_disposition) VALUES($1,'manager',$1,$2,$3,'fixture',$4,now(),'accepted')",
      [eventId, runId, eventType, { privateData: "Run event payload" }],
    );
    const activityPath = "/api/v1/ext/runs/{runId}/activity";
    const activity = (id: string, requestHeaders: HeadersInit, query = "") =>
      getActivity(
        new NextRequest(
          `http://localhost/api/v1/ext/runs/${id}/activity${query}`,
          { headers: requestHeaders },
        ),
        { params: Promise.resolve({ runId: id }) },
      );

    expect(
      await assertExternalRead(
        activityPath,
        await activity(runId, cronHeaders),
      ),
    ).toEqual({
      items: [
        {
          id: eventId,
          projectId: a,
          slug,
          runId,
          type: eventType,
          occurredAt: expect.any(String),
        },
      ],
      nextCursor: null,
    });
    expect(
      await assertExternalRead(
        activityPath,
        await activity(runId, ordinaryHeaders),
      ),
    ).toMatchObject({
      items: [],
      hasMore: false,
    });
    await assertExternalRead(
      activityPath,
      await activity(randomUUID(), cronHeaders),
      404,
    );
    await assertExternalRead(
      activityPath,
      await activity(runId, cronHeaders, "?sinceId=1"),
      422,
    );
    const { GET: observatory } =
      await import("@/app/api/v1/ext/observatory/summary/route");
    const observatoryPath = "/api/v1/ext/observatory/summary";

    await assertExternalRead(
      observatoryPath,
      await observatory(
        new NextRequest(`http://localhost${observatoryPath}`, {
          headers: ordinaryHeaders,
        }),
      ),
      403,
    );

    for (const [slug, projectId] of [
      ["install-a", a],
      ["install-b", b],
    ]) {
      const aggregate = await observatory(
        new NextRequest(
          `http://localhost/api/v1/ext/observatory/summary?period=24h&slug=${slug}`,
          { headers: cronHeaders },
        ),
      );

      expect(await assertExternalRead(observatoryPath, aggregate)).toEqual({
        items: [
          {
            projectId,
            slug,
            runCount: 1,
            successCount: 1,
            durationMs: 60000,
          },
        ],
        nextCursor: null,
      });
    }
    await expect(
      db.transaction((tx) =>
        captureInstallationProjects(
          tx,
          cronRun.id,
          Array.from({ length: 256 }, () => randomUUID()),
        ),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    await expect(installationRunProjects(db, cronRun.id)).resolves.toEqual(
      [a, b].sort(),
    );
    const scheduledProposal = await noteCommand.POST(
      new NextRequest("http://localhost/api/v1/ext/agent/memory/commands", {
        method: "POST",
        headers: {
          authorization: `Bearer ${scheduled.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "create",
          path: "/memories/notes/cron.md",
          file_text: "A scheduled observation.",
          ifHash: null,
          ifRevisionId: null,
          requestKey: randomUUID(),
        }),
      }),
    );

    expect(scheduledProposal.status).toBe(202);
    const { proposalId: cronProposal } = await scheduledProposal.json();

    expect((await listReviews(installationAdminId)).items).toContainEqual(
      expect.objectContaining({ id: cronProposal }),
    );
    await expect(
      decideVaultProposal(db, {
        proposalId: cronProposal,
        userId: installationAdminId,
        expectedVersion: 1,
        decision: "accept",
        requestKey: randomUUID(),
      }),
    ).resolves.toMatchObject({ state: "accepted" });
    expect(
      (
        await database.pool.query(
          "SELECT source_project_ids,author->>'runId' AS author FROM agent_memory_revisions WHERE path='/memories/notes/cron.md'",
        )
      ).rows,
    ).toEqual([{ source_project_ids: [a, b].sort(), author: cronRun.id }]);

    const producingId = "rah:vault-installation-producer";
    const producingDefinition = await resolveInstalledAgentDefinition(db, {
      agentId: producingId,
      packageInstallId: pin.packageInstallId,
    });
    const producingDigest = agentDefinitionSha256(producingDefinition.parsed);
    const { specialist: producingBinding } =
      await createCompanySpecialistBinding(
        db,
        installationAdminId,
        producingId,
        {
          ...configuration,
          definitionSha256: producingDigest,
          idempotencyKey: randomUUID(),
        },
      );
    const producingInput = await createSpecialistAssignment(
      db,
      installationAdminId,
      {
        ...assignmentInput,
        destination: { kind: "inbox", userId: installationAdminId },
        specialistBindingId: producingBinding.bindingId,
        responsibleAgentId: producingId,
        standingDefinition: {
          ...pin,
          agentId: producingId,
          definition: producingDefinition.parsed,
          definitionSha256: producingDigest,
        },
      },
    );
    const producing = await reserveCompanyAgentRun(
      db,
      installationAdminId,
      {
        ...request,
        assignmentId: producingInput.id,
        bindingId: producingBinding.bindingId,
        bindingRevision: producingBinding.configRevision,
      },
      hosts,
    );

    await db
      .update(runs)
      .set({
        agentChainDepth: 0,
      })
      .where(eq(runs.id, producing.runId));
    await emitDomainEvent({
      db,
      companyId: configuration.owner.companyId,
      runId: producing.runId,
      parentRunId: null,
      kind: "run.done",
      actor: { type: "system", id: null },
      payload: {
        runId: producing.runId,
        runKind: "agent",
        flowId: null,
        taskId: null,
      },
    });
    const [event] = await db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.runId, producing.runId),
          eq(domainEvents.kind, "run.done"),
        ),
      );

    if (!event) throw new Error("Expected classified producing event");
    const { dispatchCompanyAgentEvents } =
      await import("../company-event-dispatch");

    await database.pool.query(
      "INSERT INTO execution_host_pressure(execution_host_id,pressured_since) SELECT id,now() FROM execution_hosts WHERE kind='local_direct' AND retired_at IS NULL ON CONFLICT DO NOTHING",
    );
    try {
      await dispatchCompanyAgentEvents(db, [event]);
    } finally {
      await database.pool.query("DELETE FROM execution_host_pressure");
    }
    expect(
      (
        await database.pool.query(
          "SELECT r.agent_chain_depth,authority.principal FROM runs r JOIN agent_installation_run_authorities authority ON authority.run_id=r.id WHERE r.agent_schedule_id=$1 AND r.trigger_event_id=$2",
          [eventSubscription.scheduleId, event.id],
        )
      ).rows,
    ).toEqual([
      {
        agent_chain_depth: 1,
        principal: { kind: "unattended", trigger: "domain_event" },
      },
    ]);
    const exhausted = await reserveCompanyAgentRun(
      db,
      installationAdminId,
      {
        ...request,
        assignmentId: (
          await createSpecialistAssignment(db, installationAdminId, {
            ...assignmentInput,
            origin: { kind: "manual", interactionId: randomUUID() },
            destination: { kind: "inbox", userId: installationAdminId },
            specialistBindingId: producingBinding.bindingId,
            responsibleAgentId: producingId,
            standingDefinition: {
              ...pin,
              agentId: producingId,
              definition: producingDefinition.parsed,
              definitionSha256: producingDigest,
            },
          })
        ).id,
        bindingId: producingBinding.bindingId,
        bindingRevision: producingBinding.configRevision,
      },
      hosts,
    );

    await db
      .update(runs)
      .set({ agentChainDepth: maxAgentChainDepth() })
      .where(eq(runs.id, exhausted.runId));
    await emitDomainEvent({
      db,
      companyId: configuration.owner.companyId,
      runId: exhausted.runId,
      parentRunId: null,
      kind: "run.done",
      actor: { type: "system", id: null },
      payload: {
        runId: exhausted.runId,
        runKind: "agent",
        flowId: null,
        taskId: null,
      },
    });
    const [exhaustedEvent] = await db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.runId, exhausted.runId),
          eq(domainEvents.kind, "run.done"),
        ),
      );

    if (!exhaustedEvent) throw new Error("Expected exhausted producing event");
    await dispatchCompanyAgentEvents(db, [exhaustedEvent]);
    expect(
      (
        await database.pool.query(
          "SELECT outcome, reason_code FROM agent_trigger_attempts WHERE schedule_id=$1 AND trigger_event_id=$2",
          [eventSubscription.scheduleId, exhaustedEvent.id],
        )
      ).rows,
    ).toEqual([
      { outcome: "suppressed", reason_code: "chain_depth_exhausted" },
    ]);
  } finally {
    await database.pool.query(
      "UPDATE users SET must_change_password=false WHERE id=$1",
      [launchUserId],
    );
  }
  const cronNote = parseAgentMemoryView({
    command: "view",
    path: "/memories/notes/cron.md",
  });

  await expect(
    viewAgentMemory(
      db,
      cronNote,
      prepareHumanInstallationVault({
        userId: launchUserId,
        agentId: candidateId,
        bindingId: specialist.bindingId,
        action: "read",
      }),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "agent_memory_unavailable" },
  });
  const [retainedVault] = (
    await database.pool.query<{ id: string }>(
      "SELECT id FROM agent_memory_vaults WHERE company_id=$1 AND agent_id=$2",
      [configuration.owner.companyId, candidateId],
    )
  ).rows;

  if (!retainedVault)
    throw new Error("Expected the retained installation vault");
  const { seedLibrarianTurn } = await import("@/test-support/librarian-seed");
  const { issueLibrarianTurnToken, scopesForLibrarianTurn } =
    await import("@/lib/librarian/authority");
  const { GET: librarianVaultView } =
    await import("@/app/api/v1/ext/librarian/vaults/[vaultId]/view/route");

  for (const [ownerId, expectedStatus] of [
    [installationAdminId, 200],
    [launchUserId, 404],
  ] as const) {
    const turnId = await seedLibrarianTurn(database.db, ownerId);
    const { secret, tokenId } = await issueLibrarianTurnToken(
      {
        turnId,
        ownerUserId: ownerId,
        scopes: scopesForLibrarianTurn("owner_message"),
        expiresAt: new Date(Date.now() + 60_000),
      },
      db,
    );

    await database.pool.query(
      "UPDATE librarian_turns SET token_id=$2 WHERE id=$1",
      [turnId, tokenId],
    );
    const get = (id: string) =>
      librarianVaultView(
        new NextRequest(
          `http://localhost/api/v1/ext/librarian/vaults/${id}/view?path=${encodeURIComponent(cronNote.path)}`,
          {
            headers: { authorization: `Bearer ${secret}` },
          },
        ),
        { params: Promise.resolve({ vaultId: id }) },
      );
    const reply = await get(retainedVault.id);

    expect(reply.status).toBe(expectedStatus);
    if (expectedStatus === 200)
      expect(await reply.json()).toMatchObject({
        content: "A scheduled observation.",
      });
    else
      expect(await reply.json()).toEqual(
        await (await get(randomUUID())).json(),
      );
  }
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), a, launchUserId],
  );
  const installationCredentialGuard = {
    code: "23514",
    constraint: "project_tokens_installation_binding_immutable",
  };

  await expect(
    database.pool.query(
      `UPDATE project_tokens SET scopes=scopes || '["runs:read"]'::jsonb
       WHERE installation_run_id=$1 AND scopes='["activity:read"]'::jsonb`,
      [run.runId],
    ),
  ).rejects.toMatchObject(installationCredentialGuard);
  const failed = await prepareUndispatchedAgentFailure(run.runId, {
    db,
    reason: "agent_dispatch_failed",
  });

  await db.transaction(failed.apply);
  expect(
    (
      await database.pool.query<{
        revoked: boolean;
        revocation_reason: string;
      }>(
        `SELECT revoked_at IS NOT NULL AS revoked, revocation_reason
         FROM project_tokens WHERE installation_run_id=$1`,
        [run.runId],
      )
    ).rows,
  ).toEqual(
    Array.from({ length: 3 }, () => ({
      revoked: true,
      revocation_reason: "revoked",
    })),
  );
  await expect(
    database.pool.query(
      "UPDATE project_tokens SET revocation_reason=NULL WHERE id=$1",
      [refreshedToken.tokenId],
    ),
  ).rejects.toMatchObject(installationCredentialGuard);
  await expect(
    database.pool.query(
      "UPDATE project_tokens SET revoked_at=NULL,revocation_reason=NULL WHERE id=$1",
      [refreshedToken.tokenId],
    ),
  ).rejects.toMatchObject(installationCredentialGuard);
  await assertExternalRead("/api/v1/ext/projects", await list(), 401);
  const retryOptions = await getAgentRetryOptions(db, run.runId, launchUserId);

  expect(retryOptions).toMatchObject({
    eligible: true,
    selectedRunnerId: runnerId,
  });
  const retry = await acceptAgentRetry(db, run.runId, launchUserId, {
    runnerId,
    requestKey: randomUUID(),
    previewFingerprint: retryOptions.previewFingerprint,
  });

  expect(retry).toMatchObject({
    intentState: "launched",
    runStatus: "Pending",
  });
  expect(
    (
      await database.pool.query(
        `SELECT successor.knowledge_access, successor.knowledge_access=source.knowledge_access AS exact_capture
         FROM runs source JOIN runs successor ON successor.retry_of_run_id=source.id WHERE source.id=$1`,
        [run.runId],
      )
    ).rows,
  ).toEqual([
    {
      exact_capture: true,
      knowledge_access: expect.objectContaining({
        restrictions: expect.arrayContaining(
          [a, b].map((projectId) => ({ kind: "project_context", projectId })),
        ),
      }),
    },
  ]);
  if (!retry.runId) throw new Error("Expected a retained retry Run");
  const retryRunId = retry.runId;

  await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
    retryRunId,
  ]);
  const retryCredential = await db.transaction((tx) =>
    retainCompanyAgentSessionCredential(tx, retryRunId),
  );

  headers.authorization = `Bearer ${retryCredential.secret}`;
  await assertExternalRead("/api/v1/ext/projects", await list());
  await database.pool.query("DELETE FROM projects WHERE id=$1", [a]);
  await expect(installationRunProjects(db, cronRun.id)).resolves.toEqual(
    [a, b].sort(),
  );
  await expect(view(launchUserId)).rejects.toMatchObject({
    details: { reason: "agent_memory_unavailable" },
  });
  await expect(view(installationAdminId)).resolves.toMatchObject({
    kind: "note",
  });
  await updateCompanySpecialistBinding(
    db,
    installationAdminId,
    candidateId,
    specialist.bindingId,
    {
      ...configuration,
      installationGrant: null,
      expectedRevision: specialist.configRevision,
      idempotencyKey: randomUUID(),
      runnerId: null,
      coordinatorFlowRevisionId: null,
      executionPolicy: { preset: "supervised" },
    },
  );
  expect((await list()).status).toBe(403);
});

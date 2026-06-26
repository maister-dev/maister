import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import pino from "pino";

import {
  mergeRunnerAdapterLaunch,
  runnerExecutorInput,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import {
  defaultRunSessionValues,
  resolveAgentRunner,
  type RunnerCatalogEntry,
  type RunnerResolution,
  type RunnerSnapshot,
  type RunnerSidecarSnapshot,
} from "@/lib/acp-runners/resolve";
import { resolveAgentConfig } from "@/lib/agents/config";
import { type ParsedAgentDefinition } from "@/lib/agents/definition";
import {
  checkRepoReadDirt,
  loadAgentWorkspaceContext,
  materializeAgentReadOnlySettings,
  quarantineAgentInTx,
} from "@/lib/agents/dirty-watchdog";
import {
  resolveEffectiveAgentDefinition,
  type EffectiveAgentDefinition,
} from "@/lib/agents/effective";
import { hookEnvDefaults, resolveHooksConfig } from "@/lib/flows/hooks-config";
import { resolveAgentExecutionPolicy } from "@/lib/agents/execution-policy";
import {
  issueAgentRunToken,
  revokeAgentRunTokensForRun,
} from "@/lib/agents/tokens";
import {
  cancelActiveAssignmentsForRun,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import { type AgentMcpServer } from "@/lib/capabilities/agent-map";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  type AgentExecutionPolicyRecommendation,
  type DelegationSnapshot,
} from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { MaisterError, type MaisterErrorCode } from "@/lib/errors";
import { gcAgeDays, worktreesRoot } from "@/lib/instance-config";
import { applyDefaultBudgetForUnattended } from "@/lib/runs/budget-default";
import {
  permissionsFromSnapshot,
  resolveExecutionPolicy,
  type ExecutionPolicy,
} from "@/lib/runs/execution-policy";
import { nextKeepaliveAt } from "@/lib/runs/keepalive-config";
import { assertRunKindInvariant } from "@/lib/runs/run-kind-invariants";
import {
  findSharedTreeWorkspace,
  resolveSharedTreeWorkspaceForUpdate,
} from "@/lib/runs/shared-tree";
import {
  markReworkFromReview,
  type StateTransitionResult,
} from "@/lib/runs/state-transitions";
import {
  promoteNextPending,
  releaseSlotOnIdle,
  tryStartRun,
} from "@/lib/scheduler";
import {
  checkpointSession,
  createSession,
  deliverPermission,
  listSessions,
  sendPrompt,
  streamSession,
  type SupervisorEvent,
} from "@/lib/supervisor-client";
import { escalateHookTrip } from "@/lib/runs/hook-trip";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import {
  addDetachedWorktree,
  addWorktree,
  listBranches,
  listWorktrees,
  removeWorktree,
  resolveBaseCommit,
  statusPorcelain,
} from "@/lib/worktree";
import { recordArtifact } from "@/lib/flows/graph/artifact-store";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  agents,
  agentProjectLinks,
  domainEvents,
  hitlRequests,
  flows,
  platformAcpRunners,
  platformRouterSidecars,
  platformRuntimeSettings,
  projects,
  runs,
  runSessions,
  taskComments,
  tasks,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "agents-launch",
  level: process.env.LOG_LEVEL ?? "info",
});

const COMMENT_THREAD_TAIL_LIMIT = 6;
const CONSENSUS_DRAFT_OUTPUT_CAP_BYTES = 1024 * 1024;

export type AgentTriggerSource =
  | "manual"
  | "cron"
  | "domain_event"
  | "webhook"
  | "flow";

export type LaunchAgentRunInput = {
  agentId: string;
  projectId: string;
  taskId?: string | null;
  launchOverrideRunnerId?: string | null;
  trigger: {
    source: AgentTriggerSource;
    eventId?: number | null;
    payload?: Record<string, unknown> | null;
  };
  // M37 (ADR-098): orchestrator run-tree linkage. Set when this run is a
  // delegated child — parentRunId is the delegator, rootRunId the tree root,
  // launchMode distinguishes auto-DAG launches from manual delegations.
  parentRunId?: string | null;
  rootRunId?: string | null;
  launchMode?: "auto" | "manual";
  // M37 Phase 8 (ADR-099): a persistent child parks between turns and is
  // re-addressable by `addressableKey` within its orchestrator tree (unique on
  // (root_run_id, addressable_key) among persistent rows). `addressableKey` is
  // REQUIRED when `persistent` is set.
  persistent?: boolean;
  addressableKey?: string | null;
  // M37 Phase 10 (ADR-099): worktree allocation mode for a delegated child.
  // `own` (default/null) = a per-run worktree; `shared` = all children of one
  // rootRunId point at a single pre-allocated tree (serialized writers via the
  // scheduler promote-time guard). A `shared` request with no rootRunId is
  // refused (CONFIG) — a top-level run has no tree to share.
  workspaceMode?: "own" | "shared" | null;
  // M37 (ADR-100): an explicit per-child workspace axis OVERRIDE. When set by a
  // delegation (run_delegate / run_plan), it wins over the agent definition's
  // declared `workspace` — so a coordinator can request a `none`/`repo_read`
  // child (exits Done, no Review round-trip) or a `worktree` child (produces a
  // diff to promote/rework). Absent/null ⇒ the agent-def default (unchanged).
  workspace?: "none" | "repo_read" | "worktree" | null;
  db?: Db;
};

export type LaunchAgentRunResult =
  | { runId: string; status: "Running" | "Pending"; queuePosition?: number }
  | { deduped: true; triggerEventId: number };

export type AgentLaunchErrorKind =
  | "not_registered"
  | "not_attached"
  | "disabled"
  | "quarantined"
  | "destructive"
  | "subagent"
  | "trigger_missing"
  | "project_missing"
  | "task_mismatch"
  // M39 (ADR-106): the agent declares a flow_ref but the same-package flow is
  // not configured/enabled in the project.
  | "flow_unconfigured";

export class AgentLaunchError extends MaisterError {
  readonly kind: AgentLaunchErrorKind;

  constructor(
    kind: AgentLaunchErrorKind,
    code: MaisterErrorCode,
    message: string,
  ) {
    super(code, message);
    this.name = "AgentLaunchError";
    this.kind = kind;
    Object.setPrototypeOf(this, AgentLaunchError.prototype);
  }
}

export function isAgentLaunchError(err: unknown): err is AgentLaunchError {
  return err instanceof AgentLaunchError;
}

export function hidesAgentExistenceForLaunch(err: unknown): boolean {
  return (
    isAgentLaunchError(err) &&
    (err.kind === "not_registered" || err.kind === "not_attached")
  );
}

export function publicAgentLaunchMessage(err: AgentLaunchError): string {
  if (err.kind === "quarantined") {
    return "agent is quarantined; admin review required";
  }

  return err.message;
}

export type LoadedAgentContext = {
  agent: Record<string, any>;
  // ADR-089 rework (RD4): the definition the launch actually runs — resolved
  // through THIS project's pinned package revision, behind enablement+trust.
  effective: EffectiveAgentDefinition;
  link: Record<string, any>;
  project: Record<string, any>;
};

export type AgentLaunchRuntime = LoadedAgentContext & {
  resolution: RunnerResolution;
};

type TaskCommentPromptRow = {
  id: string;
  body: string;
  actorType: "user" | "agent" | "system";
  actorId: string | null;
  createdAt: Date;
};

function runnerCatalogEntry(
  row: Record<string, any>,
  sidecarById: Map<string, Record<string, any>>,
): RunnerCatalogEntry {
  const sidecar = row.sidecarId ? sidecarById.get(row.sidecarId) : undefined;

  return {
    id: row.id,
    adapter: row.adapter,
    capabilityAgent: row.capabilityAgent,
    model: row.model,
    env: row.env,
    provider: row.provider,
    providerKind: row.provider?.kind ?? "anthropic",
    permissionPolicy: row.permissionPolicy,
    sidecar: sidecar
      ? ({
          id: sidecar.id,
          kind: sidecar.kind,
          lifecycle: sidecar.lifecycle,
          configPath: sidecar.configPath,
          baseUrl: sidecar.baseUrl,
          healthcheckUrl: sidecar.healthcheckUrl,
          authTokenRef: sidecar.authTokenRef,
        } satisfies RunnerSidecarSnapshot)
      : null,
    sidecarId: row.sidecarId,
    enabled: row.enabled,
    ready: row.readinessStatus === "Ready",
  };
}

async function loadAgentContext(
  _db: Db,
  input: LaunchAgentRunInput,
): Promise<LoadedAgentContext> {
  const agentRows = await _db
    .select()
    .from(agents)
    .where(eq(agents.id, input.agentId));
  const agent = agentRows[0];

  if (!agent) {
    throw new AgentLaunchError(
      "not_registered",
      "PRECONDITION",
      `agent "${input.agentId}" is not registered`,
    );
  }

  const linkRows = await _db
    .select()
    .from(agentProjectLinks)
    .where(
      and(
        eq(agentProjectLinks.agentId, input.agentId),
        eq(agentProjectLinks.projectId, input.projectId),
      ),
    );
  const link = linkRows[0];

  if (!link || !link.enabled) {
    throw new AgentLaunchError(
      "not_attached",
      "PRECONDITION",
      `agent "${input.agentId}" is not attached (enabled) to project ${input.projectId}`,
    );
  }

  if (!agent.enabled) {
    throw new AgentLaunchError(
      "disabled",
      "PRECONDITION",
      `agent "${input.agentId}" is disabled`,
    );
  }

  if (agent.quarantinedAt) {
    throw new AgentLaunchError(
      "quarantined",
      "PRECONDITION",
      `agent "${input.agentId}" is quarantined; un-quarantine it before launching`,
    );
  }

  // ADR-089 rework (RD4): everything below the platform kill-switches guards
  // against the EFFECTIVE definition — the agents/<stem>.md inside THIS
  // project's pinned package revision (enablement+trust gated). A pinned
  // version that lacks the trigger (pin divergence) refuses here even though
  // the index row advertised it to the dispatcher.
  const effective = await resolveEffectiveAgentDefinition(
    { agentId: input.agentId, projectId: input.projectId },
    _db,
  );

  if (effective.parsed.riskTier === "destructive") {
    throw new AgentLaunchError(
      "destructive",
      "PRECONDITION",
      `agent "${input.agentId}" is risk_tier=destructive — gated until capability enforcement lands (ADR-041)`,
    );
  }

  if (effective.parsed.mode !== "session") {
    throw new AgentLaunchError(
      "subagent",
      "PRECONDITION",
      `agent "${input.agentId}" is mode=subagent — flow-bound only, not launchable standalone`,
    );
  }

  if (!effective.parsed.triggers.includes(input.trigger.source)) {
    throw new AgentLaunchError(
      "trigger_missing",
      "PRECONDITION",
      `agent "${input.agentId}" does not declare the "${input.trigger.source}" trigger`,
    );
  }

  const projectRows = await _db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId));
  const project = projectRows[0];

  if (!project || project.archivedAt) {
    throw new AgentLaunchError(
      "project_missing",
      "PRECONDITION",
      `project ${input.projectId} is missing or archived`,
    );
  }

  if (input.taskId) {
    const taskRows = await _db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId)),
      );

    if (!taskRows[0]) {
      throw new AgentLaunchError(
        "task_mismatch",
        "PRECONDITION",
        `task ${input.taskId} is not in project ${input.projectId}`,
      );
    }
  }

  return { agent, effective, link, project };
}

async function resolveRunnerForAgent(
  _db: Db,
  ctx: LoadedAgentContext,
  launchOverrideRunnerId: string | null | undefined,
): Promise<RunnerResolution> {
  const runtimeRows = await _db
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"));
  const platformRuntime = runtimeRows[0];

  if (!platformRuntime) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "platform default ACP runner is not configured",
    );
  }

  const runnerRows = await _db.select().from(platformAcpRunners);
  const sidecarRows = await _db.select().from(platformRouterSidecars);
  const sidecarById = new Map<string, Record<string, any>>(
    sidecarRows.map((row: Record<string, any>) => [row.id, row]),
  );

  return resolveAgentRunner({
    launchOverrideRunnerId,
    link: { runnerOverrideId: ctx.link.runnerOverrideId },
    agent: {
      runnerId: ctx.effective.parsed.runner,
      mode: ctx.effective.parsed.mode,
      workspace: ctx.effective.parsed.workspace,
    },
    project: { defaultRunnerId: ctx.project.defaultRunnerId },
    platform: { defaultRunnerId: platformRuntime.defaultRunnerId },
    runners: runnerRows.map((row: Record<string, any>) =>
      runnerCatalogEntry(row, sidecarById),
    ),
  });
}

export async function resolveAgentLaunchRuntime(
  input: LaunchAgentRunInput,
): Promise<AgentLaunchRuntime> {
  const _db = input.db ?? getDb();
  const ctx = await loadAgentContext(_db, input);
  const resolution = await resolveRunnerForAgent(
    _db,
    ctx,
    input.launchOverrideRunnerId,
  );

  return { ...ctx, resolution };
}

export function agentWorkdirPath(projectSlug: string, runId: string): string {
  return path.join(worktreesRoot(), projectSlug, runId);
}

// M37 Phase 10 (ADR-099): the SHARED worktree for an orchestrator tree —
// keyed by the tree root, so every shared-mode child of the same rootRunId
// resolves to one tree. Deterministic from rootRunId, so the 2nd shared child
// recomputes the same path and reuses the tree the 1st allocated.
export function sharedAgentWorktreePath(
  projectSlug: string,
  rootRunId: string,
): string {
  return path.join(worktreesRoot(), projectSlug, "agents", rootRunId);
}

function branchSafeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function agentWorktreeBranchName(input: {
  prefix: string;
  agentId: string;
  runId: string;
}): string {
  const safeAgentId = branchSafeSegment(input.agentId);

  return `${input.prefix}agent-${safeAgentId}-${input.runId.slice(0, 8)}`;
}

// ADR-090 rework (workspace_ref): the EPHEMERAL read-only checkout for a
// repo_read run pinned to a trigger-derived ref. Deterministic from the run
// id — the terminal choke point derives it back without any schema state.
export function agentReadOnlyWorkdirPath(
  projectSlug: string,
  runId: string,
): string {
  return path.join(worktreesRoot(), projectSlug, `${runId}-ro`);
}

async function pathIsDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// Resolve `workspace_ref` to a committish (v1, owner decision 8):
// - a literal value is a branch/ref name resolved against the local repo;
// - `trigger` derives from the trigger context — run.* domain events use the
//   triggering run's workspace branch, webhooks use the conventional payload
//   `branch` (fallback `ref`) field; every other source refuses.
// Unresolvable refs refuse (no auto-fetch in v1).
export async function resolveWorkspaceRefCommittish(
  _db: Db,
  args: {
    agentId: string;
    workspaceRef: string;
    repoPath: string;
    trigger: {
      source: AgentTriggerSource;
      eventId?: number | bigint | null;
      payload?: Record<string, unknown> | null;
    };
  },
): Promise<string> {
  let ref: string;

  if (args.workspaceRef !== "trigger") {
    ref = args.workspaceRef;
  } else if (args.trigger.source === "webhook") {
    const payload = args.trigger.payload ?? {};
    const fromPayload =
      typeof payload.branch === "string" && payload.branch.length > 0
        ? payload.branch
        : typeof payload.ref === "string" && payload.ref.length > 0
          ? payload.ref
          : null;

    if (!fromPayload) {
      throw new MaisterError(
        "PRECONDITION",
        `agent "${args.agentId}": workspace_ref=trigger needs a webhook payload \`branch\` (or \`ref\`) field`,
      );
    }
    ref = fromPayload;
  } else if (args.trigger.source === "domain_event") {
    if (args.trigger.eventId == null) {
      throw new MaisterError(
        "PRECONDITION",
        `agent "${args.agentId}": workspace_ref=trigger needs the triggering domain event`,
      );
    }

    const eventRows = await _db
      .select({ kind: domainEvents.kind, runId: domainEvents.runId })
      .from(domainEvents)
      .where(eq(domainEvents.id, args.trigger.eventId));
    const event = eventRows[0];

    if (!event || !String(event.kind).startsWith("run.") || !event.runId) {
      throw new MaisterError(
        "PRECONDITION",
        `agent "${args.agentId}": workspace_ref=trigger derives a ref only from run.* events (got ${event?.kind ?? "missing event"})`,
      );
    }

    const wsRows = await _db
      .select({ branch: workspaces.branch })
      .from(workspaces)
      .where(eq(workspaces.runId, event.runId));
    const branch = wsRows[0]?.branch as string | undefined;

    if (!branch) {
      throw new MaisterError(
        "PRECONDITION",
        `agent "${args.agentId}": triggering run ${event.runId} has no workspace branch to check out`,
      );
    }
    ref = branch;
  } else {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${args.agentId}": workspace_ref=trigger is not derivable from a "${args.trigger.source}" launch — configure a literal branch instead`,
    );
  }

  // PRECONDITION on an unresolvable ref — v1 never auto-fetches.
  return resolveBaseCommit({
    projectRepoPath: args.repoPath,
    baseRef: ref,
  });
}

// M39 (ADR-106): an agent declaring a same-package flow_ref drives that flow as
// a NORMAL flow run (run_kind='flow', flow pool, worktree, the flow engine —
// reusing the board launch path `launchRun`) carrying runs.agent_id; the graph
// M39 (ADR-106): the loser of a CONCURRENT trigger redelivery (it reused the
// winner's auto-task) converges to the winner's run instead of launching its own
// (which would collide on the shared task's branch). The winner's run row may not
// be committed the instant we lose the task claim, so this is a one-shot BOUNDED
// convergence on the (agent_id, trigger_event_id) claim — NOT state-polling. If the
// winner fails in the narrow pre-insert window, fall back to a deduped marker (the
// winner's own error path surfaces that failure).
async function convergeToTriggerWinner(
  _db: Db,
  agentId: string,
  triggerEventId: number,
): Promise<LaunchAgentRunResult> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const winner = await _db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(
        and(eq(runs.agentId, agentId), eq(runs.triggerEventId, triggerEventId)),
      );

    if (winner[0]) {
      return {
        runId: winner[0].id as string,
        status: winner[0].status as "Running" | "Pending",
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  log.warn(
    { agentId, triggerEventId },
    "concurrent redelivery winner run not observed — deduped",
  );

  return { deduped: true, triggerEventId };
}

// runner injects the agent persona on every ai_coding node. The graph runner
// derives promotion/branch/board from a task, so a task-less trigger
// (cron/webhook/event) auto-creates one (owner decision, M39).
async function launchAgentDrivenFlowRun(
  _db: Db,
  ctx: LoadedAgentContext,
  input: LaunchAgentRunInput,
): Promise<LaunchAgentRunResult> {
  const flowRef = ctx.effective.parsed.flow as string;

  // flows.flow_ref_id IS the manifest flow id, and a package install enables its
  // member flows — so the attached+trusted agent's flow resolves to the
  // project's enabled flow row of the same ref.
  const flowRows = await _db
    .select({ id: flows.id })
    .from(flows)
    .where(
      and(eq(flows.projectId, input.projectId), eq(flows.flowRefId, flowRef)),
    );
  const flow = flowRows[0];

  if (!flow) {
    throw new AgentLaunchError(
      "flow_unconfigured",
      "PRECONDITION",
      `agent "${input.agentId}" declares flow "${flowRef}", but that flow is not configured in project ${input.projectId}`,
    );
  }

  let taskId = input.taskId ?? null;

  if (!taskId) {
    const { createTask } = await import("@/lib/services/tasks");
    const created = await createTask(
      {
        title: `${ctx.effective.parsed.name} (${input.trigger.source})`,
        prompt: ctx.effective.parsed.prompt,
        flowId: flow.id as string,
        // ADR-106: carry the trigger claim so a concurrent redelivery converges
        // to ONE auto-task (createTask dedups on (agent_id, trigger_event_id)).
        agentId: input.agentId,
        triggerEventId: input.trigger.eventId ?? null,
      },
      { projectId: input.projectId, actorUserId: null },
      _db,
    );

    taskId = created.taskId;

    // ADR-106: a deduped auto-task means a CONCURRENT redelivery already claimed
    // this trigger and the winner is creating the run. Do NOT launch our own run
    // (it would collide on the shared task's branch) — converge to the winner's.
    if (created.deduped && input.trigger.eventId != null) {
      return convergeToTriggerWinner(_db, input.agentId, input.trigger.eventId);
    }
  }

  // M39 Phase 5 (ADR-106): a flow-driving agent imposes ITS runner policy on the
  // flow run (autoApply → the flow's existing B1/B2 enforcement, onBudgetBreach →
  // the budget axis). Pass it as an OVERLAY (not a wholesale launch override) so
  // launchRun resolves its own task/project base first and the agent axes fold on
  // top — inherited axes such as budget limits survive. null when the agent
  // declares neither axis, so the flow keeps its task/project default untouched.
  const instancePolicy = ctx.link
    .executionPolicyOverride as AgentExecutionPolicyRecommendation | null;
  const recommendedPolicy =
    ctx.effective.parsed.recommended?.executionPolicy ?? null;
  const autoApply = instancePolicy?.autoApply ?? recommendedPolicy?.autoApply;
  const onBudgetBreach =
    instancePolicy?.onBudgetBreach ?? recommendedPolicy?.onBudgetBreach;
  const agentPolicyOverlay: AgentExecutionPolicyRecommendation | null =
    autoApply || onBudgetBreach ? { autoApply, onBudgetBreach } : null;

  // ADR-106: the flow run forks from the agent's branch base (instance override →
  // recommended → the flow's own task/project default when the agent declares
  // none). launchRun validates a declared base against the project's branches.
  const declaredBranchBase =
    ctx.link.branchBase ??
    ctx.effective.parsed.recommended?.branch_base ??
    null;

  // Only the auto-task claim WINNER (or a task-bound launch) reaches here, so the
  // run insert never contends on (agent_id, trigger_event_id) on the live path —
  // the partial unique index stays the backstop, not a hot conflict.
  const { launchRun } = await import("@/lib/services/runs");
  const result = await launchRun(
    {
      taskId,
      flowId: flow.id as string,
      agentId: input.agentId,
      // Trigger provenance carries the (agent_id, trigger_event_id) dedup claim
      // onto the flow run so an at-least-once redelivery converges to one run.
      triggerSource: input.trigger.source,
      triggerEventId: input.trigger.eventId ?? null,
      triggerPayload: input.trigger.payload ?? null,
      ...(declaredBranchBase ? { baseBranch: declaredBranchBase } : {}),
      ...(agentPolicyOverlay ? { agentPolicyOverlay } : {}),
    },
    { authorize: async () => {}, actorUserId: null },
    _db,
  );

  return {
    runId: result.runId,
    status: result.status as "Running" | "Pending",
    ...(result.queuePosition !== undefined
      ? { queuePosition: result.queuePosition }
      : {}),
  };
}

export async function launchAgentRun(
  input: LaunchAgentRunInput,
): Promise<LaunchAgentRunResult> {
  const _db = input.db ?? getDb();
  const ctx = await loadAgentContext(_db, input);

  // Fast trigger-event dedup BEFORE any side effect (task auto-create, worktree,
  // run insert) — covering BOTH the flow-driving and standalone paths. The
  // partial unique index on runs(agent_id, trigger_event_id) is the authoritative
  // race backstop; this pre-check converges an at-least-once redelivery to one
  // run without leaving an orphan task/worktree on the common sequential path.
  if (input.trigger.eventId != null) {
    const existing = await _db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.agentId, input.agentId),
          eq(runs.triggerEventId, input.trigger.eventId),
        ),
      );

    if (existing[0]) {
      log.info(
        { agentId: input.agentId, triggerEventId: input.trigger.eventId },
        "agent trigger already claimed — dedup",
      );

      return { deduped: true, triggerEventId: input.trigger.eventId };
    }
  }

  // M39 (ADR-106): branch on the flow_ref discriminant BEFORE the standalone
  // routing — an agent that declares a same-package flow drives that flow
  // (run_kind='flow', persona on every ai_coding node), not a standalone session.
  if (ctx.effective.parsed.flow) {
    return launchAgentDrivenFlowRun(_db, ctx, input);
  }

  const resolution = await resolveRunnerForAgent(
    _db,
    ctx,
    input.launchOverrideRunnerId,
  );

  const runId = randomUUID();
  // M37 (ADR-100): an explicit delegation `workspace` overrides the agent-def
  // axis; absent ⇒ the agent's declared default.
  const workspace = input.workspace ?? ctx.effective.parsed.workspace;

  // M37 Phase 8 (ADR-099): a persistent child must carry an addressable_key —
  // it is the re-message handle. Uniqueness within the tree is enforced by the
  // partial index (mapped to CONFLICT below); this guards the NOT-NULL contract
  // before any side effect.
  if (input.persistent && !input.addressableKey) {
    throw new MaisterError(
      "CONFIG",
      "a persistent child requires an addressableKey",
    );
  }

  // M37 Phase 10 (ADR-099): a shared worktree is keyed by the tree root, so a
  // top-level run (no rootRunId) has no tree to share. Refuse before any side
  // effect.
  if (input.workspaceMode === "shared" && !input.rootRunId) {
    throw new MaisterError(
      "CONFIG",
      "workspaceMode=shared requires a delegated child with a rootRunId — a top-level run cannot share a tree",
    );
  }

  // M37 follow-up (ADR-102): the shared WRITABLE-worktree review/promote model is
  // now specified — per-tree Review + an orchestrator-driven tree-promote that
  // resolves the tree workspace by (root_run_id, workspace_mode='shared'), merges
  // once, and settles ALL shared siblings Review→Done. The former launch gate is
  // therefore removed: the shared-allocation block below allocates (or reuses) the
  // tree, finalizeAgentRun lands every shared writable child in Review, and promote
  // settles the tree. The `!input.rootRunId` gate above still stands (a top-level
  // run has no tree to share). `workspaceMode=own` (default) is unaffected.

  // M37 Phase 8 (ADR-099): the addressable_key must be free within the
  // orchestrator tree. The child's tree root is rootRunId (always set for a
  // delegated persistent child) else its own id. This pre-check is the common
  // path; the partial unique index is the race backstop (23505 → CONFLICT).
  if (input.persistent && input.addressableKey) {
    const treeRoot = input.rootRunId ?? runId;
    const keyClash = await _db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.rootRunId, treeRoot),
          eq(runs.addressableKey, input.addressableKey),
          eq(runs.persistent, true),
        ),
      );

    if (keyClash[0]) {
      throw new MaisterError(
        "CONFLICT",
        `a persistent child with addressableKey "${input.addressableKey}" already exists in this orchestrator tree`,
      );
    }
  }

  // ADR-090: a repo_read run against the PARENT checkout is only verifiable
  // from a clean baseline. With workspace_ref the run gets an EPHEMERAL
  // detached checkout instead — clean by construction, so the baseline check
  // is skipped and the ref must resolve NOW (launch-surface PRECONDITION).
  if (workspace === "repo_read") {
    if (ctx.effective.parsed.workspaceRef) {
      await resolveWorkspaceRefCommittish(_db, {
        agentId: input.agentId,
        workspaceRef: ctx.effective.parsed.workspaceRef,
        repoPath: ctx.project.repoPath,
        trigger: input.trigger,
      });
    } else {
      const porcelain = await statusPorcelain({
        worktreePath: ctx.project.repoPath,
      });

      if (porcelain.trim() !== "") {
        throw new MaisterError(
          "PRECONDITION",
          `repo_read agent launch refused: parent checkout ${ctx.project.repoPath} is dirty — commit or stash first`,
        );
      }
    }
  }

  let worktreePath: string | null = null;
  let branch: string | null = null;
  let baseCommit: string | null = null;
  // ADR-106: the resolved worktree base (instance → recommended → project main);
  // forks the worktree and is the promote target on the workspaces row. Stays
  // project main for non-worktree modes (unused there).
  let resolvedBranchBase = ctx.project.mainBranch;
  // M37 Phase 10 (ADR-099): a shared-mode child whose tree a sibling already
  // allocated reuses that tree — it gets NO workspaces row of its own (the
  // worktree_path column is UNIQUE; the allocating sibling owns the record).
  // startAgentSession recomputes the shared cwd from workspace_mode + rootRunId.
  let reuseSharedTree = false;
  // F3 (ADR-102): true ONLY when THIS launch actually ran addWorktree (an
  // allocator). The teardown on a deduped/failed insert must remove only a dir we
  // created — never a reused tree (sibling-owned) NOR an orphan dir we merely
  // claimed (a crashed prior launch's work).
  let allocatedWorktree = false;
  const isShared = input.workspaceMode === "shared" && input.rootRunId != null;

  if (workspace === "worktree") {
    // ADR-106: resolve the worktree base — instance link override → agent
    // recommended → project main — and validate a DECLARED (non-fallback) base
    // against the project's branches BEFORE any git side-effect, so an unknown
    // ref is a clean PRECONDITION rather than a raw git failure.
    const declaredBranchBase =
      ctx.link.branchBase ??
      ctx.effective.parsed.recommended?.branch_base ??
      null;

    resolvedBranchBase = declaredBranchBase ?? ctx.project.mainBranch;

    if (declaredBranchBase) {
      const knownBranches = new Set(await listBranches(ctx.project.repoPath));

      if (!knownBranches.has(declaredBranchBase)) {
        throw new MaisterError(
          "PRECONDITION",
          `branch base "${declaredBranchBase}" does not exist in ${ctx.project.slug}`,
        );
      }
    }

    if (isShared) {
      const rootRunId = input.rootRunId as string;

      branch = `${ctx.project.branchPrefix ?? "maister/"}agents/${rootRunId}`;
      worktreePath = sharedAgentWorktreePath(ctx.project.slug, rootRunId);

      // F3 (ADR-102): the allocator-vs-reuser decision is DB-truth, NOT a bare
      // filesystem observation. A crash between addWorktree (git, outside the tx)
      // and the workspaces insert leaves an ORPHAN path on disk with no row;
      // trusting listWorktrees there made every later sibling "reuse" the path and
      // skip the insert, so the tree NEVER got a row (unresolvable for promote/diff/
      // GC). The `workspaces` row is the source of truth.
      const treeRow = await findSharedTreeWorkspace(_db, rootRunId);

      if (treeRow) {
        // A row exists ⇒ a sibling genuinely allocated the tree. Reuse the dir,
        // own no row.
        reuseSharedTree = true;
      } else {
        // No row ⇒ THIS child owns the tree's row. Branch on whether the dir is
        // already present.
        const existing = await listWorktrees(ctx.project.repoPath);

        if (existing.some((w) => w.path === worktreePath)) {
          // ORPHAN-CLAIM: the path exists from a crashed prior allocation with no
          // surviving row. Reuse the dir (do NOT addWorktree — it would fail on the
          // existing path/branch) and claim the row below. The true base is lost;
          // promote/diff tolerate base_commit=null.
          baseCommit = null;
          log.warn(
            { rootRunId, worktreePath },
            "shared tree orphan path claimed — no prior workspaces row",
          );
        } else {
          // ALLOCATOR: create the worktree.
          baseCommit = await resolveBaseCommit({
            projectRepoPath: ctx.project.repoPath,
            baseRef: resolvedBranchBase,
          });

          try {
            await addWorktree({
              projectRepoPath: ctx.project.repoPath,
              worktreePath,
              branch,
              startPoint: resolvedBranchBase,
            });
            allocatedWorktree = true;
          } catch (err) {
            // M37 (ADR-100): a concurrent shared-mode sibling can allocate the tree
            // between the listWorktrees check and this add (TOCTOU). Re-check the
            // registry: if the path now exists, the sibling won the race — reuse the
            // dir and claim-as-orphan (base lost), letting the insert's
            // onConflictDoNothing arbitrate the single row. Otherwise it is a genuine
            // git failure → surface as a typed CONFLICT, never a raw 500.
            const after = await listWorktrees(ctx.project.repoPath);

            if (after.some((w) => w.path === worktreePath)) {
              baseCommit = null;
            } else {
              throw new MaisterError(
                "CONFLICT",
                `shared worktree allocation failed for tree ${rootRunId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        }
      }

      // M37 (ADR-102): record the allocator-vs-reuser decision for the shared
      // tree. The allocator/claimer owns the single `workspaces` row (UNIQUE
      // worktree_path, inserted with onConflictDoNothing); a reuser child gets none
      // and the tree is resolved by root_run_id at promote.
      log.info(
        {
          rootRunId: input.rootRunId,
          worktreePath,
          branch,
          decision: reuseSharedTree ? "reuse" : "allocate",
        },
        reuseSharedTree
          ? "shared worktree tree reused by sibling (no workspaces row of its own)"
          : "shared worktree tree allocated (this child owns the workspaces row)",
      );
    } else {
      branch = agentWorktreeBranchName({
        prefix: ctx.project.branchPrefix ?? "maister/",
        agentId: input.agentId,
        runId,
      });
      worktreePath = agentWorkdirPath(ctx.project.slug, runId);
      baseCommit = await resolveBaseCommit({
        projectRepoPath: ctx.project.repoPath,
        baseRef: resolvedBranchBase,
      });
      await addWorktree({
        projectRepoPath: ctx.project.repoPath,
        worktreePath,
        branch,
        startPoint: resolvedBranchBase,
      });
      allocatedWorktree = true;
    }
  }

  // M39 Phase 5 (ADR-106): resolve the effective runner policy (autoApply →
  // B1/B2 axes, onBudgetBreach → the budget-terminal axis) in the Q3 order
  // instance-override → agent recommended → project execution-policy default
  // (then the supervised floor), and snapshot it onto the run so the budget
  // watchdog + HITL boundary read the snapshot (never a post-launch projection).
  // The project base is load-bearing: it carries the budget axis the agent
  // recommendation never declares, so a project token ceiling actually binds an
  // agent run.
  const executionPolicy = applyDefaultBudgetForUnattended(
    resolveAgentExecutionPolicy({
      instanceOverride: ctx.link
        .executionPolicyOverride as AgentExecutionPolicyRecommendation | null,
      recommended: ctx.effective.parsed.recommended?.executionPolicy ?? null,
      base: resolveExecutionPolicy({
        projectDefault: ctx.project
          .executionPolicyDefault as ExecutionPolicy | null,
      }),
    }),
  );

  // ADR-111 (D5): resolve the effective agent config ONCE here and snapshot it
  // onto the run row. buildAgentPrompt reads THIS snapshot at spawn — never
  // re-resolving from the (mutable) definition/link. null when the agent
  // declares no config (the column stays null).
  const resolvedConfig = resolveAgentConfig(
    ctx.effective.parsed.config,
    (ctx.link.config as Record<string, unknown> | null) ?? null,
  );
  const agentConfig =
    Object.keys(resolvedConfig).length > 0 ? resolvedConfig : null;

  log.debug(
    {
      runId,
      agentId: input.agentId,
      configKeys: agentConfig ? Object.keys(agentConfig) : [],
    },
    "[ADR-111] resolved agent config snapshot",
  );

  const runRow = {
    id: runId,
    runKind: "agent" as const,
    agentId: input.agentId,
    executionPolicy,
    agentConfig,
    triggerSource: input.trigger.source,
    triggerEventId: input.trigger.eventId ?? null,
    triggerPayload: input.trigger.payload ?? null,
    agentWorkspace: workspace,
    taskId: input.taskId ?? null,
    projectId: input.projectId,
    flowId: null,
    runnerId: resolution.runnerId,
    runnerResolutionTier: resolution.runnerResolutionTier,
    capabilityAgent: resolution.capabilityAgent,
    runnerSnapshot: resolution.runnerSnapshot,
    status: "Pending" as const,
    currentStepId: "agent",
    flowVersion: "agent",
    flowRevision: "manual",
    // M37 (ADR-098): run-tree linkage. delegation_snapshot records the CHILD's
    // launch-time effective agent-def (skill-context rule 207 — id + pinned
    // revision only; the resolved runner stays in runner_snapshot above). Set
    // only for a delegated child (parentRunId present).
    parentRunId: input.parentRunId ?? null,
    rootRunId: input.rootRunId ?? null,
    launchMode: input.launchMode ?? null,
    delegationSnapshot: input.parentRunId
      ? {
          agentDefinitionId: input.agentId,
          revisionId: ctx.effective.packageInstallId,
        }
      : null,
    // M37 Phase 8 (ADR-099): persistent swarm-member flags.
    persistent: input.persistent ?? false,
    addressableKey: input.addressableKey ?? null,
    // M37 Phase 10 (ADR-099): worktree allocation mode — read by the scheduler
    // serialization guard and by startAgentSession's shared-cwd resolution.
    workspaceMode: input.workspaceMode ?? null,
  };

  assertRunKindInvariant({
    id: runId,
    runKind: "agent",
    taskId: runRow.taskId,
    flowId: null,
    flowRevisionId: null,
    flowVersion: runRow.flowVersion,
    flowRevision: runRow.flowRevision,
    agentId: input.agentId,
  });

  try {
    const inserted = await _db.transaction(async (tx: Db) => {
      // Claim-first: the INSERT itself is the at-least-once dedup claim. The
      // persistent addressable_key uniqueness is enforced by the pre-insert
      // check above (the deterministic path); the partial index is the
      // last-line backstop against a duplicate ROW (a true insert race just
      // dedups here — no duplicate is ever written).
      const rows = await tx
        .insert(runs)
        .values(runRow)
        .onConflictDoNothing()
        .returning({ id: runs.id });

      if (rows.length === 0) return false;

      // M42 (ADR-114): a standalone agent run is a single-`default`-session run.
      await tx.insert(runSessions).values({
        id: randomUUID(),
        ...defaultRunSessionValues(runId, resolution),
      });

      // A reused shared tree already has a workspaces row owned by its allocator
      // (worktree_path is UNIQUE), so a reusing sibling inserts none. F3
      // (ADR-102): the allocator/orphan-claimer insert is onConflictDoNothing on
      // worktree_path so two concurrent allocators/claimers don't 23505 — one
      // inserts, the other no-ops (its run still launches; the tree keeps exactly
      // one row).
      if (
        workspace === "worktree" &&
        worktreePath &&
        branch &&
        !reuseSharedTree
      ) {
        await tx
          .insert(workspaces)
          .values({
            id: randomUUID(),
            runId,
            projectId: input.projectId,
            branch,
            worktreePath,
            parentRepoPath: ctx.project.repoPath,
            baseBranch: resolvedBranchBase,
            baseCommit,
            targetBranch: resolvedBranchBase,
          })
          .onConflictDoNothing({ target: workspaces.worktreePath });
      }

      return true;
    });

    if (!inserted) {
      // Only tear down a worktree THIS launch created — never a shared tree a
      // sibling owns, nor an orphan dir we merely claimed (F3).
      if (worktreePath && allocatedWorktree) {
        await removeWorktree({
          projectRepoPath: ctx.project.repoPath,
          worktreePath,
        }).catch(() => undefined);
      }

      return {
        deduped: true,
        triggerEventId: input.trigger.eventId ?? -1,
      };
    }
  } catch (err) {
    if (worktreePath && allocatedWorktree) {
      await removeWorktree({
        projectRepoPath: ctx.project.repoPath,
        worktreePath,
      }).catch(() => undefined);
    }
    throw err;
  }

  if (workspace === "none") {
    await mkdir(agentWorkdirPath(ctx.project.slug, runId), {
      recursive: true,
    });
  }

  const startResult = await tryStartRun(runId, { db: _db });

  log.info(
    {
      runId,
      agentId: input.agentId,
      projectId: input.projectId,
      trigger: input.trigger.source,
      workspace,
      runnerId: resolution.runnerId,
      tier: resolution.runnerResolutionTier,
      started: startResult.started,
    },
    "agent run launched",
  );

  if (startResult.started) {
    queueMicrotask(() => {
      void startAgentSession(runId).catch((err: unknown) => {
        log.error(
          { runId, err: err instanceof Error ? err.message : String(err) },
          "startAgentSession dispatch threw",
        );
      });
    });

    return { runId, status: "Running" };
  }

  return {
    runId,
    status: "Pending",
    queuePosition: startResult.queuePosition,
  };
}

function triggerContextBlock(run: Record<string, any>): string {
  switch (run.triggerSource) {
    case "domain_event":
      return [
        "## Trigger",
        `Domain event id ${run.triggerEventId ?? "?"}:`,
        "```json",
        JSON.stringify(run.triggerPayload ?? {}, null, 2),
        "```",
      ].join("\n");
    case "webhook":
      return [
        "## Trigger",
        "Inbound webhook payload:",
        "```json",
        JSON.stringify(run.triggerPayload ?? {}, null, 2),
        "```",
      ].join("\n");
    case "cron":
      return "## Trigger\nScheduled cron fire.";
    default:
      return "## Trigger\nManual launch.";
  }
}

function domainEventKind(run: Record<string, any>): string | null {
  const triggerPayload = run.triggerPayload;

  if (
    triggerPayload === null ||
    typeof triggerPayload !== "object" ||
    Array.isArray(triggerPayload)
  ) {
    return null;
  }

  const kind = (triggerPayload as Record<string, unknown>).kind;

  return typeof kind === "string" ? kind : null;
}

function domainEventPayload(run: Record<string, any>): Record<string, unknown> {
  const triggerPayload = run.triggerPayload;

  if (
    triggerPayload === null ||
    typeof triggerPayload !== "object" ||
    Array.isArray(triggerPayload)
  ) {
    return {};
  }

  const payload = (triggerPayload as Record<string, unknown>).payload;

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return {};
  }

  return payload as Record<string, unknown>;
}

function commentActorLabel(row: TaskCommentPromptRow): string {
  return row.actorId ? `${row.actorType}:${row.actorId}` : row.actorType;
}

function sortCommentsAscending(
  rows: TaskCommentPromptRow[],
): TaskCommentPromptRow[] {
  return [...rows].sort((left, right) => {
    const byDate = left.createdAt.getTime() - right.createdAt.getTime();

    return byDate === 0 ? left.id.localeCompare(right.id) : byDate;
  });
}

function formatCommentForPrompt(row: TaskCommentPromptRow): string {
  return [
    `- ${row.createdAt.toISOString()} ${commentActorLabel(row)} (${row.id})`,
    ...row.body.split("\n").map((line) => `  ${line}`),
  ].join("\n");
}

async function taskCommentTriggerContextBlock(
  _db: Db,
  run: Record<string, any>,
): Promise<string> {
  if (
    run.triggerSource !== "domain_event" ||
    domainEventKind(run) !== "task.comment_added"
  ) {
    return "";
  }

  if (!run.taskId || typeof run.taskId !== "string") {
    throw new MaisterError(
      "PRECONDITION",
      `task.comment_added agent run ${run.id ?? "unknown"} has no task_id`,
    );
  }

  const payload = domainEventPayload(run);
  const commentId = payload.commentId;

  if (typeof commentId !== "string" || commentId.length === 0) {
    throw new MaisterError(
      "PRECONDITION",
      `task.comment_added agent run ${run.id ?? "unknown"} has no commentId payload`,
    );
  }

  const triggerRows = (await _db
    .select({
      id: taskComments.id,
      body: taskComments.body,
      actorType: taskComments.actorType,
      actorId: taskComments.actorId,
      createdAt: taskComments.createdAt,
    })
    .from(taskComments)
    .where(
      and(eq(taskComments.taskId, run.taskId), eq(taskComments.id, commentId)),
    )
    .limit(1)) as TaskCommentPromptRow[];
  const triggerComment = triggerRows[0];

  if (!triggerComment) {
    throw new MaisterError(
      "PRECONDITION",
      `task.comment_added agent run ${run.id ?? "unknown"} references missing comment ${commentId}`,
    );
  }

  const recentRows = (await _db
    .select({
      id: taskComments.id,
      body: taskComments.body,
      actorType: taskComments.actorType,
      actorId: taskComments.actorId,
      createdAt: taskComments.createdAt,
    })
    .from(taskComments)
    .where(eq(taskComments.taskId, run.taskId))
    .orderBy(desc(taskComments.createdAt), desc(taskComments.id))
    .limit(COMMENT_THREAD_TAIL_LIMIT)) as TaskCommentPromptRow[];
  const recentThread = sortCommentsAscending(recentRows);

  log.debug(
    {
      runId: run.id ?? null,
      taskId: run.taskId,
      commentId,
      recentThreadCount: recentThread.length,
    },
    "[FIX:agent-comment-context] task.comment_added prompt context loaded",
  );

  return [
    "## Triggering comment",
    formatCommentForPrompt(triggerComment),
    "",
    `## Recent task thread (last ${COMMENT_THREAD_TAIL_LIMIT})`,
    ...recentThread.map(formatCommentForPrompt),
  ].join("\n");
}

async function taskContextBlock(
  _db: Db,
  run: Record<string, any>,
): Promise<string> {
  if (!run.taskId) return "";

  const rows = await _db
    .select({
      number: tasks.number,
      title: tasks.title,
      prompt: tasks.prompt,
      taskKey: projects.taskKey,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, run.taskId));
  const task = rows[0];

  if (!task) return "";

  return [
    "## Task context",
    `${task.taskKey}-${task.number}: ${task.title}`,
    "",
    task.prompt,
  ].join("\n");
}

// ADR-111 (D5): the "Effective configuration" block is rendered from the
// launch-time SNAPSHOT on the run row (`run.agentConfig`), NEVER re-resolved
// from the (mutable) definition/link. The declaration only supplies a
// human-readable label + a stable order; the VALUE is whatever the snapshot
// holds. Returns "" when no config was snapshotted (a run with no declared
// config never writes the column).
function configContextBlock(
  parsed: ParsedAgentDefinition,
  run: Record<string, any>,
): string {
  const snapshot = run.agentConfig;

  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return "";
  }

  const config = snapshot as Record<string, unknown>;
  const keys = Object.keys(config);

  if (keys.length === 0) return "";

  const labelByKey = new Map<string, string>(
    (parsed.config ?? []).map((p) => [p.key, p.label ?? p.key]),
  );
  // Declared order first (stable), then any snapshot-only keys.
  const orderedKeys = [
    ...(parsed.config ?? []).map((p) => p.key).filter((k) => k in config),
    ...keys.filter((k) => !labelByKey.has(k)),
  ];

  return [
    "## Effective configuration",
    ...orderedKeys.map(
      (key) =>
        `- ${labelByKey.get(key) ?? key} (${key}): ${JSON.stringify(config[key])}`,
    ),
  ].join("\n");
}

// The prompt body comes from the EFFECTIVE definition (the project-pinned
// package revision, resolved by the caller at spawn time) — never from the
// catalog index row.
export async function buildAgentPrompt(
  _db: Db,
  parsed: ParsedAgentDefinition,
  run: Record<string, any>,
): Promise<string> {
  const sections = [parsed.prompt.trim()];
  const configBlock = configContextBlock(parsed, run);
  const taskBlock = await taskContextBlock(_db, run);
  const commentTriggerBlock = await taskCommentTriggerContextBlock(_db, run);

  // ADR-111 (D5): the config block lands right after the persona body and
  // BEFORE the task block — the agent reads its effective config first.
  if (configBlock) sections.push(configBlock);
  if (taskBlock) sections.push(taskBlock);
  if (commentTriggerBlock) sections.push(commentTriggerBlock);
  sections.push(triggerContextBlock(run));

  return sections.join("\n\n");
}

type ConsensusDraftPayload = {
  kind: "consensus_draft";
  nodeId: string;
  nodeAttemptId: string;
  round: number;
  participantId: string;
  participantKind: "agent" | "runner";
  prompt: string;
  workspaceMode: "repo_read";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function consensusDraftPayload(
  run: Record<string, any>,
): ConsensusDraftPayload | null {
  const payload = run.triggerPayload;

  if (!isRecord(payload) || payload.kind !== "consensus_draft") return null;

  if (
    typeof payload.nodeId !== "string" ||
    typeof payload.nodeAttemptId !== "string" ||
    typeof payload.round !== "number" ||
    typeof payload.participantId !== "string" ||
    (payload.participantKind !== "agent" &&
      payload.participantKind !== "runner") ||
    typeof payload.prompt !== "string" ||
    payload.workspaceMode !== "repo_read"
  ) {
    return null;
  }

  return payload as ConsensusDraftPayload;
}

function runnerDelegationSnapshot(
  value: unknown,
): Extract<DelegationSnapshot, { kind: "runner" }> | null {
  if (!isRecord(value) || value.kind !== "runner") return null;

  if (
    typeof value.runnerId !== "string" ||
    typeof value.participantId !== "string" ||
    typeof value.nodeId !== "string" ||
    typeof value.nodeAttemptId !== "string" ||
    typeof value.round !== "number" ||
    value.workspaceMode !== "repo_read"
  ) {
    return null;
  }

  return value as Extract<DelegationSnapshot, { kind: "runner" }>;
}

function consensusDraftPromptBlock(payload: ConsensusDraftPayload): string {
  return [
    "## Consensus draft request",
    payload.prompt,
    "",
    "Return an independent draft with concise evidence for the declared material axes. Do not modify repository files; this session is read-only.",
  ].join("\n");
}

function consensusAgentDraftPrompt(
  basePrompt: string,
  payload: ConsensusDraftPayload,
): string {
  return [basePrompt, consensusDraftPromptBlock(payload)].join("\n\n");
}

function appendCappedConsensusDraftOutput(
  current: string,
  chunk: string,
): string {
  const remaining = CONSENSUS_DRAFT_OUTPUT_CAP_BYTES - current.length;

  if (remaining <= 0) return current;

  return current + chunk.slice(0, remaining);
}

function consensusDraftUpdateText(update: unknown): string | null {
  if (!isRecord(update)) return null;
  if (update.sessionUpdate !== "agent_message_chunk") return null;

  const content = update.content;

  if (!isRecord(content) || content.type !== "text") return null;

  return typeof content.text === "string" ? content.text : null;
}

async function loadConsensusDraftPayload(
  db: Db,
  runId: string,
): Promise<ConsensusDraftPayload | null> {
  const rows = await db
    .select({ triggerPayload: runs.triggerPayload })
    .from(runs)
    .where(eq(runs.id, runId));
  const row = rows[0];

  return row ? consensusDraftPayload(row) : null;
}

async function recordConsensusDraftArtifact(args: {
  db: Db;
  runId: string;
  payload: ConsensusDraftPayload;
  text: string;
}): Promise<void> {
  const text = args.text.slice(0, CONSENSUS_DRAFT_OUTPUT_CAP_BYTES);

  if (text.trim().length === 0) {
    throw new MaisterError(
      "PRECONDITION",
      `consensus draft participant "${args.payload.participantId}" produced no text`,
    );
  }

  await recordArtifact(
    {
      id: `run:${args.runId}:consensus-draft:${args.payload.nodeAttemptId}:${args.payload.participantId}:r${args.payload.round}`,
      runId: args.runId,
      nodeId: "consensus-draft",
      artifactDefId: "default:consensus-draft",
      kind: "human_note",
      producer: "runner",
      locator: {
        kind: "inline",
        text,
      },
      validity: "current",
      visibility: "internal",
      retention: "run",
    },
    args.db,
  );
}

async function startConsensusRunnerDraftSession(args: {
  db: Db;
  api: AgentSupervisorApi;
  run: Record<string, any>;
  project: Record<string, any>;
  payload: ConsensusDraftPayload;
  snapshot: RunnerSnapshot;
}): Promise<void> {
  const runId = args.run.id as string;
  const cwd = args.project.repoPath as string;

  try {
    await materializeAgentReadOnlySettings(cwd).catch((err: unknown) => {
      log.warn(
        { runId, err: err instanceof Error ? err.message : String(err) },
        "L2 materialization failed — L1 carries consensus runner draft read-only contract",
      );
    });

    const session = await args.api.createSession({
      runId,
      projectSlug: args.project.slug,
      worktreePath: cwd,
      stepId: "agent",
      executor: runnerExecutorInput(args.snapshot),
      runner: runnerSupervisorInput({ snapshot: args.snapshot }),
      adapterLaunch: mergeRunnerAdapterLaunch(args.snapshot),
      readOnlySession: true,
      ...(args.run.acpSessionId
        ? { resumeSessionId: args.run.acpSessionId }
        : {}),
    });

    await args.db
      .update(runs)
      .set({ acpSessionId: session.acpSessionId })
      .where(eq(runs.id, runId));

    queueMicrotask(() => {
      void consumeAgentSession({
        db: args.db,
        api: args.api,
        runId,
        sessionId: session.sessionId,
      }).catch((err: unknown) => {
        log.error(
          { runId, err: err instanceof Error ? err.message : String(err) },
          "consensus runner draft session consumer threw",
        );
      });
    });

    await args.api.sendPrompt(session.sessionId, {
      stepId: "agent",
      prompt: consensusDraftPromptBlock(args.payload),
    });

    log.info(
      {
        runId,
        participantId: args.payload.participantId,
        nodeId: args.payload.nodeId,
        nodeAttemptId: args.payload.nodeAttemptId,
        round: args.payload.round,
        runnerId: args.run.runnerId ?? null,
      },
      "consensus runner draft session started",
    );
  } catch (err) {
    log.error(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "consensus runner draft session spawn/prompt failed",
    );
    await finalizeAgentRun(runId, "Failed", {
      db: args.db,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

type AgentTerminalOutcome = "Done" | "Failed" | "Crashed" | "Abandoned";
type AgentFinalStatus = AgentTerminalOutcome | "Review";

type AgentAssignmentClose =
  | {
      kind: "user";
      actorId: string;
      eventKind?: "cancelled" | "superseded" | "system_closed";
      reason?: string;
    }
  | {
      kind: "system";
      reason: string;
    };

type AgentFinalizeOptions = {
  db?: Db;
  reason?: string;
  closeOpenHitl?: boolean;
  closeAssignments?: AgentAssignmentClose;
};

const TERMINAL_CAS_SOURCE: Record<AgentTerminalOutcome, string[]> = {
  Done: ["Running", "NeedsInput"],
  Failed: ["Running", "NeedsInput"],
  Crashed: ["Running", "NeedsInput"],
  Abandoned: [
    "Pending",
    "Running",
    "NeedsInput",
    "NeedsInputIdle",
    "Review",
    "Crashed",
  ],
};

const DOMAIN_KIND_BY_OUTCOME: Record<
  AgentTerminalOutcome,
  "run.done" | "run.failed" | "run.crashed" | "run.abandoned"
> = {
  Done: "run.done",
  Failed: "run.failed",
  Crashed: "run.crashed",
  Abandoned: "run.abandoned",
};

const WEBHOOK_TYPE_BY_STATUS: Record<
  AgentFinalStatus,
  "run.review" | "run.done" | "run.failed" | "run.crashed" | "run.abandoned"
> = {
  Review: "run.review",
  Done: "run.done",
  Failed: "run.failed",
  Crashed: "run.crashed",
  Abandoned: "run.abandoned",
};

function finalStatusForCleanAgentExit(hasWorkspace: boolean): AgentFinalStatus {
  return hasWorkspace ? "Review" : "Done";
}

// The terminal choke point for agent runs (ADR-090 sequencing rule): the
// dirty-watchdog (Phase 4) and the token revoke run BEFORE/WITHIN the
// status-flip transaction; nothing writes the run row after the flip.
export async function finalizeAgentRun(
  runId: string,
  outcome: AgentTerminalOutcome,
  opts: AgentFinalizeOptions = {},
): Promise<{ finalized: boolean; status?: AgentFinalStatus }> {
  const _db = opts.db ?? getDb();

  // Set inside the transaction when the run used an ephemeral workspace_ref
  // checkout — removed AFTER the commit (fs cleanup must never roll back the
  // terminal flip; a failure leaves a stale dir the next spawn recreates).
  let ephemeralCleanup: { repoPath: string; worktreePath: string } | null =
    null;

  const finalizeResult = await _db.transaction(async (tx: Db) => {
    // M37 (ADR-102): read the shared-tree axes up front for the finalize
    // branch below. The CAS gates on status.
    const preRows = await tx
      .select({
        workspaceMode: runs.workspaceMode,
        agentWorkspace: runs.agentWorkspace,
      })
      .from(runs)
      .where(eq(runs.id, runId));
    // M37 (ADR-102): a shared writable-worktree child finalizes to Review even
    // when it owns no `workspaces` row (a reuser child — the allocator owns the
    // UNIQUE worktree_path). The shared tree is one branch = one diff, reviewed and
    // promoted once; a shared writable child is NEVER auto-Done on a clean exit.
    const isSharedWritableExit =
      preRows[0]?.workspaceMode === "shared" &&
      preRows[0]?.agentWorkspace === "worktree";

    const workspaceRows =
      outcome === "Done"
        ? await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.runId, runId))
        : [];
    const status =
      outcome === "Done"
        ? isSharedWritableExit
          ? "Review"
          : finalStatusForCleanAgentExit(workspaceRows.length > 0)
        : outcome;

    if (outcome === "Done") {
      log.debug(
        {
          runId,
          workspaceMode: preRows[0]?.workspaceMode ?? null,
          agentWorkspace: preRows[0]?.agentWorkspace ?? null,
          hasWorkspace: workspaceRows.length > 0,
          status,
        },
        "agent clean-exit final status",
      );
    }
    const endedAt = new Date();

    // M42 (ADR-114): the agent run's session resume handle lives on its
    // `run_sessions` row (sole source of truth) — a delegated child reaching
    // Review keeps it for run_rework session/resume; a terminal run is never
    // resumed (status-gated), so no run-level marker reset is needed here.
    const rows = await tx
      .update(runs)
      .set({
        status,
        endedAt,
        currentStepId: null,
      })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.runKind, "agent"),
          inArray(runs.status, TERMINAL_CAS_SOURCE[outcome]),
        ),
      )
      .returning({
        projectId: runs.projectId,
        taskId: runs.taskId,
        agentId: runs.agentId,
        agentWorkspace: runs.agentWorkspace,
        parentRunId: runs.parentRunId,
      });
    const row = rows[0];

    if (!row) return false;

    if (status === "Abandoned") {
      const scheduledRemovalAt = new Date(
        endedAt.getTime() + gcAgeDays() * 86_400_000,
      );

      await tx
        .update(workspaces)
        .set({ scheduledRemovalAt })
        .where(eq(workspaces.runId, runId));
    }

    // ADR-090 L3 (terminal choke point): the dirty-watchdog runs WITHIN the
    // status-flip transaction — a repo_read run that left the parent
    // checkout dirty quarantines its agent atomically with the terminal
    // write. The porcelain read is read-only git; a failure here rolls the
    // flip back and the reconcile sweep re-finalizes later.
    if (row.agentId) {
      const wsCtx = await loadAgentWorkspaceContext(
        tx,
        row.agentId,
        row.projectId,
      );
      // Gate on the workspace the run ACTUALLY launched with (persisted at
      // insert from the project's effective pin), NOT the catalog index — the
      // index projects the newest revision and can diverge from the pin,
      // which would silently skip L3 and leak the ephemeral checkout. Fall
      // back to the index only for rows that predate agent_workspace.
      const ranAs = row.agentWorkspace ?? wsCtx?.workspace;

      // M37 Phase 10 (ADR-099): L3 guards repo_read ONLY. A shared WRITE tree
      // (workspace=worktree, workspace_mode='shared') is intentionally dirtied
      // by multiple children, so the dirty-watchdog does not apply — never
      // quarantine a shared write child.
      if (wsCtx && ranAs === "repo_read") {
        // workspace_ref runs leave a deterministic `-ro` checkout: when it
        // exists, the L3 target IS that ephemeral dir (the parent checkout
        // was never the session cwd).
        const ephemeralPath = agentReadOnlyWorkdirPath(wsCtx.slug, runId);
        const usedEphemeral = await pathIsDirectory(ephemeralPath);
        const l3Target = usedEphemeral ? ephemeralPath : wsCtx.repoPath;
        const verdict = await checkRepoReadDirt(l3Target);

        if (verdict.dirty) {
          await quarantineAgentInTx({
            tx,
            agentId: row.agentId,
            runId,
            projectId: row.projectId,
            taskId: row.taskId,
            reason: `repo_read run left ${l3Target} dirty: ${verdict.porcelain.slice(0, 512)}`,
          });
        }

        if (usedEphemeral) {
          ephemeralCleanup = {
            repoPath: wsCtx.repoPath,
            worktreePath: ephemeralPath,
          };
        }
      }
    }

    await revokeAgentRunTokensForRun(runId, tx);

    if (opts.closeOpenHitl) {
      await tx
        .update(hitlRequests)
        .set({ respondedAt: endedAt })
        .where(
          and(eq(hitlRequests.runId, runId), isNull(hitlRequests.respondedAt)),
        );
    }

    if (opts.closeAssignments?.kind === "user") {
      await cancelActiveAssignmentsForRun({
        db: tx,
        runId,
        actorId: opts.closeAssignments.actorId,
        eventKind: opts.closeAssignments.eventKind,
        reason: opts.closeAssignments.reason,
      });
    } else if (opts.closeAssignments?.kind === "system") {
      await systemCloseActiveAssignmentsForRun({
        db: tx,
        runId,
        reason: opts.closeAssignments.reason,
      });
    }

    await emitWebhookEvent({
      db: tx,
      type: WEBHOOK_TYPE_BY_STATUS[status],
      projectId: row.projectId,
      runId,
      data: {
        kind: "agent",
        agentId: row.agentId,
        ...(status === "Review" ? { source: "agent" } : {}),
        ...(opts.reason && status !== "Review" ? { reason: opts.reason } : {}),
      },
    });

    // M37 (ADR-098/097): a DELEGATED child reaching Review emits `run.review` so
    // the parked coordinator wakes to promote/rework the diff (and as-plan
    // auto-promote fires). A top-level Review (no parent) emits nothing — there is
    // no orchestrator to route to. Terminal outcomes emit their terminal kind.
    if (status === "Review") {
      if (row.parentRunId) {
        await emitDomainEvent({
          db: tx,
          kind: "run.review",
          projectId: row.projectId,
          taskId: row.taskId,
          runId,
          actor: { type: "agent", id: row.agentId },
          parentRunId: row.parentRunId,
          payload: {
            runKind: "agent",
            agentId: row.agentId,
            status,
          },
        });
      }
    } else {
      await emitDomainEvent({
        db: tx,
        kind: DOMAIN_KIND_BY_OUTCOME[outcome],
        projectId: row.projectId,
        taskId: row.taskId,
        runId,
        actor: { type: "agent", id: row.agentId },
        parentRunId: row.parentRunId,
        payload: {
          runKind: "agent",
          agentId: row.agentId,
          status,
          ...(opts.reason ? { reason: opts.reason } : {}),
        },
      });
    }

    return { finalized: true as const, status };
  });

  if (finalizeResult !== false) {
    log.info(
      { runId, outcome, status: finalizeResult.status, reason: opts.reason },
      "agent run finalized",
    );

    if (ephemeralCleanup) {
      const cleanup = ephemeralCleanup as {
        repoPath: string;
        worktreePath: string;
      };

      await removeWorktree({
        projectRepoPath: cleanup.repoPath,
        worktreePath: cleanup.worktreePath,
        force: true,
      }).catch((err: unknown) => {
        log.warn(
          { runId, err: err instanceof Error ? err.message : String(err) },
          "ephemeral checkout removal failed — next spawn recreates it",
        );
      });
    }

    await promoteNextPending({ db: _db, pool: "agent" }).catch(
      (err: unknown) => {
        log.error(
          { runId, err: err instanceof Error ? err.message : String(err) },
          "agent slot promote failed",
        );
      },
    );
  }

  return finalizeResult !== false ? finalizeResult : { finalized: false };
}

// M37 Phase 8 (ADR-099): a persistent swarm member PARKS on a clean end_turn
// instead of finalizing — it stays addressable for the next re-message. The
// CAS Running → NeedsInputIdle keeps acp_session_id (the resume handle), stamps
// checkpoint_at, refreshes acp_session_id if the latest turn produced a newer
// one, and frees the agent-pool slot. NO run-terminal domain event fires (it is
// not terminal). A genuine failure/crash still goes through finalizeAgentRun.
export async function parkPersistentAgent(
  runId: string,
  opts: { db?: Db; acpSessionId?: string | null } = {},
): Promise<{ parked: boolean }> {
  const _db = opts.db ?? getDb();

  const parked: boolean = await _db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({
        status: "NeedsInputIdle",
        checkpointAt: new Date(),
        keepaliveUntil: null,
        ...(opts.acpSessionId ? { acpSessionId: opts.acpSessionId } : {}),
      })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.runKind, "agent"),
          eq(runs.status, "Running"),
        ),
      )
      .returning({ id: runs.id });

    return rows.length > 0;
  });

  if (!parked) {
    log.warn(
      { runId, from: "Running", to: "NeedsInputIdle" },
      "parkPersistentAgent: status-guard mismatch — concurrent transition won",
    );

    return { parked: false };
  }

  // Free the agent-pool slot the parked member no longer needs (mirrors the
  // NeedsInputIdle checkpoint path) and promote any queued agent run.
  await releaseSlotOnIdle({ runId, db: _db }).catch((err: unknown) => {
    log.warn(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "parkPersistentAgent: releaseSlotOnIdle failed",
    );
  });

  log.info({ runId }, "persistent agent parked on clean end_turn");

  return { parked: true };
}

export type SendAgentMessageResult = {
  childRunId: string;
  status: "Running";
};

// M37 Phase 8 (ADR-099): re-message a persistent child agent. A parked child
// (NeedsInputIdle) is woken — CAS NeedsInputIdle → Running, then
// startAgentSession respawns + session/resumes (run.acpSessionId) and delivers
// the override prompt as a fresh turn; the consume loop re-parks it on the next
// clean end_turn. A live child (Running, mid-turn) gets the prompt delivered to
// its already-attached session. Never exposes acp_session_id. Mirrors the HITL
// idle-resume path's claim-then-startAgentSession mechanics.
export async function sendAgentMessage(
  childRunId: string,
  prompt: string,
  opts: {
    db?: Db;
    api?: AgentSupervisorApi;
    listSessions?: typeof listSessions;
  } = {},
): Promise<SendAgentMessageResult> {
  const _db = opts.db ?? getDb();
  const listSessionsFn = opts.listSessions ?? listSessions;

  const rows = await _db
    .select({
      status: runs.status,
      runKind: runs.runKind,
      acpSessionId: runs.acpSessionId,
    })
    .from(runs)
    .where(eq(runs.id, childRunId));
  const run = rows[0];

  if (!run || run.runKind !== "agent") {
    throw new MaisterError(
      "PRECONDITION",
      `run ${childRunId} is not an agent run`,
    );
  }

  // Parked: claim NeedsInputIdle → Running (startAgentSession early-returns on
  // any non-Running status), then respawn + resume + deliver the new prompt.
  // Mirrors the agent-idle HITL resume CAS in lib/services/hitl.ts.
  if (run.status === "NeedsInputIdle") {
    const claimed: boolean = await _db.transaction(async (tx: Db) => {
      const updated = await tx
        .update(runs)
        .set({ status: "Running", keepaliveUntil: null, checkpointAt: null })
        .where(and(eq(runs.id, childRunId), eq(runs.status, "NeedsInputIdle")))
        .returning({ id: runs.id });

      return updated.length > 0;
    });

    if (!claimed) {
      throw new MaisterError(
        "CONFLICT",
        `child run ${childRunId} is being resumed concurrently`,
      );
    }

    await startAgentSession(childRunId, {
      db: _db,
      ...(opts.api ? { api: opts.api } : {}),
      overridePrompt: prompt,
    });

    return { childRunId, status: "Running" };
  }

  // Live: deliver the prompt to the running session (its consumer re-parks it).
  if (run.status === "Running") {
    if (!run.acpSessionId) {
      throw new MaisterError(
        "PRECONDITION",
        `child run ${childRunId} has no live session handle yet`,
      );
    }

    const live = (await listSessionsFn()).find(
      (s) => s.status === "live" && s.acpSessionId === run.acpSessionId,
    );

    if (!live) {
      throw new MaisterError(
        "PRECONDITION",
        `child run ${childRunId} has no live supervisor session`,
      );
    }

    const api = opts.api ?? defaultSupervisorApi;

    await api.sendPrompt(live.sessionId, { stepId: "agent", prompt });

    return { childRunId, status: "Running" };
  }

  throw new MaisterError(
    "PRECONDITION",
    `child run ${childRunId} is not re-messageable (status=${run.status})`,
  );
}

export type ReworkChildRunResult = {
  childRunId: string;
  status: "Running";
};

// FOR UPDATE load of an OWN (non-shared) child's `workspaces` row promotion_state —
// the row the promote claim/finalize lock. Returns null for a workspace-less child
// (workspace 'none'/'repo_read', no row), which can't be promoted (no branch).
async function loadOwnWorkspacePromotionStateForUpdate(
  db: Db,
  runId: string,
): Promise<{ promotionState: string | null } | null> {
  const rows = await db
    .select({ promotionState: workspaces.promotionState })
    .from(workspaces)
    .where(eq(workspaces.runId, runId))
    .for("update");

  return rows[0] ?? null;
}

// M37 (ADR-100): re-open a DELEGATED child whose turn produced a diff (Review)
// for another turn with the coordinator's rework prompt. CAS Review → Running
// (single-winner — a concurrent promote/rework loses → CONFLICT), then
// startAgentSession respawns + session/resumes (run.acpSessionId, preserved on
// the delegated Review flip) and delivers the rework prompt as a fresh turn; the
// consume loop re-reviews on the next clean end_turn. The caller (rework route)
// has already verified the child is a direct child of the bound orchestrator and
// in Review. Never exposes acp_session_id. Mirrors sendAgentMessage's parked
// claim-then-startAgentSession mechanics.
export async function reworkChildRun(
  childRunId: string,
  prompt: string,
  opts: { db?: Db; api?: AgentSupervisorApi } = {},
): Promise<ReworkChildRunResult> {
  const _db = opts.db ?? getDb();

  const rows = await _db
    .select({
      status: runs.status,
      runKind: runs.runKind,
      workspaceMode: runs.workspaceMode,
      agentWorkspace: runs.agentWorkspace,
      rootRunId: runs.rootRunId,
    })
    .from(runs)
    .where(eq(runs.id, childRunId));
  const run = rows[0];

  if (!run || run.runKind !== "agent") {
    throw new MaisterError(
      "PRECONDITION",
      `run ${childRunId} is not an agent run`,
    );
  }

  if (run.status !== "Review") {
    throw new MaisterError(
      "PRECONDITION",
      `child run ${childRunId} is not in Review (status=${run.status})`,
    );
  }

  // F1 + F1-twin (Codex adversarial review): a worktree-backed child (shared OR own)
  // is promotable — the promote claim mints promotion_state='claiming' under the
  // workspaces-row FOR UPDATE lock, runs its merge LOCKLESS between the claim and
  // finalize tx, then the finalize flips → Done. An UNFENCED rework that CASes
  // Review→Running in that claim→finalize window is clobbered back to Done by the
  // finalize (a lost update — both report success). Fence the rework on the SAME row
  // the promote claim/finalize lock: refuse CONFLICT while a promote is claiming/done,
  // else CAS Review→Running in the same tx. The promote claim ALSO re-reads run.status
  // under this lock (see promoteWorkspaceRun), so a rework that wins the lock FIRST
  // makes the promote abort instead of clobber. Single consistent single-row lock
  // (shared: tree allocator row; own: this run's row) → no deadlock. A workspace-less
  // child (workspace 'none'/'repo_read', no row) can't be promoted → unfenced CAS.
  // F1 shipped the shared half; this adds the own half (sibling-sweep miss).
  let claim: StateTransitionResult;

  if (run.workspaceMode === "shared" && run.agentWorkspace === "worktree") {
    claim = await _db.transaction(async (tx: Db) => {
      const ws = await resolveSharedTreeWorkspaceForUpdate(tx, run);

      if (ws.promotionState === "claiming" || ws.promotionState === "done") {
        log.info(
          {
            childRunId,
            rootRunId: run.rootRunId ?? null,
            promotionState: ws.promotionState,
          },
          "rework refused — shared tree promote in progress",
        );
        throw new MaisterError(
          "CONFLICT",
          `child run ${childRunId} rework refused — a tree promote is in progress / the tree is already promoted`,
        );
      }

      return markReworkFromReview(childRunId, { db: tx });
    });
  } else {
    claim = await _db.transaction(async (tx: Db) => {
      const ws = await loadOwnWorkspacePromotionStateForUpdate(tx, childRunId);

      if (
        ws &&
        (ws.promotionState === "claiming" || ws.promotionState === "done")
      ) {
        log.info(
          { childRunId, promotionState: ws.promotionState },
          "rework refused — promote in progress",
        );
        throw new MaisterError(
          "CONFLICT",
          `child run ${childRunId} rework refused — a promote is in progress / the run is already promoted`,
        );
      }

      return markReworkFromReview(childRunId, { db: tx });
    });
  }

  if (!claim.ok) {
    throw new MaisterError(
      "CONFLICT",
      `child run ${childRunId} left Review concurrently (promoted or reworked)`,
    );
  }

  await startAgentSession(childRunId, {
    db: _db,
    ...(opts.api ? { api: opts.api } : {}),
    overridePrompt: prompt,
  });

  return { childRunId, status: "Running" };
}

async function recordAgentPermissionRequest(args: {
  db: Db;
  runId: string;
  event: Extract<SupervisorEvent, { type: "session.permission_request" }>;
}): Promise<void> {
  await args.db.transaction(async (tx: Db) => {
    await tx.insert(hitlRequests).values({
      id: randomUUID(),
      runId: args.runId,
      stepId: "agent",
      kind: "permission",
      schema: {
        requestId: args.event.requestId,
        options: args.event.options,
        toolCall: args.event.toolCall,
        supervisorSessionId: args.event.sessionId,
      },
      prompt: "Agent requests a tool permission",
    });
    await tx
      .update(runs)
      .set({ status: "NeedsInput", keepaliveUntil: nextKeepaliveAt() })
      .where(and(eq(runs.id, args.runId), eq(runs.status, "Running")));
  });
}

export type AgentSupervisorApi = {
  createSession: typeof createSession;
  deliverPermission: typeof deliverPermission;
  sendPrompt: typeof sendPrompt;
  streamSession: typeof streamSession;
  // ADR-108 (M40): a halting guardrail trip checkpoints the live session before
  // the NeedsInput escalate (escalateHookTrip).
  checkpointSession: typeof checkpointSession;
};

// RD7 (ADR-089 rework): resolve the agent's declared capability_profile.mcps
// through the platform/project catalog — same precedence resolver and the
// same exec-trust stdio gate as flow sessions. An empty/absent declaration
// resolves to NO catalog MCPs (the facade is the only injected server) — an
// agent never inherits the project default MCP set implicitly.
export async function resolveAgentProfileMcpServers(args: {
  db: Db;
  projectId: string;
  capabilityProfile: Record<string, unknown> | null;
  capabilityAgent: string;
  execTrust: "untrusted" | "trusted";
  runId: string;
}): Promise<AgentMcpServer[]> {
  const declared = Array.isArray(args.capabilityProfile?.mcps)
    ? (args.capabilityProfile.mcps as unknown[]).filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      )
    : [];

  if (declared.length === 0) return [];

  const [
    { loadSelectableCapabilities, resolveCapabilityProfile },
    { gateStdioMcpsByExecTrust, mapProfileToAgentArtifacts },
  ] = await Promise.all([
    import("@/lib/capabilities/resolver"),
    import("@/lib/capabilities/agent-map"),
  ]);
  const catalog = await loadSelectableCapabilities(args.projectId, args.db);
  const profile = resolveCapabilityProfile({
    projectId: args.projectId,
    executorAgent: args.capabilityAgent as never,
    selectedMcpIds: declared,
    selectedSkillIds: [],
    selectedRuleIds: [],
    selectedRestrictionIds: [],
    planMode: "off",
    catalog,
  });
  const mapped = mapProfileToAgentArtifacts({
    profile,
    agent: args.capabilityAgent as never,
  });
  const gated = gateStdioMcpsByExecTrust(mapped.mcpServers, args.execTrust);
  const withheld = mapped.mcpServers.length - gated.length;

  if (withheld > 0) {
    log.warn(
      { runId: args.runId, withheld, execTrust: args.execTrust },
      "agent profile stdio MCPs withheld — providing package is not exec-trusted",
    );
  }

  return gated;
}

// MCP facade injection (ADR-089 D9): the agent's sanctioned write channel —
// triage/comments/relations over the ext API, authenticated by the
// per-launch ephemeral token. The token rides the literal `env` channel
// (never logged, never streamed, never in session/update). Command
// resolution is env-overridable for split-host topologies; the default
// targets the monorepo facade via its workspace-local tsx.
export function agentFacadeMcpServer(tokenSecret: string): AgentMcpServer {
  const mcpDir = path.resolve(process.cwd(), "../mcp");
  const command =
    process.env.MAISTER_MCP_FACADE_COMMAND ??
    path.join(mcpDir, "node_modules", ".bin", "tsx");
  const args = process.env.MAISTER_MCP_FACADE_ARGS
    ? process.env.MAISTER_MCP_FACADE_ARGS.split(" ").filter(Boolean)
    : [path.join(mcpDir, "src", "main.ts"), "--stdio"];

  return {
    name: "maister",
    transport: "stdio",
    command,
    args,
    env: {
      MAISTER_API_BASE_URL:
        process.env.MAISTER_API_BASE_URL ?? "http://localhost:3000",
      MAISTER_PROJECT_TOKEN: tokenSecret,
    },
  };
}

const defaultSupervisorApi: AgentSupervisorApi = {
  createSession,
  deliverPermission,
  sendPrompt,
  streamSession,
  checkpointSession,
};

// Drives one standalone agent session end-to-end: spawn (resume-aware),
// prompt, then consume supervisor events until a terminal transition.
export async function startAgentSession(
  runId: string,
  // M37 Phase 8 (ADR-099): overridePrompt re-messages a parked persistent
  // child with a fresh turn instead of rebuilding the definition prompt. The
  // session resumes via run.acpSessionId and re-parks on the next end_turn.
  opts: {
    db?: Db;
    api?: AgentSupervisorApi;
    overridePrompt?: string;
  } = {},
): Promise<void> {
  const _db = opts.db ?? getDb();
  const api = opts.api ?? defaultSupervisorApi;

  const runRows = await _db.select().from(runs).where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run || run.runKind !== "agent") {
    throw new MaisterError("PRECONDITION", `run ${runId} is not an agent run`);
  }

  if (run.status !== "Running") {
    log.warn(
      { runId, status: run.status },
      "startAgentSession skipped — run is not Running",
    );

    return;
  }

  const draftPayload = consensusDraftPayload(run);
  const projectRows = await _db
    .select()
    .from(projects)
    .where(eq(projects.id, run.projectId));
  const project = projectRows[0];

  if (!project) {
    await finalizeAgentRun(runId, "Failed", {
      db: _db,
      reason: "project row vanished before spawn",
    });

    return;
  }

  if (!run.agentId) {
    const delegation = runnerDelegationSnapshot(run.delegationSnapshot);
    const snapshot = run.runnerSnapshot;

    if (draftPayload?.participantKind === "runner" && delegation && snapshot) {
      await startConsensusRunnerDraftSession({
        db: _db,
        api,
        run,
        project,
        payload: draftPayload,
        snapshot,
      });

      return;
    }

    await finalizeAgentRun(runId, "Failed", {
      db: _db,
      reason:
        "agent run has no catalog agent and is not a valid consensus runner draft",
    });

    return;
  }

  const agentRows = await _db
    .select()
    .from(agents)
    .where(eq(agents.id, run.agentId));
  const agent = agentRows[0];

  if (!agent) {
    await finalizeAgentRun(runId, "Failed", {
      db: _db,
      reason: "agent row vanished before spawn",
    });

    return;
  }

  // RD4: the effective definition resolves AGAIN at spawn — the project's
  // pin is the source of truth for the prompt body and the workspace axis.
  let effective: EffectiveAgentDefinition;

  try {
    effective = await resolveEffectiveAgentDefinition(
      { agentId: run.agentId as string, projectId: run.projectId as string },
      _db,
    );
  } catch (err) {
    await finalizeAgentRun(runId, "Failed", {
      db: _db,
      reason: err instanceof Error ? err.message : String(err),
    });

    return;
  }

  // M37 (ADR-100): use the workspace axis the run ACTUALLY launched with
  // (persisted at insert — a delegation override OR the agent-def default), not a
  // re-derivation from the agent def, which would diverge from an overriding
  // delegation (wrong cwd / readOnlySession). Falls back to the def for rows that
  // predate agent_workspace.
  const workspace = (run.agentWorkspace ?? effective.parsed.workspace) as
    | "none"
    | "repo_read"
    | "worktree";
  let cwd: string;

  if (workspace === "repo_read" && effective.parsed.workspaceRef) {
    // ADR-090 rework: ephemeral detached checkout at the trigger-derived ref
    // — the user's checkout is never switched; removed at the terminal choke.
    cwd = agentReadOnlyWorkdirPath(project.slug, runId);

    try {
      const committish = await resolveWorkspaceRefCommittish(_db, {
        agentId: run.agentId as string,
        workspaceRef: effective.parsed.workspaceRef,
        repoPath: project.repoPath as string,
        trigger: {
          source: run.triggerSource as AgentTriggerSource,
          eventId: run.triggerEventId as number | bigint | null,
          payload: run.triggerPayload as Record<string, unknown> | null,
        },
      });

      // A leftover from a crashed prior spawn of the SAME run is stale —
      // recreate at the freshly resolved ref (removeWorktree no-ops when
      // missing).
      await removeWorktree({
        projectRepoPath: project.repoPath as string,
        worktreePath: cwd,
        force: true,
      });
      await addDetachedWorktree({
        projectRepoPath: project.repoPath as string,
        worktreePath: cwd,
        committish,
      });
    } catch (err) {
      await finalizeAgentRun(runId, "Failed", {
        db: _db,
        reason: err instanceof Error ? err.message : String(err),
      });

      return;
    }
  } else if (workspace === "repo_read") {
    cwd = project.repoPath;
  } else if (workspace === "worktree") {
    // M37 Phase 10 (ADR-099): a shared-mode child resolves the tree from its
    // root_run_id (a reusing sibling has NO workspaces row of its own — the
    // allocator owns it under the UNIQUE worktree_path), so the shared path is
    // computed deterministically rather than read back.
    if (run.workspaceMode === "shared" && run.rootRunId) {
      cwd = sharedAgentWorktreePath(project.slug, run.rootRunId as string);
    } else {
      const wsRows = await _db
        .select({ worktreePath: workspaces.worktreePath })
        .from(workspaces)
        .where(eq(workspaces.runId, runId));

      cwd = wsRows[0]?.worktreePath ?? agentWorkdirPath(project.slug, runId);
    }
  } else {
    cwd = agentWorkdirPath(project.slug, runId);
    await mkdir(cwd, { recursive: true });
  }

  const snapshot = run.runnerSnapshot;

  if (!snapshot) {
    await finalizeAgentRun(runId, "Failed", {
      db: _db,
      reason: "run has no runner snapshot",
    });

    return;
  }

  try {
    // ADR-090 L2 (materialize-only): instructed deny rules in the session
    // cwd; manifest-tracked and restored at the terminal choke point.
    if (workspace !== "worktree") {
      await materializeAgentReadOnlySettings(cwd).catch((err: unknown) => {
        log.warn(
          { runId, err: err instanceof Error ? err.message : String(err) },
          "L2 materialization failed — L1/L3 carry the contract",
        );
      });
    }

    const basePrompt = await buildAgentPrompt(_db, effective.parsed, run);
    const prompt =
      opts.overridePrompt ??
      (draftPayload
        ? consensusAgentDraftPrompt(basePrompt, draftPayload)
        : basePrompt);

    const issuedToken = await issueAgentRunToken({
      agentId: agent.id,
      projectId: project.id,
      runId,
      db: _db,
    });

    // RD7: the agent's capability_profile.mcps resolve through the existing
    // platform/project catalog (precedence + exec-trust stdio gate) and ride
    // createSession alongside the facade.
    const profileMcpServers = await resolveAgentProfileMcpServers({
      db: _db,
      projectId: project.id as string,
      capabilityProfile: effective.parsed.capabilityProfile,
      capabilityAgent: snapshot.capabilityAgent as string,
      execTrust: effective.execTrust,
      runId,
    });

    // ADR-108 (M40): explicit agent guardrail hooks. Agent runs carry no
    // execution-policy preset, so there is no `unattended` auto-arm — only what
    // the agent definition declares (undefined when it declares none). Resolved
    // once so it can be both logged and threaded; resolver stays pure. NOTE:
    // resolved-and-sent ≠ enforced — the supervisor interceptor lands in Phase 2;
    // until then the session body is accept-and-ignore.
    const hooksConfig = resolveHooksConfig({
      hooks: effective.parsed.hooks ?? undefined,
      preset: undefined,
      defaults: hookEnvDefaults(),
    });

    if (hooksConfig) {
      log.debug(
        { runId, rules: Object.keys(hooksConfig) },
        "guardrail hooks resolved (enforcement: Phase 2)",
      );
    }

    const session = await api.createSession({
      runId,
      projectSlug: project.slug,
      worktreePath: cwd,
      stepId: "agent",
      executor: runnerExecutorInput(snapshot),
      runner: runnerSupervisorInput({ snapshot }),
      adapterLaunch: mergeRunnerAdapterLaunch(snapshot),
      // ADR-089 D9: the facade carries the ephemeral token to the agent.
      mcpServers: [
        ...profileMcpServers,
        agentFacadeMcpServer(issuedToken.secret),
      ],
      // ADR-090 L1: none/repo_read agents run the whole session read-only.
      readOnlySession: workspace !== "worktree",
      hooksConfig,
      // M39 Phase 5 (ADR-106): autoApply='permissions'/'full' maps to B1
      // permissions=auto_approve — the supervisor's requestPermission handler
      // auto-selects the allow option inline (L3, below the read-only layers),
      // so a standalone agent never pauses to a permission HITL. Read from the
      // run's immutable execution_policy snapshot (fail-closed to `ask`).
      autoApprovePermissions:
        permissionsFromSnapshot(run.executionPolicy ?? null) === "auto_approve",
      ...(run.acpSessionId ? { resumeSessionId: run.acpSessionId } : {}),
    });

    await _db
      .update(runs)
      .set({ acpSessionId: session.acpSessionId })
      .where(eq(runs.id, runId));

    queueMicrotask(() => {
      void consumeAgentSession({
        db: _db,
        api,
        runId,
        sessionId: session.sessionId,
      }).catch((err: unknown) => {
        log.error(
          { runId, err: err instanceof Error ? err.message : String(err) },
          "agent session consumer threw",
        );
      });
    });

    await api.sendPrompt(session.sessionId, { stepId: "agent", prompt });
  } catch (err) {
    log.error(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "agent session spawn/prompt failed",
    );
    await finalizeAgentRun(runId, "Failed", {
      db: _db,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function consumeAgentSession(args: {
  db: Db;
  api: AgentSupervisorApi;
  runId: string;
  sessionId: string;
}): Promise<void> {
  let sawPermissionRequest = false;
  const draftPayload = await loadConsensusDraftPayload(args.db, args.runId);
  let consensusDraftOutput = "";

  for await (const event of args.api.streamSession(args.sessionId)) {
    switch (event.type) {
      case "session.update": {
        if (draftPayload) {
          const chunk = consensusDraftUpdateText(event.update);

          if (chunk) {
            consensusDraftOutput = appendCappedConsensusDraftOutput(
              consensusDraftOutput,
              chunk,
            );
          }
        }
        if (sawPermissionRequest) {
          // The permission was answered (the session is active again);
          // the runner owns NeedsInput → Running for agent runs too.
          sawPermissionRequest = false;
          await args.db
            .update(runs)
            .set({ status: "Running", keepaliveUntil: null })
            .where(and(eq(runs.id, args.runId), eq(runs.status, "NeedsInput")));
        }
        break;
      }
      case "session.permission_request": {
        const autoDelivered = await tryAutoDeliverAgentPermission({
          db: args.db,
          api: args.api,
          runId: args.runId,
          sessionId: args.sessionId,
          event,
        });

        if (autoDelivered) {
          sawPermissionRequest = false;
          break;
        }
        sawPermissionRequest = true;
        await recordAgentPermissionRequest({
          db: args.db,
          runId: args.runId,
          event,
        });
        break;
      }
      case "session.exited": {
        if (event.reason === "checkpoint") {
          // The keep-alive sweeper owns the NeedsInputIdle transition.
          log.info(
            { runId: args.runId },
            "agent session checkpointed — consumer detaching",
          );

          return;
        }

        // M37 Phase 8 (ADR-099): a persistent swarm member PARKS on a NATURAL
        // clean end_turn (exitCode 0, no reason) instead of finalizing — it
        // stays addressable for the next re-message. An `intentional` DELETE
        // (explicit cancel/stop) or any non-zero exit is a genuine teardown and
        // finalizes terminally below. Look up persistent only on the clean exit.
        if (event.exitCode === 0 && event.reason === undefined) {
          const persistentRows = await args.db
            .select({ persistent: runs.persistent })
            .from(runs)
            .where(eq(runs.id, args.runId));

          if (persistentRows[0]?.persistent === true) {
            await parkPersistentAgent(args.runId, { db: args.db });

            return;
          }
        }

        if (
          draftPayload &&
          event.exitCode === 0 &&
          event.reason === undefined
        ) {
          try {
            await recordConsensusDraftArtifact({
              db: args.db,
              runId: args.runId,
              payload: draftPayload,
              text: consensusDraftOutput,
            });
            log.info(
              {
                runId: args.runId,
                participantId: draftPayload.participantId,
                nodeId: draftPayload.nodeId,
                nodeAttemptId: draftPayload.nodeAttemptId,
                round: draftPayload.round,
                outputLength: consensusDraftOutput.length,
              },
              "consensus draft output artifact recorded",
            );
          } catch (err) {
            await finalizeAgentRun(args.runId, "Failed", {
              db: args.db,
              reason: err instanceof Error ? err.message : String(err),
            });

            return;
          }
        }

        await finalizeAgentRun(
          args.runId,
          event.exitCode === 0 || event.reason === "intentional"
            ? "Done"
            : "Failed",
          {
            db: args.db,
            reason:
              event.exitCode === 0
                ? undefined
                : `session exited with code ${event.exitCode}`,
          },
        );

        return;
      }
      case "session.crashed": {
        await finalizeAgentRun(args.runId, "Crashed", {
          db: args.db,
          reason: "supervisor reported session crash",
        });

        return;
      }
      // ADR-108 (M40): a halting guardrail trip (repetition / no_progress)
      // checkpoints + escalates to NeedsInput (resumable via startAgentSession);
      // the checkpoint produces a session.exited{reason:"checkpoint"} that
      // detaches this loop above. If the escalate cannot be durably recorded
      // (checkpoint EXECUTOR_UNAVAILABLE / tx failure) the run is stranded → it is
      // finalized Crashed (recoverable) so it never finalizes as success. A
      // path_guard deny is record-only (the supervisor already denied inline,
      // deny-and-continue).
      case "session.hook_trip": {
        if (event.disposition === "halt") {
          const haltRule =
            event.rule === "no_progress" ? "no_progress" : "repetition";

          try {
            await escalateHookTrip({
              db: args.db,
              runId: args.runId,
              stepId: "agent",
              supervisorSessionId: args.sessionId,
              rule: haltRule,
              toolCall: event.toolCall,
              runKind: "agent",
              checkpointSession: args.api.checkpointSession,
            });
          } catch (err) {
            // The halt is live (the supervisor cancelled the agent and will not
            // re-emit) but the escalate could not be durably recorded. Do NOT let
            // the run finalize as success on a later session.exited: surface a
            // recoverable Crashed (recover → session/resume on the retained
            // acp_session_id) and detach.
            log.error(
              {
                runId: args.runId,
                err: err instanceof Error ? err.message : String(err),
              },
              "hook_trip escalation failed — agent run Crashed (stranded)",
            );
            await finalizeAgentRun(args.runId, "Crashed", {
              db: args.db,
              reason: "hook_trip escalation failed (executor unavailable)",
            });

            return;
          }

          break;
        }
        log.debug(
          { runId: args.runId, rule: event.rule },
          "path_guard deny — agent run continues (record-only)",
        );
        break;
      }
      default:
        break;
    }
  }

  log.warn(
    { runId: args.runId, sessionId: args.sessionId },
    "agent session stream ended without a terminal event",
  );
}

type StoredAgentPermissionIntent = {
  id: string;
  optionId: string;
  originalRequestId: string | null;
};

async function findStoredAgentPermissionIntent(
  db: Db,
  runId: string,
): Promise<StoredAgentPermissionIntent | null> {
  const rows = await db
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        eq(hitlRequests.stepId, "agent"),
        eq(hitlRequests.kind, "permission"),
        isNull(hitlRequests.respondedAt),
      ),
    );

  for (const row of rows) {
    const optionId = (row.response as { optionId?: unknown } | null)?.optionId;

    if (typeof optionId !== "string" || optionId.length === 0) continue;

    return {
      id: row.id as string,
      optionId,
      originalRequestId:
        (row.schema as { requestId?: string } | null)?.requestId ?? null,
    };
  }

  return null;
}

async function tryAutoDeliverAgentPermission(args: {
  db: Db;
  api: AgentSupervisorApi;
  runId: string;
  sessionId: string;
  event: Extract<SupervisorEvent, { type: "session.permission_request" }>;
}): Promise<boolean> {
  const intent = await findStoredAgentPermissionIntent(args.db, args.runId);

  if (!intent) return false;

  await args.api.deliverPermission(
    args.sessionId,
    args.event.requestId,
    intent.optionId,
  );

  await args.db.transaction(async (tx: Db) => {
    const stamped = await tx
      .update(hitlRequests)
      .set({
        respondedAt: new Date(),
        response: {
          optionId: intent.optionId,
          _audit: {
            originalRequestId: intent.originalRequestId,
            reissuedRequestId: args.event.requestId,
            deliveredViaAgentResume: true,
          },
        },
      })
      .where(
        and(eq(hitlRequests.id, intent.id), isNull(hitlRequests.respondedAt)),
      )
      .returning({ id: hitlRequests.id });

    if (stamped.length === 0) return;

    const projectRows = await tx
      .select({ projectId: runs.projectId })
      .from(runs)
      .where(eq(runs.id, args.runId));

    await emitWebhookEvent({
      db: tx,
      type: "hitl.responded",
      projectId: projectRows[0].projectId,
      runId: args.runId,
      data: { hitlRequestId: intent.id, kind: "permission", via: "auto" },
    });
  });

  log.info(
    {
      runId: args.runId,
      originalRequestId: intent.originalRequestId,
      reissuedRequestId: args.event.requestId,
      optionId: intent.optionId,
    },
    "agent permission stored intent auto-delivered on resumed session",
  );

  return true;
}

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
  resolveAgentRunner,
  type RunnerCatalogEntry,
  type RunnerResolution,
  type RunnerSidecarSnapshot,
} from "@/lib/acp-runners/resolve";
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
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { MaisterError, type MaisterErrorCode } from "@/lib/errors";
import { gcAgeDays, worktreesRoot } from "@/lib/instance-config";
import { nextKeepaliveAt } from "@/lib/runs/keepalive-config";
import { assertRunKindInvariant } from "@/lib/runs/run-kind-invariants";
import {
  promoteNextPending,
  releaseSlotOnIdle,
  tryStartRun,
} from "@/lib/scheduler";
import {
  createSession,
  deliverPermission,
  listSessions,
  sendPrompt,
  streamSession,
  type SupervisorEvent,
} from "@/lib/supervisor-client";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import {
  addDetachedWorktree,
  addWorktree,
  listWorktrees,
  removeWorktree,
  resolveBaseCommit,
  statusPorcelain,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  agents,
  agentProjectLinks,
  domainEvents,
  hitlRequests,
  platformAcpRunners,
  platformRouterSidecars,
  platformRuntimeSettings,
  projects,
  runs,
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
  // M36 (ADR-095): orchestrator run-tree linkage. Set when this run is a
  // delegated child — parentRunId is the delegator, rootRunId the tree root,
  // launchMode distinguishes auto-DAG launches from manual delegations.
  parentRunId?: string | null;
  rootRunId?: string | null;
  launchMode?: "auto" | "manual";
  // M36 Phase 8 (ADR-096): a persistent child parks between turns and is
  // re-addressable by `addressableKey` within its orchestrator tree (unique on
  // (root_run_id, addressable_key) among persistent rows). `addressableKey` is
  // REQUIRED when `persistent` is set.
  persistent?: boolean;
  addressableKey?: string | null;
  // M36 Phase 10 (ADR-096): worktree allocation mode for a delegated child.
  // `own` (default/null) = a per-run worktree; `shared` = all children of one
  // rootRunId point at a single pre-allocated tree (serialized writers via the
  // scheduler promote-time guard). A `shared` request with no rootRunId is
  // refused (CONFIG) — a top-level run has no tree to share.
  workspaceMode?: "own" | "shared" | null;
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
  | "task_mismatch";

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

type LoadedAgentContext = {
  agent: Record<string, any>;
  // ADR-089 rework (RD4): the definition the launch actually runs — resolved
  // through THIS project's pinned package revision, behind enablement+trust.
  effective: EffectiveAgentDefinition;
  link: Record<string, any>;
  project: Record<string, any>;
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

export function agentWorkdirPath(projectSlug: string, runId: string): string {
  return path.join(worktreesRoot(), projectSlug, runId);
}

// M36 Phase 10 (ADR-096): the SHARED worktree for an orchestrator tree —
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

export async function launchAgentRun(
  input: LaunchAgentRunInput,
): Promise<LaunchAgentRunResult> {
  const _db = input.db ?? getDb();
  const ctx = await loadAgentContext(_db, input);
  const resolution = await resolveRunnerForAgent(
    _db,
    ctx,
    input.launchOverrideRunnerId,
  );

  const runId = randomUUID();
  const workspace = ctx.effective.parsed.workspace;

  // M36 Phase 8 (ADR-096): a persistent child must carry an addressable_key —
  // it is the re-message handle. Uniqueness within the tree is enforced by the
  // partial index (mapped to CONFLICT below); this guards the NOT-NULL contract
  // before any side effect.
  if (input.persistent && !input.addressableKey) {
    throw new MaisterError(
      "CONFIG",
      "a persistent child requires an addressableKey",
    );
  }

  // M36 Phase 10 (ADR-096): a shared worktree is keyed by the tree root, so a
  // top-level run (no rootRunId) has no tree to share. Refuse before any side
  // effect.
  if (input.workspaceMode === "shared" && !input.rootRunId) {
    throw new MaisterError(
      "CONFIG",
      "workspaceMode=shared requires a delegated child with a rootRunId — a top-level run cannot share a tree",
    );
  }

  // Fast dedup pre-check before any side effect; the partial unique index
  // on (agent_id, trigger_event_id) stays the authoritative backstop.
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

  // M36 Phase 8 (ADR-096): the addressable_key must be free within the
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
  // M36 Phase 10 (ADR-096): a shared-mode child whose tree a sibling already
  // allocated reuses that tree — it gets NO workspaces row of its own (the
  // worktree_path column is UNIQUE; the allocating sibling owns the record).
  // startAgentSession recomputes the shared cwd from workspace_mode + rootRunId.
  let reuseSharedTree = false;
  const isShared = input.workspaceMode === "shared" && input.rootRunId != null;

  if (workspace === "worktree") {
    if (isShared) {
      const rootRunId = input.rootRunId as string;

      branch = `${ctx.project.branchPrefix ?? "maister/"}agents/${rootRunId}`;
      worktreePath = sharedAgentWorktreePath(ctx.project.slug, rootRunId);

      // Idempotent allocation: a sibling may have created the shared tree
      // already. listWorktrees is the registry of record — if the path is
      // present, reuse it (skip addWorktree, which would fail on the existing
      // path/branch); otherwise this child is the allocator.
      const existing = await listWorktrees(ctx.project.repoPath);

      reuseSharedTree = existing.some((w) => w.path === worktreePath);

      if (!reuseSharedTree) {
        baseCommit = await resolveBaseCommit({
          projectRepoPath: ctx.project.repoPath,
          baseRef: ctx.project.mainBranch,
        });
        await addWorktree({
          projectRepoPath: ctx.project.repoPath,
          worktreePath,
          branch,
          startPoint: ctx.project.mainBranch,
        });
      }
    } else {
      branch = agentWorktreeBranchName({
        prefix: ctx.project.branchPrefix ?? "maister/",
        agentId: input.agentId,
        runId,
      });
      worktreePath = agentWorkdirPath(ctx.project.slug, runId);
      baseCommit = await resolveBaseCommit({
        projectRepoPath: ctx.project.repoPath,
        baseRef: ctx.project.mainBranch,
      });
      await addWorktree({
        projectRepoPath: ctx.project.repoPath,
        worktreePath,
        branch,
        startPoint: ctx.project.mainBranch,
      });
    }
  }

  const runRow = {
    id: runId,
    runKind: "agent" as const,
    agentId: input.agentId,
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
    // M36 (ADR-095): run-tree linkage. delegation_snapshot records the CHILD's
    // launch-time effective agent-def (skill-context rule 207 — id + pinned
    // revision only; the resolved runner stays in runner_snapshot above). Set
    // only for a delegated child (parentRunId present).
    parentRunId: input.parentRunId ?? null,
    rootRunId: input.rootRunId ?? null,
    launchMode: input.launchMode ?? null,
    delegationSnapshot: input.parentRunId
      ? {
          agentDefinitionId: input.agentId,
          revisionId: ctx.effective.revisionId,
        }
      : null,
    // M36 Phase 8 (ADR-096): persistent swarm-member flags.
    persistent: input.persistent ?? false,
    addressableKey: input.addressableKey ?? null,
    // M36 Phase 10 (ADR-096): worktree allocation mode — read by the scheduler
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

      // A reused shared tree already has a workspaces row owned by its allocator
      // (worktree_path is UNIQUE), so a reusing sibling inserts none.
      if (
        workspace === "worktree" &&
        worktreePath &&
        branch &&
        !reuseSharedTree
      ) {
        await tx.insert(workspaces).values({
          id: randomUUID(),
          runId,
          projectId: input.projectId,
          branch,
          worktreePath,
          parentRepoPath: ctx.project.repoPath,
          baseBranch: ctx.project.mainBranch,
          baseCommit,
          targetBranch: ctx.project.mainBranch,
        });
      }

      return true;
    });

    if (!inserted) {
      // Only tear down a worktree THIS launch created — never a shared tree a
      // sibling owns.
      if (worktreePath && !reuseSharedTree) {
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
    if (worktreePath && !reuseSharedTree) {
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

// The prompt body comes from the EFFECTIVE definition (the project-pinned
// package revision, resolved by the caller at spawn time) — never from the
// catalog index row.
export async function buildAgentPrompt(
  _db: Db,
  parsed: ParsedAgentDefinition,
  run: Record<string, any>,
): Promise<string> {
  const sections = [parsed.prompt.trim()];
  const taskBlock = await taskContextBlock(_db, run);
  const commentTriggerBlock = await taskCommentTriggerContextBlock(_db, run);

  if (taskBlock) sections.push(taskBlock);
  if (commentTriggerBlock) sections.push(commentTriggerBlock);
  sections.push(triggerContextBlock(run));

  return sections.join("\n\n");
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
    const workspaceRows =
      outcome === "Done"
        ? await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.runId, runId))
        : [];
    const status =
      outcome === "Done"
        ? finalStatusForCleanAgentExit(workspaceRows.length > 0)
        : outcome;
    const endedAt = new Date();

    const rows = await tx
      .update(runs)
      .set({
        status,
        endedAt,
        acpSessionId: null,
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

      // M36 Phase 10 (ADR-096): L3 guards repo_read ONLY. A shared WRITE tree
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

    if (status !== "Review") {
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

// M36 Phase 8 (ADR-096): a persistent swarm member PARKS on a clean end_turn
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

// M36 Phase 8 (ADR-096): re-message a persistent child agent. A parked child
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
};

// Drives one standalone agent session end-to-end: spawn (resume-aware),
// prompt, then consume supervisor events until a terminal transition.
export async function startAgentSession(
  runId: string,
  // M36 Phase 8 (ADR-096): overridePrompt re-messages a parked persistent
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

  const agentRows = await _db
    .select()
    .from(agents)
    .where(eq(agents.id, run.agentId));
  const agent = agentRows[0];
  const projectRows = await _db
    .select()
    .from(projects)
    .where(eq(projects.id, run.projectId));
  const project = projectRows[0];

  if (!agent || !project) {
    await finalizeAgentRun(runId, "Failed", {
      db: _db,
      reason: "agent or project row vanished before spawn",
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

  const workspace = effective.parsed.workspace;
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
    // M36 Phase 10 (ADR-096): a shared-mode child resolves the tree from its
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

    const prompt =
      opts.overridePrompt ??
      (await buildAgentPrompt(_db, effective.parsed, run));

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

  for await (const event of args.api.streamSession(args.sessionId)) {
    switch (event.type) {
      case "session.update": {
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

        // M36 Phase 8 (ADR-096): a persistent swarm member PARKS on a NATURAL
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

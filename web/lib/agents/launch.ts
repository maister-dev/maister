import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray } from "drizzle-orm";
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
import { type AgentMcpServer } from "@/lib/capabilities/agent-map";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";
import { worktreesRoot } from "@/lib/instance-config";
import { nextKeepaliveAt } from "@/lib/runs/keepalive-config";
import { assertRunKindInvariant } from "@/lib/runs/run-kind-invariants";
import { promoteNextPending, tryStartRun } from "@/lib/scheduler";
import {
  createSession,
  sendPrompt,
  streamSession,
  type SupervisorEvent,
} from "@/lib/supervisor-client";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import {
  addDetachedWorktree,
  addWorktree,
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
  tasks,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "agents-launch",
  level: process.env.LOG_LEVEL ?? "info",
});

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
  db?: Db;
};

export type LaunchAgentRunResult =
  | { runId: string; status: "Running" | "Pending"; queuePosition?: number }
  | { deduped: true; triggerEventId: number };

type LoadedAgentContext = {
  agent: Record<string, any>;
  // ADR-089 rework (RD4): the definition the launch actually runs — resolved
  // through THIS project's pinned package revision, behind enablement+trust.
  effective: EffectiveAgentDefinition;
  link: Record<string, any>;
  project: Record<string, any>;
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
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}" is not registered`,
    );
  }

  if (!agent.enabled) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}" is disabled`,
    );
  }

  if (agent.quarantinedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}" is quarantined (${agent.quarantineReason ?? "no reason recorded"}); un-quarantine it before launching`,
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
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}" is risk_tier=destructive — gated until capability enforcement lands (ADR-041)`,
    );
  }

  if (effective.parsed.mode !== "session") {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}" is mode=subagent — flow-bound only, not launchable standalone`,
    );
  }

  if (!effective.parsed.triggers.includes(input.trigger.source)) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}" does not declare the "${input.trigger.source}" trigger`,
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
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}" is not attached (enabled) to project ${input.projectId}`,
    );
  }

  const projectRows = await _db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId));
  const project = projectRows[0];

  if (!project || project.archivedAt) {
    throw new MaisterError(
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
      throw new MaisterError(
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

  if (workspace === "worktree") {
    branch = `${ctx.project.branchPrefix ?? "maister/"}agent-${input.agentId}-${runId.slice(0, 8)}`;
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

  const runRow = {
    id: runId,
    runKind: "agent" as const,
    agentId: input.agentId,
    triggerSource: input.trigger.source,
    triggerEventId: input.trigger.eventId ?? null,
    triggerPayload: input.trigger.payload ?? null,
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
      // Claim-first: the INSERT itself is the at-least-once dedup claim.
      const rows = await tx
        .insert(runs)
        .values(runRow)
        .onConflictDoNothing()
        .returning({ id: runs.id });

      if (rows.length === 0) return false;

      if (workspace === "worktree" && worktreePath && branch) {
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
      if (worktreePath) {
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
    if (worktreePath) {
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

  if (taskBlock) sections.push(taskBlock);
  sections.push(triggerContextBlock(run));

  return sections.join("\n\n");
}

type AgentTerminalOutcome = "Done" | "Failed" | "Crashed";

const TERMINAL_CAS_SOURCE: Record<AgentTerminalOutcome, string[]> = {
  Done: ["Running", "NeedsInput"],
  Failed: ["Running", "NeedsInput"],
  Crashed: ["Running", "NeedsInput"],
};

const DOMAIN_KIND_BY_OUTCOME: Record<
  AgentTerminalOutcome,
  "run.done" | "run.failed" | "run.crashed"
> = {
  Done: "run.done",
  Failed: "run.failed",
  Crashed: "run.crashed",
};

// The terminal choke point for agent runs (ADR-090 sequencing rule): the
// dirty-watchdog (Phase 4) and the token revoke run BEFORE/WITHIN the
// status-flip transaction; nothing writes the run row after the flip.
export async function finalizeAgentRun(
  runId: string,
  outcome: AgentTerminalOutcome,
  opts: { db?: Db; reason?: string } = {},
): Promise<{ finalized: boolean }> {
  const _db = opts.db ?? getDb();

  // Set inside the transaction when the run used an ephemeral workspace_ref
  // checkout — removed AFTER the commit (fs cleanup must never roll back the
  // terminal flip; a failure leaves a stale dir the next spawn recreates).
  let ephemeralCleanup: { repoPath: string; worktreePath: string } | null =
    null;

  const finalized = await _db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({ status: outcome, endedAt: new Date() })
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
      });
    const row = rows[0];

    if (!row) return false;

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

      if (wsCtx?.workspace === "repo_read") {
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

    await emitWebhookEvent({
      db: tx,
      type:
        outcome === "Done"
          ? "run.done"
          : outcome === "Failed"
            ? "run.failed"
            : "run.crashed",
      projectId: row.projectId,
      runId,
      data: {
        kind: "agent",
        agentId: row.agentId,
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    });
    await emitDomainEvent({
      db: tx,
      kind: DOMAIN_KIND_BY_OUTCOME[outcome],
      projectId: row.projectId,
      taskId: row.taskId,
      runId,
      actor: { type: "agent", id: row.agentId },
      payload: {
        runKind: "agent",
        agentId: row.agentId,
        status: outcome,
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    });

    return true;
  });

  if (finalized) {
    log.info({ runId, outcome, reason: opts.reason }, "agent run finalized");

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

  return { finalized };
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
  sendPrompt: typeof sendPrompt;
  streamSession: typeof streamSession;
};

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
  sendPrompt,
  streamSession,
};

// Drives one standalone agent session end-to-end: spawn (resume-aware),
// prompt, then consume supervisor events until a terminal transition.
export async function startAgentSession(
  runId: string,
  opts: { db?: Db; api?: AgentSupervisorApi } = {},
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
    const wsRows = await _db
      .select({ worktreePath: workspaces.worktreePath })
      .from(workspaces)
      .where(eq(workspaces.runId, runId));

    cwd = wsRows[0]?.worktreePath ?? agentWorkdirPath(project.slug, runId);
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

    const prompt = await buildAgentPrompt(_db, effective.parsed, run);

    const issuedToken = await issueAgentRunToken({
      agentId: agent.id,
      projectId: project.id,
      runId,
      db: _db,
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
      mcpServers: [agentFacadeMcpServer(issuedToken.secret)],
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

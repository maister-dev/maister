import "server-only";

import type { AgentTriggerKind } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
import {
  issueAgentRunToken,
  revokeAgentRunTokensForRun,
} from "@/lib/agents/tokens";
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
  addWorktree,
  removeWorktree,
  resolveBaseCommit,
  statusPorcelain,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  agents,
  agentProjectLinks,
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

  if (agent.riskTier === "destructive") {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}" is risk_tier=destructive — gated until capability enforcement lands (ADR-041)`,
    );
  }

  if (agent.mode !== "session") {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}" is mode=subagent — flow-bound only, not launchable standalone`,
    );
  }

  const triggers = (agent.triggers ?? []) as AgentTriggerKind[];

  if (!triggers.includes(input.trigger.source)) {
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

  return { agent, link, project };
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
      runnerId: ctx.agent.runnerId,
      mode: ctx.agent.mode,
      workspace: ctx.agent.workspace,
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
  const workspace = ctx.agent.workspace as "none" | "repo_read" | "worktree";

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

  // ADR-088: a repo_read run is only verifiable against a clean baseline.
  if (workspace === "repo_read") {
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

export async function buildAgentPrompt(
  _db: Db,
  agent: Record<string, any>,
  run: Record<string, any>,
): Promise<string> {
  const { readFile } = await import("node:fs/promises");

  let body: string;

  try {
    body = await readFile(agent.sourcePath as string, "utf8");
  } catch {
    throw new MaisterError(
      "CONFIG",
      `agent "${agent.id}": definition file ${agent.sourcePath} is missing`,
    );
  }

  const { parseAgentDefinition } = await import("@/lib/agents/definition");
  const parsed = parseAgentDefinition(agent.id as string, body);
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

// The terminal choke point for agent runs (ADR-088 sequencing rule): the
// dirty-watchdog (Phase 4) and the token revoke run BEFORE/WITHIN the
// status-flip transaction; nothing writes the run row after the flip.
export async function finalizeAgentRun(
  runId: string,
  outcome: AgentTerminalOutcome,
  opts: { db?: Db; reason?: string } = {},
): Promise<{ finalized: boolean }> {
  const _db = opts.db ?? getDb();

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

  const workspace = agent.workspace as "none" | "repo_read" | "worktree";
  let cwd: string;

  if (workspace === "repo_read") {
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
    const prompt = await buildAgentPrompt(_db, agent, run);

    await issueAgentRunToken({
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
      // ADR-088 L1: none/repo_read agents run the whole session read-only.
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

import "server-only";

import { readFile } from "node:fs/promises";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { resolveCompanyFlowPersona } from "./company-flow-persona";

import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { loadProjectAssignmentExecutionInput } from "@/lib/specialist-assignments/project-admission";
import { materializeSubagentDefinition } from "@/lib/capabilities/adapter-home";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { buildAgentActivitySnapshot } from "@/lib/agents/activity-snapshot";
import { recordNativeKnowledgeActor } from "@/lib/brain/knowledge-execution-actor";
import { usesStructuredKnowledgeContext } from "@/lib/run-results/contract";
import { requireRunProjectId } from "@/lib/runs/run-kind-invariants";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { agents, agentProjectLinks, runs } = schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "agent-flow-binding",
  level: process.env.LOG_LEVEL ?? "info",
});

export type FlowBoundAgentResolution =
  | { mode: "session"; prompt: string }
  | { mode: "subagent"; materializedPath: string };

// Resolves a node's `settings.agent` binding (ADR-089) at dispatch time.
// mode=session → the caller substitutes the agent's .md body as the system
// prompt; mode=subagent → the .md is materialized into the run worktree's
// .claude/agents/ (Claude self-delegates) and requires a claude-capability
// executor — refused with EXECUTOR_UNAVAILABLE otherwise, BEFORE any spawn.
export async function resolveFlowBoundAgent(args: {
  agentId: string;
  runId: string;
  nodeAttemptId?: string;
  executorAgent: string;
  worktreePath: string;
  db?: Db;
  // M39 (ADR-106): the run-driving persona path (an agent launched WITH a
  // flow_ref) reuses this resolver but skips the "flow" trigger requirement —
  // the driving agent is launched by its own trigger, not bound to a flow node.
  // Defaults to true (the per-node settings.agent binding still requires it).
  requireFlowTrigger?: boolean;
}): Promise<FlowBoundAgentResolution> {
  const _db = args.db ?? getDb();
  const rows = await _db
    .select()
    .from(agents)
    .where(eq(agents.id, args.agentId));
  const agent = rows[0];

  if (!agent) {
    throw new MaisterError(
      "CONFIG",
      `flow node binds agent "${args.agentId}" but it is not registered in the catalog`,
    );
  }

  if (!agent.enabled) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${args.agentId}" is disabled`,
    );
  }

  if (agent.quarantinedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${args.agentId}" is quarantined (${agent.quarantineReason ?? "no reason recorded"})`,
    );
  }

  // ADR-089 rework (RD4): the binding substitutes the definition from the
  // host Run's project attachment or explicit company-reviewed provider pin,
  // behind the same current enablement/trust gates as a standalone launch.
  const runRows = await _db
    .select({
      projectId: runs.projectId,
      companyId: runs.companyId,
      flowId: runs.flowId,
      flowRevisionId: runs.flowRevisionId,
      flowRevision: runs.flowRevision,
      sourceAgentId: runs.sourceAgentId,
      resultContract: runs.resultContract,
      knowledgeAccess: runs.knowledgeAccess,
    })
    .from(runs)
    .where(eq(runs.id, args.runId));
  const projectId = runRows[0]?.projectId as string | undefined;

  const companyId = runRows[0]?.companyId;

  if (typeof companyId === "string")
    log.debug(
      {
        runId: args.runId,
        agentId: args.agentId,
        nodeAttemptId: args.nodeAttemptId,
        companyId,
      },
      "resolving company Flow node persona",
    );

  if (!projectId && typeof companyId !== "string") {
    throw new MaisterError(
      "PRECONDITION",
      `run ${args.runId} not found for agent binding resolution`,
    );
  }

  if (typeof companyId === "string" && !args.nodeAttemptId)
    throw new MaisterError(
      "PRECONDITION",
      "Company Flow persona resolution requires an exact current node attempt",
    );
  if (
    typeof companyId === "string" &&
    args.requireFlowTrigger === false &&
    args.agentId !== runRows[0]?.sourceAgentId
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Only the responsible company role may supply the driving persona",
    );
  const companyPersona =
    typeof companyId === "string"
      ? await resolveCompanyFlowPersona(_db, args.runId, args.agentId)
      : null;

  const { resolveEffectiveAgentDefinition } =
    await import("@/lib/agents/effective");
  const effective =
    companyPersona?.effective ??
    (await resolveEffectiveAgentDefinition(
      {
        agentId: args.agentId,
        projectId: requireRunProjectId(projectId ?? null, args.runId),
      },
      _db,
    ));
  const parsed = effective.parsed;
  const assignedInput =
    typeof projectId === "string" && args.agentId === runRows[0]?.sourceAgentId
      ? await loadProjectAssignmentExecutionInput(_db, {
          ...runRows[0],
          id: args.runId,
          projectId,
        })
      : null;

  if (
    assignedInput &&
    (assignedInput.snapshot.standingDefinition.agentId !== args.agentId ||
      assignedInput.snapshot.standingDefinition.packageInstallId !==
        effective.packageInstallId ||
      assignedInput.snapshot.standingDefinition.definitionSha256 !==
        agentDefinitionSha256(parsed))
  )
    throw new MaisterError(
      "CONFLICT",
      "The project coordinator persona differs from its frozen original assignment",
    );

  if (parsed.kind === "operational")
    throw new MaisterError(
      "CONFIG",
      "operational agents cannot be bound as Flow personas or subagents",
      { details: { reason: "operational_combination_unsupported" } },
    );

  if (args.requireFlowTrigger !== false && !parsed.triggers.includes("flow")) {
    throw new MaisterError(
      "CONFIG",
      `agent "${args.agentId}" does not declare the "flow" trigger — flow binding refused`,
    );
  }

  const source = await readFile(effective.sourcePath, "utf8");

  if (usesStructuredKnowledgeContext(runRows[0] ?? {})) {
    if (!args.nodeAttemptId || parsed.mode !== "session")
      throw new MaisterError(
        "PRECONDITION",
        "Native Flow knowledge requires an explicit session role and current node attempt",
        { details: { reason: "native_knowledge_actor_required" } },
      );
    const activity = buildAgentActivitySnapshot(args.agentId, effective);

    await recordNativeKnowledgeActor(_db, {
      runId: args.runId,
      nodeAttemptId: args.nodeAttemptId,
      actor: {
        schemaVersion: 1,
        agentId: args.agentId,
        packageName: effective.packageName,
        packageInstallId: effective.packageInstallId,
        definitionSha256: activity.definitionSha256,
      },
    });
  }

  if (parsed.mode === "subagent") {
    const [attachment] = await _db.select({ memoryEnabled: agentProjectLinks.memoryEnabled })
      .from(agentProjectLinks).where(and(
        eq(agentProjectLinks.projectId, projectId),
        eq(agentProjectLinks.agentId, args.agentId),
      ));

    if (attachment?.memoryEnabled === true)
      throw new MaisterError("PRECONDITION", "A shared subagent session cannot hold an independent vault credential");
    if (args.executorAgent !== "claude") {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `agent "${args.agentId}" is mode=subagent (.claude/agents materialization) but the resolved executor capability is "${args.executorAgent}" — only claude can host it`,
      );
    }

    // FR-C4: shared materialize step (also used for scratch broad materialization).
    const targetPath = await materializeSubagentDefinition({
      worktreePath: args.worktreePath,
      runId: args.runId,
      agentId: args.agentId,
      source,
    });

    log.info(
      { agentId: args.agentId, targetPath },
      "subagent definition materialized into the worktree",
    );

    return { mode: "subagent", materializedPath: targetPath };
  }

  const configuration =
    companyPersona?.configuration ??
    assignedInput?.snapshot.standingDefinition.configuration;
  const prompt =
    configuration !== undefined
      ? `${parsed.prompt.trim()}\n\n## Specialist configuration\n${JSON.stringify(configuration)}`
      : parsed.prompt.trim();

  return { mode: "session", prompt };
}

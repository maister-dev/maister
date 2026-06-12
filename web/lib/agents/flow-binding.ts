import "server-only";

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import pino from "pino";

import { atomicWriteText } from "@/lib/atomic";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { agents, runs } = schemaModule as unknown as Record<string, any>;

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
  executorAgent: string;
  worktreePath: string;
  db?: Db;
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
  // HOST RUN project's pinned revision of the providing package, behind the
  // same enablement/trust gates as a standalone launch.
  const runRows = await _db
    .select({ projectId: runs.projectId })
    .from(runs)
    .where(eq(runs.id, args.runId));
  const projectId = runRows[0]?.projectId as string | undefined;

  if (!projectId) {
    throw new MaisterError(
      "PRECONDITION",
      `run ${args.runId} not found for agent binding resolution`,
    );
  }

  const { resolveEffectiveAgentDefinition } = await import(
    "@/lib/agents/effective"
  );
  const effective = await resolveEffectiveAgentDefinition(
    { agentId: args.agentId, projectId },
    _db,
  );
  const parsed = effective.parsed;

  if (!parsed.triggers.includes("flow")) {
    throw new MaisterError(
      "CONFIG",
      `agent "${args.agentId}" does not declare the "flow" trigger — flow binding refused`,
    );
  }

  const source = await readFile(effective.sourcePath, "utf8");

  if (parsed.mode === "subagent") {
    if (args.executorAgent !== "claude") {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `agent "${args.agentId}" is mode=subagent (.claude/agents materialization) but the resolved executor capability is "${args.executorAgent}" — only claude can host it`,
      );
    }

    const targetDir = path.join(args.worktreePath, ".claude", "agents");
    // Materialize under the file STEM — a `:` in the filename is hostile to
    // the .claude/agents convention; the subagent NAME comes from frontmatter.
    const stem = args.agentId.split(":").pop() ?? args.agentId;
    const targetPath = path.join(targetDir, `${stem}.md`);

    await mkdir(targetDir, { recursive: true });
    await atomicWriteText(targetPath, source);
    log.info(
      { agentId: args.agentId, targetPath },
      "subagent definition materialized into the worktree",
    );

    return { mode: "subagent", materializedPath: targetPath };
  }

  return { mode: "session", prompt: parsed.prompt.trim() };
}

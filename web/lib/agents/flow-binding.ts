import "server-only";

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import pino from "pino";

import { parseAgentDefinition } from "@/lib/agents/definition";
import { atomicWriteText } from "@/lib/atomic";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { agents } = schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "agent-flow-binding",
  level: process.env.LOG_LEVEL ?? "info",
});

export type FlowBoundAgentResolution =
  | { mode: "session"; prompt: string }
  | { mode: "subagent"; materializedPath: string };

// Resolves a node's `settings.agent` binding (ADR-087) at dispatch time.
// mode=session → the caller substitutes the agent's .md body as the system
// prompt; mode=subagent → the .md is materialized into the run worktree's
// .claude/agents/ (Claude self-delegates) and requires a claude-capability
// executor — refused with EXECUTOR_UNAVAILABLE otherwise, BEFORE any spawn.
export async function resolveFlowBoundAgent(args: {
  agentId: string;
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

  const triggers = (agent.triggers ?? []) as string[];

  if (!triggers.includes("flow")) {
    throw new MaisterError(
      "CONFIG",
      `agent "${args.agentId}" does not declare the "flow" trigger — flow binding refused`,
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

  let source: string;

  try {
    source = await readFile(agent.sourcePath as string, "utf8");
  } catch {
    throw new MaisterError(
      "CONFIG",
      `agent "${args.agentId}": definition file ${agent.sourcePath} is missing`,
    );
  }

  const parsed = parseAgentDefinition(args.agentId, source);

  if (parsed.mode === "subagent") {
    if (args.executorAgent !== "claude") {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `agent "${args.agentId}" is mode=subagent (.claude/agents materialization) but the resolved executor capability is "${args.executorAgent}" — only claude can host it`,
      );
    }

    const targetDir = path.join(args.worktreePath, ".claude", "agents");
    const targetPath = path.join(targetDir, `${args.agentId}.md`);

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

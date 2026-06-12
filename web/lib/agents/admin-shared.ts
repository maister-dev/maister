import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { AGENT_TRIGGER_KINDS } from "@/lib/agents/definition";
import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "api-admin-agents",
  level: process.env.LOG_LEVEL ?? "info",
});

export const agentDefinitionBodySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    name: z.string().min(1),
    description: z.string().min(1),
    scope: z.enum(["platform", "project"]),
    project: z.string().min(1).max(64).optional(),
    runner: z.string().min(1).max(128).nullable().optional(),
    workspace: z.enum(["none", "repo_read", "worktree"]),
    mode: z.enum(["session", "subagent"]),
    triggers: z.array(z.enum(AGENT_TRIGGER_KINDS)).min(1),
    capabilityProfile: z.record(z.unknown()).nullable().optional(),
    riskTier: z.enum(["read_only", "standard", "destructive"]),
    prompt: z.string().min(1),
  })
  .strict();

export type AgentDefinitionBody = z.infer<typeof agentDefinitionBodySchema>;

function statusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
    case "CONFLICT":
    case "PRECONDITION":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

export function agentsErrorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "agents admin API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// Explicit DTO projection — never serialize the raw row (repo rule).
export function projectAgentSummary(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.projectId ?? null,
    name: row.name,
    description: row.description,
    runnerId: row.runnerId ?? null,
    workspace: row.workspace,
    mode: row.mode,
    triggers: row.triggers,
    riskTier: row.riskTier,
    sourcePath: row.sourcePath,
    enabled: row.enabled,
    quarantinedAt: row.quarantinedAt ?? null,
    quarantineReason: row.quarantineReason ?? null,
  };
}

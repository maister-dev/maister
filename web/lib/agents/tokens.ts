import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { AGENT_TOKEN_SCOPES, TOKEN_SCOPES } from "@/types/token-scopes";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { generateToken } from "@/lib/tokens/secret";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectTokens } = schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "agent-tokens",
  level: process.env.LOG_LEVEL ?? "info",
});

// Per-launch ephemeral agent tokens (ADR-089): the hash-only token store
// cannot re-surface a durable attach-time secret at later spawns, so every
// agent run gets a fresh token, revoked at the run's terminal transition,
// on attachment detach, and by GC. Expiry is a backstop for runs that idle
// past every sweep.
const AGENT_TOKEN_TTL_HOURS = 48;

// M36 (ADR-095, Phase 3): the orchestrator's run-bound token carries the agent
// scope set PLUS the delegation toolset (run_delegate/run_collect/run_cancel
// over the maister MCP facade). A regular agent token keeps AGENT_TOKEN_SCOPES
// only — delegation is the orchestrator coordinator's privilege, not every
// agent's.
export const ORCHESTRATOR_TOKEN_SCOPES = [
  ...AGENT_TOKEN_SCOPES,
  "runs:delegate",
  "runs:collect",
  "runs:cancel",
  // M36 (ADR-097): promote a reviewed child (merge its branch → child Done).
  "runs:promote",
] as const satisfies readonly (typeof TOKEN_SCOPES)[number][];

export type IssuedAgentToken = {
  tokenId: string;
  secret: string;
};

export async function issueAgentRunToken(args: {
  agentId: string;
  projectId: string;
  runId: string;
  db?: Db;
}): Promise<IssuedAgentToken> {
  const _db = args.db ?? getDb();
  const { secret, prefix, hash } = generateToken();
  const tokenId = randomUUID();

  await _db.insert(projectTokens).values({
    id: tokenId,
    project_id: args.projectId,
    // Deterministic name — the terminal revoke matches on it exactly.
    name: `agent-run:${args.runId}`,
    token_kind: "agent",
    agent_id: args.agentId,
    prefix,
    token_hash: hash,
    scopes: [...AGENT_TOKEN_SCOPES],
    expires_at: new Date(Date.now() + AGENT_TOKEN_TTL_HOURS * 3_600_000),
  });

  log.info(
    { agentId: args.agentId, runId: args.runId, tokenId },
    "ephemeral agent token issued",
  );

  return { tokenId, secret };
}

// M36 (ADR-095): an orchestrator is a flow NODE, not a catalog agent — it has
// no `agents` row to hang an agent-kind token on, and the store CHECK forbids
// agent_id on a non-agent token. So a parked coordinator authenticates to the
// maister MCP facade via a PROJECT-kind, run-bound token (deterministic name →
// terminal revoke matches on it) carrying ORCHESTRATOR_TOKEN_SCOPES (agent
// scopes + the Phase-3 delegation toolset).
export async function issueOrchestratorRunToken(args: {
  projectId: string;
  runId: string;
  db?: Db;
}): Promise<IssuedAgentToken> {
  const _db = args.db ?? getDb();
  const { secret, prefix, hash } = generateToken();
  const tokenId = randomUUID();

  await _db.insert(projectTokens).values({
    id: tokenId,
    project_id: args.projectId,
    name: `orchestrator-run:${args.runId}`,
    token_kind: "project",
    prefix,
    token_hash: hash,
    scopes: [...ORCHESTRATOR_TOKEN_SCOPES],
    expires_at: new Date(Date.now() + AGENT_TOKEN_TTL_HOURS * 3_600_000),
  });

  log.info(
    { runId: args.runId, tokenId },
    "ephemeral orchestrator token issued",
  );

  return { tokenId, secret };
}

export async function revokeAgentRunToken(
  tokenId: string,
  db?: Db,
): Promise<void> {
  const _db = db ?? getDb();

  await _db
    .update(projectTokens)
    .set({ revoked_at: new Date() })
    .where(
      and(eq(projectTokens.id, tokenId), isNull(projectTokens.revoked_at)),
    );
}

// Terminal-transition revoke: every live ephemeral token issued for this run
// (matched on the deterministic `agent-run:<runId>` name).
export async function revokeAgentRunTokensForRun(
  runId: string,
  db?: Db,
): Promise<void> {
  const _db = db ?? getDb();

  await _db
    .update(projectTokens)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(projectTokens.token_kind, "agent"),
        eq(projectTokens.name, `agent-run:${runId}`),
        isNull(projectTokens.revoked_at),
      ),
    );
}

// M36 (ADR-095): terminal-transition revoke for the orchestrator's run-bound
// token (matched on the deterministic `orchestrator-run:<runId>` name). Not
// fired on the WaitingOnChildren park — the token must survive the wait so the
// Phase-5 resume can re-authenticate the respawned coordinator.
export async function revokeOrchestratorRunTokensForRun(
  runId: string,
  db?: Db,
): Promise<void> {
  const _db = db ?? getDb();

  await _db
    .update(projectTokens)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(projectTokens.name, `orchestrator-run:${runId}`),
        isNull(projectTokens.revoked_at),
      ),
    );
}

// Detach rotation guarantee (ADR-089): revoking every live token for the
// (agent, project) pair on link removal.
export async function revokeAgentProjectTokens(args: {
  agentId: string;
  projectId: string;
  db?: Db;
}): Promise<number> {
  const _db = args.db ?? getDb();
  const revoked = await _db
    .update(projectTokens)
    .set({ revoked_at: new Date() })
    .where(
      and(
        eq(projectTokens.agent_id, args.agentId),
        eq(projectTokens.project_id, args.projectId),
        isNull(projectTokens.revoked_at),
      ),
    )
    .returning({ id: projectTokens.id });

  if (revoked.length > 0) {
    log.info(
      {
        agentId: args.agentId,
        projectId: args.projectId,
        revoked: revoked.length,
      },
      "agent tokens revoked on detach",
    );
  }

  return revoked.length;
}

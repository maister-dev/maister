import "server-only";

import type { CompanyRunCredentialOwner } from "./company-run-credential-owner";
import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";

import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { COMPANY_FLOW_TOKEN_SCOPES } from "../../../runtime/company-flow-tools";

import { ACTIVE_AGENT_RUN_STATUSES } from "./activity-status";
import {
  requireCompanyRunCredentialOwner,
  requireCompanyFlowNodeKnowledgeOwner,
} from "./company-run-credential-owner";

import { assertNativeRunKnowledgeInputsInTransaction } from "@/lib/brain/knowledge-execution-access";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { AGENT_TOKEN_SCOPES, TOKEN_SCOPES } from "@/types/token-scopes";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { redactQueryError, queryErrorDiagnostics } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { generateToken } from "@/lib/tokens/secret";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projectTokens, runs } = schemaModule as unknown as Record<string, any>;

type Db = any;

export type RunTokenRow = typeof schemaModule.projectTokens.$inferSelect;
type TokenParent = Pick<
  typeof schemaModule.runs.$inferSelect,
  "projectId" | "companyId" | "agentId" | "runKind" | "status"
>;
type RunBinding = Readonly<{
  projectId: string;
  runId: string;
  originKind: "orchestrator_run" | "agent_run";
  agentId: string | null;
}>;

function stampedBinding(token: RunTokenRow): RunBinding | null {
  if (!token.bound_run_id || !token.origin_kind || !token.project_id)
    return null;
  if (
    (token.origin_kind === "orchestrator_run" &&
      token.token_kind !== "project") ||
    (token.origin_kind === "agent_run" &&
      (token.token_kind !== "agent" || !token.agent_id))
  )
    return null;

  return {
    projectId: token.project_id,
    runId: token.bound_run_id,
    originKind: token.origin_kind,
    agentId: token.agent_id,
  };
}

async function lockMintingRun(db: Db, binding: RunBinding): Promise<void> {
  const rows: TokenParent[] = await db
    .select({
      projectId: runs.projectId,
      companyId: runs.companyId,
      agentId: runs.agentId,
      runKind: runs.runKind,
      status: runs.status,
    })
    .from(runs)
    .where(eq(runs.id, binding.runId))
    .for("update");
  const parent = rows[0];

  if (
    !parent ||
    parent.projectId !== binding.projectId ||
    !ACTIVE_AGENT_RUN_STATUSES.includes(parent.status) ||
    (binding.originKind === "agent_run" &&
      (parent.runKind !== "agent" || parent.agentId !== binding.agentId)) ||
    (binding.originKind === "orchestrator_run" && parent.runKind !== "flow")
  )
    throw new MaisterError(
      "PRECONDITION",
      "Token issuance requires its current Run owner",
      { details: { reason: "token_run_binding_invalid" } },
    );
}

function runFamily(binding: RunBinding): SQL | undefined {
  return and(
    eq(projectTokens.project_id, binding.projectId),
    eq(projectTokens.bound_run_id, binding.runId),
    eq(projectTokens.origin_kind, binding.originKind),
    eq(
      projectTokens.token_kind,
      binding.originKind === "orchestrator_run" ? "project" : "agent",
    ),
    binding.agentId === null
      ? isNull(projectTokens.agent_id)
      : eq(projectTokens.agent_id, binding.agentId),
  );
}

/** Retire only a positively stamped immutable family; a display name never grants family authority. */
export async function revokeStampedRunTokenFamily(
  token: RunTokenRow,
  db: Db,
): Promise<number> {
  const binding = stampedBinding(token);

  if (!binding) return 0;
  await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(eq(runs.id, binding.runId), eq(runs.projectId, binding.projectId)),
    )
    .for("update");
  const updated: Array<{ id: string }> = await db
    .update(projectTokens)
    .set({
      revoked_at: sql`coalesce(${projectTokens.revoked_at},clock_timestamp())`,
      revocation_reason: "revoked",
    })
    .where(
      and(
        runFamily(binding),
        sql`${projectTokens.revocation_reason} IS DISTINCT FROM 'revoked'`,
      ),
    )
    .returning({ id: projectTokens.id });

  return updated.length;
}

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

// M37 (ADR-098, Phase 3): the orchestrator's run-bound token carries the agent
// scope set PLUS the delegation toolset (run_delegate/run_collect/run_cancel
// over the maister MCP facade). A regular agent token keeps AGENT_TOKEN_SCOPES
// only — delegation is the orchestrator coordinator's privilege, not every
// agent's.
export const ORCHESTRATOR_TOKEN_SCOPES = [
  ...AGENT_TOKEN_SCOPES,
  "runs:delegate",
  "runs:collect",
  "runs:cancel",
  // M37 (ADR-100): promote a reviewed child (merge its branch → child Done).
  "runs:promote",
] as const satisfies readonly (typeof TOKEN_SCOPES)[number][];

function legacyOrchestratorFamily(binding: RunBinding): SQL | undefined {
  return and(
    eq(projectTokens.project_id, binding.projectId),
    eq(projectTokens.token_kind, "project"),
    eq(projectTokens.name, `orchestrator-run:${binding.runId}`),
    isNull(projectTokens.bound_run_id),
    isNull(projectTokens.origin_kind),
    isNull(projectTokens.agent_id),
    isNull(projectTokens.owner_user_id),
    isNull(projectTokens.librarian_turn_id),
    isNull(projectTokens.created_by),
    sql`${projectTokens.scopes} @> ${JSON.stringify(ORCHESTRATOR_TOKEN_SCOPES)}::jsonb`,
    sql`${projectTokens.scopes} <@ ${JSON.stringify(ORCHESTRATOR_TOKEN_SCOPES)}::jsonb`,
  );
}

/** Rotate the existing hash-only credential without changing its execution or professional binding. */
async function retainCompanyRunCredential(
  tx: SqlTransaction,
  owner: CompanyRunCredentialOwner,
  nodeAttemptId: string | null,
): Promise<IssuedAgentToken> {
  await authorizeCompanyUserAction(
    tx,
    owner.userId,
    owner.companyId,
    "assignments:update",
  );
  const scopes = COMPANY_FLOW_TOKEN_SCOPES.filter((action) =>
    owner.actionLimits.includes(action),
  );
  const { secret, prefix, hash } = generateToken();
  const tokenId = randomUUID();
  const name = `agent-run:${owner.runId}`;

  await tx.execute(
    sql`UPDATE project_tokens SET revoked_at=now() WHERE token_kind='agent' AND company_run_id=${owner.runId} AND revoked_at IS NULL`,
  );
  await tx.execute(sql`INSERT INTO project_tokens(id,company_id,company_run_id,name,token_kind,owner_user_id,agent_id,knowledge_node_attempt_id,prefix,token_hash,scopes,expires_at)
    VALUES(${tokenId},${owner.companyId},${owner.runId},${name},'agent',${owner.userId},${owner.agentId},${nodeAttemptId},${prefix},${hash},${JSON.stringify(scopes)}::jsonb,${new Date(Date.now() + AGENT_TOKEN_TTL_HOURS * 3600000)})`);
  log.info(
    {
      runId: owner.runId,
      companyId: owner.companyId,
      agentId: owner.agentId,
      nodeAttemptId,
      tokenId,
      scopeCount: scopes.length,
    },
    "ephemeral company execution token issued",
  );

  return { tokenId, secret };
}

/** Company graph authority must be bound to the exact current server-attested node. */
export async function issueCompanyFlowNodeRunToken(
  args: Readonly<{ runId: string; nodeAttemptId: string; db?: SqlDatabase }>,
): Promise<IssuedAgentToken> {
  const db: SqlDatabase = args.db ?? getDb();

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM runs WHERE id=${args.runId} FOR UPDATE`,
      );
      const rootOwner = await requireCompanyRunCredentialOwner(tx, args.runId);
      const owner = await requireCompanyFlowNodeKnowledgeOwner(
        tx,
        rootOwner,
        args.nodeAttemptId,
      );

      await assertNativeRunKnowledgeInputsInTransaction(tx, args.runId);

      return retainCompanyRunCredential(tx, owner, args.nodeAttemptId);
    });
  } catch (error) {
    log.warn(
      {
        runId: args.runId,
        nodeAttemptId: args.nodeAttemptId,
        code: error instanceof MaisterError ? error.code : undefined,
        ...queryErrorDiagnostics(error),
      },
      "company Flow node credential refused",
    );
    throw redactQueryError(error);
  }
}

// ADR-145 (Evaluation Lab) D10/D12: a judge attempt's ephemeral token carries
// ONLY the four attempt-bound evaluator scopes — it does NOT spread
// AGENT_TOKEN_SCOPES. A judge reads its token-bound evidence snapshot and submits
// exactly one result; it cannot browse a project/worktree, read/mutate tasks,
// comment, or launch anything. The execution/attempt binding lives in
// `evaluation_judge_attempts.token_id` (resolved server-side), so no evaluator
// tool ever accepts a study/run/snapshot id from the client.
export const EVALUATION_JUDGE_TOKEN_SCOPES = [
  "evaluations:context:read",
  "evaluations:evidence:read",
  "evaluations:objective:read",
  "evaluations:result:submit",
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

  await _db.transaction(async (tx: Db) => {
    await lockMintingRun(tx, {
      projectId: args.projectId,
      runId: args.runId,
      originKind: "agent_run",
      agentId: args.agentId,
    });
    await tx.insert(projectTokens).values({
      id: tokenId,
      project_id: args.projectId,
      bound_run_id: args.runId,
      origin_kind: "agent_run",
      // Deterministic name — the terminal revoke matches on it exactly.
      name: `agent-run:${args.runId}`,
      token_kind: "agent",
      agent_id: args.agentId,
      prefix,
      token_hash: hash,
      scopes: [...AGENT_TOKEN_SCOPES],
      expires_at: new Date(Date.now() + AGENT_TOKEN_TTL_HOURS * 3_600_000),
    });
  });

  log.info(
    { agentId: args.agentId, runId: args.runId, tokenId },
    "ephemeral agent token issued",
  );

  return { tokenId, secret };
}

/** Company tokens extend the existing hash-only run credential and terminal revocation lifecycle. */
export async function issueCompanyAgentRunToken(
  args: Readonly<{ runId: string; db?: SqlDatabase }>,
): Promise<IssuedAgentToken> {
  const db: SqlDatabase = args.db ?? getDb();
  const issued = await db
    .transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM runs WHERE id=${args.runId} FOR UPDATE`,
      );
      const owner = await requireCompanyRunCredentialOwner(tx, args.runId);

      if (owner.snapshot.schemaVersion !== 1)
        throw new MaisterError(
          "UNAUTHORIZED",
          "Company graph credentials require their exact current node; the standalone issuer cannot mint them",
        );

      return retainCompanyRunCredential(tx, owner, null);
    })
    .catch((error: unknown) => {
      throw redactQueryError(error);
    });

  return issued;
}

// ADR-145 (Evaluation Lab) D12: a judge attempt runs as a dedicated agent Run
// (workspace:none). Its ephemeral token carries ONLY EVALUATION_JUDGE_TOKEN_SCOPES
// and rides the same deterministic `agent-run:<runId>` name so the standard
// terminal revoke (revokeAgentRunTokensForRun) fires when the attempt's agent Run
// ends; the sealing service ALSO revokes it explicitly the moment a result is
// sealed. The execution/attempt binding is stored on the attempt row, not the
// token — the evaluator facade resolves it server-side.
export async function issueJudgeAttemptToken(args: {
  agentId: string;
  projectId: string;
  runId: string;
  db?: Db;
}): Promise<IssuedAgentToken> {
  const _db = args.db ?? getDb();
  const { secret, prefix, hash } = generateToken();
  const tokenId = randomUUID();

  await _db.transaction(async (tx: Db) => {
    await lockMintingRun(tx, {
      projectId: args.projectId,
      runId: args.runId,
      originKind: "agent_run",
      agentId: args.agentId,
    });
    await tx.insert(projectTokens).values({
      id: tokenId,
      project_id: args.projectId,
      bound_run_id: args.runId,
      origin_kind: "agent_run",
      name: `agent-run:${args.runId}`,
      token_kind: "agent",
      agent_id: args.agentId,
      prefix,
      token_hash: hash,
      scopes: [...EVALUATION_JUDGE_TOKEN_SCOPES],
      expires_at: new Date(Date.now() + AGENT_TOKEN_TTL_HOURS * 3_600_000),
    });
  });

  log.info(
    { agentId: args.agentId, runId: args.runId, tokenId },
    "ephemeral judge attempt token issued",
  );

  return { tokenId, secret };
}

// M37 (ADR-098): an orchestrator is a flow NODE, not a catalog agent — it has
// no `agents` row to hang an agent-kind token on, and the store CHECK forbids
// agent_id on a non-agent token. So a parked coordinator authenticates to the
// maister MCP facade via a PROJECT-kind, run-bound token (deterministic name →
// terminal revoke matches on it) carrying ORCHESTRATOR_TOKEN_SCOPES (agent
// scopes + the Phase-3 delegation toolset).
type NodeRunTokenInput = Readonly<{
  projectId: string;
  runId: string;
  nodeAttemptId?: string;
  db?: Db;
}>;

export async function issueOrchestratorRunToken(
  args: NodeRunTokenInput,
): Promise<IssuedAgentToken> {
  return issueNodeRunToken(args, ORCHESTRATOR_TOKEN_SCOPES);
}

/** Native ordinary Flow nodes get knowledge tools without acquiring coordinator delegation authority. */
export async function issueNativeNodeRunToken(
  args: NodeRunTokenInput & Readonly<{ nodeAttemptId: string }>,
): Promise<IssuedAgentToken> {
  return issueNodeRunToken(args, AGENT_TOKEN_SCOPES);
}

async function issueNodeRunToken(
  args: NodeRunTokenInput,
  scopes: readonly (typeof TOKEN_SCOPES)[number][],
): Promise<IssuedAgentToken> {
  const _db = args.db ?? getDb();
  const { secret, prefix, hash } = generateToken();
  const tokenId = randomUUID();

  await _db.transaction(async (tx: Db) => {
    const binding: RunBinding = {
      projectId: args.projectId,
      runId: args.runId,
      originKind: "orchestrator_run",
      agentId: null,
    };

    await lockMintingRun(tx, binding);
    await tx
      .update(projectTokens)
      .set({
        revoked_at: new Date(),
        // Only an actual delegation credential can retain accepted child obligations.
        revocation_reason: sql`CASE WHEN ${projectTokens.scopes} ? 'runs:delegate' OR ${projectTokens.scopes} ? '*' THEN 'rotation' ELSE 'revoked' END`,
      })
      .where(and(runFamily(binding), isNull(projectTokens.revoked_at)));
    // Legacy names can identify a private credential for retirement, never for a grant.
    await tx
      .update(projectTokens)
      .set({ revoked_at: new Date(), revocation_reason: "revoked" })
      .where(
        and(
          legacyOrchestratorFamily(binding),
          isNull(projectTokens.revoked_at),
        ),
      );
    await tx.insert(projectTokens).values({
      id: tokenId,
      project_id: args.projectId,
      bound_run_id: args.runId,
      origin_kind: "orchestrator_run",
      name: `orchestrator-run:${args.runId}`,
      token_kind: "project",
      prefix,
      token_hash: hash,
      knowledge_node_attempt_id: args.nodeAttemptId ?? null,
      scopes: [...scopes],
      expires_at: new Date(Date.now() + AGENT_TOKEN_TTL_HOURS * 3_600_000),
    });
  });

  log.info(
    {
      runId: args.runId,
      tokenId,
      nodeAttemptId: args.nodeAttemptId,
      scopeCount: scopes.length,
    },
    "ephemeral Flow node token issued",
  );

  return { tokenId, secret };
}

export async function revokeAgentRunToken(
  tokenId: string,
  db?: Db,
): Promise<void> {
  const database = db ?? getDb();

  await database.transaction(async (tx: Db) => {
    const rows: RunTokenRow[] = await tx
      .select()
      .from(projectTokens)
      .where(
        and(
          eq(projectTokens.id, tokenId),
          eq(projectTokens.token_kind, "agent"),
        ),
      );
    const token = rows[0];

    if (!token) return;
    if (stampedBinding(token)) {
      await revokeStampedRunTokenFamily(token, tx);

      return;
    }
    await tx
      .update(projectTokens)
      .set({
        revoked_at: sql`coalesce(${projectTokens.revoked_at},clock_timestamp())`,
        revocation_reason: "revoked",
      })
      .where(
        and(
          eq(projectTokens.id, tokenId),
          eq(projectTokens.token_kind, "agent"),
          sql`${projectTokens.revocation_reason} IS DISTINCT FROM 'revoked'`,
        ),
      );
  });
}

async function currentRunForRevocation(
  db: Db,
  runId: string,
): Promise<TokenParent | null> {
  const rows: TokenParent[] = await db
    .select({
      projectId: runs.projectId,
      companyId: runs.companyId,
      agentId: runs.agentId,
      runKind: runs.runKind,
      status: runs.status,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update");

  return rows[0] ?? null;
}

// Terminal ownership is resolved from the actual Run; names identify legacy rows only for retirement.
export async function revokeAgentRunTokensForRun(
  runId: string,
  db?: Db,
): Promise<void> {
  const database = db ?? getDb();

  await database.transaction(async (tx: Db) => {
    const parent = await currentRunForRevocation(tx, runId);

    if (parent?.companyId) {
      const revoked: Array<{ id: string }> = await tx
        .update(projectTokens)
        .set({
          revoked_at: sql`coalesce(${projectTokens.revoked_at},clock_timestamp())`,
          revocation_reason: "revoked",
        })
        .where(
          and(
            eq(projectTokens.token_kind, "agent"),
            eq(projectTokens.company_id, parent.companyId),
            eq(projectTokens.company_run_id, runId),
            sql`${projectTokens.revocation_reason} IS DISTINCT FROM 'revoked'`,
          ),
        )
        .returning({ id: projectTokens.id });

      log.info(
        { runId, companyId: parent.companyId, revoked: revoked.length },
        "company execution credential family retired",
      );

      return;
    }
    if (!parent?.projectId || !parent.agentId) return;
    const binding: RunBinding = {
      projectId: parent.projectId,
      runId,
      originKind: "agent_run",
      agentId: parent.agentId,
    };

    await tx
      .update(projectTokens)
      .set({
        revoked_at: sql`coalesce(${projectTokens.revoked_at},clock_timestamp())`,
        revocation_reason: "revoked",
      })
      .where(
        and(
          eq(projectTokens.project_id, parent.projectId),
          eq(projectTokens.token_kind, "agent"),
          eq(projectTokens.agent_id, parent.agentId),
          sql`(${runFamily(binding)} OR (${projectTokens.bound_run_id} IS NULL AND ${projectTokens.origin_kind} IS NULL AND ${projectTokens.name}=${`agent-run:${runId}`}))`,
          sql`${projectTokens.revocation_reason} IS DISTINCT FROM 'revoked'`,
        ),
      );
  });
}

// Normal completion and explicit stop retire every captured generation in the exact Run family.
export async function revokeOrchestratorRunTokensForRun(
  runId: string,
  db?: Db,
): Promise<void> {
  const database = db ?? getDb();

  await database.transaction(async (tx: Db) => {
    const parent = await currentRunForRevocation(tx, runId);

    if (!parent?.projectId) return;
    const binding: RunBinding = {
      projectId: parent.projectId,
      runId,
      originKind: "orchestrator_run",
      agentId: null,
    };

    await tx
      .update(projectTokens)
      .set({
        revoked_at: sql`coalesce(${projectTokens.revoked_at},clock_timestamp())`,
        revocation_reason: "revoked",
      })
      .where(
        and(
          sql`(${runFamily(binding)} OR ${legacyOrchestratorFamily(binding)})`,
          sql`${projectTokens.revocation_reason} IS DISTINCT FROM 'revoked'`,
        ),
      );
  });
}

// Detach revokes the exact project/agent subject, including already-retired generations.
export async function revokeAgentProjectTokens(args: {
  agentId: string;
  projectId: string;
  db?: Db;
}): Promise<number> {
  const database = args.db ?? getDb();
  const revoked: Array<{ id: string }> = await database
    .update(projectTokens)
    .set({
      revoked_at: sql`coalesce(${projectTokens.revoked_at},clock_timestamp())`,
      revocation_reason: "revoked",
    })
    .where(
      and(
        eq(projectTokens.token_kind, "agent"),
        eq(projectTokens.agent_id, args.agentId),
        eq(projectTokens.project_id, args.projectId),
        sql`${projectTokens.revocation_reason} IS DISTINCT FROM 'revoked'`,
      ),
    )
    .returning({ id: projectTokens.id });

  if (revoked.length > 0)
    log.info(
      {
        agentId: args.agentId,
        projectId: args.projectId,
        revoked: revoked.length,
      },
      "agent tokens revoked on detach",
    );

  return revoked.length;
}

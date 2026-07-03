import "server-only";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import type {
  BrainProposalActor,
  BrainProposalAutonomyDecision,
  BrainProposalBlastRadius,
  BrainProposalKind,
  BrainProposalResolution,
  BrainProposalStatus,
} from "./schema";

import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "brain:proposals",
  level: process.env.LOG_LEVEL ?? "info",
});

const PROPOSAL_KINDS = [
  "rule",
  "skill",
  "flow",
  "adr",
  "roadmap",
  "state",
] as const satisfies readonly BrainProposalKind[];
const BLAST_RADII = [
  "low",
  "medium",
  "high",
] as const satisfies readonly BrainProposalBlastRadius[];
const AUTONOMY_DECISIONS = [
  "manual",
  "auto_draft",
] as const satisfies readonly BrainProposalAutonomyDecision[];

type ProposalDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

type ProposalTxDb = ProposalDb & {
  transaction<T>(fn: (tx: ProposalDb) => Promise<T>): Promise<T>;
};

export interface BrainProposalDto {
  id: string;
  projectId: string;
  kind: BrainProposalKind;
  evidenceItemIds: string[];
  draft: Record<string, unknown>;
  status: BrainProposalStatus;
  blastRadius: BrainProposalBlastRadius;
  autonomyDecision: BrainProposalAutonomyDecision;
  clusterHash: string | null;
  actor: BrainProposalActor;
  resolution: BrainProposalResolution | null;
  authoredDraftId: string | null;
  taskId: string | null;
  runId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  resolvedAt: Date | string | null;
  appliedAt: Date | string | null;
  idempotent: boolean;
}

export interface CreateBrainProposalInput {
  projectId: string;
  kind: BrainProposalKind;
  evidenceItemIds: string[];
  draft: Record<string, unknown>;
  blastRadius: BrainProposalBlastRadius;
  autonomyDecision: BrainProposalAutonomyDecision;
  clusterHash?: string | null;
  actor: BrainProposalActor;
}

export interface TransitionBrainProposalInput {
  projectId: string;
  proposalId: string;
  transition: "accept" | "reject" | "apply";
  actor: BrainProposalActor;
  reason?: string;
  links?: {
    authoredDraftId?: string | null;
    taskId?: string | null;
    runId?: string | null;
  };
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function assertActor(actor: BrainProposalActor): void {
  if (!isOneOf(actor.type, ["user", "agent", "system"] as const)) {
    throw new MaisterError("CONFIG", `invalid proposal actor type: ${actor.type}`);
  }

  if (actor.id.trim().length === 0) {
    throw new MaisterError("CONFIG", "proposal actor id is required");
  }
}

function assertCreateInput(input: CreateBrainProposalInput): void {
  if (!isOneOf(input.kind, PROPOSAL_KINDS)) {
    throw new MaisterError("CONFIG", `invalid proposal kind: ${input.kind}`);
  }

  if (!isOneOf(input.blastRadius, BLAST_RADII)) {
    throw new MaisterError(
      "CONFIG",
      `invalid proposal blast radius: ${input.blastRadius}`,
    );
  }

  if (!isOneOf(input.autonomyDecision, AUTONOMY_DECISIONS)) {
    throw new MaisterError(
      "CONFIG",
      `invalid proposal autonomy decision: ${input.autonomyDecision}`,
    );
  }

  assertActor(input.actor);
}

function toProposal(row: Record<string, unknown>): BrainProposalDto {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: row.kind as BrainProposalKind,
    evidenceItemIds: (row.evidence_item_ids as string[]) ?? [],
    draft: (row.draft as Record<string, unknown>) ?? {},
    status: row.status as BrainProposalStatus,
    blastRadius: row.blast_radius as BrainProposalBlastRadius,
    autonomyDecision: row.autonomy_decision as BrainProposalAutonomyDecision,
    clusterHash: (row.cluster_hash as string | null) ?? null,
    actor: row.actor as BrainProposalActor,
    resolution: (row.resolution as BrainProposalResolution | null) ?? null,
    authoredDraftId: (row.authored_draft_id as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    runId: (row.run_id as string | null) ?? null,
    createdAt: row.created_at as Date | string,
    updatedAt: row.updated_at as Date | string,
    resolvedAt: (row.resolved_at as Date | string | null) ?? null,
    appliedAt: (row.applied_at as Date | string | null) ?? null,
    idempotent: Boolean(row.idempotent),
  };
}

async function loadProposalForUpdate(
  db: ProposalDb,
  projectId: string,
  proposalId: string,
): Promise<BrainProposalDto> {
  const rows = await db.execute(sql`
    SELECT *
    FROM brain_proposals
    WHERE id = ${proposalId} AND project_id = ${projectId}
    FOR UPDATE
  `);

  if (!rows.rows[0]) {
    throw new MaisterError("PRECONDITION", "Brain proposal not found");
  }

  return toProposal(rows.rows[0]);
}

function resolution(actor: BrainProposalActor, reason?: string): BrainProposalResolution {
  return reason ? { actor, reason } : { actor };
}

function assertTransition(
  current: BrainProposalStatus,
  transition: TransitionBrainProposalInput["transition"],
): BrainProposalStatus {
  if (transition === "accept" && current === "pending") return "accepted";
  if (transition === "reject" && current === "pending") return "rejected";
  if (transition === "apply" && current === "accepted") return "applied";

  throw new MaisterError(
    "CONFLICT",
    `invalid Brain proposal transition ${current} -> ${transition}`,
  );
}

export async function createBrainProposal(
  db: ProposalDb,
  input: CreateBrainProposalInput,
): Promise<BrainProposalDto> {
  assertCreateInput(input);

  if (input.clusterHash) {
    const existing = await db.execute(sql`
      SELECT *, true AS idempotent
      FROM brain_proposals
      WHERE project_id = ${input.projectId}
        AND cluster_hash = ${input.clusterHash}
      LIMIT 1
    `);

    if (existing.rows[0]) return toProposal(existing.rows[0]);
  }

  const id = randomUUID();
  const rows = await db.execute(sql`
    INSERT INTO brain_proposals
      (id, project_id, kind, evidence_item_ids, draft, status, blast_radius,
       autonomy_decision, cluster_hash, actor)
    VALUES
      (${id}, ${input.projectId}, ${input.kind},
       ${JSON.stringify(input.evidenceItemIds)}::jsonb,
       ${JSON.stringify(input.draft)}::jsonb, 'pending',
       ${input.blastRadius}, ${input.autonomyDecision},
       ${input.clusterHash ?? null}, ${JSON.stringify(input.actor)}::jsonb)
    RETURNING *, false AS idempotent
  `);
  const proposal = toProposal(rows.rows[0]);

  log.info(
    {
      projectId: input.projectId,
      proposalId: proposal.id,
      kind: proposal.kind,
      status: proposal.status,
      actorType: input.actor.type,
    },
    "brain proposal created",
  );

  return proposal;
}

export async function transitionBrainProposal(
  db: ProposalTxDb,
  input: TransitionBrainProposalInput,
): Promise<BrainProposalDto> {
  assertActor(input.actor);

  return db.transaction(async (tx) => {
    const current = await loadProposalForUpdate(
      tx,
      input.projectId,
      input.proposalId,
    );
    const nextStatus = assertTransition(current.status, input.transition);
    const resolved =
      input.transition === "apply"
        ? (current.resolution ?? resolution(input.actor, input.reason))
        : resolution(input.actor, input.reason);
    const links = input.links ?? {};
    const rows = await tx.execute(sql`
      UPDATE brain_proposals
      SET status = ${nextStatus},
          resolution = ${JSON.stringify(resolved)}::jsonb,
          authored_draft_id = COALESCE(${links.authoredDraftId ?? null}, authored_draft_id),
          task_id = COALESCE(${links.taskId ?? null}, task_id),
          run_id = COALESCE(${links.runId ?? null}, run_id),
          resolved_at = CASE
            WHEN ${nextStatus} IN ('accepted', 'rejected') THEN now()
            ELSE resolved_at
          END,
          applied_at = CASE
            WHEN ${nextStatus} = 'applied' THEN now()
            ELSE applied_at
          END,
          updated_at = now()
      WHERE id = ${input.proposalId} AND project_id = ${input.projectId}
      RETURNING *
    `);
    const proposal = toProposal(rows.rows[0]);

    log.info(
      {
        projectId: input.projectId,
        proposalId: input.proposalId,
        kind: proposal.kind,
        status: proposal.status,
        actorType: input.actor.type,
      },
      "brain proposal transitioned",
    );

    return proposal;
  });
}

import "server-only";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import type {
  AuthoredCapabilityBody,
  AuthoredCapabilityKind,
  CreateAuthoredCapabilityInput,
} from "@/lib/catalog/authored-types";
import type {
  BrainProposalActor,
  BrainProposalAutonomyDecision,
  BrainProposalBlastRadius,
  BrainProposalKind,
  BrainProposalResolution,
  BrainProposalStatus,
} from "./schema";

import {
  getBrainAutonomyPolicy,
  resolveBrainAutonomyDecision,
} from "@/lib/brain/autonomy";
import { projectBrainProposalToTask } from "@/lib/brain/projection";
import { createAuthoredCapabilityDraftInTransaction } from "@/lib/catalog/authored-service";
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

export type BrainProposalDb = ProposalDb;
export type BrainProposalTransactionalDb = ProposalTxDb;

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

export interface CreateBrainProposalWithAutonomyInput {
  projectId: string;
  projectSlug: string;
  kind: BrainProposalKind;
  evidenceItemIds: string[];
  draft: Record<string, unknown>;
  blastRadius: BrainProposalBlastRadius;
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

export interface ConcludeBrainProposalInput {
  projectId: string;
  projectSlug: string;
  proposalId: string;
  action: "accept" | "reject";
  actor: BrainProposalActor;
  reason?: string;
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return (
    typeof value === "string" &&
    (values as readonly string[]).includes(value)
  );
}

function assertActor(actor: BrainProposalActor): void {
  if (!isOneOf(actor.type, ["user", "agent", "system"] as const)) {
    throw new MaisterError("CONFIG", `invalid proposal actor type: ${actor.type}`);
  }

  if (actor.id.trim().length === 0) {
    throw new MaisterError("CONFIG", "proposal actor id is required");
  }
}

function assertHumanConclusionActor(actor: BrainProposalActor): void {
  if (actor.type !== "user") {
    throw new MaisterError(
      "UNAUTHORIZED",
      "Brain proposal conclusions require a human user actor",
    );
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

export async function getBrainProposal(
  db: ProposalDb,
  projectId: string,
  proposalId: string,
): Promise<BrainProposalDto> {
  const rows = await db.execute(sql`
    SELECT *, false AS idempotent
    FROM brain_proposals
    WHERE id = ${proposalId} AND project_id = ${projectId}
    LIMIT 1
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

function assertTransitionActor(
  transition: TransitionBrainProposalInput["transition"],
  actor: BrainProposalActor,
): void {
  if (transition === "accept" || transition === "reject") {
    assertHumanConclusionActor(actor);
  }
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

export async function createBrainProposalWithAutonomy(
  db: ProposalDb | ProposalTxDb,
  input: CreateBrainProposalWithAutonomyInput,
): Promise<BrainProposalDto> {
  assertActor(input.actor);

  const apply = async (tx: ProposalDb): Promise<BrainProposalDto> => {
    const policy = await getBrainAutonomyPolicy(tx, input.projectId);
    const decision = resolveBrainAutonomyDecision(
      policy,
      input.kind,
      input.blastRadius,
    );
    const created = await createBrainProposal(tx, {
      projectId: input.projectId,
      kind: input.kind,
      evidenceItemIds: input.evidenceItemIds,
      draft: input.draft,
      blastRadius: input.blastRadius,
      autonomyDecision: decision,
      clusterHash: input.clusterHash,
      actor: input.actor,
    });

    log.info(
      {
        projectId: input.projectId,
        kind: input.kind,
        blastRadius: input.blastRadius,
        decision,
      },
      "brain proposal autonomy decision resolved",
    );

    if (created.idempotent || decision !== "auto_draft") return created;
    if (!isCatalogProposalKind(created.kind)) return created;

    return autoDraftBrainProposalInTransaction(tx, {
      projectId: input.projectId,
      projectSlug: input.projectSlug,
      proposalId: created.id,
    });
  };

  return "transaction" in db && typeof db.transaction === "function"
    ? db.transaction(apply)
    : apply(db);
}

export async function transitionBrainProposal(
  db: ProposalTxDb,
  input: TransitionBrainProposalInput,
): Promise<BrainProposalDto> {
  assertActor(input.actor);
  assertTransitionActor(input.transition, input.actor);

  return db.transaction((tx) => transitionBrainProposalInTransaction(tx, input));
}

async function transitionBrainProposalInTransaction(
  db: ProposalDb,
  input: TransitionBrainProposalInput,
): Promise<BrainProposalDto> {
  assertActor(input.actor);
  assertTransitionActor(input.transition, input.actor);

  const current = await loadProposalForUpdate(
    db,
    input.projectId,
    input.proposalId,
  );

  return transitionLoadedBrainProposal(db, current, input);
}

async function transitionLoadedBrainProposal(
  db: ProposalDb,
  current: BrainProposalDto,
  input: TransitionBrainProposalInput,
): Promise<BrainProposalDto> {
  const nextStatus = assertTransition(current.status, input.transition);
  const resolved =
    input.transition === "apply"
      ? (current.resolution ?? resolution(input.actor, input.reason))
      : resolution(input.actor, input.reason);
  const links = input.links ?? {};
  const rows = await db.execute(sql`
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

  await incrementProposalDecisionStats(db, current, input);

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
}

async function incrementProposalDecisionStats(
  db: ProposalDb,
  current: BrainProposalDto,
  input: TransitionBrainProposalInput,
): Promise<void> {
  if (input.transition !== "accept" && input.transition !== "reject") return;

  const acceptedCount = input.transition === "accept" ? 1 : 0;
  const rejectedCount = input.transition === "reject" ? 1 : 0;
  const autoDraftedCount =
    input.transition === "accept" &&
    current.autonomyDecision === "auto_draft" &&
    input.actor.type === "system" &&
    input.reason === "auto_draft"
      ? 1
      : 0;

  await db.execute(sql`
    INSERT INTO brain_proposal_decision_stats (
      project_id,
      kind,
      blast_radius,
      accepted_count,
      rejected_count,
      auto_drafted_count
    )
    VALUES (
      ${current.projectId},
      ${current.kind},
      ${current.blastRadius},
      ${acceptedCount},
      ${rejectedCount},
      ${autoDraftedCount}
    )
    ON CONFLICT (project_id, kind, blast_radius)
    DO UPDATE SET
      accepted_count =
        brain_proposal_decision_stats.accepted_count +
        EXCLUDED.accepted_count,
      rejected_count =
        brain_proposal_decision_stats.rejected_count +
        EXCLUDED.rejected_count,
      auto_drafted_count =
        brain_proposal_decision_stats.auto_drafted_count +
        EXCLUDED.auto_drafted_count,
      updated_at = now()
  `);
}

export async function concludeBrainProposal(
  db: ProposalTxDb,
  input: ConcludeBrainProposalInput,
): Promise<BrainProposalDto> {
  assertActor(input.actor);
  assertHumanConclusionActor(input.actor);

  return db.transaction(async (tx) => {
    const current = await loadProposalForUpdate(
      tx,
      input.projectId,
      input.proposalId,
    );

    if (current.status !== "pending") {
      throw new MaisterError(
        "CONFLICT",
        `Brain proposal ${input.proposalId} is ${current.status} and cannot be concluded`,
      );
    }

    if (input.action === "reject") {
      const rejected = await transitionLoadedBrainProposal(tx, current, {
        projectId: input.projectId,
        proposalId: input.proposalId,
        transition: "reject",
        actor: input.actor,
        reason: input.reason,
      });

      log.info(
        {
          projectId: input.projectId,
          proposalId: input.proposalId,
          kind: rejected.kind,
          resolvedBy: input.actor.id,
        },
        "brain proposal rejected",
      );

      return rejected;
    }

    const accepted = await transitionLoadedBrainProposal(tx, current, {
      projectId: input.projectId,
      proposalId: input.proposalId,
      transition: "accept",
      actor: input.actor,
      reason: input.reason,
    });

    if (!isCatalogProposalKind(current.kind)) {
      const projected = await projectBrainProposalToTask(tx as any, {
        projectId: input.projectId,
        proposalId: input.proposalId,
        kind: current.kind,
        draft: accepted.draft,
        actor: input.actor,
      });
      const applied = await transitionLoadedBrainProposal(tx, accepted, {
        projectId: input.projectId,
        proposalId: input.proposalId,
        transition: "apply",
        actor: input.actor,
        links: { taskId: projected.taskId },
      });

      log.info(
        {
          projectId: input.projectId,
          proposalId: input.proposalId,
          kind: applied.kind,
          taskId: applied.taskId,
          launchMode: projected.launchMode,
          resolvedBy: input.actor.id,
        },
        "brain proposal accepted into projection task",
      );

      return applied;
    }

    const authored = await createAuthoredCapabilityDraftInTransaction({
      projectSlug: input.projectSlug,
      input: authoredInputFromProposal({ ...accepted, kind: current.kind }),
      db: tx,
    });
    const applied = await transitionLoadedBrainProposal(tx, accepted, {
      projectId: input.projectId,
      proposalId: input.proposalId,
      transition: "apply",
      actor: input.actor,
      links: { authoredDraftId: authored.capability.id },
    });

    log.info(
      {
        projectId: input.projectId,
        proposalId: input.proposalId,
        kind: applied.kind,
        resolvedBy: input.actor.id,
      },
      "brain proposal accepted into authored draft",
    );

    return applied;
  });
}

async function autoDraftBrainProposalInTransaction(
  db: ProposalDb,
  input: {
    projectId: string;
    projectSlug: string;
    proposalId: string;
  },
): Promise<BrainProposalDto> {
  const actor: BrainProposalActor = { type: "system", id: "brain-autonomy" };
  const current = await loadProposalForUpdate(
    db,
    input.projectId,
    input.proposalId,
  );

  if (current.status !== "pending") {
    throw new MaisterError(
      "CONFLICT",
      `Brain proposal ${input.proposalId} is ${current.status} and cannot auto-draft`,
    );
  }

  if (!isCatalogProposalKind(current.kind)) {
    return current;
  }

  const accepted = await transitionLoadedBrainProposal(db, current, {
    projectId: input.projectId,
    proposalId: input.proposalId,
    transition: "accept",
    actor,
    reason: "auto_draft",
  });
  const authored = await createAuthoredCapabilityDraftInTransaction({
    projectSlug: input.projectSlug,
    input: authoredInputFromProposal({ ...accepted, kind: current.kind }),
    db,
  });
  const applied = await transitionLoadedBrainProposal(db, accepted, {
    projectId: input.projectId,
    proposalId: input.proposalId,
    transition: "apply",
    actor,
    links: { authoredDraftId: authored.capability.id },
  });

  log.info(
    {
      projectId: input.projectId,
      proposalId: input.proposalId,
      kind: applied.kind,
      blastRadius: applied.blastRadius,
      decision: "auto_draft",
    },
    "brain proposal auto-drafted",
  );

  return applied;
}

function isCatalogProposalKind(
  kind: BrainProposalKind,
): kind is AuthoredCapabilityKind {
  return kind === "rule" || kind === "skill" || kind === "flow";
}

function authoredInputFromProposal(
  proposal: BrainProposalDto & { kind: AuthoredCapabilityKind },
): CreateAuthoredCapabilityInput {
  const draft = proposal.draft;
  const input: CreateAuthoredCapabilityInput = {
    kind: proposal.kind,
    slug: requiredDraftString(draft, "slug"),
    title: requiredDraftString(draft, "title"),
    body: optionalDraftBody(draft, "body") ?? {},
    manifest: optionalDraftBody(draft, "manifest") ?? null,
    schemaVersion: optionalDraftInteger(draft, "schemaVersion") ?? 1,
  };
  const sourceFlowRefId = optionalDraftString(draft, "sourceFlowRefId");

  if (sourceFlowRefId !== undefined) {
    input.sourceFlowRefId = sourceFlowRefId;
  }

  return input;
}

function requiredDraftString(
  draft: Record<string, unknown>,
  key: string,
): string {
  const value = optionalDraftString(draft, key);

  if (value === undefined) {
    throw new MaisterError(
      "CONFIG",
      `Brain proposal draft requires string field "${key}"`,
    );
  }

  return value;
}

function optionalDraftString(
  draft: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = draft[key];

  if (value === undefined || value === null) return undefined;

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MaisterError(
      "CONFIG",
      `Brain proposal draft field "${key}" must be a non-empty string`,
    );
  }

  return value.trim();
}

function optionalDraftBody(
  draft: Record<string, unknown>,
  key: string,
): AuthoredCapabilityBody | null | undefined {
  const value = draft[key];

  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as AuthoredCapabilityBody;
  }

  throw new MaisterError(
    "CONFIG",
    `Brain proposal draft field "${key}" must be an object or null`,
  );
}

function optionalDraftInteger(
  draft: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = draft[key];

  if (value === undefined || value === null) return undefined;

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new MaisterError(
      "CONFIG",
      `Brain proposal draft field "${key}" must be a positive integer`,
    );
  }

  return value;
}

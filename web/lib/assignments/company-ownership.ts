import "server-only";

import type {
  ActorIdentity,
  Assignment,
  HitlRequest,
  Run,
} from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { assertCompanyRunReadAccess } from "@/lib/agents/company-run-read-access";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { getDb } from "@/lib/db/client";
import { actorIdentities, assignments } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "company-human-work",
  level: process.env.LOG_LEVEL ?? "info",
});

export type HumanWorkOwner =
  | Readonly<{ projectId: string; companyId?: null }>
  | Readonly<{ projectId: null; companyId: string }>;

export function humanWorkOwner(
  row: Readonly<{ projectId: string | null; companyId: string | null }>,
): HumanWorkOwner {
  if (typeof row.companyId === "string" && row.projectId === null)
    return { companyId: row.companyId, projectId: null };
  if (typeof row.projectId === "string" && row.companyId == null)
    return { projectId: row.projectId };
  throw new MaisterError(
    "CONFIG",
    "Human work requires one retained company or project owner",
  );
}

/** An actor is attribution only; every claim/answer separately checks current action authority. */
export async function ensureCompanyUserActor(
  args: Readonly<{
    db?: Db;
    companyId: string;
    userId: string;
    label?: string | null;
  }>,
): Promise<ActorIdentity> {
  const db = args.db ?? getDb();

  const actor = await db.transaction(async (tx) => {
    await authorizeCompanyUserAction(
      tx,
      args.userId,
      args.companyId,
      "assignments:read",
    );
    const [actor] = await tx
      .insert(actorIdentities)
      .values({
        id: randomUUID(),
        companyId: args.companyId,
        projectId: null,
        kind: "user",
        userId: args.userId,
        label: args.label ?? args.userId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [actorIdentities.companyId, actorIdentities.userId],
        targetWhere: sql`${actorIdentities.companyId} IS NOT NULL AND ${actorIdentities.kind}='user'`,
        set: { label: args.label ?? args.userId, updatedAt: new Date() },
      })
      .returning();

    return actor;
  });

  log.debug(
    { companyId: args.companyId, userId: args.userId, actorId: actor.id },
    "company user actor retained",
  );

  return actor;
}

/** Server lifecycle identity, scoped to one company and never usable as a human responder. */
export async function ensureCompanyLifecycleActor(
  db: Db,
  companyId: string,
): Promise<ActorIdentity> {
  const [actor] = await db
    .insert(actorIdentities)
    .values({
      id: randomUUID(),
      companyId,
      projectId: null,
      kind: "system",
      systemKey: "assignment-lifecycle",
      label: "MAIster lifecycle",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [actorIdentities.companyId, actorIdentities.systemKey],
      targetWhere: sql`${actorIdentities.companyId} IS NOT NULL AND ${actorIdentities.kind}='system'`,
      set: { updatedAt: new Date() },
    })
    .returning();

  return actor;
}

async function companyAssignmentActor(
  db: Db,
  companyId: string,
  actorId: string,
): Promise<ActorIdentity> {
  const [actor] = await db
    .select()
    .from(actorIdentities)
    .where(
      and(
        eq(actorIdentities.id, actorId),
        eq(actorIdentities.companyId, companyId),
        sql`${actorIdentities.projectId} IS NULL`,
      ),
    )
    .for("share");

  if (!actor || actor.disabledAt !== null)
    throw new MaisterError(
      "UNAUTHORIZED",
      "A current actor in the human assignment owner is required",
    );

  return actor;
}

export async function authorizeCompanyHumanAnswer(
  db: Db,
  assignment: Assignment,
  actorId: string,
): Promise<void> {
  if (assignment.projectId !== null) return;
  if (typeof assignment.companyId !== "string")
    throw new MaisterError("CONFIG", "Company human work has no company owner");
  const actor = await companyAssignmentActor(db, assignment.companyId, actorId);

  if (actor.kind !== "user" || actor.userId === null)
    throw new MaisterError(
      "UNAUTHORIZED",
      "A current human responder is required for company work",
    );
  await authorizeCompanyUserAction(
    db,
    actor.userId,
    assignment.companyId,
    "assignments:answer",
  );
  await assertCompanyRunReadAccess(db, actor.userId, assignment.runId);
}

export async function authorizeCompanyHumanCancellation(
  db: Db,
  assignment: Assignment,
  actorId: string,
): Promise<void> {
  if (assignment.projectId !== null) return;
  if (typeof assignment.companyId !== "string")
    throw new MaisterError("CONFIG", "Company human work has no company owner");
  const actor = await companyAssignmentActor(db, assignment.companyId, actorId);

  if (actor.kind === "system" && actor.systemKey === "assignment-lifecycle")
    return;
  if (actor.kind !== "user" || actor.userId === null)
    throw new MaisterError(
      "UNAUTHORIZED",
      "A current company cancellation principal is required",
    );
  await authorizeCompanyUserAction(
    db,
    actor.userId,
    assignment.companyId,
    "assignments:cancel",
  );
  await assertCompanyRunReadAccess(db, actor.userId, assignment.runId);
}

const companyConsentResponseSchema = z.object({
  _audit: z.object({
    companyConsent: z
      .object({
        version: z.literal(1),
        actorId: z.string().uuid(),
        userId: z.string().uuid(),
      })
      .strict(),
  }),
});

/** A saved answer is historical consent, never a substitute for current authority. */
export async function authorizeCompanyPermissionConsent(
  tx: Db,
  run: Run,
  hitl: Pick<HitlRequest, "id" | "response">,
): Promise<void> {
  if (run.projectId !== null || run.companyId === null) return;
  const response = companyConsentResponseSchema.safeParse(hitl.response);

  if (!response.success)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Company permission delivery requires retained human consent",
      { details: { reason: "company_permission_consent_missing" } },
    );
  const consent = response.data._audit.companyConsent;
  const [human] = await tx
    .select({ assignment: assignments })
    .from(assignments)
    .innerJoin(
      actorIdentities,
      eq(actorIdentities.id, assignments.assigneeActorId),
    )
    .where(
      and(
        eq(assignments.hitlRequestId, hitl.id),
        eq(assignments.runId, run.id),
        eq(assignments.companyId, run.companyId),
        isNull(assignments.projectId),
        eq(assignments.assigneeActorId, consent.actorId),
        eq(actorIdentities.userId, consent.userId),
      ),
    )
    .for("share");

  if (!human)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Company permission consent no longer matches its responding actor",
      { details: { reason: "company_permission_consent_actor" } },
    );
  await authorizeCompanyHumanAnswer(tx, human.assignment, consent.actorId);
  log.debug(
    {
      runId: run.id,
      hitlRequestId: hitl.id,
      companyId: run.companyId,
      actorId: consent.actorId,
      userId: consent.userId,
    },
    "retained company permission consent authorized",
  );
}

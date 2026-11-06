import "server-only";

import type { ActorIdentity, Assignment } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { assertCompanyRunReadAccess } from "@/lib/agents/company-run-read-access";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { getDb } from "@/lib/db/client";
import { actorIdentities } from "@/lib/db/schema";
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

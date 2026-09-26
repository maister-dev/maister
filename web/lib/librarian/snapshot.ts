import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ComposedContext } from "./composer";

import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import pino from "pino";

import {
  librarianContextSnapshots,
  librarianTurns,
  projectMembers,
  users,
} from "@/lib/db/schema";
import { getVisibleProjectIds } from "@/lib/queries/visible-projects";

const log = pino({
  name: "librarian.snapshot",
  level: process.env.LOG_LEVEL ?? "info",
});

/** ADR-183 D3: sha256 over what decides what the owner may see — account
 * state, global role and the sorted (project, role) visibility set. A change
 * bumps the conversation's context epoch, so a resumed session can never
 * repeat a fact the owner lost access to. */
export async function computeAuthzFingerprint(
  tx: Db,
  ownerId: string,
): Promise<string> {
  const [owner] = await tx
    .select({
      role: users.role,
      accountStatus: users.accountStatus,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, ownerId));
  const visible = owner
    ? await getVisibleProjectIds(ownerId, owner.role, tx as never)
    : [];
  const memberships = await tx
    .select({ projectId: projectMembers.projectId, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.userId, ownerId));
  const roleByProject = new Map(
    memberships.map((row) => [row.projectId, row.role]),
  );
  const projects = [...visible]
    .sort()
    .map((projectId) => [projectId, roleByProject.get(projectId) ?? "global"]);

  return createHash("sha256")
    .update(
      JSON.stringify({
        active: owner?.accountStatus === "active",
        mustChangePassword: owner?.mustChangePassword ?? true,
        role: owner?.role ?? null,
        projects,
      }),
    )
    .digest("hex");
}

/** Committed BEFORE the turn's prompt command exists: a reply is always
 * reproducible from what its snapshot names (`LCV-07`). */
export async function writeContextSnapshot(
  tx: Db,
  input: {
    turnId: string;
    composed: ComposedContext;
    authzFingerprint: string;
    contextEpoch: number;
  },
): Promise<string> {
  const [snapshot] = await tx
    .insert(librarianContextSnapshots)
    .values({
      turnId: input.turnId,
      instructionsVersion: input.composed.instructionsVersion,
      messageIds: input.composed.messageIds,
      summaryRevisions: input.composed.summaryRevisions,
      memoryItemRevisions: input.composed.memoryItemRevisions,
      authzFingerprint: input.authzFingerprint,
      contextEpoch: input.contextEpoch,
      charCount: input.composed.charCount,
      truncated: input.composed.truncated,
    })
    .returning({ id: librarianContextSnapshots.id });

  await tx
    .update(librarianTurns)
    .set({ contextSnapshotId: snapshot.id })
    .where(eq(librarianTurns.id, input.turnId));
  log.debug(
    {
      turnId: input.turnId,
      messages: input.composed.messageIds.length,
      chars: input.composed.charCount,
      truncated: input.composed.truncated,
      contextEpoch: input.contextEpoch,
    },
    "librarian context snapshot",
  );

  return snapshot.id;
}

import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TrustedSetupTarget } from "./types";

import { and, desc, eq, sql } from "drizzle-orm";

import {
  projects,
  projectDependencyDeclarations as heads,
  projectDependencyAttempts as attempts,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

/** Trust fan-out can affect several projects. Reserve one exact, recoverable
 * operation per effective declaration in the transaction that accepts trust. */
export async function enqueueTrustedSetup(
  tx: Db,
  actorUserId: string | undefined,
  target: TrustedSetupTarget,
  projectId?: string,
): Promise<string[]> {
  if (!actorUserId) return [];
  const packageOwner = sql`SELECT package_install_id FROM project_package_attachments
    WHERE project_id=${heads.projectId} AND id=${heads.effectiveAttachmentId}`;
  const owner =
    target.kind === "package"
      ? sql`(${packageOwner})=${target.id} AND (
        EXISTS (SELECT 1 FROM capability_imports c WHERE c.project_id=${heads.projectId}
          AND c.package_install_id=${target.id} AND c.setup_status IN ('pending','failed'))
        OR EXISTS (SELECT 1 FROM flows f JOIN flow_revisions r ON r.id=f.enabled_revision_id
          WHERE f.project_id=${heads.projectId} AND f.package_install_id=${target.id}
          AND r.setup_status IN ('pending','failed')))`
      : target.kind === "flow"
        ? sql`EXISTS (SELECT 1 FROM flows f JOIN flow_revisions r ON r.id=f.enabled_revision_id
          WHERE f.project_id=${heads.projectId} AND r.id=${target.id}
          AND r.setup_status IN ('pending','failed') AND r.resolved_revision=${heads.effectiveRevision}
          AND ((${heads.kind}='flow' AND f.flow_ref_id=${heads.logicalId})
            OR f.package_install_id=(${packageOwner})))`
        : sql`EXISTS (SELECT 1 FROM capability_imports c WHERE c.project_id=${heads.projectId}
          AND c.id=${target.id} AND c.resolved_revision=${heads.effectiveRevision}
          AND c.setup_status IN ('pending','failed')
          AND ((${heads.kind}='capability_import' AND c.capability_ref_id=${heads.logicalId})
            OR c.package_install_id=(${packageOwner})))`;
  const declarations = await tx
    .select()
    .from(heads)
    .where(and(projectId ? eq(heads.projectId, projectId) : undefined, owner))
    .orderBy(heads.projectId, heads.id)
    .for("update");
  const ids: string[] = [];

  for (const head of declarations) {
    if (head.effectiveGeneration !== head.generation)
      throw new MaisterError(
        "CONFLICT",
        "The effective package is being replaced.",
        { details: { reason: "stale_generation" } },
      );
    const [latest] = await tx
      .select()
      .from(attempts)
      .where(
        and(
          eq(attempts.declarationId, head.id),
          eq(attempts.generation, head.generation),
        ),
      )
      .orderBy(desc(attempts.attemptNo))
      .limit(1);

    // A repeated trust confirmation observes the known failure. Only the
    // explicit retry command creates a new setup attempt for that target.
    if (
      latest?.status === "failed" &&
      latest.checkpoint.postTrust?.kind === target.kind &&
      latest.checkpoint.postTrust.id === target.id
    ) {
      ids.push(latest.id);
      continue;
    }
    if (
      latest &&
      ["running", "pending", "recovery_required"].includes(latest.status)
    ) {
      if (
        latest.checkpoint.postTrust?.kind !== target.kind ||
        latest.checkpoint.postTrust.id !== target.id
      )
        throw new MaisterError(
          "CONFLICT",
          "Another operation owns this dependency.",
        );
      ids.push(latest.id);
      continue;
    }
    const [queued] = await tx
      .insert(attempts)
      .values({
        projectId: head.projectId,
        declarationId: head.id,
        generation: head.generation,
        attemptNo: (latest?.attemptNo ?? 0) + 1,
        desired: head.desired,
        actorUserId,
        resolvedRevision: head.effectiveRevision,
        stage: "setup",
        checkpoint: { postTrust: target },
      })
      .returning({ id: attempts.id });

    ids.push(queued.id);
  }

  return ids;
}

export async function finishTrustedSetup(
  db: Db,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  if (!ids.length) return;
  const { serviceDependency } = await import("./worker");

  for (const id of ids) {
    await serviceDependency(db, signal ?? new AbortController().signal, id);
    const [row] = await db
      .select({
        status: attempts.status,
        reason: attempts.reason,
        memberRef: attempts.memberRef,
        declarationId: attempts.declarationId,
        projectSlug: projects.slug,
      })
      .from(attempts)
      .innerJoin(projects, eq(projects.id, attempts.projectId))
      .where(eq(attempts.id, id));

    if (!row)
      throw new MaisterError(
        "CONFLICT",
        "The dependency was removed after trust confirmation.",
        { details: { reason: "stale_generation" } },
      );
    if (row.status !== "succeeded")
      throw new MaisterError(
        row.status === "failed" ? "FLOW_INSTALL" : "CONFLICT",
        "Inspect the trusted dependency setup in project settings.",
        {
          details: {
            trustAccepted: true,
            projectSlug: row.projectSlug,
            declarationId: row.declarationId,
            reason: row.reason ?? "setup_pending",
            memberRef: row.memberRef,
          },
        },
      );
  }
}

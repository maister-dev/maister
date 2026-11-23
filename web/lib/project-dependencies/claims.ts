import "server-only";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { hasActiveGlobalRole } from "@/lib/authz";
import {
  projectDependencyAttempts as attempts,
  projectDependencyDeclarations as declarations,
  projects,
  users,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
export const dependencyLeaseMs = 90_000;
export type DependencyClaim = typeof attempts.$inferSelect & {
  claimToken: string;
};
export async function claimDependency(db: Db): Promise<DependencyClaim | null> {
  const token = randomUUID();

  return db.transaction(async (tx) => {
    // Recover an abandoned obsolete owner before the new generation competes
    // for the one-running-attempt constraint. A live shell remains fenced by
    // its independent physical setup receipt.
    await tx.execute(sql`
      WITH stale AS (
        SELECT a.id FROM project_dependency_attempts a
        JOIN project_dependency_declarations d ON d.id=a.declaration_id AND d.generation>a.generation
        WHERE a.status='pending' OR (a.status='running' AND a.lease_expires_at<=clock_timestamp())
        ORDER BY a.due_at LIMIT 16 FOR UPDATE OF a SKIP LOCKED
      )
      UPDATE project_dependency_attempts a SET status='failed',stage=coalesce(stage,'attach'),
        reason='superseded',claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      FROM stale WHERE a.id=stale.id`);
    // Project-first locks respect other mutation writers. A ready item whose
    // project is applying a member can never stall the scan of another project.
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT a.id FROM project_dependency_attempts a
      JOIN project_dependency_declarations d ON d.id=a.declaration_id AND d.generation=a.generation
      JOIN projects p ON p.id=d.project_id AND p.archived_at IS NULL
      WHERE ((a.status='pending' AND a.due_at<=clock_timestamp())
         OR (a.status='running' AND a.lease_expires_at<=clock_timestamp()))
        AND NOT EXISTS (SELECT 1 FROM project_dependency_attempts busy WHERE busy.declaration_id=d.id AND busy.id<>a.id AND busy.status='running')
        AND NOT EXISTS (SELECT 1 FROM project_dependency_attempts earlier
          JOIN project_dependency_declarations sibling ON sibling.id=earlier.declaration_id AND sibling.generation=earlier.generation
          WHERE sibling.project_id=p.id AND sibling.kind=d.kind AND sibling.ordinal<d.ordinal
          AND earlier.status='pending' AND earlier.due_at<=clock_timestamp() AND earlier.attempt_no=1)
      ORDER BY (SELECT max(other.updated_at) FROM project_dependency_attempts other WHERE other.project_id=p.id AND other.status<>'pending') NULLS FIRST, a.due_at, d.ordinal, a.id
      FOR UPDATE OF p,a SKIP LOCKED LIMIT 1`);

    if (!rows[0]) return null;
    const [claim] = await tx
      .update(attempts)
      .set({
        status: "running",
        claimToken: token,
        leaseExpiresAt: new Date(Date.now() + dependencyLeaseMs),
        updatedAt: new Date(),
      })
      .where(eq(attempts.id, rows[0].id))
      .returning();

    return { ...claim, claimToken: token };
  });
}

export function sameClaim(claim: DependencyClaim) {
  return and(
    eq(attempts.id, claim.id),
    eq(attempts.claimToken, claim.claimToken),
    eq(attempts.status, "running"),
  );
}

async function authorize(db: Db, claim: DependencyClaim) {
  const [actor] = await db
    .select()
    .from(users)
    .where(eq(users.id, claim.actorUserId))
    .for("share");

  // A current global admin satisfies the project management guard as well.
  if (!actor || !hasActiveGlobalRole(actor, "admin"))
    throw new MaisterError(
      "UNAUTHORIZED",
      "Dependency installation authority was revoked",
      { details: { reason: "authority_revoked" } },
    );
}

export async function requireCurrentDependency(db: Db, claim: DependencyClaim) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, claim.projectId))
    .for("update");
  const [current] = await db
    .select()
    .from(declarations)
    .where(
      and(
        eq(declarations.id, claim.declarationId),
        eq(declarations.projectId, claim.projectId),
        eq(declarations.generation, claim.generation),
      ),
    );
  const [owned] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        sameClaim(claim),
        sql`${attempts.leaseExpiresAt} > clock_timestamp()`,
      ),
    );

  if (!project || !current || !owned)
    throw new MaisterError("CONFLICT", "Dependency attempt was superseded", {
      details: { reason: "superseded" },
    });
  if (project.archivedAt)
    throw new MaisterError("PRECONDITION", "Project is archived", {
      details: { reason: "project_archived" },
    });
  await authorize(db, claim);

  return { project, declaration: current };
}

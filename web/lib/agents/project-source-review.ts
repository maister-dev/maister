import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { ProjectRole } from "@/lib/db/schema";

import { sql } from "drizzle-orm";

import { projectRolesForActions } from "@/lib/authz";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";

export type ProjectSourceContent = Readonly<{
  triggerType: "cron" | "event" | "mention";
  cronExpr: string | null;
  timezone: string | null;
  eventMatch: Readonly<{ kinds: readonly string[] }> | null;
  requestAtLaunch?: string | null;
}>;

/** Eligibility and scheduler counters are separate from the exact reviewed selector and recurring request. */
export function projectSourceContentDigest(
  source: ProjectSourceContent,
): string {
  return contentDigest({
    schemaVersion: 1,
    triggerType: source.triggerType,
    cronExpr: source.cronExpr,
    timezone: source.timezone,
    eventKinds: [...(source.eventMatch?.kinds ?? [])].sort(),
    requestAtLaunch: source.requestAtLaunch ?? null,
  });
}

/** Reuse current identity and the existing project action policy while locking authority for the save. */
export async function authorizeProjectSourceReview(
  tx: SqlTransaction,
  userId: string,
  projectId: string,
): Promise<void> {
  const principal = await resolveKnowledgePrincipal(
    tx,
    { kind: "user", userId },
    "knowledge:read",
  );
  const project = (
    await tx.execute(
      sql`SELECT id FROM projects WHERE id=${projectId} FOR SHARE`,
    )
  ).rows[0];

  if (!project)
    throw new MaisterError(
      "PRECONDITION",
      "Project source review requires an existing project",
    );
  if (principal.kind !== "user")
    throw new MaisterError(
      "UNAUTHORIZED",
      "Project source review requires an actual user",
    );
  if (principal.user.role === "admin") return;
  const membership = (
    await tx.execute(
      sql`SELECT role FROM project_members WHERE project_id=${projectId} AND user_id=${userId} FOR SHARE`,
    )
  ).rows[0] as { role: ProjectRole } | undefined;

  if (
    !membership ||
    !projectRolesForActions(["editSettings"]).includes(membership.role)
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Reviewing native automation requires current project settings authority",
    );
}

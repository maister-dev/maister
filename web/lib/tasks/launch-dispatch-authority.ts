import "server-only";

import type { ProjectAction } from "@/lib/authz";
import type { Db } from "@/lib/execution-host/db";
import type { taskLaunchIntents } from "@/lib/db/schema";

import { eq } from "drizzle-orm";

import { assertTaskLaunchExecutionParent } from "./launch-parent-admission";
import { assertTaskLaunchUserAuthority } from "./launch-authority";
import { assertStoredTaskLaunchTokenAuthority } from "./launch-token";
import { assertStoredTaskLaunchServerSource } from "./launch-server-source";
import { launchRefusal } from "./launch-resolution";

import { projects } from "@/lib/db/schema";
import { requiresLaunchUnattended } from "@/lib/runs/execution-policy";

/** A durable accepted decision is revalidated; its actor ID is not a fresh human grant. */
export async function assertTaskLaunchDispatchAuthority(
  db: Db,
  intent: typeof taskLaunchIntents.$inferSelect,
): Promise<void> {
  await assertTaskLaunchExecutionParent(db, intent);
  const actions: readonly ProjectAction[] = requiresLaunchUnattended(
    intent.settingsSnapshot.executionPolicy,
  )
    ? ["launchRun", "launchUnattended"]
    : ["launchRun"];

  if (
    intent.settingsSnapshot.version === 2 &&
    intent.settingsSnapshot.serverExecution
  ) {
    const source = intent.settingsSnapshot.serverExecution;

    if (
      (intent.principalKind === "system" &&
        intent.principalId !== `${source.kind}:${source.id}`) ||
      source.taskId !== intent.taskId ||
      source.projectId !== intent.projectId
    )
      throw launchRefusal("launch_source_authority_required", "PRECONDITION");
    await assertStoredTaskLaunchServerSource(db, source);
  }
  if (intent.basis.kind === "manual") {
    if (
      intent.principalKind !== "session_user" ||
      intent.actorUserId !== intent.basis.userId
    )
      throw launchRefusal("launch_authority_revoked", "PRECONDITION");
    await assertTaskLaunchUserAuthority(
      db,
      intent.projectId,
      intent.basis.userId,
      actions,
    );

    return;
  }
  if (intent.basis.kind === "automatic" && intent.basis.origin) {
    await assertStoredTaskLaunchTokenAuthority(db, intent.id, actions);

    return;
  }
  const [project] = await db
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, intent.projectId));

  if (!project || project.archivedAt)
    throw launchRefusal("launch_authority_revoked", "PRECONDITION");
}

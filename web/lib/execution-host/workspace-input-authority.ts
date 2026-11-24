import "server-only";

import type { Db } from "./db";

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { WORKSPACE_CONTEXT_INPUT } from "../../../runtime/workspace-context-input";

import { configuredSelectedExecutionEndpoint } from "./selected-endpoint";

import {
  agentProjectLinks,
  projects,
  runs,
  taskLaunchIntents,
  workspaceInputCaptures,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";
import { assertTaskLaunchDispatchAuthority } from "@/lib/tasks/launch-dispatch-authority";

/** Use the current Run principal. Bytes in a retained capture grant no authority. */
export async function assertWorkspaceRunAuthority(
  db: Db,
  runId: string,
): Promise<void> {
  const [run] = await db
    .select({
      projectId: runs.projectId,
      userId: runs.createdByUserId,
      intentId: runs.taskLaunchIntentId,
      originalUserId: workspaceInputCaptures.originUserId,
      agentId: runs.agentId,
      runKind: runs.runKind,
      context: sql<string | null>`(
        SELECT entry->>'base64' FROM jsonb_array_elements(${workspaceInputCaptures.files}) entry
        WHERE entry->>'path' = ${WORKSPACE_CONTEXT_INPUT}
      )`,
    })
    .from(runs)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.runId, runs.id),
        eq(workspaces.preparationAssignmentId, runs.executionAssignmentId),
      ),
    )
    .innerJoin(
      workspaceInputCaptures,
      eq(workspaceInputCaptures.workspaceId, workspaces.id),
    )
    .where(and(eq(runs.id, runId), isNull(workspaces.removedAt)));

  if (!run?.projectId)
    throw new MaisterError(
      "PRECONDITION",
      "Workspace input dispatch requires an active project launch",
      {
        details: { reason: "workspace_preparation_changed" },
      },
    );
  if (run.userId !== run.originalUserId)
    throw new MaisterError(
      "UNAUTHORIZED",
      "The addressed Run's launch principal is no longer active",
      {
        details: { reason: "launch_authority_revoked" },
      },
    );
  if (run.context !== null)
    await assertContextAuthority(db, {
      encoded: run.context,
      launch: {
        kind: run.runKind,
        projectId: run.projectId,
        userId: run.userId,
        agentId: run.agentId,
      },
    });
  if (run.intentId) {
    const [intent] = await db
      .select()
      .from(taskLaunchIntents)
      .where(
        and(
          eq(taskLaunchIntents.id, run.intentId),
          eq(taskLaunchIntents.projectId, run.projectId),
        ),
      )
      .for("share");
    if (!intent)
      throw new MaisterError(
        "UNAUTHORIZED",
        "Workspace input launch authority is unavailable",
        {
          details: { reason: "launch_authority_revoked" },
        },
      );
    await assertTaskLaunchDispatchAuthority(db, intent);

    return;
  }
  if (run.userId) {
    await assertTaskLaunchUserAuthority(db, run.projectId, run.userId, [
      "launchRun",
    ]);

    return;
  }
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, run.projectId), isNull(projects.archivedAt)))
    .for("share");
  if (!project)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Workspace input launch project is archived or missing",
      {
        details: { reason: "launch_authority_revoked" },
      },
    );
}

async function assertContextAuthority(
  db: Db,
  input: Readonly<{
    encoded: string;
    launch: Readonly<{
      kind: string;
      projectId: string;
      userId: string | null;
      agentId: string | null;
    }>;
  }>,
): Promise<void> {
  const context = z
    .array(
      z.object({
        repositoryId: z.string().min(1),
        slug: z.string().min(1),
        declaredRef: z.string().nullable(),
      }),
    )
    .max(64)
    .parse(JSON.parse(Buffer.from(input.encoded, "base64").toString("utf8")));
  const { launch } = input;
  const denied = (): MaisterError =>
    new MaisterError(
      "UNAUTHORIZED",
      "Retained workspace context requires a current repository grant",
      {
        details: { reason: "workspace_context_authority_required" },
      },
    );
  if (launch.kind === "agent" && launch.agentId) {
    const [link] = await db
      .select({ contextRepos: agentProjectLinks.contextRepos })
      .from(agentProjectLinks)
      .where(
        and(
          eq(agentProjectLinks.agentId, launch.agentId),
          eq(agentProjectLinks.projectId, launch.projectId),
          eq(agentProjectLinks.enabled, true),
        ),
      )
      .for("share");
    if (
      !link?.contextRepos ||
      context.some(
        (mount) =>
          !link.contextRepos?.some(
            (allowed) =>
              allowed.project === mount.slug &&
              (allowed.ref ?? null) === mount.declaredRef,
          ),
      )
    )
      throw denied();

    for (const mount of context) {
      const [sibling] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, mount.repositoryId),
            eq(projects.slug, mount.slug),
            isNull(projects.archivedAt),
          ),
        )
        .for("share");
      if (!sibling) throw denied();
    }

    return;
  }
  if (!launch.userId) throw denied();
  const repositoryIds = [
    ...new Set(context.map(({ repositoryId }) => repositoryId)),
  ].sort();

  for (const projectId of repositoryIds)
    await assertTaskLaunchUserAuthority(db, projectId, launch.userId, [
      "readRepoFiles",
    ]);
}

/** Legacy sessions use their existing admission authority. */
export async function assertAddressedWorkspaceSessionAuthority(
  db: Db,
  runId: string,
): Promise<void> {
  if (!configuredSelectedExecutionEndpoint()) return;
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.runId, runId),
        eq(workspaces.ownershipKind, "host_owned"),
        isNull(workspaces.removedAt),
      ),
    )
    .limit(1);
  if (workspace) await assertWorkspaceRunAuthority(db, runId);
}

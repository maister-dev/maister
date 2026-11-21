import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { z } from "zod";
import type {
  platformCompletionPatchSchema,
  projectCompletionPatchSchema,
} from "./completion-policy";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import {
  completionSettingsSchema,
  DEFAULT_COMPLETION_LIMITS,
  type CompletionSettings,
} from "./completion-policy";

import { platformRuntimeSettings, projects, users } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";

const log = pino({
  name: "autonomous-completion",
  level: process.env.LOG_LEVEL ?? "info",
});

type ProjectPatch = z.infer<typeof projectCompletionPatchSchema>;
type PlatformPatch = z.infer<typeof platformCompletionPatchSchema>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

function settingsChanged(currentRevision: number): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "Autonomous completion settings changed",
    {
      details: { reason: "autonomy_revision_changed", currentRevision },
    },
  );
}

export async function setProjectCompletion(
  tx: Transaction,
  projectId: string,
  userId: string,
  patch: ProjectPatch,
): Promise<{ settings: CompletionSettings; revision: number }> {
  const [current] = await tx
    .select({
      settings: projects.autonomousCompletion,
      revision: projects.autonomousCompletionRevision,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.archivedAt)))
    .for("update");

  await assertTaskLaunchUserAuthority(tx, projectId, userId, ["editSettings"]);
  if (!current || current.revision !== patch.expectedRevision)
    throw settingsChanged(current?.revision ?? 0);
  const { expectedRevision: _expectedRevision, ...changes } = patch;
  const parsed = completionSettingsSchema.safeParse({
    ...DEFAULT_COMPLETION_LIMITS,
    ...current.settings,
    ...changes,
  });

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Enabling autonomous completion requires approved CI sources and valid evidence limits",
      {
        details: { reason: "autonomy_policy_invalid" },
      },
    );

  const revision = current.revision + 1;

  await tx
    .update(projects)
    .set({
      autonomousCompletion: parsed.data,
      autonomousCompletionRevision: revision,
    })
    .where(eq(projects.id, projectId));

  return { settings: parsed.data, revision };
}

export async function setPlatformCompletion(
  db: Db,
  userId: string,
  patch: PlatformPatch,
): Promise<{ enabled: boolean; revision: number }> {
  const result = await db.transaction(async (tx) => {
    const [actor] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.role, "admin"),
          eq(users.accountStatus, "active"),
          eq(users.mustChangePassword, false),
        ),
      )
      .for("share");

    if (!actor)
      throw new MaisterError(
        "UNAUTHORIZED",
        "Current platform administrator authority is required",
      );
    const [current] = await tx
      .select({
        revision: platformRuntimeSettings.autonomousCompletionRevision,
      })
      .from(platformRuntimeSettings)
      .where(eq(platformRuntimeSettings.id, "singleton"))
      .for("update");

    if (!current || current.revision !== patch.expectedRevision)
      throw settingsChanged(current?.revision ?? 0);

    const revision = current.revision + 1;

    await tx
      .update(platformRuntimeSettings)
      .set({
        autonomousCompletionEnabled: patch.enabled,
        autonomousCompletionRevision: revision,
        updatedAt: new Date(),
      })
      .where(eq(platformRuntimeSettings.id, "singleton"));

    return { enabled: patch.enabled, revision };
  });

  log.info(
    { actorId: userId, ...result },
    "platform autonomous completion settings changed",
  );

  return result;
}

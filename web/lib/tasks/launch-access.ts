import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TokenTaskLaunchPrincipal } from "./launch-token";

import { eq } from "drizzle-orm";

import { assertTaskLaunchReadAuthority } from "./launch-authority";
import { launchRefusal } from "./launch-resolution";
import {
  assertTaskLaunchTokenAuthentication,
  assertTaskLaunchTokenReadAuthority,
  assertTaskLaunchTokenAuthority,
  assertTaskLaunchTokenVisibility,
} from "./launch-token";

import { taskLaunchIntents } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { requiresLaunchUnattended } from "@/lib/runs/execution-policy";

/** An intent selector never discloses whether another project's request exists. */
export async function taskLaunchForUser(
  db: Db,
  intentId: string,
  userId: string,
): Promise<typeof taskLaunchIntents.$inferSelect> {
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (!intent) throw launchRefusal("launch_not_found", "PRECONDITION");
  try {
    await assertTaskLaunchReadAuthority(db, intent.projectId, userId);
  } catch (error) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED")
      throw launchRefusal("launch_not_found", "PRECONDITION");
    throw error;
  }

  return intent;
}

export async function taskLaunchForToken(
  db: Db,
  intentId: string,
  principal: TokenTaskLaunchPrincipal,
): Promise<typeof taskLaunchIntents.$inferSelect> {
  await assertTaskLaunchTokenAuthentication(db, principal);
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (!intent) throw launchRefusal("launch_not_found", "PRECONDITION");
  try {
    await assertTaskLaunchTokenReadAuthority(db, principal, intent.projectId);
  } catch (error) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED")
      throw launchRefusal("launch_not_found", "PRECONDITION");
    throw error;
  }

  return intent;
}

/** Receipt replay is a launch operation; it does not require the separate metadata scope. */
export async function taskLaunchForTokenWrite(
  db: Db,
  intentId: string,
  principal: TokenTaskLaunchPrincipal,
): Promise<typeof taskLaunchIntents.$inferSelect> {
  await assertTaskLaunchTokenAuthentication(db, principal);
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, intentId));

  if (!intent) throw launchRefusal("launch_not_found", "PRECONDITION");
  try {
    await assertTaskLaunchTokenVisibility(db, principal, intent.projectId);
  } catch (error) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED")
      throw launchRefusal("launch_not_found", "PRECONDITION");
    throw error;
  }
  await assertTaskLaunchTokenAuthority(
    db,
    principal,
    intent.projectId,
    requiresLaunchUnattended(intent.settingsSnapshot.executionPolicy)
      ? ["launchRun", "launchUnattended"]
      : ["launchRun"],
  );

  return intent;
}

import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { eq } from "drizzle-orm";

import { assertTaskLaunchReadAuthority } from "./launch-authority";
import { launchRefusal } from "./launch-resolution";

import { taskLaunchIntents } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";

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

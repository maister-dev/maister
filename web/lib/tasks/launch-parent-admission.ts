import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { taskLaunchIntents } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";

import { taskExecutionChildAdmissionProof } from "./qualification-admission";
import { launchRefusal } from "./launch-resolution";

import { retryDigest } from "@/lib/agents/retry-guards";
import { runs } from "@/lib/db/schema";
import { lockDelegationParent } from "@/lib/orchestrator/admission";

type AcceptedIntent = typeof taskLaunchIntents.$inferSelect;

/** Every child source must retain the exact current admitted parent and child objective. */
export async function assertTaskLaunchExecutionParent(
  db: Db,
  intent: AcceptedIntent,
): Promise<void> {
  if (intent.basis.kind !== "execution_child") return;
  const current = await taskExecutionChildAdmissionProof(
    db,
    intent.projectId,
    intent.taskId,
  );

  if (retryDigest(current) !== retryDigest(intent.basis.parent))
    throw launchRefusal("qualification_child_stale", "PRECONDITION");
}

/** Acquire the parent before the child reservation/run locks at a decisive first-dispatch boundary. */
export async function lockTaskLaunchExecutionParent(
  db: Db,
  intent: AcceptedIntent,
): Promise<void> {
  if (intent.basis.kind !== "execution_child") return;
  await lockDelegationParent(db, intent.basis.parent.parentRunId);
  const [parent] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.id, intent.basis.parent.parentRunId),
        eq(runs.projectId, intent.projectId),
      ),
    )
    .for("share");

  if (!parent)
    throw launchRefusal("qualification_parent_unavailable", "PRECONDITION");
  await assertTaskLaunchExecutionParent(db, intent);
}

import "server-only";

import { and, desc, eq } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";
import { actorForUserId } from "@/lib/social/activity";
import { addTaskComment } from "@/lib/social/comments";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { taskComments } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

// ADR-163 review S7 + Codex review F3: a TYPED refusal of an as-plan task's
// launch — at release time (a flow disabled, untrusted or upgraded past this
// engine, an agent no longer resolvable) or at `run_plan`'s own source launch —
// is a durable condition no sibling settle can fix, and the dependent DAG
// stalled with nothing on the task. Post it where the task's readers look, once
// per distinct refusal; launch_mode stays `auto` so an admin fix is retried on
// the next settle. This is the C2 give-up's comment WITHOUT its flag/clear: an
// as-plan task is never triaged, so that CAS could not match it, and a stall
// here is recoverable by fixing the target.
export async function noteAsPlanRefusal(
  db: Db,
  candidate: { taskId: string },
  refusal: { code: string; message: string },
): Promise<void> {
  const body = `As-plan auto-launch refused (${refusal.code}): ${refusal.message}. The task stays queued (launch_mode auto); fix the target and it is retried when a sibling child next settles.`;
  const latest = (await db
    .select({ body: taskComments.body })
    .from(taskComments)
    .where(
      and(
        eq(taskComments.taskId, candidate.taskId),
        eq(taskComments.actorType, "system"),
      ),
    )
    .orderBy(desc(taskComments.createdAt))
    .limit(1)) as { body: string }[];

  if (latest[0]?.body === body) return;

  await addTaskComment(
    {
      taskId: candidate.taskId,
      body,
      actor: actorForUserId(null),
      activityPayloadExtra: {
        reason: "as_plan_launch_refused",
        code: refusal.code,
      },
    },
    db,
  );
}

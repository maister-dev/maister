import "server-only";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";
import { recordTaskActivity, type SocialActor } from "@/lib/social/activity";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { flows, platformAcpRunners, tasks } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "service-triage",
  level: process.env.LOG_LEVEL ?? "info",
});

export type PromotionMode = "local_merge" | "pull_request";

// M34 (ADR-089) launch-verdict patch. The ext triage op uses the set-only
// shape (no nulls); the web card PATCH is SET/CLEAR symmetric (null clears).
export type TaskVerdictPatch = {
  flowId?: string | null;
  runnerId?: string | null;
  baseBranch?: string | null;
  targetBranch?: string | null;
  promotionMode?: PromotionMode | null;
};

// Conservative git-check-ref-format subset for a branch name. The verdict
// branch only pre-fills the launch dialog — the launch path re-validates
// against the live repo — so shape validation is the contract here.
export function isValidGitBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name === "@" || name.startsWith("-") || name.endsWith(".")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return false;
  }
  if (name.includes("..") || name.includes("@{") || name.includes("\\")) {
    return false;
  }

  if (/[\s~^:?*[\x00-\x1f\x7f]/.test(name)) return false;

  return name
    .split("/")
    .every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

// Allow-list validation of body-controlled verdict ids against server state:
// flowId ∈ project flows, runnerId ∈ enabled runner catalog, branch names =
// git ref-name shape. promotionMode is schema-validated by the caller.
export async function validateVerdictRefs(
  projectId: string,
  patch: TaskVerdictPatch,
  db?: Db,
): Promise<void> {
  const _db = (db ?? getDb()) as unknown as { select: any };

  if (patch.flowId != null) {
    const rows = await _db
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.id, patch.flowId), eq(flows.projectId, projectId)));

    if (rows.length === 0) {
      throw new MaisterError(
        "CONFIG",
        `flow ${patch.flowId} is not configured for project`,
      );
    }
  }

  if (patch.runnerId != null) {
    const rows = await _db
      .select({ id: platformAcpRunners.id })
      .from(platformAcpRunners)
      .where(
        and(
          eq(platformAcpRunners.id, patch.runnerId),
          eq(platformAcpRunners.enabled, true),
        ),
      );

    if (rows.length === 0) {
      throw new MaisterError(
        "CONFIG",
        `runner ${patch.runnerId} is not an enabled catalog runner`,
      );
    }
  }

  if (patch.baseBranch != null && !isValidGitBranchName(patch.baseBranch)) {
    throw new MaisterError(
      "CONFIG",
      `baseBranch is not a valid git branch name`,
    );
  }

  if (patch.targetBranch != null && !isValidGitBranchName(patch.targetBranch)) {
    throw new MaisterError(
      "CONFIG",
      `targetBranch is not a valid git branch name`,
    );
  }
}

function verdictColumns(patch: TaskVerdictPatch): Record<string, unknown> {
  const set: Record<string, unknown> = {};

  if (patch.flowId !== undefined) set.flowId = patch.flowId;
  if (patch.runnerId !== undefined) set.runnerId = patch.runnerId;
  if (patch.baseBranch !== undefined) set.baseBranch = patch.baseBranch;
  if (patch.targetBranch !== undefined) set.targetBranch = patch.targetBranch;
  if (patch.promotionMode !== undefined) {
    set.promotionMode = patch.promotionMode;
  }

  return set;
}

// Ext triage op (ADR-089 D8): set-only verdict fields + the 'triaged' stamp +
// a `triage_set` activity entry — caller supplies the transaction so the
// token audit row commits or rolls back with the verdict.
export async function applyTriageVerdict(
  tx: any,
  input: {
    taskId: string;
    projectId: string;
    verdict: TaskVerdictPatch;
    actor: SocialActor;
  },
): Promise<void> {
  const set = verdictColumns(input.verdict);

  await tx
    .update(tasks)
    .set({ ...set, triageStatus: "triaged", updatedAt: new Date() })
    .where(
      and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId)),
    );

  await recordTaskActivity(tx, {
    taskId: input.taskId,
    projectId: input.projectId,
    actor: input.actor,
    eventKind: "triage_set",
    payload: { ...input.verdict },
  });

  log.info(
    {
      taskId: input.taskId,
      actorType: input.actor.type,
      fields: Object.keys(set),
    },
    "triage verdict applied",
  );
}

// Web card PATCH (one aggregating endpoint): SET/CLEAR symmetric — an
// explicit null clears the column. Never touches `triage_status` (that mark
// belongs to the triager / send-to-triage).
export async function updateTaskVerdict(
  input: { taskId: string; projectId: string; patch: TaskVerdictPatch },
  db?: Db,
): Promise<void> {
  const _db = db ?? getDb();
  const set = verdictColumns(input.patch);

  if (Object.keys(set).length === 0) {
    throw new MaisterError("CONFIG", "at least one verdict field is required");
  }

  await validateVerdictRefs(input.projectId, input.patch, _db);

  await _db
    .update(tasks)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId)),
    );

  log.info(
    { taskId: input.taskId, fields: Object.keys(set) },
    "task verdict updated",
  );
}

// "Send to triage" (ADR-089 D13): the task.triage_requeued emitter that
// ADR-086 registered emitter-less. ONE transaction: clear the stamp, emit
// the domain event, record the activity entry.
export async function sendTaskToTriage(
  input: {
    taskId: string;
    projectId: string;
    taskRef: string;
    title: string;
    actor: SocialActor;
  },
  db?: Db,
): Promise<void> {
  const _db = (db ?? getDb()) as unknown as {
    transaction<T>(scope: (tx: any) => Promise<T>): Promise<T>;
  };

  await _db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({ triageStatus: null, updatedAt: new Date() })
      .where(
        and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId)),
      );

    await emitDomainEvent({
      db: tx,
      kind: "task.triage_requeued",
      projectId: input.projectId,
      taskId: input.taskId,
      actor: input.actor,
      payload: { taskKey: input.taskRef, title: input.title },
    });

    await recordTaskActivity(tx, {
      taskId: input.taskId,
      projectId: input.projectId,
      actor: input.actor,
      eventKind: "triage_requeued",
      payload: {},
    });
  });

  log.info(
    { taskId: input.taskId, actorType: input.actor.type },
    "task sent to triage",
  );
}

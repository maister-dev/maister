import type { Db } from "./db";
import type {
  AssignmentId,
  AssignmentState,
  CommandKind,
  PlacementReason,
} from "./types";

import { randomUUID } from "node:crypto";

import { and, desc, eq, max } from "drizzle-orm";
import pino, { type Logger } from "pino";

import {
  executionAssignments,
  runs,
  type ExecutionAssignment,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "assignments" });

// Kinds admissible under a `released` assignment: an incarnation that has
// ended may still tear its own sessions down (the orchestrator park checkpoint
// would otherwise be fenced locally — X-EH-20).
export const TEARDOWN_COMMAND_KINDS = [
  "session.checkpoint",
  "session.delete",
  "session.cancel",
  "runtime_object.delete",
  "workspace.release",
] as const satisfies readonly CommandKind[];

export function isAdmissible(
  kind: CommandKind,
  state: AssignmentState,
  opts: { inputAction?: "select" | "cancel" } = {},
): boolean {
  switch (state) {
    case "active":
      return true;
    case "released":
      if (kind === "session.input") return opts.inputAction === "cancel";

      return (TEARDOWN_COMMAND_KINDS as readonly string[]).includes(kind);
    case "superseded":
      return false;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

export async function getActiveAssignment(
  db: Db,
  runId: string,
): Promise<ExecutionAssignment | null> {
  const rows = await db
    .select()
    .from(executionAssignments)
    .where(
      and(
        eq(executionAssignments.runId, runId),
        eq(executionAssignments.state, "active"),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

// The run's newest assignment regardless of state — what a teardown command
// binds to when the run's incarnation already ended (`released`), so a
// checkpoint/delete never mints a fresh epoch just to address a dead session.
export async function getLatestAssignment(
  db: Db,
  runId: string,
): Promise<ExecutionAssignment | null> {
  const rows = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.runId, runId))
    .orderBy(desc(executionAssignments.epoch))
    .limit(1);

  return rows[0] ?? null;
}

export async function getAssignmentById(
  db: Db,
  id: string,
): Promise<ExecutionAssignment | null> {
  const rows = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, id))
    .limit(1);

  return rows[0] ?? null;
}

// Mint the next driver-ownership epoch for a run. MUST run inside the caller's
// placement-claim transaction. The run row is the serialization point (a
// stable parent — the new row does not exist yet, so locking it cannot
// serialize); the unique constraints are the backstop and map to CONFLICT.
export async function mintAssignment(
  tx: Db,
  input: {
    runId: string;
    hostId: string;
    reason: PlacementReason;
    id?: string;
    now?: Date;
    logger?: Logger;
  },
): Promise<ExecutionAssignment> {
  const now = input.now ?? new Date();
  const logger = input.logger ?? defaultLog;

  const locked = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.id, input.runId))
    .for("update");

  if (locked.length === 0) {
    throw new MaisterError(
      "PRECONDITION",
      `cannot mint an execution assignment for unknown run ${input.runId}`,
    );
  }

  const active = await getActiveAssignment(tx, input.runId);
  // D3/D7: the adopted handle is copied forward from the run's NEWEST prior
  // generation on the same host — released included (a resume follows a
  // checkpoint that released it), so a re-entry never re-adopts. A stale
  // handle is harmless: the host answers `unknown_workspace` and the client
  // re-adopts once.
  const previous = await getLatestAssignment(tx, input.runId);
  const inherited =
    previous && previous.executionHostId === input.hostId
      ? {
          executionWorkspaceId: previous.executionWorkspaceId,
          workspaceAdoptedAt: previous.workspaceAdoptedAt,
        }
      : { executionWorkspaceId: null, workspaceAdoptedAt: null };
  const [agg] = await tx
    .select({ maxEpoch: max(executionAssignments.epoch) })
    .from(executionAssignments)
    .where(eq(executionAssignments.runId, input.runId));
  const epoch = (agg?.maxEpoch ?? 0) + 1;
  const id = input.id ?? randomUUID();

  // The partial "one active per run" index forces the old row out of `active`
  // BEFORE the new row can be inserted, and the self-FK forces the pointer to
  // be written only AFTER the new row exists — hence three statements.
  if (active) {
    await tx
      .update(executionAssignments)
      .set({ state: "superseded", endedAt: now, updatedAt: now })
      .where(
        and(
          eq(executionAssignments.id, active.id),
          eq(executionAssignments.state, "active"),
        ),
      );
  }

  let row: ExecutionAssignment;

  try {
    [row] = await tx
      .insert(executionAssignments)
      .values({
        id,
        runId: input.runId,
        executionHostId: input.hostId,
        epoch,
        state: "active",
        placementReason: input.reason,
        // Stage A: the host never changes, so the handle carries forward.
        executionWorkspaceId: inherited.executionWorkspaceId,
        workspaceAdoptedAt: inherited.workspaceAdoptedAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MaisterError(
        "CONFLICT",
        `a concurrent placement minted an execution assignment for run ${input.runId}`,
        { cause: err, details: { reason: "assignment_mint_race" } },
      );
    }

    throw err;
  }

  if (active) {
    await tx
      .update(executionAssignments)
      .set({ supersededById: id })
      .where(eq(executionAssignments.id, active.id));
  }

  await tx
    .update(runs)
    .set({
      executionAssignmentId: id,
      flowDriverToken: null,
      flowDriverLeaseExpiresAt: null,
    })
    .where(eq(runs.id, input.runId));

  logger.info(
    {
      runId: input.runId,
      assignmentId: id,
      assignmentEpoch: epoch,
      reason: input.reason,
      supersededId: active?.id ?? null,
    },
    active ? "assignment-superseded" : "assignment-minted",
  );

  return row;
}

// Advisory for fencing (the next mint supersedes anything); idempotent.
export async function releaseAssignmentForRun(
  tx: Db,
  runId: string,
  reason: string,
  opts: { now?: Date; logger?: Logger } = {},
): Promise<ExecutionAssignment | null> {
  const now = opts.now ?? new Date();
  const [row] = await tx
    .update(executionAssignments)
    .set({
      state: "released",
      releasedReason: reason,
      endedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(executionAssignments.runId, runId),
        eq(executionAssignments.state, "active"),
      ),
    )
    .returning();

  if (row) {
    (opts.logger ?? defaultLog).info(
      { runId, assignmentId: row.id, assignmentEpoch: row.epoch, reason },
      "assignment-released",
    );
  }

  return row ?? null;
}

export async function setAssignmentWorkspace(
  tx: Db,
  assignmentId: AssignmentId | string,
  executionWorkspaceId: string,
  now: Date = new Date(),
): Promise<{ changed: boolean }> {
  const rows = await tx
    .update(executionAssignments)
    .set({ executionWorkspaceId, workspaceAdoptedAt: now, updatedAt: now })
    .where(eq(executionAssignments.id, assignmentId))
    .returning({ id: executionAssignments.id });

  return { changed: rows.length > 0 };
}

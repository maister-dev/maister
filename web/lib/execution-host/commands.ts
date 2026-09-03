import type { Db } from "./db";
import type { CommandId, CommandKind, CommandState } from "./types";

import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, lt, or } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { redactPayload } from "./redact";
import { OPEN_COMMAND_STATES, TERMINAL_COMMAND_STATES } from "./types";

import { executionCommands, type ExecutionCommand } from "@/lib/db/schema";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "ledger" });

export type InsertCommandInput = {
  id?: CommandId | string;
  runId: string;
  assignmentId: string;
  hostId: string;
  assignmentEpoch: number;
  kind: CommandKind;
  targetSessionId?: string | null;
  payload: unknown;
  maxAttempts: number;
  driverless?: boolean;
  now?: Date;
};

export type TransitionOptions = { logger?: Logger; now?: Date };

export type TransitionResult = {
  changed: boolean;
  row: ExecutionCommand | null;
};

export function isTerminalCommandState(state: CommandState): boolean {
  return (TERMINAL_COMMAND_STATES as readonly string[]).includes(state);
}

export async function insertCommand(
  tx: Db,
  input: InsertCommandInput,
): Promise<ExecutionCommand> {
  const now = input.now ?? new Date();
  const [row] = await tx
    .insert(executionCommands)
    .values({
      id: input.id ?? randomUUID(),
      runId: input.runId,
      executionAssignmentId: input.assignmentId,
      executionHostId: input.hostId,
      assignmentEpoch: input.assignmentEpoch,
      kind: input.kind,
      targetSessionId: input.targetSessionId ?? null,
      payload: redactPayload(input.kind, input.payload),
      state: "queued",
      attempts: 0,
      maxAttempts: input.maxAttempts,
      driverless: input.driverless ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return row;
}

export async function getCommand(
  db: Db,
  id: string,
): Promise<ExecutionCommand | null> {
  const rows = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, id))
    .limit(1);

  return rows[0] ?? null;
}

// Every ledger transition is a CAS on (id, state IN from, attempts). A signal
// that arrives for a row that already moved on — a stale attempt number or a
// terminal row — changes nothing and is logged `command-late-signal`.
export async function casTransition(
  db: Db,
  id: string,
  from: readonly CommandState[],
  attempts: number | null,
  patch: Partial<typeof executionCommands.$inferInsert>,
  opts: TransitionOptions = {},
): Promise<TransitionResult> {
  const now = opts.now ?? new Date();
  const predicate = [
    eq(executionCommands.id, id),
    inArray(executionCommands.state, [...from]),
  ];

  if (attempts !== null)
    predicate.push(eq(executionCommands.attempts, attempts));

  const rows = await db
    .update(executionCommands)
    .set({ ...patch, updatedAt: now })
    .where(and(...predicate))
    .returning();

  if (rows.length > 0) {
    (opts.logger ?? defaultLog).debug(
      {
        commandId: id,
        from,
        to: patch.state ?? rows[0].state,
        attempt: rows[0].attempts,
      },
      "command-transition",
    );

    return { changed: true, row: rows[0] };
  }

  const current = await getCommand(db, id);

  (opts.logger ?? defaultLog).warn(
    {
      commandId: id,
      expectedFrom: from,
      expectedAttempts: attempts,
      state: current?.state ?? null,
      attempts: current?.attempts ?? null,
      terminal: current ? isTerminalCommandState(current.state) : null,
    },
    "command-late-signal",
  );

  return { changed: false, row: current };
}

export async function claimDelivering(
  db: Db,
  id: string,
  expectedAttempts: number,
  opts: TransitionOptions = {},
): Promise<TransitionResult> {
  const now = opts.now ?? new Date();

  return casTransition(
    db,
    id,
    ["queued"],
    expectedAttempts,
    {
      state: "delivering",
      attempts: expectedAttempts + 1,
      deliveringSince: now,
      nextAttemptAt: null,
    },
    { ...opts, now },
  );
}

// Recovery only: a `delivering` row the host never saw (no receipt) goes back
// to `queued` with its attempt count intact, so the deliverer can claim it.
export async function requeueDelivering(
  db: Db,
  id: string,
  opts: TransitionOptions = {},
): Promise<TransitionResult> {
  const now = opts.now ?? new Date();

  return casTransition(
    db,
    id,
    ["delivering"],
    null,
    { state: "queued", deliveringSince: null, nextAttemptAt: null },
    { ...opts, now },
  );
}

export async function markAccepted(
  db: Db,
  id: string,
  attempts: number | null,
  opts: TransitionOptions = {},
): Promise<TransitionResult> {
  const now = opts.now ?? new Date();

  return casTransition(
    db,
    id,
    ["delivering"],
    attempts,
    { state: "accepted", acceptedAt: now },
    { ...opts, now },
  );
}

export async function markSucceeded(
  db: Db,
  id: string,
  attempts: number | null,
  result: Record<string, unknown> | null,
  opts: TransitionOptions = {},
): Promise<TransitionResult> {
  const now = opts.now ?? new Date();

  return casTransition(
    db,
    id,
    ["delivering", "accepted"],
    attempts,
    { state: "succeeded", completedAt: now, result },
    { ...opts, now },
  );
}

export async function markFailed(
  db: Db,
  id: string,
  attempts: number | null,
  error: Record<string, unknown>,
  opts: TransitionOptions = {},
): Promise<TransitionResult> {
  const now = opts.now ?? new Date();

  return casTransition(
    db,
    id,
    [...OPEN_COMMAND_STATES],
    attempts,
    { state: "failed", completedAt: now, lastError: error },
    { ...opts, now },
  );
}

export async function markFenced(
  db: Db,
  id: string,
  attempts: number | null,
  error: Record<string, unknown>,
  opts: TransitionOptions = {},
): Promise<TransitionResult> {
  const now = opts.now ?? new Date();

  return casTransition(
    db,
    id,
    [...OPEN_COMMAND_STATES],
    attempts,
    { state: "fenced", completedAt: now, lastError: error },
    { ...opts, now },
  );
}

// Unknown-outcome failure: back to `queued` with a backoff stamp while the
// per-kind budget allows another attempt with the SAME command id; `failed`
// once it is exhausted.
export async function failRetryable(
  db: Db,
  id: string,
  attempts: number,
  error: Record<string, unknown>,
  backoff: { nextAttemptAt: Date },
  opts: TransitionOptions = {},
): Promise<TransitionResult & { exhausted: boolean }> {
  const current = await getCommand(db, id);

  if (!current) return { changed: false, row: null, exhausted: false };

  if (attempts >= current.maxAttempts) {
    const failed = await markFailed(db, id, attempts, error, opts);

    return { ...failed, exhausted: true };
  }

  const now = opts.now ?? new Date();
  const result = await casTransition(
    db,
    id,
    ["delivering"],
    attempts,
    {
      state: "queued",
      nextAttemptAt: backoff.nextAttemptAt,
      deliveringSince: null,
      lastError: error,
    },
    { ...opts, now },
  );

  return { ...result, exhausted: false };
}

export type OpenCommandsCursor = { createdAt: Date; id: string };

export const OPEN_COMMANDS_PAGE_SIZE = 500;

// One page of open rows in `(created_at, id)` order; `after` continues from the
// last row of the previous page so a recovery pass reaches every open row no
// matter how many stay open.
export async function loadOpenCommands(
  db: Db,
  opts: { limit?: number; after?: OpenCommandsCursor } = {},
): Promise<ExecutionCommand[]> {
  const predicate = [
    inArray(executionCommands.state, [...OPEN_COMMAND_STATES]),
  ];

  if (opts.after) {
    predicate.push(
      or(
        gt(executionCommands.createdAt, opts.after.createdAt),
        and(
          eq(executionCommands.createdAt, opts.after.createdAt),
          gt(executionCommands.id, opts.after.id),
        ),
      )!,
    );
  }

  return db
    .select()
    .from(executionCommands)
    .where(and(...predicate))
    .orderBy(asc(executionCommands.createdAt), asc(executionCommands.id))
    .limit(opts.limit ?? OPEN_COMMANDS_PAGE_SIZE);
}

export async function listCommandsForRun(
  db: Db,
  runId: string,
): Promise<ExecutionCommand[]> {
  return db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.runId, runId))
    .orderBy(asc(executionCommands.createdAt));
}

export async function pruneTerminalCommands(
  db: Db,
  olderThan: Date,
): Promise<number> {
  const rows = await db
    .delete(executionCommands)
    .where(
      and(
        inArray(executionCommands.state, [...TERMINAL_COMMAND_STATES]),
        lt(executionCommands.completedAt, olderThan),
      ),
    )
    .returning({ id: executionCommands.id });

  return rows.length;
}

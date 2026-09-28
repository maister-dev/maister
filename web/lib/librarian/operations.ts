import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { and, eq, gt, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  agentTurns,
  librarianConversations,
  librarianOperations,
  runMessages,
  runs,
  taskClarifications,
  taskComments,
  tasks,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { librarianConfig } from "@/lib/librarian/config";

type Db = ReturnType<typeof getDb>;

export type LibrarianOperationResult = {
  statusCode: number;
  body: Record<string, unknown>;
};

export type AdmittedLibrarianOperation = {
  id: string;
  status: "admitted" | "succeeded" | "refused" | "failed" | "unknown";
  result: LibrarianOperationResult | null;
  reused: boolean;
};

const log = pino({
  name: "librarian.operations",
  level: process.env.LOG_LEVEL ?? "info",
});

// An unknown external effect remains visible and is never re-issued. It may
// outlive a context reset once its uncertainty window has elapsed; the ledger
// receipt remains available even after history deletion.
export function librarianOperationBlocksBarrier(now: Date): SQL {
  const recent = new Date(
    now.getTime() - librarianConfig().operationReconcileSeconds * 1000,
  );

  return or(
    eq(librarianOperations.status, "admitted"),
    and(
      eq(librarianOperations.status, "unknown"),
      or(
        isNull(librarianOperations.settledAt),
        gt(librarianOperations.settledAt, recent),
      ),
    ),
  )!;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }

  return value;
}

export function librarianRequestDigest(input: {
  kind: string;
  target: Record<string, string>;
  body: unknown;
}): string {
  const canonicalJson = JSON.stringify(
    canonicalize({
      kind: input.kind,
      target: input.target,
      body: input.body,
    }),
  );

  return createHash("sha256").update(canonicalJson).digest("hex");
}

export async function admitLibrarianOperation(
  input: {
    conversationId: string;
    segmentId: string;
    turnId: string;
    idempotencyKey: string;
    kind: string;
    target: Record<string, string>;
    body: unknown;
    allowDuplicate: boolean;
  },
  db: Db = getDb(),
): Promise<AdmittedLibrarianOperation> {
  const digest = librarianRequestDigest(input);

  return db.transaction(async (tx) => {
    const conversation = await tx.query.librarianConversations.findFirst({
      where: eq(librarianConversations.id, input.conversationId),
      columns: { id: true },
    });

    if (!conversation) {
      throw new MaisterError(
        "PRECONDITION",
        "librarian conversation is unavailable",
      );
    }

    // All effects in one conversation serialize their duplicate check. The
    // operation row itself is committed before any domain effect starts.
    await tx.execute(sql`
      SELECT id FROM librarian_conversations
      WHERE id = ${input.conversationId} FOR UPDATE
    `);

    const existing = await tx.query.librarianOperations.findFirst({
      where: and(
        eq(librarianOperations.conversationId, input.conversationId),
        eq(librarianOperations.idempotencyKey, input.idempotencyKey),
      ),
    });

    if (existing) {
      if (existing.requestDigest !== digest) {
        log.warn(
          { operationId: existing.id, kind: input.kind },
          "librarian operation key reused with a different payload",
        );
        throw new MaisterError(
          "CONFLICT",
          "operation key was used for a different request",
          {
            details: { reason: "idempotency_payload_mismatch" },
          },
        );
      }

      return {
        id: existing.id,
        status: existing.status,
        result: existing.result as LibrarianOperationResult | null,
        reused: true,
      };
    }

    if (!input.allowDuplicate) {
      const duplicate = await tx.query.librarianOperations.findFirst({
        where: and(
          eq(librarianOperations.segmentId, input.segmentId),
          eq(librarianOperations.requestDigest, digest),
          eq(librarianOperations.status, "succeeded"),
        ),
        columns: { id: true },
      });

      if (duplicate) {
        log.warn(
          { operationId: duplicate.id, kind: input.kind },
          "duplicate librarian effect refused",
        );
        throw new MaisterError(
          "CONFLICT",
          "this effect already succeeded in the current segment",
          {
            details: {
              reason: "duplicate_of_operation",
              operationId: duplicate.id,
            },
          },
        );
      }
    }

    const id = randomUUID();

    await tx.insert(librarianOperations).values({
      id,
      conversationId: input.conversationId,
      segmentId: input.segmentId,
      turnId: input.turnId,
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      requestDigest: digest,
      target: input.target,
      status: "admitted",
    });
    log.info(
      { operationId: id, kind: input.kind, status: "admitted" },
      "librarian operation admitted",
    );

    return { id, status: "admitted", result: null, reused: false };
  });
}

export async function settleLibrarianOperation(
  input: { id: string; result: LibrarianOperationResult },
  db: Db,
): Promise<void> {
  const updated = await db
    .update(librarianOperations)
    .set({ status: "succeeded", result: input.result, settledAt: new Date() })
    .where(
      and(
        eq(librarianOperations.id, input.id),
        eq(librarianOperations.status, "admitted"),
      ),
    )
    .returning({ id: librarianOperations.id, kind: librarianOperations.kind });

  if (updated.length !== 1) {
    throw new MaisterError(
      "CONFLICT",
      "librarian operation is no longer admitted",
      {
        details: { operationId: input.id },
      },
    );
  }

  log.info(
    { operationId: input.id, kind: updated[0].kind, status: "succeeded" },
    "librarian operation settled",
  );
}

// A launch has a durable Pending run at settlement time; the capacity gate
// resolves Running versus Pending only after that transaction commits. Refresh
// the already successful receipt without replaying the effect or audit.
export async function refreshSucceededLibrarianReceipt(
  input: { id: string; result: LibrarianOperationResult },
  db: Db = getDb(),
): Promise<void> {
  const updated = await db
    .update(librarianOperations)
    .set({ result: input.result })
    .where(
      and(
        eq(librarianOperations.id, input.id),
        eq(librarianOperations.status, "succeeded"),
      ),
    )
    .returning({ id: librarianOperations.id });

  if (updated.length !== 1) {
    throw new MaisterError(
      "CONFLICT",
      "cannot refresh a librarian operation that did not succeed",
      {
        details: { operationId: input.id },
      },
    );
  }
}

export async function refuseLibrarianOperation(
  input: {
    id: string;
    errorCode: string;
    statusCode: number;
    body: Record<string, unknown>;
  },
  db: Db = getDb(),
): Promise<void> {
  await db
    .update(librarianOperations)
    .set({
      status: "refused",
      errorCode: input.errorCode,
      result: { statusCode: input.statusCode, body: input.body },
      settledAt: new Date(),
    })
    .where(
      and(
        eq(librarianOperations.id, input.id),
        eq(librarianOperations.status, "admitted"),
      ),
    );
}

export async function markLibrarianOperationUnknown(
  input: { id: string; errorCode: string },
  db: Db,
): Promise<void> {
  const updated = await db
    .update(librarianOperations)
    .set({
      status: "unknown",
      errorCode: input.errorCode,
      result: {
        statusCode: 202,
        body: { operationId: input.id, status: "unknown" },
      },
      settledAt: new Date(),
    })
    .where(
      and(
        eq(librarianOperations.id, input.id),
        eq(librarianOperations.status, "admitted"),
      ),
    )
    .returning({ id: librarianOperations.id, kind: librarianOperations.kind });

  if (updated.length !== 1) {
    throw new MaisterError(
      "CONFLICT",
      "cannot mark a librarian operation unknown after settlement",
      {
        details: { operationId: input.id },
      },
    );
  }

  log.warn(
    {
      operationId: input.id,
      kind: updated[0].kind,
      status: "unknown",
      errorCode: input.errorCode,
    },
    "librarian operation outcome unknown",
  );
}

export async function reconcileAdmittedLibrarianOperations(
  olderThan: Date,
  db: Db = getDb(),
  conversationId?: string,
): Promise<number> {
  const stale = await db.query.librarianOperations.findMany({
    where: and(
      conversationId
        ? eq(librarianOperations.conversationId, conversationId)
        : undefined,
      or(
        eq(librarianOperations.status, "admitted"),
        eq(librarianOperations.status, "unknown"),
      ),
      lt(librarianOperations.createdAt, olderThan),
    ),
    columns: { id: true, kind: true, status: true },
  });

  for (const operation of stale) {
    const [task, comment, run, clarification, runMessage, agentTurn] =
      await Promise.all([
        db.query.tasks.findFirst({
          where: eq(tasks.createdViaOperationId, operation.id),
          columns: { id: true },
        }),
        db.query.taskComments.findFirst({
          where: eq(taskComments.viaOperationId, operation.id),
          columns: { id: true },
        }),
        db.query.runs.findFirst({
          where: eq(runs.librarianOperationId, operation.id),
          columns: { id: true },
        }),
        db.query.taskClarifications.findFirst({
          where: eq(taskClarifications.requestedViaOperationId, operation.id),
          columns: { id: true, seq: true, taskId: true },
        }),
        db.query.runMessages.findFirst({
          where: eq(runMessages.viaOperationId, operation.id),
          columns: { id: true, runId: true },
        }),
        db.query.agentTurns.findFirst({
          where: eq(agentTurns.logicalKey, operation.id),
          columns: { id: true, runId: true },
        }),
      ]);

    const result = task
      ? { statusCode: 201, body: { taskId: task.id } }
      : comment
        ? { statusCode: 201, body: { commentId: comment.id } }
        : run
          ? { statusCode: 201, body: { runId: run.id } }
          : clarification
            ? {
                statusCode: 201,
                body: {
                  id: clarification.id,
                  seq: clarification.seq,
                  taskId: clarification.taskId,
                },
              }
            : runMessage
              ? {
                  statusCode: 202,
                  body: {
                    runId: runMessage.runId,
                    messageId: runMessage.id,
                    outcome: "queued",
                  },
                }
              : agentTurn
                ? {
                    statusCode: 202,
                    body: {
                      runId: agentTurn.runId,
                      messageId: agentTurn.id,
                      outcome: "queued",
                    },
                  }
                : null;
    const externalEffect = new Set([
      "run_stop",
      "run_recover",
      "run_sync",
      "run_reopen",
      "card_decide",
    ]).has(operation.kind);
    // These services cross Git/supervisor boundaries and do not have a
    // via-operation result row. An absent row cannot prove non-application.
    if (!result && externalEffect && operation.status === "unknown") continue;
    const status = result ? "succeeded" : externalEffect ? "unknown" : "failed";
    const receipt =
      result ??
      (externalEffect
        ? {
            statusCode: 202,
            body: { operationId: operation.id, status: "unknown" },
          }
        : null);

    await db
      .update(librarianOperations)
      .set({
        status,
        result: receipt,
        errorCode: result
          ? null
          : externalEffect
            ? "outcome_unknown"
            : "not_applied",
        settledAt: new Date(),
      })
      .where(
        and(
          eq(librarianOperations.id, operation.id),
          or(
            eq(librarianOperations.status, "admitted"),
            eq(librarianOperations.status, "unknown"),
          ),
        ),
      );
    log.info(
      { operationId: operation.id, kind: operation.kind, status },
      "librarian operation reconciled",
    );
  }

  return stale.length;
}

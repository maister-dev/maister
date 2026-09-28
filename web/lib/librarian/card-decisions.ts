import "server-only";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import { requireProjectActionForUser } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import {
  librarianCards,
  librarianConversations,
  librarianOperations,
  librarianTurns,
} from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  cardTarget,
  librarianCardProposalSchema,
  type LibrarianCardProposal,
} from "@/lib/librarian/cards";
import {
  admitLibrarianOperation,
  markLibrarianOperationUnknown,
  refuseLibrarianOperation,
  settleLibrarianOperation,
  type LibrarianOperationResult,
} from "@/lib/librarian/operations";
import { promoteRun } from "@/lib/runs/promote";
import { rememberAcceptedSuggestion } from "@/lib/librarian/memory";
import { respondToHitl } from "@/lib/services/hitl";
import { acceptStatement } from "@/lib/tasks/statement";
import { discardWorkbench } from "@/lib/workbench-lifecycle/service";

type Db = ReturnType<typeof getDb>;

const log = pino({
  name: "librarian.card-decisions",
  level: process.env.LOG_LEVEL ?? "info",
});

function changed(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "card target changed; review a new proposal",
    {
      details: { reason: "target_changed" },
    },
  );
}

async function loadOwnedCard(cardId: string, ownerUserId: string, db: Db) {
  const [row] = await db
    .select({
      card: librarianCards,
      conversationUserId: librarianConversations.userId,
    })
    .from(librarianCards)
    .innerJoin(
      librarianConversations,
      eq(librarianCards.conversationId, librarianConversations.id),
    )
    .where(eq(librarianCards.id, cardId));

  if (!row || row.conversationUserId !== ownerUserId) {
    throw new MaisterError("PRECONDITION", "card is unavailable");
  }

  return row.card;
}

async function assertCardTargetUnchanged(
  card: Awaited<ReturnType<typeof loadOwnedCard>>,
  proposal: LibrarianCardProposal,
  ownerUserId: string,
  db: Db,
): Promise<void> {
  let target: Awaited<ReturnType<typeof cardTarget>>;

  try {
    target = await cardTarget(proposal, ownerUserId, db);
  } catch (err) {
    if (!isMaisterError(err)) throw err;
    throw changed();
  }

  if (
    target.revision !== card.targetRevision ||
    Object.keys(target.target).length !== Object.keys(card.target).length ||
    Object.entries(target.target).some(
      ([key, value]) => card.target[key] !== value,
    )
  ) {
    log.warn({ cardId: card.id, kind: card.kind }, "card target drifted");
    throw changed();
  }
}

async function executeHumanAction(
  proposal: Exclude<
    LibrarianCardProposal,
    { action: "statement_accept" | "memory_suggest" }
  >,
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    role: string;
  },
  db: Db,
): Promise<Record<string, unknown>> {
  if (proposal.action === "hitl_respond") {
    const response = await respondToHitl(
      {
        runId: proposal.runId,
        hitlRequestId: proposal.hitlRequestId,
        body: proposal.response,
        bodyKeys: Object.keys(proposal.response),
      },
      {
        kind: "user",
        userId: user.id,
        label: user.name ?? user.email ?? user.id,
      },
      { db },
    );

    if (response.status >= 400) {
      throw new MaisterError(
        "PRECONDITION",
        "HITL response was refused by the run",
        {
          details: { reason: "hitl_response_refused", status: response.status },
        },
      );
    }

    return {
      runId: proposal.runId,
      hitlRequestId: proposal.hitlRequestId,
      status: "answered",
    };
  }

  if (proposal.action === "run_promote") {
    const result = await promoteRun(
      proposal.runId,
      {
        mode: proposal.mode,
        reviewedTargetCommit: proposal.reviewedTargetCommit,
      },
      {
        sessionUser: user,
        authorize: async (projectId: string) => {
          await requireProjectActionForUser(user.id, projectId, "promoteRun");
        },
      },
      db,
    );

    return { runId: proposal.runId, promotion: result };
  }

  const result = await discardWorkbench(proposal.runId);

  return { runId: proposal.runId, discard: result };
}

export async function decideLibrarianCard(
  input: {
    cardId: string;
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      role: string;
    };
    decision: "accept" | "reject";
    expectedRevision?: number;
  },
  db: Db = getDb(),
): Promise<LibrarianOperationResult> {
  const card = await loadOwnedCard(input.cardId, input.user.id, db);

  if (card.target.projectId) {
    try {
      await requireProjectActionForUser(
        input.user.id,
        card.target.projectId,
        "readBoard",
      );
    } catch (err) {
      if (!isMaisterError(err)) throw err;
      throw new MaisterError("PRECONDITION", "card is unavailable");
    }
  } else if (card.kind !== "memory_suggestion") {
    throw new MaisterError("PRECONDITION", "card is unavailable");
  }

  if (card.status === "accepted") {
    const [operation] = await db
      .select({ result: librarianOperations.result })
      .from(librarianOperations)
      .where(
        and(
          eq(librarianOperations.conversationId, card.conversationId),
          eq(librarianOperations.idempotencyKey, `card:${card.id}`),
        ),
      );

    if (operation?.result) return operation.result as LibrarianOperationResult;
    throw changed();
  }

  if (card.status === "rejected" && input.decision === "reject") {
    return { statusCode: 200, body: { cardId: card.id, status: "rejected" } };
  }

  if (input.decision === "reject") {
    await db.transaction(async (tx) => {
      await tx
        .select({ id: librarianConversations.id })
        .from(librarianConversations)
        .where(eq(librarianConversations.id, card.conversationId))
        .for("update");
      const [operation] = await tx
        .select({
          id: librarianOperations.id,
          status: librarianOperations.status,
        })
        .from(librarianOperations)
        .where(
          and(
            eq(librarianOperations.conversationId, card.conversationId),
            eq(librarianOperations.idempotencyKey, `card:${card.id}`),
          ),
        );

      if (operation && operation.status !== "refused") throw changed();
      const [rejected] = await tx
        .update(librarianCards)
        .set({
          status: "rejected",
          decidedAt: new Date(),
        })
        .where(
          and(
            eq(librarianCards.id, card.id),
            eq(librarianCards.status, "pending"),
          ),
        )
        .returning({ id: librarianCards.id });

      if (!rejected) throw changed();
    });
    log.info(
      { cardId: card.id, kind: card.kind, decision: "rejected" },
      "librarian card decided",
    );

    return { statusCode: 200, body: { cardId: card.id, status: "rejected" } };
  }

  if (card.status !== "pending") throw changed();
  if (card.expiresAt <= new Date()) {
    await db
      .update(librarianCards)
      .set({ status: "expired", decidedAt: new Date() })
      .where(
        and(
          eq(librarianCards.id, card.id),
          eq(librarianCards.status, "pending"),
        ),
      );
    throw changed();
  }

  const proposal = librarianCardProposalSchema.parse(card.payload);

  if (
    proposal.action === "statement_accept" &&
    input.expectedRevision !== proposal.expectedRevision
  ) {
    throw changed();
  }
  await assertCardTargetUnchanged(card, proposal, input.user.id, db);

  const [turn] = await db
    .select({ id: librarianTurns.id })
    .from(librarianTurns)
    .where(eq(librarianTurns.segmentId, card.segmentId))
    .orderBy(desc(librarianTurns.createdAt))
    .limit(1);

  if (!turn)
    throw new MaisterError(
      "PRECONDITION",
      "card's conversation turn is unavailable",
    );
  const operation = await admitLibrarianOperation(
    {
      conversationId: card.conversationId,
      segmentId: card.segmentId,
      turnId: turn.id,
      idempotencyKey: `card:${card.id}`,
      kind: "card_decide",
      target: card.target,
      body: {
        decision: "accept",
        cardId: card.id,
        payloadDigest: card.payloadDigest,
      },
      allowDuplicate: true,
    },
    db,
  );

  if (operation.reused) {
    return (
      operation.result ?? {
        statusCode: 202,
        body: {
          cardId: card.id,
          operationId: operation.id,
          status: operation.status,
        },
      }
    );
  }

  if (proposal.action === "memory_suggest") {
    try {
      const receipt = await db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ id: librarianConversations.id })
          .from(librarianConversations)
          .where(eq(librarianConversations.id, card.conversationId))
          .for("update");

        if (!conversation) throw changed();
        const [locked] = await tx
          .select({ status: librarianCards.status })
          .from(librarianCards)
          .where(eq(librarianCards.id, card.id))
          .for("update");

        if (locked?.status !== "pending") throw changed();
        const itemId = await rememberAcceptedSuggestion(
          tx as unknown as Db,
          input.user.id,
          proposal.memory,
          Number(card.targetRevision),
        );
        const result: LibrarianOperationResult = {
          statusCode: 200,
          body: { cardId: card.id, status: "accepted", memoryItemId: itemId },
        };

        await tx
          .update(librarianCards)
          .set({ status: "accepted", decidedAt: new Date() })
          .where(eq(librarianCards.id, card.id));
        await settleLibrarianOperation(
          { id: operation.id, result },
          tx as unknown as Db,
        );

        return result;
      });

      log.info(
        { cardId: card.id, kind: card.kind, decision: "accepted" },
        "librarian card decided",
      );

      return receipt;
    } catch (err) {
      if (isMaisterError(err))
        await refuseLibrarianOperation(
          {
            id: operation.id,
            errorCode: err.code,
            statusCode: 409,
            body: {
              code: err.code,
              message: err.message,
              details: err.details,
            },
          },
          db,
        );
      throw err;
    }
  }

  const currentCard = await loadOwnedCard(card.id, input.user.id, db);

  if (currentCard.status !== "pending") {
    await refuseLibrarianOperation(
      {
        id: operation.id,
        errorCode: "CONFLICT",
        statusCode: 409,
        body: {
          code: "CONFLICT",
          message: "card decision changed",
          details: { reason: "target_changed" },
        },
      },
      db,
    );
    throw changed();
  }

  if (proposal.action === "statement_accept") {
    try {
      const result = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ status: librarianCards.status })
          .from(librarianCards)
          .where(eq(librarianCards.id, card.id))
          .for("update");

        if (locked?.status !== "pending") throw changed();
        const accepted = await acceptStatement(
          {
            projectId: card.target.projectId,
            taskId: proposal.taskId,
            conversationId: card.conversationId,
            statement: proposal.statement,
            expectedRevision: proposal.expectedRevision,
            actor: { type: "user", id: input.user.id },
            viaOperationId: operation.id,
          },
          tx as unknown as Db,
        );
        const receipt: LibrarianOperationResult = {
          statusCode: 200,
          body: {
            cardId: card.id,
            status: "accepted",
            taskId: accepted.taskId,
            revision: accepted.revision,
          },
        };

        await tx
          .update(librarianCards)
          .set({ status: "accepted", decidedAt: new Date() })
          .where(eq(librarianCards.id, card.id));
        await settleLibrarianOperation(
          { id: operation.id, result: receipt },
          tx as unknown as Db,
        );

        return receipt;
      });

      log.info(
        { cardId: card.id, kind: card.kind, decision: "accepted" },
        "librarian card decided",
      );

      return result;
    } catch (err) {
      if (isMaisterError(err)) {
        await refuseLibrarianOperation(
          {
            id: operation.id,
            errorCode: err.code,
            statusCode: 409,
            body: {
              code: err.code,
              message: err.message,
              details: err.details,
            },
          },
          db,
        );
      }
      throw err;
    }
  }

  try {
    const result = await executeHumanAction(proposal, input.user, db);
    const receipt: LibrarianOperationResult = {
      statusCode: 200,
      body: { cardId: card.id, status: "accepted", result },
    };

    await db.transaction(async (tx) => {
      await tx
        .update(librarianCards)
        .set({ status: "accepted", decidedAt: new Date() })
        .where(
          and(
            eq(librarianCards.id, card.id),
            eq(librarianCards.status, "pending"),
          ),
        );
      await settleLibrarianOperation(
        { id: operation.id, result: receipt },
        tx as unknown as Db,
      );
    });
    log.info(
      { cardId: card.id, kind: card.kind, decision: "accepted" },
      "librarian card decided",
    );

    return receipt;
  } catch (err) {
    if (
      isMaisterError(err) &&
      err.details?.reason === "hitl_response_refused"
    ) {
      const receipt: LibrarianOperationResult = {
        statusCode: 409,
        body: { code: err.code, message: err.message, details: err.details },
      };

      await refuseLibrarianOperation(
        {
          id: operation.id,
          errorCode: err.code,
          statusCode: receipt.statusCode,
          body: receipt.body,
        },
        db,
      );
      log.warn(
        { cardId: card.id, kind: card.kind, status: 409 },
        "librarian card effect refused",
      );

      return receipt;
    }
    await markLibrarianOperationUnknown(
      {
        id: operation.id,
        errorCode: isMaisterError(err) ? err.code : "outcome_unknown",
      },
      db,
    );
    log.warn(
      { cardId: card.id, kind: card.kind, error: err },
      "librarian card outcome unknown",
    );

    return {
      statusCode: 202,
      body: { cardId: card.id, operationId: operation.id, status: "unknown" },
    };
  }
}

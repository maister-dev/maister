import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ScopedHumanAskBody } from "@/lib/services/agent-question-contract";
import type { LibrarianCardRow } from "@/lib/db/schema";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import pino from "pino";

import {
  appendConversationMessage,
  lockOwnerConversation,
} from "./conversation";
import { lockLibrarianKnowledgeContext } from "./knowledge-authority";
import {
  librarianProjectSources,
  recheckLibrarianProjects,
  turnSourceProjectIds,
  visibleLibrarianCapture,
} from "./disclosed-context";

import {
  librarianCards,
  librarianMessages,
  librarianTurns,
} from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { validateHitlResponse } from "@/lib/flows/hitl-validate";
import { scopedHumanAskBodySchema } from "@/lib/services/agent-question-contract";

const log = pino({
  name: "librarian.questions",
  level: process.env.LOG_LEVEL ?? "info",
});

export type PrivateQuestionState =
  "checkpoint_pending" | "open" | "accepted" | "delivered" | "closed";

function questionState(card: LibrarianCardRow): PrivateQuestionState {
  if (card.questionDeliveredAt) return "delivered";
  if (card.status === "accepted") return "accepted";
  if (card.status !== "pending") return "closed";

  return card.questionCheckpointAt ? "open" : "checkpoint_pending";
}

export function privateQuestionView(card: LibrarianCardRow) {
  const state = questionState(card);

  if (state === "checkpoint_pending") return null;

  const request = scopedHumanAskBodySchema.parse(card.payload);

  return {
    id: card.id,
    state,
    question: request.question,
    schema: request.schema,
    answer: card.questionAnswer,
  };
}

export async function openPrivateQuestion(
  tokenId: string,
  request: ScopedHumanAskBody,
  db: Db = getDb(),
) {
  const body = scopedHumanAskBodySchema.parse(request);

  return db.transaction(async (tx) => {
    const owner = await lockLibrarianKnowledgeContext(
      tx,
      tokenId,
      "librarian:cards",
    );
    const digest = contentDigest(body);
    const [previous] = await tx
      .select()
      .from(librarianCards)
      .where(
        and(
          eq(librarianCards.questionTurnId, owner.turnId),
          eq(librarianCards.questionKey, body.requestKey),
        ),
      );

    if (previous) {
      if (previous.payloadDigest !== digest)
        throw new MaisterError(
          "CONFLICT",
          "Question request key is already in use",
        );

      return { questionId: previous.id, state: questionState(previous) };
    }
    const [pending] = await tx
      .select({ id: librarianCards.id })
      .from(librarianCards)
      .where(
        and(
          eq(librarianCards.questionTurnId, owner.turnId),
          eq(librarianCards.status, "pending"),
        ),
      );

    if (pending)
      throw new MaisterError(
        "CONFLICT",
        "This turn already has a pending question",
      );
    const [created] = await tx
      .insert(librarianCards)
      .values({
        conversationId: owner.conversationId,
        segmentId: owner.segmentId,
        questionTurnId: owner.turnId,
        questionKey: body.requestKey,
        kind: "question",
        status: "pending",
        target: {},
        payload: body,
        payloadDigest: digest,
        requiresOwner: true,
        // Owner questions remain open across tab close and have no approval TTL.
        expiresAt: new Date("9999-12-31T23:59:59Z"),
      })
      .returning();

    log.info(
      {
        questionId: created.id,
        turnId: owner.turnId,
        state: "checkpoint_pending",
      },
      "private question recorded",
    );

    return { questionId: created.id, state: questionState(created) };
  });
}

export async function answerPrivateQuestion(
  ownerId: string,
  cardId: string,
  answer: Record<string, unknown>,
  db: Db = getDb(),
) {
  return db.transaction(async (tx) => {
    const { conversation, segment } = await lockOwnerConversation(tx, ownerId);
    const [card] = await tx
      .select()
      .from(librarianCards)
      .where(
        and(
          eq(librarianCards.id, cardId),
          eq(librarianCards.conversationId, conversation.id),
          eq(librarianCards.kind, "question"),
        ),
      )
      .for("update");

    if (!card?.questionTurnId)
      throw new MaisterError("PRECONDITION", "Question unavailable", {
        details: { reason: "not_found" },
      });
    const [turn] = await tx
      .select()
      .from(librarianTurns)
      .where(eq(librarianTurns.id, card.questionTurnId))
      .for("update");

    if (
      !turn ||
      (await visibleLibrarianCapture(tx, ownerId, turn.knowledgeAccess)) ===
        null
    )
      throw new MaisterError("PRECONDITION", "Question unavailable", {
        details: { reason: "not_found" },
      });
    const sourceProjectIds = await turnSourceProjectIds(tx, turn.id);

    await recheckLibrarianProjects(
      tx,
      ownerId,
      librarianProjectSources(sourceProjectIds),
    );
    if (
      conversation.resetState !== "none" ||
      card.segmentId !== segment.id ||
      questionState(card) === "closed"
    )
      throw new MaisterError("CONFLICT", "Question is closed", {
        details: { reason: "question_closed" },
      });
    if (card.questionAnswer) {
      if (contentDigest(card.questionAnswer) !== contentDigest(answer))
        throw new MaisterError(
          "CONFLICT",
          "Another answer has already been accepted",
        );

      return {
        questionId: card.id,
        state: card.questionDeliveredAt
          ? ("delivered" as const)
          : ("accepted" as const),
        conversationId: conversation.id,
      };
    }
    if (!card.questionCheckpointAt || turn.status !== "awaiting_answer")
      throw new MaisterError(
        "CONFLICT",
        "The question has no recoverable checkpoint",
      );
    const validation = validateHitlResponse(
      answer,
      scopedHumanAskBodySchema.parse(card.payload).schema,
    );

    if (!validation.ok) throw new MaisterError("CONFIG", validation.message);
    await tx
      .update(librarianCards)
      .set({
        status: "accepted",
        questionAnswer: answer,
        decidedAt: new Date(),
      })
      .where(eq(librarianCards.id, card.id));
    await tx
      .update(librarianTurns)
      .set({
        status: "queued",
        startAttempts: 0,
        startLeaseAt: null,
        deadlineAt: null,
      })
      .where(eq(librarianTurns.id, turn.id));
    await appendConversationMessage(tx, {
      conversationId: conversation.id,
      segmentId: segment.id,
      authorKind: "system",
      body: "private_answer_queued",
      turnId: turn.id,
      cardId: card.id,
      sourceProjectIds,
    });
    log.info(
      { questionId: card.id, turnId: turn.id, state: "accepted" },
      "private answer queued",
    );

    return {
      questionId: card.id,
      state: "accepted" as const,
      conversationId: conversation.id,
    };
  });
}

export async function privateAnswerContext(tx: Db, turnId: string) {
  const records = await tx
    .select({ card: librarianCards, message: librarianMessages })
    .from(librarianCards)
    .innerJoin(
      librarianMessages,
      and(
        eq(librarianMessages.cardId, librarianCards.id),
        eq(librarianMessages.turnId, turnId),
        eq(librarianMessages.authorKind, "system"),
      ),
    )
    .where(
      and(
        eq(librarianCards.questionTurnId, turnId),
        eq(librarianCards.status, "accepted"),
      ),
    )
    .orderBy(asc(librarianMessages.seq));

  return {
    text: records
      .map(({ card }) =>
        JSON.stringify({
          question: scopedHumanAskBodySchema.parse(card.payload).question,
          answer: card.questionAnswer,
        }),
      )
      .join("\n"),
    messageIds: records.map(({ message }) => message.id),
    hasUndeliveredAnswer: records.some(({ card }) => !card.questionDeliveredAt),
    sources: librarianProjectSources(
      records.flatMap(({ message }) => message.sourceProjectIds),
    ),
  };
}

export async function checkpointPrivateQuestions(
  tx: Db,
  turnId: string,
): Promise<LibrarianCardRow | null> {
  // The owning prompt result and this receipt commit in the same transaction.
  await tx
    .update(librarianCards)
    .set({ questionDeliveredAt: new Date() })
    .where(
      and(
        eq(librarianCards.questionTurnId, turnId),
        eq(librarianCards.status, "accepted"),
        isNull(librarianCards.questionDeliveredAt),
      ),
    );
  const [pending] = await tx
    .update(librarianCards)
    .set({ questionCheckpointAt: new Date() })
    .where(
      and(
        eq(librarianCards.questionTurnId, turnId),
        eq(librarianCards.status, "pending"),
      ),
    )
    .returning();

  return pending ?? null;
}

export async function closeUndeliveredQuestions(
  tx: Db,
  turnId: string,
): Promise<null> {
  await tx
    .update(librarianCards)
    .set({
      status: "superseded",
      decidedAt: sql`coalesce(${librarianCards.decidedAt}, now())`,
    })
    .where(
      and(
        eq(librarianCards.questionTurnId, turnId),
        inArray(librarianCards.status, ["pending", "accepted"]),
        isNull(librarianCards.questionDeliveredAt),
      ),
    );

  return null;
}

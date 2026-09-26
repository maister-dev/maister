import "server-only";

import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { requireProjectActionForUser, type ProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { hitlRequests, librarianCards, runs, tasks } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { taskStatementSchema } from "@/lib/tasks/statement";

type Db = ReturnType<typeof getDb>;

export const librarianCardProposalSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("statement_accept"),
      taskId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
      statement: taskStatementSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("hitl_respond"),
      runId: z.string().uuid(),
      hitlRequestId: z.string().uuid(),
      response: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      action: z.literal("run_promote"),
      runId: z.string().uuid(),
      mode: z.enum(["local_merge", "rebase_merge", "pull_request"]),
      reviewedTargetCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("run_discard"),
      runId: z.string().uuid(),
    })
    .strict(),
]);

export type LibrarianCardProposal = z.infer<typeof librarianCardProposalSchema>;

const log = pino({
  name: "librarian.cards",
  level: process.env.LOG_LEVEL ?? "info",
});

function cardTtlMinutes(): number {
  const raw = process.env.MAISTER_LIBRARIAN_CONFIRMATION_TTL_MINUTES ?? "60";
  const minutes = Number(raw);

  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080) {
    throw new MaisterError(
      "CONFIG",
      "MAISTER_LIBRARIAN_CONFIRMATION_TTL_MINUTES must be an integer from 1 to 10080",
    );
  }

  return minutes;
}

async function assertOwnerAction(
  userId: string,
  projectId: string,
  action: ProjectAction,
): Promise<void> {
  try {
    await requireProjectActionForUser(userId, projectId, action);
  } catch (err) {
    if (!isMaisterError(err)) throw err;
    try {
      await requireProjectActionForUser(userId, projectId, "readBoard");
    } catch (visibilityErr) {
      if (!isMaisterError(visibilityErr)) throw visibilityErr;
      throw new MaisterError("PRECONDITION", "card target is unavailable", {
        details: { reason: "target_changed" },
      });
    }
    throw err;
  }
}

function hitlQuestionRevision(question: {
  id: string;
  kind: string;
  prompt: string;
  schema: unknown;
  createdAt: Date;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: question.id,
        kind: question.kind,
        prompt: question.prompt,
        schema: question.schema,
        createdAt: question.createdAt.toISOString(),
      }),
    )
    .digest("hex");
}

export async function cardTarget(
  proposal: LibrarianCardProposal,
  ownerUserId: string,
  db: Db,
): Promise<{ target: Record<string, string>; revision: string }> {
  if (proposal.action === "statement_accept") {
    const [task] = await db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        revision: tasks.revision,
      })
      .from(tasks)
      .where(eq(tasks.id, proposal.taskId));

    if (!task)
      throw new MaisterError("PRECONDITION", "card target is unavailable", {
        details: { reason: "target_changed" },
      });
    await assertOwnerAction(ownerUserId, task.projectId, "editTask");

    if (task.revision !== proposal.expectedRevision) {
      throw new MaisterError(
        "CONFLICT",
        "task revision changed before the card was proposed",
        {
          details: { reason: "target_changed" },
        },
      );
    }

    return {
      target: { projectId: task.projectId, taskId: task.id },
      revision: String(task.revision),
    };
  }

  const [run] = await db
    .select({ id: runs.id, projectId: runs.projectId, status: runs.status })
    .from(runs)
    .where(eq(runs.id, proposal.runId));

  if (!run?.projectId)
    throw new MaisterError("PRECONDITION", "card target is unavailable", {
      details: { reason: "target_changed" },
    });
  const action: ProjectAction =
    proposal.action === "hitl_respond"
      ? "answerHitl"
      : proposal.action === "run_promote"
        ? "promoteRun"
        : "recoverRun";

  await assertOwnerAction(ownerUserId, run.projectId, action);

  if (proposal.action === "hitl_respond") {
    const [question] = await db
      .select({
        id: hitlRequests.id,
        runId: hitlRequests.runId,
        kind: hitlRequests.kind,
        prompt: hitlRequests.prompt,
        schema: hitlRequests.schema,
        createdAt: hitlRequests.createdAt,
        respondedAt: hitlRequests.respondedAt,
      })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.id, proposal.hitlRequestId),
          eq(hitlRequests.runId, run.id),
        ),
      );

    if (!question || question.respondedAt) {
      throw new MaisterError(
        "CONFLICT",
        "HITL question changed before the card was proposed",
        {
          details: { reason: "target_changed" },
        },
      );
    }

    return {
      target: {
        projectId: run.projectId,
        runId: run.id,
        hitlRequestId: question.id,
      },
      revision: hitlQuestionRevision(question),
    };
  }

  if (proposal.action === "run_promote" && run.status !== "Review") {
    throw new MaisterError(
      "CONFLICT",
      "run left Review before the card was proposed",
      {
        details: { reason: "target_changed" },
      },
    );
  }

  return {
    target: { projectId: run.projectId, runId: run.id },
    revision:
      proposal.action === "run_promote"
        ? `${run.status}:${proposal.reviewedTargetCommit}`
        : run.status,
  };
}

export async function proposeLibrarianCard(
  input: {
    conversationId: string;
    segmentId: string;
    ownerUserId: string;
    proposal: LibrarianCardProposal;
    recordCreated: (db: Db, cardId: string) => Promise<void>;
  },
  db: Db = getDb(),
): Promise<{ cardId: string; expiresAt: Date }> {
  const proposal = librarianCardProposalSchema.parse(input.proposal);
  const { target, revision } = await cardTarget(
    proposal,
    input.ownerUserId,
    db,
  );
  const digest = createHash("sha256")
    .update(JSON.stringify(proposal))
    .digest("hex");
  const expiresAt = new Date(Date.now() + cardTtlMinutes() * 60_000);
  const card = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(librarianCards)
      .values({
        conversationId: input.conversationId,
        segmentId: input.segmentId,
        kind:
          proposal.action === "statement_accept"
            ? "statement_proposal"
            : "confirmation",
        status: "pending",
        target,
        targetRevision: revision,
        payload: proposal,
        payloadDigest: digest,
        requiresOwner: true,
        expiresAt,
      })
      .returning({ id: librarianCards.id });

    await input.recordCreated(tx as unknown as Db, created.id);

    return created;
  });

  log.info(
    { cardId: card.id, kind: proposal.action, decision: "proposed" },
    "librarian card proposed",
  );

  return { cardId: card.id, expiresAt };
}

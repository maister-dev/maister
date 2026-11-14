import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { librarianConversations } from "@/lib/db/schema";
import type { CardTarget, LibrarianCardProposal } from "./cards";

import { and, eq, gt, inArray, notExists, sql } from "drizzle-orm";

import {
  hitlQuestionRevision,
  librarianCardProposalSchema,
  matchesFrozenCardTarget,
  runCardTarget,
} from "./cards";
import { memoryContentDigest } from "./memory";

import {
  hitlRequests,
  librarianCards,
  librarianMemoryTombstones,
  librarianOperations,
  runs,
  tasks,
  users,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  getActionableProjectIds,
  getVisibleProjects,
} from "@/lib/queries/visible-projects";

export type ConfirmationOwner = Pick<
  typeof librarianConversations.$inferSelect,
  "id" | "userId" | "currentSegmentId" | "contextEpoch" | "resetState"
>;

export async function readLibrarianProjectAccess(db: Db, ownerId: string) {
  const [owner] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, ownerId));

  if (!owner)
    throw new MaisterError(
      "UNAUTHENTICATED",
      "Librarian owner is unavailable.",
    );
  const [visible, actionable] = await Promise.all([
    getVisibleProjects(ownerId, owner.role, db),
    getActionableProjectIds(ownerId, owner.role, db),
  ]);

  return {
    visible: new Map(visible.map((project) => [project.id, project.slug])),
    actionable: new Set(actionable),
  };
}

type Access = Awaited<ReturnType<typeof readLibrarianProjectAccess>>;

async function pendingCandidates(db: Db, conversationId: string) {
  const cards = librarianCards;

  return db
    .select({
      id: cards.id,
      segmentId: cards.segmentId,
      target: cards.target,
      targetRevision: cards.targetRevision,
      payload: cards.payload,
      task: {
        id: tasks.id,
        projectId: tasks.projectId,
        revision: tasks.revision,
      },
      run: { id: runs.id, projectId: runs.projectId, status: runs.status },
      question: {
        id: hitlRequests.id,
        kind: hitlRequests.kind,
        prompt: hitlRequests.prompt,
        schema: hitlRequests.schema,
        createdAt: hitlRequests.createdAt,
        respondedAt: hitlRequests.respondedAt,
      },
    })
    .from(cards)
    .leftJoin(tasks, eq(tasks.id, sql`${cards.target}->>'taskId'`))
    .leftJoin(runs, eq(runs.id, sql`${cards.target}->>'runId'`))
    .leftJoin(
      hitlRequests,
      and(
        eq(hitlRequests.id, sql`${cards.target}->>'hitlRequestId'`),
        eq(hitlRequests.runId, runs.id),
      ),
    )
    .where(
      and(
        eq(cards.conversationId, conversationId),
        sql`${cards.status} = 'pending'`,
        gt(cards.expiresAt, sql`now()`),
        notExists(
          db
            .select({ id: librarianOperations.id })
            .from(librarianOperations)
            .where(
              and(
                eq(librarianOperations.conversationId, cards.conversationId),
                eq(librarianOperations.segmentId, cards.segmentId),
                eq(librarianOperations.cardId, cards.id),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: librarianOperations.id })
            .from(librarianOperations)
            .where(
              and(
                eq(librarianOperations.conversationId, cards.conversationId),
                eq(librarianOperations.segmentId, cards.segmentId),
                eq(
                  librarianOperations.idempotencyKey,
                  sql`'card:' || ${cards.id}`,
                ),
              ),
            ),
        ),
      ),
    );
}

type Candidate = Awaited<ReturnType<typeof pendingCandidates>>[number];

function currentTarget(
  card: Candidate,
  proposal: LibrarianCardProposal,
  owner: ConfirmationOwner,
  access: Access,
  forgotten: ReadonlySet<string>,
): CardTarget | null {
  if (proposal.action === "memory_suggest") {
    if (
      owner.currentSegmentId !== card.segmentId ||
      owner.resetState !== "none" ||
      forgotten.has(memoryContentDigest(proposal.memory.content))
    )
      return null;
    const projectId = card.target.projectId;

    if (proposal.memory.scope === "project") {
      if (
        !projectId ||
        access.visible.get(projectId) !== proposal.memory.projectSlug
      )
        return null;
    }

    return {
      target: proposal.memory.scope === "project" ? { projectId } : {},
      revision: String(owner.contextEpoch),
    };
  }
  if (proposal.action === "statement_accept") {
    const task = card.task;

    if (
      task?.id !== proposal.taskId ||
      task.revision !== proposal.expectedRevision ||
      !access.actionable.has(task.projectId)
    )
      return null;

    return {
      target: { projectId: task.projectId, taskId: task.id },
      revision: String(task.revision),
    };
  }
  const run = card.run;

  if (
    run?.id !== proposal.runId ||
    !run.projectId ||
    !access.actionable.has(run.projectId)
  )
    return null;
  if (proposal.action === "hitl_respond") {
    const question = card.question;

    if (question?.id !== proposal.hitlRequestId || question.respondedAt)
      return null;

    return {
      target: {
        projectId: run.projectId,
        runId: run.id,
        hitlRequestId: question.id,
      },
      revision: hitlQuestionRevision(question),
    };
  }

  return runCardTarget(proposal, { ...run, projectId: run.projectId });
}

/** Uses the same scoped observation as the history page and its attention count. */
export async function readEligibleConfirmationIds(
  db: Db,
  owner: ConfirmationOwner,
  access?: Access,
): Promise<string[]> {
  const candidates = (await pendingCandidates(db, owner.id)).flatMap((card) => {
    const proposal = librarianCardProposalSchema.safeParse(card.payload);

    return proposal.success ? [{ card, proposal: proposal.data }] : [];
  });

  if (!candidates.length) return [];
  const digests = [
    ...new Set(
      candidates.flatMap(({ proposal }) =>
        proposal.action === "memory_suggest"
          ? [memoryContentDigest(proposal.memory.content)]
          : [],
      ),
    ),
  ];
  const [currentAccess, tombstones] = await Promise.all([
    access ?? readLibrarianProjectAccess(db, owner.userId),
    digests.length
      ? db
          .select({ digest: librarianMemoryTombstones.contentDigest })
          .from(librarianMemoryTombstones)
          .where(
            and(
              eq(librarianMemoryTombstones.userId, owner.userId),
              inArray(librarianMemoryTombstones.contentDigest, digests),
            ),
          )
      : [],
  ]);
  const forgotten = new Set(tombstones.map(({ digest }) => digest));

  return candidates.flatMap(({ card, proposal }) => {
    const target = currentTarget(
      card,
      proposal,
      owner,
      currentAccess,
      forgotten,
    );

    return target && matchesFrozenCardTarget(card, target) ? [card.id] : [];
  });
}

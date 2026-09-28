import "server-only";

import { desc, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  librarianCards,
  librarianConversations,
  librarianOperations,
  librarianTaskLinks,
  hitlRequests,
  runs,
  tasks,
  users,
  workspaces,
} from "@/lib/db/schema";
import { librarianCardProposalSchema } from "@/lib/librarian/cards";
import { getVisibleProjects } from "@/lib/queries/visible-projects";
import { renderStatementPrompt } from "@/lib/tasks/statement";

type Db = ReturnType<typeof getDb>;

export type LibrarianCardView = {
  id: string;
  kind: "statement_proposal" | "confirmation" | "memory_suggestion";
  status: string;
  action: string;
  target: Record<string, string>;
  targetRevision: string | null;
  payload: Record<string, unknown>;
  currentPrompt: string | null;
  proposedPrompt: string | null;
  hitlPrompt: string | null;
  runBranch: string | null;
  available: boolean;
  expiresAt: string;
};

export type LibrarianOperationView = {
  id: string;
  kind: string;
  status: string;
  result: Record<string, unknown> | null;
  liveRunStatus: string | null;
  taskPath: string | null;
  available: boolean;
  createdAt: string;
};

export type LibrarianRelatedTaskView = {
  taskId: string;
  meaning: string;
  fromMessageId: string | null;
  toMessageId: string | null;
  available: boolean;
  projectSlug: string | null;
  number: number | null;
  title: string | null;
  status: string | null;
};

export type LibrarianLinkedWork = {
  cards: LibrarianCardView[];
  operations: LibrarianOperationView[];
  tasks: LibrarianRelatedTaskView[];
};

const log = pino({
  name: "librarian.read-models",
  level: process.env.LOG_LEVEL ?? "info",
});

function resultBody(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return null;
  const body = (result as { body?: unknown }).body;

  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function resultRunId(result: unknown): string | null {
  const runId = resultBody(result)?.runId;

  return typeof runId === "string" ? runId : null;
}

export async function getLinkedWork(
  ownerId: string,
  db: Db = getDb(),
): Promise<LibrarianLinkedWork> {
  const [owner] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, ownerId));
  const [conversation] = await db
    .select({ id: librarianConversations.id })
    .from(librarianConversations)
    .where(eq(librarianConversations.userId, ownerId));

  if (!owner || !conversation) return { cards: [], operations: [], tasks: [] };
  const visibleProjects = await getVisibleProjects(
    ownerId,
    owner.role,
    db as never,
  );
  const visibleById = new Map(
    visibleProjects.map((project) => [project.id, project]),
  );
  const visibleSlugs = new Set(visibleProjects.map((project) => project.slug));
  const [cardRows, operationRows, linkRows] = await Promise.all([
    db
      .select()
      .from(librarianCards)
      .where(eq(librarianCards.conversationId, conversation.id))
      .orderBy(desc(librarianCards.createdAt))
      .limit(50),
    db
      .select()
      .from(librarianOperations)
      .where(eq(librarianOperations.conversationId, conversation.id))
      .orderBy(desc(librarianOperations.createdAt))
      .limit(50),
    db
      .select()
      .from(librarianTaskLinks)
      .where(eq(librarianTaskLinks.conversationId, conversation.id))
      .orderBy(desc(librarianTaskLinks.createdAt))
      .limit(100),
  ]);
  const taskIds = [
    ...new Set([
      ...linkRows.map((link) => link.taskId),
      ...cardRows
        .map((card) => card.target.taskId)
        .filter((id): id is string => typeof id === "string"),
      ...operationRows
        .flatMap((operation) => [
          operation.target.taskId,
          resultBody(operation.result)?.taskId,
        ])
        .filter((id): id is string => typeof id === "string"),
    ]),
  ];
  const runIds = [
    ...new Set(
      [
        ...operationRows.map((operation) => resultRunId(operation.result)),
        ...operationRows.map((operation) => operation.target.runId),
        ...cardRows.map((card) => card.target.runId),
      ].filter((id): id is string => typeof id === "string"),
    ),
  ];
  const hitlIds = [
    ...new Set(
      cardRows
        .map((card) => card.target.hitlRequestId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const [taskRows, runRows, workspaceRows, hitlRows] = await Promise.all([
    taskIds.length > 0
      ? db
          .select({
            id: tasks.id,
            projectId: tasks.projectId,
            number: tasks.number,
            title: tasks.title,
            status: tasks.status,
            prompt: tasks.prompt,
          })
          .from(tasks)
          .where(inArray(tasks.id, taskIds))
      : Promise.resolve([]),
    runIds.length > 0
      ? db
          .select({
            id: runs.id,
            projectId: runs.projectId,
            status: runs.status,
          })
          .from(runs)
          .where(inArray(runs.id, runIds))
      : Promise.resolve([]),
    runIds.length > 0
      ? db
          .select({ runId: workspaces.runId, branch: workspaces.branch })
          .from(workspaces)
          .where(inArray(workspaces.runId, runIds))
      : Promise.resolve([]),
    hitlIds.length > 0
      ? db
          .select({ id: hitlRequests.id, prompt: hitlRequests.prompt })
          .from(hitlRequests)
          .where(inArray(hitlRequests.id, hitlIds))
      : Promise.resolve([]),
  ]);
  const taskById = new Map(taskRows.map((task) => [task.id, task]));
  const runById = new Map(runRows.map((run) => [run.id, run]));
  const workspaceByRunId = new Map(
    workspaceRows.map((workspace) => [workspace.runId, workspace]),
  );
  const hitlById = new Map(hitlRows.map((question) => [question.id, question]));
  const cards = cardRows.map((card): LibrarianCardView => {
    const parsed = librarianCardProposalSchema.safeParse(card.payload);
    const task = card.target.taskId ? taskById.get(card.target.taskId) : null;
    const projectId = card.target.projectId;
    const available =
      (card.kind === "memory_suggestion" && !projectId
        ? true
        : visibleById.has(projectId)) &&
      (card.target.taskId
        ? !!task
        : card.target.runId
          ? !!runById.get(card.target.runId)
          : true);

    return {
      id: card.id,
      kind: card.kind,
      status:
        card.status === "pending" && card.expiresAt <= new Date()
          ? "expired"
          : card.status,
      action: parsed.success ? parsed.data.action : "unavailable",
      target: available ? card.target : {},
      targetRevision: available ? card.targetRevision : null,
      payload: available ? card.payload : {},
      currentPrompt: available && task ? task.prompt : null,
      proposedPrompt:
        available && parsed.success && parsed.data.action === "statement_accept"
          ? renderStatementPrompt(parsed.data.statement)
          : null,
      hitlPrompt:
        available && card.target.hitlRequestId
          ? (hitlById.get(card.target.hitlRequestId)?.prompt ?? null)
          : null,
      runBranch:
        available && card.target.runId
          ? (workspaceByRunId.get(card.target.runId)?.branch ?? null)
          : null,
      available,
      expiresAt: card.expiresAt.toISOString(),
    };
  });
  const operations = operationRows.map((operation): LibrarianOperationView => {
    const body = resultBody(operation.result);
    const runId = operation.target.runId ?? resultRunId(operation.result);
    const run = runId ? runById.get(runId) : null;
    const taskId =
      operation.target.taskId ??
      (typeof body?.taskId === "string" ? body.taskId : null);
    const task = taskId ? taskById.get(taskId) : null;
    const taskProject = task ? visibleById.get(task.projectId) : null;
    const targetProjectId =
      operation.target.projectId ?? run?.projectId ?? task?.projectId ?? null;
    const available =
      (!taskId || !!task) &&
      (!runId || !!run) &&
      (targetProjectId === null || visibleById.has(targetProjectId)) &&
      (!operation.target.slug || visibleSlugs.has(operation.target.slug));

    return {
      id: operation.id,
      kind: operation.kind,
      status: operation.status,
      result: available ? body : null,
      liveRunStatus: available && run ? run.status : null,
      taskPath:
        available && task && taskProject
          ? `/projects/${taskProject.slug}/tasks/${task.number}`
          : null,
      available,
      createdAt: operation.createdAt.toISOString(),
    };
  });
  const linkedTasks = linkRows.map((link): LibrarianRelatedTaskView => {
    const task = taskById.get(link.taskId);
    const project = task ? visibleById.get(task.projectId) : null;

    return {
      taskId: link.taskId,
      meaning: link.meaning,
      fromMessageId: link.fromMessageId,
      toMessageId: link.toMessageId,
      available: !!task && !!project,
      projectSlug: project?.slug ?? null,
      number: project ? (task?.number ?? null) : null,
      title: project ? (task?.title ?? null) : null,
      status: project ? (task?.status ?? null) : null,
    };
  });

  log.debug(
    {
      ownerId,
      cards: cards.length,
      operations: operations.length,
      tasks: linkedTasks.length,
    },
    "linked work loaded",
  );

  return { cards, operations, tasks: linkedTasks };
}

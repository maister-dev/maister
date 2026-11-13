import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LibrarianCardView } from "./read-models";
import type { LibrarianCardProposal } from "./cards";
import type { LibrarianMessageDto } from "./view";

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { librarianCardProposalSchema } from "./cards";

import {
  librarianConversations,
  hitlRequests,
  projects,
  runs,
  taskActivity,
  tasks,
  users,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  getActionableProjectIds,
  getVisibleProjects,
} from "@/lib/queries/visible-projects";
import { renderStatementPrompt } from "@/lib/tasks/statement";

const collections = ["actions", "tasks", "attention"] as const;

export type HistoryCollection = (typeof collections)[number];
export type HistoryTarget =
  | { state: "visible"; href: string; label: string; title?: string }
  | { state: "unavailable" };
export type HistoryItem = {
  id: string;
  sourceKind: "operation" | "card" | "task";
  kind: string;
  outcome: string;
  createdAt: string;
  settledAt: string | null;
  targets: HistoryTarget[];
  confirmation?: LibrarianCardView;
};
export type ActionHistoryPage = {
  historyGeneration: number | null;
  items: HistoryItem[];
  nextCursor: string | null;
};
export type WorkAttention = { count: number; items: HistoryItem[] };
export type ReceiptAttachments = Record<string, HistoryItem[]>;

const limitDefault = 20;
const cursorShape = z
  .object({
    version: z.literal(1),
    collection: z.enum(collections),
    conversation: z.string().min(1).max(128),
    generation: z.number().int().nonnegative(),
    time: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
      .refine((value) => Number.isFinite(Date.parse(value))),
    source: z.enum(["operation", "card", "task"]),
    id: z.string().min(1).max(256),
  })
  .strict();

type Cursor = z.infer<typeof cursorShape>;

function invalidQuery(): never {
  throw new MaisterError("CONFIG", "Invalid Action history selection.");
}

export function parseActionHistoryQuery(search: URLSearchParams): {
  collection: HistoryCollection;
  limit: number;
  cursor: Cursor | null;
} {
  for (const key of search.keys())
    if (
      !["collection", "limit", "cursor"].includes(key) ||
      search.getAll(key).length !== 1
    )
      invalidQuery();
  const collection = z
    .enum(collections)
    .safeParse(search.get("collection") ?? "actions");
  const limitText = search.get("limit") ?? String(limitDefault);
  const limit = Number(limitText);
  const encoded = search.get("cursor");
  let cursor: Cursor | null = null;

  if (!collection.success || !/^[1-9][0-9]?$/.test(limitText) || limit > 50)
    return invalidQuery();
  if (encoded !== null) {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(encoded)) return invalidQuery();
    try {
      const parsed = cursorShape.safeParse(
        JSON.parse(
          Buffer.from(encoded, "base64url").toString("utf8"),
        ) as unknown,
      );

      if (!parsed.success || parsed.data.collection !== collection.data)
        return invalidQuery();
      cursor = parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) return invalidQuery();
      throw error;
    }
  }

  return { collection: collection.data, limit, cursor };
}

export async function readHistoryOwner(db: Db, owner: string) {
  const [conversation] = await db
    .select()
    .from(librarianConversations)
    .where(eq(librarianConversations.userId, owner));

  return conversation ?? null;
}

type Owner = NonNullable<Awaited<ReturnType<typeof readHistoryOwner>>>;
type HistoryRow = {
  id: string;
  source_kind: HistoryItem["sourceKind"];
  kind: string;
  outcome: string;
  created_at: string;
  settled_at: string | null;
  target: Record<string, unknown>;
  result: Record<string, unknown> | null;
  attachment: string | null;
  confirmation: Record<string, unknown> | null;
  target_revision: string | null;
  expires_at: string | null;
  total: number;
};

const utc = (column: string) =>
  sql.raw(
    `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  );
const present = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const unavailable: HistoryTarget = { state: "unavailable" };

function workRows(
  conversation: Owner,
  projectIds: readonly string[],
  collection: HistoryCollection,
  page?: { cursor: Cursor | null; size: number },
) {
  const conversationId = conversation.id;
  const descending = collection !== "attention";
  const direction = descending ? sql`DESC NULLS LAST` : sql`ASC NULLS FIRST`;
  const comparison = descending ? sql`<` : sql`>`;
  const pageSource = (
    source: HistoryItem["sourceKind"],
    alias: "o" | "c" | "l",
  ) => {
    if (!page) return sql``;
    const created = sql.raw(`${alias}.created_at`);
    const id = sql.raw(`${alias}.id`);
    const cursor = page.cursor;
    const boundary = cursor
      ? source === cursor.source
        ? sql`AND (${created}, ${id}) ${comparison} (${cursor.time}::timestamptz, ${cursor.id})`
        : (descending ? source < cursor.source : source > cursor.source)
          ? sql`AND ${created} ${descending ? sql`<=` : sql`>=`} ${cursor.time}::timestamptz`
          : sql`AND ${created} ${comparison} ${cursor.time}::timestamptz`
      : sql``;

    return sql`${boundary} ORDER BY ${created} ${direction}, ${id} ${direction} LIMIT ${page.size}`;
  };
  const actionable = sql`ARRAY[${sql.join(
    projectIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;
  const operationRows = sql`
    SELECT o.id, 'operation'::text AS source_kind, o.kind, o.status AS outcome,
           o.created_at, o.settled_at, o.target, o.result, o.segment_id,
           CASE WHEN paired.id IS NOT NULL THEN card_message.id
                WHEN o.card_id IS NULL AND o.idempotency_key NOT LIKE 'card:%' THEN coalesce(reply.id, trigger.id)
           END AS attachment,
           NULL::jsonb AS confirmation, NULL::text AS target_revision, NULL::timestamptz AS expires_at
      FROM librarian_operations o
      LEFT JOIN librarian_cards paired ON paired.conversation_id = o.conversation_id AND paired.segment_id = o.segment_id
        AND paired.id = coalesce(o.card_id, CASE WHEN o.idempotency_key LIKE 'card:%' THEN substring(o.idempotency_key FROM 6) END)
      LEFT JOIN librarian_messages card_message ON card_message.id = paired.message_id AND card_message.conversation_id = o.conversation_id AND card_message.segment_id = o.segment_id
      LEFT JOIN librarian_turns turn ON turn.id = o.turn_id AND turn.conversation_id = o.conversation_id AND turn.segment_id = o.segment_id
      LEFT JOIN librarian_messages trigger ON trigger.id = turn.message_id AND trigger.conversation_id = o.conversation_id AND trigger.segment_id = o.segment_id
      LEFT JOIN LATERAL (
        SELECT m.id FROM librarian_messages m
         WHERE m.conversation_id = o.conversation_id AND m.segment_id = o.segment_id AND m.turn_id = turn.id AND m.author_kind = 'librarian'
         ORDER BY m.seq DESC LIMIT 1
      ) reply ON true
     WHERE o.conversation_id = ${conversationId}
       ${collection === "attention" ? sql`AND o.status IN ('admitted','unknown')` : sql``}
       ${pageSource("operation", "o")}`;
  const cardRows = sql`
    SELECT c.id, 'card'::text AS source_kind, coalesce(c.payload->>'action', c.kind) AS kind,
           CASE WHEN c.status = 'pending' AND c.expires_at <= now() THEN 'expired' ELSE c.status END AS outcome,
           c.created_at, c.decided_at AS settled_at, c.target, NULL::jsonb AS result, c.segment_id,
           m.id AS attachment,
           CASE WHEN c.status = 'pending' AND c.expires_at > now()
             AND (c.segment_id = ${conversation.currentSegmentId} OR c.kind <> 'memory_suggestion')
             AND (NOT (c.target ? 'taskId') OR (target_task.project_id = c.target->>'projectId' AND target_task.revision::text = c.target_revision))
             AND (NOT (c.target ? 'runId') OR target_run.project_id = c.target->>'projectId')
             AND (NOT (c.target ? 'hitlRequestId') OR (target_hitl.id IS NOT NULL AND target_hitl.responded_at IS NULL))
             AND CASE c.payload->>'action'
                   WHEN 'run_promote' THEN c.target_revision = target_run.status || ':' || (c.payload->>'reviewedTargetCommit') AND target_run.status = 'Review'
                   WHEN 'run_discard' THEN c.target_revision = target_run.status
                   ELSE true
                 END
             THEN c.payload END AS confirmation,
           c.target_revision, c.expires_at
      FROM librarian_cards c
      LEFT JOIN librarian_messages m ON m.id = c.message_id AND m.conversation_id = c.conversation_id AND m.segment_id = c.segment_id
      LEFT JOIN tasks target_task ON target_task.id = c.target->>'taskId'
      LEFT JOIN runs target_run ON target_run.id = c.target->>'runId'
      LEFT JOIN hitl_requests target_hitl ON target_hitl.id = c.target->>'hitlRequestId' AND target_hitl.run_id = target_run.id
     WHERE c.conversation_id = ${conversationId}
       AND NOT EXISTS (
         SELECT 1 FROM librarian_operations o WHERE o.conversation_id = c.conversation_id AND o.segment_id = c.segment_id
           AND o.idempotency_key = 'card:' || c.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM librarian_operations o WHERE o.conversation_id = c.conversation_id AND o.segment_id = c.segment_id
           AND o.card_id = c.id
       )
       ${
         collection === "attention"
           ? sql`
         AND c.status = 'pending' AND c.expires_at > now()
         AND (
           (c.kind = 'memory_suggestion' AND NOT (c.target ? 'projectId'))
           OR (c.target->>'projectId') = ANY(${actionable})
         )
         AND (NOT (c.target ? 'taskId') OR (target_task.project_id = c.target->>'projectId'
           AND target_task.revision::text = c.target_revision))
         AND (NOT (c.target ? 'runId') OR target_run.project_id = c.target->>'projectId')
         AND (NOT (c.target ? 'hitlRequestId') OR (target_hitl.id IS NOT NULL AND target_hitl.responded_at IS NULL))
         AND CASE c.payload->>'action'
               WHEN 'run_promote' THEN c.target_revision = target_run.status || ':' || (c.payload->>'reviewedTargetCommit') AND target_run.status = 'Review'
               WHEN 'run_discard' THEN c.target_revision = target_run.status
               WHEN 'memory_suggest' THEN c.segment_id = ${conversation.currentSegmentId}
               ELSE true
             END
       `
           : sql``
       }
       ${pageSource("card", "c")}`;
  const taskRows = sql`
    SELECT l.id, 'task'::text AS source_kind, l.meaning AS kind, 'linked'::text AS outcome,
           l.created_at, NULL::timestamptz AS settled_at, jsonb_build_object('taskId',l.task_id) AS target,
           NULL::jsonb AS result,
           CASE WHEN a.id IS NULL OR b.id IS NULL OR a.segment_id = b.segment_id THEN coalesce(b.segment_id,a.segment_id) END AS segment_id,
           CASE WHEN a.id IS NULL OR b.id IS NULL OR a.segment_id = b.segment_id THEN coalesce(b.id,a.id) END AS attachment,
           NULL::jsonb AS confirmation, NULL::text AS target_revision, NULL::timestamptz AS expires_at
      FROM librarian_task_links l
      LEFT JOIN librarian_messages a ON a.id=l.from_message_id AND a.conversation_id=l.conversation_id
      LEFT JOIN librarian_messages b ON b.id=l.to_message_id AND b.conversation_id=l.conversation_id
     WHERE l.conversation_id = ${conversationId}
     ${pageSource("task", "l")}`;

  return collection === "tasks"
    ? taskRows
    : sql`(${operationRows}) UNION ALL (${cardRows})`;
}

async function grants(db: Db, ownerId: string) {
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
    actionable,
  };
}

function textAt(
  object: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = object?.[key];

  return present(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function matchesCardTarget(
  proposal: LibrarianCardProposal,
  target: HistoryRow["target"],
  projectSlug: string | undefined,
): boolean {
  switch (proposal.action) {
    case "memory_suggest":
      return proposal.memory.scope === "general"
        ? !textAt(target, "projectId")
        : projectSlug !== undefined &&
            proposal.memory.projectSlug === projectSlug;
    case "statement_accept":
      return proposal.taskId === textAt(target, "taskId");
    case "hitl_respond":
      return (
        proposal.runId === textAt(target, "runId") &&
        proposal.hitlRequestId === textAt(target, "hitlRequestId")
      );
    case "run_discard":
    case "run_promote":
      return proposal.runId === textAt(target, "runId");
  }
}

async function presentRows(
  db: Db,
  rows: HistoryRow[],
  access: Awaited<ReturnType<typeof grants>>,
): Promise<HistoryItem[]> {
  const relations = rows.filter(
    (row) =>
      row.source_kind === "operation" &&
      ["relation_add", "relation_remove"].includes(row.kind),
  );
  const relationSources = [
    ...new Set(
      relations.map((row) => textAt(row.target, "taskId")).filter(present),
    ),
  ];
  const activityRows = relationSources.length
    ? await db
        .select({ payload: taskActivity.payload, taskId: taskActivity.taskId })
        .from(taskActivity)
        .where(
          and(
            inArray(taskActivity.taskId, relationSources),
            inArray(taskActivity.eventKind, [
              "relation_added",
              "relation_removed",
            ]),
            inArray(
              sql<string>`${taskActivity.payload}->>'viaOperationId'`,
              relations.map((row) => row.id),
            ),
          ),
        )
    : [];
  const verified = new Map(
    activityRows.flatMap((row) => {
      const key = textAt(row.payload, "viaOperationId");

      return key && row.taskId === textAt(row.payload, "fromTaskId")
        ? [[key, row.payload] as const]
        : [];
    }),
  );
  const identities = rows.map((row) => {
    const body = record(row.result?.body);
    const nested = record(body?.result);
    const relation = relations.includes(row);
    const provenance = record(row.result?.relationProvenance);
    const source =
      textAt(row.target, "taskId") ??
      textAt(body, "taskId") ??
      textAt(nested, "taskId");
    const counterpart =
      relation && source
        ? textAt(
            textAt(provenance, "fromTaskId") === source
              ? provenance
              : verified.get(row.id),
            "toTaskId",
          )
        : null;

    return {
      row,
      taskIds: [...new Set([source, counterpart].filter(present))],
      runId:
        textAt(row.target, "runId") ??
        textAt(body, "runId") ??
        textAt(nested, "runId"),
      relation,
    };
  });
  const taskIds = [...new Set(identities.flatMap((item) => item.taskIds))];
  const runIds = [
    ...new Set(identities.map((item) => item.runId).filter(present)),
  ];
  const hitlIds = [
    ...new Set(
      rows.map((row) => textAt(row.target, "hitlRequestId")).filter(present),
    ),
  ];
  const [taskRows, runRows, questions] = await Promise.all([
    taskIds.length
      ? db
          .select({
            id: tasks.id,
            projectId: tasks.projectId,
            number: tasks.number,
            title: tasks.title,
            prompt: tasks.prompt,
            slug: projects.slug,
            taskKey: projects.taskKey,
          })
          .from(tasks)
          .innerJoin(projects, eq(projects.id, tasks.projectId))
          .where(inArray(tasks.id, taskIds))
      : [],
    runIds.length
      ? db
          .select({
            id: runs.id,
            projectId: runs.projectId,
            kind: runs.runKind,
          })
          .from(runs)
          .where(inArray(runs.id, runIds))
      : [],
    hitlIds.length
      ? db
          .select({
            id: hitlRequests.id,
            runId: hitlRequests.runId,
            prompt: hitlRequests.prompt,
          })
          .from(hitlRequests)
          .where(inArray(hitlRequests.id, hitlIds))
      : [],
  ]);
  const questionById = new Map(
    questions.map((question) => [question.id, question]),
  );
  const taskById = new Map(taskRows.map((task) => [task.id, task]));
  const runById = new Map(runRows.map((run) => [run.id, run]));

  return identities.map(({ row, taskIds: ids, runId, relation }) => {
    const targets: HistoryTarget[] = ids.map((id) => {
      const task = taskById.get(id);

      return task && access.visible.has(task.projectId)
        ? {
            state: "visible",
            href: `/projects/${encodeURIComponent(task.slug)}/tasks/${task.number}`,
            label: `${task.taskKey}-${task.number}`,
            title: task.title,
          }
        : unavailable;
    });
    const run = runId ? runById.get(runId) : undefined;

    if (runId && targets.length < 2)
      targets.push(
        run?.projectId && access.visible.has(run.projectId)
          ? {
              state: "visible",
              href: `/${run.kind === "scratch" ? "scratch-runs" : "runs"}/${encodeURIComponent(run.id)}`,
              label: run.id.slice(0, 8),
            }
          : unavailable,
      );
    if (
      (relation && ids.length < 2) ||
      (targets.length === 0 && row.source_kind !== "card")
    )
      targets.push(unavailable);
    const item: HistoryItem = {
      id: row.id,
      sourceKind: row.source_kind,
      kind: row.kind,
      outcome: row.outcome,
      createdAt: row.created_at,
      settledAt: row.settled_at,
      targets: targets.slice(0, 2),
    };
    const proposal = librarianCardProposalSchema.safeParse(row.confirmation);
    const project = textAt(row.target, "projectId");

    if (
      row.source_kind === "card" &&
      row.outcome === "pending" &&
      row.expires_at &&
      proposal.success &&
      matchesCardTarget(
        proposal.data,
        row.target,
        project ? access.visible.get(project) : undefined,
      ) &&
      (project
        ? access.actionable.includes(project)
        : proposal.data.action === "memory_suggest") &&
      targets.every((target) => target.state === "visible")
    ) {
      const task = ids[0] ? taskById.get(ids[0]) : undefined;
      const action = proposal.data.action;
      const kind =
        action === "statement_accept"
          ? "statement_proposal"
          : action === "memory_suggest"
            ? "memory_suggestion"
            : "confirmation";

      const hitlId = textAt(row.target, "hitlRequestId");
      const question = hitlId ? questionById.get(hitlId) : undefined;

      item.confirmation = {
        id: row.id,
        kind,
        status: "pending",
        action,
        available: true,
        target:
          run && run.projectId && access.visible.has(run.projectId)
            ? { runId: run.id }
            : {},
        targetRevision: row.target_revision,
        payload: proposal.data,
        currentPrompt: task?.prompt ?? null,
        proposedPrompt:
          proposal.data.action === "statement_accept"
            ? renderStatementPrompt(proposal.data.statement)
            : null,
        hitlPrompt:
          question?.runId === run?.id ? (question?.prompt ?? null) : null,
        runBranch: null,
        expiresAt: row.expires_at,
      };
    }

    return item;
  });
}

function readRows(
  db: Db,
  source: ReturnType<typeof workRows>,
  where: ReturnType<typeof sql>,
  order: "asc" | "desc",
  limit: number,
  total: ReturnType<typeof sql> = sql`0`,
) {
  const direction = order === "asc" ? sql`ASC` : sql`DESC`;

  return db
    .execute<HistoryRow>(
      sql`
    WITH work AS (${source})
    SELECT id, source_kind, kind, outcome, ${utc("created_at")} AS created_at,
      ${utc("settled_at")} AS settled_at, target, result, attachment,
      confirmation, target_revision, ${utc("expires_at")} AS expires_at, ${total} AS total
      FROM work WHERE ${where}
      ORDER BY work.created_at ${direction}, source_kind ${direction}, id ${direction}
      LIMIT ${limit}
  `,
    )
    .then((result) => result.rows);
}

export async function readActionHistory(
  db: Db,
  ownerId: string,
  query: ReturnType<typeof parseActionHistoryQuery>,
): Promise<ActionHistoryPage> {
  return db.transaction(
    async (tx) => {
      const conversation = await readHistoryOwner(tx, ownerId);
      const { cursor, collection, limit } = query;

      if (cursor && cursor.conversation !== conversation?.id)
        throw new MaisterError(
          "PRECONDITION",
          "Action history is unavailable.",
          { details: { reason: "not_found" } },
        );
      if (!conversation)
        return { historyGeneration: null, items: [], nextCursor: null };
      if (cursor && cursor.generation !== conversation.historyGeneration)
        throw new MaisterError(
          "CONFLICT",
          "Action history changed. Reload its first page.",
          { details: { reason: "history_generation_changed" } },
        );
      const access = await grants(tx, ownerId);
      const ascending = collection === "attention";
      const source = workRows(conversation, access.actionable, collection, {
        cursor,
        size: limit + 1,
      });
      const rows = await readRows(
        tx,
        source,
        sql`true`,
        ascending ? "asc" : "desc",
        limit + 1,
      );
      const selected = rows.slice(0, limit);
      const last = selected.at(-1);
      const next: Cursor | null =
        rows.length > limit && last
          ? {
              version: 1,
              collection,
              conversation: conversation.id,
              generation: conversation.historyGeneration,
              time: last.created_at,
              source: last.source_kind,
              id: last.id,
            }
          : null;

      return {
        historyGeneration: conversation.historyGeneration,
        items: await presentRows(tx, selected, access),
        nextCursor: next
          ? Buffer.from(JSON.stringify(next)).toString("base64url")
          : null,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function readCurrentWork(
  db: Db,
  ownerId: string,
  conversation: Owner,
): Promise<{ currentWork: HistoryItem[]; attention: WorkAttention }> {
  const access = await grants(db, ownerId);
  const [tasks, attention] = await Promise.all([
    readRows(
      db,
      workRows(conversation, access.actionable, "tasks"),
      sql`segment_id = ${conversation.currentSegmentId}`,
      "desc",
      limitDefault,
    ),
    readRows(
      db,
      workRows(conversation, access.actionable, "attention"),
      sql`true`,
      "asc",
      limitDefault,
      sql`count(*) OVER()::int`,
    ),
  ]);

  return {
    currentWork: await presentRows(db, tasks, access),
    attention: {
      count: attention[0]?.total ?? 0,
      items: await presentRows(db, attention, access),
    },
  };
}

export async function readReceiptAttachments(
  db: Db,
  ownerId: string,
  conversation: Owner,
  messages: LibrarianMessageDto[],
): Promise<ReceiptAttachments> {
  const ids = messages
    .filter(
      (message) =>
        message.segmentId === conversation.currentSegmentId && !message.masked,
    )
    .map((message) => message.id);

  if (!ids.length) return {};
  const access = await grants(db, ownerId);
  const source = workRows(conversation, access.actionable, "actions");
  const { rows } = await db.execute<HistoryRow>(sql`
    WITH work AS (${source}), ranked AS (
      SELECT work.*, row_number() OVER (PARTITION BY attachment ORDER BY created_at DESC, source_kind DESC, id DESC) AS rank
        FROM work WHERE segment_id = ${conversation.currentSegmentId}
         AND attachment IN (${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )})
         AND outcome NOT IN ('pending','admitted','unknown')
    )
    SELECT id, source_kind, kind, outcome, ${utc("created_at")} AS created_at,
      ${utc("settled_at")} AS settled_at, target, result, attachment,
      confirmation, target_revision, ${utc("expires_at")} AS expires_at, 0 AS total
      FROM ranked WHERE rank <= 10 ORDER BY attachment, rank
  `);
  const projected = await presentRows(db, rows, access);
  const attached: ReceiptAttachments = {};

  for (const [index, row] of rows.entries()) {
    if (row.attachment)
      (attached[row.attachment] ??= []).push(projected[index]);
  }

  return attached;
}

import "server-only";

import type { GlobalRole } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { getVisibleProjectIds } from "@/lib/queries/visible-projects";

const { projects, tasks } = schema;

const log = pino({
  name: "librarian.search",
  level: process.env.LOG_LEVEL ?? "info",
});

export const TASK_SEARCH_PAGE_SIZE = 25;
export const TASK_SEARCH_QUERY_MAX = 200;

export interface TaskSearchHit {
  taskId: string;
  key: string;
  number: number;
  title: string;
  status: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  updatedAt: Date;
  matchedIn: ("key" | "title" | "prompt")[];
}

export interface TaskSearchResult {
  tasks: TaskSearchHit[];
  // There are more matches past this page; the caller must page or narrow the
  // query rather than reason from a partial list as if it were complete.
  truncated: boolean;
  nextCursor: string | null;
  projectCount: number;
}

type Cursor = { updatedAt: string; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<Cursor>;

    if (
      typeof parsed.updatedAt === "string" &&
      !Number.isNaN(Date.parse(parsed.updatedAt)) &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0
    ) {
      return { updatedAt: parsed.updatedAt, id: parsed.id };
    }
  } catch {
    // fall through to the typed refusal
  }

  throw new MaisterError("CONFIG", "invalid search cursor");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// `KEY-12` (or a bare `12`) addresses a task by its board identity.
function parseTaskRef(
  q: string,
): { key: string | null; number: number } | null {
  const match = /^(?:([A-Za-z][A-Za-z0-9]*)-)?(\d{1,9})$/.exec(q.trim());

  if (!match) return null;

  return { key: match[1]?.toUpperCase() ?? null, number: Number(match[2]) };
}

/**
 * Title / prompt / key search over the tasks of the reader's visible projects
 * (ADR-184 LAU-06). Visibility is resolved FIRST and bounds the query, so a
 * task in a project the reader cannot see is never selected, counted or paged
 * over. Ordered by `updated_at DESC, id DESC` with an opaque keyset cursor.
 */
export async function searchVisibleTasks(
  user: { id: string; role: GlobalRole },
  input: { q: string; cursor?: string | null },
  client: NodePgDatabase<typeof schema> = getDb() as NodePgDatabase<
    typeof schema
  >,
): Promise<TaskSearchResult> {
  const q = input.q.trim();

  if (q.length === 0 || q.length > TASK_SEARCH_QUERY_MAX) {
    throw new MaisterError(
      "CONFIG",
      `q must be 1..${TASK_SEARCH_QUERY_MAX} characters`,
    );
  }

  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const projectIds = await getVisibleProjectIds(user.id, user.role, client);

  if (projectIds.length === 0) {
    return { tasks: [], truncated: false, nextCursor: null, projectCount: 0 };
  }

  const pattern = `%${escapeLike(q)}%`;
  const ref = parseTaskRef(q);
  const keyMatch = ref
    ? ref.key === null
      ? eq(tasks.number, ref.number)
      : and(eq(tasks.number, ref.number), eq(projects.taskKey, ref.key))
    : undefined;
  const textMatch = or(
    ilike(tasks.title, pattern),
    ilike(tasks.prompt, pattern),
  );
  const match = keyMatch ? or(keyMatch, textMatch) : textMatch;

  const rows = await client
    .select({
      taskId: tasks.id,
      number: tasks.number,
      title: tasks.title,
      prompt: tasks.prompt,
      status: tasks.status,
      updatedAt: tasks.updatedAt,
      projectId: projects.id,
      projectSlug: projects.slug,
      projectName: projects.name,
      taskKey: projects.taskKey,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(
      and(
        inArray(tasks.projectId, projectIds),
        match,
        cursor
          ? or(
              lt(tasks.updatedAt, new Date(cursor.updatedAt)),
              and(
                eq(tasks.updatedAt, new Date(cursor.updatedAt)),
                sql`${tasks.id} < ${cursor.id}`,
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(tasks.updatedAt), desc(tasks.id))
    .limit(TASK_SEARCH_PAGE_SIZE + 1);

  const page = rows.slice(0, TASK_SEARCH_PAGE_SIZE);
  const truncated = rows.length > TASK_SEARCH_PAGE_SIZE;
  const needle = q.toLowerCase();
  const hits: TaskSearchHit[] = page.map((row) => {
    const key = `${row.taskKey}-${row.number}`;
    const matchedIn: TaskSearchHit["matchedIn"] = [];

    if (
      ref &&
      row.number === ref.number &&
      (ref.key === null || ref.key === row.taskKey)
    ) {
      matchedIn.push("key");
    }
    if (row.title.toLowerCase().includes(needle)) matchedIn.push("title");
    if (row.prompt.toLowerCase().includes(needle)) matchedIn.push("prompt");

    return {
      taskId: row.taskId,
      key,
      number: row.number,
      title: row.title,
      status: row.status,
      projectId: row.projectId,
      projectSlug: row.projectSlug,
      projectName: row.projectName,
      updatedAt: row.updatedAt,
      matchedIn,
    };
  });
  const last = page.at(-1);
  const nextCursor =
    truncated && last
      ? encodeCursor({
          updatedAt: last.updatedAt.toISOString(),
          id: last.taskId,
        })
      : null;

  log.debug(
    {
      userId: user.id,
      visibleProjects: projectIds.length,
      rows: hits.length,
      truncated,
    },
    "task search",
  );

  return {
    tasks: hits,
    truncated,
    nextCursor,
    projectCount: projectIds.length,
  };
}

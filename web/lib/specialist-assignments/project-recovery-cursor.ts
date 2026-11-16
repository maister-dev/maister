import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import {
  DEFAULT_AUTO_LAUNCH_TRIAGED_JOB_ID,
  ensureDefaultAutoLaunchTriagedJob,
} from "@/lib/scheduler/jobs";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "project-assignment-recovery-cursor",
  level: process.env.LOG_LEVEL ?? "info",
});

export const PROJECT_RECOVERY_PAGE_SIZE = 100;
const positionSchema = z
  .object({
    createdAt: z
      .string()
      .datetime()
      .regex(/\.\d{6}Z$/),
    id: z.string().min(1).max(128),
  })
  .strict();
const cursorSchema = z
  .object({
    revision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    after: positionSchema.nullable(),
    through: positionSchema.nullable(),
  })
  .strict()
  .refine((cursor) => cursor.after === null || cursor.through !== null);

type RecoveryCursorValue = z.infer<typeof cursorSchema>;
type RecoveryPosition = z.infer<typeof positionSchema>;
export type ProjectRecoveryCursor = Readonly<{
  key: "projectIntakeRecoveryCursor" | "projectQualifiedResumeCursor";
  value: RecoveryCursorValue | null;
  through: RecoveryPosition | null;
}>;

/** A frozen upper bound forces rotation even while new intake continually extends the queue. */
export function projectRecoveryHeadBounds(cursor: ProjectRecoveryCursor): SQL {
  const after = cursor.value?.after;
  const through = cursor.through;

  if (!through) return sql`false`;

  return sql`(head.created_at,head.id)<=(${through.createdAt}::timestamptz,${through.id})
    ${after ? sql`AND (head.created_at,head.id)>(${after.createdAt}::timestamptz,${after.id})` : sql``}`;
}

async function currentProjectRecoveryHighWater(
  db: Db,
): Promise<RecoveryPosition | null> {
  const row = (
    await db.execute(sql`
      SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
      FROM specialist_assignments
      WHERE project_id IS NOT NULL AND company_id IS NULL
      ORDER BY created_at DESC,id DESC LIMIT 1
    `)
  ).rows[0];

  if (!row) return null;
  const parsed = positionSchema.safeParse(row);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The project recovery high-water position is invalid",
    );

  return parsed.data;
}

/** Independent versioned cursors share the existing job target without holding its row lock over work. */
export async function readProjectRecoveryCursor(
  db: Db,
  key: ProjectRecoveryCursor["key"],
): Promise<ProjectRecoveryCursor> {
  await ensureDefaultAutoLaunchTriagedJob({ db });
  const row = (
    await db.execute(
      sql`SELECT target->${key} AS cursor FROM scheduler_jobs WHERE id=${DEFAULT_AUTO_LAUNCH_TRIAGED_JOB_ID}`,
    )
  ).rows[0];

  if (!row)
    throw new MaisterError(
      "CONFIG",
      "The project recovery scheduler job is unavailable",
    );
  if (row.cursor === null)
    return {
      key,
      value: null,
      through: await currentProjectRecoveryHighWater(db),
    };
  const parsed = cursorSchema.safeParse(row.cursor);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The project recovery cursor is malformed",
      {
        details: { reason: "project_recovery_cursor_invalid", cursorKey: key },
      },
    );

  return {
    key,
    value: parsed.data,
    through:
      parsed.data.after === null
        ? await currentProjectRecoveryHighWater(db)
        : parsed.data.through,
  };
}

/** Revision CAS also fences a stale scan after a complete rotation back to the same position. */
export async function advanceProjectRecoveryCursor(
  db: Db,
  cursor: ProjectRecoveryCursor,
  after: RecoveryPosition | null,
): Promise<boolean> {
  const parsed = cursorSchema.safeParse({
    revision: (cursor.value?.revision ?? 0) + 1,
    after,
    through: cursor.through,
  });

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The next project recovery position is invalid",
    );
  const changed = await db.execute(sql`
    UPDATE scheduler_jobs
    SET target=jsonb_set(coalesce(target,'{}'::jsonb),ARRAY[${cursor.key}]::text[],${JSON.stringify(parsed.data)}::jsonb,true)
    WHERE id=${DEFAULT_AUTO_LAUNCH_TRIAGED_JOB_ID}
      AND coalesce(target->${cursor.key},'null'::jsonb)=${JSON.stringify(cursor.value)}::jsonb
    RETURNING id
  `);

  log.debug(
    {
      cursorKey: cursor.key,
      revision: parsed.data.revision,
      afterId: after?.id ?? null,
      throughId: cursor.through?.id ?? null,
      advanced: changed.rows.length === 1,
    },
    "[FIX:project-recovery] bounded assignment scan position settled",
  );

  return changed.rows.length === 1;
}

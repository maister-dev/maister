import "server-only";

import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import {
  agentProjectLinks,
  agents,
  agentSchedules,
  runSchedules,
  runs,
  scheduledTaskLaunchEvents,
  scheduledTaskLaunches,
  tasks,
  users,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

import type { ScheduledLaunchRequest } from "@/lib/scheduled-launches/types";

type DateValue = Date | string | null;

function iso(value: DateValue): string | null {
  if (value === null) return null;
  if (typeof value === "string") return new Date(value).toISOString();

  return value.toISOString();
}

export type ScheduledLaunchDTO = {
  id: string;
  type: "one_time_task_launch";
  revision: number;
  task: { id: string | null; key: string; number: number; title: string };
  scheduledLocalTime: string;
  timezone: string;
  disambiguation: "earlier" | "later" | null;
  scheduledForAt: string;
  launchRequest: ScheduledLaunchRequest;
  state: typeof scheduledTaskLaunches.$inferSelect.state;
  nextAttemptAt: string | null;
  attemptCount: number;
  maxAttempts: number;
  latestOutcome: typeof scheduledTaskLaunches.$inferSelect.latestOutcome;
  errorCode: string | null;
  errorMessage: string | null;
  lateByMs: number | null;
  resultingRun: { id: string; status: string } | null;
  createdBy: { id: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
};

type ScheduledLaunchRow = {
  launch: typeof scheduledTaskLaunches.$inferSelect;
  runId: string | null;
  runStatus: string | null;
  userId: string | null;
  userEmail: string | null;
};

function toScheduledLaunchDto(row: ScheduledLaunchRow): ScheduledLaunchDTO {
  const launch = row.launch;

  return {
    id: launch.id,
    type: "one_time_task_launch",
    revision: launch.revision,
    task: {
      id: launch.taskId,
      key: launch.taskKey,
      number: launch.taskNumber,
      title: launch.taskTitle,
    },
    scheduledLocalTime: launch.scheduledLocalTime,
    timezone: launch.timezone,
    disambiguation: launch.disambiguation,
    scheduledForAt: iso(launch.scheduledForAt)!,
    launchRequest: launch.launchRequest,
    state: launch.state,
    nextAttemptAt: iso(launch.nextAttemptAt),
    attemptCount: launch.attemptCount,
    maxAttempts: launch.maxAttempts,
    latestOutcome: launch.latestOutcome,
    errorCode: launch.errorCode,
    errorMessage: launch.errorMessage,
    lateByMs: launch.lateByMs,
    resultingRun:
      row.runId && row.runStatus
        ? { id: row.runId, status: row.runStatus }
        : null,
    createdBy:
      row.userId && row.userEmail
        ? { id: row.userId, email: row.userEmail }
        : null,
    createdAt: iso(launch.createdAt)!,
    updatedAt: iso(launch.updatedAt)!,
  };
}

const scheduledLaunchSelection = {
  launch: scheduledTaskLaunches,
  runId: runs.id,
  runStatus: runs.status,
  userId: users.id,
  userEmail: users.email,
} as const;

export async function findScheduledLaunchForProject(input: {
  projectId: string;
  scheduledLaunchId: string;
}): Promise<typeof scheduledTaskLaunches.$inferSelect | null> {
  const rows = await getDb()
    .select()
    .from(scheduledTaskLaunches)
    .where(
      and(
        eq(scheduledTaskLaunches.id, input.scheduledLaunchId),
        eq(scheduledTaskLaunches.projectId, input.projectId),
      ),
    );

  return rows[0] ?? null;
}

export async function getScheduledLaunchDto(input: {
  projectId: string;
  scheduledLaunchId: string;
}): Promise<ScheduledLaunchDTO | null> {
  const rows = await getDb()
    .select(scheduledLaunchSelection)
    .from(scheduledTaskLaunches)
    .leftJoin(runs, eq(runs.scheduledLaunchId, scheduledTaskLaunches.id))
    .leftJoin(users, eq(users.id, scheduledTaskLaunches.createdByUserId))
    .where(
      and(
        eq(scheduledTaskLaunches.id, input.scheduledLaunchId),
        eq(scheduledTaskLaunches.projectId, input.projectId),
      ),
    );
  const row = rows[0];

  return row ? toScheduledLaunchDto(row) : null;
}

export async function listScheduledLaunchEvents(input: {
  projectId: string;
  scheduledLaunchId: string;
}): Promise<
  Array<{
    id: string;
    kind: string;
    actorType: string;
    claimFence: number | null;
    errorCode: string | null;
    message: string | null;
    createdAt: string;
  }>
> {
  const rows = await getDb()
    .select({
      id: scheduledTaskLaunchEvents.id,
      kind: scheduledTaskLaunchEvents.kind,
      actorType: scheduledTaskLaunchEvents.actorType,
      claimFence: scheduledTaskLaunchEvents.claimFence,
      errorCode: scheduledTaskLaunchEvents.errorCode,
      message: scheduledTaskLaunchEvents.message,
      createdAt: scheduledTaskLaunchEvents.createdAt,
    })
    .from(scheduledTaskLaunchEvents)
    .innerJoin(
      scheduledTaskLaunches,
      eq(
        scheduledTaskLaunchEvents.scheduledLaunchId,
        scheduledTaskLaunches.id,
      ),
    )
    .where(
      and(
        eq(scheduledTaskLaunchEvents.scheduledLaunchId, input.scheduledLaunchId),
        eq(scheduledTaskLaunches.projectId, input.projectId),
      ),
    )
    .orderBy(asc(scheduledTaskLaunchEvents.createdAt));

  return rows.map((row) => ({ ...row, createdAt: iso(row.createdAt)! }));
}

const automationKindSchema = z.enum([
  "one_time_task_launch",
  "recurring_task_schedule",
  "agent_cron",
  "agent_event",
]);

export type AutomationKind = z.infer<typeof automationKindSchema>;

export type AutomationRow = {
  id: string;
  type: AutomationKind;
  name: string;
  target: string;
  trigger: string;
  timezone: string | null;
  nextActionAt: string | null;
  state: string;
  latestOutcome: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  resultingRun: { id: string; status: string } | null;
  detailHref: string;
  updatedAt: string;
};

type AutomationCursor = {
  version: 1;
  active: boolean;
  nextActionAt: string | null;
  kindRank: number;
  id: string;
  updatedAt: string;
};

const automationCursorSchema = z.object({
  version: z.literal(1),
  active: z.boolean(),
  nextActionAt: z.string().datetime().nullable(),
  kindRank: z.number().int().min(0).max(3),
  id: z.string().min(1),
  updatedAt: z.string().datetime(),
});

function kindRank(type: AutomationKind): number {
  return {
    one_time_task_launch: 0,
    recurring_task_schedule: 1,
    agent_cron: 2,
    agent_event: 3,
  }[type];
}

function cursorFor(row: AutomationRow): AutomationCursor {
  return {
    version: 1,
    active: row.nextActionAt !== null,
    nextActionAt: row.nextActionAt,
    kindRank: kindRank(row.type),
    id: row.id,
    updatedAt: row.updatedAt,
  };
}

function encodeCursor(cursor: AutomationCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): AutomationCursor | null {
  if (!cursor) return null;

  try {
    return automationCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
  } catch {
    throw new MaisterError("CONFIG", "invalid automation cursor");
  }
}

function compareAutomationRows(left: AutomationRow, right: AutomationRow): number {
  const leftActive = left.nextActionAt !== null;
  const rightActive = right.nextActionAt !== null;

  if (leftActive !== rightActive) return leftActive ? -1 : 1;
  if (leftActive && rightActive) {
    const next = left.nextActionAt!.localeCompare(right.nextActionAt!);

    if (next !== 0) return next;
  } else {
    const updated = right.updatedAt.localeCompare(left.updatedAt);

    if (updated !== 0) return updated;
  }

  const rank = kindRank(left.type) - kindRank(right.type);

  return rank !== 0 ? rank : left.id.localeCompare(right.id);
}

function isAfterCursor(row: AutomationRow, cursor: AutomationCursor): boolean {
  const boundary: AutomationRow = {
    id: cursor.id,
    type: automationKindSchema.options[cursor.kindRank]!,
    name: "",
    target: "",
    trigger: "",
    timezone: null,
    nextActionAt: cursor.nextActionAt,
    state: "",
    latestOutcome: null,
    errorCode: null,
    errorMessage: null,
    resultingRun: null,
    detailHref: "",
    updatedAt: cursor.updatedAt,
  };

  return compareAutomationRows(row, boundary) > 0;
}

async function listProjectAutomationRows(input: {
  projectId: string;
  projectSlug?: string;
}): Promise<AutomationRow[]> {
  const db = getDb();
  const [launches, recurring, bindings] = await Promise.all([
    db
      .select(scheduledLaunchSelection)
      .from(scheduledTaskLaunches)
      .leftJoin(runs, eq(runs.scheduledLaunchId, scheduledTaskLaunches.id))
      .leftJoin(users, eq(users.id, scheduledTaskLaunches.createdByUserId))
      .where(eq(scheduledTaskLaunches.projectId, input.projectId)),
    db
      .select({
        id: runSchedules.id,
        name: runSchedules.name,
        taskTitle: tasks.title,
        cronExpr: runSchedules.cronExpr,
        timezone: runSchedules.timezone,
        nextFireAt: runSchedules.nextFireAt,
        enabled: runSchedules.enabled,
        lastOutcome: runSchedules.lastFireOutcome,
        lastError: runSchedules.lastFireError,
        runId: runs.id,
        runStatus: runs.status,
        updatedAt: runSchedules.updatedAt,
      })
      .from(runSchedules)
      .leftJoin(tasks, eq(tasks.id, runSchedules.taskId))
      .leftJoin(runs, eq(runs.id, runSchedules.lastRunId))
      .where(eq(runSchedules.projectId, input.projectId)),
    db
      .select({
        id: agentSchedules.id,
        triggerType: agentSchedules.triggerType,
        cronExpr: agentSchedules.cronExpr,
        timezone: agentSchedules.timezone,
        nextFireAt: agentSchedules.nextFireAt,
        eventMatch: agentSchedules.eventMatch,
        enabled: agentSchedules.enabled,
        lastOutcome: agentSchedules.lastOutcome,
        lastErrorCode: agentSchedules.lastErrorCode,
        lastErrorMessage: agentSchedules.lastErrorMessage,
        lastRunId: agentSchedules.lastRunId,
        updatedAt: agentSchedules.updatedAt,
        agentId: agents.id,
        agentName: agents.name,
      })
      .from(agentSchedules)
      .innerJoin(agents, eq(agents.id, agentSchedules.agentId))
      .innerJoin(
        agentProjectLinks,
        and(
          eq(agentProjectLinks.agentId, agentSchedules.agentId),
          eq(agentProjectLinks.projectId, agentSchedules.projectId),
          eq(agentProjectLinks.enabled, true),
        ),
      )
      .where(eq(agentSchedules.projectId, input.projectId)),
  ]);
  const projectIdentifier = input.projectSlug ?? input.projectId;
  const rows: AutomationRow[] = [
    ...launches.map((row) => {
      const dto = toScheduledLaunchDto(row);

      return {
        id: dto.id,
        type: "one_time_task_launch" as const,
        name: `Schedule ${dto.task.key}-${dto.task.number}`,
        target: dto.task.title,
        trigger: dto.scheduledLocalTime,
        timezone: dto.timezone,
        nextActionAt: dto.nextAttemptAt,
        state: dto.state,
        latestOutcome: dto.latestOutcome,
        errorCode: dto.errorCode,
        errorMessage: dto.errorMessage,
        resultingRun: dto.resultingRun,
        detailHref: `/api/projects/${projectIdentifier}/automations/one_time_task_launch/${dto.id}`,
        updatedAt: dto.updatedAt,
      };
    }),
    ...recurring.map((row) => ({
      id: row.id,
      type: "recurring_task_schedule" as const,
      name: row.name,
      target: row.taskTitle ?? "Deleted task",
      trigger: row.cronExpr,
      timezone: row.timezone,
      nextActionAt: row.enabled ? iso(row.nextFireAt) : null,
      state: row.enabled ? "Enabled" : "Disabled",
      latestOutcome: row.lastOutcome,
      errorCode: null,
      errorMessage: row.lastError,
      resultingRun:
        row.runId && row.runStatus
          ? { id: row.runId, status: row.runStatus }
          : null,
      detailHref: `/api/projects/${projectIdentifier}/automations/recurring_task_schedule/${row.id}`,
      updatedAt: iso(row.updatedAt)!,
    })),
    ...bindings.map((row) => ({
      id: row.id,
      type:
        row.triggerType === "cron"
          ? ("agent_cron" as const)
          : ("agent_event" as const),
      name: row.agentName,
      target: row.agentName,
      trigger:
        row.triggerType === "cron"
          ? (row.cronExpr ?? "")
          : (row.eventMatch?.kinds.join(", ") ?? ""),
      timezone: row.timezone,
      nextActionAt:
        row.triggerType === "cron" && row.enabled ? iso(row.nextFireAt) : null,
      state: row.enabled ? "Enabled" : "Disabled",
      latestOutcome: row.lastOutcome,
      errorCode: row.lastErrorCode,
      errorMessage: row.lastErrorMessage,
      resultingRun: row.lastRunId ? { id: row.lastRunId, status: "Unknown" } : null,
      detailHref: `/api/projects/${projectIdentifier}/automations/${row.triggerType === "cron" ? "agent_cron" : "agent_event"}/${row.id}`,
      updatedAt: iso(row.updatedAt)!,
    })),
  ];
  return rows.sort(compareAutomationRows);
}

export async function listProjectAutomations(input: {
  projectId: string;
  projectSlug?: string;
  limit: number;
  cursor?: string;
}): Promise<{ rows: AutomationRow[]; nextCursor: string | null }> {
  const cursor = decodeCursor(input.cursor);
  const ordered = (await listProjectAutomationRows(input)).filter((row) =>
    cursor ? isAfterCursor(row, cursor) : true,
  );
  const page = ordered.slice(0, input.limit);
  const finalRow = page.at(-1);

  return {
    rows: page,
    nextCursor:
      finalRow && ordered.length > page.length
        ? encodeCursor(cursorFor(finalRow))
        : null,
  };
}

export async function getProjectAutomationDetail(input: {
  projectId: string;
  projectSlug?: string;
  kind: AutomationKind;
  automationId: string;
}): Promise<AutomationRow | null> {
  const rows = await listProjectAutomationRows({
    projectId: input.projectId,
    projectSlug: input.projectSlug,
  });

  return (
    rows.find(
      (row) => row.type === input.kind && row.id === input.automationId,
    ) ?? null
  );
}

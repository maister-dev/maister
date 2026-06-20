import "server-only";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { GlobalRole, RunKind, RunStatus } from "@/lib/db/schema";
import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { getDb } from "@/lib/db/client";

export const RUNS_LIST_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "Review",
  "Crashed",
  "Done",
  "Abandoned",
  "Failed",
] as const satisfies readonly RunStatus[];

export const RUNS_LIST_SOURCES = [
  "manual",
  "scheduled",
  "scratch",
  "domain_event",
  "webhook",
  "flow",
] as const;

export type RunsListSource = (typeof RUNS_LIST_SOURCES)[number];

export type RunsListFilters = {
  agent?: AdapterId;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  projectSlug?: string;
  source?: RunsListSource;
  status?: RunStatus;
};

export type RunsListProjectOption = {
  id: string;
  name: string;
  slug: string;
};

export type RunsListRow = {
  branch: string | null;
  durationMs: number | null;
  endedAt: Date | null;
  flowLabel: string | null;
  href: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  runId: string;
  runKind: RunKind;
  runnerLabel: string | null;
  sourceKind: RunsListSource;
  sourceLabel: string | null;
  startedAt: Date;
  status: RunStatus;
  taskLabel: string;
  tokensTotal: number | null;
};

export type RunsListPage = {
  filters: RunsListFilters;
  hasNextPage: boolean;
  page: number;
  pageSize: number;
  projectOptions: RunsListProjectOption[];
  rows: RunsListRow[];
};

type RunsListUser = {
  id: string;
  role: GlobalRole;
};

type RunsListDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

type RawProjectOptionRow = {
  project_id: string;
  project_name: string;
  project_slug: string;
};

type RawRunsListRow = {
  agent_id: string | null;
  branch: string | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  capability_agent: AdapterId | null;
  ended_at: Date | string | null;
  flow_ref_id: string | null;
  flow_version: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  project_id: string;
  project_name: string;
  project_slug: string;
  run_id: string;
  run_kind: RunKind;
  runner_snapshot: unknown;
  schedule_id: string | null;
  schedule_name: string | null;
  started_at: Date | string;
  status: RunStatus;
  task_key: string | null;
  task_number: number | null;
  task_title: string | null;
  trigger_source:
    | "manual"
    | "cron"
    | "domain_event"
    | "webhook"
    | "flow"
    | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validDate(value: string | undefined): string | undefined {
  if (!value || !DATE_RE.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);

  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

function validPage(value: string | undefined): number {
  const page = value ? Number.parseInt(value, 10) : 1;

  return Number.isInteger(page) && page > 0 ? page : 1;
}

function oneOf<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
): T[number] | undefined {
  return value && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : undefined;
}

export function normalizeRunsListFilters(
  params: Record<string, string | string[] | undefined>,
): RunsListFilters {
  return {
    page: validPage(firstParam(params.page)),
    projectSlug: firstParam(params.project),
    status: oneOf(firstParam(params.status), RUNS_LIST_STATUSES),
    source: oneOf(firstParam(params.source), RUNS_LIST_SOURCES),
    agent: oneOf(firstParam(params.agent), ADAPTER_IDS),
    dateFrom: validDate(firstParam(params.from)),
    dateTo: validDate(firstParam(params.to)),
  };
}

function coerceDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function coerceNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : coerceDate(value);
}

function dateStart(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function nextDateStart(value: string): Date {
  const date = dateStart(value);

  date.setUTCDate(date.getUTCDate() + 1);

  return date;
}

function visibleProjectsPredicate(user: RunsListUser): SQL {
  if (user.role === "admin") return sql`p.archived_at IS NULL`;

  return sql`
    p.archived_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM project_members pm
      WHERE pm.project_id = p.id
        AND pm.user_id = ${user.id}
    )
  `;
}

function sourcePredicate(source: RunsListSource): SQL {
  if (source === "scheduled") {
    return sql`(rs.id IS NOT NULL OR r.trigger_source = 'cron')`;
  }

  if (source === "manual") {
    return sql`
      rs.id IS NULL
      AND r.run_kind <> 'scratch'
      AND (r.trigger_source IS NULL OR r.trigger_source = 'manual')
    `;
  }

  if (source === "scratch") return sql`r.run_kind = 'scratch'`;

  return sql`r.trigger_source = ${source}`;
}

function buildRunPredicates(
  user: RunsListUser,
  filters: RunsListFilters,
): SQL[] {
  const predicates: SQL[] = [visibleProjectsPredicate(user)];

  if (filters.projectSlug) {
    predicates.push(sql`p.slug = ${filters.projectSlug}`);
  }
  if (filters.status) {
    predicates.push(sql`r.status = ${filters.status}`);
  }
  if (filters.agent) {
    predicates.push(sql`r.capability_agent = ${filters.agent}`);
  }
  if (filters.source) {
    predicates.push(sourcePredicate(filters.source));
  }
  if (filters.dateFrom) {
    predicates.push(sql`r.started_at >= ${dateStart(filters.dateFrom)}`);
  }
  if (filters.dateTo) {
    predicates.push(sql`r.started_at < ${nextDateStart(filters.dateTo)}`);
  }

  return predicates;
}

function visibleProjectOptionsQuery(user: RunsListUser): SQL {
  return sql`
    SELECT
      p.id AS project_id,
      p.name AS project_name,
      p.slug AS project_slug
    FROM projects p
    WHERE ${visibleProjectsPredicate(user)}
    ORDER BY lower(p.name) ASC, p.slug ASC
  `;
}

function runsListQuery(args: {
  filters: RunsListFilters;
  pageSize: number;
  user: RunsListUser;
}): SQL {
  const offset = (args.filters.page - 1) * args.pageSize;
  const limit = args.pageSize + 1;
  const predicates = buildRunPredicates(args.user, args.filters);

  return sql`
    SELECT
      r.id AS run_id,
      r.run_kind,
      r.agent_id,
      r.status,
      r.trigger_source,
      r.started_at,
      r.ended_at,
      r.capability_agent,
      r.runner_snapshot,
      p.id AS project_id,
      p.slug AS project_slug,
      p.name AS project_name,
      p.task_key,
      t.number AS task_number,
      t.title AS task_title,
      f.flow_ref_id,
      COALESCE(f.version, r.flow_version) AS flow_version,
      w.branch,
      rs.id AS schedule_id,
      rs.name AS schedule_name,
      c.input_tokens,
      c.output_tokens,
      c.cache_read_tokens,
      c.cache_creation_tokens
    FROM runs r
    INNER JOIN projects p ON p.id = r.project_id
    LEFT JOIN tasks t ON t.id = r.task_id
    LEFT JOIN flows f ON f.id = r.flow_id
    LEFT JOIN LATERAL (
      SELECT w.branch
      FROM workspaces w
      WHERE w.run_id = r.id
      ORDER BY w.created_at DESC, w.id ASC
      LIMIT 1
    ) w ON true
    LEFT JOIN run_cost_rollups c ON c.run_id = r.id
    LEFT JOIN LATERAL (
      SELECT s.id, s.name
      FROM run_schedules s
      WHERE s.last_run_id = r.id
      ORDER BY s.last_fired_at DESC NULLS LAST, s.updated_at DESC, s.id ASC
      LIMIT 1
    ) rs ON true
    WHERE ${sql.join(predicates, sql` AND `)}
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
}

function tokensTotal(row: RawRunsListRow): number | null {
  const values = [
    row.input_tokens,
    row.output_tokens,
    row.cache_read_tokens,
    row.cache_creation_tokens,
  ].filter((value): value is number => value !== null);

  if (values.length === 0) return null;

  return values.reduce((sum, value) => sum + value, 0);
}

function sourceKind(row: RawRunsListRow): RunsListSource {
  if (row.schedule_id || row.trigger_source === "cron") return "scheduled";
  if (row.run_kind === "scratch") return "scratch";
  if (
    row.trigger_source === "domain_event" ||
    row.trigger_source === "webhook" ||
    row.trigger_source === "flow"
  ) {
    return row.trigger_source;
  }

  return "manual";
}

function sourceLabel(row: RawRunsListRow): string | null {
  if (row.schedule_name) return row.schedule_name;
  if (row.trigger_source === "cron") return "cron";

  return null;
}

function runnerLabel(row: RawRunsListRow): string | null {
  if (row.runner_snapshot && typeof row.runner_snapshot === "object") {
    const snapshot = row.runner_snapshot as {
      adapter?: unknown;
      id?: unknown;
      model?: unknown;
    };
    const model = typeof snapshot.model === "string" ? snapshot.model : null;
    const adapter =
      typeof snapshot.adapter === "string" ? snapshot.adapter : null;

    if (model && adapter) return `${adapter} · ${model}`;
    if (model) return model;
  }

  return row.capability_agent ?? null;
}

function flowLabel(row: RawRunsListRow): string | null {
  if (!row.flow_ref_id) return null;

  return row.flow_version
    ? `${row.flow_ref_id} · ${row.flow_version}`
    : row.flow_ref_id;
}

function taskLabel(row: RawRunsListRow): string {
  if (row.task_number !== null && row.task_title) {
    const key = row.task_key ? `${row.task_key}-${row.task_number}` : null;

    return key
      ? `${key} ${row.task_title}`
      : `#${row.task_number} ${row.task_title}`;
  }

  if (row.run_kind === "scratch") return "Scratch run";
  if (row.agent_id) return row.agent_id;

  return row.branch ?? row.run_id;
}

function hrefFor(row: RawRunsListRow): string {
  return row.run_kind === "scratch"
    ? `/scratch-runs/${row.run_id}`
    : `/runs/${row.run_id}`;
}

function toRunsListRow(row: RawRunsListRow): RunsListRow {
  const startedAt = coerceDate(row.started_at);
  const endedAt = coerceNullableDate(row.ended_at);

  return {
    branch: row.branch,
    durationMs: endedAt ? endedAt.getTime() - startedAt.getTime() : null,
    endedAt,
    flowLabel: flowLabel(row),
    href: hrefFor(row),
    projectId: row.project_id,
    projectName: row.project_name,
    projectSlug: row.project_slug,
    runId: row.run_id,
    runKind: row.run_kind,
    runnerLabel: runnerLabel(row),
    sourceKind: sourceKind(row),
    sourceLabel: sourceLabel(row),
    startedAt,
    status: row.status,
    taskLabel: taskLabel(row),
    tokensTotal: tokensTotal(row),
  };
}

function toProjectOption(row: RawProjectOptionRow): RunsListProjectOption {
  return {
    id: row.project_id,
    name: row.project_name,
    slug: row.project_slug,
  };
}

export async function listRunsPage(args: {
  db?: RunsListDb;
  filters: RunsListFilters;
  pageSize?: number;
  user: RunsListUser;
}): Promise<RunsListPage> {
  const db = args.db ?? (getDb() as unknown as RunsListDb);
  const pageSize = args.pageSize ?? 50;
  const [projectResult, runsResult] = await Promise.all([
    db.execute(visibleProjectOptionsQuery(args.user)),
    db.execute(
      runsListQuery({
        filters: args.filters,
        pageSize,
        user: args.user,
      }),
    ),
  ]);
  const rawRows = (runsResult.rows ?? []) as RawRunsListRow[];
  const hasNextPage = rawRows.length > pageSize;

  return {
    filters: args.filters,
    hasNextPage,
    page: args.filters.page,
    pageSize,
    projectOptions: ((projectResult.rows ?? []) as RawProjectOptionRow[]).map(
      toProjectOption,
    ),
    rows: rawRows.slice(0, pageSize).map(toRunsListRow),
  };
}

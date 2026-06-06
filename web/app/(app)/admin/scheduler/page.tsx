import type { SchedulerJobKind } from "@/lib/db/schema";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import {
  SchedulerJobsTable,
  type SchedulerJobRow,
} from "@/components/admin/scheduler-jobs-table";
import { requireGlobalRole } from "@/lib/authz";
import { listSchedulerStatusRows } from "@/lib/queries/scheduler";

const JOB_KINDS = [
  "system_sweep",
  "command",
  "agent_tick",
  "flow_run",
] as const;
const STATES = ["active", "disabled"] as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("adminScheduler");

  return { title: t("title") };
}

export default async function AdminSchedulerPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactElement> {
  await requireGlobalRole("admin");

  const t = await getTranslations("adminScheduler");
  const sp = await searchParams;

  const kindParam = first(sp.jobKind);
  const stateParam = first(sp.state);
  const jobKind =
    kindParam && (JOB_KINDS as readonly string[]).includes(kindParam)
      ? (kindParam as SchedulerJobKind)
      : undefined;
  const state =
    stateParam && (STATES as readonly string[]).includes(stateParam)
      ? (stateParam as (typeof STATES)[number])
      : undefined;

  const all = await listSchedulerStatusRows({ limit: 200 });
  const filtered = all.filter((job) => {
    if (jobKind && job.jobKind !== jobKind) return false;
    if (state === "active" && job.disabledAt !== null) return false;
    if (state === "disabled" && job.disabledAt === null) return false;

    return true;
  });

  const rows: SchedulerJobRow[] = filtered.map((job) => ({
    id: job.id,
    projectId: job.projectId,
    jobKind: job.jobKind,
    target: job.target,
    cadenceIntervalSeconds: job.cadenceIntervalSeconds,
    nextRunAt: job.nextRunAt.toISOString(),
    lastFiredAt: job.lastFiredAt?.toISOString() ?? null,
    disabledAt: job.disabledAt?.toISOString() ?? null,
    consecutiveFailures: job.consecutiveFailures,
    maxFailures: job.maxFailures,
    lastStatus: job.lastStatus,
    lastFinishedAt: job.lastFinishedAt?.toISOString() ?? null,
    lastErrorCode: job.lastErrorCode,
  }));

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">
          {t("eyebrow")}
        </div>
        <div>
          <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em] text-ink">
            {t("title")}
          </h1>
          <p className="mt-2 max-w-[680px] text-[13.5px] leading-[1.55] text-mute">
            {t("sub")}
          </p>
        </div>
      </header>

      <SchedulerJobsTable
        filters={{
          jobKind: jobKind ?? "all",
          state: state ?? "all",
        }}
        jobs={rows}
      />
    </div>
  );
}

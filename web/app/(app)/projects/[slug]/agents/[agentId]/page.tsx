import type { ReactElement } from "react";

import { getTranslations, getLocale } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import {
  resolveAgentActivityAccess,
  getAgentActivityDetail,
  getAgentDefinitionView,
} from "@/lib/agents/activity-access";
import {
  getAgentRunHistory,
  getAgentAttemptHistory,
} from "@/lib/agents/activity-queries";
import { RUN_STATUS_VALUES } from "@/lib/runs/run-status-values";
import {
  AgentRunHistory,
  AgentAttemptHistory,
} from "@/components/agents/agent-history";
import { AgentMemoryControl } from "@/components/agents/agent-memory-control";
import { ProjectAgentSettings } from "@/components/agents/project-agent-settings";

const querySchema = z
  .object({
    tab: z
      .enum(["history", "attempts", "memory", "definition", "settings"])
      .default("history"),
    cursor: z.string().min(1).max(2048).optional(),
    status: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(RUN_STATUS_VALUES).optional(),
    ),
    triggerSource: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .enum([
          "manual",
          "cron",
          "domain_event",
          "webhook",
          "flow",
          "scheduled",
        ])
        .optional(),
    ),
    outcome: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .enum([
          "success",
          "partial",
          "blocked",
          "failed",
          "cancelled",
          "crashed",
        ])
        .optional(),
    ),
  })
  .strict();

export default async function ProjectAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; agentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const { slug, agentId } = await params;
  const parsed = querySchema.safeParse(await searchParams);

  if (!parsed.success) notFound();
  const query = parsed.data;
  const access = await resolveAgentActivityAccess(slug, agentId);
  const detail = await getAgentActivityDetail(access);
  const t = await getTranslations("agentActivity");
  const locale = await getLocale();
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "UTC",
  });
  const base = `/projects/${slug}/agents/${encodeURIComponent(access.agentId)}`;
  const tabs = [
    "history",
    "attempts",
    "memory",
    "definition",
    "settings",
  ] as const;
  const definition =
    query.tab === "definition" && access.canReadDefinition
      ? await getAgentDefinitionView(access)
      : null;
  const history =
    query.tab === "history"
      ? await getAgentRunHistory(access.db, {
          projectId: access.projectId,
          agentId: access.agentId,
          cursor: query.cursor,
          status: query.status,
          triggerSource: query.triggerSource,
          outcome: query.outcome,
        })
      : null;
  const attempts =
    query.tab === "attempts"
      ? await getAgentAttemptHistory(access.db, {
          projectId: access.projectId,
          agentId: access.agentId,
          cursor: query.cursor,
        })
      : null;

  return (
    <div
      className="mx-auto max-w-6xl space-y-6"
      data-testid="project-agent-page"
    >
      <Link
        className="text-sm text-mute underline"
        href={`/projects/${slug}?tab=agents`}
      >
        {t("backToAgents")}
      </Link>
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-widest text-accent-4">
          {t("title")}
        </p>
        <h1 className="break-words text-2xl font-bold text-ink">
          {detail.displayName}
        </h1>
        <p className="break-all font-mono text-xs text-mute">
          {detail.agentId}
        </p>
        {detail.attachmentState !== "attached" ? (
          <p
            className="rounded-lg border border-line bg-ivory p-3 text-sm"
            role="status"
          >
            {t("historicalOnly")}
          </p>
        ) : null}
      </header>
      <dl className="grid gap-3 rounded-xl border border-line bg-paper p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs text-mute">{t("retainedRuns")}</dt>
          <dd className="mt-1 text-xl font-semibold">
            {new Intl.NumberFormat(locale).format(
              detail.activity.retainedRunCount,
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-mute">{t("activeTitle")}</dt>
          <dd className="mt-1 text-xl font-semibold">
            {new Intl.NumberFormat(locale).format(
              detail.activity.activeRunCount,
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-mute">{t("lastLaunched")}</dt>
          <dd className="mt-1 text-sm">
            {detail.activity.lastLaunched ? (
              <>
                <Link
                  className="underline"
                  href={`/runs/${detail.activity.lastLaunched.runId}`}
                >
                  {t(`status.${detail.activity.lastLaunched.status}`)}
                </Link>{" "}
                ·{" "}
                <time dateTime={detail.activity.lastLaunched.at}>
                  {date.format(new Date(detail.activity.lastLaunched.at))}
                </time>
                {detail.activity.lastLaunched.outcome ? (
                  <span className="block text-xs text-mute">
                    {t(`outcome.${detail.activity.lastLaunched.outcome}`)}
                  </span>
                ) : null}
              </>
            ) : (
              t("notRunYet")
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-mute">{t("lastCompleted")}</dt>
          <dd className="mt-1 text-sm">
            {detail.activity.lastCompleted ? (
              <>
                <Link
                  className="underline"
                  href={`/runs/${detail.activity.lastCompleted.runId}`}
                >
                  {t(`status.${detail.activity.lastCompleted.status}`)}
                </Link>{" "}
                ·{" "}
                <time dateTime={detail.activity.lastCompleted.at}>
                  {date.format(new Date(detail.activity.lastCompleted.at))}
                </time>
                {detail.activity.lastCompleted.outcome ? (
                  <span className="block text-xs text-mute">
                    {t(`outcome.${detail.activity.lastCompleted.outcome}`)}
                  </span>
                ) : null}
              </>
            ) : (
              t("notCompletedYet")
            )}
          </dd>
        </div>
      </dl>
      <nav
        aria-label={t("tabsLabel")}
        className="flex gap-1 overflow-x-auto border-b border-line"
      >
        {tabs.map((tab) => (
          <Link
            key={tab}
            aria-current={query.tab === tab ? "page" : undefined}
            className={`shrink-0 border-b-2 px-3 py-3 text-sm font-semibold ${query.tab === tab ? "border-accent-4 text-ink" : "border-transparent text-mute hover:text-ink"}`}
            href={`${base}?tab=${tab}`}
          >
            {t(tab)}
          </Link>
        ))}
      </nav>
      {history ? (
        <AgentRunHistory
          agentId={access.agentId}
          canRetry={access.canRetry}
          newerRunsAvailable={Boolean(
            query.cursor &&
            detail.activity.lastLaunched &&
            detail.activity.lastLaunched.at > history.asOf,
          )}
          outcome={query.outcome}
          page={history}
          slug={slug}
          status={query.status}
          triggerSource={query.triggerSource}
        />
      ) : null}
      {attempts ? (
        <AgentAttemptHistory
          agentId={access.agentId}
          page={attempts}
          slug={slug}
        />
      ) : null}
      {query.tab === "memory" ? (
        access.canReadDefinition && access.attachmentState === "attached" ? (
          <AgentMemoryControl
            agentId={access.agentId}
            canEdit={access.canEditSettings}
            slug={slug}
          />
        ) : (
          <p className="text-sm text-mute">
            {t(
              access.canReadDefinition
                ? "memoryUnavailable"
                : "definitionPermission",
            )}
          </p>
        )
      ) : null}
      {query.tab === "definition" ? (
        definition?.state === "available" ? (
          <section className="space-y-3">
            <p className="text-xs text-mute">
              {t("pinnedDefinition")} · {definition.packageVersion} ·{" "}
              <code>{definition.definitionDigest?.slice(0, 12)}</code>
            </p>
            <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-paper p-4 text-sm">
              {definition.prompt}
            </pre>
            <p className="text-xs text-mute">{t("promptEditBoundary")}</p>
          </section>
        ) : (
          <p className="text-sm text-mute">
            {t(
              access.canReadDefinition
                ? "definitionUnavailable"
                : "definitionPermission",
            )}
          </p>
        )
      ) : null}
      {query.tab === "settings" ? (
        access.canEditSettings ? (
          <ProjectAgentSettings
            agentId={access.agentId}
            projectId={access.projectId}
            slug={slug}
          />
        ) : (
          <p className="text-sm text-mute">{t("settingsUnavailable")}</p>
        )
      ) : null}
    </div>
  );
}

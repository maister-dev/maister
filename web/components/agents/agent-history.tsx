import type {
  ActivityPage,
  AgentHistoryItem,
  AgentAttemptItem,
} from "@/lib/agents/activity-queries";
import type { ReactElement } from "react";

import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

import { RUN_STATUS_VALUES } from "@/lib/runs/run-status-values";
import { AgentRetryControl } from "@/components/agents/agent-retry-control";

const link =
  "inline-flex min-h-8 items-center rounded-lg border border-line bg-ivory px-3 text-xs font-semibold text-ink hover:border-mute";

export async function AgentRunHistory({
  page,
  slug,
  agentId,
  status,
  triggerSource,
  outcome,
  canRetry,
  newerRunsAvailable = false,
}: {
  page: ActivityPage<AgentHistoryItem>;
  slug: string;
  agentId: string;
  status?: string;
  triggerSource?: string;
  outcome?: string;
  canRetry: boolean;
  newerRunsAvailable?: boolean;
}): Promise<ReactElement> {
  const t = await getTranslations("agentActivity");
  const locale = await getLocale();
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "UTC",
  });
  const base = `/projects/${slug}/agents/${encodeURIComponent(agentId)}`;
  const latest = new URLSearchParams({
    tab: "history",
    ...(status ? { status } : {}),
    ...(triggerSource ? { triggerSource } : {}),
    ...(outcome ? { outcome } : {}),
  });
  const next = new URLSearchParams({
    tab: "history",
    ...(status ? { status } : {}),
    ...(triggerSource ? { triggerSource } : {}),
    ...(outcome ? { outcome } : {}),
    ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
  });

  return (
    <section aria-label={t("history")} className="space-y-4">
      {newerRunsAvailable ? (
        <p
          className="rounded-lg border border-line bg-ivory p-3 text-sm"
          role="status"
        >
          {t("newRunsAvailable")}{" "}
          <Link className="underline" href={`${base}?${latest.toString()}`}>
            {t("latestRuns")}
          </Link>
        </p>
      ) : null}
      <form
        action={base}
        className="flex flex-wrap items-end gap-2"
        method="get"
      >
        <input name="tab" type="hidden" value="history" />
        <label className="text-sm">
          {t("statusFilter")}
          <select
            className="ml-2 rounded-lg border border-line bg-paper p-2"
            defaultValue={status ?? ""}
            name="status"
          >
            <option value="">{t("allStatuses")}</option>
            {RUN_STATUS_VALUES.map((value) => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          {t("trigger")}
          <select
            className="ml-2 rounded-lg border border-line bg-paper p-2"
            defaultValue={triggerSource ?? ""}
            name="triggerSource"
          >
            <option value="">{t("allTriggers")}</option>
            {[
              "manual",
              "cron",
              "domain_event",
              "webhook",
              "flow",
              "scheduled",
            ].map((value) => (
              <option key={value} value={value}>
                {t(`triggerSource.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          {t("outcomeLabel")}
          <select
            className="ml-2 rounded-lg border border-line bg-paper p-2"
            defaultValue={outcome ?? ""}
            name="outcome"
          >
            <option value="">{t("allOutcomes")}</option>
            {[
              "success",
              "partial",
              "blocked",
              "failed",
              "cancelled",
              "crashed",
            ].map((value) => (
              <option key={value} value={value}>
                {t(`outcome.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <button className={link} type="submit">
          {t("applyFilters")}
        </button>
      </form>
      {page.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-6 text-sm text-mute">
          {t(
            status || triggerSource || outcome ? "noMatchingRuns" : "notRunYet",
          )}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-mute">
              <tr>
                <th className="p-2" scope="col">
                  {t("run")}
                </th>
                <th className="p-2" scope="col">
                  {t("statusFilter")}
                </th>
                <th className="p-2" scope="col">
                  {t("launchedAt")}
                </th>
                <th className="p-2" scope="col">
                  {t("trigger")}
                </th>
                <th className="p-2" scope="col">
                  {t("workspace")}
                </th>
                <th className="p-2" scope="col">
                  {t("actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr
                  key={item.runId}
                  className="border-b border-line/60"
                  data-testid="agent-history-row"
                >
                  <th className="p-2 font-mono font-normal" scope="row">
                    <Link
                      className="text-ink underline underline-offset-2"
                      href={`/runs/${item.runId}`}
                    >
                      {item.runId.slice(0, 8)}
                    </Link>
                    {item.retryOfRunId ? (
                      <span className="mt-1 block text-xs text-mute">
                        {t("retryOf")}{" "}
                        <Link
                          className="underline"
                          href={`/runs/${item.retryOfRunId}`}
                        >
                          {item.retryOfRunId.slice(0, 8)}
                        </Link>
                      </span>
                    ) : null}
                  </th>
                  <td className="p-2">
                    <span>{t(`status.${item.status}`)}</span>
                    {item.outcome ? (
                      <span className="block text-xs text-mute">
                        {t(`outcome.${item.outcome}`)}
                      </span>
                    ) : null}
                    {item.runKind === "flow" ? (
                      <span className="block text-xs text-mute">
                        {t("flowPool")}
                      </span>
                    ) : null}
                  </td>
                  <td className="p-2">
                    <time dateTime={item.launchedAt ?? item.sortAt}>
                      {date.format(new Date(item.launchedAt ?? item.sortAt))}
                    </time>
                    {item.timestampProvenance !== "launch" &&
                    item.timestampProvenance !== "verified_creation" ? (
                      <span className="block text-xs text-mute">
                        {t("estimatedTime")}
                      </span>
                    ) : null}
                  </td>
                  <td className="p-2">
                    {item.triggerSource
                      ? t(`triggerSource.${item.triggerSource}`)
                      : t("unavailable")}
                  </td>
                  <td className="p-2 text-xs">
                    {item.workspaceAvailable
                      ? t("workspaceAvailable")
                      : t("noWorkspace")}
                  </td>
                  <td className="p-2">
                    {canRetry &&
                    item.runKind === "agent" &&
                    (item.status === "Failed" || item.status === "Crashed") ? (
                      <AgentRetryControl runId={item.runId} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label={t("historyPages")} className="flex gap-2">
        {page.nextCursor ? (
          <Link className={link} href={`${base}?${next}`}>
            {t("nextPage")}
          </Link>
        ) : null}
        <Link className={link} href={`${base}?${latest.toString()}`}>
          {t("latestRuns")}
        </Link>
      </nav>
    </section>
  );
}
export async function AgentAttemptHistory({
  page,
  slug,
  agentId,
}: {
  page: ActivityPage<AgentAttemptItem>;
  slug: string;
  agentId: string;
}): Promise<ReactElement> {
  const t = await getTranslations("agentActivity");
  const locale = await getLocale();
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "UTC",
  });
  const base = `/projects/${slug}/agents/${encodeURIComponent(agentId)}`;

  return (
    <section aria-label={t("attempts")} className="space-y-4">
      <p className="text-sm text-mute">{t("attemptsHint")}</p>
      {page.items.length === 0 ? (
        <p className="text-sm text-mute">{t("noAttempts")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {page.items.map((item) => (
            <li
              key={item.attemptId}
              className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
              data-testid="agent-attempt-row"
            >
              <span>
                <time dateTime={item.claimedAt}>
                  {date.format(new Date(item.claimedAt))}
                </time>{" "}
                · {t(`triggerSource.${item.triggerSource}`)} ·{" "}
                {item.outcome
                  ? t(`attemptOutcome.${item.outcome}`)
                  : t("attemptUnsettled")}
                {item.provenance === "legacy_latest" ? (
                  <span className="block text-xs text-mute">
                    {t("estimatedAttemptHistory")}
                  </span>
                ) : null}
              </span>
              {item.runId ? (
                <Link className={link} href={`/runs/${item.runId}`}>
                  {t("openDiagnosticRun")}
                </Link>
              ) : (
                <span className="text-xs text-mute">
                  {t("attemptWithoutRun")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor ? (
        <Link
          className={link}
          href={`${base}?${new URLSearchParams({ tab: "attempts", cursor: page.nextCursor })}`}
        >
          {t("nextPage")}
        </Link>
      ) : null}
    </section>
  );
}

import type { ReactElement } from "react";
import type { ActiveAgentExecution } from "@/lib/agents/activity-queries";

import {
  CpuChipIcon,
  QuestionMarkCircleIcon,
} from "@heroicons/react/24/outline";
import { getTranslations, getLocale } from "next-intl/server";
import Link from "next/link";

export async function ActiveAgentExecutions({
  items,
}: {
  items: readonly ActiveAgentExecution[];
}): Promise<ReactElement> {
  const t = await getTranslations("agentActivity");
  const locale = await getLocale();
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "UTC",
  });

  return (
    <section
      aria-label={t("activeTitle")}
      className="flex min-h-0 flex-col gap-2"
      data-testid="active-agent-executions"
    >
      <h2 className="flex items-center justify-between font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
        <span>{t("activeTitle")}</span>
        <span>{new Intl.NumberFormat(locale).format(items.length)}</span>
      </h2>
      {items.length === 0 ? (
        <p className="text-xs text-mute">{t("noneActive")}</p>
      ) : (
        <ul className="max-h-[40vh] min-h-0 space-y-1 overflow-y-auto overscroll-contain">
          {items.map((item) => (
            <li
              key={item.runId}
              className="rounded-lg border border-accent-4/20 bg-accent-4/5 p-2 text-xs"
              data-agent-run-id={item.runId}
            >
              <Link
                className="flex gap-2 text-ink hover:underline focus-visible:outline-2"
                href={`/runs/${item.runId}`}
              >
                <CpuChipIcon
                  aria-hidden="true"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-4"
                />
                <span className="min-w-0">
                  <strong className="block break-words">
                    {item.displayName ?? item.agentId ?? t("unknownAgent")}
                  </strong>
                  <span className="block text-mute">
                    {item.projectName} · {t(`status.${item.status}`)}
                  </span>
                </span>
              </Link>
              <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 font-mono text-[10px] text-mute">
                <span>
                  {item.runKind === "flow" ? t("flowPool") : t("agentPool")}
                </span>
                <span>
                  {item.workspaceAvailable
                    ? t("workspaceAvailable")
                    : t("noWorkspace")}
                </span>
                {item.launchedAt ? (
                  <time dateTime={item.launchedAt}>
                    {date.format(new Date(item.launchedAt))}
                  </time>
                ) : (
                  <span>{t("launchTimeUnavailable")}</span>
                )}
              </div>
              {item.pendingInputCount > 0 ? (
                <Link
                  className="mt-1 inline-flex items-center gap-1 font-semibold text-amber"
                  href={`/runs/${item.runId}`}
                >
                  <QuestionMarkCircleIcon
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                  />
                  {t("pendingInput", { count: item.pendingInputCount })}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

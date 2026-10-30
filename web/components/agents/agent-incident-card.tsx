"use client";

import type { ReactElement } from "react";
import type {
  AgentIncidentGroup,
  AgentIncidentEpisode,
} from "@/lib/runs/agent-incident-projection";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";

const button =
  "inline-flex min-h-8 items-center rounded-lg border border-line bg-ivory px-3 text-xs font-semibold text-ink hover:border-mute disabled:opacity-50";

function causeKey(
  reason: string,
): "cleanup" | "authorization" | "qualification" | "execution" {
  if (reason.includes("cleanup") || reason.includes("preserv"))
    return "cleanup";
  if (
    [
      "qualification_stale",
      "qualification_input_changed",
      "qualification_routing_changed",
    ].includes(reason)
  )
    return "qualification";
  if (
    reason.includes("403") ||
    reason.includes("authoriz") ||
    reason.includes("revoked")
  )
    return "authorization";

  return "execution";
}
export function AgentIncidentCard({
  group,
}: {
  group: AgentIncidentGroup;
}): ReactElement {
  const t = useTranslations("agentActivity");
  const locale = useLocale();
  const router = useRouter();
  const [page, setPage] = useState<{
    items: AgentIncidentEpisode[];
    nextCursor: string | null;
    revision: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const episodes = page?.items ?? group.episodes;
  const cursor = page ? page.nextCursor : group.nextCursor;
  const endpoint = `/api/projects/${encodeURIComponent(group.projectSlug)}/agents/${encodeURIComponent(group.agentId)}/incidents`;
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "UTC",
  });
  const acknowledge = async (episode: AgentIncidentEpisode): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          episodes: [
            {
              episodeId: episode.episodeId,
              attentionRevision: episode.attentionRevision,
            },
          ],
        }),
      });

      if (!response.ok) {
        setError(t(response.status === 409 ? "ackConflict" : "ackError"));

        return;
      }
      if (page)
        setPage({
          ...page,
          items: page.items.filter(
            (item) => item.episodeId !== episode.episodeId,
          ),
        });
      router.refresh();
    } catch {
      setError(t("ackError"));
    } finally {
      setBusy(false);
    }
  };
  const next = async (): Promise<void> => {
    if (!cursor) return;
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        cursor,
        state: "open",
        acknowledged: "false",
      });
      const response = await fetch(`${endpoint}?${query}`);

      if (!response.ok) {
        setError(t("loadError"));

        return;
      }
      const result = (await response.json()) as {
        items: AgentIncidentEpisode[];
        nextCursor: string | null;
      };

      setPage({ ...result, revision: group.contentRevision });
    } catch {
      setError(t("loadError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className="space-y-3 rounded-[14px] border border-line border-l-2 border-l-amber bg-paper p-4"
      data-agent-id={group.agentId}
      data-testid="agent-incident-card"
    >
      <header className="flex items-start gap-2">
        <ExclamationTriangleIcon
          aria-hidden="true"
          className="mt-0.5 h-5 w-5 shrink-0 text-amber"
        />
        <div>
          <h3 className="font-semibold text-ink">{group.title}</h3>
          <p className="text-xs text-mute">
            {group.projectSlug} ·{" "}
            {t("incidentSummary", {
              runs: group.failedRunCount,
              attempts: group.attemptCount,
              causes: group.totalCauseCount,
            })}
          </p>
        </div>
      </header>
      <Link
        className={button}
        href={`/projects/${group.projectSlug}/agents/${encodeURIComponent(group.agentId)}`}
      >
        {t("history")}
      </Link>
      <details>
        <summary className="cursor-pointer text-sm font-semibold text-ink">
          {t("unseenCauses", { count: group.unreadEpisodeCount })}
        </summary>
        <div aria-busy={busy} className="mt-2 space-y-3">
          {page && page.revision !== group.contentRevision ? (
            <p role="status">
              {t("contentChanged")}{" "}
              <button
                className={button}
                type="button"
                onClick={() => setPage(null)}
              >
                {t("refresh")}
              </button>
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : null}
          {episodes.map((episode) => (
            <section
              key={episode.episodeId}
              className="space-y-2 rounded-lg border border-line p-3"
              data-testid="agent-incident-cause"
            >
              <h4 className="text-sm font-semibold">
                {t(`cause.${causeKey(episode.reasonCode)}`)}
              </h4>
              <p className="text-xs text-mute">
                {t("occurrences", { count: episode.occurrenceCount })} ·{" "}
                <time dateTime={episode.firstAt}>
                  {date.format(new Date(episode.firstAt))}
                </time>{" "}
                —{" "}
                <time dateTime={episode.lastAt}>
                  {date.format(new Date(episode.lastAt))}
                </time>
              </p>
              <p className="text-sm">
                {t(`remediation.${causeKey(episode.reasonCode)}`)}
              </p>
              <div className="flex flex-wrap gap-2">
                {episode.representativeRunId ? (
                  <Link
                    className={button}
                    href={`/runs/${episode.representativeRunId}`}
                  >
                    {t("openDiagnosticRun")}
                  </Link>
                ) : (
                  <span className="text-xs text-mute">
                    {t("evidenceExpired")}
                  </span>
                )}
                <button
                  className={button}
                  disabled={busy}
                  type="button"
                  onClick={() => void acknowledge(episode)}
                >
                  {t("ackCause")}
                </button>
              </div>
            </section>
          ))}
          {page ? (
            <button
              className={button}
              disabled={busy}
              type="button"
              onClick={() => setPage(null)}
            >
              {t("firstPage")}
            </button>
          ) : null}
          {cursor ? (
            <button
              className={button}
              disabled={busy}
              type="button"
              onClick={() => void next()}
            >
              {t("nextCauses")}
            </button>
          ) : null}
        </div>
      </details>
    </article>
  );
}

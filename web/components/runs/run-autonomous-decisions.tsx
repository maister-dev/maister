import { getLocale, getTranslations } from "next-intl/server";

import { ReportAutonomousReversal } from "./report-autonomous-reversal";

import { getDb } from "@/lib/db/client";
import { getRecentAutonomousDecisions } from "@/lib/queries/autonomous-completion";

export async function RunAutonomousDecisions({
  runId,
  projectId,
  canAct,
}: {
  runId: string;
  projectId: string;
  canAct: boolean;
}) {
  const decisions = await getRecentAutonomousDecisions(
    getDb(),
    runId,
    projectId,
  );

  if (decisions.length === 0) return null;
  const [t, locale] = await Promise.all([
    getTranslations("runAutonomy"),
    getLocale(),
  ]);
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <section
      aria-label={t("title")}
      className="rounded-lg border border-line bg-paper p-3"
    >
      <h3 className="text-sm font-semibold">{t("title")}</h3>
      <ul className="mt-2 space-y-2 text-xs">
        {decisions.map((decision) => (
          <li key={decision.id} className="grid gap-0.5">
            <span>
              {t(`action.${decision.action}`)} · {t(`phase.${decision.phase}`)}
            </span>
            <span>
              {t.has(`reason.${decision.reason}`)
                ? t(`reason.${decision.reason}`)
                : t("reason.missing_required_evidence")}
            </span>
            <time className="text-mute" dateTime={decision.at.toISOString()}>
              {format.format(decision.at)}
            </time>
            {decision.verifiedReversals > 0 ? (
              <span>
                {t("reversal.recorded", { count: decision.verifiedReversals })}
              </span>
            ) : null}
            {canAct && decision.canReportReversal ? (
              <ReportAutonomousReversal
                decisionId={decision.id}
                runId={runId}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

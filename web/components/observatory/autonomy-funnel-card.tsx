import type { ReactElement } from "react";
import type { AutonomyFunnelCardProps } from "@/components/observatory/types";

export function AutonomyFunnelCard({
  data,
  labels,
  locale,
}: AutonomyFunnelCardProps): ReactElement {
  const text = labels.funnel;
  const groups = [
    { title: text.runKind, rows: data.runKinds },
    { title: text.launchMode, rows: data.launchModes },
    { title: text.triggerSource, rows: data.triggerSources },
    { title: text.humanTouch, rows: data.humanTouch },
    { title: text.throughput, rows: data.throughput },
    { title: text.promotionLane, rows: data.promotionLanes },
  ];

  return (
    <section
      className="rounded-[14px] border border-line bg-paper p-5"
      data-testid="observatory-funnel"
    >
      <header className="mb-4">
        <h2 className="m-0 text-lg font-semibold text-ink">{text.title}</h2>
        <p className="mt-1 text-sm text-mute">{text.subtitle}</p>
      </header>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => (
          <article
            key={group.title}
            className="rounded-md border border-line-soft bg-ivory px-3 py-2"
          >
            <h3 className="m-0 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
              {group.title}
            </h3>
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-xs text-ink">
              {group.rows.map((row) => (
                <li key={row.key} className="flex justify-between gap-2">
                  <span>{funnelLabel(text, row.key)}</span>
                  <strong>
                    {new Intl.NumberFormat(locale).format(row.count)}
                  </strong>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      {data.volatile ? (
        <p className="mt-3 text-xs text-amber">{labels.volatile}</p>
      ) : null}
    </section>
  );
}

function funnelLabel(
  labels: AutonomyFunnelCardProps["labels"]["funnel"],
  key: string,
): string {
  const known: Record<string, string> = {
    pure_autonomous: labels.pureAutonomous,
    ai_with_correction: labels.aiWithCorrection,
    human_takeover: labels.humanTakeover,
    platform_promoted: labels.platformPromoted,
    failed: labels.failed,
    crashed: labels.crashed,
    abandoned: labels.abandoned,
    unrecorded: labels.unrecorded,
  };

  return known[key] ?? key;
}

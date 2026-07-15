import type { ReactElement } from "react";

import Link from "next/link";

export type SchedulerScheduledLaunchOverviewView = {
  scheduledLaunchId: string;
  projectSlug: string;
  projectName: string;
  taskKey: string;
  taskNumber: number;
  taskTitle: string;
  state: string;
  nextAttemptAt: string | null;
  attemptCount: number;
  latestOutcome: string | null;
  errorCode: string | null;
};

export function SchedulerScheduledLaunchesOverview(props: {
  labels: { attempt: string; empty: string; subtitle: string; title: string };
  launches: SchedulerScheduledLaunchOverviewView[];
}): ReactElement {
  return (
    <section className="rounded-[12px] border border-line bg-paper p-5">
      <h2 className="m-0 text-[16px] font-semibold text-ink">{props.labels.title}</h2>
      <p className="mt-1 text-[12px] text-mute">{props.labels.subtitle}</p>
      {props.launches.length === 0 ? (
        <p className="mt-4 font-mono text-[12px] text-mute">{props.labels.empty}</p>
      ) : (
        <ul className="mt-4 divide-y divide-line-soft">
          {props.launches.map((launch) => (
            <li className="flex items-center justify-between gap-3 py-2.5" key={launch.scheduledLaunchId}>
              <div className="min-w-0">
                <Link
                  className="text-sm font-semibold text-ink hover:text-amber"
                  href={`/projects/${launch.projectSlug}?tab=automations`}
                >
                  {launch.projectName} · {launch.taskKey}-{launch.taskNumber}
                </Link>
                <p className="truncate font-mono text-[10px] text-mute">{launch.taskTitle}</p>
              </div>
              <p className="text-right font-mono text-[10px] text-mute">
                {launch.state} · {props.labels.attempt} {launch.attemptCount}
                {launch.latestOutcome ? ` · ${launch.latestOutcome}` : ""}
                {launch.errorCode ? ` · ${launch.errorCode}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

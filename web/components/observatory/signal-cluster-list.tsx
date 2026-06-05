"use client";

import type { SignalCluster } from "@/lib/queries/observatory-signals";
import type { ReactElement } from "react";
import type { ObservatoryLabels } from "@/components/observatory/types";

import Link from "next/link";
import { Chip } from "@heroui/react";

export function SignalClusterList({
  labels,
  projectSlug,
  signals,
}: {
  labels: ObservatoryLabels;
  projectSlug?: string;
  signals: readonly SignalCluster[];
}): ReactElement {
  return (
    <section className="rounded-lg border border-line bg-paper p-4">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-sm font-semibold text-ink">
            {labels.signals}
          </h2>
          <p className="mt-1 text-xs leading-5 text-mute">
            {labels.observationsOnly}
          </p>
        </div>
      </header>
      {signals.length === 0 ? (
        <p className="text-sm text-mute">{labels.noSignals}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {signals.map((signal) => (
            <li
              key={signal.key}
              className="rounded-lg border border-line-soft bg-ivory p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Chip
                      className="h-6 font-mono text-[10px] uppercase tracking-[0.08em]"
                      size="sm"
                      variant="soft"
                    >
                      {labels.kind[signal.kind]}
                    </Chip>
                    <span className="font-mono text-[10px] text-mute">
                      {signal.occurrenceCount}x · {signal.affectedRunCount}{" "}
                      {labels.runs}
                    </span>
                  </div>
                  <h3 className="m-0 truncate text-sm font-semibold text-ink">
                    {signal.title}
                  </h3>
                </div>
                <strong className="font-mono text-sm text-ink">
                  {signal.priorityScore}
                </strong>
              </div>
              {signal.examples.length > 0 ? (
                <ul className="mt-2 m-0 flex list-none flex-col gap-1 p-0 text-xs text-body">
                  {signal.examples.map((example) => (
                    <li key={example} className="truncate">
                      {example}
                    </li>
                  ))}
                </ul>
              ) : null}
              {projectSlug && signal.drillDown.nodeId ? (
                <Link
                  className="mt-2 inline-flex text-xs font-semibold text-amber hover:underline"
                  href={`/projects/${projectSlug}/observatory?${drillDownParams(
                    signal,
                  )}`}
                >
                  {labels.drillDown}
                </Link>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function drillDownParams(signal: SignalCluster): string {
  const params = new URLSearchParams();

  if (signal.drillDown.flowId) params.set("flowId", signal.drillDown.flowId);
  if (signal.drillDown.nodeId) params.set("nodeId", signal.drillDown.nodeId);
  if (signal.drillDown.artifactKind) {
    params.set("artifactKind", signal.drillDown.artifactKind);
  }
  if (signal.drillDown.artifactDefId) {
    params.set("artifactDefId", signal.drillDown.artifactDefId);
  }

  return params.toString();
}

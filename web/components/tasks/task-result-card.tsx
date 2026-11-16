import type { ReactElement } from "react";
import type { TaskRunRow } from "@/lib/queries/task-detail";

import Link from "next/link";
import { CheckCircleIcon } from "@heroicons/react/24/outline";

import { TaskRunArtifactView as ArtifactView } from "@/components/tasks/task-run-artifact";

// D10 / P-1: a Done task leads with its result — the attempt the completion
// activity names (legacy completions without one say so), not the newest Run.
export function TaskResultCard({
  resolvingRun,
  labels,
  artifactLabels,
}: {
  resolvingRun: TaskRunRow | null;
  labels: {
    title: string;
    resolvingRun: string;
    resolvingUnknown: string;
    openChanges: string;
  };
  artifactLabels: Parameters<typeof ArtifactView>[0]["labels"];
}): ReactElement {
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-good bg-good-soft p-3"
      data-testid="task-result-card"
      id="task-result"
    >
      <h2 className="m-0 inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-good">
        <CheckCircleIcon aria-hidden="true" className="h-4 w-4" />
        {labels.title}
      </h2>
      {resolvingRun ? (
        <div className="flex flex-wrap items-center gap-3 text-[12px]">
          <span className="text-mute">{labels.resolvingRun}</span>
          <Link
            className="font-mono font-semibold text-amber hover:underline"
            href={`/runs/${resolvingRun.id}`}
          >
            {resolvingRun.id.slice(0, 8)}
          </Link>
          <ArtifactView
            artifact={resolvingRun.delivery.artifact}
            labels={artifactLabels}
          />
          <Link
            className="font-mono text-[11px] font-semibold text-amber hover:underline"
            href={`/runs/${resolvingRun.id}?tab=changes`}
          >
            {labels.openChanges}
          </Link>
        </div>
      ) : (
        <p className="m-0 text-[12px] text-mute">{labels.resolvingUnknown}</p>
      )}
    </section>
  );
}

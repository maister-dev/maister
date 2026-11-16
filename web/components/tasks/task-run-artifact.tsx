import type { ReactElement } from "react";
import type { PrStateChipLabels } from "@/components/pr-state-chip";
import type { TaskRunArtifact } from "@/lib/queries/task-detail";

import { PrStateChip } from "@/components/pr-state-chip";

// D10: what a Run actually delivered, never the configured strategy.
export function TaskRunArtifactView({
  artifact,
  labels,
}: {
  artifact: TaskRunArtifact;
  labels: { notDelivered: string; merged: string; pr: PrStateChipLabels };
}): ReactElement {
  switch (artifact.kind) {
    case "pr":
      return (
        <span className="inline-flex items-center gap-1.5">
          <a
            className="font-mono font-semibold text-amber hover:underline"
            href={artifact.url}
            rel="noreferrer"
            target="_blank"
          >
            #{artifact.number ?? "?"}
          </a>
          <PrStateChip
            labels={labels.pr}
            prHasConflicts={null}
            prState={
              artifact.state === "open" ||
              artifact.state === "merged" ||
              artifact.state === "closed"
                ? artifact.state
                : null
            }
          />
        </span>
      );
    case "published":
      return <span className="font-mono">{artifact.branch}</span>;
    case "merged":
      return (
        <span className="font-mono">
          {labels.merged}
          {artifact.commit ? ` ${artifact.commit.slice(0, 7)}` : ""}
        </span>
      );
    case "none":
      return <span className="text-mute">{labels.notDelivered}</span>;
  }
}

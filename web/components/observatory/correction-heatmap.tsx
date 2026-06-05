import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

import type { CorrectionHeatmapProps } from "@/components/observatory/types";

export function CorrectionHeatmap({
  labels,
  nodes,
  projectSlug,
}: CorrectionHeatmapProps): ReactElement {
  if (nodes.length === 0) {
    return (
      <section className="rounded-lg border border-line bg-paper p-4">
        <h2 className="m-0 text-sm font-semibold text-ink">{labels.nodes}</h2>
        <p className="mt-2 text-sm text-mute">{labels.noNodes}</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-line bg-paper p-4">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="m-0 text-sm font-semibold text-ink">{labels.nodes}</h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">
          {labels.correctionFormula}
        </span>
      </header>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-2">
        {nodes.map((node) => {
          const content = <NodeCell labels={labels} node={node} />;

          return projectSlug ? (
            <Link
              key={node.nodeId}
              className="block focus:outline-none focus:ring-2 focus:ring-amber"
              href={`/projects/${projectSlug}/observatory?nodeId=${encodeURIComponent(
                node.nodeId,
              )}`}
            >
              {content}
            </Link>
          ) : (
            <div key={node.nodeId}>{content}</div>
          );
        })}
      </div>
    </section>
  );
}

function NodeCell({
  labels,
  node,
}: {
  labels: CorrectionHeatmapProps["labels"];
  node: CorrectionHeatmapProps["nodes"][number];
}): ReactElement {
  const tone =
    node.correctionRate >= 1
      ? "border-danger/30 bg-danger/10 text-danger"
      : node.correctionRate > 0
        ? "border-amber-line bg-amber-soft text-amber"
        : "border-line-soft bg-ivory text-ink";

  return (
    <article
      className={clsx(
        "min-h-[118px] rounded-lg border p-3 transition-colors hover:border-amber",
        tone,
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <h3 className="m-0 truncate text-sm font-semibold text-ink">
          {node.nodeId}
        </h3>
        <span className="rounded-full border border-current px-1.5 py-0.5 font-mono text-[9px] uppercase">
          {node.nodeType}
        </span>
      </div>
      <strong className="mt-4 block text-[28px] leading-none text-ink">
        {node.correctionRate.toFixed(2)}
      </strong>
      <dl className="mt-3 grid grid-cols-3 gap-1 font-mono text-[10px] text-mute">
        <Metric label={labels.runs} value={node.runCount} />
        <Metric label={labels.rework} value={node.reworkCount} />
        <Metric label={labels.retries} value={node.retryCount} />
      </dl>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <div>
      <dt className="truncate">{label}</dt>
      <dd className="font-semibold text-ink">{value}</dd>
    </div>
  );
}

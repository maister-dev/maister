import type { ReactElement } from "react";
import type { CoverageMapCardProps } from "@/components/observatory/types";

export function CoverageMapCard({
  coverage,
  labels,
}: CoverageMapCardProps): ReactElement {
  const harness = labels.harness;

  if (coverage.length === 0) {
    return (
      <section className="rounded-lg border border-line bg-paper p-4">
        <h2 className="m-0 text-sm font-semibold text-ink">
          {harness.coverageTitle}
        </h2>
        <p className="mt-2 text-sm text-mute">{harness.noCoverage}</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-line bg-paper p-4">
      <h2 className="m-0 text-sm font-semibold text-ink">
        {harness.coverageTitle}
      </h2>
      <div className="mt-3 flex flex-col gap-3">
        {coverage.map((flow) => (
          <article
            key={flow.flowId}
            className="rounded-md border border-line-soft bg-ivory px-3 py-2"
          >
            <header className="flex items-center justify-between gap-3">
              <h3 className="m-0 font-mono text-xs font-semibold text-ink">
                {flow.flowRefId}
              </h3>
              <span className="font-mono text-[10px] text-mute">
                {flow.revisionCount} {harness.revisions}
              </span>
            </header>
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
              {flow.nodes.map((node) => (
                <li
                  key={node.nodeId}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <span className="font-mono font-semibold text-ink">
                    {node.nodeId}
                    {node.guidesWithoutSensors ? (
                      <span className="ml-2 rounded-full border border-amber-line bg-amber-soft px-1.5 py-0.5 font-mono text-[9px] uppercase text-amber">
                        {harness.guidesWithoutSensors}
                      </span>
                    ) : null}
                  </span>
                  <span className="font-mono text-[10px] text-mute">
                    {node.blockingGateCount} {harness.blocking} ·{" "}
                    {node.advisoryGateCount} {harness.advisory} ·{" "}
                    {node.guideCount} {harness.guides} · n={node.executions}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

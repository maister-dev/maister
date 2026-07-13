import type { ReactElement } from "react";
import type { CoverageMapCardProps } from "@/components/observatory/types";

import { FlowLedgerScope } from "@/components/observatory/flow-ledger-scope";

export function CoverageMapCard({
  coverage,
  labels,
}: CoverageMapCardProps): ReactElement {
  const harness = labels.harness;

  if (coverage.length === 0) {
    return (
      <section className="rounded-lg border border-line bg-paper p-4">
        <header className="flex items-center justify-between gap-2">
          <h2 className="m-0 text-sm font-semibold text-ink">
            {harness.coverageTitle}
          </h2>
          <FlowLedgerScope labels={labels} />
        </header>
        <p className="mt-2 text-sm text-mute">{harness.noCoverage}</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-line bg-paper p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold text-ink">
          {harness.coverageTitle}
        </h2>
        <FlowLedgerScope labels={labels} />
      </header>
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
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[480px] border-collapse text-left text-xs">
                <thead className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                  <tr>
                    <th className="border-b border-line px-2 py-2" scope="col">
                      {labels.node}
                    </th>
                    <th
                      className="border-b border-line px-2 py-2 text-right"
                      scope="col"
                    >
                      {harness.guides}
                    </th>
                    <th
                      className="border-b border-line px-2 py-2 text-right"
                      scope="col"
                    >
                      {harness.blocking}
                    </th>
                    <th
                      className="border-b border-line px-2 py-2 text-right"
                      scope="col"
                    >
                      {harness.advisory}
                    </th>
                    <th
                      className="border-b border-line px-2 py-2 text-right"
                      scope="col"
                    >
                      {harness.executions}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {flow.nodes.map((node) => (
                    <tr
                      key={node.nodeId}
                      className={
                        node.guidesWithoutSensors
                          ? "border-b border-amber-line bg-amber-soft"
                          : "border-b border-line-soft"
                      }
                    >
                      <td className="px-2 py-2">
                        <span className="font-mono font-semibold text-ink">
                          {node.nodeId}
                        </span>
                        {node.guidesWithoutSensors ? (
                          <span className="ml-2 rounded-full border border-amber-line bg-paper px-1.5 py-0.5 font-mono text-[9px] uppercase text-amber">
                            {harness.guidesWithoutSensors}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-mute">
                        {node.guideCount}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-ink">
                        {node.blockingGateCount}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-ink">
                        {node.advisoryGateCount}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-mute">
                        {node.executions}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

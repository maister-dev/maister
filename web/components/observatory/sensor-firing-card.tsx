import type { ReactElement } from "react";
import type { SensorFiringCardProps } from "@/components/observatory/types";

import Link from "next/link";

import { formatRateWithN } from "@/components/observatory/harness-format";
import { MIN_GROUP_EXECUTIONS } from "@/lib/queries/observatory-core";

export function SensorFiringCard({
  firing,
  labels,
  neverFired,
  projectSlug,
}: SensorFiringCardProps): ReactElement {
  const harness = labels.harness;

  if (firing.groups.length === 0) {
    return (
      <section className="rounded-lg border border-line bg-paper p-4">
        <h2 className="m-0 text-sm font-semibold text-ink">
          {harness.firingTitle}
        </h2>
        <p className="mt-2 text-sm text-mute">{harness.noFiring}</p>
      </section>
    );
  }

  const neverFiredKeys = new Set(
    neverFired.map((flag) => `${flag.flowId}::${flag.nodeId}::${flag.gateId}`),
  );

  return (
    <section className="rounded-lg border border-line bg-paper p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold text-ink">
          {harness.firingTitle}
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
          {harness.byKind}:{" "}
          {firing.byKind
            .map(
              (kind) =>
                `${kind.kind} ${formatRateWithN(kind.failRate, kind.executions)}`,
            )
            .join(" · ")}
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
            <tr>
              <th className="border-b border-line px-2 py-2">{harness.gate}</th>
              <th className="border-b border-line px-2 py-2">{labels.node}</th>
              <th className="border-b border-line px-2 py-2">{harness.kind}</th>
              <th className="border-b border-line px-2 py-2">{harness.mode}</th>
              <th className="border-b border-line px-2 py-2">
                {harness.passed}
              </th>
              <th className="border-b border-line px-2 py-2">
                {harness.failed}
              </th>
              <th className="border-b border-line px-2 py-2">
                {harness.stale}
              </th>
              <th className="border-b border-line px-2 py-2">
                {harness.failRate}
              </th>
            </tr>
          </thead>
          <tbody>
            {firing.groups.map((group) => {
              const groupKey = `${group.projectId}:${group.flowId}:${group.nodeId}:${group.gateId}`;
              const flagged = neverFiredKeys.has(
                `${group.flowId}::${group.nodeId}::${group.gateId}`,
              );
              const nodeParams = new URLSearchParams({
                flowId: group.flowId,
                nodeId: group.nodeId,
              });

              return (
                <tr key={groupKey} className="border-b border-line-soft">
                  <td className="px-2 py-2">
                    <span className="font-mono text-xs font-semibold text-ink">
                      {group.gateId}
                    </span>
                    <span className="ml-2 font-mono text-[10px] text-mute">
                      {group.flowRefId}
                    </span>
                    {flagged ? (
                      <span
                        className="ml-2 rounded-full border border-amber-line bg-amber-soft px-1.5 py-0.5 font-mono text-[9px] uppercase text-amber"
                        title={harness.neverFiredHint}
                      >
                        {harness.neverFired}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-ink">
                    {projectSlug ? (
                      <Link
                        className="text-amber hover:underline"
                        href={`/projects/${projectSlug}/observatory?${nodeParams.toString()}`}
                      >
                        {group.nodeId}
                      </Link>
                    ) : (
                      group.nodeId
                    )}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-mute">
                    {group.kind}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-mute">
                    {group.mode === "blocking"
                      ? harness.blocking
                      : harness.advisory}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-ink">
                    {group.passed}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-ink">
                    {group.failed}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-ink">
                    {group.stale}
                  </td>
                  <td
                    className="px-2 py-2 font-mono text-xs text-ink"
                    title={
                      group.executions < MIN_GROUP_EXECUTIONS
                        ? harness.insufficientData
                        : undefined
                    }
                  >
                    {formatRateWithN(group.failRate, group.executions)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

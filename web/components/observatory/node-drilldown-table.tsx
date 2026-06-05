import type { ReactElement } from "react";

import Link from "next/link";

import type { ObservatoryNodeDrilldownProps } from "@/components/observatory/types";

export function NodeDrilldownTable({
  detail,
  labels,
}: ObservatoryNodeDrilldownProps): ReactElement {
  if (detail.runs.length === 0) {
    return (
      <section className="rounded-lg border border-line bg-paper p-4">
        <h2 className="m-0 text-sm font-semibold text-ink">
          {labels.historicalAttempts}
        </h2>
        <p className="mt-2 text-sm text-mute">{labels.noNodes}</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-line bg-paper p-4">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="m-0 text-sm font-semibold text-ink">
          {labels.historicalAttempts}
        </h2>
        <span className="font-mono text-xs text-mute">{detail.nodeId}</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
            <tr>
              <th className="border-b border-line px-2 py-2">{labels.runs}</th>
              <th className="border-b border-line px-2 py-2">
                {labels.latestAttempt}
              </th>
              <th className="border-b border-line px-2 py-2">{labels.gates}</th>
              <th className="border-b border-line px-2 py-2">
                {labels.hitlWaits}
              </th>
            </tr>
          </thead>
          <tbody>
            {detail.runs.map((run) => {
              const attempts = detail.attempts.filter(
                (attempt) => attempt.runId === run.runId,
              );
              const latest = attempts.at(-1);
              const gates = detail.gates.filter((gate) => gate.runId === run.runId);
              const waits = detail.hitlWaits.filter(
                (hitl) => hitl.runId === run.runId,
              );

              return (
                <tr key={run.runId} className="border-b border-line-soft">
                  <td className="px-2 py-2">
                    <Link
                      className="font-mono text-xs font-semibold text-amber hover:underline"
                      href={`/runs/${run.runId}`}
                    >
                      {run.runId}
                    </Link>
                  </td>
                  <td className="px-2 py-2">
                    {latest ? (
                      <span className="font-mono text-xs text-ink">
                        #{latest.attempt} · {latest.status}
                      </span>
                    ) : (
                      <span className="text-mute">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-ink">
                    {gates.length}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-ink">
                    {waits.length}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {detail.signals.length > 0 ? (
        <div className="mt-4 rounded-md border border-line-soft bg-ivory px-3 py-2">
          <h3 className="m-0 text-xs font-semibold text-ink">{labels.signals}</h3>
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-xs text-body">
            {detail.signals.flatMap((signal) =>
              signal.examples.map((example) => (
                <li key={`${signal.key}:${example}`} className="truncate">
                  {example}
                </li>
              )),
            )}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

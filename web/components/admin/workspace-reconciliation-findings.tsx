import type { ReactElement } from "react";
import type { WorkspaceReconciliationFindingPageItem } from "@/lib/queries/workspace-reconciliation-findings";

export function WorkspaceReconciliationFindings({
  findings,
  labels,
}: {
  findings: WorkspaceReconciliationFindingPageItem[];
  labels: {
    title: string;
    subtitle: string;
    empty: string;
    path: string;
    state: string;
    attempts: string;
    error: string;
    rescueRef: string;
  };
}): ReactElement {
  return (
    <section className="rounded-[14px] border border-line bg-paper shadow-[var(--shadow-sm)]">
      <div className="border-b border-line px-5 py-4">
        <h2 className="m-0 text-[17px] font-semibold text-ink">
          {labels.title}
        </h2>
        <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
          {labels.subtitle}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px] border-collapse text-left">
          <thead className="border-b border-line bg-ivory font-mono text-[10px] uppercase text-mute">
            <tr>
              <th className="px-5 py-3">{labels.path}</th>
              <th className="px-4 py-3">{labels.state}</th>
              <th className="px-4 py-3">{labels.attempts}</th>
              <th className="px-4 py-3">{labels.error}</th>
              <th className="px-5 py-3">{labels.rescueRef}</th>
            </tr>
          </thead>
          <tbody>
            {findings.length === 0 ? (
              <tr>
                <td
                  className="px-5 py-8 text-center font-mono text-[11.5px] text-mute"
                  colSpan={5}
                >
                  {labels.empty}
                </td>
              </tr>
            ) : (
              findings.map((finding) => (
                <tr
                  key={finding.id}
                  className="border-b border-line last:border-b-0"
                >
                  <td className="px-5 py-3 font-mono text-[11.5px] text-ink">
                    {finding.relativePath}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11.5px] text-ink-2">
                    {finding.state}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11.5px] text-ink-2">
                    {finding.attemptCount}
                  </td>
                  <td className="px-4 py-3 text-[11.5px] text-danger">
                    {finding.lastErrorCode ?? "—"}
                  </td>
                  <td className="px-5 py-3 font-mono text-[11.5px] text-ink-2">
                    {finding.rescueRef ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

import type { ReactElement } from "react";
import type { CostBreakdownCardProps } from "@/components/observatory/types";

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

// ADR-117: a read-only cost breakdown table (by model or by runner). Rows are
// pre-summed + sorted by the query layer; this is presentation only.
export function CostBreakdownCard({
  rows,
  title,
  keyHeader,
  labels,
  testId,
}: CostBreakdownCardProps): ReactElement {
  const cost = labels.costBreakdown;

  return (
    <section
      className="mt-4 rounded-lg border border-line bg-paper p-4"
      data-testid={testId}
    >
      <h3 className="m-0 mb-3 text-sm font-semibold text-ink">{title}</h3>
      <div className="overflow-x-auto">
        <table
          aria-label={title}
          className="w-full min-w-[420px] border-collapse text-left"
        >
          <thead>
            <tr className="border-b border-line font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] text-mute">
              <th className="py-2 pr-3 font-bold">{keyHeader}</th>
              <th className="py-2 pr-3 text-right font-bold">
                {cost.inputHeader}
              </th>
              <th className="py-2 pr-3 text-right font-bold">
                {cost.outputHeader}
              </th>
              <th className="py-2 pr-3 text-right font-bold">
                {cost.cacheHeader}
              </th>
              <th className="py-2 text-right font-bold">{cost.totalHeader}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="py-3 text-xs text-mute" colSpan={5}>
                  {cost.empty}
                </td>
              </tr>
            ) : (
              rows.map((dimensionRow) => (
                <tr
                  key={dimensionRow.key}
                  className="border-b border-line/60 last:border-b-0"
                >
                  <td className="py-2 pr-3 font-mono text-xs text-ink">
                    {dimensionRow.label}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-body">
                    {formatTokens(dimensionRow.inputTokens)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-body">
                    {formatTokens(dimensionRow.outputTokens)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-body">
                    {formatTokens(
                      dimensionRow.cacheReadTokens +
                        dimensionRow.cacheCreationTokens,
                    )}
                  </td>
                  <td className="py-2 text-right font-mono text-xs font-semibold text-ink">
                    {formatTokens(dimensionRow.totalTokens)}
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

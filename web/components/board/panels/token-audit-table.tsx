import type { ReactElement } from "react";
import type { TokenAuditEntry } from "@/lib/tokens/audit-list";

import { NumberedPagination } from "@/components/navigation/numbered-pagination";

export interface TokenAuditLabels {
  title: string;
  description: string;
  empty: string;
  colWhen: string;
  colToken: string;
  colMethod: string;
  colEndpoint: string;
  colScope: string;
  colResult: string;
  colStatus: string;
  filterToken: string;
  filterResult: string;
  filterAny: string;
  resultOk: string;
  resultError: string;
  apply: string;
  pagePrev: string;
  pageNext: string;
  pageLabel: string;
  paginationLabel: string;
}

// Read-only view-table per the admin convention (canonical: TaskActivityLog).
// token_audit_log is the authoritative "via named token, not from the web UI"
// trail (every /api/v1/ext call); this surfaces it. Filters + pagination are
// URL-synchronized GET params on the integrations tab.
export function TokenAuditTable({
  slug,
  rows,
  total,
  page,
  pageSize,
  filters,
  tokenOptions,
  labels,
}: {
  slug: string;
  rows: TokenAuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  filters: { tokenId?: string; result?: "ok" | "error" };
  tokenOptions: Array<{ id: string; name: string }>;
  labels: TokenAuditLabels;
}): ReactElement {
  const pages = Math.max(Math.ceil(total / pageSize), 1);

  const pageHref = (target: number): string => {
    const params = new URLSearchParams({ tab: "integrations" });

    if (filters.tokenId) params.set("audit_token", filters.tokenId);
    if (filters.result) params.set("audit_result", filters.result);
    if (target > 1) params.set("audit_page", String(target));

    return `/projects/${slug}?${params.toString()}`;
  };

  return (
    <section className="mt-8 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {labels.title}
        </h2>
        <p className="m-0 font-mono text-[11px] text-mute">
          {labels.description}
        </p>
      </div>

      <form
        action={`/projects/${slug}`}
        className="flex flex-wrap items-center gap-2 font-mono text-[11px]"
        method="get"
      >
        <input name="tab" type="hidden" value="integrations" />
        <label className="flex items-center gap-1 text-mute">
          {labels.filterToken}
          <select
            className="rounded border border-line bg-paper px-1.5 py-1 text-ink"
            defaultValue={filters.tokenId ?? ""}
            name="audit_token"
          >
            <option value="">{labels.filterAny}</option>
            {tokenOptions.map((tok) => (
              <option key={tok.id} value={tok.id}>
                {tok.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-mute">
          {labels.filterResult}
          <select
            className="rounded border border-line bg-paper px-1.5 py-1 text-ink"
            defaultValue={filters.result ?? ""}
            name="audit_result"
          >
            <option value="">{labels.filterAny}</option>
            <option value="ok">{labels.resultOk}</option>
            <option value="error">{labels.resultError}</option>
          </select>
        </label>
        <button
          className="rounded border border-line bg-paper px-2 py-1 uppercase tracking-[0.06em] text-mute transition hover:border-amber hover:text-amber"
          type="submit"
        >
          {labels.apply}
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute">
          {labels.empty}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-paper">
          <table className="w-full min-w-[820px] border-collapse text-left font-mono text-[11px]">
            <thead>
              <tr className="border-b border-line text-[9.5px] font-semibold uppercase tracking-[0.12em] text-mute">
                <th className="px-4 py-3">{labels.colWhen}</th>
                <th className="px-4 py-3">{labels.colToken}</th>
                <th className="px-4 py-3">{labels.colMethod}</th>
                <th className="px-4 py-3">{labels.colEndpoint}</th>
                <th className="px-4 py-3">{labels.colScope}</th>
                <th className="px-4 py-3">{labels.colResult}</th>
                <th className="px-4 py-3">{labels.colStatus}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-line-soft last:border-b-0 text-ink-2"
                >
                  <td
                    suppressHydrationWarning
                    className="px-4 py-3 tabular-nums text-mute"
                  >
                    {row.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="px-4 py-3 font-semibold text-ink">
                    {row.actorLabel}
                  </td>
                  <td className="px-4 py-3 text-mute">{row.method}</td>
                  <td className="max-w-[280px] truncate px-4 py-3 text-ink-2">
                    {row.endpoint}
                  </td>
                  <td className="px-4 py-3 text-mute">{row.scopeUsed}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full border px-[7px] py-[3px] text-[9px] font-bold uppercase tracking-[0.08em] ${
                        row.result === "ok"
                          ? "border-line bg-paper text-mute"
                          : "border-amber-line bg-amber-soft text-amber"
                      }`}
                    >
                      {row.result === "ok"
                        ? labels.resultOk
                        : labels.resultError}
                    </span>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-mute">
                    {row.statusCode}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 ? (
        <NumberedPagination
          currentPage={page}
          hrefForPage={pageHref}
          labels={{
            ariaLabel: labels.paginationLabel,
            next: labels.pageNext,
            page: labels.pageLabel,
            previous: labels.pagePrev,
          }}
          pageCount={pages}
          surface="inline"
        />
      ) : null}
    </section>
  );
}

import type { RunsListFilters } from "@/lib/queries/runs-list";

// The `/runs` ledger's URL vocabulary, in ONE place.
//
// Deliberately NOT inside `lib/queries/runs-list.ts`: that module is
// `server-only`, and the Observatory's drill-down builder — which must write
// exactly these param names for a cell's count to equal the list it opens
// (ADR-178 D8) — has no business pulling a query module into its import graph.
// The `RunsListFilters` import is type-only, so nothing of the query module
// survives to runtime here.

export function filtersToParams(filters: RunsListFilters): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.projectSlug) params.set("project", filters.projectSlug);
  if (filters.status) params.set("status", filters.status);
  if (filters.source) params.set("source", filters.source);
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.bucket) params.set("bucket", filters.bucket);
  if (filters.dateFrom) params.set("from", filters.dateFrom);
  if (filters.dateTo) params.set("to", filters.dateTo);
  if (filters.page > 1) params.set("page", String(filters.page));

  return params;
}
